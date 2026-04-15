import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { NotFoundError, ForbiddenError } from '../../shared/errors/AppError';

const PROVIDERS = ['FACEBOOK', 'GA4', 'GOOGLE_ADS', 'TIKTOK', 'KWAI', 'CUSTOM'] as const;
const EVENTS    = ['ViewContent', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase'] as const;

export async function trackingRoutes(app: FastifyInstance) {

  // ── GET /tracking/checkout/:slug — público, retorna pixels da oferta ──
  // Usado pelo checkout frontend para injetar os pixels corretos
  app.get('/checkout/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };

    const offer = await prisma.offer.findUnique({
      where  : { slug, isActive: true, deletedAt: null },
      include: { product: { include: { producer: { select: { userId: true } } } } },
    });

    if (!offer) return reply.send({ pixels: [] });

    const producerUserId = offer.product.producer?.userId;
    if (!producerUserId) return reply.send({ pixels: [] });

    const pixels = await prisma.trackingPixel.findMany({
      where  : { producerId: producerUserId, isActive: true },
      select : { id: true, provider: true, pixelId: true, events: true, name: true },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({ pixels });
  });

  // ── GET /tracking — listar pixels do produtor logado ─────────────────
  app.get('/', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    const pixels = await prisma.trackingPixel.findMany({
      where  : { producerId: req.user.sub },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(pixels);
  });

  // ── POST /tracking — criar pixel ──────────────────────────────────────
  app.post('/', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    const body = z.object({
      provider: z.enum(PROVIDERS),
      name    : z.string().min(2).max(80),
      pixelId : z.string().min(1).max(200),
      isActive: z.boolean().default(true),
      events  : z.array(z.enum(EVENTS)).min(1).default(['ViewContent', 'InitiateCheckout', 'Purchase']),
    }).parse(req.body);

    const pixel = await prisma.trackingPixel.create({
      data: { ...body, producerId: req.user.sub },
    });

    return reply.status(201).send(pixel);
  });

  // ── PUT /tracking/:id — atualizar pixel ───────────────────────────────
  app.put('/:id', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const existing = await prisma.trackingPixel.findUnique({ where: { id } });
    if (!existing)                            throw new NotFoundError('Pixel');
    if (existing.producerId !== req.user.sub) throw new ForbiddenError();

    const body = z.object({
      provider: z.enum(PROVIDERS).optional(),
      name    : z.string().min(2).max(80).optional(),
      pixelId : z.string().min(1).max(200).optional(),
      isActive: z.boolean().optional(),
      events  : z.array(z.enum(EVENTS)).min(1).optional(),
    }).parse(req.body);

    const updated = await prisma.trackingPixel.update({ where: { id }, data: body });
    return reply.send(updated);
  });

  // ── DELETE /tracking/:id ──────────────────────────────────────────────
  app.delete('/:id', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const existing = await prisma.trackingPixel.findUnique({ where: { id } });
    if (!existing)                            throw new NotFoundError('Pixel');
    if (existing.producerId !== req.user.sub) throw new ForbiddenError();

    await prisma.trackingPixel.delete({ where: { id } });
    return reply.send({ message: 'Pixel removido.' });
  });
}
