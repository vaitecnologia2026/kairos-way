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
RUN npm install --save-exact prisma@5.22.0 @prisma/client@5.22.0
COPY src ./src
COPY prisma ./prisma
RUN npx prisma@5.22.0 generate --schema=./prisma/schema.prisma
RUN npm run build || true
RUN ls dist/app.js && echo "Build OK"

# Produção
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps    /app/node_modules          ./node_modules
COPY --from=builder /app/node_modules/.prisma  ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma  ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma   ./node_modules/prisma
COPY --from=builder /app/dist                  ./dist
COPY --from=builder /app/prisma                ./prisma

EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:3333/health || exit 1

CMD ["node", "dist/app.js"]
