/**
 * Teste real do ranking de marcos — cria 3 afiliados, gera vendas APROVADAS
 * em diferentes volumes, e mostra a posição de cada um no marco.
 *
 * Rodar: DATABASE_URL="..." npx tsx scripts/test-ranking.ts
 *
 * Ao final, limpa tudo que criou. Use flag --keep para preservar.
 */
import { prisma } from '../src/shared/utils/prisma';
import crypto from 'crypto';

const KEEP = process.argv.includes('--keep');
const PREFIX = 'ranktest_';   // tag para identificar tudo que o script cria (lowercase — email-safe)

async function resolveProducerAndMilestone() {
  // Busca produtores ativos E escolhe o primeiro que tem produto aprovado
  // + oferta ativa + marco configurado. Não exige splits (o teste grava
  // orders direto no DB, sem passar pelo checkout).
  const producers = await prisma.producer.findMany({
    where  : { isActive: true },
    include: {
      user    : { select: { id: true, name: true, email: true } },
      products: {
        where  : { status: 'APPROVED', deletedAt: null },
        include: { offers: { where: { isActive: true } } },
      },
    },
  });

  for (const p of producers) {
    const offer = p.products.flatMap(pr => pr.offers)[0];
    if (!offer) continue;

    const milestone = await prisma.salesMilestone.findFirst({
      where  : { producerId: p.userId },
      orderBy: { position: 'asc' },
    });
    if (!milestone) continue;

    return { producer: p, offer, milestone };
  }

  throw new Error('Nenhum produtor com produto APROVADO + oferta ativa + marco configurado.');
}

