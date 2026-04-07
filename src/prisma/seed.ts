import { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed do banco de dados...');

  // ── ADMIN ──────────────────────────────────────────────────────
  const adminEmail = 'admin@kairosway.com.br';
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existing) {
    const admin = await prisma.user.create({
      data: {
        name: 'Administrador Kairos Way',
        email: adminEmail,
        passwordHash: await bcrypt.hash('KairosWay@2026!', 12),
        role: 'ADMIN',
        isActive: true,
      },
    });
    console.log(`✅ Admin criado: ${admin.email}`);
  } else {
    console.log('ℹ️  Admin já existe');
  }

  // ── PRODUTOR DEMO ─────────────────────────────────────────────
  const prodEmail = 'produtor@kairosway.com.br';
  const existingProd = await prisma.user.findUnique({ where: { email: prodEmail } });

  if (!existingProd) {
    const prod = await prisma.user.create({
      data: {
        name: 'Produtor Demo',
        email: prodEmail,
        passwordHash: await bcrypt.hash('KairosWay@2026!', 12),
        role: 'PRODUCER',
        isActive: true,
        document: '12345678000195',
        phone: '11999999999',
        producer: {
          create: {
            companyName: 'Demo Produtos Ltda',
            kycStatus: 'APPROVED',
            isActive: true,
            approvedAt: new Date(),
          },
        },
      },
    });

    // Produto demo
    const producer = await prisma.producer.findUnique({ where: { userId: prod.id } });
    const product = await prisma.product.create({
      data: {
        producerId: producer!.id,
        name: 'JAMU Black — Produto Demo',
        description: 'Produto de demonstração para testes',
        type: 'PHYSICAL',
        status: 'APPROVED',
        category: 'Saúde',
        weightGrams: 300,
        isActive: true,
        approvedAt: new Date(),
      },
    });

    // Oferta demo com splits
    const offer = await prisma.offer.create({
      data: {
        productId: product.id,
        name: 'Oferta Padrão',
        slug: 'jamu-black-padrao',
        priceCents: 9700, // R$ 97,00
        type: 'STANDARD',
        isActive: true,
      },
    });

    // Splits: Plataforma 5% | Produtor 75% | Co-prod 20%
    await prisma.splitRule.createMany({
      data: [
        { offerId: offer.id, recipientType: 'PLATFORM',  basisPoints: 500,  description: 'Taxa plataforma' },
        { offerId: offer.id, recipientType: 'PRODUCER',  recipientId: prod.id, basisPoints: 7500, description: 'Produtor' },
        { offerId: offer.id, recipientType: 'COPRODUCER', basisPoints: 2000, description: 'Co-produtor' },
      ],
    });

    // Checkout config
    await prisma.checkoutConfig.create({
      data: {
        offerId: offer.id,
        primaryColor: '#0055FE',
        pixEnabled: true,
        cardEnabled: true,
        maxInstallments: 12,
        guaranteeDays: 30,
      },
    });

    console.log(`✅ Produtor demo criado: ${prodEmail}`);
    console.log(`✅ Produto demo criado: ${product.name}`);
    console.log(`✅ Oferta demo criada: ${offer.slug} (R$ 97,00)`);
  } else {
    console.log('ℹ️  Produtor demo já existe');
  }

  console.log('✅ Seed concluído!');
  console.log('');
  console.log('Credenciais de acesso:');
  console.log('  Admin:    admin@kairosway.com.br  /  KairosWay@2026!');
  console.log('  Produtor: produtor@kairosway.com.br  /  KairosWay@2026!');
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
