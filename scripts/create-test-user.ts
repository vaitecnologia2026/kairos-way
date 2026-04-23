/**
 * Cria o usuário de teste para fluxo de esqueci-senha.
 * Rodar: DATABASE_URL="..." npx tsx scripts/create-test-user.ts
 */
import { prisma } from '../src/shared/utils/prisma';
import bcrypt from 'bcryptjs';

const EMAIL        = 'vaitecnologialp@gmail.com';
const NAME         = 'VAI Tecnologia LP';
const INITIAL_PASS = 'KairosWay@2026!';
const ROLE         = 'PRODUCER' as const;

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) {
    console.log(`Usuário já existe: ${EMAIL} (id=${existing.id}, role=${existing.role})`);
    // Reativa + reseta senha para o valor de teste
    await prisma.user.update({
      where: { id: existing.id },
      data : {
        passwordHash  : await bcrypt.hash(INITIAL_PASS, 12),
        isActive      : true,
        deletedAt     : null,
        failedAttempts: 0,
        lockedUntil   : null,
      },
    });
    console.log(`Senha resetada para: ${INITIAL_PASS}`);
    console.log(`Status: reativado`);
  } else {
    const user = await prisma.user.create({
      data: {
        email       : EMAIL,
        name        : NAME,
        role        : ROLE,
        passwordHash: await bcrypt.hash(INITIAL_PASS, 12),
        isActive    : true,
      },
    });
    console.log(`Usuário criado: ${user.email} (id=${user.id})`);

    // Como PRODUCER, precisa de Producer record (mesmo que sem KYC aprovado)
    await prisma.producer.create({
      data: {
        userId      : user.id,
        companyName : NAME,
        kycStatus   : 'APPROVED',
        isActive    : true,
        approvedAt  : new Date(),
      },
    });
    console.log(`Producer record criado`);
  }

  console.log('\nCredenciais:');
  console.log(`  Email: ${EMAIL}`);
  console.log(`  Senha: ${INITIAL_PASS}`);
  console.log(`  Role : ${ROLE}`);
  console.log('\nUse este usuário para testar /esqueci-senha.');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Erro:', e);
  await prisma.$disconnect();
  process.exit(1);
});
