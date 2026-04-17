import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { prisma } from '../utils/prisma';

/**
 * JADLOG SERVICE — Integração completa com a API Jadlog v2.3
 *
 * Endpoints:
 * - Inclusão de Pedido
 * - Cancelamento de Pedido
 * - Consulta Tracking
 * - Simulador de Frete
 *
 * Configuração via .env:
 *   JADLOG_TOKEN        — Token de autenticação (fornecido pela Jadlog)
 *   JADLOG_COD_CLIENTE  — Código do cliente na Jadlog
 *   JADLOG_CONTA        — Conta corrente Jadlog (correntista)
 *   JADLOG_MODALIDADE   — Modalidade padrão (3 = .PACKAGE rodoviário)
 *   JADLOG_CEP_ORIGEM   — CEP de origem padrão do remetente
 *   JADLOG_CNPJ         — CNPJ do tomador do serviço
 */

// ── Tipos ──────────────────────────────────────────────────────────

export interface JadlogAddress {
  nome     : string;
  cnpjCpf  : string;
  ie?      : string;
  endereco : string;
  numero   : string;
  compl?   : string;
  bairro   : string;
  cidade   : string;
  uf       : string;
  cep      : string;
  fone?    : string;
  cel?     : string;
  email?   : string;
  contato? : string;
}

export interface JadlogVolume {
  altura       : number; // cm
  comprimento  : number; // cm
  largura      : number; // cm
  peso         : number; // kg (ex: 1.2)
  identificador?: string;
}

export interface JadlogDocFiscal {
  cfop       : string;
  danfeCte   : string;
  nrDoc      : string;
  serie      : string;
  tpDocumento: number; // 0=Declaração, 1=NF, 2=NFE, 4=CTE, 5=DCE
  valor      : number;
}

export interface JadlogIncluirPedidoInput {
  pedido       : string[];    // número(s) de pedido do cliente
  conteudo     : string;      // descrição do conteúdo
  totPeso      : number;      // peso total em kg
  totValor     : number;      // valor total declarado
  obs?         : string;
  rem          : JadlogAddress;
  des          : JadlogAddress;
  volume       : JadlogVolume[];
  dfe?         : JadlogDocFiscal[];
  modalidade?  : number;
  tpColeta?    : string;      // K=solicitação eletrônica, S=coleta física
  tipoFrete?   : number;      // 0=Normal, 1=Subcontratação, 2=Redespacho, 3=Intermediário
  cdPickupDes? : string;
  nrContrato?  : number;
  servico?     : number;      // 0=sem PIN, 1=com PIN, 2=Dropoff, 3=Dropoff/Pudoc
}

export interface JadlogIncluirPedidoResponse {
  codigo?    : string;
  shipmentId?: string;
  status     : string;
  erro?      : { id: number; descricao: string; detalhe?: string };
  etiqueta?  : {
    arquivo?: string; // PDF base64
    volume? : Array<{
      seqVolume      : number;
      codbarra       : string;
      lastMile       : string;
      rua            : string;
      posicao        : string;
      prioridade     : number;
      rota           : string;
      unidadeDestino : string;
    }>;
  };
}

export interface JadlogTrackingEvento {
  data   : string;
  status : string;
  unidade: string;
}

export interface JadlogTrackingResponse {
  consulta: Array<{
    codigo?: string;
    tracking?: {
      codigo     : string;
      shipmentId : string;
      dacte?     : string;
      dtEmissao  : string;
      status     : string;
      valor      : number;
      peso       : number;
      eventos    : JadlogTrackingEvento[];
      volumes    : Array<{ peso: number; altura: number; largura: number; comprimento: number }>;
    };
    previsaoEntrega?: string;
    erro?: { id: number; descricao: string; detalhe?: string };
  }>;
}

export interface JadlogFreteInput {
  cepori      : string;
  cepdes      : string;
  peso        : number; // kg — maior entre peso real e peso cubado
  vldeclarado : number;
  modalidade? : number;
  tpentrega?  : string; // D=Domicílio, R=Retira
}

