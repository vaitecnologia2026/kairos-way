import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { logger } from '../../shared/utils/logger';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, ForbiddenError, AppError } from '../../shared/errors/AppError';
import { buildMelhorEnvio } from '../../shared/services/melhor-envio.service';

const audit = new AuditService();

/**
 * Logística — Melhor Envio
 * Cada produtor usa suas próprias credenciais armazenadas em UserIntegration.
 * Cotação (/quote) busca a config do produtor dono da oferta a partir do slug.
 */

async function getProducerMelhorEnvio(producerUserId: string) {
  const row = await prisma.userIntegration.findUnique({
    where: { userId_provider: { userId: producerUserId, provider: 'MELHOR_ENVIO' } },
  });
  if (!row || !row.isActive) return null;
  return buildMelhorEnvio(row.config);
}

export async function logisticsRoutes(app: FastifyInstance) {

  // ── POST /logistics/quote — cotação de frete (público, usado no checkout) ──
  app.post('/quote', async (req, reply) => {
    const body = z.object({
      offerSlug  : z.string().optional(),
      producerId : z.string().optional(),
      cepDestino : z.string().min(8),
      weightKg   : z.number().positive(),
      valueCents : z.number().int().positive(),
      heightCm   : z.number().optional(),
      widthCm    : z.number().optional(),
      lengthCm   : z.number().optional(),
    }).parse(req.body);

    // Descobre o produtor dono do produto para pegar as credenciais
    let producerUserId: string | null = null;
    if (body.offerSlug) {
      const offer = await prisma.offer.findUnique({
        where  : { slug: body.offerSlug },
        include: { product: { include: { producer: true } } },
      });
      producerUserId = offer?.product?.producer?.userId ?? null;
    } else if (body.producerId) {
      producerUserId = body.producerId;
    }

    // Credenciais do produtor
    const svc = producerUserId ? await getProducerMelhorEnvio(producerUserId) : null;

    if (!svc) {
      // Sem integração — retorna fallback simples para não quebrar o checkout
      return reply.send([
        { name: 'Indisponível', company: 'Melhor Envio', priceCents: 0, deliveryDays: 0, error: 'Produtor não configurou Melhor Envio' },
      ]);
    }

    try {
      const quotes = await svc.quote({
        fromCep   : (svc as any).cfg?.fromCep || process.env.DEFAULT_FROM_CEP || '01310100',
        toCep     : body.cepDestino,
        weightKg  : body.weightKg,
        valueCents: body.valueCents,
        heightCm  : (body as any).heightCm,
        widthCm   : (body as any).widthCm,
        lengthCm  : (body as any).lengthCm,
      });
      return reply.send(quotes);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Logistics: falha na cotação Melhor Envio');
      return reply.status(502).send({ message: 'Falha ao cotar frete', error: err.message });
    }
  });

  // ── POST /logistics/ship — criar envio no Melhor Envio ──
  app.post('/ship', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const body = z.object({
      orderId    : z.string(),
      serviceId  : z.number(),   // id da modalidade retornada por /quote
      fromAddress: z.record(z.any()),
      toAddress  : z.record(z.any()),
      volumes    : z.array(z.record(z.any())).min(1),
    }).parse(req.body);

    const order = await prisma.order.findUnique({
      where  : { id: body.orderId },
      include: { offer: { include: { product: { include: { producer: true } } } } },
    });

    if (!order) throw new NotFoundError('Pedido');
    if (order.offer.product.type !== 'PHYSICAL') throw new AppError('Produto não é físico', 422);

    const producerUserId = order.offer.product.producer?.userId;
    if (!producerUserId) throw new AppError('Produtor sem cadastro válido', 500);

    // Permissão
    if ((req.user as any).role === 'PRODUCER' && producerUserId !== (req.user as any).sub) {
      throw new ForbiddenError();
    }

    const svc = await getProducerMelhorEnvio(producerUserId);
    if (!svc) throw new AppError('Produtor não configurou Melhor Envio (seção Integrações)', 503);

    const payload = {
      service : body.serviceId,
      from    : body.fromAddress,
      to      : body.toAddress,
      volumes : body.volumes,
      options : { insurance_value: order.amountCents / 100, receipt: false, own_hand: false },
    };

    const result = await svc.createShipment(payload);

    const shipment = await prisma.shipment.upsert({
      where : { orderId: order.id },
      create: {
        orderId     : order.id,
        carrier     : 'MELHOR_ENVIO',
        service     : String(body.serviceId),
        trackingCode: result.id,
        status      : 'DISPATCHED',
        shippedAt   : new Date(),
        metadata    : { melhorEnvio: result },
      },
      update: {
        carrier     : 'MELHOR_ENVIO',
        trackingCode: result.id,
        status      : 'DISPATCHED',
        shippedAt   : new Date(),
        metadata    : { melhorEnvio: result },
      },
    });

    await audit.log({
      userId  : (req.user as any).sub,
      action  : 'MELHOR_ENVIO_SHIP_CREATED',
      resource: `order:${order.id}`,
      details : { shipmentMeId: result.id },
      level   : 'MEDIUM',
    });

    return reply.status(201).send({ shipment, melhorEnvio: result });
  });

  // ── GET /logistics/tracking/:orderId — tracking do envio ──
  app.get('/tracking/:orderId', async (req, reply) => {
    const { orderId } = req.params as { orderId: string };

    const shipment = await prisma.shipment.findFirst({
      where  : { orderId },
      include: { order: { include: { offer: { include: { product: { include: { producer: true } } } } } } },
    });
    if (!shipment) throw new NotFoundError('Envio');

    const producerUserId = shipment.order?.offer?.product?.producer?.userId;
    const svc = producerUserId ? await getProducerMelhorEnvio(producerUserId) : null;

    if (svc && shipment.trackingCode) {
      try {
        const tracking = await svc.tracking([shipment.trackingCode]);
        const meta = (shipment.metadata as any) || {};
        await prisma.shipment.update({
          where: { id: shipment.id },
          data : { metadata: { ...meta, tracking } },
        });
        return reply.send({ ...shipment, tracking });
      } catch (err: any) {
        logger.warn({ orderId, err: err.message }, 'Logistics: falha ao consultar tracking');
      }
    }

    return reply.send(shipment);
  });

  // ── GET /logistics/orders — pedidos físicos do produtor/admin ──
  app.get('/orders', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { offer: { product: { type: 'PHYSICAL' } } };
    if (status) where.status = status;

    if ((req.user as any).role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: (req.user as any).sub } });
      if (!producer) return reply.send({ data: [], total: 0 });
      where.offer.product.producerId = producer.id;
    }

    const [data, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          offer   : { include: { product: { select: { name: true, weightGrams: true } } } },
          shipment: true,
        },
        orderBy: { createdAt: 'desc' },
        skip, take: Number(limit),
      }),
      prisma.order.count({ where }),
    ]);

    return reply.send({ data, total });
  });
}
