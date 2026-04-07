const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Força geração usando o binário local do prisma
const prismaBin = path.join(__dirname, 'node_modules', 'prisma', 'build', 'index.js');
const prismaClientBin = path.join(__dirname, 'node_modules', '.bin', 'prisma');

console.log('Prisma bin exists:', fs.existsSync(prismaBin));
console.log('Prisma .bin exists:', fs.existsSync(prismaClientBin));

try {
  console.log('Tentando gerar com node direto...');
  const result = execSync(`node "${prismaBin}" generate`, { 
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env }
  });
  console.log('Sucesso!');
} catch(e) {
  console.error('Falhou:', e.message);
  
  // Tenta caminho alternativo
  try {
    console.log('\nTentando caminho alternativo...');
    execSync(`node node_modules/prisma/build/index.js generate`, { 
      stdio: 'inherit',
      cwd: __dirname
    });
  } catch(e2) {
    console.error('Também falhou:', e2.message);
  }
}