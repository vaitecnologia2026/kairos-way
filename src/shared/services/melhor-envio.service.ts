import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

/**
 * Melhor Envio — Cotação, etiquetas e tracking
 * Docs: https://docs.melhorenvio.com.br/
 *
 * Cada usuário informa seu próprio access token (OAuth2 bearer).
 * As credenciais ficam em UserIntegration.config.
 */

export interface MelhorEnvioConfig {
  accessToken : string;
  sandbox?    : boolean;  // se true, usa ambiente de homologação
  userAgent?  : string;   // ex: 'Kairos Way (contato@kairosway.com.br)'
  fromCep?    : string;   // CEP de origem padrão do remetente
}

export interface MelhorEnvioQuoteInput {
  fromCep     : string;
  toCep       : string;
  weightKg    : number;   // ≥ 0.1
  valueCents  : number;
  heightCm?   : number;
  widthCm?    : number;
  lengthCm?   : number;
}

export interface MelhorEnvioQuoteOption {
  id           : number;
  name         : string;  // "PAC", "SEDEX", ".Package" etc.
  company      : string;  // "Correios", "Jadlog", "Azul Cargo", etc.
  priceCents   : number;
  deliveryDays : number;
  error?       : string;
}

export class MelhorEnvioService {
  private readonly api : AxiosInstance;
  private readonly cfg : MelhorEnvioConfig;

  constructor(config: MelhorEnvioConfig) {
    this.cfg = config;
    const baseURL = config.sandbox
      ? 'https://sandbox.melhorenvio.com.br'
      : 'https://melhorenvio.com.br';
    this.api = axios.create({
      baseURL,
      headers: {
        'Accept'       : 'application/json',
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${config.accessToken}`,
        'User-Agent'   : config.userAgent || 'Kairos Way',
      },
      timeout: 30_000,
    });
  }

  /** Verifica credenciais buscando o perfil do usuário Melhor Envio. */
  async testConnection(): Promise<{ ok: true; user: any } | { ok: false; error: string }> {
    try {
      const { data } = await this.api.get('/api/v2/me');
      return { ok: true, user: data };
    } catch (err: any) {
      logger.warn({ err: err?.response?.data || err.message }, 'MelhorEnvio: testConnection falhou');
      return {
        ok   : false,
        error: err?.response?.data?.message || err?.response?.data?.error || 'Credenciais inválidas',
      };
    }
  }

  /** Calcula fretes disponíveis para um pacote. */
  async quote(input: MelhorEnvioQuoteInput): Promise<MelhorEnvioQuoteOption[]> {
    const payload = {
      from   : { postal_code: input.fromCep.replace(/\D/g, '') },
      to     : { postal_code: input.toCep  .replace(/\D/g, '') },
      package: {
        height: input.heightCm ?? 10,
        width : input.widthCm  ?? 15,
        length: input.lengthCm ?? 20,
        weight: Math.max(0.1, input.weightKg),
      },
      options: {
        insurance_value : input.valueCents / 100,
        receipt         : false,
        own_hand        : false,
      },
    };

    try {
      const { data } = await this.api.post('/api/v2/me/shipment/calculate', payload);
      return (Array.isArray(data) ? data : []).map((d: any) => ({
        id          : d.id,
        name        : d.name,
        company     : d.company?.name || 'Transportadora',
        priceCents  : Math.round(Number(d.price || d.custom_price || 0) * 100),
        deliveryDays: Number(d.delivery_time || d.custom_delivery_time || 0),
        error       : d.error,
      }));
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message }, 'MelhorEnvio: falha na cotação');
      throw err;
    }
  }

  /** Adiciona um envio ao carrinho Melhor Envio. Retorna o id da etiqueta. */
  async createShipment(payload: Record<string, any>): Promise<{ id: string; [k: string]: any }> {
    try {
      const { data } = await this.api.post('/api/v2/me/cart', payload);
      logger.info({ id: data.id }, 'MelhorEnvio: envio criado no carrinho');
      return data;
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message }, 'MelhorEnvio: falha ao criar envio');
      throw err;
    }
  }

  /** Consulta status/tracking de um ou mais envios. */
  async tracking(orderIds: string[]): Promise<Record<string, any>> {
    try {
      const { data } = await this.api.post('/api/v2/me/shipment/tracking', { orders: orderIds });
      return data;
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message }, 'MelhorEnvio: falha no tracking');
      throw err;
    }
  }
}

/** Helper para instanciar a partir da config salva em UserIntegration. */
export function buildMelhorEnvio(config: any): MelhorEnvioService | null {
  if (!config?.accessToken) return null;
  return new MelhorEnvioService({
    accessToken: config.accessToken,
    sandbox    : !!config.sandbox,
    userAgent  : config.userAgent,
    fromCep    : config.fromCep,
  });
}
