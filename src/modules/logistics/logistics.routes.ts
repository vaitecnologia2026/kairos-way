import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, ForbiddenError } from '../../shared/errors/AppError';
import axios from 'axios';

const audit = new AuditService();

export async function logisticsRoutes(app: FastifyInstance) {

  // ── POST /logistics/quote — calcular frete ────────────────────
  app.post('/quote', async (req, reply) => {
    const body = z.object({
      cepDestino : z.string().length(8, 'CEP deve ter 8 dígitos'),
      weightGrams: z.number().int().positive(),
      heightCm   : z.number().positive().optional(),
      widthCm    : z.number().positive().optional(),
      lengthCm   : z.number().positive().optional(),
    }).parse(req.body);

    try {
      const response = await axios.post(
        'https://melhorenvio.com.br/api/v2/me/shipment/calculate',
        {
          from   : { postal_code: process.env.ORIGIN_CEP || '01001000' },
          to     : { postal_code: body.cepDestino },
          package: {
            weight: body.weightGrams / 1000,
            width : body.widthCm    || 10,
            height: body.heightCm   || 10,
            length: body.lengthCm   || 10,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.MELHOR_ENVIO_TOKEN}`,
            Accept        : 'application/json',
          },
          timeout: 8000,
        }
      );
      return reply.send(response.data);
    } catch {
      // Fallback com tabela fixa se API indisponível
      return reply.send([
        { name: 'PAC Correios',   price: 18.50, delivery_time: 7 },
        { name: 'SEDEX Correios', price: 35.90, delivery_time: 2 },
      ]);
    }
  });

  // ── GET /logistics/orders — pedidos físicos ───────────────────
  app.get('/orders', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status) where.status = status;

    // FIX B-37: PRODUCER vê apenas envios dos próprios produtos
    if (req.user.role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      if (!producer) return reply.send({ data: [], total: 0 });

      where.order = {
        offer: { product: { producerId: producer.id } },
      };
    }

    const [data, total] = await Promise.all([
      prisma.shipment.findMany({
        where,
        include: {
          order: { select: { customerName: true, customerEmail: true, amountCents: true, id: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip, take: Number(limit),
      }),
      prisma.shipment.count({ where }),
    ]);

    return reply.send({ data, total, page: Number(page), limit: Number(limit) });
  });

  // ── GET /logistics/orders/:id/tracking ───────────────────────
  app.get('/orders/:id/tracking', async (req, reply) => {
    const { id } = req.params as { id: string };
    const shipment = await prisma.shipment.findFirst({ where: { orderId: id } });
    if (!shipment) throw new NotFoundError('Envio');
    return reply.send(shipment);
  });

  // ── POST /logistics/orders/:id/dispatch — marcar como despachado
  app.post('/orders/:id/dispatch', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body   = z.object({
      carrier     : z.string().min(2),
      trackingCode: z.string().optional(),
      labelUrl    : z.string().url().optional(),
    }).parse(req.body);

    // PRODUCER só despacha pedidos dos próprios produtos
    if (req.user.role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      const order    = await prisma.order.findUnique({
        where  : { id },
        include: { offer: { include: { product: { select: { producerId: true } } } } },
      });
      if (order?.offer.product.producerId !== producer?.id) throw new ForbiddenError();
    }

    const shipment = await prisma.shipment.upsert({
      where : { orderId: id },
      create: { orderId: id, ...body, status: 'DISPATCHED', shippedAt: new Date() },
      update: { ...body, status: 'DISPATCHED', shippedAt: new Date() },
    });

    await audit.log({
      userId  : req.user.sub,
      action  : 'ORDER_DISPATCHED',
      resource: `order:${id}`,
      level   : 'LOW',
    });

    return reply.send(shipment);
  });
}