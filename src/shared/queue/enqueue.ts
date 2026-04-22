import { emailQueue, nfeQueue, repasesQueue, webhookQueue, logisticsQueue } from './queues';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * Helpers de enfileiramento para uso nos modules/routes e services.
 * Não importam gateway, splitEngine ou outros services — zero circular deps.
 */

export async function enqueueEmail(
  to      : string,
  subject : string,
  template: string,
  data    : Record<string, any>
): Promise<void> {
  // Fire-and-forget com timeout — se o Redis estiver lento/indisponível,
  // NÃO bloqueia o fluxo principal (aprovar produtor, webhook, etc).
  try {
    await Promise.race([
      emailQueue.add(template, { to, subject, template, data }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue timeout')), 3000)),
    ]);
    logger.debug({ to, template }, 'Queue: email enfileirado');
  } catch (err: any) {
    logger.warn({ to, template, err: err.message }, 'Queue: enqueueEmail falhou (não crítico)');
  }
}

export async function enqueueNfe(orderId: string): Promise<void> {
  // Delay de 5s para garantir que o pedido foi persistido antes de processar
  await nfeQueue.add('emit', { orderId }, { delay: 5_000 });
  logger.debug({ orderId }, 'Queue: NF-e enfileirada');
}

export async function enqueueRepasse(withdrawalId: string): Promise<void> {
  await repasesQueue.add('process', { withdrawalId });
  logger.debug({ withdrawalId }, 'Queue: repasse enfileirado');
}

export async function enqueueLogistics(orderId: string): Promise<void> {
  // Delay de 3s para garantir que splits e dados foram persistidos
  await logisticsQueue.add('fulfill', { orderId }, { delay: 3_000 });
  logger.debug({ orderId }, 'Queue: logistics enfileirado');
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
  }

  for (const endpoint of endpoints) {
    await webhookQueue.add('deliver', {
      endpointId: endpoint.id,
      eventId   : event.id,
      payload   : {
        event    : eventType,
        timestamp: new Date().toISOString(),
        data     : payload,
      },
    });
    logger.debug({ eventType, endpointId: endpoint.id }, 'Queue: webhook enfileirado para entrega');
  }
}