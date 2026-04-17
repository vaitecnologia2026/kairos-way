// ── REPORTS ROUTES ───────────────────────────────────────────────
import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';

export async function reportRoutes(app: FastifyInstance) {

  // GET /reports/sales
  app.get('/sales', { preHandler: [authenticate] }, async (req, reply) => {
    const { from, to, startDate, endDate, page = '1', limit = '50', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const dateFrom = from || startDate;
    const dateTo   = to   || endDate;

    const where: any = {};
    if (dateFrom) where.createdAt = { gte: new Date(`${dateFrom}T00:00:00.000Z`) };
    if (dateTo)   where.createdAt = { ...(where.createdAt || {}), lte: new Date(`${dateTo}T23:59:59.999Z`) };
    if (status) where.status = status;

    if (req.user.role === 'PRODUCER') {
      const p = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      where.offer = { product: { producerId: p?.id } };
    }

    const [data, total, aggregate] = await Promise.all([
      prisma.order.findMany({
        where, skip, take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          offer: { include: { product: { select: { name: true } } } },
          affiliate: { include: { user: { select: { name: true } } } },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.aggregate({ where: { ...where, status: 'APPROVED' }, _sum: { amountCents: true } }),
    ]);

    return reply.send({
      data, total,
      page: Number(page), limit: Number(limit),
      totalRevenueCents: aggregate._sum.amountCents || 0,
    });
  });

  // GET /reports/affiliates — ranking de afiliados com receita
  app.get('/affiliates', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    // Busca pedidos aprovados com afiliado
    const orders = await prisma.order.findMany({
      where  : { status: 'APPROVED', affiliateId: { not: null } },
      include: { affiliate: { include: { user: { select: { name: true, email: true } } } } },
      orderBy: { createdAt: 'desc' },
    });

    // Agrupa por afiliado
    const map: Record<string, { affiliateId: string; name: string; email: string; code: string; vendas: number; receitaCents: number }> = {};
    for (const o of orders) {
      if (!o.affiliate) continue;
      const id = o.affiliateId!;
      if (!map[id]) {
        const aff = await prisma.affiliate.findUnique({ where: { userId: o.affiliate.userId } });
        map[id] = {
          affiliateId : id,
          name        : o.affiliate.user.name,
          email       : o.affiliate.user.email,
          code        : aff?.code || '—',
          vendas      : 0,
          receitaCents: 0,
        };
      }
      map[id].vendas++;
      map[id].receitaCents += o.amountCents;
    }

    const ranking = Object.values(map).sort((a, b) => b.receitaCents - a.receitaCents);
    return reply.send(ranking);
  });

  // GET /reports/coproducers — co-produtores com receita (admin vê todos)
  app.get('/coproducers', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'STAFF')] }, async (req, reply) => {
    // Busca todos os Coproducers cadastrados
    const coproducers = await prisma.coproducer.findMany({
      where  : { isActive: true },
      include: { user: { select: { name: true, email: true } } },
    });

    // Para cada co-produtor, soma os splits
    const result = await Promise.all(coproducers.map(async (cp) => {
      const agg = await prisma.splitRecord.groupBy({
        by    : ['status'],
        where : { recipientId: cp.userId, recipientType: 'COPRODUCER' },
        _sum  : { amountCents: true },
        _count: { id: true },
      });

      let totalCents = 0, paidCents = 0, pendingCents = 0, count = 0;
      for (const row of agg) {
        totalCents += row._sum.amountCents || 0;
        count      += row._count.id;
        if (row.status === 'PAID') paidCents   += row._sum.amountCents || 0;
        else                       pendingCents += row._sum.amountCents || 0;
      }

      return {
        recipientId : cp.userId,
        name        : cp.user.name,
        email       : cp.user.email,
        totalCents,
        paidCents,
        pendingCents,
        count,
      };
    }));

    return reply.send(result.filter(r => r.count > 0).sort((a, b) => b.totalCents - a.totalCents));
  });

  // GET /reports/my-coproducers — co-produtores ativos do produtor
  app.get('/my-coproducers', { preHandler: [authenticate, requireRole('PRODUCER')] }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer) return reply.send([]);

    const coproducers = await prisma.coproducerProduct.findMany({
      where  : { product: { producerId: producer.id }, isActive: true },
      include: {
        coproducer: { include: { user: { select: { name: true, email: true } } } },
        product   : { select: { name: true } },
      },
    });

    return reply.send(coproducers);
  });

  // GET /reports/products — produtos com mais vendas
  app.get('/products', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const orders = await prisma.order.findMany({
      where  : { status: 'APPROVED' },
      include: { offer: { include: { product: { select: { id: true, name: true, type: true } } } } },
    });

    const map: Record<string, { productId: string; name: string; type: string; vendas: number; receitaCents: number }> = {};
    for (const o of orders) {
      const p = o.offer?.product;
      if (!p) continue;
      if (!map[p.id]) map[p.id] = { productId: p.id, name: p.name, type: p.type, vendas: 0, receitaCents: 0 };
      map[p.id].vendas++;
      map[p.id].receitaCents += o.amountCents;
    }

    return reply.send(Object.values(map).sort((a, b) => b.receitaCents - a.receitaCents));
  });

  // GET /reports/chargebacks
  app.get('/chargebacks', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const orders = await prisma.order.findMany({
      where: { status: 'CHARGEBACK' },
      include: { offer: { include: { product: { select: { name: true } } } } },
      orderBy: { chargebackAt: 'desc' }, take: 100,
    });
    return reply.send(orders);
  });

  // GET /reports/mrr
  app.get('/mrr', { preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')] }, async (req, reply) => {
    const result = await prisma.subscription.aggregate({
      where: { status: 'ACTIVE' },
      _sum: { priceCents: true },
      _count: true,
    });
    return reply.send({ mrrCents: result._sum.priceCents || 0, activeSubscriptions: result._count });
  });
}