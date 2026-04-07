import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import crypto from 'crypto';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { NotFoundError, AppError } from '../../shared/errors/AppError';
import { nanoid } from 'nanoid';

// FIX B-07: hash impossível para contas sem senha (não pode ser reversed)
// Usa 64 bytes aleatórios — bcrypt.compare sempre retorna false
const IMPOSSIBLE_HASH = `*NOLOGIN_${crypto.randomBytes(32).toString('hex')}`;

export async function affiliateRoutes(app: FastifyInstance) {

  // ── POST /affiliates — criar afiliado individual ──────────────
  app.post('/', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const body = z.object({
      name     : z.string().min(3),
      email    : z.string().email(),
      document : z.string().optional(),
      phone    : z.string().optional(),
    }).parse(req.body);

    // Verificar limite de 1000 usando transação atômica
    // FIX B-05: usa $transaction para evitar race condition
    const result = await prisma.$transaction(async (tx) => {
      const count = await tx.affiliate.count({ where: { isActive: true } });
      if (count >= 1000) throw new AppError('Limite de 1.000 afiliados atingido', 409);

      const existing = await tx.user.findUnique({ where: { email: body.email } });
      if (existing) throw new AppError('Email já cadastrado', 409);

      const code = nanoid(10);

      const user = await tx.user.create({
        data: {
          name        : body.name,
          email       : body.email,
          // FIX B-07: hash impossível — afiliado não pode fazer login com senha
          passwordHash: IMPOSSIBLE_HASH,
          role        : 'AFFILIATE',
          isActive    : true,
          document    : body.document,
          phone       : body.phone,
          affiliate   : { create: { code } },
        },
      });

      return { userId: user.id, code };
    });

    const link = `${process.env.FRONTEND_URL}/checkout?aff=${result.code}`;
    return reply.status(201).send({ ...result, link });
  });

  // ── POST /affiliates/bulk — importar CSV ──────────────────────
  // FIX B-06: processamento em lotes com createMany (não sequencial)
  app.post('/bulk', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const data = await req.file();
    if (!data) throw new AppError('Arquivo CSV obrigatório');

    const buf     = await data.toBuffer();
    const records = parse(buf, { columns: true, skip_empty_lines: true, trim: true }) as any[];

    if (records.length === 0) throw new AppError('CSV vazio ou sem registros válidos');
    if (records.length > 1000) throw new AppError('CSV não pode ter mais de 1.000 registros');

    const count = await prisma.affiliate.count({ where: { isActive: true } });
    const slots = 1000 - count;
    if (slots <= 0) throw new AppError('Limite de 1.000 afiliados atingido', 409);

    const toProcess = records.slice(0, slots);

    // Buscar emails já existentes em uma única query
    const emails       = toProcess.map((r: any) => r.email).filter(Boolean);
    const existingUsers = await prisma.user.findMany({
      where : { email: { in: emails } },
      select: { email: true },
    });
    const existingEmails = new Set(existingUsers.map((u) => u.email));

    const created : string[] = [];
    const errors  : { row: number; email: string; error: string }[] = [];

    // Preparar lote de usuários válidos
    const validRecords = toProcess
      .map((r: any, i: number) => {
        if (!r.email || !r.name) {
          errors.push({ row: i + 1, email: r.email || '—', error: 'email e name são obrigatórios' });
          return null;
        }
        if (existingEmails.has(r.email)) {
          errors.push({ row: i + 1, email: r.email, error: 'Email já cadastrado' });
          return null;
        }
        return { name: r.name, email: r.email, code: nanoid(10) };
      })
      .filter(Boolean) as { name: string; email: string; code: string }[];

    // Criar todos em uma transação com createMany (uma query por lote)
    if (validRecords.length > 0) {
      await prisma.$transaction(async (tx) => {
        // Criar usuários
        await tx.user.createMany({
          data: validRecords.map((r) => ({
            name        : r.name,
            email       : r.email,
            passwordHash: IMPOSSIBLE_HASH, // FIX B-07
            role        : 'AFFILIATE',
            isActive    : true,
          })),
          skipDuplicates: true,
        });

        // Buscar IDs dos usuários criados
        const createdUsers = await tx.user.findMany({
          where : { email: { in: validRecords.map((r) => r.email) } },
          select: { id: true, email: true },
        });

        const emailToId = new Map(createdUsers.map((u) => [u.email, u.id]));

        // Criar afiliados com códigos únicos
        await tx.affiliate.createMany({
          data: validRecords
            .map((r) => ({
              userId  : emailToId.get(r.email)!,
              code    : r.code,
              isActive: true,
            }))
            .filter((a) => a.userId),
          skipDuplicates: true,
        });
      });

      validRecords.forEach((r) => created.push(r.email));
    }

    return reply.send({
      created : created.length,
      errors  : errors.length,
      skipped : records.length - toProcess.length,
      details : errors,
    });
  });

  // ── GET /affiliates — listar afiliados ────────────────────────
  app.get('/', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const { page = '1', limit = '50', search } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (search) {
      where.user = {
        OR: [
          { name  : { contains: search, mode: 'insensitive' } },
          { email : { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [data, total] = await Promise.all([
      prisma.affiliate.findMany({
        where,
        include: { user: { select: { name: true, email: true, phone: true } } },
        skip, take: Number(limit), orderBy: { createdAt: 'desc' },
      }),
      prisma.affiliate.count({ where }),
    ]);

    return reply.send({ data, total, page: Number(page), limit: Number(limit) });
  });

  // ── GET /affiliates/:code/track — rastrear clique ─────────────
  app.get('/:code/track', async (req, reply) => {
    const { code    } = req.params as { code: string };
    const { offerId } = req.query  as { offerId?: string };

    const affiliate = await prisma.affiliate.findUnique({
      where: { code, isActive: true },
    });

    if (!affiliate) return reply.status(404).send({ error: 'Link inválido' });

    if (offerId) {
      // Fire-and-forget — não bloqueia a resposta
      prisma.affiliateTracking.create({
        data: {
          affiliateId : affiliate.id,
          offerId,
          ip          : req.ip,
          userAgent   : req.headers['user-agent'],
        },
      }).catch(() => {}); // não quebra o fluxo se falhar
    }

    return reply.send({ affiliateId: affiliate.id, code });
  });

  // ── GET /affiliates/dashboard — painel do afiliado ────────────
  app.get('/dashboard', {
    preHandler: [authenticate, requireRole('AFFILIATE')],
  }, async (req, reply) => {
    const affiliate = await prisma.affiliate.findUnique({
      where: { userId: req.user.sub },
    });
    if (!affiliate) throw new NotFoundError('Afiliado');

    const [totalClicks, earningsAgg, paidEarningsAgg] = await Promise.all([
      prisma.affiliateTracking.count({ where: { affiliateId: affiliate.id } }),
      prisma.splitRecord.aggregate({
        where: { recipientId: req.user.sub, status: 'PENDING' },
        _sum : { amountCents: true },
      }),
      prisma.splitRecord.aggregate({
        where: { recipientId: req.user.sub, status: 'PAID' },
        _sum : { amountCents: true },
      }),
    ]);

    return reply.send({
      code              : affiliate.code,
      link              : `${process.env.FRONTEND_URL}/checkout?aff=${affiliate.code}`,
      totalClicks,
      pendingEarnings   : earningsAgg._sum.amountCents     || 0,
      paidEarnings      : paidEarningsAgg._sum.amountCents || 0,
      totalEarningsCents: (earningsAgg._sum.amountCents || 0) + (paidEarningsAgg._sum.amountCents || 0),
    });
  });

  // ── PATCH /affiliates/:id — ativar/desativar ──────────────────
  app.patch('/:id', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const { id   } = req.params as { id: string };
    const body     = z.object({ isActive: z.boolean() }).parse(req.body);

    const affiliate = await prisma.affiliate.update({
      where: { id },
      data : { isActive: body.isActive },
    });

    return reply.send(affiliate);
  });
}