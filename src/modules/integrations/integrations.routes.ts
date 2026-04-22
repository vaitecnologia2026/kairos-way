import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { logger } from '../../shared/utils/logger';
import { AuditService } from '../audit/audit.service';
import { buildMelhorEnvio } from '../../shared/services/melhor-envio.service';
import { buildNFeIo }       from '../../shared/services/nfeio.service';

const audit = new AuditService();

const PROVIDERS = ['MELHOR_ENVIO', 'NFE_IO'] as const;
type Provider = typeof PROVIDERS[number];

// Schemas de config por provider (validação)
const CONFIG_SCHEMAS: Record<Provider, z.ZodTypeAny> = {
  MELHOR_ENVIO: z.object({
    accessToken: z.string().min(10, 'Access token muito curto'),
    sandbox    : z.boolean().optional().default(false),
    userAgent  : z.string().optional(),
    fromCep    : z.string().optional(),
  }),
  NFE_IO: z.object({
    apiKey          : z.string().min(10, 'API key muito curta'),
    companyId       : z.string().min(1, 'Company ID obrigatório'),
    cityServiceCode : z.string().optional(),
  }),
};

/** Remove campos sensíveis antes de retornar ao frontend. */
function maskConfig(provider: Provider, config: any): any {
  if (!config) return null;
  const mask = (s: string) => s.length > 8 ? `${s.slice(0, 4)}••••${s.slice(-4)}` : '••••';
  if (provider === 'MELHOR_ENVIO') {
    return { ...config, accessToken: config.accessToken ? mask(config.accessToken) : '' };
  }
  if (provider === 'NFE_IO') {
    return { ...config, apiKey: config.apiKey ? mask(config.apiKey) : '' };
  }
  return config;
}

export async function integrationsRoutes(app: FastifyInstance) {

  // ── POST /integrations/nfe-callback — recebe resultado da NFe.io (via Pluga)
  // Público (sem auth). Use um segredo em query (?key=XYZ) para validar.
  // No Pluga, após o passo "Create NFS-e", adicione um passo "HTTP Request":
  //   URL:    {BACKEND}/integrations/nfe-callback?orderId={order.code}&key={secret}
  //   Method: POST
  //   Body:   { id, number, status, pdfUrl, xmlUrl }  (os retornados pelo NFe.io)
  app.post('/nfe-callback', async (req, reply) => {
    const q = req.query as { orderId?: string; key?: string };
    const expected = process.env.NFE_CALLBACK_SECRET;
    if (expected && q.key !== expected) {
      return reply.status(403).send({ message: 'chave inválida' });
    }
    if (!q.orderId) return reply.status(400).send({ message: 'orderId obrigatório' });

    // Encontra order por código (últimos 8 chars upper) ou por ID direto
    const code = q.orderId.toUpperCase();
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id: q.orderId },
          { id: { endsWith: code.toLowerCase() } },
          { id: { endsWith: code } },
        ],
      },
    });
    if (!order) return reply.status(404).send({ message: 'pedido não encontrado' });

    const body = z.object({
      id      : z.string().optional(),
      number  : z.union([z.string(), z.number()]).optional(),
      status  : z.string().optional(),
      pdfUrl  : z.string().url().optional(),
      xmlUrl  : z.string().url().optional(),
    }).parse(req.body ?? {});

    const mappedStatus =
      body.status === 'Issued' || body.status === 'issued'        ? 'issued'
    : body.status === 'IssuedWithErrors' || body.status === 'failed' ? 'failed'
    :                                                                  'processing';

    await prisma.order.update({
      where: { id: order.id },
      data : {
        metadata: {
          ...(order.metadata as object || {}),
          nfe: {
            id    : body.id,
            number: body.number ? String(body.number) : undefined,
            status: mappedStatus,
            pdfUrl: body.pdfUrl,
            xmlUrl: body.xmlUrl,
          },
        },
      },
    });

    return reply.send({ ok: true, orderId: order.id, status: mappedStatus });
  });

  // GET /integrations — lista integrações do usuário logado
  app.get('/', { preHandler: [authenticate] }, async (req, reply) => {
    const rows = await prisma.userIntegration.findMany({
      where  : { userId: req.user.sub },
      orderBy: { provider: 'asc' },
    });

    // Retorna todos os providers (configurados e não configurados)
    const byProvider = new Map(rows.map(r => [r.provider, r]));
    const data = PROVIDERS.map(p => {
      const row = byProvider.get(p);
      return {
        provider  : p,
        configured: !!row,
        isActive  : row?.isActive ?? false,
        config    : row ? maskConfig(p, row.config) : null,
        updatedAt : row?.updatedAt ?? null,
      };
    });

    return reply.send({ data });
  });

  // PUT /integrations/:provider — cria ou atualiza integração
  app.put('/:provider', { preHandler: [authenticate] }, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!PROVIDERS.includes(provider as Provider)) {
      return reply.status(400).send({ message: 'Provider inválido' });
    }

    const schema = CONFIG_SCHEMAS[provider as Provider];
    const body = z.object({
      config  : schema,
      isActive: z.boolean().optional().default(true),
    }).parse(req.body);

    const row = await prisma.userIntegration.upsert({
      where : { userId_provider: { userId: req.user.sub, provider } },
      create: {
        userId  : req.user.sub,
        provider,
        config  : body.config as any,
        isActive: body.isActive,
      },
      update: {
        config  : body.config as any,
        isActive: body.isActive,
      },
    });

    await audit.log({
      userId : req.user.sub,
      action : 'INTEGRATION_UPDATED',
      details: { provider },
      level  : 'MEDIUM',
    });

    logger.info({ userId: req.user.sub, provider }, 'Integração salva');
    return reply.send({
      provider  : row.provider,
      configured: true,
      isActive  : row.isActive,
      config    : maskConfig(provider as Provider, row.config),
      updatedAt : row.updatedAt,
    });
  });

  // DELETE /integrations/:provider — remove integração
  app.delete('/:provider', { preHandler: [authenticate] }, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!PROVIDERS.includes(provider as Provider)) {
      return reply.status(400).send({ message: 'Provider inválido' });
    }

    await prisma.userIntegration.deleteMany({
      where: { userId: req.user.sub, provider },
    });

    await audit.log({
      userId : req.user.sub,
      action : 'INTEGRATION_REMOVED',
      details: { provider },
      level  : 'MEDIUM',
    });

    return reply.send({ message: 'Integração removida' });
  });

  // POST /integrations/:provider/test — testa conexão usando a config salva
  app.post('/:provider/test', { preHandler: [authenticate] }, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!PROVIDERS.includes(provider as Provider)) {
      return reply.status(400).send({ message: 'Provider inválido' });
    }

    const row = await prisma.userIntegration.findUnique({
      where: { userId_provider: { userId: req.user.sub, provider } },
    });
    if (!row) return reply.status(404).send({ message: 'Integração não configurada' });

    try {
      if (provider === 'MELHOR_ENVIO') {
        const svc = buildMelhorEnvio(row.config);
        if (!svc) return reply.send({ ok: false, error: 'Credenciais incompletas' });
        const res = await svc.testConnection();
        return reply.send(res);
      }
      if (provider === 'NFE_IO') {
        const svc = buildNFeIo(row.config);
        if (!svc) return reply.send({ ok: false, error: 'Credenciais incompletas' });
        const res = await svc.testConnection();
        return reply.send(res);
      }
      return reply.send({ ok: false, error: 'Provider sem teste implementado' });
    } catch (err: any) {
      return reply.send({ ok: false, error: err?.message || 'Erro ao testar' });
    }
  });
}
