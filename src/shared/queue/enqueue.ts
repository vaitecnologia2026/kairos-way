import { emailQueue, nfeQueue, repasesQueue, webhookQueue, logisticsQueue } from './queues';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * Helpers de enfileiramento para uso nos modules/routes e services.
 * Não importam gateway, splitEngine ou outros services — zero circular deps.
 *
 * IMPORTANTE: todos aplicam Promise.race(queue.add, 3s timeout) — se o Redis
 * estiver lento/indisponível (Upstash DNS ENOTFOUND etc), o enqueue FALHA LOGO
 * em vez de bloquear o endpoint por minutos. O job é perdido (não é crítico —
 * notificações e NF-e têm fallbacks manuais).
 */

const ENQUEUE_TIMEOUT_MS = 3_000;

/** Envolve qualquer Promise em Promise.race com timeout, logando se expirar. */
async function raceTimeout<T>(
  p: Promise<T>,
  label: string,
  ctx: Record<string, any> = {},
): Promise<T | void> {
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`enqueue timeout (${ENQUEUE_TIMEOUT_MS}ms)`)), ENQUEUE_TIMEOUT_MS),
      ),
    ]);
  } catch (err: any) {
    logger.warn({ ...ctx, err: err.message }, `Queue: ${label} falhou (não crítico — Redis indisponível?)`);
  }
}

export async function enqueueEmail(
  to      : string,
  subject : string,
  template: string,
  data    : Record<string, any>
): Promise<void> {
  await raceTimeout(
    emailQueue.add(template, { to, subject, template, data }),
    'enqueueEmail',
    { to, template },
  );
}

export async function enqueueNfe(orderId: string): Promise<void> {
  // Delay de 5s para garantir que o pedido foi persistido antes de processar
  await raceTimeout(
    nfeQueue.add('emit', { orderId }, { delay: 5_000 }),
    'enqueueNfe',
    { orderId },
  );
}

export async function enqueueRepasse(withdrawalId: string): Promise<void> {
  await raceTimeout(
    repasesQueue.add('process', { withdrawalId }),
    'enqueueRepasse',
    { withdrawalId },
  );
}

export async function enqueueLogistics(orderId: string): Promise<void> {
  // Delay de 3s para garantir que splits e dados foram persistidos
  await raceTimeout(
    logisticsQueue.add('fulfill', { orderId }, { delay: 3_000 }),
    'enqueueLogistics',
    { orderId },
  );
}

export async function dispatchWebhookEvent(
  eventType: string,
  payload  : Record<string, any>,
  orderId? : string
): Promise<void> {
  const event = await prisma.webhookEvent.create({
    data: { orderId, eventType, payload },
  });

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { events: { has: eventType }, status: 'ACTIVE' },
  });

  if (endpoints.length === 0) {
    logger.debug({ eventType }, 'Queue: nenhum endpoint inscrito para o evento');
    return;
  }

  for (const endpoint of endpoints) {
    await raceTimeout(
      webhookQueue.add('deliver', {
        endpointId: endpoint.id,
        eventId   : event.id,
        payload   : {
          event    : eventType,
          timestamp: new Date().toISOString(),
          data     : payload,
        },
      }),
      'dispatchWebhookEvent',
      { eventType, endpointId: endpoint.id },
    );
  }
}
