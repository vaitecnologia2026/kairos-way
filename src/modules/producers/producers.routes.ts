import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { AuditService } from '../audit/audit.service';
import { prisma } from '../../shared/utils/prisma';
import { NotFoundError, AppError } from '../../shared/errors/AppError';
import { enqueueEmail } from '../../shared/queue/enqueue';
import { pagarmeRecipients } from '../../shared/services/pagarme-recipients.service';
import { notifications, NotifType } from '../../shared/notifications/notification.service';

const auditService = new AuditService();

// Garante um Producer record para o User fazer KYC.
// Afiliados podem completar KYC para virar recebedor Pagar.me e operar como produtor depois.
async function ensureProducerForKyc(userId: string) {
  const existing = await prisma.producer.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.producer.create({
    data: { userId, kycStatus: 'PENDING', isActive: false },
  });
}

export async function producerRoutes(app: FastifyInstance) {

  // ── GET /producers/me ─────────────────────────────────────────
  app.get('/me', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    await ensureProducerForKyc(req.user.sub);
    const producer = await prisma.producer.findUnique({
      where  : { userId: req.user.sub },
      include: { user: { select: { name: true, email: true, phone: true, document: true } } },
    });
    if (!producer) throw new NotFoundError('Produtor');
    return reply.send(producer);
  });

  // ── POST /producers/kyc/documents ─────────────────────────────
  app.post('/kyc/documents', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    const body = z.object({
      type: z.string().min(2),
      url : z.string().url(),
    }).parse(req.body);

    const producer = await ensureProducerForKyc(req.user.sub);

    const doc = await prisma.kycDocument.create({
      data: { producerId: producer.id, type: body.type, url: body.url },
    });

    await prisma.producer.update({
      where: { id: producer.id },
      data : { kycStatus: 'DOCUMENTS_SENT' },
    });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'KYC_DOCUMENT_SENT',
      details : { documentType: body.type },
      level   : 'MEDIUM',
    });

    return reply.status(201).send(doc);
  });

  // ── GET /producers/kyc/status ─────────────────────────────────
  app.get('/kyc/status', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    await ensureProducerForKyc(req.user.sub);
    const producer = await prisma.producer.findUnique({
      where  : { userId: req.user.sub },
      include: { kycDocuments: true },
    });
    if (!producer) throw new NotFoundError('Produtor');

    // Requisitos que destravam a aprovação
    const bank = (producer.bankData as any) || {};
    const reg  = (producer.metadata as any)?.registerInformation || {};
    const hasBanking = !!(bank.bank && bank.accountNumber && bank.holderDocument);
    const hasRegister = !!(reg.address?.zipCode && reg.phoneNumbers?.length);
    const hasDocuments = producer.kycDocuments.length > 0;

    return reply.send({
      kycStatus            : producer.kycStatus,
      isActive             : producer.isActive,
      pagarmeRecipientId   : producer.pagarmeRecipientId,
      pagarmeRecipientStatus: producer.pagarmeRecipientStatus,
      rejectedReason       : producer.rejectedReason,
      canOperate           : producer.kycStatus === 'APPROVED' && producer.isActive && !!producer.pagarmeRecipientId,
      completeness         : { hasDocuments, hasBanking, hasRegister },
      documents            : producer.kycDocuments,
    });
  });

  // ── PATCH /producers/banking — produtor informa dados bancários ──
  app.patch('/banking', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    const body = z.object({
      bank              : z.string().min(3).max(3), // código ISPB de 3 dígitos
      branchNumber      : z.string().min(1).max(6),
      branchCheckDigit  : z.string().max(2).optional(),
      accountNumber     : z.string().min(1).max(15),
      accountCheckDigit : z.string().min(1).max(2),
      type              : z.enum(['checking', 'savings']),
      holderName        : z.string().min(3),
      holderDocument    : z.string().transform(v => v.replace(/\D/g, '')).refine(v => v.length === 11 || v.length === 14, { message: 'CPF (11) ou CNPJ (14)' }),
    }).parse(req.body);

    const producer = await ensureProducerForKyc(req.user.sub);
    if (producer.kycStatus === 'APPROVED' && producer.pagarmeRecipientId) throw new AppError('Cadastro já aprovado — dados bancários bloqueados', 400);

    await prisma.producer.update({
      where: { id: producer.id },
      data : { bankData: { ...body, holderType: body.holderDocument.length === 11 ? 'individual' : 'corporation' } },
    });

    await auditService.log({ userId: req.user.sub, action: 'PRODUCER_BANK_UPDATED', level: 'MEDIUM' });
    return reply.send({ message: 'Dados bancários salvos' });
  });

  // ── PATCH /producers/register-information — produtor completa KYC ──
  app.patch('/register-information', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    const addressSchema = z.object({
      street        : z.string().min(2),
      streetNumber  : z.string().min(1),
      complementary : z.string().optional().nullable(),
      neighborhood  : z.string().min(2),
      city          : z.string().min(2),
      state         : z.string().length(2).transform(v => v.toUpperCase()),
      zipCode       : z.string().transform(v => v.replace(/\D/g, '')).refine(v => v.length === 8),
      referencePoint: z.string().optional().nullable(),
    });

    const phoneSchema = z.object({
      ddd    : z.string().length(2),
      number : z.string().min(8).max(9),
      type   : z.enum(['mobile', 'home']),
    });

    const body = z.object({
      type         : z.enum(['individual', 'corporation']),
      name         : z.string().min(3),
      email        : z.string().email(),
      document     : z.string().transform(v => v.replace(/\D/g, '')),
      // Pessoa física
      birthdate    : z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional(),
      monthlyIncome: z.number().positive().optional(),
      professionalOccupation: z.string().min(2).optional(),
      motherName   : z.string().optional(),
      // Pessoa jurídica
      companyName  : z.string().optional(),
      tradingName  : z.string().optional(),
      siteUrl      : z.string().url().optional(),
      annualRevenue: z.number().positive().optional(),
      corporationType: z.enum(['EIRELI', 'LTDA', 'MEI', 'SA']).optional(),
      foundingDate : z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional(),
      // Comuns
      phoneNumbers : z.array(phoneSchema).min(1).max(2),
      address      : addressSchema,
      mainAddress  : addressSchema.optional(),
      managingPartners: z.array(z.any()).optional(),
    }).parse(req.body);

    const producer = await ensureProducerForKyc(req.user.sub);
    if (producer.kycStatus === 'APPROVED' && producer.pagarmeRecipientId) throw new AppError('Cadastro já aprovado — dados bloqueados', 400);

    const currentMeta = (producer.metadata as any) || {};
    await prisma.producer.update({
      where: { id: producer.id },
      data : { metadata: { ...currentMeta, registerInformation: body } },
    });

    await auditService.log({ userId: req.user.sub, action: 'PRODUCER_REGISTER_UPDATED', level: 'MEDIUM' });
    return reply.send({ message: 'Informações cadastrais salvas' });
  });

  // ── POST /producers/kyc/submit — finaliza envio e marca DOCUMENTS_SENT ──
  app.post('/kyc/submit', {
    preHandler: [authenticate, requireRole('PRODUCER', 'AFFILIATE')],
  }, async (req, reply) => {
    await ensureProducerForKyc(req.user.sub);
    const producer = await prisma.producer.findUnique({
      where  : { userId: req.user.sub },
      include: { kycDocuments: true },
    });
    if (!producer) throw new NotFoundError('Produtor');

    const bank = (producer.bankData as any) || {};
    const reg  = (producer.metadata as any)?.registerInformation || {};
    const hasBanking = !!(bank.bank && bank.accountNumber && bank.holderDocument);
    const hasRegister = !!(reg.address?.zipCode && reg.phoneNumbers?.length);
    const hasDocuments = producer.kycDocuments.length > 0;

    if (!hasBanking || !hasRegister || !hasDocuments) {
      throw new AppError('Verificação incompleta: envie documentos, dados cadastrais e bancários antes.', 400);
    }

    if (producer.kycStatus === 'APPROVED') {
      return reply.send({ message: 'Conta já aprovada' });
    }

    await prisma.producer.update({
      where: { id: producer.id },
      data : { kycStatus: 'DOCUMENTS_SENT' },
    });

    await auditService.log({ userId: req.user.sub, action: 'PRODUCER_KYC_SUBMITTED', level: 'HIGH' });
    return reply.send({ message: 'Documentação enviada — aguardando análise do administrador' });
  });

  // ── GET /producers/checkout-config ───────────────────────────────
  app.get('/checkout-config', { preHandler: [authenticate, requireRole('PRODUCER')] }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer) throw new NotFoundError('Produtor');
    const cfg = (producer.metadata as any)?.successConfig ?? {};
    return reply.send({ html: cfg.html ?? '', icon: cfg.icon ?? 'CheckCircle', color: cfg.color ?? '#00C9A7' });
  });

  // ── PATCH /producers/checkout-config ─────────────────────────────
  app.patch('/checkout-config', { preHandler: [authenticate, requireRole('PRODUCER')] }, async (req, reply) => {
    const body = z.object({
      html : z.string().max(20000).optional().nullable(),
      icon : z.string().max(50).optional().nullable(),
      color: z.string().max(20).optional().nullable(),
    }).parse(req.body);

    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer) throw new NotFoundError('Produtor');

    const currentMeta = (producer.metadata as any) ?? {};
    await prisma.producer.update({
      where: { userId: req.user.sub },
      data : { metadata: { ...currentMeta, successConfig: body } },
    });

    await auditService.log({ userId: req.user.sub, action: 'CHECKOUT_CONFIG_UPDATED', level: 'LOW' });
    return reply.send({ message: 'Configuração salva' });
  });

  // ══════════════════════════════════════════════════════════════
  // REVIEW DE DOCUMENTOS KYC (admin)
  // ══════════════════════════════════════════════════════════════

  // GET /producers/:id/kyc-full — admin vê docs + dados cadastrais + bancários
  app.get('/:id/kyc-full', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const producer = await prisma.producer.findUnique({
      where  : { id },
      include: {
        user        : { select: { id: true, name: true, email: true, phone: true, document: true, createdAt: true } },
        kycDocuments: { orderBy: { uploadedAt: 'desc' } },
      },
    });
    if (!producer) throw new NotFoundError('Produtor');

    return reply.send({
      id                    : producer.id,
      user                  : producer.user,
      companyName           : producer.companyName,
      kycStatus             : producer.kycStatus,
      isActive              : producer.isActive,
      approvedAt            : producer.approvedAt,
      rejectedAt            : producer.rejectedAt,
      rejectedReason        : producer.rejectedReason,
      pagarmeRecipientId    : producer.pagarmeRecipientId,
      pagarmeBankAccountId  : producer.pagarmeBankAccountId,
      pagarmeRecipientStatus: producer.pagarmeRecipientStatus,
      bankData              : producer.bankData,
      registerInformation   : (producer.metadata as any)?.registerInformation ?? null,
      documents             : producer.kycDocuments,
    });
  });

  // POST /producers/:id/documents/:docId/approve — admin aprova documento
  app.post('/:id/documents/:docId/approve', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };

    const doc = await prisma.kycDocument.findFirst({ where: { id: docId, producerId: id } });
    if (!doc) throw new NotFoundError('Documento');

    const updated = await prisma.kycDocument.update({
      where: { id: docId },
      data : {
        status          : 'APPROVED',
        reviewedAt      : new Date(),
        reviewedBy      : req.user.sub,
        adjustmentReason: null,
        rejectionReason : null,
      },
    });

    await notifications.notify({
      recipient: { kind: 'producer', producerId: id },
      type     : NotifType.KYC_DOC_APPROVED,
      title    : 'Documento aprovado',
      body     : `Seu documento ${doc.type} foi aprovado.`,
    });

    await auditService.log({
      userId : req.user.sub,
      action : 'KYC_DOC_APPROVED',
      details: { docId, producerId: id, docType: doc.type },
      level  : 'MEDIUM',
    });

    return reply.send(updated);
  });

  // POST /producers/:id/documents/:docId/request-adjustment — admin pede ajuste
  app.post('/:id/documents/:docId/request-adjustment', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    const body = z.object({ reason: z.string().min(5, 'Explique o que precisa ser ajustado') }).parse(req.body);

    const doc = await prisma.kycDocument.findFirst({ where: { id: docId, producerId: id } });
    if (!doc) throw new NotFoundError('Documento');

    const updated = await prisma.kycDocument.update({
      where: { id: docId },
      data : {
        status          : 'NEEDS_ADJUSTMENT',
        reviewedAt      : new Date(),
        reviewedBy      : req.user.sub,
        adjustmentReason: body.reason,
      },
    });

    await notifications.notify({
      recipient: { kind: 'producer', producerId: id },
      type     : NotifType.KYC_DOC_ADJUSTMENT,
      title    : 'Ajuste solicitado em documento',
      body     : `Documento ${doc.type}: ${body.reason}`,
    });

    await auditService.log({
      userId : req.user.sub,
      action : 'KYC_DOC_ADJUSTMENT_REQUESTED',
      details: { docId, producerId: id, reason: body.reason },
      level  : 'MEDIUM',
    });

    return reply.send(updated);
  });

  // POST /producers/:id/documents/:docId/reject — admin rejeita doc permanentemente
  app.post('/:id/documents/:docId/reject', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    const body = z.object({ reason: z.string().min(5) }).parse(req.body);

    const doc = await prisma.kycDocument.findFirst({ where: { id: docId, producerId: id } });
    if (!doc) throw new NotFoundError('Documento');

    const updated = await prisma.kycDocument.update({
      where: { id: docId },
      data : {
        status          : 'REJECTED',
        reviewedAt      : new Date(),
        reviewedBy      : req.user.sub,
        rejectionReason : body.reason,
      },
    });

    await notifications.notify({
      recipient: { kind: 'producer', producerId: id },
      type     : NotifType.KYC_DOC_REJECTED,
      title    : 'Documento rejeitado',
      body     : `Documento ${doc.type}: ${body.reason}`,
    });

    return reply.send(updated);
  });

  // POST /producers/:id/revoke-approval — cancela aprovação do produtor
  app.post('/:id/revoke-approval', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().min(5) }).parse(req.body);

    const producer = await prisma.producer.update({
      where  : { id },
      data   : { kycStatus: 'DOCUMENTS_SENT', isActive: false, rejectedReason: body.reason },
      include: { user: true },
    });

    await notifications.notify({
      recipient: { kind: 'user', userId: producer.userId },
      type     : NotifType.KYC_REVOKED,
      title    : 'Aprovação cancelada',
      body     : `Sua aprovação foi revogada: ${body.reason}`,
    });

    await auditService.log({
      userId : req.user.sub,
      action : 'PRODUCER_APPROVAL_REVOKED',
      details: { producerId: id, reason: body.reason },
      level  : 'HIGH',
    });

    return reply.send({ message: 'Aprovação revogada', producer });
  });

  // ── GET /producers/dashboard ──────────────────────────────────
  app.get('/dashboard', {
    preHandler: [authenticate, requireRole('PRODUCER')],
  }, async (req, reply) => {
    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer) throw new NotFoundError('Produtor');

    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };

    const dateFilter: any = {};
    if (startDate) dateFilter.gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate)   dateFilter.lte = new Date(`${endDate}T23:59:59.999Z`);

    const orderBase: any = { offer: { product: { producerId: producer.id } } };
    const orderDateFilter: any = { ...orderBase, status: 'APPROVED' };
    if (startDate || endDate) orderDateFilter.approvedAt = dateFilter;

    const now           = new Date();
    const monthStart    = new Date(now.getFullYear(), now.getMonth(), 1);

    const [products, recentOrders, balance,
           approvedCount, refundStats, chargebackCount, pendingRefundCount,
           totalRevenueAgg, monthRevenueAgg] = await Promise.all([
      prisma.product.count({ where: { producerId: producer.id, isActive: true } }),
      prisma.order.findMany({
        where  : orderDateFilter,
        take   : 10,
        orderBy: { createdAt: 'desc' },
        include: { offer: { include: { product: { select: { name: true } } } } },
      }),
      prisma.splitRecord.aggregate({
        where: { recipientId: req.user.sub, status: 'PENDING' },
        _sum : { amountCents: true },
      }),
      prisma.order.count({ where: orderDateFilter }),
      prisma.order.aggregate({
        where: { ...orderBase, status: 'REFUNDED', ...(startDate || endDate ? { updatedAt: dateFilter } : {}) },
        _sum : { amountCents: true },
        _count: true,
      }),
      prisma.order.count({ where: { ...orderBase, status: 'CHARGEBACK', ...(startDate || endDate ? { updatedAt: dateFilter } : {}) } }),
      prisma.order.count({
        where: {
          ...orderBase,
          status  : 'PENDING',
          metadata: { path: ['refundRequest'], not: 'undefined' },
        },
      }),
      // Faturamento no período selecionado (ou total se sem filtro)
      prisma.order.aggregate({
        where: orderDateFilter,
        _sum : { amountCents: true },
      }),
      // Faturamento do mês atual
      prisma.order.aggregate({
        where: { ...orderBase, status: 'APPROVED', approvedAt: { gte: monthStart } },
        _sum : { amountCents: true },
      }),
    ]);

    const refundCount       = refundStats._count;
    const refundAmountCents = refundStats._sum.amountCents ?? 0;
    const refundRate        = approvedCount > 0
      ? Math.round(((refundCount + chargebackCount) / (approvedCount + refundCount + chargebackCount)) * 10000) / 100
      : 0;

    return reply.send({
      products,
      recentOrders,
      pendingBalanceCents : balance._sum.amountCents           || 0,
      totalRevenueCents   : totalRevenueAgg._sum.amountCents   || 0,
      monthRevenueCents   : monthRevenueAgg._sum.amountCents   || 0,
      refunds: {
        refundCount,
        refundAmountCents,
        chargebackCount,
        pendingRefundCount,
        refundRate,
      },
    });
  });

  // ── GET /producers/refunds ────────────────────────────────────
  app.get('/refunds', {
    preHandler: [authenticate, requireRole('PRODUCER')],
  }, async (req, reply) => {
    const { page = '1', limit = '20' } = req.query as { page?: string; limit?: string };
    const skip = (Number(page) - 1) * Number(limit);

    const producer = await prisma.producer.findUnique({ where: { userId: req.user.sub } });
    if (!producer) throw new NotFoundError('Produtor');

    const orderBase = { offer: { product: { producerId: producer.id } } };

    const [refunded, chargebacks, pending, totalRefunded, totalCB, totalPending] = await Promise.all([
      prisma.order.findMany({
        where  : { ...orderBase, status: 'REFUNDED' },
        orderBy: { updatedAt: 'desc' },
        skip, take: Number(limit),
        include: {
          offer      : { include: { product: { select: { name: true } } } },
          affiliate  : { include: { user: { select: { name: true } } } },
        },
      }),
      prisma.order.findMany({
        where  : { ...orderBase, status: 'CHARGEBACK' },
        orderBy: { updatedAt: 'desc' },
        take   : Number(limit),
        include: {
          offer    : { include: { product: { select: { name: true } } } },
          affiliate: { include: { user: { select: { name: true } } } },
        },
      }),
      prisma.order.findMany({
        where  : { ...orderBase, status: 'PENDING', metadata: { path: ['refundRequest'], not: 'undefined' } },
        orderBy: { updatedAt: 'desc' },
        take   : Number(limit),
        include: {
          offer    : { include: { product: { select: { name: true } } } },
          affiliate: { include: { user: { select: { name: true } } } },
        },
      }),
      prisma.order.count({ where: { ...orderBase, status: 'REFUNDED' } }),
      prisma.order.count({ where: { ...orderBase, status: 'CHARGEBACK' } }),
      prisma.order.count({
        where: { ...orderBase, status: 'PENDING', metadata: { path: ['refundRequest'], not: 'undefined' } },
      }),
    ]);

    const allOrders = [
      ...refunded.map((o: any)   => ({ ...o, displayStatus: 'REFUNDED'       })),
      ...chargebacks.map((o: any) => ({ ...o, displayStatus: 'CHARGEBACK'     })),
      ...pending.map((o: any)     => ({ ...o, displayStatus: 'PENDING_REFUND' })),
    ].sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return reply.send({
      data : allOrders,
      total: totalRefunded + totalCB + totalPending,
      counts: { refunded: totalRefunded, chargebacks: totalCB, pendingReview: totalPending },
    });
  });

  // ── GET /producers — listar todos (admin) ─────────────────────
  app.get('/', {
    preHandler: [authenticate, requireRole('ADMIN', 'STAFF')],
  }, async (req, reply) => {
    const { page = '1', limit = '20', status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status) where.kycStatus = status.toUpperCase();

    const [data, total] = await Promise.all([
      prisma.producer.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true, phone: true, failedAttempts: true, lockedUntil: true, isActive: true } } },
        orderBy: { createdAt: 'desc' },
        skip, take: Number(limit),
      }),
      prisma.producer.count({ where }),
    ]);

    return reply.send({ data, total, page: Number(page), limit: Number(limit) });
  });

  // ── POST /producers/:id/approve ───────────────────────────────
  app.post('/:id/approve', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const current = await prisma.producer.findUnique({
      where  : { id },
      include: { user: true, kycDocuments: true },
    });
    if (!current) throw new NotFoundError('Produtor');

    // Valida pré-requisitos de KYC
    const bank = (current.bankData as any) || {};
    const reg  = (current.metadata as any)?.registerInformation || {};
    if (!current.kycDocuments.length) throw new AppError('Produtor não enviou documentos', 400);
    if (!bank.bank || !bank.accountNumber) throw new AppError('Produtor não informou dados bancários', 400);
    if (!reg.address?.zipCode) throw new AppError('Produtor não completou o cadastro', 400);

    // Cria recebedor no Pagar.me se ainda não existe
    let pagarmeRecipientId   = current.pagarmeRecipientId;
    let pagarmeBankAccountId = current.pagarmeBankAccountId;
    let pagarmeRecipientStatus = current.pagarmeRecipientStatus;

    if (!pagarmeRecipientId) {
      const registerInformation: any = reg.type === 'corporation'
        ? {
            type              : 'corporation' as const,
            companyName       : reg.companyName || reg.name,
            tradingName       : reg.tradingName,
            email             : reg.email,
            document          : reg.document,
            siteUrl           : reg.siteUrl,
            annualRevenue     : reg.annualRevenue || 12000000,
            corporationType   : reg.corporationType || 'LTDA',
            foundingDate      : reg.foundingDate,
            phoneNumbers      : reg.phoneNumbers,
            address           : reg.address,
            mainAddress       : reg.mainAddress || reg.address,
            managingPartners  : reg.managingPartners || [],
          }
        : {
            type         : 'individual' as const,
            name         : reg.name,
            email        : reg.email,
            document     : reg.document,
            birthdate    : reg.birthdate,
            monthlyIncome: reg.monthlyIncome || 500000,
            professionalOccupation: reg.professionalOccupation || 'Empresário',
            motherName   : reg.motherName,
            phoneNumbers : reg.phoneNumbers,
            address      : reg.address,
          };

      try {
        const recipient = await pagarmeRecipients.createRecipient({
          name        : reg.name || current.user.name,
          email       : reg.email || current.user.email,
          document    : reg.document || (current.user.document || '').replace(/\D/g, ''),
          type        : bank.holderType || (reg.type === 'corporation' ? 'corporation' : 'individual'),
          code        : current.id,
          defaultBankAccount: {
            holderName        : bank.holderName,
            holderType        : bank.holderType,
            holderDocument    : bank.holderDocument,
            bank              : bank.bank,
            branchNumber      : bank.branchNumber,
            branchCheckDigit  : bank.branchCheckDigit,
            accountNumber     : bank.accountNumber,
            accountCheckDigit : bank.accountCheckDigit,
            type              : bank.type,
          },
          registerInformation,
          metadata: { kairosProducerId: current.id, kairosUserId: current.userId },
        });

        pagarmeRecipientId     = recipient.id;
        pagarmeBankAccountId   = recipient.default_bank_account?.id || null;
        pagarmeRecipientStatus = recipient.status;
      } catch (err: any) {
        const details = err?.response?.data;
        await auditService.log({
          userId : req.user.sub,
          action : 'PRODUCER_APPROVE_PAGARME_FAIL',
          details: { producerId: id, pagarme: details },
          level  : 'HIGH',
        });
        throw new AppError(
          `Falha ao criar recebedor no Pagar.me: ${details?.message || err.message}`,
          502,
        );
      }
    }

    const producer = await prisma.producer.update({
      where  : { id },
      data   : {
        kycStatus              : 'APPROVED',
        isActive               : true,
        approvedAt             : new Date(),
        approvedBy             : req.user.sub,
        pagarmeRecipientId,
        pagarmeBankAccountId,
        pagarmeRecipientStatus,
        pagarmeSyncedAt        : new Date(),
      },
      include: { user: true },
    });

    await prisma.user.update({
      where: { id: producer.userId },
      data : { isActive: true },
    });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'PRODUCER_APPROVED',
      details : { producerId: id, producerEmail: producer.user.email, pagarmeRecipientId },
      level   : 'HIGH',
    });

    // Notificar produtor da aprovação
    await enqueueEmail(
      producer.user.email,
      'Sua conta foi aprovada!',
      'producer-approved',
      {
        name        : producer.user.name,
        dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`,
      }
    );

    return reply.send({ message: 'Produtor aprovado e recebedor criado no Pagar.me', producer, pagarmeRecipientId });
  });

  // ── POST /producers/:id/reject ────────────────────────────────
  app.post('/:id/reject', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body   = z.object({
      reason: z.string().min(10, 'Informe o motivo da rejeição (mínimo 10 caracteres)'),
    }).parse(req.body);

    const producer = await prisma.producer.update({
      where  : { id },
      data   : { kycStatus: 'REJECTED', isActive: false, rejectedAt: new Date(), rejectedBy: req.user.sub, rejectedReason: body.reason },
      include: { user: true },
    });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'PRODUCER_REJECTED',
      details : { producerId: id, reason: body.reason },
      level   : 'HIGH',
    });

    await notifications.notify({
      recipient: { kind: 'user', userId: producer.userId },
      type     : NotifType.KYC_REVOKED,
      title    : 'Cadastro recusado',
      body     : `Seu cadastro como produtor foi recusado: ${body.reason}`,
    });

    await enqueueEmail(
      producer.user.email,
      'Atualização sobre sua conta Kairos Way',
      'producer-rejected',
      {
        name  : producer.user.name,
        reason: body.reason,
      }
    );

    return reply.send({ message: 'Produtor rejeitado' });
  });

  // ── DELETE /producers/:id ─────────────────────────────────────
  // Apaga User+Producer+Affiliate+KycDocs (cascade). Bloqueia se houver pedidos/produtos.
  app.delete('/:id', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const producer = await prisma.producer.findUnique({ where: { id }, include: { user: true } });
    if (!producer) throw new NotFoundError('Produtor');

    const userId = producer.userId;
    const userEmail = producer.user.email;

    const [productCount, withdrawalCount] = await Promise.all([
      prisma.product.count({ where: { producerId: id } }),
      prisma.withdrawal.count({ where: { userId } }),
    ]);
    if (productCount > 0 || withdrawalCount > 0) {
      throw new AppError(
        `Não é possível excluir: produtor possui ${productCount} produto(s) e ${withdrawalCount} saque(s) no histórico.`,
        409,
      );
    }

    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { userId } }),
      prisma.pushToken.deleteMany({ where: { userId } }),
      prisma.userIntegration.deleteMany({ where: { userId } }),
      prisma.webhookEndpoint.deleteMany({ where: { userId } }),
      prisma.coproducerRequest.deleteMany({ where: { userId } }),
      prisma.auditLog.updateMany({ where: { userId }, data: { userId: null } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);

    await auditService.log({
      userId : req.user.sub,
      action : 'PRODUCER_DELETED',
      details: { producerId: id, userId, email: userEmail },
      level  : 'HIGH',
    });

    return reply.send({ message: 'Produtor e dados vinculados excluídos' });
  });

  // ── POST /producers/:id/block ─────────────────────────────────
  app.post('/:id/block', {
    preHandler: [authenticate, requireRole('ADMIN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body   = z.object({ reason: z.string().min(5) }).parse(req.body);

    const producer = await prisma.producer.update({
      where: { id },
      data : { isActive: false },
    });
    await prisma.user.update({
      where: { id: producer.userId },
      data : { isActive: false },
    });

    // Revogar todas as sessões do produtor bloqueado
    await prisma.session.deleteMany({ where: { userId: producer.userId } });

    await auditService.log({
      userId  : req.user.sub,
      action  : 'PRODUCER_BLOCKED',
      details : { producerId: id, reason: body.reason },
      level   : 'HIGH',
    });

    return reply.send({ message: 'Produtor bloqueado e sessões revogadas' });
  });
}