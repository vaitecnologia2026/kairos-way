import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../shared/middleware/auth.middleware';
import { r2 } from '../../shared/services/r2.service';
/**
 * POST /upload/image
 * Recebe multipart/form-data com campo "file"
 * Retorna { url } da imagem no R2
 *
 * Query params:
 * - folder: 'products' | 'offers' | 'avatars' (default: 'products')
 */
export async function uploadRoutes(app: FastifyInstance) {
  app.post('/image', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN', 'AFFILIATE')],
  }, async (req, reply) => {
    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ message: 'Nenhum arquivo enviado' });
    }
    const folder = (req.query as any).folder || 'products';
    const buffer = await data.toBuffer();
    try {
      const { url } = await r2.upload({
        buffer,
        mimeType    : data.mimetype,
        originalName: data.filename,
        folder,
      });
      return reply.status(201).send({ url });
    } catch (err: any) {
      return reply.status(400).send({ message: err.message });
    }
  });
}