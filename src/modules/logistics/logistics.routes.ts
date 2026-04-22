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

    // CEP de origem: producer.metadata.address.zipCode tem prioridade, fallback meCfg.fromCep
    const producer = await prisma.producer.findFirst({ where: { userId: producerUserId } });
    const producerAddr = ((producer?.metadata as any) || {}).address || {};
    const meCfg = (svc as any).cfg || {};
    const fromCep = (producerAddr.zipCode || meCfg.fromCep || process.env.DEFAULT_FROM_CEP || '01310100')
      .replace(/\D/g, '');
    if (fromCep.length !== 8) throw new AppError('CEP de origem inválido — preencha endereço no Perfil', 422);

    const product = order.offer.product;
    const weightKg = Math.max(0.1, (product.weightGrams || 500) / 1000);

    try {
      const quotes = await svc.quote({
        fromCep,
        toCep     : billing.zipCode,
        weightKg,
        valueCents: order.amountCents,
        heightCm  : (product as any).heightCm || 10,
        widthCm   : (product as any).widthCm  || 15,
        lengthCm  : (product as any).lengthCm || 20,
      });
      logger.info({ orderId, fromCep, toCep: billing.zipCode, count: quotes.length, quotes },
        'Logistics: cotação retornada pelo Melhor Envio');
      return reply.send(quotes);
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message }, 'Logistics: falha cotação');
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
      // Prioriza CEP do produtor (perfil), só usa meCfg/DEFAULT como último recurso
      const fromCep = (producerAddr.zipCode || meCfg.fromCep || process.env.DEFAULT_FROM_CEP || '01310100')
        .replace(/\D/g, '');
      const toCep = (billing.zipCode || '').replace(/\D/g, '');
      const quotes = await svc.quote({
        fromCep,
        toCep,
        weightKg,
        valueCents: order.amountCents,
        heightCm  : (product as any).heightCm || 10,
        widthCm   : (product as any).widthCm  || 15,
        lengthCm  : (product as any).lengthCm || 20,
      });
      logger.info({ orderId: order.id, fromCep, toCep, quoteCount: quotes.length, quotes },
        'Logistics: cotação bruta do Melhor Envio');
      const valid = quotes.filter(q => !q.error && q.priceCents > 0);
      if (valid.length === 0) {
        // Se houver quotes com erros, mostra todos os motivos (CEP fora de área, formato inválido etc)
        const errs = quotes
          .filter(q => q.error)
          .map(q => `${q.name || q.company}: ${q.error}`)
          .join(' | ');
        const msg = errs
          ? `Transportadoras recusaram este envio — ${errs}`
          : `Nenhum serviço de entrega disponível. CEP origem=${fromCep}, destino=${toCep}. Verifique se sua conta Melhor Envio está verificada (CPF/CNPJ + endereço).`;
        throw new AppError(msg, 422);
      }
      const cheapest = valid.sort((a, b) => a.priceCents - b.priceCents)[0];
      serviceId = cheapest.id;
      logger.info({ orderId: order.id, serviceId, priceCents: cheapest.priceCents, name: cheapest.name },
        'Logistics: serviço auto-selecionado (mais barato)');
    }

    // Normaliza CPF/CNPJ (11 ou 14 dígitos — senão omite)
    const normalizeDoc = (raw?: string | null): string | undefined => {
      const d = (raw || '').replace(/\D/g, '');
      return (d.length === 11 || d.length === 14) ? d : undefined;
    };
    // Normaliza telefone (10 ou 11 dígitos — senão omite)
    const normalizePhone = (raw?: string | null): string | undefined => {
      const d = (raw || '').replace(/\D/g, '');
      return (d.length >= 10 && d.length <= 13) ? d : undefined;
    };
    // Normaliza CEP (8 dígitos — senão null)
    const normalizeCep = (raw?: string | null): string | undefined => {
      const d = (raw || '').replace(/\D/g, '');
      return d.length === 8 ? d : undefined;
    };
    // Remove campos undefined/'' do objeto (ME rejeita strings vazias em alguns campos)
    const pruneEmpty = (obj: Record<string, any>) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null || v === '') continue;
        out[k] = v;
      }
      return out;
    };

    const producerDoc   = normalizeDoc((producer?.user as any)?.document);
    const producerPhone = normalizePhone(producerMeta.phone || (producer?.user as any)?.phone);
    const producerCep   = normalizeCep(producerAddr.zipCode || producerMeta.zipCode || meCfg.fromCep);
    const customerDoc   = normalizeDoc(order.customerDoc);
    const customerPhone = normalizePhone(order.customerPhone);
    const customerCep   = normalizeCep(billing.zipCode);

    // Valida mínimo exigido pelo Melhor Envio
    if (!producerCep) throw new AppError('Produtor sem CEP de origem — preencha em Perfil ou reconecte Melhor Envio', 422);
    if (!customerCep) throw new AppError('Pedido sem CEP válido — cliente precisa ter preenchido endereço no checkout', 422);
    if (!producerDoc)   logger.warn({ userId: producerUserId }, 'Logistics: produtor sem document (CPF/CNPJ) — ME pode rejeitar');
    if (!customerDoc)   logger.warn({ orderId: order.id },   'Logistics: cliente sem document (CPF/CNPJ) — ME pode rejeitar');

    const payload = {
      service: serviceId,
      from: pruneEmpty({
        name            : producer?.user?.name || producer?.companyName || 'Remetente',
        phone           : producerPhone,
        email           : producer?.user?.email,
        document        : producerDoc && producerDoc.length === 11 ? producerDoc : undefined,
        company_document: producerDoc && producerDoc.length === 14 ? producerDoc : undefined,
        address         : producerAddr.street       || producerMeta.street,
        number          : producerAddr.number       || producerMeta.number       || 'S/N',
        complement      : producerAddr.complement   || producerMeta.complement,
        district        : producerAddr.neighborhood || producerMeta.neighborhood || 'Centro',
        city            : producerAddr.city         || producerMeta.city         || 'São Paulo',
        state_abbr      : (producerAddr.state || producerMeta.state || 'SP').toUpperCase().slice(0, 2),
        country_id      : 'BR',
        postal_code     : producerCep,
      }),
      to: pruneEmpty({
        name            : order.customerName || 'Cliente',
        phone           : customerPhone,
        email           : order.customerEmail,
        document        : customerDoc && customerDoc.length === 11 ? customerDoc : undefined,
        company_document: customerDoc && customerDoc.length === 14 ? customerDoc : undefined,
        address         : billing.street,
        number          : billing.number       || 'S/N',
        complement      : billing.complement,
        district        : billing.neighborhood || 'Centro',
        city            : billing.city,
        state_abbr      : (billing.state || '').toUpperCase().slice(0, 2),
        country_id      : 'BR',
        postal_code     : customerCep,
      }),
      products: [{
        name         : product.name,
        quantity     : 1,
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
      },
    };

    logger.info({
      orderId    : order.id,
      serviceId,
      producerCep,
      customerCep,
      hasProducerDoc: !!producerDoc,
      hasCustomerDoc: !!customerDoc,
    }, 'Logistics: enviando payload ao Melhor Envio');

    let result: any;
    try {
      result = await svc.createShipment(payload);
    } catch (err: any) {
      const me = err?.response?.data;
      logger.error({
        orderId: order.id,
        status : err?.response?.status,
        meData : JSON.stringify(me),          // stringificado para garantir que aparece no Railway
        payload: JSON.stringify(payload),
      }, 'Logistics: Melhor Envio rejeitou o createShipment');

      // Extrai erros detalhados. Se ME retornar { errors: {field: [reasons]} },
      // junta tudo: "field: reason1, reason2 | field2: reason3"
      const buildErrorList = (errs: any): string => {
        if (!errs || typeof errs !== 'object') return '';
        return Object.entries(errs)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
          .join(' | ');
      };

      const detailed = buildErrorList(me?.errors);
      const friendly = detailed
        || me?.message
        || err.message
        || 'Falha ao criar envio no Melhor Envio';

      // Retorna também o response bruto do ME para ajudar debug no front
      return reply.status(422).send({
        statusCode: 422,
        error     : 'MelhorEnvioError',
        message   : friendly,
        meResponse: me,   // para ver exatamente o que o ME mandou
      });
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
