import { prisma } from '../../shared/utils/prisma';
// ── AUTH ROUTES ──────────────────────────────────────────────────────
import { FastifyInstance } from 'fastify';
import { AuthService } from './auth.service';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { z } from 'zod';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Resend } from 'resend';
import { logger } from '../../shared/utils/logger';

// AuthService instanciado dentro da função para ter acesso ao fastify
let authService: AuthService;

export async function authRoutes(app: FastifyInstance) {
  authService = new AuthService(app);
  // POST /auth/login
  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: 60000 } },
  }, async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }).parse(request.body);

    const result = await authService.login(body.email, body.password, request.ip);
    return reply.send(result);
  });

  // POST /auth/mfa/verify
  app.post('/mfa/verify', async (request, reply) => {
    const body = z.object({
      tempToken: z.string(),
      code: z.string().length(6),
    }).parse(request.body);

    const result = await authService.verifyMfa(body.tempToken, body.code, request.ip);
    return reply.send(result);
  });

  // POST /auth/refresh
  app.post('/refresh', async (request, reply) => {
    const body = z.object({ refreshToken: z.string() }).parse(request.body);
    const result = await authService.refreshToken(body.refreshToken, request.ip);
    return reply.send(result);
  });

  // POST /auth/logout
  app.post('/logout', { preHandler: [authenticate] }, async (request, reply) => {
    const token = request.headers.authorization?.replace('Bearer ', '') || '';
    await authService.logout(token, request.user.sub);
    return reply.send({ message: 'Logout realizado com sucesso' });
  });

  // GET /auth/me
  app.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    const user = await authService.getMe(request.user.sub);
    // Anexa endereço salvo em Producer.metadata.address OU Affiliate.metadata.address
    const [producer, affiliate] = await Promise.all([
      prisma.producer .findUnique({ where: { userId: request.user.sub }, select: { metadata: true } }),
      prisma.affiliate.findUnique({ where: { userId: request.user.sub }, select: { metadata: true } }),
    ]);
    const prodAddr = (producer?.metadata  as any)?.address;
    const affAddr  = (affiliate?.metadata as any)?.address;
    const address  = prodAddr || affAddr || null;
    return reply.send({ ...user, address });
  });

  // POST /auth/register (LP → produtor)
  app.post('/register', {
    config: { rateLimit: { max: 5, timeWindow: 300000 } }, // 5/5min
  }, async (request, reply) => {
    const body = z.object({
      name: z.string().min(3),
      email: z.string().email(),
      password: z.string().min(12, 'Senha deve ter no mínimo 12 caracteres'),
      document: z.string().optional(),
      phone: z.string().optional(),
      companyName: z.string().optional(),
    }).parse(request.body);

    const result = await authService.register(body, request.ip);
    return reply.status(201).send(result);
  });

  // POST /auth/mfa/setup (gerar QR code)
  app.post('/mfa/setup', { preHandler: [authenticate] }, async (request, reply) => {
    const result = await authService.setupMfa(request.user.sub, request.user.email);
    return reply.send(result);
  });

  // POST /auth/mfa/enable (confirmar código e ativar)
  app.post('/mfa/enable', { preHandler: [authenticate] }, async (request, reply) => {
    const body = z.object({ code: z.string().length(6) }).parse(request.body);
    await authService.enableMfa(request.user.sub, body.code);
    return reply.send({ message: 'MFA ativado com sucesso' });
  });

  // PUT /auth/password
  app.put('/password', { preHandler: [authenticate] }, async (request, reply) => {
    const body = z.object({
      currentPassword: z.string(),
      newPassword: z.string().min(12, 'Senha deve ter no mínimo 12 caracteres'),
    }).parse(request.body);

    await authService.changePassword(request.user.sub, body.currentPassword, body.newPassword);
    return reply.send({ message: 'Senha alterada com sucesso' });
  });

  // PATCH /auth/profile — atualizar dados do perfil
  app.patch('/profile', { preHandler: [authenticate] }, async (request, reply) => {
    const body = request.body as any;
    const { name, document, phone, birthDate, avatarUrl } = body;

    // Dados do User
    const userData: any = {};
    if (name)      userData.name      = name;
    if (document)  userData.document  = document;
    if (phone)     userData.phone     = phone;
    if (avatarUrl) userData.avatarUrl = avatarUrl;
    if (birthDate) userData.birthDate = new Date(birthDate);

    const updated = await prisma.user.update({
      where : { id: request.user.sub },
      data  : userData,
      select: { id: true, name: true, email: true, role: true, document: true, phone: true, birthDate: true, avatarUrl: true },
    });

    // Endereço — salva em Producer.metadata.address OU Affiliate.metadata.address
    const addressFields = {
      zipCode     : body.zipCode,
      street      : body.street,
      number      : body.number,
      complement  : body.complement,
      neighborhood: body.neighborhood,
      city        : body.city,
      state       : body.state ? String(body.state).toUpperCase() : undefined,
    };
    const hasAddressInput = Object.values(addressFields).some(v => v && String(v).trim());

    if (hasAddressInput) {
      // Limpa vazios
      const cleanAddress = Object.fromEntries(
        Object.entries(addressFields).filter(([, v]) => v && String(v).trim())
      );

      const [producer, affiliate] = await Promise.all([
        prisma.producer .findUnique({ where: { userId: request.user.sub }, select: { id: true, metadata: true } }),
        prisma.affiliate.findUnique({ where: { userId: request.user.sub }, select: { id: true, metadata: true } }),
      ]);

      if (producer) {
        await prisma.producer.update({
          where: { userId: request.user.sub },
          data : {
            metadata: { ...(producer.metadata as object || {}), address: cleanAddress } as any,
          },
        });
      }
      if (affiliate) {
        await prisma.affiliate.update({
          where: { userId: request.user.sub },
          data : {
            metadata: { ...(affiliate.metadata as object || {}), address: cleanAddress } as any,
          },
        });
      }
    }

    return reply.send(updated);
  });

  // ───────────────────────────────────────────────────────────────────
  // ESQUECI MINHA SENHA — fluxo em 3 etapas
  // 1. POST /auth/forgot-password       (email)              → envia código
  // 2. POST /auth/verify-reset-code     (email + code)       → retorna resetToken
  // 3. POST /auth/reset-password        (resetToken + senha) → troca senha
  // ───────────────────────────────────────────────────────────────────

  const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

  // 1. Solicita código
  app.post('/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: 300_000 } }, // 5 por 5min por IP
  }, async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
    }).parse(request.body);

    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });

    // Resposta sempre genérica — não revela se e-mail existe (anti-enumeration)
    const genericResponse = { message: 'Se houver cadastro, você receberá um código por e-mail.' };

    if (!user || !user.isActive || user.deletedAt) {
      logger.info({ email: body.email, ip: request.ip }, 'forgot-password: usuário não encontrado ou inativo');
      return reply.send(genericResponse);
    }

    // Invalida códigos anteriores ainda válidos (one active at a time)
    await prisma.passwordResetCode.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data : { usedAt: new Date() },
    });

    // Gera código de 6 dígitos
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    await prisma.passwordResetCode.create({
      data: { userId: user.id, codeHash, expiresAt, requestIp: request.ip },
    });

    // Envia e-mail via Resend
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from   : `${process.env.EMAIL_FROM_NAME || 'Kairos Way'} <${process.env.EMAIL_FROM || 'onboarding@resend.dev'}>`,
        to     : user.email,
        subject: 'Kairos Way — Código de recuperação de senha',
        html   : `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <div style="background:#0055FE;padding:20px;border-radius:12px 12px 0 0;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:18px;letter-spacing:0.5px">KAIROS WAY</h1>
            </div>
            <div style="background:#fff;padding:28px;border:1px solid #e4e4e7;border-top:0;border-radius:0 0 12px 12px">
              <h2 style="margin:0 0 12px;font-size:17px;color:#111">Recuperação de senha</h2>
              <p style="color:#333;font-size:14px;line-height:1.5">
                Olá, <strong>${user.name}</strong>. Use o código abaixo para redefinir sua senha:
              </p>
              <div style="background:#f4f7ff;border:1px solid #b9cffe;border-radius:10px;padding:18px;text-align:center;margin:18px 0">
                <div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#0055FE;font-family:monospace">${code}</div>
              </div>
              <p style="color:#666;font-size:12px;line-height:1.5">
                O código expira em <strong>15 minutos</strong>. Se você não solicitou esta recuperação, ignore este e-mail —
                sua senha permanece inalterada.
              </p>
              <p style="color:#999;font-size:11px;margin-top:20px;border-top:1px solid #eee;padding-top:12px">
                Este e-mail foi enviado por Kairos Way. Não responda este e-mail.
              </p>
            </div>
          </div>
        `,
      });
      logger.info({ userId: user.id, email: user.email }, 'forgot-password: código enviado');
    } catch (err: any) {
      logger.error({ userId: user.id, err: err.message }, 'forgot-password: falha no envio de e-mail');
      // Mesmo com erro de e-mail, retornamos mensagem genérica (evita vazar estado)
    }

    return reply.send(genericResponse);
  });

  // 2. Verifica código e devolve token temporário
  app.post('/verify-reset-code', {
    config: { rateLimit: { max: 10, timeWindow: 300_000 } },
  }, async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
      code : z.string().length(6).regex(/^\d+$/, 'Código deve ter 6 dígitos'),
    }).parse(request.body);

    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user) return reply.status(400).send({ message: 'Código inválido ou expirado' });

    const record = await prisma.passwordResetCode.findFirst({
      where  : { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      return reply.status(400).send({ message: 'Código inválido ou expirado' });
    }

    // Limite de tentativas — 5
    if (record.attempts >= 5) {
      await prisma.passwordResetCode.update({
        where: { id: record.id },
        data : { usedAt: new Date() },   // queima o código
      });
      return reply.status(429).send({ message: 'Excesso de tentativas. Solicite um novo código.' });
    }

    const match = record.codeHash === sha256(body.code);
    if (!match) {
      await prisma.passwordResetCode.update({
        where: { id: record.id },
        data : { attempts: { increment: 1 } },
      });
      return reply.status(400).send({ message: 'Código inválido ou expirado' });
    }

    // Código ok — emite resetToken de 15min (JWT curto) para a etapa 3
    const resetToken = app.jwt.sign(
      { sub: user.id, kind: 'password-reset', rid: record.id },
      { expiresIn: '15m' },
    );

    logger.info({ userId: user.id }, 'verify-reset-code: código validado');
    return reply.send({ resetToken });
  });

  // 3. Redefine a senha usando o resetToken
  app.post('/reset-password', async (request, reply) => {
    const body = z.object({
      resetToken : z.string(),
      newPassword: z.string().min(12, 'Senha deve ter no mínimo 12 caracteres'),
    }).parse(request.body);

    let payload: any;
    try {
      payload = app.jwt.verify(body.resetToken);
    } catch {
      return reply.status(400).send({ message: 'Token inválido ou expirado' });
    }

    if (payload.kind !== 'password-reset' || !payload.sub || !payload.rid) {
      return reply.status(400).send({ message: 'Token inválido' });
    }

    const record = await prisma.passwordResetCode.findUnique({ where: { id: payload.rid } });
    if (!record || record.usedAt || record.userId !== payload.sub || record.expiresAt < new Date()) {
      return reply.status(400).send({ message: 'Código já usado ou expirado' });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return reply.status(400).send({ message: 'Usuário não encontrado' });

    const newHash = await bcrypt.hash(body.newPassword, 12);

    // Atualiza senha + marca código como usado + zera tentativas falhas + desloga
    // sessões (invalida refresh tokens) numa transação
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data : { passwordHash: newHash, failedAttempts: 0, lockedUntil: null },
      }),
      prisma.passwordResetCode.update({
        where: { id: record.id },
        data : { usedAt: new Date() },
      }),
      prisma.session.deleteMany({ where: { userId: user.id } }),
    ]);

    logger.info({ userId: user.id, ip: request.ip }, 'reset-password: senha alterada com sucesso');
    return reply.send({ message: 'Senha alterada com sucesso. Faça login com a nova senha.' });
  });
}