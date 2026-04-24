import { Worker } from 'bullmq';
import { createHmac } from 'crypto';
import axios from 'axios';
import { redisConnection } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { GatewayService } from '../../modules/gateway/gateway.service';
import { SplitEngineService } from '../../modules/split-engine/split-engine.service';
import { EmailService } from '../services/email.service';
import { NFeIoService } from '../services/nfeio.service';
import {
  webhookQueue,
  dunningQueue,
  repasesQueue,
  emailQueue,
  nfeQueue,
  logisticsQueue,
} from './queues';
import { enqueueEmail, dispatchWebhookEvent } from './enqueue';
import { notifyNewSale } from '../utils/notifyNewSale';

const gateway     = new GatewayService();
const splitEngine = new SplitEngineService();
const emailSvc    = new EmailService();
const nfeIo       = new NFeIoService();

// FIX B-68: referências persistidas — GC não pode coletar os workers
const workers: Worker[] = [];

// Intervalo do job de reconciliação (2 minutos)
const RECONCILIATION_INTERVAL_MS = 2 * 60 * 1_000;

// Status Pagar.me → status interno
const PAGARME_STATUS_MAP: Record<string, string> = {
  paid        : 'APPROVED',
  authorized  : 'APPROVED',
  refunded    : 'REFUNDED',
  chargedback : 'CHARGEBACK',
  canceled    : 'REJECTED',
  failed      : 'REJECTED',
};

export async function startWorkers() {
  workers.push(
    startWebhookWorker(),
    startDunningWorker(),
    startRepasesWorker(),
    startEmailWorker(),
    startNfeWorker(),
    startLogisticsWorker(),
  );
  logger.info(`✅ ${workers.length} Workers BullMQ iniciados`);

  // Job de reconciliação — roda imediatamente e depois a cada 2 min
  runReconciliation().catch((err) => logger.error({ err }, 'Reconciliação: erro na primeira execução'));
  setInterval(() => {
    runReconciliation().catch((err) => logger.error({ err }, 'Reconciliação: erro inesperado'));
  }, RECONCILIATION_INTERVAL_MS);

  logger.info('✅ Job de reconciliação de pagamentos iniciado (intervalo: 2 min)');
}

export async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
  logger.info('Workers BullMQ encerrados');
}

// ── RECONCILIAÇÃO DE PAGAMENTOS ───────────────────────────────────
/**
 * Verifica pedidos PROCESSING diretamente no adquirente e os aprova
 * automaticamente caso o pagamento tenha sido confirmado (ex: PIX pago
 * mas webhook não chegou ou chegou com estrutura inesperada).
 *
 * Roda a cada 2 minutos via setInterval.
 */
async function runReconciliation(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000); // últimas 24h
  const after  = new Date(Date.now() - 2 * 60 * 1_000);       // criado há mais de 2 min (evita race com checkout)

  const pendingOrders = await prisma.order.findMany({
    where: {
      status      : 'PROCESSING',
      acquirerTxId: { not: null },
      createdAt   : { gte: since, lte: after },
    },
    select: { id: true, acquirer: true, acquirerTxId: true, amountCents: true },
    take: 50, // processa no máximo 50 por rodada para não sobrecarregar a API
  });

  if (pendingOrders.length === 0) return;

  logger.info({ count: pendingOrders.length }, 'Reconciliação: verificando pedidos PROCESSING');

  for (const order of pendingOrders) {
    try {
      const rawStatus = await gateway.getStatus(order.acquirer as any, order.acquirerTxId!);
      const newStatus  = PAGARME_STATUS_MAP[rawStatus];

      if (!newStatus) continue; // still pending/waiting — nenhuma ação

      // Recarregar para garantir idempotência (pode ter sido aprovado por webhook entre os checks)
      const current = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
      if (!current || current.status !== 'PROCESSING') continue;

      logger.info({ orderId: order.id, rawStatus, newStatus }, 'Reconciliação: atualizando status do pedido');

      await prisma.order.update({
        where: { id: order.id },
        data : {
          status    : newStatus as any,
          approvedAt: newStatus === 'APPROVED' ? new Date() : undefined,
        },
      });

      if (newStatus === 'APPROVED') {
        await aprovarPedidoReconciliacao(order.id);
        await dispatchWebhookEvent('payment.approved', { orderId: order.id, acquirer: order.acquirer, amountCents: order.amountCents });
      }

    } catch (err: any) {
      // Falha em um pedido não deve parar os demais
      logger.warn({ orderId: order.id, err: err.message }, 'Reconciliação: erro ao verificar pedido');
    }
  }
}

