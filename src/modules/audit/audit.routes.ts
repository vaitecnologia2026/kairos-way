import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { AuditService } from './audit.service';

const auditService = new AuditService();

export async function auditRoutes(app: FastifyInstance) {

  // GET /audit — listar audit log
  app.get('/', { preHandler: [authenticate, requireRole('ADMIN', 'STAFF')] }, async (req, reply) => {
    const { page, limit, level, action, from, to, userId } = req.query as any;
    const result = await auditService.findAll({
      page: Number(page) || 1,
      limit: Number(limit) || 50,
      level, action, userId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return reply.send(result);
  });
}
