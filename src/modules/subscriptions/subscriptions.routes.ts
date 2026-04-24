import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, AppError } from '../../shared/errors/AppError';

const audit = new AuditService();

export async function subscriptionRoutes(app: FastifyInstance) {

  // GET /subscriptions — minhas assinaturas (cliente ou produtor)
  app.get('/', { preHandler: [authenticate] }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { status: status || undefined };
    if (req.user.role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      const offers   = producer
        ? await prisma.offer.findMany({
            where : { product: { producerId: producer.id } },
            select: { id: true },
          })
        : [];
      where.offerId = { in: offers.map(o => o.id) };
    }

    const [data, total] = await Promise.all([
      prisma.subscription.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' } }),
      prisma.subscription.count({ where }),
    ]);
    return reply.send({ data, total });
  });

  // POST /subscriptions/:id/cancel
  app.post('/:id/cancel', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body);

    const sub = await prisma.subscription.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason },
    });
    await audit.log({ userId: req.user.sub, action: 'SUBSCRIPTION_CANCELLED', resource: `sub:${id}`, level: 'MEDIUM' });
    return reply.send(sub);
  });

  // GET /subscriptions/mrr — MRR dashboard (produtor/admin)
  app.get('/mrr', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const active = await prisma.subscription.aggregate({
      where: { status: 'ACTIVE' },
      _sum: { priceCents: true },
      _count: true,
    });
    return reply.send({
      mrrCents: active._sum.priceCents || 0,
      activeCount: active._count,
    });
  });
}
