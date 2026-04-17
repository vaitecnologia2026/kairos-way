import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { logger } from '../../shared/utils/logger';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, ForbiddenError, AppError } from '../../shared/errors/AppError';
import { jadlogService } from '../../shared/services/jadlog.service';

const audit = new AuditService();

// Helper — evita repetir cast em toda rota protegida
function user(req: any): { sub: string; role: string } {
  return req.user as any;
}

export async function logisticsRoutes(app: FastifyInstance) {

  // ── POST /logistics/quote — calcular frete (Jadlog + fallback) ──
  app.post('/quote', async (req, reply) => {
    const body = z.object({
      cepDestino : z.string().min(8, 'CEP deve ter 8 dígitos'),
      weightKg   : z.number().positive(),
      valueCents : z.number().int().positive(),
    }).parse(req.body);

    const cep = body.cepDestino.replace(/\D/g, '');

    // Tenta Jadlog
    if (await jadlogService.isConfigured()) {
      try {
        const opcoes = await jadlogService.simularFreteMultiplo(
          cep,
          body.weightKg,
          body.valueCents / 100,
        );
        if (opcoes.length > 0) {
          return reply.send(opcoes.map(o => ({
            name         : o.nome,
            modal        : o.modal,
            price        : o.valor,
            delivery_time: o.prazo,
            modalidade   : o.modalidade,
            carrier      : 'JADLOG',
          })));
        }
      } catch (err: any) {
        logger.warn({ err: err.message, cep }, 'Logistics: Jadlog indisponível, usando fallback');
      }
    }

    // Fallback com tabela fixa
    return reply.send([
      { name: 'Jadlog .PACKAGE',  price: 18.50, delivery_time: 7, modalidade: 3,  carrier: 'JADLOG' },
      { name: 'Jadlog ECONÔMICO', price: 14.90, delivery_time: 10, modalidade: 5, carrier: 'JADLOG' },
      { name: 'Jadlog EXPRESSO',  price: 35.90, delivery_time: 3, modalidade: 0,  carrier: 'JADLOG' },
    ]);
  });

  // ── POST /logistics/jadlog/ship — criar pedido na Jadlog ────────
  app.post('/jadlog/ship', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const body = z.object({
      orderId    : z.string(),
      modalidade : z.number().optional(),
    }).parse(req.body);

    if (!await jadlogService.isConfigured()) {
      throw new AppError('Jadlog não configurada — adicione JADLOG_TOKEN, JADLOG_COD_CLIENTE, JADLOG_CNPJ e JADLOG_CEP_ORIGEM no .env', 503);
    }

    const order = await prisma.order.findUnique({
      where  : { id: body.orderId },
      include: {
        offer: { include: { product: { include: { producer: true } } } },
        shipment: true,
      },
    });

    if (!order) throw new NotFoundError('Pedido');
    if (order.offer.product.type !== 'PHYSICAL') throw new AppError('Produto não é físico', 422);
    if (order.status !== 'APPROVED') throw new AppError('Pedido não aprovado', 422);

    // Verificar permissão do produtor
    if (user(req).role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: user(req).sub } });
      if (order.offer.product.producerId !== producer?.id) throw new ForbiddenError();
    }

    // Endereço do destinatário vem do metadata do pedido
    const shippingAddr = (order.metadata as any)?.shippingAddress;
    if (!shippingAddr) {
      throw new AppError('Endereço de entrega não encontrado no pedido', 422);
    }

    // Dados do remetente — lidos da config Jadlog salva pelo admin
    const jadlogCfg = await prisma.platformConfig.findUnique({ where: { key: 'jadlog' } });
    const jc: any   = jadlogCfg?.value || {};
    const remetente = {
      nome    : jc.remNome     || 'Kairos Way',
      cnpjCpf : jc.cnpj       || '',
      endereco: jc.remEndereco || '',
      numero  : jc.remNumero   || '',
      bairro  : jc.remBairro   || '',
      cidade  : jc.remCidade   || '',
      uf      : jc.remUf       || '',
      cep     : jc.cepOrigem   || '',
      email   : jc.remEmail    || '',
      fone    : jc.remFone     || '',
    };

    // Volume estimado — produtor pode configurar no produto futuramente
    const pesoKg = (order.metadata as any)?.weightKg || 1;
    const volume = {
      altura      : (order.metadata as any)?.heightCm  || 10,
      comprimento : (order.metadata as any)?.lengthCm  || 20,
      largura     : (order.metadata as any)?.widthCm   || 15,
      peso        : pesoKg,
      identificador: order.id.slice(-8).toUpperCase(),
    };

    const result = await jadlogService.incluirPedido({
      pedido  : [order.id.slice(-8).toUpperCase()],
      conteudo: order.offer.product.name.slice(0, 80),
      totPeso : pesoKg,
      totValor: order.amountCents / 100,
      modalidade: body.modalidade,
      rem: remetente,
      des: {
        nome    : order.customerName  || 'Cliente',
        cnpjCpf : order.customerDoc   || '',
        endereco: shippingAddr.endereco || shippingAddr.street || '',
        numero  : shippingAddr.numero   || shippingAddr.number || '',
        compl   : shippingAddr.compl    || shippingAddr.complement || '',
        bairro  : shippingAddr.bairro   || shippingAddr.neighborhood || '',
        cidade  : shippingAddr.cidade   || shippingAddr.city || '',
        uf      : shippingAddr.uf       || shippingAddr.state || '',
        cep     : (shippingAddr.cep || shippingAddr.zip || '').replace(/\D/g, ''),
        email   : order.customerEmail || '',
        cel     : order.customerPhone || '',
        fone    : order.customerPhone || '',
      },
      volume: [volume],
    });

    if (result.erro) {
      throw new AppError(`Jadlog: ${result.erro.descricao} — ${result.erro.detalhe || ''}`, 422);
    }

    // Criar/atualizar Shipment no banco
    const shipment = await prisma.shipment.upsert({
      where : { orderId: order.id },
      create: {
        order       : { connect: { id: order.id } },
        carrier     : 'JADLOG',
        service     : `Jadlog ${body.modalidade ?? 3}`,
        trackingCode: result.shipmentId || result.codigo || null,
        status      : 'DISPATCHED',
        shippedAt   : new Date(),
        metadata    : {
          jadlogCodigo    : result.codigo,
          jadlogShipmentId: result.shipmentId,
          etiqueta        : result.etiqueta || null,
        },
      },
      update: {
        carrier     : 'JADLOG',
        trackingCode: result.shipmentId || result.codigo || null,
        status      : 'DISPATCHED',
        shippedAt   : new Date(),
        metadata    : {
          jadlogCodigo    : result.codigo,
          jadlogShipmentId: result.shipmentId,
          etiqueta        : result.etiqueta || null,
        },
      },
    });

    await audit.log({
      userId  : user(req).sub,
      action  : 'JADLOG_SHIP_CREATED',
      resource: `order:${order.id}`,
      details : { jadlogCodigo: result.codigo, jadlogShipmentId: result.shipmentId },
      level   : 'MEDIUM',
    });

    logger.info({ orderId: order.id, jadlogCodigo: result.codigo }, 'Logistics: pedido enviado para Jadlog');

    return reply.status(201).send({
      shipment,
      jadlog: {
        codigo    : result.codigo,
        shipmentId: result.shipmentId,
        status    : result.status,
        etiqueta  : result.etiqueta,
      },
    });
  });

  // ── POST /logistics/jadlog/cancel — cancelar pedido Jadlog ──────
  app.post('/jadlog/cancel', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const body = z.object({
      orderId: z.string(),
    }).parse(req.body);

    const shipment = await prisma.shipment.findFirst({ where: { orderId: body.orderId } });
    if (!shipment) throw new NotFoundError('Envio');

    const meta = shipment.metadata as any;
    if (!meta?.jadlogShipmentId && !meta?.jadlogCodigo) {
      throw new AppError('Pedido não possui referência Jadlog', 422);
    }

    const result = await jadlogService.cancelarPedido({
      shipmentId: meta.jadlogShipmentId,
      codigo    : meta.jadlogCodigo,
    });

    await prisma.shipment.update({
      where: { id: shipment.id },
      data : { status: 'RETURNED', returnedAt: new Date() },
    });

    logger.info({ orderId: body.orderId }, 'Logistics: pedido Jadlog cancelado');
    return reply.send(result);
  });

  // ── GET /logistics/tracking/:orderId — tracking Jadlog ──────────
  app.get('/tracking/:orderId', async (req, reply) => {
    const { orderId } = req.params as { orderId: string };

    const shipment = await prisma.shipment.findFirst({
      where  : { orderId },
      include: { order: { select: { customerEmail: true, customerName: true } } },
    });

    if (!shipment) throw new NotFoundError('Envio');

    // Se tem referência Jadlog e a integração está configurada, busca tracking atualizado
    const meta = shipment.metadata as any;
    const jadlogRef = meta?.jadlogShipmentId || meta?.jadlogCodigo;

    if (jadlogRef && await jadlogService.isConfigured()) {
      try {
        const tracking = await jadlogService.consultarTracking({
          shipmentId: meta.jadlogShipmentId,
          codigo    : meta.jadlogCodigo,
        });

        const item = tracking.consulta?.[0];
        if (item?.tracking) {
          // Atualizar status no banco
          const newStatus = jadlogService.mapStatusToPrisma(item.tracking.status);
          const updateData: any = { status: newStatus };
          if (newStatus === 'DELIVERED' && !shipment.deliveredAt) updateData.deliveredAt = new Date();
          if (item.previsaoEntrega) updateData.estimatedAt = new Date(item.previsaoEntrega);

          await prisma.shipment.update({
            where: { id: shipment.id },
            data : {
              ...updateData,
              metadata: {
                ...(shipment.metadata as any),
                jadlogTracking: item.tracking,
                previsaoEntrega: item.previsaoEntrega,
              },
            },
          });

          return reply.send({
            ...shipment,
            status         : newStatus,
            estimatedAt    : item.previsaoEntrega || shipment.estimatedAt,
            deliveredAt    : newStatus === 'DELIVERED' ? (shipment.deliveredAt || new Date()) : shipment.deliveredAt,
            jadlogTracking : item.tracking,
            previsaoEntrega: item.previsaoEntrega,
          });
        }
      } catch (err: any) {
        logger.warn({ orderId, err: err.message }, 'Logistics: falha ao consultar tracking Jadlog — retornando dados locais');
      }
    }

    // Fallback: retorna dados locais do banco
    return reply.send({
      ...shipment,
      jadlogTracking: meta?.jadlogTracking || null,
      previsaoEntrega: meta?.previsaoEntrega || null,
    });
  });

  // ── GET /logistics/orders — pedidos físicos (produtor/admin) ────
  app.get('/orders', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status) where.status = status;

    if (user(req).role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: user(req).sub } });
      if (!producer) return reply.send({ data: [], total: 0 });
      where.order = { offer: { product: { producerId: producer.id } } };
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

  // ── POST /logistics/orders/:id/dispatch — despacho manual ───────
  app.post('/orders/:id/dispatch', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body   = z.object({
      carrier     : z.string().min(2),
      trackingCode: z.string().optional(),
      labelUrl    : z.string().url().optional(),
    }).parse(req.body);

    if (user(req).role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: user(req).sub } });
      const order    = await prisma.order.findUnique({
        where  : { id },
        include: { offer: { include: { product: { select: { producerId: true } } } } },
      });
      if (order?.offer.product.producerId !== producer?.id) throw new ForbiddenError();
    }

    const shipment = await prisma.shipment.upsert({
      where : { orderId: id },
      create: { order: { connect: { id } }, carrier: body.carrier, trackingCode: body.trackingCode, labelUrl: body.labelUrl, status: 'DISPATCHED', shippedAt: new Date() },
      update: { carrier: body.carrier, trackingCode: body.trackingCode, labelUrl: body.labelUrl, status: 'DISPATCHED', shippedAt: new Date() },
    });

    await audit.log({
      userId  : user(req).sub,
      action  : 'ORDER_DISPATCHED',
      resource: `order:${id}`,
      level   : 'LOW',
    });

    return reply.send(shipment);
  });
}
