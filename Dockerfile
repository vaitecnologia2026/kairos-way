# ── Dockerfile ──────────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# Dependências de produção
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Build
FROM base AS builder
COPY package*.json tsconfig.json ./
RUN npm ci
# Forçar versão correta do prisma e client
RUN npm install prisma@5.22.0 @prisma/client@5.22.0 --save-exact
COPY src ./src
COPY prisma ./prisma
RUN node_modules/.bin/prisma generate
RUN npm run build

# Produção
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps    /app/node_modules          ./node_modules
# Sobrescrever com os node_modules do builder que têm o prisma correto
COPY --from=builder /app/node_modules/.prisma  ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma  ./node_modules/@prisma
COPY --from=builder /app/dist                  ./dist
COPY --from=builder /app/prisma                ./prisma

EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:3333/health || exit 1

CMD ["node", "dist/app.js"]
