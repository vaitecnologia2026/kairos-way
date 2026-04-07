require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  console.log('Adicionando campos avatarUrl e birthDate...');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
  `);
  console.log('✓ avatarUrl adicionado');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthDate" TIMESTAMP;
  `);
  console.log('✓ birthDate adicionado');

  await prisma.$disconnect();
  console.log('Pronto!');
}

run().catch(async e => {
  console.error('ERRO:', e.message);
  await prisma.$disconnect();
});