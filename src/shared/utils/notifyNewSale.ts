import { notifications, NotifType } from '../notifications/notification.service';

/**
 * Cria notificações de "nova venda" para o produtor e, se houver, para o afiliado.
 * Delega ao NotificationService para resolver os User.id corretos via tipos.
 *
 * ATENÇÃO: `producerId` aqui é o Producer.id (Product.producerId). O service faz o
 * lookup para User.id antes de persistir. Isso corrige o bug silencioso anterior
 * onde passávamos Producer.id como se fosse User.id e a FK quebrava.
 */
export async function notifyNewSale(params: {
  orderId         : string;
  productName     : string;
  amountCents     : number;
  /** Producer.id — o service resolve para Producer.userId automaticamente. */
  producerId      : string;
  /** Já é User.id (Affiliate.userId). */
  affiliateUserId?: string;
  commissionCents?: number;
}): Promise<void> {
  const { orderId, productName, amountCents, producerId, affiliateUserId, commissionCents } = params;

  const fmt = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

  await notifications.notify({
    recipient: { kind: 'producer', producerId },
    type     : NotifType.NEW_SALE,
    title    : '💰 Nova venda aprovada!',
    body     : `${fmt(amountCents)} — ${productName}`,
    orderId,
  });

  if (affiliateUserId && commissionCents && commissionCents > 0) {
    await notifications.notify({
      recipient: { kind: 'user', userId: affiliateUserId },
      type     : NotifType.NEW_COMMISSION,
      title    : '🎉 Nova comissão gerada!',
      body     : `${fmt(commissionCents)} de comissão — ${productName}`,
      orderId,
    });
  }
}
