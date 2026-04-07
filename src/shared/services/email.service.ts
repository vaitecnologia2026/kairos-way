import { Resend } from 'resend';
import { logger } from '../utils/logger';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = process.env.EMAIL_FROM || 'noreply@kairosway.com.br';
const FROM_NAME  = process.env.EMAIL_FROM_NAME || 'Kairos Way';

export interface EmailPayload {
  to      : string;
  subject : string;
  template: EmailTemplate;
  data    : Record<string, any>;
}

export type EmailTemplate =
  | 'welcome'
  | 'producer-approved'
  | 'producer-rejected'
  | 'order-approved'
  | 'order-refunded'
  | 'withdrawal-paid'
  | 'withdrawal-failed'
  | 'subscription-suspended'
  | 'subscription-cancelled'
  | 'mfa-enabled'
  | 'password-changed';

export class EmailService {

  async send(payload: EmailPayload): Promise<void> {
    const html = this.render(payload.template, payload.data);

    const { error } = await resend.emails.send({
      from   : `${FROM_NAME} <${FROM_EMAIL}>`,
      to     : payload.to,
      subject: payload.subject,
      html,
    });

    if (error) {
      logger.error({ error, to: payload.to, template: payload.template }, 'Resend: falha ao enviar email');
      throw new Error(`Resend error: ${error.message}`);
    }

    logger.info({ to: payload.to, template: payload.template }, 'Email enviado com sucesso');
  }

