import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { AppError } from '../../shared/errors/AppError';
import { AuditService } from '../audit/audit.service';
import { GatewayService } from '../gateway/gateway.service';
import { AcquirerName } from '@prisma/client';
import { notifications, NotifType } from '../../shared/notifications/notification.service';

const auditService = new AuditService();
const gateway      = new GatewayService();

/** Formata centavos em "R$ X,XX" para uso em notificações */
function fmtBRL(cents: number) {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

// ── SCHEMAS ───────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  name    : z.string().min(2),
  email   : z.string().email(),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email   : z.string().email(),
  password: z.string().min(1),
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

/** Vincula orders existentes (sem customerId) ao usuário pelo email */
async function linkOrdersByEmail(userId: string, email: string) {
  await prisma.order.updateMany({
    where: { customerEmail: email, customerId: null },
    data : { customerId: userId },
  });
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

export const customerRoutes: FastifyPluginAsync = async (app) => {

  // POST /customer/register — cria conta de comprador
  app.post('/register', async (req, reply) => {
    const { name, email, password } = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });

    if (existing) {
      // Conta já existe — se for CUSTOMER, tenta login direto
      if (existing.role !== 'CUSTOMER') {
        throw new AppError('Este e-mail já está cadastrado com outro perfil.', 409);
      }
      // Retorna erro amigável para o front tratar como "já tem conta"
      throw new AppError('Este e-mail já possui uma conta. Faça login para continuar.', 409);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role    : 'CUSTOMER',
        isActive: true,
      },
    });

    // Vincula orders anteriores pelo email
    await linkOrdersByEmail(user.id, email);

    // Cria sessão
    const accessToken  = app.jwt.sign({ sub: user.id, email: user.email, role: user.role, name: user.name }, { expiresIn: '15m' });
    const refreshToken = app.jwt.sign({ sub: user.id, type: 'refresh' }, { expiresIn: '7d' });

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await prisma.session.create({
      data: {
        userId   : user.id,
        accessToken,
        refreshToken,
        expiresAt,
        ip       : req.ip,
        userAgent: req.headers['user-agent'] || '',
      },
    });

    return reply.status(201).send({
      user: {
        id   : user.id,
        name : user.name,
        email: user.email,
        role : user.role,
      },
      accessToken,
      refreshToken,
    });
  });

  // POST /customer/link-orders — vincula orders pós-login (ex: login em conta existente)
  app.post('/link-orders', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const user   = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw new AppError('Usuário não encontrado', 404);

    await linkOrdersByEmail(userId, user.email);
    return reply.send({ ok: true });
  });

  // GET /customer/orders — meus pedidos
  app.get('/orders', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const user   = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw new AppError('Usuário não encontrado', 404);

    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { customerId   : userId },
          { customerEmail: user.email },
        ],
      },
      include: {
        offer: {
          select: {
            name          : true,
            priceCents    : true,
            slug          : true,
            product       : {
              select: { name: true, imageUrl: true, type: true },
            },
            checkoutConfig: { select: { guaranteeDays: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send({ data: orders });
  });

  // POST /customer/orders/:orderId/refund-request — reembolso via Pagar.me + notificações
  app.post('/orders/:orderId/refund-request', { preHandler: [authenticate] }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const { reason }  = z.object({ reason: z.string().min(5, 'Descreva o motivo') }).parse(req.body);
    const userId      = req.user.sub;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user) throw new AppError('Usuário não encontrado', 404);

    // Busca pedido com todos os dados necessários
    const order = await prisma.order.findFirst({
      where: {
        id    : orderId,
        status: 'APPROVED',
        OR    : [{ customerId: userId }, { customerEmail: user.email }],
      },
      include: {
        offer: {
          include: {
            checkoutConfig: { select: { guaranteeDays: true } },
            product       : { select: { name: true, producerId: true } },
          },
        },
        affiliate: { select: { userId: true } },
      },
    });
    if (!order) throw new AppError('Pedido não encontrado ou não elegível para devolução', 404);

    // Verifica janela de reembolso (guaranteeDays configurado pelo produtor)
    const guaranteeDays = order.offer?.checkoutConfig?.guaranteeDays ?? 30;
    const windowEnd     = new Date(order.approvedAt ?? order.createdAt);
    windowEnd.setDate(windowEnd.getDate() + guaranteeDays);
    if (new Date() > windowEnd) {
      throw new AppError(
        `Prazo de reembolso encerrado. O limite é de ${guaranteeDays} dias após a confirmação da compra.`,
        422
      );
    }

    // Impede solicitação duplicada
    const meta = (order.metadata as any) || {};
    if (meta.refundRequest) throw new AppError('Já existe uma solicitação de reembolso para este pedido', 409);

    const productName = order.offer?.product?.name ?? 'Produto';
    const amountFmt   = fmtBRL(order.amountCents);
    const shortId     = orderId.slice(-8).toUpperCase();

    // ── Tenta processar reembolso via Pagar.me ──────────────────
    let refundStatus: 'PROCESSED' | 'PENDING' = 'PENDING';

    if (order.acquirerTxId && order.acquirer) {
      try {
        await gateway.refund(order.acquirer as AcquirerName, order.acquirerTxId, order.amountCents);
        refundStatus = 'PROCESSED';
      } catch {
        // Falha na API: salva como pendente para tratativa manual
        refundStatus = 'PENDING';
      }
    }

    // ── Atualiza pedido ──────────────────────────────────────────
    await prisma.order.update({
      where: { id: orderId },
      data : {
        status    : refundStatus === 'PROCESSED' ? 'REFUNDED' : 'PENDING',
        refundedAt: refundStatus === 'PROCESSED' ? new Date() : undefined,
        metadata  : {
          ...meta,
          refundRequest: {
            reason      : reason.trim(),
            requestedAt : new Date().toISOString(),
            requestedBy : userId,
            status      : refundStatus,
          },
        },
      },
    });

    // ── Cancela split records pendentes ─────────────────────────
    if (refundStatus === 'PROCESSED') {
      await prisma.splitRecord.updateMany({
        where: { orderId, status: 'PENDING' },
        data : { status: 'CANCELLED' },
      });
    }

    // ── Notifica produtor (resolve User.id via producerId) ──────
    const producerId = order.offer?.product?.producerId;
    if (producerId) {
      await notifications.notify({
        recipient: { kind: 'producer', producerId },
        type     : refundStatus === 'PROCESSED' ? NotifType.REFUND_PROCESSED : NotifType.REFUND_REQUESTED,
        title    : refundStatus === 'PROCESSED'
          ? `Reembolso processado — ${productName}`
          : `Solicitação de reembolso — ${productName}`,
        body     : refundStatus === 'PROCESSED'
          ? `${amountFmt} reembolsado para o cliente (pedido #${shortId}). Motivo: ${reason}.`
          : `O cliente solicitou reembolso de ${amountFmt} (pedido #${shortId}). Aguarda análise manual. Motivo: ${reason}.`,
        orderId,
      });
    }

    // ── Notifica afiliado (se houver) — affiliate.userId já é User.id ──
    if (order.affiliate?.userId) {
      await notifications.notify({
        recipient: { kind: 'user', userId: order.affiliate.userId },
        type     : NotifType.COMMISSION_CANCELLED,
        title    : `Comissão cancelada — ${productName}`,
        body     : `A venda de ${amountFmt} foi reembolsada (pedido #${shortId}). Sua comissão foi estornada.`,
        orderId,
      });
    }

    await auditService.log({
      userId,
      action   : 'REFUND_REQUESTED',
      resource : `order:${orderId}`,
      details  : { reason, refundStatus, amountCents: order.amountCents, productName },
      level    : 'HIGH',
      ip       : req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.send({
      ok    : true,
      status: refundStatus,
      message: refundStatus === 'PROCESSED'
        ? 'Reembolso processado com sucesso.'
        : 'Solicitação recebida. Nossa equipe analisará em até 5 dias úteis.',
    });
  });

  // GET /customer/marketplace — produtos aprovados para vitrine pública
  app.get('/marketplace', async (req, reply) => {
    const { type, search } = req.query as { type?: string; search?: string };

    const products = await prisma.product.findMany({
      where: {
        status: 'APPROVED',
        ...(type   ? { type: type as any } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      include: {
        offers: {
          where  : { isActive: true, type: 'STANDARD' },
          orderBy: { createdAt: 'asc' },
          take   : 1,
          select : { priceCents: true, slug: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Só retorna produtos que têm ao menos uma oferta ativa
    const result = products
      .filter(p => p.offers.length > 0)
      .map(p => ({
        id       : p.id,
        name     : p.name,
        type     : p.type,
        imageUrl : p.imageUrl,
        slug     : p.offers[0].slug,
        price    : p.offers[0].priceCents,
        offerName: p.offers[0].name,
      }));

    return reply.send({ data: result });
  });
};
