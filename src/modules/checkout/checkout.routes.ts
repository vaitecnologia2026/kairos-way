import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayService } from '../gateway/gateway.service';
import { SplitEngineService } from '../split-engine/split-engine.service';
import { AuditService } from '../audit/audit.service';
import { prisma } from '../../shared/utils/prisma';
import { logger } from '../../shared/utils/logger';
import { NotFoundError, AppError } from '../../shared/errors/AppError';
import { authenticate, requireRole, optionalAuthenticate } from '../../shared/middleware/auth.middleware';
import { enqueueNfe, enqueueEmail, enqueueLogistics } from '../../shared/queue/enqueue';
import { whatsAppService } from '../../shared/services/whatsapp.service';
import { notifyNewSale } from '../../shared/utils/notifyNewSale';

const gateway      = new GatewayService();
const splitEngine  = new SplitEngineService();
const auditService = new AuditService();

export async function checkoutRoutes(app: FastifyInstance) {

  // ── GET /checkout/:slug — dados da oferta ─────────────────────
  app.get('/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const q    = req.query  as { aff?: string; ref?: string };
    const aff   = q.aff || q.ref;

    const [offer, platformConfig] = await Promise.all([
      prisma.offer.findUnique({
        where  : { slug, isActive: true, deletedAt: null },
        include: {
          product: {
            include: { producer: { select: { metadata: true } } },
          },
          checkoutConfig: true,
        },
      }),
      prisma.platformConfig.findUnique({ where: { key: 'checkout_success_message' } }),
    ]);
    if (!offer) throw new NotFoundError('Oferta');

    // Rastrear clique de afiliado (fire-and-forget)
    if (aff) {
      prisma.affiliate.findUnique({ where: { code: aff, isActive: true } }).then((affiliate) => {
        if (affiliate) {
          prisma.affiliateTracking.create({
            data: { affiliateId: affiliate.id, offerId: offer.id, ip: req.ip, userAgent: req.headers['user-agent'] },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    // Hierarquia: produto → produtor → plataforma → código
    const prodCfg  = ((offer.product as any).producer?.metadata as any)?.successConfig ?? {};
    const platCfg  = (platformConfig?.value as any) ?? {};
    const successMessage   = offer.product.successMessage   ?? prodCfg.html  ?? platCfg.html  ?? null;
    const successIcon      = offer.product.successIcon      ?? prodCfg.icon  ?? platCfg.icon  ?? 'CheckCircle';
    const successIconColor = offer.product.successIconColor ?? prodCfg.color ?? platCfg.color ?? '#00C9A7';

    return reply.send({
      offer: {
        id              : offer.id,
        name            : offer.product.name,
        description     : offer.product.description,
        imageUrl        : offer.product.imageUrl,
        priceCents      : offer.priceCents,
        type            : offer.type,
        successMessage,
        successIcon,
        successIconColor,
      },
      config: offer.checkoutConfig,
    });
  });

  // ── POST /checkout/:slug/pay — processar pagamento ────────────
  app.post('/:slug/pay', {
    config    : { rateLimit: { max: 10, timeWindow: 60_000 } },
    preHandler: [optionalAuthenticate],
  }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const q2   = req.query  as { aff?: string; ref?: string };
    const aff  = q2.aff || q2.ref;

    const body = z.object({
      customerEmail  : z.string().email(),
      customerName   : z.string().min(3),
      customerDoc    : z.string().optional(),
      customerPhone  : z.string().optional(),
      method         : z.enum(['PIX', 'CREDIT_CARD', 'BOLETO']),
      cardToken      : z.string().optional(),
      installments   : z.number().int().min(1).max(12).optional(),
      billingAddress : z.record(z.string()).optional(),
    }).parse(req.body);

    const offer = await prisma.offer.findUnique({
      where  : { slug, isActive: true, deletedAt: null },
      include: { product: true },
    });
    if (!offer) throw new NotFoundError('Oferta');

    let affiliateId: string | undefined;
    if (aff) {
      const affiliate = await prisma.affiliate.findUnique({ where: { code: aff, isActive: true } });
      affiliateId = affiliate?.id;
    }

    const customerId = (req as any).user?.sub as string | undefined;

    const order = await prisma.order.create({
      data: {
        offerId      : offer.id,
        affiliateId,
        customerId,
        customerEmail: body.customerEmail,
        customerName : body.customerName,
        customerDoc  : body.customerDoc,
        customerPhone: body.customerPhone,
        amountCents  : offer.priceCents,
        paymentMethod: body.method as any,
        status       : 'PENDING',
        ipAddress    : req.ip,
        userAgent    : req.headers['user-agent'],
      },
    });
    logger.info({ orderId: order.id, offerId: offer.id, method: body.method, amountCents: offer.priceCents }, 'Checkout: pedido criado');

    try {
      const result = await gateway.processPayment({
        offerId       : offer.id,
        amountCents   : offer.priceCents,
        method        : body.method as any,
        installments  : body.installments,
        customerEmail : body.customerEmail,
        customerName  : body.customerName,
        customerDoc   : body.customerDoc,
        customerPhone : body.customerPhone,   // FIX: obrigatório para PIX
        cardToken     : body.cardToken,
        billingAddress: body.billingAddress,  // FIX: obrigatório para Boleto
        ip            : req.ip,
      });

      const orderStatus = result.status === 'APPROVED'
        ? 'APPROVED'
        : result.status === 'PENDING'
          ? 'PROCESSING'
          : 'REJECTED';

      logger.info({ orderId: order.id, acquirer: result.acquirer, acquirerTxId: result.acquirerTxId, orderStatus }, 'Checkout: resposta do gateway recebida');

      // Captura dados do afiliado para notificação (preenchidos dentro da transação)
      let notifAffiliateUserId: string | undefined;
      let notifCommissionCents = 0;

      // Order + splits em transação atômica
      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data : {
            status        : orderStatus as any,
            acquirer      : result.acquirer,
            acquirerTxId  : result.acquirerTxId,
            pixCode       : result.pixCode,
            pixQrCode     : result.pixQrCode,
            boletoUrl     : result.boletoUrl,
            boletoBarcode : result.boletoBarcode,
            approvedAt    : orderStatus === 'APPROVED' ? new Date() : undefined,
          },
        });

        if (orderStatus === 'APPROVED') {
          await splitEngine.saveSplitRecords(order.id, result.splits, tx);

          // Split do afiliado (se houver ?ref= no pedido)
          // A comissão do afiliado SAI da parte do PRODUTOR — nunca é somada ao total
          if (order.affiliateId) {
            const affiliate = await tx.affiliate.findUnique({ where: { id: order.affiliateId } });
            if (affiliate) {
              const config = await tx.affiliateConfig.findUnique({
                where: { offerId: offer.id, enabled: true },
              });
              if (config && config.commissionBps > 0) {
                const commissionCents = Math.floor(order.amountCents * config.commissionBps / 10000);
                if (commissionCents > 0) {
                  // Buscar o split record do PRODUTOR para descontar a comissão
                  const producerRecord = await tx.splitRecord.findFirst({
                    where: { orderId: order.id, recipientType: 'PRODUCER' },
                  });

                  if (!producerRecord) {
                    logger.error({ orderId: order.id }, 'Split do produtor não encontrado — comissão de afiliado não registrada');
                    return;
                  }

                  const producerAfterCommission = producerRecord.amountCents - commissionCents;
                  if (producerAfterCommission < 0) {
                    logger.error({ orderId: order.id, commissionCents, producerCents: producerRecord.amountCents },
                      'Comissão do afiliado excede o valor do produtor — comissão não registrada');
                    return;
                  }

                  // Reduzir o split do produtor pelo valor da comissão
                  await tx.splitRecord.update({
                    where: { id: producerRecord.id },
                    data : { amountCents: producerAfterCommission },
                  });

                  // Criar o split do afiliado com o mesmo splitRuleId do produtor como referência
                  await tx.splitRecord.create({
                    data: {
                      orderId      : order.id,
                      splitRuleId  : producerRecord.splitRuleId,
                      recipientType: 'AFFILIATE',
                      recipientId  : affiliate.userId,
                      amountCents  : commissionCents,
                      status       : 'PENDING',
                    },
                  });

                  // Capturar para notificação (fora da transação)
                  notifAffiliateUserId = affiliate.userId;
                  notifCommissionCents = commissionCents;
                }
              }
            }
          }
        }

        // Linkar tracking ao orderId para QUALQUER status (inclusive PIX/Boleto PENDING)
        // O webhook de confirmação precisa encontrar o tracking via orderId
        if (order.affiliateId) {
          await tx.affiliateTracking.updateMany({
            where: { affiliateId: order.affiliateId, offerId: offer.id, orderId: null },
            data : { orderId: order.id },
          });
        }
      });

      // ── Workers após aprovação ─────────────────────────────────
      if (orderStatus === 'APPROVED') {
        // Notificação in-app para produtor (e afiliado, se houver)
        await notifyNewSale({
          orderId        : order.id,
          productName    : offer.product.name,
          amountCents    : offer.priceCents,
          producerUserId : offer.product.producerId,
          affiliateUserId: notifAffiliateUserId,
          commissionCents: notifCommissionCents,
        });

        // Email de confirmação para o cliente
        await enqueueEmail(
          body.customerEmail,
          `Pagamento confirmado — ${offer.product.name}`,
          'order-approved',
          {
            customerName: body.customerName,
            productName : offer.product.name,
            amountCents : offer.priceCents,
            orderId     : order.id,
            accessUrl   : (offer.product as any).digitalUrl || undefined,
          }
        );

        // Emitir NF-e (apenas para produtos digitais — o worker filtra)
        await enqueueNfe(order.id);

        // Logística — criar shipment WAITING para produtos físicos (produtor despacha depois)
        if (offer.product.type === 'PHYSICAL') {
          await enqueueLogistics(order.id);
        }

        // WhatsApp — enviar link do produto digital ao cliente (só se tiver digitalUrl e telefone)
        const digitalUrl = (offer.product as any).digitalUrl;
        if (digitalUrl && body.customerPhone) {
          whatsAppService.sendPurchaseConfirmation({
            phone        : body.customerPhone,
            customerName : body.customerName,
            productName  : offer.product.name,
            paymentMethod: body.method,
            digitalUrl,
          }).catch(err => {
            // Não falha o checkout se o WhatsApp falhar
            logger.info({ orderId: order.id }, 'WhatsApp: envio ignorado (Vercel/cloud block) — pedido não afetado');
          });
        }
      }

      await auditService.log({
        action  : 'ORDER_CREATED',
        resource: `order:${order.id}`,
        details : {
          offerId    : offer.id,
          acquirer   : result.acquirer,
          status     : orderStatus,
          amountCents: offer.priceCents,
        },
        level: 'MEDIUM',
      });

      return reply.status(201).send({
        orderId      : order.id,
        status       : orderStatus,
        method       : body.method,   // FIX: frontend precisa saber o método para tela de boleto
        acquirer     : result.acquirer,
        pixCode      : result.pixCode,
        pixQrCode    : result.pixQrCode,
        pixExpiration: result.pixCode
          ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
          : undefined,
        boletoUrl    : result.boletoUrl,
        boletoBarcode: result.boletoBarcode,
      });

    } catch (err: any) {
      logger.error({ orderId: order.id, offerId: offer.id, method: body.method, err: err?.message }, 'Checkout: pagamento falhou — pedido rejeitado');
      await prisma.order.update({
        where: { id: order.id },
        data : { status: 'REJECTED', rejectedAt: new Date() },
      });
      throw err;
    }
  });

  // ── POST /checkout/:slug/upsell/accept ────────────────────────
  app.post('/:slug/upsell/accept', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body     = z.object({ orderId: z.string() }).parse(req.body);

    const offer = await prisma.offer.findUnique({
      where  : { slug },
      include: { checkoutConfig: true },
    });
    if (!offer?.checkoutConfig?.upsellOfferId) throw new NotFoundError('Upsell');

    const originalOrder = await prisma.order.findUnique({ where: { id: body.orderId } });
    if (!originalOrder) throw new NotFoundError('Pedido original');
    if (!originalOrder.cardToken) {
      throw new AppError('Upsell disponível apenas para pagamentos com cartão', 400);
    }

    const upsellOffer = await prisma.offer.findUnique({
      where  : { id: offer.checkoutConfig.upsellOfferId },
      include: { product: true },
    });
    if (!upsellOffer) throw new NotFoundError('Oferta de upsell');

    const result = await gateway.processPayment({
      offerId      : upsellOffer.id,
      amountCents  : upsellOffer.priceCents,
      method       : 'CREDIT_CARD',
      cardToken    : originalOrder.cardToken,
      customerEmail: originalOrder.customerEmail!,
      customerName : originalOrder.customerName!,
      customerDoc  : originalOrder.customerDoc || undefined,
    });

    return reply.send({ status: result.status, acquirerTxId: result.acquirerTxId });
  });

  // ── POST /checkout/tokenize-card ─────────────────────────────
  // Tokeniza o cartão via Pagar.me server-side (resolve CORS do browser)
  // Os dados do cartão transitam pelo servidor mas NUNCA são armazenados (PCI SAQ A-EP)
  app.post('/tokenize-card', {
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const body = z.object({
      number  : z.string().min(13).max(19),
      holder  : z.string().min(3),
      expMonth: z.string().length(2),
      expYear : z.string().length(4),
      cvv     : z.string().min(3).max(4),
    }).parse(req.body);

    const apiKey = process.env.PAGARME_API_KEY;
    if (!apiKey) throw new AppError('Gateway não configurado', 500);

    try {
      const axios = (await import('axios')).default;
      const publicKey = process.env.PAGARME_PUBLIC_KEY;
      if (!publicKey) throw new AppError('PAGARME_PUBLIC_KEY não configurado', 500);

      // appId como query param — sem Authorization header
      // Do Node.js não há restrição de CORS, funciona normalmente server-side
      const { data } = await axios.post(
        `https://api.pagar.me/core/v5/tokens?appId=${publicKey}`,
        {
          type: 'card',
          card: {
            number     : body.number.replace(/\D/g, ''),
            holder_name: body.holder.toUpperCase(),
            exp_month  : body.expMonth,
            exp_year   : body.expYear,
            cvv        : body.cvv,
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        }
      );

      if (!data.id) throw new AppError('Erro ao tokenizar cartão', 502);
      return reply.send({ token: data.id, brand: data.card?.brand });
    } catch (err: any) {
      logger.error({ statusCode: err?.response?.status, data: err?.response?.data }, 'Checkout: erro ao tokenizar cartão');
      const msg = err?.response?.data?.message
               || err?.response?.data?.errors?.[0]?.message
               || 'Erro ao processar cartão';
      throw new AppError(msg, 422);
    }
  });

  // ── POST /checkout/config — configurar checkout white label ───
  app.post('/config', {
    preHandler: [authenticate, requireRole('PRODUCER', 'ADMIN')],
  }, async (req, reply) => {
    const body = z.object({
      offerId            : z.string(),
      primaryColor       : z.string().optional(),
      bgColor            : z.string().optional(),
      logoUrl            : z.string().url().optional(),
      customDomain       : z.string().optional(),
      pixEnabled         : z.boolean().optional(),
      cardEnabled        : z.boolean().optional(),
      boletoEnabled      : z.boolean().optional(),
      maxInstallments    : z.number().int().min(1).max(12).optional(),
      passInstFee        : z.boolean().optional(),
      orderBumpOfferId   : z.string().optional(),
      upsellOfferId      : z.string().optional(),
      countdownMinutes   : z.number().optional(),
      guaranteeDays      : z.number().optional(),
      facebookPixelId    : z.string().optional(),
      gtmId              : z.string().optional(),
      threatMetrixEnabled: z.boolean().optional(),
    }).parse(req.body);

    const config = await prisma.checkoutConfig.upsert({
      where : { offerId: body.offerId },
      create: body,
      update: body,
    });

    return reply.send(config);
  });
}