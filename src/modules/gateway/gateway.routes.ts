import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { GatewayService } from './gateway.service';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, ForbiddenError } from '../../shared/errors/AppError';

const gateway = new GatewayService();
const audit   = new AuditService();

export async function gatewayRoutes(app: FastifyInstance) {

  // ── POST /gateway/refund — reembolso ──────────────────────────
  app.post('/refund', {
    preHandler: [authenticate, requireRole('ADMIN', 'PRODUCER')],
  }, async (req, reply) => {
    const body = z.object({
      orderId    : z.string(),
      amountCents: z.number().int().positive().optional(),
      reason     : z.string().optional(),
    }).parse(req.body);

    const order = await prisma.order.findUnique({
      where  : { id: body.orderId },
      include: { offer: { include: { product: { select: { producerId: true } } } } },
    });
    if (!order) throw new NotFoundError('Pedido');

    // FIX B-34: PRODUCER só reembolsa pedidos dos próprios produtos
    if (req.user.role === 'PRODUCER') {
      const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
      if (order.offer.product.producerId !== producer?.id) {
        throw new ForbiddenError('Você não tem permissão para reembolsar este pedido');
      }
    }

    if (!order.acquirer || !order.acquirerTxId) {
      throw new NotFoundError('Dados do adquirente não encontrados para este pedido');
    }

    if (order.status === 'REFUNDED') {
      throw new NotFoundError('Pedido já foi reembolsado');
    }

    await gateway.refund(order.acquirer, order.acquirerTxId, body.amountCents || order.amountCents);

    await prisma.order.update({
      where: { id: body.orderId },
      data : { status: 'REFUNDED', refundedAt: new Date() },
    });

    await audit.log({
      userId  : req.user.sub,
      action  : 'ORDER_REFUNDED',
      resource: `order:${body.orderId}`,
      details : { acquirer: order.acquirer, reason: body.reason, amountCents: body.amountCents || order.amountCents },
      level   : 'HIGH',
    });

    return reply.send({ message: 'Reembolso processado com sucesso' });
  });

  // ── GET /gateway/status/:orderId — status no adquirente ───────
  app.get('/status/:orderId', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const order       = await prisma.order.findUnique({ where: { id: orderId } });

    if (!order || !order.acquirer || !order.acquirerTxId) {
      throw new NotFoundError('Pedido ou dados de pagamento');
    }

    const acquirerStatus = await gateway.getStatus(order.acquirer, order.acquirerTxId);
    return reply.send({ orderId, localStatus: order.status, acquirerStatus });
  });

  // ── GET /gateway/acquirers — status dos adquirentes ──────────
  app.get('/acquirers', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (_req, reply) => {
    // TODO: substituir por verificação real de conectividade
    return reply.send([
      { name: 'PAGARME', status: 'active',  priority: 1, mdr: '2.99%' },
      { name: 'ASAAS',   status: 'active',  priority: 2, mdr: '0.99% Pix' },
      { name: 'STONE',   status: 'active',  priority: 3, mdr: '2.89%' },
      { name: 'CIELO',   status: 'standby', priority: 4, mdr: 'variável' },
    ]);
  });
}