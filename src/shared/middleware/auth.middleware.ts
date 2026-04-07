import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../utils/prisma';
import { AuditService } from '../../modules/audit/audit.service';
import { UnauthorizedError, ForbiddenError } from '../errors/AppError';
import { Role } from '@prisma/client';
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
    throw new UnauthorizedError('Token inválido ou expirado');
  }

  const token = request.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new UnauthorizedError();

  const session = await prisma.session.findFirst({
    where: { accessToken: token, expiresAt: { gt: new Date() } },
  });

  if (!session) throw new UnauthorizedError('Sessão expirada. Faça login novamente.');

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
