import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'crypto';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { AppError, NotFoundError } from '../../shared/errors/AppError';
import { dispatchWebhookEvent } from '../../shared/queue/workers';
import { logger } from '../../shared/utils/logger';

const audit = new AuditService();

const WEBHOOK_EVENTS = [
  'payment.approved', 'payment.failed', 'payment.refunded',
  'subscription.created', 'subscription.cancelled', 'subscription.charged',
  'affiliate.sale', 'order.shipped', 'order.delivered',
  'producer.approved', 'chargeback.created',
] as const;

// ── HMAC HELPERS ─────────────────────────────────────────────────

/**
 * FIX B-58: Verificação de assinatura HMAC usando timingSafeEqual
 * Previne timing attacks e garante autenticidade do webhook
 */
function verifyHmacSignature(
  payload    : string,
  secret     : string,
  receivedSig: string,
  algo       : 'sha256' | 'sha1' = 'sha256'
): boolean {
  const expected = `${algo}=${createHmac(algo, secret).update(payload).digest('hex')}`;
  try {
    return timingSafeEqual(
      Buffer.from(receivedSig.padEnd(expected.length)),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// Secrets por adquirente vêm de variáveis de ambiente
// Pagar.me V5 usa SHA1 no header x-hub-signature (formato: sha1=HASH)
const ACQUIRER_SECRETS: Record<string, { headerKey: string; secret: string; algo: 'sha256' | 'sha1' }> = {
  pagarme: {
    headerKey : 'x-hub-signature',
    secret    : process.env.PAGARME_WEBHOOK_SECRET || '',
    algo      : 'sha1',  // FIX: Pagar.me V5 usa SHA1, não SHA256
  },
  asaas: {
    headerKey : 'asaas-access-token',
    secret    : process.env.ASAAS_WEBHOOK_SECRET || process.env.ASAAS_API_KEY || '',
    algo      : 'sha256',
  },
  stone: {
    headerKey : 'x-stone-signature',
    secret    : process.env.STONE_WEBHOOK_SECRET || '',
    algo      : 'sha256',
  },
  cielo: {
    headerKey : 'x-cielo-signature',
    secret    : process.env.CIELO_WEBHOOK_SECRET || '',
    algo      : 'sha256',
  },
};

export async function webhookRoutes(app: FastifyInstance) {

  // ── POST /webhooks/receive/:acquirer (INBOUND — adquirentes) ──
  // FIX B-58: HMAC obrigatório antes de processar qualquer payload
  app.post('/receive/:acquirer', async (req, reply) => {
    const { acquirer } = req.params as { acquirer: string };
    const config      = ACQUIRER_SECRETS[acquirer.toLowerCase()];

    if (!config) {
      await audit.log({
        action : 'WEBHOOK_UNKNOWN_ACQUIRER',
        details: { acquirer },
        level  : 'HIGH',
      });
      return reply.status(400).send({ error: `Adquirente desconhecido: ${acquirer}` });
    }

    if (!config.secret) {
      logger.error(`WEBHOOK_SECRET não configurado para adquirente: ${acquirer}`);
      return reply.status(500).send({ error: 'Configuração interna inválida' });
    }

    // FIX: usar rawBody capturado antes do parse (JSON.stringify pode diferir do original)
    const rawBody     = (req as any).rawBody || JSON.stringify(req.body);
    const receivedSig = (req.headers[config.headerKey] || '') as string;

    // Log de debug — remover após confirmar funcionamento
    logger.info({
      acquirer,
      headerKey  : config.headerKey,
      receivedSig: receivedSig.slice(0, 30) + '...',
      rawBodyLen : rawBody.length,
      algo       : config.algo,
      secretLen  : config.secret?.length,
    }, 'WEBHOOK_DEBUG');

    if (!receivedSig) {
      await audit.log({
        action : 'WEBHOOK_MISSING_SIGNATURE',
        details: { acquirer, ip: req.ip },
        level  : 'HIGH',
      });
      return reply.status(401).send({ error: 'Assinatura ausente' });
    }

    const isValid = verifyHmacSignature(rawBody, config.secret, receivedSig, config.algo);

    if (!isValid) {
      // Log detalhado para debug
      const { createHmac } = await import('crypto');
      const expectedSig = `${config.algo}=${createHmac(config.algo, config.secret).update(rawBody).digest('hex')}`;
      logger.warn({
        acquirer,
        receivedSig,
        expectedSig,
        match: receivedSig === expectedSig,
      }, 'WEBHOOK_SIGNATURE_MISMATCH');

      await audit.log({
        action : 'WEBHOOK_INVALID_SIGNATURE',
        details: { acquirer, ip: req.ip },
        level  : 'CRITICAL',
      });
      return reply.status(401).send({ error: 'Assinatura inválida' });
    }

    // ── Processar payload após validação ──────────────────────
    const payload = req.body as any;

    await audit.log({
      action : 'WEBHOOK_RECEIVED',
      details: { acquirer, event: payload.type || payload.event || 'unknown' },
      level  : 'LOW',
    });

    try {
      if (acquirer === 'pagarme') {
        await processPagarmeWebhook(payload);
      } else if (acquirer === 'asaas') {
        await processAsaasWebhook(payload);
      } else if (acquirer === 'stone') {
        await processStoneWebhook(payload);
      }
    } catch (err: any) {
      logger.error({ err, acquirer }, 'Erro ao processar webhook');
      // Responder 200 mesmo com erro interno para evitar reenvio infinito do adquirente
      return reply.status(200).send({ received: true, processed: false });
    }

    return reply.status(200).send({ received: true });
  });

  // ── POST /webhooks/endpoints — cadastrar endpoint (outbound) ──
  app.post('/endpoints', { preHandler: [authenticate] }, async (req, reply) => {
    const body = z.object({
      url    : z.string().url().startsWith('https', { message: 'URL deve usar HTTPS em produção' }),
      events : z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Selecione ao menos um evento'),
    }).parse(req.body);

    // Gerar secret criptograficamente seguro (FIX B-59)
    const { randomBytes } = await import('crypto');
    const secret   = randomBytes(32).toString('hex');

    const endpoint = await prisma.webhookEndpoint.create({
      data: { userId: req.user.sub, url: body.url, secret, events: body.events, status: 'ACTIVE' },
    });

    // Retorna o secret apenas na criação — não é recuperável depois
    return reply.status(201).send({ ...endpoint, secret });
  });

  // ── GET /webhooks/endpoints — listar endpoints ────────────────
  app.get('/endpoints', { preHandler: [authenticate] }, async (req, reply) => {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where : { userId: req.user.sub },
      select: { id: true, url: true, events: true, status: true, createdAt: true },
      // secret nunca é retornado após a criação
    });
    return reply.send(endpoints);
  });

  // ── DELETE /webhooks/endpoints/:id ────────────────────────────
  app.delete('/endpoints/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    // FIX B-62: verificar ownership antes de desativar
    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw new NotFoundError('Endpoint');
    if (endpoint.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new AppError('Acesso negado a este endpoint', 403);
    }

    await prisma.webhookEndpoint.update({ where: { id }, data: { status: 'INACTIVE' } });
    return reply.send({ message: 'Endpoint desativado' });
  });

  // ── GET /webhooks/endpoints/:id/deliveries ────────────────────
  app.get('/endpoints/:id/deliveries', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw new NotFoundError('Endpoint');
    if (endpoint.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new AppError('Acesso negado', 403);
    }

    const deliveries = await prisma.webhookDelivery.findMany({
      where  : { endpointId: id },
      include: { event: { select: { eventType: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      take   : 50,
    });
    return reply.send(deliveries);
  });

  // ── POST /webhooks/endpoints/:id/test ─────────────────────────
  app.post('/endpoints/:id/test', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw new NotFoundError('Endpoint');
    if (endpoint.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new AppError('Acesso negado', 403);
    }

    const testPayload = {
      event     : 'webhook.test',
      timestamp : new Date().toISOString(),
      data      : { message: 'Teste de webhook Kairos Way', endpointId: id },
    };

    await dispatchWebhookEvent('webhook.test', testPayload);
    await audit.log({ userId: req.user.sub, action: 'WEBHOOK_TEST', details: { endpointId: id }, level: 'LOW' });

    return reply.send({ message: 'Evento de teste enfileirado', payload: testPayload });
  });

  // ── GET /webhooks/events — lista de eventos disponíveis ────────
  app.get('/events', async (_req, reply) => {
    return reply.send([...WEBHOOK_EVENTS]);
  });
}

// ── PROCESSADORES POR ADQUIRENTE ─────────────────────────────────

async function processPagarmeWebhook(payload: any) {
  const txId   = payload.data?.id;
  const status = payload.data?.status;
  if (!txId || !status) return;

  const orderStatus =
    status === 'paid'     ? 'APPROVED' :
    status === 'refunded' ? 'REFUNDED' :
    status === 'chargedback' ? 'CHARGEBACK' : null;

  if (!orderStatus) return;

  const order = await prisma.order.findFirst({ where: { acquirerTxId: txId } });
  if (!order) {
    logger.warn({ txId, status }, 'Pagar.me webhook: pedido não encontrado');
    return;
  }

  await prisma.order.update({
    where: { id: order.id },
    data : {
      status     : orderStatus as any,
      approvedAt : orderStatus === 'APPROVED' ? new Date() : undefined,
    },
  });

  if (orderStatus === 'APPROVED') {
    await dispatchWebhookEvent('payment.approved', { orderId: order.id, acquirer: 'PAGARME', amountCents: order.amountCents });
  }
}

async function processAsaasWebhook(payload: any) {
  const paymentId = payload.payment?.id;
  const event     = payload.event;
  if (!paymentId) return;

  const statusMap: Record<string, string> = {
    PAYMENT_CONFIRMED          : 'APPROVED',
    PAYMENT_RECEIVED           : 'APPROVED',
    PAYMENT_REFUNDED           : 'REFUNDED',
    PAYMENT_CHARGEBACK_REQUESTED: 'CHARGEBACK',
  };

  const orderStatus = statusMap[event];
  if (!orderStatus) return;

  const order = await prisma.order.findFirst({ where: { acquirerTxId: paymentId } });
  if (!order) return;

  await prisma.order.update({
    where: { id: order.id },
    data : {
      status     : orderStatus as any,
      approvedAt : orderStatus === 'APPROVED' ? new Date() : undefined,
    },
  });

  if (orderStatus === 'APPROVED') {
    await dispatchWebhookEvent('payment.approved', { orderId: order.id, acquirer: 'ASAAS', amountCents: order.amountCents });
  }
}

async function processStoneWebhook(payload: any) {
  const txId   = payload.id;
  const status = payload.status;
  if (!txId || !status) return;

  const orderStatus = status === 'APPROVED' ? 'APPROVED' : status === 'CANCELLED' ? 'REJECTED' : null;
  if (!orderStatus) return;

  const order = await prisma.order.findFirst({ where: { acquirerTxId: txId } });
  if (!order) return;

  await prisma.order.update({
    where: { id: order.id },
    data : { status: orderStatus as any, approvedAt: orderStatus === 'APPROVED' ? new Date() : undefined },
  });
}