FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl openssl-dev

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma

RUN npx prisma generate

RUN npm run build || true

RUN ls dist/app.js && echo "Build OK"

# Debug — mostra quais engines foram gerados
RUN echo "=== PRISMA ENGINES ===" && \
    find /app/node_modules/.prisma -name "*.node" -o -name "*.so*" 2>/dev/null && \
    find /app/node_modules/@prisma/engines -name "*.node" -o -name "*.so*" 2>/dev/null || true

ENV NODE_ENV=production
ENV PRISMA_CLIENT_ENGINE_TYPE=library
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:3333/health || exit 1

CMD ["node", "dist/app.js"]
