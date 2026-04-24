import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { GatewayService } from './gateway.service';
import { SplitEngineService } from '../split-engine/split-engine.service';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, ForbiddenError } from '../../shared/errors/AppError';
import { dispatchWebhookEvent } from '../../shared/queue/enqueue';
import { notifyNewSale } from '../../shared/utils/notifyNewSale';
import { logger } from '../../shared/utils/logger';

const gateway     = new GatewayService();
const splitEngine = new SplitEngineService();
const audit       = new AuditService();

// Mapeamento de status Pagar.me → interno (espelha o webhook handler)
const PAGARME_STATUS_MAP: Record<string, string> = {
  paid        : 'APPROVED',
  authorized  : 'APPROVED',
  refunded    : 'REFUNDED',
  chargedback : 'CHARGEBACK',
  canceled    : 'REJECTED',
  failed      : 'REJECTED',
};

/**
 * Cria splits após aprovação manual/sync — idempotente.
 * Copia a lógica do webhook handler para garantir consistência.
 */
async function criarSplitsSeNecessario(orderId: string): Promise<void> {
  const existing = await prisma.splitRecord.count({ where: { orderId } });
  if (existing > 0) return;

  const order = await prisma.order.findUnique({
    where  : { id: orderId },
    include: { offer: { include: { product: true } } },
  });
  if (!order?.offer) return;

  const producerUserId = order.offer.product.producerId;
  const splits         = await splitEngine.calculate(order.offer.id, order.amountCents);
  await splitEngine.saveSplitRecords(orderId, splits);

  let affiliateUserId: string | undefined;
  let commissionCents = 0;

  if (order.affiliateId) {
    const [affiliate, config] = await Promise.all([
      prisma.affiliate.findUnique({ where: { id: order.affiliateId } }),
      prisma.affiliateConfig.findUnique({ where: { offerId: order.offer.id, enabled: true } }),
    ]);
    if (affiliate && config && config.commissionBps > 0) {
      commissionCents = Math.floor(order.amountCents * config.commissionBps / 10000);
      if (commissionCents > 0) {
        const producerRecord = await prisma.splitRecord.findFirst({ where: { orderId, recipientType: 'PRODUCER' } });
        if (producerRecord && producerRecord.amountCents >= commissionCents) {
          await prisma.$transaction([
            prisma.splitRecord.update({ where: { id: producerRecord.id }, data: { amountCents: producerRecord.amountCents - commissionCents } }),
            prisma.splitRecord.create({ data: { orderId, splitRuleId: producerRecord.splitRuleId, recipientType: 'AFFILIATE', recipientId: affiliate.userId, amountCents: commissionCents, status: 'PENDING' } }),
          ]);
          affiliateUserId = affiliate.userId;
        }
      }
    }
  }

  await notifyNewSale({ orderId, productName: order.offer.product.name, amountCents: order.amountCents, producerId: producerUserId, affiliateUserId, commissionCents });
}

