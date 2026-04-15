import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { AppError } from '../../shared/errors/AppError';

// Paleta de cores padrão para atribuição automática
const AUTO_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6',
];

function pickAutoColor(existingColors: string[]): string {
  const unused = AUTO_COLORS.filter(c => !existingColors.includes(c));
  if (unused.length > 0) return unused[0];
  return AUTO_COLORS[Math.floor(Math.random() * AUTO_COLORS.length)];
}

const milestoneSchema = z.object({
  name       : z.string().min(1).max(80),
  color      : z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  targetType : z.enum(['VALUE', 'UNITS']).default('VALUE'),
  targetValue: z.number().int().min(1),
  reward     : z.string().min(1).max(2000),
  position   : z.number().int().min(0).optional(),
});

export const milestoneRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /producers/milestones ─────────────────────────────────
  // Lista marcos + progresso atual do produtor
  app.get('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;

    const milestones = await prisma.salesMilestone.findMany({
      where  : { producerId: userId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    // Calcula progresso: soma de vendas APPROVED dos produtos do produtor
    const [valueSales, unitSales] = await Promise.all([
      prisma.order.aggregate({
        _sum : { amountCents: true },
        where: {
          status: 'APPROVED',
          offer : { product: { producerId: userId } },
        },
      }),
      prisma.order.count({
        where: {
          status: 'APPROVED',
          offer : { product: { producerId: userId } },
        },
      }),
    ]);

    const totalValueCents = valueSales._sum.amountCents ?? 0;
    const totalUnits      = unitSales;

    const data = milestones.map(m => {
      const current    = m.targetType === 'VALUE' ? totalValueCents : totalUnits;
      const percentage = Math.min(100, Math.round((current / m.targetValue) * 100));
      const reached    = current >= m.targetValue;
      return { ...m, current, percentage, reached };
    });

    return reply.send({
      data,
      summary: { totalValueCents, totalUnits },
    });
  });

  // ── POST /producers/milestones ────────────────────────────────
  app.post('/', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const body   = milestoneSchema.parse(req.body);

    // Cor automática se não fornecida
    let color = body.color;
    if (!color) {
      const existing = await prisma.salesMilestone.findMany({
        where : { producerId: userId },
        select: { color: true },
      });
      color = pickAutoColor(existing.map(m => m.color));
    }

    // Posição padrão = último + 1
    let position = body.position;
    if (position === undefined) {
      const last = await prisma.salesMilestone.findFirst({
        where  : { producerId: userId },
        orderBy: { position: 'desc' },
        select : { position: true },
      });
      position = (last?.position ?? -1) + 1;
    }

    const milestone = await prisma.salesMilestone.create({
      data: {
        producerId : userId,
        name       : body.name,
        color,
        targetType : body.targetType,
        targetValue: body.targetValue,
        reward     : body.reward,
        position,
      },
    });

    return reply.status(201).send(milestone);
  });

  // ── PUT /producers/milestones/:id ─────────────────────────────
  app.put('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const { id } = req.params as { id: string };
    const body   = milestoneSchema.partial().parse(req.body);

    const milestone = await prisma.salesMilestone.findFirst({
      where: { id, producerId: userId },
    });
    if (!milestone) throw new AppError('Marco não encontrado', 404);

    // Cor automática se explicitamente enviada como null/vazia
    let color = body.color ?? undefined;
    if (body.color === null as any || body.color === '') {
      const existing = await prisma.salesMilestone.findMany({
        where : { producerId: userId, id: { not: id } },
        select: { color: true },
      });
      color = pickAutoColor(existing.map(m => m.color));
    }

    const updated = await prisma.salesMilestone.update({
      where: { id },
      data : {
        ...(body.name        !== undefined && { name       : body.name }),
        ...(color            !== undefined && { color }),
        ...(body.targetType  !== undefined && { targetType : body.targetType }),
        ...(body.targetValue !== undefined && { targetValue: body.targetValue }),
        ...(body.reward      !== undefined && { reward     : body.reward }),
        ...(body.position    !== undefined && { position   : body.position }),
      },
    });

    return reply.send(updated);
  });

  // ── DELETE /producers/milestones/:id ──────────────────────────
  app.delete('/:id', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const { id } = req.params as { id: string };

    const milestone = await prisma.salesMilestone.findFirst({
      where: { id, producerId: userId },
    });
    if (!milestone) throw new AppError('Marco não encontrado', 404);

    await prisma.salesMilestone.delete({ where: { id } });

    return reply.send({ ok: true });
  });

  // ── PUT /producers/milestones/reorder ─────────────────────────
  // Recebe array de { id, position } para reordenar em lote
  app.put('/reorder', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const userId = req.user.sub;
    const { items } = z.object({
      items: z.array(z.object({ id: z.string(), position: z.number().int() })),
    }).parse(req.body);

    await prisma.$transaction(
      items.map(({ id, position }) =>
        prisma.salesMilestone.updateMany({
          where: { id, producerId: userId },
          data : { position },
        })
      )
    );

    return reply.send({ ok: true });
  });
};
