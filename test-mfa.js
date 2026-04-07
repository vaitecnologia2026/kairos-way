require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

async function test() {
  const user = await prisma.user.findFirst({ where: { mfaEnabled: true } });
  console.log('User:', user?.email);
  console.log('mfaSecret exists:', !!user?.mfaSecret);

  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex').slice(0, 32);
  console.log('Key length:', key.length, '(deve ser 32)');

  try {
    const buf      = Buffer.from(user.mfaSecret, 'base64');
    const iv       = buf.subarray(0, 12);
    const authTag  = buf.subarray(12, 28);
    const enc      = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const secret = decipher.update(enc).toString('utf8') + decipher.final('utf8');
    console.log('Descriptografia: OK — secret length:', secret.length);
  } catch(e) {
    console.error('Descriptografia FALHOU:', e.message);
  }

  await prisma.$disconnect();
}

test();