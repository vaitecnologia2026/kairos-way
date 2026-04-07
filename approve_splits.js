require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const result = await prisma.splitRecord.updateMany({
    where: { status: 'PENDING', recipientType: 'PRODUCER' },
    data : { status: 'PAID', paidAt: new Date() },
  });
  console.log('Split records aprovados:', result.count);
  await prisma.$disconnect();
}

run().catch(async e => { console.error(e.message); await prisma.$disconnect(); });