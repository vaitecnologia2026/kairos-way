// ── OFFERS ROUTES ─────────────────────────────────────────────────
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { SplitEngineService } from '../split-engine/split-engine.service';
import { prisma } from '../../shared/utils/prisma';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/errors/AppError';
import { nanoid } from 'nanoid';

const splitEngine = new SplitEngineService();

export async function offerRoutes(app: FastifyInstance) {
  // POST /offers (criar oferta para um produto)
  app.post('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const body = z.object({
      productId: z.string(),
      name: z.string().min(3),
      description: z.string().optional(),
      priceCents: z.number().int().positive(),
      type: z.enum(['STANDARD', 'UPSELL', 'ORDERBUMP', 'SUBSCRIPTION']).default('STANDARD'),
    }).parse(req.body);

    // Verificar propriedade do produto
    const product = await prisma.product.findUnique({ where: { id: body.productId } });
    if (!product) throw new NotFoundError('Produto');
    if (req.user.role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      if (product.producerId !== producer?.id) throw new ForbiddenError();
    }

    const offer = await prisma.offer.create({
      data: {
        ...body,
        slug: `${body.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${nanoid(6)}`,
      },
    });

    return reply.status(201).send(offer);
  });

  // GET /offers/:id
  app.get('/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const offer = await prisma.offer.findUnique({
      where: { id },
      include: { splitRules: { where: { isActive: true } }, product: true },
    });
    if (!offer) throw new NotFoundError('Oferta');
    return reply.send(offer);
  });

  // GET /offers/by-slug/:slug (público — checkout)
  app.get('/by-slug/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const offer = await prisma.offer.findUnique({
      where: { slug, isActive: true },
      include: {
        product: { select: { name: true, description: true, imageUrl: true, type: true } },
        splitRules: { where: { isActive: true } },
        checkoutConfig: true,
      },
    });
    if (!offer) throw new NotFoundError('Oferta');
    return reply.send(offer);
  });

  // PUT /offers/:id (atualiza — inativa antiga, cria nova versão de splits)
  app.put('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      priceCents: z.number().int().positive().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);

    const offer = await prisma.offer.update({ where: { id }, data: body });
    return reply.send(offer);
  });

  // POST /offers/:id/splits — configurar splits de uma oferta
  app.post('/:id/splits', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      splits: z.array(z.object({
        recipientType: z.enum(['PLATFORM', 'PRODUCER', 'COPRODUCER', 'AFFILIATE']),
        recipientId: z.string().optional(),
        basisPoints: z.number().int().positive(),
        description: z.string().optional(),
      })),
    }).parse(req.body);

    // REGRA DE NEGÓCIO: taxa da plataforma sempre 5% (500 bps) — não configurável pelo produtor
    const PLATFORM_FEE_BPS = 500;

    // Remove qualquer PLATFORM que o produtor tente enviar
    const userSplits = body.splits.filter((s: any) => s.recipientType !== 'PLATFORM');

    // Valida que os splits do produtor somam exatamente 9500 bps (95%)
    const userTotal = userSplits.reduce((s: number, r: any) => s + r.basisPoints, 0);
    if (userTotal !== 10000 - PLATFORM_FEE_BPS) {
      throw new ValidationError(
        `Seus splits devem somar 95% (9500 bps) — 5% é reservado para a plataforma. Atual: ${userTotal} bps (${userTotal / 100}%)`
      );
    }

    // Preencher recipientId automaticamente por tipo
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });

    const splitsNormalized = [
      // Taxa da plataforma sempre primeiro e sempre 5%
      {
        recipientType: 'PLATFORM' as const,
        recipientId  : process.env.PLATFORM_USER_ID ?? 'platform',
        basisPoints  : PLATFORM_FEE_BPS,
        description  : 'Taxa da plataforma (5%)',
      },
      // Splits do produtor com recipientId normalizado
      ...userSplits.map((s: any) => ({
        ...s,
        recipientId:
          s.recipientType === 'PRODUCER'
            ? producer?.userId ?? s.recipientId
            : s.recipientId ?? null,
      })),
    ];

    await splitEngine.configureSplits(id, splitsNormalized);
    const updated = await splitEngine.getOfferSplits(id);
    return reply.send({ message: 'Splits configurados com sucesso', splits: updated });
  });

  // GET /offers/:id/splits — ver splits de uma oferta
  app.get('/:id/splits', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const splits = await splitEngine.getOfferSplits(id);
    return reply.send(splits);
  });

  // GET /offers/:id/link — gerar link de checkout
  app.get('/:id/link', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const offer = await prisma.offer.findUnique({ where: { id } });
    if (!offer) throw new NotFoundError('Oferta');
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return reply.send({ url: `${baseUrl}/checkout/${offer.slug}` });
  });

  // GET /offers/:id/calculate — simular cálculo de split
  app.post('/:id/calculate', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ amountCents: z.number().int().positive() }).parse(req.body);
    const splits = await splitEngine.calculate(id, body.amountCents);
    return reply.send({ splits, totalCents: body.amountCents });
  });
}