/**
 * Cria splits e notifica após aprovação pela reconciliação.
 * Idempotente — não duplica splits se já existirem.
 */
async function aprovarPedidoReconciliacao(orderId: string): Promise<void> {
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
        await prisma.affiliateTracking.updateMany({
          where: { affiliateId: order.affiliateId, offerId: order.offer.id, orderId: null },
          data : { orderId },
        });
      }
    }
  }

  await notifyNewSale({ orderId, productName: order.offer.product.name, amountCents: order.amountCents, producerId: producerUserId, affiliateUserId, commissionCents });
  logger.info({ orderId }, 'Reconciliação: splits criados e produtor notificado');
}

// ── WEBHOOK WORKER ────────────────────────────────────────────────
function startWebhookWorker(): Worker {
  const worker = new Worker('webhooks', async (job) => {
    const { endpointId, eventId, payload } = job.data;

    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint || endpoint.status === 'INACTIVE') return;

    const signature = createHmac('sha256', endpoint.secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    const delivery = await prisma.webhookDelivery.create({
      data: { endpointId, eventId, status: 'PENDING', attemptCount: 1, lastAttemptAt: new Date() },
    });

    try {
      const response = await axios.post(endpoint.url, payload, {
        headers: {
          'Content-Type'      : 'application/json',
          'X-Kairos-Signature': `sha256=${signature}`,
          'X-Kairos-Event'    : payload.event,
        },
        timeout: 10_000,
      });

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data : { status: 'SUCCESS', httpStatus: response.status, deliveredAt: new Date() },
      });

    } catch (err: any) {
      const httpStatus = err?.response?.status || 0;
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data : { status: 'FAILED', httpStatus, responseBody: String(err?.message).slice(0, 500) },
      });
      throw err;
    }
  }, {
    connection       : redisConnection,
    defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 } },
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Webhook delivery falhou');
  });

  return worker;
}

// ── DUNNING WORKER ────────────────────────────────────────────────
function startDunningWorker(): Worker {
  const worker = new Worker('dunning', async (job) => {
    const { subscriptionId } = job.data;

    const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.status !== 'ACTIVE') return;

    if (sub.retryCount >= 3) {
      await prisma.subscription.update({
        where: { id: subscriptionId },
        data : { status: 'SUSPENDED', cancelReason: 'Dunning esgotado após 3 tentativas' },
      });

      await enqueueEmail(
        sub.customerEmail,
        'Sua assinatura foi suspensa',
        'subscription-suspended',
        {
          name       : sub.customerName || sub.customerEmail,
          productName: `Assinatura #${sub.id.slice(-8).toUpperCase()}`,
          retryCount : sub.retryCount,
        }
      );

      logger.warn({ subscriptionId }, 'Assinatura suspensa — dunning esgotado');
      return;
    }

    try {
      await gateway.processPayment({
        offerId      : sub.offerId,
        amountCents  : sub.priceCents,
        method       : 'CREDIT_CARD',
        cardToken    : sub.cardToken || '',
        customerEmail: sub.customerEmail,
        customerName : sub.customerName || '',
      });

      const nextChargeAt = calcNextCharge(sub.cycle);
      await prisma.subscription.update({
        where: { id: subscriptionId },
        data : { retryCount: 0, lastChargedAt: new Date(), nextChargeAt },
      });

      logger.info({ subscriptionId }, 'Dunning: cobrança bem-sucedida');

    } catch {
      const retryDelays = [24, 48, 72];
      const delayHours  = retryDelays[sub.retryCount] ?? 72;

      await prisma.subscription.update({
        where: { id: subscriptionId },
        data : { retryCount: sub.retryCount + 1, lastFailAt: new Date() },
      });

      await dunningQueue.add('retry', { subscriptionId }, {
        delay: delayHours * 60 * 60 * 1_000,
      });

      logger.info({ subscriptionId, attempt: sub.retryCount + 1, delayHours }, 'Dunning: retry agendado');
    }
  }, { connection: redisConnection });

  worker.on('error', (err) => logger.error({ err: err.message }, 'Dunning worker error'));
  return worker;
}

