// seed.ts — Kairos Way local dev seed
// Roda com: npx tsx seed.ts

import { prisma } from './src/shared/utils/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Limpando banco...');

  // Limpar na ordem correta (respeitar foreign keys)
  await prisma.auditLog.deleteMany();
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.splitRecord.deleteMany();
  await prisma.splitRule.deleteMany();
  await prisma.order.deleteMany();
  await prisma.affiliateTracking.deleteMany();
  await prisma.affiliateEnrollment.deleteMany();
  await prisma.affiliateConfig.deleteMany();
  await prisma.affiliate.deleteMany();
  await prisma.checkoutConfig.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.coproducerProduct.deleteMany();
  await prisma.coproducerRequest.deleteMany();
  await prisma.coproducer.deleteMany();
  await prisma.product.deleteMany();
  await prisma.kycDocument.deleteMany();
  await prisma.producer.deleteMany();
  await prisma.withdrawal.deleteMany();
  await prisma.platformInvoice.deleteMany();
  await prisma.session.deleteMany();
  await prisma.staffMember.deleteMany();
  await prisma.pushToken.deleteMany();
  await prisma.user.deleteMany();

  console.log('✅ Banco limpo!\n');
  console.log('🌱 Criando dados de seed...');

  const hash = await bcrypt.hash('KairosWay@2026!', 12);

  // ── ADMIN ─────────────────────────────────────────────────────
  const admin = await prisma.user.create({
    data: {
      email       : 'admin@kairosway.com.br',
      passwordHash: hash,
      name        : 'Admin Kairos',
      role        : 'ADMIN',
      isActive    : true,
    },
  });
  console.log('✅ Admin:', admin.email);

  // ── PRODUTOR ──────────────────────────────────────────────────
  const prodUser = await prisma.user.create({
    data: {
      email       : 'produtor@kairosway.com.br',
      passwordHash: hash,
      name        : 'Produtor Demo',
      role        : 'PRODUCER',
      isActive    : true,
      phone       : '47991111111',
    },
  });

  const producer = await prisma.producer.create({
    data: {
      userId     : prodUser.id,
      companyName: 'Demo Produções Ltda',
      kycStatus  : 'APPROVED',
      isActive   : true,
      approvedBy : admin.id,
      approvedAt : new Date(),
    },
  });
  console.log('✅ Produtor:', prodUser.email);

  // ── AFILIADO ──────────────────────────────────────────────────
  const affUser = await prisma.user.create({
    data: {
      email       : 'afiliado@kairosway.com.br',
      passwordHash: hash,
      name        : 'Afiliado Demo',
      role        : 'AFFILIATE',
      isActive    : true,
      phone       : '47992222222',
    },
  });

  const affiliate = await prisma.affiliate.create({
    data: {
      userId    : affUser.id,
      code      : 'DEMO2026',
      isActive  : true,
      status    : 'APPROVED',
      approvedBy: admin.id,
      approvedAt: new Date(),
    },
  });
  console.log('✅ Afiliado:', affUser.email, '| Código:', affiliate.code);

  // ── PRODUTO 1 — Digital ───────────────────────────────────────
  const prod1 = await prisma.product.create({
    data: {
      producerId : producer.id,
      name       : 'Curso de Programação Online',
      description: 'Aprenda a programar do zero ao avançado com projetos práticos.',
      type       : 'DIGITAL',
      status     : 'APPROVED',
      imageUrl   : 'https://placehold.co/600x400/0055FE/white?text=Curso+Dev',
      digitalUrl : 'https://kairosway.com.br/acesso/curso-programacao',
      isActive   : true,
      approvedBy : admin.id,
      approvedAt : new Date(),
    },
  });

  const offer1 = await prisma.offer.create({
    data: {
      productId  : prod1.id,
      name       : 'Curso Completo — Acesso Vitalício',
      slug       : 'curso-programacao-digital',
      description: 'Acesso completo e vitalício ao curso com todas as atualizações.',
      priceCents : 29700,
      type       : 'STANDARD',
      isActive   : true,
    },
  });

  await prisma.splitRule.createMany({
    data: [
      { offerId: offer1.id, recipientType: 'PLATFORM', recipientId: 'platform', basisPoints: 500,  description: 'Taxa plataforma 5%' },
      { offerId: offer1.id, recipientType: 'PRODUCER',  recipientId: null,       basisPoints: 9500, description: 'Produtor 95%' },
    ],
  });

  await prisma.affiliateConfig.create({
    data: {
      offerId      : offer1.id,
      enabled      : true,
      commissionBps: 1000,
      cookieDays   : 30,
      description  : 'Comissão de 10% por venda gerada',
    },
  });

  await prisma.affiliateEnrollment.create({
    data: {
      affiliateId: affiliate.id,
      offerId    : offer1.id,
      status     : 'ACTIVE',
      link       : `http://localhost:5173/checkout/curso-programacao-digital?ref=${affiliate.code}`,
    },
  });

  console.log('✅ Produto 1:', prod1.name);

  // ── PRODUTO 2 — Assinatura ────────────────────────────────────
  const prod2 = await prisma.product.create({
    data: {
      producerId : producer.id,
      name       : 'Mentoria Mensal Premium',
      description: 'Acesso mensal à mentoria ao vivo com sessões exclusivas.',
      type       : 'SUBSCRIPTION',
      status     : 'APPROVED',
      imageUrl   : 'https://placehold.co/600x400/27d36a/white?text=Mentoria',
      isActive   : true,
      approvedBy : admin.id,
      approvedAt : new Date(),
    },
  });

  const offer2 = await prisma.offer.create({
    data: {
      productId  : prod2.id,
      name       : 'Mentoria Premium — Mensal',
      slug       : 'mentoria-mensal-premium',
      description: 'Sessões ao vivo toda semana + grupo exclusivo no WhatsApp.',
      priceCents : 19700,
      type       : 'SUBSCRIPTION',
      isActive   : true,
    },
  });

  await prisma.splitRule.createMany({
    data: [
      { offerId: offer2.id, recipientType: 'PLATFORM', recipientId: 'platform', basisPoints: 500,  description: 'Taxa plataforma 5%' },
      { offerId: offer2.id, recipientType: 'PRODUCER',  recipientId: null,       basisPoints: 9500, description: 'Produtor 95%' },
    ],
  });

  await prisma.affiliateConfig.create({
    data: {
      offerId      : offer2.id,
      enabled      : true,
      commissionBps: 1500,
      cookieDays   : 60,
      description  : 'Comissão recorrente de 15% por assinatura',
    },
  });

  console.log('✅ Produto 2:', prod2.name);

  // ── PRODUTO 3 — Físico ────────────────────────────────────────
  const prod3 = await prisma.product.create({
    data: {
      producerId  : producer.id,
      name        : 'Kit Material Didático',
      description : 'Apostilas, caderno e canetas personalizadas para o curso.',
      type        : 'PHYSICAL',
      status      : 'APPROVED',
      imageUrl    : 'https://placehold.co/600x400/f59e0b/white?text=Kit+Material',
      weightGrams : 800,
      isActive    : true,
      approvedBy  : admin.id,
      approvedAt  : new Date(),
    },
  });

  const offer3 = await prisma.offer.create({
    data: {
      productId  : prod3.id,
      name       : 'Kit Material Didático Completo',
      slug       : 'kit-material-didatico',
      description: 'Tudo que você precisa para acompanhar o curso.',
      priceCents : 8900,
      type       : 'STANDARD',
      isActive   : true,
    },
  });

  await prisma.splitRule.createMany({
    data: [
      { offerId: offer3.id, recipientType: 'PLATFORM', recipientId: 'platform', basisPoints: 500,  description: 'Taxa plataforma 5%' },
      { offerId: offer3.id, recipientType: 'PRODUCER',  recipientId: null,       basisPoints: 9500, description: 'Produtor 95%' },
    ],
  });

  console.log('✅ Produto 3:', prod3.name);

  // ── RESUMO ────────────────────────────────────────────────────
  console.log('\n🎉 Seed concluído!\n');
  console.log('Credenciais:');
  console.log('  Admin    → admin@kairosway.com.br     / KairosWay@2026!');
  console.log('  Produtor → produtor@kairosway.com.br  / KairosWay@2026!');
  console.log('  Afiliado → afiliado@kairosway.com.br  / KairosWay@2026!');
  console.log('\nLinks de teste:');
  console.log('  Checkout     → http://localhost:5173/checkout/curso-programacao-digital');
  console.log('  Link afiliado → http://localhost:5173/checkout/curso-programacao-digital?ref=DEMO2026');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('❌ Erro no seed:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});