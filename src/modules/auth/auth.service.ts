import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/utils/prisma';
import { AuditService } from '../audit/audit.service';
import { enqueueEmail } from '../../shared/queue/enqueue';
import { logger } from '../../shared/utils/logger';
import {
  UnauthorizedError,
  LockedError,
  ConflictError,
  NotFoundError,
  AppError,
} from '../../shared/errors/AppError';
import { Role } from '@prisma/client';

const MAX_ATTEMPTS   = 6;
const LOCKOUT_MS     = 30 * 60 * 1000;
const ACCESS_TTL     = '15m';
const REFRESH_TTL    = '7d';
const TEMP_TOKEN_TTL = '5m';

const ENCRYPTION_KEY = Buffer.from(
  process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'),
  'hex'
).slice(0, 32);

const auditService = new AuditService();

export class AuthService {
  constructor(private readonly fastify: FastifyInstance) {}

  // ── LOGIN ─────────────────────────────────────────────────────
  async login(email: string, password: string, ip: string) {
    const user = await prisma.user.findUnique({ where: { email, deletedAt: null } });

    if (!user || !user.isActive) {
      await auditService.log({ ip, action: 'LOGIN_FAIL', details: { email }, level: 'MEDIUM' });
      throw new UnauthorizedError('Email ou senha incorretos');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await auditService.log({
        userId: user.id, ip, action: 'LOGIN_BLOCKED',
        details: { email, lockedUntil: user.lockedUntil }, level: 'HIGH',
      });
      throw new LockedError(user.lockedUntil);
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const attempts   = user.failedAttempts + 1;
      const shouldLock = attempts >= MAX_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data : {
          failedAttempts: attempts,
          lockedUntil   : shouldLock ? new Date(Date.now() + LOCKOUT_MS) : null,
        },
      });
      await auditService.log({
        userId: user.id, ip,
        action : shouldLock ? 'LOGIN_BLOCK_TRIGGERED' : 'LOGIN_FAIL',
        details: { attempts, maxAttempts: MAX_ATTEMPTS },
        level  : shouldLock ? 'HIGH' : 'MEDIUM',
      });
      if (shouldLock) throw new LockedError(new Date(Date.now() + LOCKOUT_MS));
      throw new UnauthorizedError(
        `Email ou senha incorretos. ${MAX_ATTEMPTS - attempts} tentativa(s) restante(s).`
      );
    }

    await prisma.user.update({
      where: { id: user.id },
      data : { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip },
    });

    // FIX 1: MFA exigido para qualquer role que tiver ativado (não só ADMIN/STAFF)
    if (user.mfaEnabled) {
      const tempToken = this.fastify.jwt.sign(
        { sub: user.id, email: user.email, role: user.role, temp: true },
        { expiresIn: TEMP_TOKEN_TTL }
      );
      await auditService.log({ userId: user.id, ip, action: 'MFA_REQUIRED', level: 'MEDIUM' });
      return { requiresMfa: true, tempToken };
    }

    const tokens = await this.createSession(user.id, user.role, ip);
    await auditService.log({ userId: user.id, ip, action: 'LOGIN_SUCCESS', level: 'MEDIUM' });
    logger.info({ userId: user.id, role: user.role, ip }, 'Auth: login bem-sucedido');
    return { ...tokens, user: this.sanitize(user) };
  }

  // ── MFA VERIFY ────────────────────────────────────────────────
  async verifyMfa(tempToken: string, code: string, ip: string) {
    let payload: { sub: string; email: string; role: Role; temp: boolean };
    try {
      payload = this.fastify.jwt.verify<typeof payload>(tempToken);
    } catch {
      throw new UnauthorizedError('Token MFA inválido ou expirado');
    }

    if (!payload.temp) throw new UnauthorizedError('Token inválido');

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.mfaSecret) throw new UnauthorizedError('Usuário ou segredo MFA não encontrado');

    // FIX 2: descriptografar o secret antes de verificar
    const secret = this.decryptField(user.mfaSecret);
    const valid  = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });

    if (!valid) {
      await auditService.log({ userId: user.id, ip, action: 'MFA_FAIL', level: 'HIGH' });
      throw new UnauthorizedError('Código MFA inválido');
    }

    const tokens = await this.createSession(user.id, user.role, ip);
    await auditService.log({ userId: user.id, ip, action: 'MFA_SUCCESS', level: 'MEDIUM' });
    return { ...tokens, user: this.sanitize(user) };
  }

  // ── REFRESH TOKEN ─────────────────────────────────────────────
  async refreshToken(refreshToken: string, ip: string) {
    const session = await prisma.session.findFirst({
      where  : { refreshToken, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!session) {
      logger.warn('Auth: refresh token não encontrado ou expirado');
      throw new UnauthorizedError('Refresh token inválido ou expirado');
    }

    try {
      this.fastify.jwt.verify(refreshToken);
    } catch {
      logger.warn({ userId: session.userId }, 'Auth: refresh token com assinatura inválida — sessão revogada');
      await prisma.session.delete({ where: { id: session.id } });
      throw new UnauthorizedError('Refresh token inválido');
    }

    await prisma.session.delete({ where: { id: session.id } });
    return this.createSession(session.user.id, session.user.role, ip);
  }

  // ── LOGOUT ────────────────────────────────────────────────────
  async logout(accessToken: string, userId: string) {
    await prisma.session.deleteMany({ where: { accessToken } });
    await auditService.log({ userId, action: 'LOGOUT', level: 'LOW' });
  }

  // ── REVOKE ALL SESSIONS ───────────────────────────────────────
  async revokeAllSessions(targetUserId: string, adminId: string) {
    const count = await prisma.session.deleteMany({ where: { userId: targetUserId } });
    await auditService.log({
      userId  : adminId,
      action  : 'USER_SESSIONS_REVOKED',
      details : { targetUserId, sessionsRevoked: count.count },
      level   : 'HIGH',
    });
  }

  // ── GET ME ────────────────────────────────────────────────────
  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where  : { id: userId },
      include: { producer: { select: { kycStatus: true, isActive: true, companyName: true } } },
    });
    if (!user) throw new NotFoundError('Usuário');
    return this.sanitize(user);
  }

  // ── REGISTER ──────────────────────────────────────────────────
  async register(data: {
    name: string; email: string; password: string;
    document?: string; phone?: string; companyName?: string;
  }, ip: string) {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new ConflictError('Este email já está cadastrado');

    const passwordHash = await bcrypt.hash(data.password, 12);

    const user = await prisma.user.create({
      data: {
        name        : data.name,
        email       : data.email,
        passwordHash,
        document    : data.document,
        phone       : data.phone,
        role        : 'PRODUCER',
        // Login liberado em modo leitura. O guard requireProducerApproved bloqueia
        // operações (criar produto, ofertas, splits) até o admin aprovar e criar
        // o recebedor no Pagar.me.
        isActive    : true,
        producer    : {
          create: { companyName: data.companyName, kycStatus: 'PENDING' },
        },
      },
    });

    await auditService.log({ userId: user.id, ip, action: 'REGISTER', level: 'MEDIUM' });

    await enqueueEmail(
      user.email,
      'Bem-vindo à Kairos Way!',
      'welcome',
      { name: user.name }
    );

    return {
      message: 'Cadastro realizado! Aguarde a aprovação do administrador.',
      userId : user.id,
    };
  }

  // ── MFA SETUP ────────────────────────────────────────────────
  async setupMfa(userId: string, email: string) {
    const secret = speakeasy.generateSecret({
      name  : `${process.env.MFA_ISSUER || 'KairosWay'}:${email}`,
      length: 20,
    });

    const encryptedSecret = this.encryptField(secret.base32);
    await prisma.user.update({
      where: { id: userId },
      data : { mfaSecret: encryptedSecret, mfaEnabled: false },
    });

    const qrUrl = await qrcode.toDataURL(secret.otpauth_url!);
    return { secret: secret.base32, qrCode: qrUrl, otpauthUrl: secret.otpauth_url };
  }

  // ── MFA ENABLE ───────────────────────────────────────────────
  async enableMfa(userId: string, code: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfaSecret) throw new AppError('Configure o MFA primeiro com POST /auth/mfa/setup');

    const secret = this.decryptField(user.mfaSecret);
    const valid  = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) throw new UnauthorizedError('Código inválido. Escaneie o QR Code novamente.');

    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    await auditService.log({ userId, action: 'MFA_ENABLED', level: 'HIGH' });

    await enqueueEmail(
      user.email,
      'Autenticação em dois fatores ativada',
      'mfa-enabled',
      { name: user.name }
    );
  }

  // ── MFA DISABLE ──────────────────────────────────────────────
  // Exige a senha atual para confirmar (mesmo padrão de change-password).
  async disableMfa(userId: string, currentPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('Usuário');
    if (!user.mfaEnabled) throw new AppError('MFA já está desativado');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Senha atual incorreta');

    await prisma.user.update({
      where: { id: userId },
      data : { mfaEnabled: false, mfaSecret: null },
    });
    await auditService.log({ userId, action: 'MFA_DISABLED', level: 'HIGH' });
  }

  // ── CHANGE PASSWORD ──────────────────────────────────────────
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('Usuário');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Senha atual incorreta');

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });

    await prisma.session.deleteMany({ where: { userId } });
    await auditService.log({ userId, action: 'PASSWORD_CHANGED', level: 'HIGH' });

    await enqueueEmail(
      user.email,
      'Senha alterada na sua conta',
      'password-changed',
      { name: user.name }
    );
  }

  // ── PRIVATE HELPERS ──────────────────────────────────────────
  private async createSession(userId: string, role: Role, ip: string) {
    const sessions = await prisma.session.findMany({
      where  : { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (sessions.length >= 5) {
      const toRevoke = sessions.slice(0, sessions.length - 4);
      await prisma.session.deleteMany({ where: { id: { in: toRevoke.map((s) => s.id) } } });
    }

    const accessToken = this.fastify.jwt.sign(
      { sub: userId, role, temp: false },
      { expiresIn: ACCESS_TTL }
    );

    const refreshToken = this.fastify.jwt.sign(
      { sub: userId, role, refresh: true },
      { expiresIn: REFRESH_TTL }
    );

    const session = await prisma.session.create({
      data: {
        userId,
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ip,
      },
    });

    return { accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  private encryptField(plaintext: string): string {
    const iv      = crypto.randomBytes(12);
    const cipher  = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    const enc     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, enc]).toString('base64');
  }

  private decryptField(ciphertext: string): string {
    try {
      const buf      = Buffer.from(ciphertext, 'base64');
      const iv       = buf.subarray(0, 12);
      const authTag  = buf.subarray(12, 28);
      const enc      = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(enc).toString('utf8') + decipher.final('utf8');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Auth: falha ao descriptografar campo — ENCRYPTION_KEY pode ter mudado');
      throw err;
    }
  }

  private sanitize(user: any) {
    const { passwordHash, mfaSecret, lockedUntil, failedAttempts, ...safe } = user;
    return safe;
  }
}