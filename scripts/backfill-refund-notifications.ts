/**
 * Backfill de notificações de reembolso perdidas.
 *
 * Todas as solicitações de refund feitas antes do fix do NotificationService
 * tinham a notificação engolida silenciosamente (Producer.id gravado como
 * User.id → FK violation → catch silent).
 *
 * Este script varre Order.metadata.refundRequest e cria a notificação para
 * o produtor (e afiliado, se houver) caso ainda não exista uma notification
 * de REFUND_* para esse orderId/userId.
 *
 * Uso:  npx tsx scripts/backfill-refund-notifications.ts [--dry]
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { notifications, NotifType } from '../src/shared/notifications/notification.service';

const prisma = new PrismaClient();
const DRY   = process.argv.includes('--dry');

function fmtBRL(cents: number) {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

async function main() {
  console.log(`🔍 Buscando pedidos com refundRequest${DRY ? ' (DRY RUN)' : ''}...`);

  const orders = await prisma.order.findMany({
    where: {
      metadata: { path: ['refundRequest'], not: Prisma.DbNull },
    },
    include: {
      offer    : { include: { product: { select: { name: true, producerId: true } } } },
      affiliate: { select: { userId: true } },
    },
  });

  console.log(`   ${orders.length} pedidos encontrados.`);

  let created   = 0;
  let skipped   = 0;
  let noProducer = 0;

  for (const o of orders) {
    const meta      = (o.metadata as any) || {};
    const refund    = meta.refundRequest as { reason?: string; status?: string } | undefined;
    if (!refund) continue;

    const producerId = o.offer?.product?.producerId;
    if (!producerId) { noProducer++; continue; }

    // Já existe notificação de refund para este pedido? (qualquer user)
    const existing = await prisma.notification.count({
      where: {
        orderId: o.id,
        type   : { in: [NotifType.REFUND_PROCESSED, NotifType.REFUND_REQUESTED, NotifType.COMMISSION_CANCELLED] },
      },
    });
    if (existing > 0) { skipped++; continue; }

    const productName = o.offer?.product?.name || 'Produto';
    const shortId     = o.id.slice(-8).toUpperCase();
    const amountFmt   = fmtBRL(o.amountCents);
    const status      = refund.status || 'PENDING';
    const reason      = refund.reason || '—';

    if (!DRY) {
      await notifications.notify({
        recipient: { kind: 'producer', producerId },
        type     : status === 'PROCESSED' ? NotifType.REFUND_PROCESSED : NotifType.REFUND_REQUESTED,
        title    : status === 'PROCESSED'
          ? `Reembolso processado — ${productName}`
          : `Solicitação de reembolso — ${productName}`,
        body     : status === 'PROCESSED'
          ? `${amountFmt} reembolsado para o cliente (pedido #${shortId}). Motivo: ${reason}.`
          : `O cliente solicitou reembolso de ${amountFmt} (pedido #${shortId}). Aguarda análise manual. Motivo: ${reason}.`,
        orderId  : o.id,
      });
      created++;

      if (o.affiliate?.userId) {
        await notifications.notify({
          recipient: { kind: 'user', userId: o.affiliate.userId },
          type     : NotifType.COMMISSION_CANCELLED,
          title    : `Comissão cancelada — ${productName}`,
          body     : `A venda de ${amountFmt} foi reembolsada (pedido #${shortId}). Sua comissão foi estornada.`,
          orderId  : o.id,
        });
        created++;
      }
    } else {
      console.log(`  + producer ${producerId} ← ${productName} #${shortId} (${status})`);
      created++;
      if (o.affiliate?.userId) {
        console.log(`  + affiliate ${o.affiliate.userId} ← comissão cancelada #${shortId}`);
        created++;
      }
    }
  }

  console.log('');
  console.log(`✅ Backfill concluído${DRY ? ' (DRY RUN)' : ''}`);
  console.log(`   Notificações criadas/simuladas: ${created}`);
  console.log(`   Pulados (já existe notif):     ${skipped}`);
  console.log(`   Pedidos sem producerId:         ${noProducer}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
