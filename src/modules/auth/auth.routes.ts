import { prisma } from '../../shared/utils/prisma';
// ── AUTH ROUTES ──────────────────────────────────────────────────────
import { FastifyInstance } from 'fastify';
import { AuthService } from './auth.service';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { z } from 'zod';

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
}