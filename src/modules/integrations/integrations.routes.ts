import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import axios from 'axios';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { prisma } from '../../shared/utils/prisma';
import { logger } from '../../shared/utils/logger';
import { AuditService } from '../audit/audit.service';
import { buildMelhorEnvio } from '../../shared/services/melhor-envio.service';
import { buildNFeIo }       from '../../shared/services/nfeio.service';

// ══════════════════════════════════════════════════════════════════
// MELHOR ENVIO — OAuth 2.0
// ══════════════════════════════════════════════════════════════════
// Fluxo:
//   1. GET /integrations/melhor-envio/authorize (autenticado)
//      → redireciona para ME com ?state=<userId>
//   2. Produtor autoriza no ME
//   3. ME redireciona para /integrations/melhor-envio/callback?code&state
//      → troca code por access_token e salva em UserIntegration
//
// Envs necessárias:
//   MELHOR_ENVIO_CLIENT_ID
//   MELHOR_ENVIO_CLIENT_SECRET
//   MELHOR_ENVIO_REDIRECT_URI   (ex: https://.../integrations/melhor-envio/callback)
//   MELHOR_ENVIO_SANDBOX=true|false
//   FRONTEND_URL                (para redirecionar o usuário de volta)

const ME_SCOPES = [
  'cart-read', 'cart-write',
  'shipping-calculate', 'shipping-cancel', 'shipping-checkout',
  'shipping-companies', 'shipping-generate', 'shipping-preview',
  'shipping-print', 'shipping-share', 'shipping-tracking',
  'ecommerce-shipping',
  'orders-read', 'purchases-read',
  'companies-read', 'users-read',
].join(' ');

