/**
 * Teste de volume — Kairos Way
 * Cria N pedidos aprovados e dispara NF-e + splits para cada um
 * Uso: node volume-test.js [quantidade] [offerId]
 */

const { PrismaClient } = require('@prisma/client');
const { Queue }        = require('bullmq');

const prisma   = new PrismaClient();
const nfeQueue = new Queue('nfe', { connection: { host: '127.0.0.1', port: 6379 } });

const QTD     = parseInt(process.argv[2]) || 100;
const DELAY_MS = 100; // 100ms entre pedidos para não sobrecarregar

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`\n🚀 Iniciando teste de volume — ${QTD} pedidos\n`);

  // Buscar oferta ativa com split rules
  const offer = await prisma.offer.findFirst({
  where  : { slug: 'curso-programacao-digital', isActive: true },
  include: { splitRules: { where: { isActive: true } } },
});

  if (!offer) {
    console.error('❌ Nenhuma oferta ativa encontrada');
    process.exit(1);
  }

  if (!offer.splitRules.length) {
    console.error('❌ Oferta sem split rules configuradas');
    process.exit(1);
  }

  console.log(`📦 Oferta: ${offer.name} — R$ ${(offer.priceCents / 100).toFixed(2)}`);
  console.log(`💰 Splits: ${offer.splitRules.length} regras\n`);

  const results = { ok: 0, err: 0, splitErrs: 0, nfeErrs: 0 };
  const startTime = Date.now();

  for (let i = 1; i <= QTD; i++) {
    try {
      // 1. Criar pedido aprovado
      const order = await prisma.order.create({
        data: {
          offerId      : offer.id,
          customerEmail: `cliente${i}@teste.com`,
          customerName : `Cliente Teste ${i}`,
          customerDoc  : `${String(i).padStart(11, '0')}`,
          amountCents  : offer.priceCents,
          status       : 'APPROVED',
          paymentMethod: 'PIX',
          acquirer     : 'PAGARME',
          acquirerTxId : `ch_test_volume_${Date.now()}_${i}`,
          approvedAt   : new Date(),
          ipAddress    : '127.0.0.1',
        },
      });

      // 2. Criar split records
      try {
        const splitData = offer.splitRules.map(r => ({
          orderId      : order.id,
          splitRuleId  : r.id,
          recipientType: r.recipientType,
          recipientId  : r.recipientId,
          amountCents  : Math.floor(offer.priceCents * r.basisPoints / 10000),
          status       : 'PENDING',
        }));

        await prisma.splitRecord.createMany({ data: splitData });
      } catch (splitErr) {
        results.splitErrs++;
        console.warn(`  ⚠ Split error pedido ${order.id.slice(-8)}: ${splitErr.message}`);
      }

      // 3. Enfileirar NF-e
      try {
        await nfeQueue.add('emit', { orderId: order.id }, {
          attempts  : 3,
          backoff   : { type: 'exponential', delay: 2000 },
        });
      } catch (nfeErr) {
        results.nfeErrs++;
        console.warn(`  ⚠ NFe queue error: ${nfeErr.message}`);
      }

      results.ok++;

      // Progress a cada 10
      if (i % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate    = (i / elapsed).toFixed(1);
        console.log(`  ✅ ${i}/${QTD} pedidos — ${elapsed}s (${rate}/s)`);
      }

      await sleep(DELAY_MS);

    } catch (err) {
      results.err++;
      console.error(`  ❌ Pedido ${i} falhou: ${err.message}`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Pedidos criados    : ${results.ok}`);
  console.log(`❌ Pedidos com erro   : ${results.err}`);
  console.log(`⚠  Erros de split     : ${results.splitErrs}`);
  console.log(`⚠  Erros de NF-e queue: ${results.nfeErrs}`);
  console.log(`⏱  Tempo total        : ${totalTime}s`);
  console.log(`⚡ Taxa               : ${(QTD / totalTime).toFixed(1)} pedidos/s`);
  console.log('─'.repeat(50));

  // Verificar NF-e queue
  const waiting = await nfeQueue.getWaitingCount();
  const active  = await nfeQueue.getActiveCount();
  const done    = await nfeQueue.getCompletedCount();
  const failed  = await nfeQueue.getFailedCount();

  console.log(`\n📊 Fila NF-e:`);
  console.log(`   Aguardando : ${waiting}`);
  console.log(`   Processando: ${active}`);
  console.log(`   Concluídos : ${done}`);
  console.log(`   Falhos     : ${failed}`);

  await prisma.$disconnect();
  await nfeQueue.close();

  console.log('\n🏁 Teste concluído!\n');
}

main().catch(async err => {
  console.error('Erro fatal:', err);
  await prisma.$disconnect();
  process.exit(1);
});