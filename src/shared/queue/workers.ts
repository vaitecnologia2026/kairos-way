import { Worker } from 'bullmq';
import { createHmac } from 'crypto';
import axios from 'axios';
import { redisConnection } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { GatewayService } from '../../modules/gateway/gateway.service';
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
import { enqueueEmail } from './enqueue';



const gateway  = new GatewayService();
const emailSvc = new EmailService();
const nfeIo    = new NFeIoService();

// FIX B-68: referências persistidas — GC não pode coletar os workers
const workers: Worker[] = [];

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
}

export async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
  logger.info('Workers BullMQ encerrados');
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

    if (!process.env.NFEIO_API_KEY || !process.env.NFEIO_COMPANY_ID) {
      logger.warn({ orderId }, 'NFEIO não configurado — NF-e não emitida');
      return;
    }

    const order = await prisma.order.findUnique({
      where  : { id: orderId },
      include: { offer: { include: { product: { select: { name: true, type: true } } } } },
    });

    if (!order) return;

    if (order.offer.product.type === 'PHYSICAL') {
      logger.info({ orderId }, 'Produto físico — NFS-e não aplicável');
      return;
    }

    try {
      const result = await nfeIo.emitir({
        orderId      : order.id,
        customerName : order.customerName || 'Cliente',
        customerEmail: order.customerEmail || '',
        customerDoc  : order.customerDoc   || undefined,
        productName  : order.offer.product.name,
        amountCents  : order.amountCents,
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
    logger.info({ orderId }, '📦 Fulfillment — TODO: integrar fornecedor');
  }, { connection: redisConnection });

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