export interface JadlogFreteResponse {
  frete: Array<{
    cepori     : string;
    cepdes     : string;
    modalidade : number;
    peso       : number;
    prazo?     : number;
    vldeclarado: number;
    vltotal?   : number;
    erro?      : { id: number; descricao: string };
  }>;
  error?: { id: number; descricao: string };
}

// ── Modalidades ────────────────────────────────────────────────────

export const JADLOG_MODALIDADES: Record<number, { nome: string; modal: string }> = {
  0 : { nome: 'EXPRESSO',      modal: 'Aéreo' },
  3 : { nome: '.PACKAGE',      modal: 'Rodoviário' },
  4 : { nome: 'RODOVIÁRIO',    modal: 'Rodoviário' },
  5 : { nome: 'ECONÔMICO',     modal: 'Rodoviário' },
  6 : { nome: 'DOC',           modal: 'Rodoviário' },
  7 : { nome: 'CORPORATE',     modal: 'Aéreo' },
  9 : { nome: '.COM',          modal: 'Aéreo' },
  12: { nome: 'CARGO',         modal: 'Aéreo' },
  14: { nome: 'EMERGÊNCIAL',   modal: 'Rodoviário' },
  40: { nome: 'PICKUP',        modal: 'Aéreo' },
};

// ── Service ────────────────────────────────────────────────────────

export class JadlogService {
  private _config: any = null;
  private _configLoadedAt = 0;

  /**
   * Carrega config da tabela PlatformConfig (key='jadlog') com cache de 60s,
   * com fallback ao .env para compatibilidade.
   */
  private async getConfig(): Promise<{
    token: string; codCliente: string; conta: string;
    modalidade: number; cnpj: string; cepOrigem: string;
    remNome: string; remEndereco: string; remNumero: string;
    remBairro: string; remCidade: string; remUf: string;
    remEmail: string; remFone: string;
  }> {
    // Cache de 60s para não bater no banco a cada chamada
    if (this._config && Date.now() - this._configLoadedAt < 60_000) return this._config;

    try {
      const row = await prisma.platformConfig.findUnique({ where: { key: 'jadlog' } });
      if (row?.value && typeof row.value === 'object') {
        this._config = row.value;
        this._configLoadedAt = Date.now();
        return this._config;
      }
    } catch { /* fallback to env */ }

    // Fallback: ler do .env
    this._config = {
      token      : process.env.JADLOG_TOKEN         || '',
      codCliente : process.env.JADLOG_COD_CLIENTE   || '',
      conta      : process.env.JADLOG_CONTA         || '',
      modalidade : Number(process.env.JADLOG_MODALIDADE) || 3,
      cnpj       : process.env.JADLOG_CNPJ          || '',
      cepOrigem  : process.env.JADLOG_CEP_ORIGEM    || '',
      remNome    : process.env.JADLOG_REMETENTE_NOME || '',
      remEndereco: process.env.JADLOG_REMETENTE_ENDERECO || '',
      remNumero  : process.env.JADLOG_REMETENTE_NUMERO || '',
      remBairro  : process.env.JADLOG_REMETENTE_BAIRRO || '',
      remCidade  : process.env.JADLOG_REMETENTE_CIDADE || '',
      remUf      : process.env.JADLOG_REMETENTE_UF || '',
      remEmail   : process.env.JADLOG_REMETENTE_EMAIL || '',
      remFone    : process.env.JADLOG_REMETENTE_FONE || '',
    };
    this._configLoadedAt = Date.now();
    return this._config;
  }

  private createApi(token: string): AxiosInstance {
    return axios.create({
      baseURL: 'https://www.jadlog.com.br/embarcador/api',
      headers: { 'Content-Type': 'application/json', 'Authorization': token },
      timeout: 30_000,
    });
  }

  private createTrackingApi(token: string): AxiosInstance {
    return axios.create({
      baseURL: 'https://prd-traffic.jadlogtech.com.br/embarcador/api',
      headers: { 'Content-Type': 'application/json', 'Authorization': token },
      timeout: 15_000,
    });
  }