// ── REPASSES WORKER ───────────────────────────────────────────────
function startRepasesWorker(): Worker {
  const worker = new Worker('repasses', async (job) => {
    const { withdrawalId } = job.data;

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal || withdrawal.status !== 'PENDING') return;

    await prisma.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'PROCESSING' } });

    try {
      // ATIVAR quando tiver conta Asaas:
      // 1. Criar conta em https://www.asaas.com/
      // 2. Obter API key no painel
      // 3. Adicionar ASAAS_API_KEY no .env
      // 4. Descomentar o bloco abaixo

      /*
      const baseUrl = process.env.ASAAS_ENV === 'production'
        ? 'https://api.asaas.com/v3'
        : 'https://sandbox.asaas.com/api/v3';

      await axios.post(`${baseUrl}/transfers`, {
        value        : withdrawal.amountCents / 100,
        bankAccount  : {
          pixAddressKey    : withdrawal.pixKey,
          pixAddressKeyType: withdrawal.pixKeyType.toUpperCase(),
        },
        operationType: 'PIX',
        description  : `Repasse Kairos Way — saque #${withdrawalId.slice(-8).toUpperCase()}`,
      }, {
        headers: { 'access_token': process.env.ASAAS_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30_000,
      });
      */

      if (process.env.NODE_ENV !== 'production') {
        logger.info(
          { withdrawalId, pixKey: withdrawal.pixKey, amountCents: withdrawal.amountCents },
          '💸 [SIMULAÇÃO] Pix enviado — configure ASAAS_API_KEY para envio real'
        );
      } else {
        throw new Error('ASAAS_API_KEY não configurado — necessário para produção');
      }

      await prisma.withdrawal.update({
        where: { id: withdrawalId },
        data : { status: 'PAID', processedAt: new Date() },
      });

      const user = await prisma.user.findUnique({
        where : { id: withdrawal.userId },
        select: { name: true, email: true },
      });
      if (user) {
        await enqueueEmail(
          user.email,
          'Seu saque foi processado!',
          'withdrawal-paid',
          { name: user.name, amountCents: withdrawal.amountCents, pixKey: withdrawal.pixKey }
        );
      }

      logger.info({ withdrawalId, amountCents: withdrawal.amountCents }, 'Repasse processado');

    } catch (err: any) {
      await prisma.withdrawal.update({
        where: { id: withdrawalId },
        data : { status: 'FAILED', failedAt: new Date(), failReason: String(err?.message).slice(0, 500) },
      });

      const user = await prisma.user.findUnique({
        where : { id: withdrawal.userId },
        select: { name: true, email: true },
      });
      if (user) {
        await enqueueEmail(
          user.email,
          'Problema no seu saque',
          'withdrawal-failed',
          { name: user.name, amountCents: withdrawal.amountCents, reason: err?.message }
        );
      }

      throw err;
    }
  }, { connection: redisConnection });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Repasse falhou');
  });

  return worker;
}

// ── EMAIL WORKER (Resend) ─────────────────────────────────────────
function startEmailWorker(): Worker {
  const worker = new Worker('emails', async (job) => {
    const { to, subject, template, data } = job.data;

    if (!process.env.RESEND_API_KEY) {
      logger.warn({ to, template }, 'RESEND_API_KEY não configurado — email não enviado');
      return;
    }

    await emailSvc.send({ to, subject, template, data });

  }, {
    connection       : redisConnection,
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, to: job?.data?.to, err: err.message }, 'Email falhou');
  });

  return worker;
}

