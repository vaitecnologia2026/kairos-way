import { prisma } from '../../shared/utils/prisma';
import { AuditLevel } from '@prisma/client';

interface AuditInput {
  userId?: string;
  ip?: string;
  userAgent?: string;
  action: string;
  resource?: string;
  details?: Record<string, any>;
  level?: AuditLevel;
}

export class AuditService {
  async log(input: AuditInput): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          userId: input.userId,
          ip: input.ip,
          userAgent: input.userAgent,
          action: input.action,
          resource: input.resource,
          details: input.details as any,
          level: input.level || 'LOW',
        },
      });
    } catch {
      // Audit log nunca deve quebrar a operação principal
    }
  }

  async findAll(filters: {
    userId?: string;
    level?: AuditLevel;
    action?: string;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }) {
    const { page = 1, limit = 50, ...where } = filters;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: {
          userId: where.userId,
          level: where.level,
          action: where.action ? { contains: where.action } : undefined,
          createdAt: {
            gte: where.from,
            lte: where.to,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { name: true, email: true, role: true } } },
      }),
      prisma.auditLog.count({ where: { userId: where.userId, level: where.level } }),
    ]);

    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