export async function gatewayRoutes(app: FastifyInstance) {

  // ── POST /gateway/refund — reembolso ──────────────────────────
  app.post('/refund', {
    preHandler: [authenticate, requireRole('ADMIN', 'PRODUCER')],
  }, async (req, reply) => {
    const body = z.object({
      orderId    : z.string(),
      amountCents: z.number().int().positive().optional(),
      reason     : z.string().optional(),
    }).parse(req.body);

    const order = await prisma.order.findUnique({
      where  : { id: body.orderId },
      include: { offer: { include: { product: { select: { producerId: true } } } } },
    });
    if (!order) throw new NotFoundError('Pedido');

    // FIX B-34: PRODUCER só reembolsa pedidos dos próprios produtos
    if (req.user.role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      if (order.offer.product.producerId !== producer?.id) {
        throw new ForbiddenError('Você não tem permissão para reembolsar este pedido');
      }
    }

    if (!order.acquirer || !order.acquirerTxId) {
      throw new NotFoundError('Dados do adquirente não encontrados para este pedido');
    }

    if (order.status === 'REFUNDED') {
      throw new NotFoundError('Pedido já foi reembolsado');
    }

    await gateway.refund(order.acquirer, order.acquirerTxId, body.amountCents || order.amountCents);

    await prisma.order.update({
      where: { id: body.orderId },
      data : { status: 'REFUNDED', refundedAt: new Date() },
    });

    await audit.log({
      userId  : req.user.sub,
      action  : 'ORDER_REFUNDED',
      resource: `order:${body.orderId}`,
      details : { acquirer: order.acquirer, reason: body.reason, amountCents: body.amountCents || order.amountCents },
      level   : 'HIGH',
    });

    return reply.send({ message: 'Reembolso processado com sucesso' });
  });

  // ── GET /gateway/status/:orderId — status no adquirente ───────
  app.get('/status/:orderId', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const order       = await prisma.order.findUnique({ where: { id: orderId } });

    if (!order || !order.acquirer || !order.acquirerTxId) {
      throw new NotFoundError('Pedido ou dados de pagamento');
    }

    const acquirerStatus = await gateway.getStatus(order.acquirer, order.acquirerTxId);
    return reply.send({ orderId, localStatus: order.status, acquirerStatus });
  });

  // ── POST /gateway/sync/:orderId — forçar sync de status com adquirente ──
  // Útil para PIX/Boleto que ficam presos em PROCESSING sem webhook
  app.post('/sync/:orderId', {
    preHandler: [authenticate, requireRole('ADMIN', 'PRODUCER')],
  }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };

    const order = await prisma.order.findUnique({
      where  : { id: orderId },
      include: { offer: { include: { product: { select: { producerId: true } } } } },
    });
    if (!order) throw new NotFoundError('Pedido');

    if (req.user.role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      if (order.offer.product.producerId !== producer?.id) {
        throw new ForbiddenError('Você não tem permissão para sincronizar este pedido');
      }
    }

    if (!order.acquirer || !order.acquirerTxId) {
      throw new NotFoundError('Dados do adquirente não encontrados para este pedido');
    }

    // Consultar status atual diretamente no adquirente
    const acquirerRawStatus = await gateway.getStatus(order.acquirer, order.acquirerTxId);

    const newStatus = PAGARME_STATUS_MAP[acquirerRawStatus] ?? null;

    await audit.log({
      userId  : req.user.sub,
      action  : 'ORDER_STATUS_SYNC',
      resource: `order:${orderId}`,
      details : { acquirer: order.acquirer, acquirerRawStatus, localBefore: order.status, localAfter: newStatus },
      level   : 'MEDIUM',
    });

    if (!newStatus) {
      return reply.send({ orderId, localStatus: order.status, acquirerStatus: acquirerRawStatus, updated: false, reason: `Status '${acquirerRawStatus}' sem mapeamento interno` });
    }

    if (order.status === newStatus) {
      return reply.send({ orderId, localStatus: order.status, acquirerStatus: acquirerRawStatus, updated: false, reason: 'Status já está atualizado' });
    }

    logger.info({ orderId, prevStatus: order.status, newStatus, acquirerRawStatus }, 'Sync manual: atualizando status do pedido');

    await prisma.order.update({
      where: { id: orderId },
      data : {
        status    : newStatus as any,
        approvedAt: newStatus === 'APPROVED' ? new Date() : undefined,
      },
    });

    if (newStatus === 'APPROVED') {
      await criarSplitsSeNecessario(orderId);
      await dispatchWebhookEvent('payment.approved', { orderId, acquirer: order.acquirer, amountCents: order.amountCents });
    }

    return reply.send({ orderId, localStatus: newStatus, acquirerStatus: acquirerRawStatus, updated: true });
  });

  // ── GET /gateway/acquirers — status dos adquirentes ──────────
  app.get('/acquirers', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (_req, reply) => {
    // TODO: substituir por verificação real de conectividade
    return reply.send([
      { name: 'PAGARME', status: 'active',  priority: 1, mdr: '2.99%' },
      { name: 'ASAAS',   status: 'active',  priority: 2, mdr: '0.99% Pix' },
      { name: 'STONE',   status: 'active',  priority: 3, mdr: '2.89%' },
      { name: 'CIELO',   status: 'standby', priority: 4, mdr: 'variável' },
    ]);
  });
}