function meBaseUrl(): string {
  return process.env.MELHOR_ENVIO_SANDBOX === 'true'
    ? 'https://sandbox.melhorenvio.com.br'
    : 'https://melhorenvio.com.br';
}

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

  // ── GET /integrations/melhor-envio/authorize ── (retorna a URL do OAuth)
  // O frontend chama via axios (com JWT) e depois faz window.location = url
  app.get('/melhor-envio/authorize', { preHandler: [authenticate] }, async (req, reply) => {
    const clientId    = process.env.MELHOR_ENVIO_CLIENT_ID;
    const redirectUri = process.env.MELHOR_ENVIO_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return reply.status(500).send({ message: 'OAuth Melhor Envio não configurado (env)' });
    }
    const state = req.user.sub;
    const url = `${meBaseUrl()}/oauth/authorize`
      + `?client_id=${encodeURIComponent(clientId)}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&response_type=code`
      + `&scope=${encodeURIComponent(ME_SCOPES)}`
      + `&state=${encodeURIComponent(state)}`;
    return reply.send({ url });
  });

  // ── GET /integrations/melhor-envio/callback ── (recebe code do ME)
  app.get('/melhor-envio/callback', async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const frontUrl = process.env.FRONTEND_URL || 'https://kairos-front-sage.vercel.app';

    if (error || !code || !state) {
      return reply.redirect(`${frontUrl}/produtor/integracoes?me=error&reason=${encodeURIComponent(error || 'missing_params')}`, 302);
    }

    const clientId     = process.env.MELHOR_ENVIO_CLIENT_ID;
    const clientSecret = process.env.MELHOR_ENVIO_CLIENT_SECRET;
    const redirectUri  = process.env.MELHOR_ENVIO_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return reply.redirect(`${frontUrl}/produtor/integracoes?me=error&reason=env_missing`, 302);
    }

    try {
      const { data } = await axios.post(`${meBaseUrl()}/oauth/token`, {
        grant_type   : 'authorization_code',
        client_id    : clientId,
        client_secret: clientSecret,
        redirect_uri : redirectUri,
        code,
      }, { timeout: 15_000 });

      const { access_token, refresh_token, expires_in, token_type } = data;
      if (!access_token) {
        logger.error({ data }, 'MelhorEnvio OAuth: resposta sem access_token');
        return reply.redirect(`${frontUrl}/produtor/integracoes?me=error&reason=no_token`, 302);
      }

      const expiresAt = expires_in
        ? new Date(Date.now() + Number(expires_in) * 1000).toISOString()
        : null;

      await prisma.userIntegration.upsert({
        where : { userId_provider: { userId: state, provider: 'MELHOR_ENVIO' } },
        create: {
          userId  : state,
          provider: 'MELHOR_ENVIO',
          config  : {
            accessToken : access_token,
            refreshToken: refresh_token,
            tokenType   : token_type,
            expiresAt,
            sandbox     : process.env.MELHOR_ENVIO_SANDBOX === 'true',
          } as any,
          isActive: true,
        },
        update: {
          config: {
            accessToken : access_token,
            refreshToken: refresh_token,
            tokenType   : token_type,
            expiresAt,
            sandbox     : process.env.MELHOR_ENVIO_SANDBOX === 'true',
          } as any,
          isActive: true,
        },
      });

      await audit.log({
        userId : state,
        action : 'MELHOR_ENVIO_CONNECTED',
        details: { tokenType: token_type, expiresIn: expires_in },
        level  : 'MEDIUM',
      });

      logger.info({ userId: state }, 'MelhorEnvio: OAuth concluído com sucesso');
      return reply.redirect(`${frontUrl}/produtor/integracoes?me=ok`, 302);
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message }, 'MelhorEnvio OAuth: falha ao trocar code');
      return reply.redirect(`${frontUrl}/produtor/integracoes?me=error&reason=token_exchange_failed`, 302);
    }
  });

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

    // Normaliza status (NFe.io usa PascalCase: Issued, IssuedWithErrors, WaitingReturn, etc.)
    const s = (body.status || '').toLowerCase();
    let mappedStatus =
      s === 'issued'                                                  ? 'issued'
    : s === 'issuedwitherrors' || s === 'failed' || s === 'cancelled' ? 'failed'
    :                                                                   'processing';

    let pdfUrl = body.pdfUrl;
    let nfeId  = body.id;
    let nfeNum = body.number ? String(body.number) : undefined;

    // Se veio vazio (Pluga não consegue expor vars do NFe.io), busca tudo na API
    // do NFe.io usando as credenciais do produtor dono do pedido.
    const needsLookup = (!nfeId && !pdfUrl) || (nfeId && !pdfUrl && mappedStatus === 'issued');
    if (needsLookup) {
      try {
        const offer = await prisma.offer.findUnique({
          where  : { id: order.offerId },
          include: { product: { include: { producer: { select: { userId: true } } } } },
        });
        const producerUserId = offer?.product?.producer?.userId;
        if (producerUserId) {
          const integration = await prisma.userIntegration.findUnique({
            where: { userId_provider: { userId: producerUserId, provider: 'NFE_IO' } },
          });
          if (integration?.config) {
            const { buildNFeIo } = await import('../../shared/services/nfeio.service');
            const nfe = buildNFeIo(integration.config);
            if (nfe) {
              if (nfeId) {
                // Só busca o PDF pelo ID conhecido
                const result = await nfe.consultar(nfeId);
                pdfUrl       = result.pdfUrl;
                nfeNum       = nfeNum ?? result.nfeNumber;
                mappedStatus = result.status;
              } else {
                // Fallback total: lista últimas notas e acha a que tem o order.code
                const recent = await nfe.listarRecentes?.();
                const match  = recent?.find((n: any) =>
                  (n.description || '').includes(code) ||
                  (n.borrower?.email || '').toLowerCase() === (order.customerEmail || '').toLowerCase(),
                );
                if (match) {
                  nfeId        = match.id;
                  nfeNum       = match.number;
                  pdfUrl       = match.pdfUrl;
                  mappedStatus = match.status;
                }
              }
            }
          }
        }
      } catch { /* não bloqueia o callback — salva o que tem */ }
    }

    await prisma.order.update({
      where: { id: order.id },
      data : {
        metadata: {
          ...(order.metadata as object || {}),
          nfe: {
            id    : nfeId,
            number: nfeNum,
            status: mappedStatus,
            pdfUrl,
            xmlUrl: body.xmlUrl,
          },
        },
      },
    });

    return reply.send({ ok: true, orderId: order.id, status: mappedStatus, pdfUrl });
  });

  // ── POST /integrations/nfe-sync/:orderId — força sync de uma NFe travada ──
  // Consulta NFe.io e atualiza Order.metadata.nfe. Útil quando o callback do
  // Pluga não disparou e a nota ficou em "processing" eterno no Kairos.
  app.post('/nfe-sync/:orderId', { preHandler: [authenticate] }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const order = await prisma.order.findUnique({
      where  : { id: orderId },
      include: { offer: { include: { product: { include: { producer: { select: { userId: true } } } } } } },
    });
    if (!order) return reply.status(404).send({ message: 'Pedido não encontrado' });

    const producerUserId = order.offer?.product?.producer?.userId;
    const role = (req.user as any).role;
    if (role !== 'ADMIN' && producerUserId !== (req.user as any).sub) {
      return reply.status(403).send({ message: 'Sem permissão para este pedido' });
    }

    if (!producerUserId) return reply.status(422).send({ message: 'Produtor inválido' });
    const integration = await prisma.userIntegration.findUnique({
      where: { userId_provider: { userId: producerUserId, provider: 'NFE_IO' } },
    });
    if (!integration) return reply.status(422).send({ message: 'Produtor sem NFe.io configurada' });

    const nfe = buildNFeIo(integration.config);
    if (!nfe) return reply.status(422).send({ message: 'Credenciais NFe.io incompletas' });

    const currentNfe = (order.metadata as any)?.nfe || {};
    const code = order.id.slice(-8).toUpperCase();

    let result: any = null;
    try {
      if (currentNfe.id) {
        // Consulta direta pelo ID conhecido
        result = await nfe.consultar(currentNfe.id);
      } else {
        // Fallback: lista últimas N notas e acha a que corresponde ao pedido
        const recent = await nfe.listarRecentes(50);
        const match = recent.find((n: any) =>
          (n.description || '').includes(code) ||
          (n.borrower?.email || '').toLowerCase() === (order.customerEmail || '').toLowerCase(),
        );
        if (match) {
          result = {
            nfeId    : match.id,
            nfeNumber: match.number,
            status   : match.status,
            pdfUrl   : match.pdfUrl,
            xmlUrl   : match.xmlUrl,
          };
        }
      }
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message, orderId }, 'NFe sync falhou');
      return reply.status(502).send({ message: 'Falha ao consultar NFe.io', error: err?.message });
    }

    if (!result) {
      return reply.status(404).send({ message: 'Nenhuma NFe encontrada na NFe.io para este pedido' });
    }

    const updatedNfe = {
      id    : result.nfeId || result.id || currentNfe.id,
      number: result.nfeNumber || result.number || currentNfe.number,
      status: result.status || currentNfe.status,
      pdfUrl: result.pdfUrl || currentNfe.pdfUrl,
      xmlUrl: result.xmlUrl || currentNfe.xmlUrl,
    };

    await prisma.order.update({
      where: { id: order.id },
      data : {
        metadata: { ...(order.metadata as object || {}), nfe: updatedNfe },
      },
    });

    logger.info({ orderId, status: updatedNfe.status, hasPdf: !!updatedNfe.pdfUrl }, 'NFe sincronizada');
    return reply.send({ ok: true, orderId: order.id, nfe: updatedNfe });
  });

  // ── POST /integrations/nfe-sync-all — sincroniza TODAS as NFes em processing do produtor
  app.post('/nfe-sync-all', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub;
    const role   = (req.user as any).role;

    const integration = await prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider: 'NFE_IO' } },
    });
    if (!integration) return reply.status(422).send({ message: 'NFe.io não configurada' });
    const nfe = buildNFeIo(integration.config);
    if (!nfe) return reply.status(422).send({ message: 'Credenciais incompletas' });

    // Busca pedidos do produtor com nfe em processing ou sem nfe
    const producer = await prisma.producer.findUnique({ where: { userId } });
    if (!producer && role !== 'ADMIN') return reply.status(404).send({ message: 'Produtor não encontrado' });

    const where: any = { status: 'APPROVED' };
    if (producer) where.offer = { product: { producerId: producer.id } };

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const toSync = orders.filter(o => {
      const n = (o.metadata as any)?.nfe;
      return !n || n.status === 'processing' || !n.pdfUrl;
    });

    const recent = await nfe.listarRecentes(100);
    let synced = 0;
    for (const order of toSync) {
      const code = order.id.slice(-8).toUpperCase();
      const match = recent.find((n: any) =>
        (n.description || '').includes(code) ||
        (n.borrower?.email || '').toLowerCase() === (order.customerEmail || '').toLowerCase(),
      );
      if (!match) continue;
      await prisma.order.update({
        where: { id: order.id },
        data : {
          metadata: {
            ...(order.metadata as object || {}),
            nfe: {
              id    : match.id,
              number: match.number,
              status: match.status,
              pdfUrl: match.pdfUrl,
              xmlUrl: match.xmlUrl,
            },
          },
        },
      });
      synced++;
    }

    logger.info({ userId, checked: toSync.length, synced }, 'NFe batch sync');
    return reply.send({ checked: toSync.length, synced });
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
