import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../utils/prisma';
import { AuditService } from '../../modules/audit/audit.service';
import { UnauthorizedError, ForbiddenError } from '../errors/AppError';
import { Role } from '@prisma/client';
import { logger } from '../utils/logger';
const auditService = new AuditService();
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      sub: string;
      email: string;
      role: Role;
      name: string;
    }
  }
}
/** Verifica JWT e valida sessão ativa */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    logger.warn({ ip: request.ip, url: request.url }, 'Auth: JWT inválido ou expirado');
    throw new UnauthorizedError('Token inválido ou expirado');
  }
  const token = request.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new UnauthorizedError();
  const session = await prisma.session.findFirst({
    where: { accessToken: token, expiresAt: { gt: new Date() } },
  });
  if (!session) {
    logger.warn({ ip: request.ip, url: request.url }, 'Auth: sessão não encontrada ou expirada');
    throw new UnauthorizedError('Sessão expirada. Faça login novamente.');
  }
  // Audit log de acesso à API
  await auditService.log({
    userId: (request.user as any).sub,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    action: 'API_ACCESS',
    resource: `${request.method} ${request.url}`,
    level: 'LOW',
  });
}
/** Tenta autenticar sem rejeitar quando não há token (endpoints públicos com auth opcional) */
export async function optionalAuthenticate(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const token = request.headers.authorization?.replace('Bearer ', '');
  if (!token) return;
  try {
    await request.jwtVerify();
  } catch {
    delete (request as any).user;
    return;
  }
  const session = await prisma.session.findFirst({
    where: { accessToken: token, expiresAt: { gt: new Date() } },
  });
  if (!session) {
    delete (request as any).user;
  }
}

/** Verifica se o usuário tem o(s) role(s) necessário(s) */
export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!roles.includes(request.user.role)) {
      throw new ForbiddenError(
        `Acesso restrito a: ${roles.join(', ')}. Seu perfil: ${request.user.role}`
      );
    }
  };
}
/** Middleware combinado: autenticar + verificar role */
export function authGuard(...roles: Role[]) {
  return [authenticate, requireRole(...roles)];
}

/**
 * Garante que o produtor (role=PRODUCER) completou o KYC e tem recebedor Pagar.me.
 * Afiliados-coprodutores também passam por aqui quando acessam ações de produtor.
 * Usar APÓS authenticate.
 */
export async function requireProducerApproved(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const user = request.user;
  if (!user) throw new UnauthorizedError();
  // ADMIN/STAFF passam direto para manutenção
  if (user.role === 'ADMIN' || user.role === 'STAFF') return;

  const producer = await prisma.producer.findUnique({ where: { userId: user.sub } });
  if (!producer) {
    throw new ForbiddenError('Perfil de produtor não encontrado.');
  }
  if (producer.kycStatus !== 'APPROVED' || !producer.isActive || !producer.pagarmeRecipientId) {
    throw new ForbiddenError(
      'Sua conta está em modo de leitura. Envie a documentação em "Verificação" para liberar as operações.',
    );
  }
}