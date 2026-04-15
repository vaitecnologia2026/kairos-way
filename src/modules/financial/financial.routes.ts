import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { SplitEngineService } from '../split-engine/split-engine.service';
import { AuditService } from '../audit/audit.service';
import { prisma } from '../../shared/utils/prisma';
import { AppError } from '../../shared/errors/AppError';
import { logger } from '../../shared/utils/logger';
import { whatsAppService } from '../../shared/services/whatsapp.service';

const splitEngine = new SplitEngineService();
const audit = new AuditService();

export async function financialRoutes(app: FastifyInstance) {

  // GET /financial/balance — saldo disponível
  app.get('/balance', { preHandler: [authenticate] }, async (req, reply) => {
    const balance = await splitEngine.getUserBalance(req.user.sub);
    return reply.send(balance);
  });

  // GET /financial/splits/pending-admin — admin vê todos os splits pendentes
  app.get('/splits/pending-admin', { preHandler: [authenticate, requireRole('ADMIN', 'STAFF')] }, async (req, reply) => {
    const splits = await prisma.splitRecord.findMany({
      where  : { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take   : 100,
    });
    return reply.send(splits);
  });

  // GET /financial/splits — histórico de splits recebidos
  app.get('/splits', { preHandler: [authenticate] }, async (req, reply) => {
    const { page = '1', limit = '50', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const [data, total] = await Promise.all([
      prisma.splitRecord.findMany({
        where: {recipientId  : req.user.sub, recipientType: req.user.role === 'AFFILIATE' ? 'AFFILIATE' : undefined, status       : status || undefined,},
        include: { order: { select: { createdAt: true, amountCents: true, customerName: true } } },
        orderBy: { createdAt: 'desc' },
        skip, take: Number(limit),
      }),
      prisma.splitRecord.count({ where: { recipientId: req.user.sub } }),
    ]);
    return reply.send({ data, total });
  });

  // POST /financial/withdraw — solicitar saque
  app.post('/withdraw', { preHandler: [authenticate] }, async (req, reply) => {
    const body = z.object({
      amountCents: z.number().int().positive().min(5000, 'Saque mínimo R$ 50,00'),
      pixKey     : z.string().min(5),
      pixKeyType : z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']),
      phone      : z.string().min(10, 'Telefone obrigatório para notificação'),
    }).parse(req.body);

    const { availableCents } = await splitEngine.getUserBalance(req.user.sub);
    if (body.amountCents > availableCents) {
      throw new AppError(`Saldo insuficiente. Disponível: R$ ${(availableCents / 100).toFixed(2)}`, 422);
    }

    const withdrawal = await prisma.withdrawal.create({
      data: {
        userId     : req.user.sub,
        amountCents: body.amountCents,
        pixKey     : body.pixKey,
        pixKeyType : body.pixKeyType,
        status     : 'PENDING',
        metadata   : { phone: body.phone },
      },
    });

    await audit.log({
      userId: req.user.sub, action: 'WITHDRAWAL_REQUESTED',
      details: { amountCents: body.amountCents }, level: 'HIGH',
    });

    return reply.status(201).send(withdrawal);
  });

  // GET /financial/withdrawals — histórico de saques
  app.get('/withdrawals', { preHandler: [authenticate] }, async (req, reply) => {
    const { limit = '50', status } = req.query as any;

    // Admin vê todos, produtor vê só os seus
    const where: any = req.user.role === 'ADMIN' || req.user.role === 'STAFF'
      ? {}
      : { userId: req.user.sub };

    if (status) where.status = status;

    const withdrawals = await prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take   : Number(limit),
    });
    return reply.send({ data: withdrawals, total: withdrawals.length });
  });

  // POST /financial/withdrawals/:id/process — admin confirma pagamento manual
  app.post('/withdrawals/:id/process', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
    // Buscar dados do usuário separadamente
    const wdUser = withdrawal ? await prisma.user.findUnique({
      where : { id: withdrawal.userId },
      select: { name: true, email: true },
    }) : null;

    if (!withdrawal) throw new AppError('Saque não encontrado', 404);
    if (withdrawal.status !== 'PENDING') {
      throw new AppError(`Saque já está com status ${withdrawal.status}`, 422);
    }

    // Marcar como PAID
    await prisma.withdrawal.update({
      where: { id },
      data : { status: 'PAID', paidAt: new Date() },
    });

    await audit.log({
      userId : req.user.sub,
      action : 'WITHDRAWAL_PROCESSED',
      details: { withdrawalId: id, amountCents: withdrawal.amountCents, pixKey: withdrawal.pixKey },
      level  : 'HIGH',
    });

    // Email de confirmação
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from   : `${process.env.EMAIL_FROM_NAME || 'Kairos Way'} <${process.env.EMAIL_FROM || 'onboarding@resend.dev'}>`,
        to     : wdUser?.email || '',
        subject: 'Saque realizado com sucesso!',
        html   : `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#0055FE;padding:24px;border-radius:12px 12px 0 0;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:20px">Kairos Way</h1>
            </div>
            <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7">
              <h2 style="margin-top:0">Saque realizado! 💰</h2>
              <p>Olá, <strong>${wdUser?.name || 'Produtor'}</strong>!</p>
              <p>Seu saque foi processado com sucesso via Pix.</p>
              <div style="background:#f0f6ff;border-left:4px solid #0055FE;padding:12px 16px;border-radius:4px;margin:16px 0">
                <strong>Valor:</strong> R$ ${(withdrawal.amountCents / 100).toFixed(2).replace('.', ',')}<br/>
                <strong>Chave Pix:</strong> ${withdrawal.pixKey}<br/>
                <strong>Tipo:</strong> ${withdrawal.pixKeyType}
              </div>
              <p style="color:#71717a;font-size:13px">O valor já está a caminho da sua conta. Em caso de dúvidas, entre em contato com o suporte.</p>
            </div>
          </div>`,
      });
    } catch (emailErr: any) {
      logger.warn({ err: emailErr.message }, 'Withdrawal: falha no email de confirmação');
    }

    // WhatsApp de confirmação
    try {
      const phone = (withdrawal.metadata as any)?.phone;
      if (phone) {
        await whatsAppService.sendWithdrawalConfirmation({
          phone,
          customerName: wdUser?.name || 'Produtor',
          amountCents : withdrawal.amountCents,
          pixKey      : withdrawal.pixKey,
        });
      }
    } catch (wppErr: any) {
      logger.warn({ err: wppErr.message }, 'Withdrawal: falha no WhatsApp de confirmação');
    }

    return reply.send({ message: 'Saque confirmado e produtor notificado!' });
  });

  // POST /financial/withdrawals/:id/reject — admin rejeita saque
  app.post('/withdrawals/:id/reject', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { id }    = req.params as { id: string };
    const { reason } = req.body as { reason?: string };

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
    // Buscar dados do usuário separadamente
    const wdUser = withdrawal ? await prisma.user.findUnique({
      where : { id: withdrawal.userId },
      select: { name: true, email: true },
    }) : null;

    if (!withdrawal) throw new AppError('Saque não encontrado', 404);

    await prisma.withdrawal.update({
      where: { id },
      data : { status: 'FAILED', failedAt: new Date(), failReason: reason || 'Rejeitado pelo admin' },
    });

    await audit.log({
      userId : req.user.sub,
      action : 'WITHDRAWAL_REJECTED',
      details: { withdrawalId: id, reason },
      level  : 'HIGH',
    });

    return reply.send({ message: 'Saque rejeitado.' });
  });

  // DELETE /financial/withdrawals/:id — cancelar saque PENDING
  app.delete('/withdrawals/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });

    if (!withdrawal) throw new AppError('Saque não encontrado', 404);
    if (withdrawal.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new AppError('Sem permissão', 403);
    }
    if (withdrawal.status !== 'PENDING') {
      throw new AppError('Só é possível cancelar saques com status PENDING', 422);
    }

    await prisma.withdrawal.delete({ where: { id } });

    await audit.log({
      userId : req.user.sub,
      action : 'WITHDRAWAL_CANCELLED',
      details: { withdrawalId: id, amountCents: withdrawal.amountCents },
      level  : 'MEDIUM',
    });

    return reply.send({ message: 'Pedido de saque cancelado.' });
  });

  // ── ADMIN ONLY ─────────────────────────────────────────────────

  // GET /financial/invoices-wl — faturas WL (spread semanal)
  app.get('/invoices-wl', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const invoices = await prisma.platformInvoice.findMany({ orderBy: { createdAt: 'desc' } });
    return reply.send(invoices);
  });

  // GET /financial/balance-all — saldo de todos os usuários
  app.get('/balance-all', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const balances = await prisma.splitRecord.groupBy({
      by: ['recipientId', 'status'],
      _sum: { amountCents: true },
    });
    return reply.send(balances);
  });

  // POST /financial/repasse-auto — marca splits PENDING como PAID
  app.post('/repasse-auto', { preHandler: [authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    // Buscar todos os splits pendentes de pedidos APPROVED
    const pending = await prisma.splitRecord.findMany({
      where : { status: 'PENDING', order: { status: 'APPROVED' } },
      select: { id: true },
      take  : 100,
    });

    if (pending.length === 0) {
      return reply.send({ message: 'Nenhum split pendente encontrado.', processed: 0 });
    }

    // Marcar todos como PAID
    const result = await prisma.splitRecord.updateMany({
      where: { id: { in: pending.map(p => p.id) }, status: 'PENDING' },
      data : { status: 'PAID', paidAt: new Date() },
    });

    await audit.log({
      userId : req.user.sub, action: 'REPASSE_AUTO_TRIGGERED',
      details: { count: result.count }, level: 'HIGH',
    });

    return reply.send({ message: `${result.count} repasse(s) processado(s) com sucesso!`, processed: result.count });
  });
}
