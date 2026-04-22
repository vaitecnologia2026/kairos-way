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

  // ── GET /logistics/quote-order/:orderId — cotação baseada num pedido ──
  app.get('/quote-order/:orderId', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'AFFILIATE')],
  }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const order = await prisma.order.findUnique({
      where  : { id: orderId },
      include: { offer: { include: { product: { include: { producer: true } } } } },
    });
    if (!order) throw new NotFoundError('Pedido');

    const producerUserId = order.offer.product.producer?.userId;
    if (!producerUserId) throw new AppError('Produtor sem cadastro válido', 500);

    const svc = await getProducerMelhorEnvio(producerUserId);
    if (!svc) throw new AppError('Produtor não configurou Melhor Envio', 503);

    const billing = (order.metadata as any)?.billingAddress || {};
    if (!billing.zipCode) throw new AppError('Pedido sem endereço de destino', 422);

    const product = order.offer.product;
    const weightKg = Math.max(0.1, (product.weightGrams || 500) / 1000);

    try {
      const quotes = await svc.quote({
        fromCep   : (svc as any).cfg?.fromCep || process.env.DEFAULT_FROM_CEP || '01310100',
        toCep     : billing.zipCode,
        weightKg,
        valueCents: order.amountCents,
        heightCm  : (product as any).heightCm || 10,
        widthCm   : (product as any).widthCm  || 15,
        lengthCm  : (product as any).lengthCm || 20,
      });
      return reply.send(quotes);
    } catch (err: any) {
      return reply.status(502).send({ message: 'Falha ao cotar', error: err.message });
    }
  });

  // ── POST /logistics/ship — criar envio no Melhor Envio (auto ou manual) ──
  // Body { orderId, serviceId? } — se não vier serviceId, usa o mais barato disponível
  app.post('/ship', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'AFFILIATE')],
  }, async (req, reply) => {
    try {
    const body = z.object({
      orderId  : z.string(),
      serviceId: z.number().optional(),
    }).parse(req.body);

    const order = await prisma.order.findUnique({
      where  : { id: body.orderId },
      include: { offer: { include: { product: { include: { producer: true } } } } },
    });

    if (!order) throw new NotFoundError('Pedido');
    if (order.offer.product.type !== 'PHYSICAL') throw new AppError('Produto não é físico', 422);
    if (order.status !== 'APPROVED') throw new AppError('Pedido não aprovado', 422);

    const producerUserId = order.offer.product.producer?.userId;
    if (!producerUserId) throw new AppError('Produtor sem cadastro válido', 500);

    // Permissão — produtor/afiliado só despacha os próprios pedidos
    const role = (req.user as any).role;
    if ((role === 'PRODUCER' || role === 'AFFILIATE') && producerUserId !== (req.user as any).sub) {
      throw new ForbiddenError();
    }

    const svc = await getProducerMelhorEnvio(producerUserId);
    if (!svc) throw new AppError('Produtor não configurou Melhor Envio (seção Integrações)', 503);

    // Monta endereços e volume automaticamente
    const billing = (order.metadata as any)?.billingAddress || {};
    if (!billing.zipCode || !billing.street) {
      throw new AppError('Pedido sem endereço completo — não é possível despachar', 422);
    }

    // Busca dados do produtor para montar endereço de origem
    const producer = await prisma.producer.findFirst({
      where  : { userId: producerUserId },
      include: { user: true },
    });
    const producerMeta = (producer?.metadata as any) || {};
    const producerAddr = producerMeta.address || {};
    const meCfg        = (svc as any).cfg || {};

    const product  = order.offer.product;
    const weightKg = Math.max(0.1, (product.weightGrams || 500) / 1000);

    // Se não vier serviceId, faz cotação e pega o mais barato
    let serviceId = body.serviceId;
    if (!serviceId) {
      const quotes = await svc.quote({
        fromCep   : meCfg.fromCep || producerAddr.zipCode || process.env.DEFAULT_FROM_CEP || '01310100',
        toCep     : billing.zipCode,
        weightKg,
        valueCents: order.amountCents,
      });
      const valid = quotes.filter(q => !q.error && q.priceCents > 0);
      if (valid.length === 0) throw new AppError('Nenhum serviço de entrega disponível para este CEP', 422);
      const cheapest = valid.sort((a, b) => a.priceCents - b.priceCents)[0];
      serviceId = cheapest.id;
      logger.info({ orderId: order.id, serviceId, priceCents: cheapest.priceCents, name: cheapest.name },
        'Logistics: serviço auto-selecionado (mais barato)');
    }

    const payload = {
      service: serviceId,
      from: {
        name         : producer?.user?.name || producer?.companyName || 'Remetente',
        phone        : producerMeta.phone   || '11999999999',
        email        : producer?.user?.email || '',
        document     : (producer?.user as any)?.document || '',
        company_document: '',
        state_register: '',
        address      : producerAddr.street       || producerMeta.street       || 'Rua Não Informada',
        number       : producerAddr.number       || producerMeta.number       || 'S/N',
        complement   : producerAddr.complement   || '',
        district     : producerAddr.neighborhood || producerMeta.neighborhood || 'Centro',
        city         : producerAddr.city         || producerMeta.city         || 'São Paulo',
        state_abbr   : (producerAddr.state || producerMeta.state || 'SP').toUpperCase().slice(0, 2),
        country_id   : 'BR',
        postal_code  : (meCfg.fromCep || producerAddr.zipCode || '01310100').replace(/\D/g, ''),
        note         : '',
      },
      to: {
        name         : order.customerName || 'Cliente',
        phone        : order.customerPhone || '11999999999',
        email        : order.customerEmail || '',
        document     : (order.customerDoc || '').replace(/\D/g, ''),
        company_document: '',
        state_register: '',
        address      : billing.street,
        number       : billing.number       || 'S/N',
        complement   : billing.complement   || '',
        district     : billing.neighborhood || '',
        city         : billing.city,
        state_abbr   : (billing.state || '').toUpperCase().slice(0, 2),
        country_id   : 'BR',
        postal_code  : billing.zipCode.replace(/\D/g, ''),
        note         : '',
      },
      products: [{
        name    : product.name,
        quantity: 1,
        unitary_value: order.amountCents / 100,
      }],
      volumes: [{
        height: (product as any).heightCm || 10,
        width : (product as any).widthCm  || 15,
        length: (product as any).lengthCm || 20,
        weight: weightKg,
      }],
      options: {
        insurance_value: order.amountCents / 100,
        receipt        : false,
        own_hand       : false,
        reverse        : false,
        non_commercial : false,
        invoice        : { key: '' },
      },
    };

    let result: any;
    try {
      result = await svc.createShipment(payload);
    } catch (err: any) {
      const me = err?.response?.data;
      logger.error({
        orderId: order.id,
        status : err?.response?.status,
        data   : me,
        payload,
      }, 'Logistics: Melhor Envio rejeitou o createShipment');
      // Extrai mensagem legível do ME
      const friendly = me?.message
        || (me?.errors && typeof me.errors === 'object'
              ? Object.entries(me.errors).map(([k, v]) => `${k}: ${(Array.isArray(v) ? v.join(', ') : v)}`).join(' | ')
              : null)
        || err.message
        || 'Falha ao criar envio no Melhor Envio';
      throw new AppError(friendly, 422);
    }

    if (!result?.id) {
      logger.error({ orderId: order.id, result }, 'Logistics: Melhor Envio retornou sem id');
      throw new AppError('Melhor Envio retornou resposta inválida', 502);
    }

    const shipment = await prisma.shipment.upsert({
      where : { orderId: order.id },
      create: {
        orderId     : order.id,
        carrier     : 'MELHOR_ENVIO',
        service     : String(serviceId),
        trackingCode: result.id,
        status      : 'DISPATCHED',
        shippedAt   : new Date(),
        metadata    : { melhorEnvio: result },
      },
      update: {
        carrier     : 'MELHOR_ENVIO',
        service     : String(serviceId),
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
      details : { shipmentMeId: result.id, serviceId },
      level   : 'MEDIUM',
    });

    logger.info({ orderId: order.id, shipmentMeId: result.id }, 'Logistics: envio criado no Melhor Envio');
    return reply.status(201).send({ shipment, melhorEnvio: result });
    } catch (err: any) {
      // Captura tudo — AppError/NotFoundError já tem status próprio, deixa passar
      if (err?.statusCode && typeof err.statusCode === 'number') throw err;
      // Erros não esperados: loga stack completo e retorna mensagem útil
      logger.error({
        orderId : (req.body as any)?.orderId,
        err     : err?.message,
        name    : err?.name,
        stack   : err?.stack?.split('\n').slice(0, 5).join(' | '),
        meResp  : err?.response?.data,
      }, 'Logistics /ship: exceção não tratada');

      const meMsg = err?.response?.data?.message
        || (err?.response?.data?.errors && JSON.stringify(err.response.data.errors))
        || err?.message
        || 'Erro desconhecido';
      return reply.status(500).send({
        statusCode: 500,
        error     : 'ShipError',
        message   : `Falha ao despachar: ${meMsg}`,
        hint      : 'Verifique se o produtor preencheu endereço no perfil, se o Melhor Envio está ativo e se o pedido tem endereço do cliente.',
      });
    }
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
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'AFFILIATE')],
  }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { offer: { product: { type: 'PHYSICAL' } } };
    if (status) where.status = status;

    if ((req.user as any).role === 'PRODUCER' || (req.user as any).role === 'AFFILIATE') {
      // Afiliado co-produtor também tem um Producer record
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