async function createTestAffiliate(idx: number) {
  const email = `${PREFIX}af${idx}_${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name        : `${PREFIX}Afiliado ${idx}`,
      passwordHash: 'x',                   // não vai logar
      role        : 'AFFILIATE',
      isActive    : true,
    },
  });
  const affiliate = await prisma.affiliate.create({
    data: {
      userId  : user.id,
      code    : `${PREFIX}${idx}${crypto.randomBytes(3).toString('hex')}`.toUpperCase(),
      status  : 'APPROVED',
      isActive: true,
    },
  });
  return { user, affiliate };
}

async function createApprovedOrder(offer: any, affiliateId: string, idx: number) {
  const order = await prisma.order.create({
    data: {
      offerId      : offer.id,
      affiliateId,
      customerEmail: `${PREFIX}cli${idx}_${Date.now()}@test.local`,
      customerName : `${PREFIX}Cliente ${idx}`,
      amountCents  : offer.priceCents,
      paymentMethod: 'PIX',
      status       : 'APPROVED',
      approvedAt   : new Date(),
      ipAddress    : '127.0.0.1',
    },
  });
  return order;
}

function formatBRL(cents: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

async function cleanup() {
  console.log('\n── Limpando dados de teste ──');

  // Resolve os affiliateIds e userIds de teste primeiro
  const testUsers = await prisma.user.findMany({
    where : { email: { startsWith: PREFIX + 'af' } },
    select: { id: true },
  });
  const testAffs = await prisma.affiliate.findMany({
    where : { userId: { in: testUsers.map(u => u.id) } },
    select: { id: true },
  });
  const affIds  = testAffs.map(a => a.id);
  const userIds = testUsers.map(u => u.id);

  // Remove em ordem de dependência (FKs)
  const orders = await prisma.order.deleteMany({
    where: { customerEmail: { startsWith: PREFIX + 'cli' } },
  });
  const tracking = await prisma.affiliateTracking.deleteMany({
    where: { affiliateId: { in: affIds } },
  });
  const enrolls = await prisma.milestoneEnrollment.deleteMany({
    where: { affiliateId: { in: affIds } },
  });
  const affs = await prisma.affiliate.deleteMany({
    where: { id: { in: affIds } },
  });
  const users = await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });
  console.log(`  orders=${orders.count} tracking=${tracking.count} enrollments=${enrolls.count} affiliates=${affs.count} users=${users.count}`);
}

async function computeRanking(producerRecordId: string, affiliateIds: string[], targetType: 'VALUE' | 'UNITS') {
  const rows = await prisma.order.groupBy({
    by   : ['affiliateId'],
    _sum : { amountCents: true },
    _count: { _all: true },
    where: {
      status     : 'APPROVED',
      affiliateId: { not: null },
      offer      : { product: { producerId: producerRecordId } },
    },
  });

  const ranked = [...rows]
    .filter(r => r.affiliateId)
    .sort((a, b) => targetType === 'VALUE'
      ? (b._sum.amountCents ?? 0) - (a._sum.amountCents ?? 0)
      : (b._count._all ?? 0) - (a._count._all ?? 0));

  return ranked.map((r, idx) => ({
    affiliateId: r.affiliateId as string,
    position   : idx + 1,
    total      : r._sum.amountCents ?? 0,
    units      : r._count._all,
    isTest     : affiliateIds.includes(r.affiliateId as string),
  }));
}

async function main() {
  console.log('━━━ TESTE DE RANKING DE MARCOS ━━━\n');

  const { producer, offer, milestone } = await resolveProducerAndMilestone();
  console.log(`Produtor   : ${producer.user.name}  (userId=${producer.userId})`);
  console.log(`Oferta     : ${offer.name}  ${formatBRL(offer.priceCents)}  (slug=${offer.slug})`);
  console.log(`Marco      : ${milestone.name}  tipo=${milestone.targetType}  meta=${milestone.targetType === 'VALUE' ? formatBRL(milestone.targetValue) : milestone.targetValue + ' unid.'}\n`);

  // Criar 3 afiliados e atribuir número de vendas crescente:
  // af1: 1 venda   af2: 2 vendas   af3: 3 vendas
  console.log('── Criando afiliados e vendas ──');
  const created: { user: any; affiliate: any; sales: number }[] = [];
  for (let i = 1; i <= 3; i++) {
    const { user, affiliate } = await createTestAffiliate(i);
    console.log(`  af${i}: ${user.name}  (affiliateId=${affiliate.id})`);
    for (let j = 0; j < i; j++) {
      await createApprovedOrder(offer, affiliate.id, i * 10 + j);
    }
    created.push({ user, affiliate, sales: i });
  }

  // Ranking esperado: af3 (3 vendas) > af2 (2 vendas) > af1 (1 venda)
  console.log('\n── Ranking esperado ──');
  console.log('  1º af3 (3 vendas) | 2º af2 (2 vendas) | 3º af1 (1 venda)');

  console.log('\n── Ranking calculado do banco ──');
  const ranking = await computeRanking(
    producer.id,
    created.map(c => c.affiliate.id),
    milestone.targetType as 'VALUE' | 'UNITS',
  );
  for (const row of ranking) {
    const tag = row.isTest ? '[TESTE]' : '       ';
    const aff = await prisma.affiliate.findUnique({
      where  : { id: row.affiliateId },
      include: { user: { select: { name: true } } },
    });
    console.log(`  ${row.position}º ${tag} ${aff?.user?.name || row.affiliateId.slice(-8)}  — ${formatBRL(row.total)} em ${row.units} vendas`);
  }

  // Simula o que /affiliates/milestones retornaria para cada afiliado de teste
  console.log('\n── Resposta do endpoint /affiliates/milestones (simulada) ──');
  for (const c of created) {
    const idx = ranking.findIndex(r => r.affiliateId === c.affiliate.id);
    const pos = idx >= 0 ? idx + 1 : null;
    const me  = ranking.find(r => r.affiliateId === c.affiliate.id);
    const current = milestone.targetType === 'VALUE' ? (me?.total ?? 0) : (me?.units ?? 0);
    const pct = Math.min(100, Math.round((current / milestone.targetValue) * 100));
    console.log(`  ${c.user.name}: position=${pos}  current=${current}  progresso=${pct}%  reached=${current >= milestone.targetValue}`);
  }

  // Mostra se o faturamento bate com os totais
  console.log('\n── Verificação de integridade ──');
  for (const c of created) {
    const sum = await prisma.order.aggregate({
      _sum : { amountCents: true },
      _count: true,
      where: { affiliateId: c.affiliate.id, status: 'APPROVED' },
    });
    console.log(`  ${c.user.name}: DB soma=${formatBRL(sum._sum.amountCents ?? 0)} em ${sum._count} pedidos`);
  }

  if (!KEEP) {
    await cleanup();
  } else {
    console.log('\n⚠ Flag --keep ativa: dados NÃO removidos.');
    console.log(`  Para limpar depois, filtre por e-mail começando com "${PREFIX.toLowerCase()}"`);
  }

  console.log('\n━━━ FIM ━━━');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('❌ Erro:', e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