  /** Verifica se a integração está configurada */
  async isConfigured(): Promise<boolean> {
    const c = await this.getConfig();
    return !!(c.token && c.codCliente && c.cnpj && c.cepOrigem);
  }

  // ── INCLUSÃO DE PEDIDO ─────────────────────────────────────────

  async incluirPedido(input: JadlogIncluirPedidoInput): Promise<JadlogIncluirPedidoResponse> {
    const c   = await this.getConfig();
    const api = this.createApi(c.token);

    const payload = {
      codCliente    : c.codCliente,
      conteudo      : input.conteudo,
      pedido        : input.pedido,
      totPeso       : input.totPeso,
      totValor      : input.totValor,
      obs           : input.obs || '',
      modalidade    : input.modalidade ?? c.modalidade,
      contaCorrente : c.conta || undefined,
      tpColeta      : input.tpColeta || 'K',
      tipoFrete     : input.tipoFrete ?? 0,
      cdPickupDes   : input.cdPickupDes || undefined,
      nrContrato    : input.nrContrato || undefined,
      servico       : input.servico ?? 0,
      rem           : input.rem,
      tomador       : input.rem, // tomador = remetente (padrão)
      des           : input.des,
      dfe           : input.dfe || [{
        cfop       : '0',
        danfeCte   : '',
        nrDoc      : input.pedido[0] || '',
        serie      : '0',
        tpDocumento: 0, // Declaração
        valor      : input.totValor,
      }],
      volume: input.volume,
    };

    try {
      const { data } = await api.post<JadlogIncluirPedidoResponse>('/pedido/incluir', payload);

      if (data.erro) {
        logger.error({ erro: data.erro, pedido: input.pedido }, 'Jadlog: erro ao incluir pedido');
        return data;
      }

      logger.info(
        { codigo: data.codigo, shipmentId: data.shipmentId, pedido: input.pedido },
        'Jadlog: pedido incluído com sucesso'
      );
      return data;
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message, pedido: input.pedido }, 'Jadlog: falha na chamada de inclusão');
      throw err;
    }
  }

  // ── CANCELAMENTO DE PEDIDO ─────────────────────────────────────

  async cancelarPedido(params: { codigo?: string; shipmentId?: string }): Promise<{ status: string; erro?: any }> {
    const c   = await this.getConfig();
    const api = this.createApi(c.token);
    try {
      const { data } = await api.post('/pedido/cancelar', params);
      logger.info(params, 'Jadlog: pedido cancelado');
      return data;
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message, ...params }, 'Jadlog: falha ao cancelar pedido');
      throw err;
    }
  }

  // ── CONSULTA DE TRACKING ───────────────────────────────────────

  async consultarTracking(params: {
    codigo?    : string;
    shipmentId?: string;
    pedido?    : string;
  }): Promise<JadlogTrackingResponse> {
    const consulta: any = {};
    if (params.codigo)     consulta.codigo     = params.codigo;
    if (params.shipmentId) consulta.shipmentId = params.shipmentId;
    if (params.pedido)     consulta.pedido     = params.pedido;

    const c          = await this.getConfig();
    const trackApi   = this.createTrackingApi(c.token);
    try {
      const { data } = await trackApi.post<JadlogTrackingResponse>(
        '/tracking/consultar',
        { consulta: [consulta] }
      );

      logger.info(params, 'Jadlog: tracking consultado');
      return data;
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message, ...params }, 'Jadlog: falha ao consultar tracking');
      throw err;
    }
  }

  /** Consulta simplificada — retorna apenas último status (até 500 consultas) */
  async consultarTrackingSimples(params: {
    codigo?    : string;
    shipmentId?: string;
    pedido?    : string;
  }): Promise<JadlogTrackingResponse> {
    const consulta: any = {};
    if (params.codigo)     consulta.codigo     = params.codigo;
    if (params.shipmentId) consulta.shipmentId = params.shipmentId;
    if (params.pedido)     consulta.pedido     = params.pedido;

    const c        = await this.getConfig();
    const trackApi = this.createTrackingApi(c.token);
    try {
      const { data } = await trackApi.post<JadlogTrackingResponse>(
        '/tracking/simples/consultar',
        { consulta: [consulta] }
      );
      return data;
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message }, 'Jadlog: falha no tracking simples');
      throw err;
    }
  }

  // ── SIMULADOR DE FRETE ─────────────────────────────────────────

  async simularFrete(input: JadlogFreteInput): Promise<JadlogFreteResponse> {
    const c   = await this.getConfig();
    const api = this.createApi(c.token);

    const payload = {
      frete: [{
        cepori     : input.cepori || c.cepOrigem,
        cepdes     : input.cepdes.replace(/\D/g, ''),
        frap       : 'N',
        peso       : input.peso,
        cnpj       : c.cnpj,
        conta      : c.conta || '',
        contrato   : null,
        modalidade : input.modalidade ?? c.modalidade,
        tpentrega  : input.tpentrega || 'D',
        tpseguro   : 'N',
        vldeclarado: input.vldeclarado,
        vlcoleta   : 0,
      }],
    };

    try {
      const { data } = await api.post<JadlogFreteResponse>('/frete/valor', payload);

      if (data.error) {
        logger.warn({ erro: data.error, cepdes: input.cepdes }, 'Jadlog: erro na simulação de frete');
        return data;
      }

      const item = data.frete?.[0];
      logger.info(
        { cepdes: input.cepdes, valor: item?.vltotal, prazo: item?.prazo },
        'Jadlog: frete simulado'
      );
      return data;
    } catch (err: any) {
      logger.error({ err: err?.response?.data || err.message, cepdes: input.cepdes }, 'Jadlog: falha na simulação de frete');
      throw err;
    }
  }

  /** Simula frete em múltiplas modalidades para dar opções ao cliente */
  async simularFreteMultiplo(cepdes: string, pesoKg: number, valorDeclarado: number): Promise<Array<{
    modalidade : number;
    nome       : string;
    modal      : string;
    valor      : number;
    prazo      : number;
  }>> {
    const modalidades = [3, 5, 0]; // .PACKAGE, ECONÔMICO, EXPRESSO
    const resultados: any[] = [];

    for (const mod of modalidades) {
      try {
        const res = await this.simularFrete({
          cepori     : '',
          cepdes,
          peso       : pesoKg,
          vldeclarado: valorDeclarado,
          modalidade : mod,
        });

        const item = res.frete?.[0];
        if (item?.vltotal && !item.erro) {
          const info = JADLOG_MODALIDADES[mod] || { nome: `Modalidade ${mod}`, modal: 'N/D' };
          resultados.push({
            modalidade: mod,
            nome      : `Jadlog ${info.nome}`,
            modal     : info.modal,
            valor     : item.vltotal,
            prazo     : item.prazo || 0,
          });
        }
      } catch {
        // Ignora modalidade indisponível
      }
    }

    return resultados.sort((a, b) => a.valor - b.valor);
  }

  // ── HELPERS ────────────────────────────────────────────────────

  /** Mapeia status do tracking Jadlog para ShipStatus do Prisma */
  mapStatusToPrisma(jadlogStatus: string): 'WAITING' | 'DISPATCHED' | 'IN_TRANSIT' | 'DELIVERED' | 'RETURNED' {
    const s = jadlogStatus.toUpperCase().trim();

    if (s === 'ENTREGUE' || s === 'ENTREGA REALIZADA')       return 'DELIVERED';
    if (s === 'DEVOLVIDO' || s.includes('DEVOLU'))            return 'RETURNED';
    if (s.includes('TRANSITO') || s.includes('TRANSFERENCIA') || s.includes('ENTRADA'))
      return 'IN_TRANSIT';
    if (s === 'EMISSAO' || s === 'COLETA SOLICITADA' || s.includes('COLETA'))
      return 'DISPATCHED';

    return 'DISPATCHED';
  }
}

// Singleton
export const jadlogService = new JadlogService();