  // ── TEMPLATES ──────────────────────────────────────────────────
  private render(template: EmailTemplate, data: Record<string, any>): string {
    const base = (content: string) => `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; margin: 0; padding: 0; }
          .wrapper { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
          .header { background: #0055FE; padding: 32px; text-align: center; }
          .header h1 { color: #fff; margin: 0; font-size: 22px; font-weight: 700; }
          .body { padding: 32px; color: #18181b; font-size: 15px; line-height: 1.6; }
          .body h2 { font-size: 18px; font-weight: 600; margin-top: 0; }
          .highlight { background: #f0f6ff; border-left: 4px solid #0055FE; padding: 12px 16px; border-radius: 4px; margin: 16px 0; }
          .btn { display: inline-block; background: #0055FE; color: #fff !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; margin: 16px 0; }
          .footer { background: #f4f4f5; padding: 20px 32px; font-size: 12px; color: #71717a; text-align: center; }
          .amount { font-size: 28px; font-weight: 700; color: #0055FE; }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="header"><h1>Kairos Way</h1></div>
          <div class="body">${content}</div>
          <div class="footer">Kairos Way — Gateway de Pagamentos White Label<br/>
          Você está recebendo este email porque possui uma conta na plataforma.</div>
        </div>
      </body>
      </html>
    `;

    switch (template) {

      case 'welcome':
        return base(`
          <h2>Bem-vindo à Kairos Way, ${data.name}! 🎉</h2>
          <p>Seu cadastro foi recebido com sucesso. Nossa equipe irá analisar seus dados e você receberá um email de confirmação em breve.</p>
          <div class="highlight">
            <strong>Próximo passo:</strong> aguarde a aprovação do administrador. Você será notificado por email assim que sua conta for ativada.
          </div>
          <p>Qualquer dúvida, entre em contato com nosso suporte.</p>
        `);

      case 'producer-approved':
        return base(`
          <h2>Sua conta foi aprovada! ✅</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>Ótimas notícias — sua conta de produtor na Kairos Way foi aprovada. Agora você pode criar produtos, configurar ofertas e receber pagamentos.</p>
          <a href="${data.dashboardUrl || process.env.FRONTEND_URL}" class="btn">Acessar Painel</a>
        `);

      case 'producer-rejected':
        return base(`
          <h2>Atualização sobre sua conta</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>Após análise, não foi possível aprovar sua conta no momento.</p>
          ${data.reason ? `<div class="highlight"><strong>Motivo:</strong> ${data.reason}</div>` : ''}
          <p>Se tiver dúvidas ou quiser enviar documentação adicional, entre em contato com nosso suporte.</p>
        `);

      case 'order-approved':
        return base(`
          <h2>Pagamento confirmado! 🎉</h2>
          <p>Olá, <strong>${data.customerName}</strong>!</p>
          <p>Seu pedido foi aprovado com sucesso.</p>
          <div class="highlight">
            <strong>Produto:</strong> ${data.productName}<br/>
            <strong>Valor:</strong> <span class="amount">R$ ${(data.amountCents / 100).toFixed(2).replace('.', ',')}</span><br/>
            <strong>Pedido:</strong> #${data.orderId?.slice(-8).toUpperCase()}
          </div>
          ${data.accessUrl ? `<a href="${data.accessUrl}" class="btn">Acessar Produto</a>` : ''}
        `);

      case 'order-refunded':
        return base(`
          <h2>Reembolso processado</h2>
          <p>Olá, <strong>${data.customerName}</strong>!</p>
          <p>Seu reembolso foi processado. O valor será estornado em até 5 dias úteis dependendo da sua forma de pagamento.</p>
          <div class="highlight">
            <strong>Valor reembolsado:</strong> R$ ${(data.amountCents / 100).toFixed(2).replace('.', ',')}<br/>
            <strong>Pedido:</strong> #${data.orderId?.slice(-8).toUpperCase()}
          </div>
        `);

      case 'withdrawal-paid':
        return base(`
          <h2>Saque realizado! 💰</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>Seu saque foi processado com sucesso via Pix.</p>
          <div class="highlight">
            <strong>Valor:</strong> <span class="amount">R$ ${(data.amountCents / 100).toFixed(2).replace('.', ',')}</span><br/>
            <strong>Chave Pix:</strong> ${data.pixKey}
          </div>
          <p>O valor já está disponível na sua conta.</p>
        `);

      case 'withdrawal-failed':
        return base(`
          <h2>Problema no saque</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>Não foi possível processar seu saque. O valor foi estornado para seu saldo na plataforma.</p>
          <div class="highlight">
            <strong>Valor:</strong> R$ ${(data.amountCents / 100).toFixed(2).replace('.', ',')}<br/>
            <strong>Motivo:</strong> ${data.reason || 'Erro no processamento'}
          </div>
          <p>Tente realizar um novo saque ou entre em contato com o suporte.</p>
        `);

      case 'subscription-suspended':
        return base(`
          <h2>Assinatura suspensa</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>Sua assinatura de <strong>${data.productName}</strong> foi suspensa após ${data.retryCount || 3} tentativas de cobrança sem sucesso.</p>
          <div class="highlight">
            <strong>Para reativar:</strong> atualize seu método de pagamento e entre em contato com o suporte.
          </div>
        `);

      case 'subscription-cancelled':
        return base(`
          <h2>Assinatura cancelada</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>Sua assinatura de <strong>${data.productName}</strong> foi cancelada conforme solicitado.</p>
          ${data.reason ? `<p><strong>Motivo:</strong> ${data.reason}</p>` : ''}
          <p>Esperamos vê-lo novamente em breve.</p>
        `);

      case 'mfa-enabled':
        return base(`
          <h2>Autenticação em dois fatores ativada 🔐</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>O MFA foi ativado com sucesso na sua conta. A partir de agora, você precisará de um código do autenticador para fazer login.</p>
          <div class="highlight">
            <strong>⚠️ Não foi você?</strong> Entre em contato imediatamente com o suporte.
          </div>
        `);

      case 'password-changed':
        return base(`
          <h2>Senha alterada</h2>
          <p>Olá, <strong>${data.name}</strong>!</p>
          <p>A senha da sua conta foi alterada com sucesso. Todas as sessões ativas foram encerradas.</p>
          <div class="highlight">
            <strong>⚠️ Não foi você?</strong> Entre em contato imediatamente com o suporte e altere sua senha.
          </div>
        `);

      default:
        return base(`<p>Notificação da Kairos Way.</p>`);
    }
  }
}