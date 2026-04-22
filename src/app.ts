import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { prisma } from './shared/utils/prisma';
import { redis } from './shared/utils/redis';
import { logger } from './shared/utils/logger';
import { AppError } from './shared/errors/AppError';

// Routes
import { uploadRoutes } from './modules/upload/upload.routes';
import { authRoutes } from './modules/auth/auth.routes';
import { producerRoutes } from './modules/producers/producers.routes';
import { productRoutes } from './modules/products/products.routes';
import { offerRoutes } from './modules/offers/offers.routes';
import { gatewayRoutes } from './modules/gateway/gateway.routes';
import { checkoutRoutes } from './modules/checkout/checkout.routes';
import { affiliatesRoutes } from './modules/affiliates/affiliates.routes';
import { coproducerRequestRoutes } from './modules/coproducers/coproducer-requests.routes';

import { coproducerRoutes } from './modules/coproducers/coproducers.routes';
import { subscriptionRoutes } from './modules/subscriptions/subscriptions.routes';
import { logisticsRoutes } from './modules/logistics/logistics.routes';
import { financialRoutes } from './modules/financial/financial.routes';
import { webhookRoutes } from './modules/webhooks/webhooks.routes';
import { reportRoutes } from './modules/reports/reports.routes';
import { auditRoutes } from './modules/audit/audit.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { customerRoutes }       from './modules/customer/customer.routes';
import { notificationRoutes }   from './modules/notifications/notifications.routes';
import { milestoneRoutes }      from './modules/producers/milestones.routes';
import { trackingRoutes }       from './modules/tracking/tracking.routes';
import { integrationsRoutes }   from './modules/integrations/integrations.routes';

// Queue workers
import { startWorkers } from './shared/queue/workers';

const app = Fastify({
  logger: process.env.NODE_ENV === 'production'
    ? { level: 'info' }
    : { level: 'debug', transport: { target: 'pino-pretty' } },
  trustProxy: true,
});

async function bootstrap() {
  // ── PLUGINS ──────────────────────────────────────────────────
  await app.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN || '15m' },
  });

  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: 60000,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Limite de requisições atingido. Tente novamente em 1 minuto.',
    }),
  });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

  // ── RAW BODY CAPTURE (para HMAC de webhooks) ─────────────────
  // Captura o payload original antes do parse JSON para validação de assinatura.
  // Sem isso, JSON.stringify(req.body) pode diferir do payload que o adquirente assinou.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body as string;
    const str = (body as string || '').trim();
    if (!str) { done(null, {}); return; }
    try {
      done(null, JSON.parse(str));
    } catch (err: any) {
      err.statusCode = 400;
      done(err);
    }
  });

  // ── GLOBAL ERROR HANDLER ─────────────────────────────────────
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        message: error.message,
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: error.message,
        details: error.validation,
      });
    }

    logger.error(error, 'Unhandled error');
    return reply.status(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Ocorreu um erro interno. Tente novamente.',
    });
  });

  // ── HEALTH CHECK ─────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  }));

  // ── ROUTES ───────────────────────────────────────────────────
  await app.register(uploadRoutes,       { prefix: '/upload' });
  await app.register(authRoutes,         { prefix: '/auth' });
  await app.register(producerRoutes,     { prefix: '/producers' });
  await app.register(productRoutes,      { prefix: '/products' });
  await app.register(offerRoutes,        { prefix: '/offers' });
  await app.register(gatewayRoutes,      { prefix: '/gateway' });
  await app.register(checkoutRoutes,     { prefix: '/checkout' });
  await app.register(affiliatesRoutes,    { prefix: '/affiliates' });
  await app.register(coproducerRequestRoutes, { prefix: '/coproducer-requests' });
  await app.register(coproducerRoutes,   { prefix: '/coproducers' });
  await app.register(subscriptionRoutes, { prefix: '/subscriptions' });
  await app.register(logisticsRoutes,    { prefix: '/logistics' });
  await app.register(financialRoutes,    { prefix: '/financial' });
  await app.register(webhookRoutes,      { prefix: '/webhooks' });
  await app.register(reportRoutes,       { prefix: '/reports' });
  await app.register(auditRoutes,        { prefix: '/audit' });
  await app.register(adminRoutes,        { prefix: '/admin' });
  await app.register(dashboardRoutes,    { prefix: '/dashboard' });
  await app.register(customerRoutes,     { prefix: '/customer' });
  await app.register(notificationRoutes, { prefix: '/notifications' });
  await app.register(milestoneRoutes,    { prefix: '/producers/milestones' });
  await app.register(trackingRoutes,     { prefix: '/tracking' });
  await app.register(integrationsRoutes, { prefix: '/integrations' });

  // ── START QUEUE WORKERS ──────────────────────────────────────
  await startWorkers();

  // ── START SERVER ─────────────────────────────────────────────
  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info(`🚀 Kairos Way API rodando na porta ${port}`);
}

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM'] as const;
signals.forEach((signal) => {
  process.on(signal, async () => {
    logger.info(`Recebido ${signal}, desligando...`);
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  });
});

bootstrap().catch((err) => {
  logger.error(err, 'Falha ao iniciar o servidor');
  process.exit(1);
});