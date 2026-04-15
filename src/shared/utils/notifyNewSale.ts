import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Cria notificações de "nova venda" para o produtor e, se houver, para o afiliado.
 * Fire-and-forget — nunca lança exceção para não quebrar o fluxo principal.
 */
export async function notifyNewSale(params: {
  orderId        : string;
  productName    : string;
  amountCents    : number;
  producerUserId : string;
  affiliateUserId?: string;
  commissionCents?: number;
}): Promise<void> {
  const { orderId, productName, amountCents, producerUserId, affiliateUserId, commissionCents } = params;

  const fmt = (cents: number) =>
    `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

  const creates: Parameters<typeof prisma.notification.createMany>[0]['data'] = [
    {
      userId : producerUserId,
      type   : 'NEW_SALE',
      title  : '💰 Nova venda aprovada!',
      body   : `${fmt(amountCents)} — ${productName}`,
      orderId,
    },
  ];

  if (affiliateUserId && commissionCents && commissionCents > 0) {
    creates.push({
      userId : affiliateUserId,
      type   : 'NEW_SALE',
      title  : '🎉 Nova comissão gerada!',
      body   : `${fmt(commissionCents)} de comissão — ${productName}`,
      orderId,
    });
  }

  try {
    await prisma.notification.createMany({ data: creates });
    logger.info({ orderId, producerUserId, affiliateUserId }, 'Notificações de venda criadas');
  } catch (err: any) {
    logger.warn({ err: err.message, orderId }, 'Falha ao criar notificações de venda — não crítico');
  }
}