// ── NF-e WORKER ───────────────────────────────────────────────────
function startNfeWorker(): Worker {
  const worker = new Worker('nfe', async (job) => {
    const { orderId } = job.data;

    const order = await prisma.order.findUnique({
      where  : { id: orderId },
      include: {
        offer: {
          include: {
            product: {
              select: {
                name: true, type: true,
                producer: { select: { userId: true } },
              },
            },
          },
        },
      },
    });

    if (!order) return;

    if (order.offer.product.type === 'PHYSICAL') {
      logger.info({ orderId }, 'Produto físico — NFS-e não aplicável');
      return;
    }

    // Busca credenciais NFe.io do PRODUTOR (não global)
    const producerUserId = order.offer.product.producer?.userId;
    let nfeInstance: NFeIoService | null = null;

    if (producerUserId) {
      const integration = await prisma.userIntegration.findUnique({
        where: { userId_provider: { userId: producerUserId, provider: 'NFE_IO' } },
      });
      if (integration?.isActive && integration.config) {
        const { buildNFeIo } = await import('../services/nfeio.service');
        nfeInstance = buildNFeIo(integration.config);
      }
    }

    // Fallback para credenciais globais (env) se produtor não configurou
    if (!nfeInstance) {
      if (!process.env.NFEIO_API_KEY || !process.env.NFEIO_COMPANY_ID) {
        logger.warn({ orderId, producerUserId }, 'NFE_IO: produtor sem integração e sem fallback — NF-e não emitida');
        return;
      }
      nfeInstance = nfeIo;
    }

    // Monta endereço do order.metadata.billingAddress (salvo no checkout)
    const billing = (order.metadata as any)?.billingAddress || {};
    const customerAddress = {
      street      : billing.street,
      number      : billing.number,
      complement  : billing.complement,
      neighborhood: billing.neighborhood,
      city        : billing.city,
      state       : billing.state,
      zipCode     : billing.zipCode,
      country     : 'BRA',
    };

    try {
      const result = await nfeInstance.emitir({
        orderId        : order.id,
        customerName   : order.customerName || 'Cliente',
        customerEmail  : order.customerEmail || '',
        customerDoc    : order.customerDoc   || undefined,
        customerPhone  : order.customerPhone || undefined,
        customerAddress,
        productName    : order.offer.product.name,
        amountCents    : order.amountCents,
      });

      await prisma.order.update({
        where: { id: orderId },
        data : {
          metadata: {
            ...(order.metadata as object || {}),
            nfe: { id: result.nfeId, number: result.nfeNumber, status: result.status, pdfUrl: result.pdfUrl },
          },
        },
      });

      logger.info({ orderId, nfeId: result.nfeId }, 'NF-e emitida');

    } catch (err: any) {
      logger.error({ orderId, err: err.message }, 'NFe worker: falha ao emitir');
      throw err;
    }

  }, {
    connection       : redisConnection,
    defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 60_000 } },
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, orderId: job?.data?.orderId, err: err.message }, 'NF-e falhou');
  });

  return worker;
}

// ── LOGISTICS WORKER ──────────────────────────────────────────────
function startLogisticsWorker(): Worker {
  const worker = new Worker('logistics', async (job) => {
    const { orderId } = job.data;

    const order = await prisma.order.findUnique({
      where  : { id: orderId },
      include: { offer: { include: { product: true } }, shipment: true },
    });

    if (!order) {
      logger.warn({ orderId }, 'Logistics worker: pedido não encontrado');
      return;
    }

    // Só processa produtos físicos
    if (order.offer.product.type !== 'PHYSICAL') {
      logger.info({ orderId, type: order.offer.product.type }, 'Logistics worker: produto não-físico, ignorando');
      return;
    }

    // Se já tem shipment, não recria
    if (order.shipment) {
      logger.info({ orderId, shipmentId: order.shipment.id }, 'Logistics worker: shipment já existe');
      return;
    }

    // Criar registro de Shipment com status WAITING (aguardando despacho pelo produtor)
    await prisma.shipment.create({
      data: {
        order  : { connect: { id: orderId } },
        carrier: 'MELHOR_ENVIO',
        status : 'WAITING',
      },
    });

    logger.info({ orderId }, '📦 Logistics worker: shipment WAITING criado — produtor precisa despachar via /logistics/ship');
  }, { connection: redisConnection });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Logistics worker falhou');
  });

  return worker;
}

// ── HELPERS ───────────────────────────────────────────────────────
function calcNextCharge(cycle: string): Date {
  const d = new Date();
  switch (cycle) {
    case 'WEEKLY'    : d.setDate(d.getDate() + 7);         break;
    case 'BIWEEKLY'  : d.setDate(d.getDate() + 14);        break;
    case 'MONTHLY'   : d.setMonth(d.getMonth() + 1);       break;
    case 'QUARTERLY' : d.setMonth(d.getMonth() + 3);       break;
    case 'SEMIANNUAL': d.setMonth(d.getMonth() + 6);       break;
    case 'ANNUAL'    : d.setFullYear(d.getFullYear() + 1); break;
  }
  return d;
}