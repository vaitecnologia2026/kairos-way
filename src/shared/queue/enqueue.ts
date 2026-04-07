import { emailQueue, nfeQueue, repasesQueue, webhookQueue } from './queues';
import { prisma } from '../utils/prisma';

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
  await emailQueue.add(template, { to, subject, template, data });
}

export async function enqueueNfe(orderId: string): Promise<void> {
  // Delay de 5s para garantir que o pedido foi persistido antes de processar
  await nfeQueue.add('emit', { orderId }, { delay: 5_000 });
}

export async function enqueueRepasse(withdrawalId: string): Promise<void> {
  await repasesQueue.add('process', { withdrawalId });
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
  }
}