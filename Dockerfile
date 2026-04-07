FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl openssl-dev libc6-compat

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma

# Gera o engine correto para Alpine (linux-musl)
RUN npx prisma generate

RUN npm run build || true

ENV NODE_ENV=production
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:3333/health || exit 1

# Roda generate novamente no start para garantir o engine correto
CMD ["sh", "-c", "npx prisma generate && node dist/app.js"]
