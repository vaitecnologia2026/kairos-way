# ── Dockerfile ────
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force


FROM base AS builder
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src

COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app


COPY --from=deps    /app/node_modules          ./node_modules
COPY --from=builder /app/dist                  ./dist
COPY --from=builder /app/node_modules/.prisma  ./node_modules/.prisma
COPY --from=builder /app/prisma                ./prisma

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:3000/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/app.js"]