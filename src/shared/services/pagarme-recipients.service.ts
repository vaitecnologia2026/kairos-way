import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

export type RecipientType = 'individual' | 'corporation';

export interface BankAccountInput {
  holderName    : string;
  holderType    : RecipientType;
  holderDocument: string;           // só dígitos (11 CPF ou 14 CNPJ)
  bank          : string;           // código numérico do banco, ex "077"
  branchNumber  : string;
  branchCheckDigit?: string;
  accountNumber : string;
  accountCheckDigit: string;
  type          : 'checking' | 'savings';
}

export interface RegisterInformationIndividual {
  type         : 'individual';
  name         : string;
  email        : string;
  document     : string;
  birthdate    : string;            // DD/MM/YYYY
  monthlyIncome: number;            // cents
  professionalOccupation: string;
  motherName?  : string;
  phoneNumbers : { ddd: string; number: string; type: 'mobile' | 'home' }[];
  address      : RecipientAddress;
}

export interface RegisterInformationCorporation {
  type              : 'corporation';
  companyName       : string;
  tradingName?      : string;
  email             : string;
  document          : string;       // CNPJ
  siteUrl?          : string;
  annualRevenue     : number;       // cents
  corporationType   : 'EIRELI' | 'LTDA' | 'MEI' | 'SA';
  foundingDate      : string;       // DD/MM/YYYY
  phoneNumbers      : { ddd: string; number: string; type: 'mobile' | 'home' }[];
  address           : RecipientAddress;
  mainAddress       : RecipientAddress;
  managingPartners  : ({
    type        : 'individual';
    name        : string;
    email       : string;
    document    : string;
    motherName? : string;
    birthdate   : string;
    monthlyIncome: number;
    professionalOccupation: string;
    selfDeclaredLegalRepresentative: boolean;
    phoneNumbers: { ddd: string; number: string; type: 'mobile' | 'home' }[];
    address     : RecipientAddress;
  })[];
}

export interface RecipientAddress {
  street       : string;
  complementary?: string;
  streetNumber : string;
  neighborhood : string;
  city         : string;
  state        : string;            // UF 2 letras
  zipCode      : string;             // só dígitos 8
  referencePoint?: string;
}

export interface CreateRecipientInput {
  name             : string;         // nome que aparece no dashboard
  email            : string;
  description?     : string;
  document         : string;
  type             : RecipientType;
  code?            : string;         // ID interno para reconciliação (Producer.id)
  defaultBankAccount: BankAccountInput;
  registerInformation: RegisterInformationIndividual | RegisterInformationCorporation;
  transferSettings?: {
    transferEnabled?  : boolean;
    transferInterval? : 'daily' | 'weekly' | 'monthly';
    transferDay?      : number;
  };
  automaticAnticipationSettings?: {
    enabled         : boolean;
    type?           : 'full' | '1025';
    volumePercentage?: number;
    delay?          : number;
  };
  metadata?        : Record<string, any>;
}

export interface PagarmeRecipient {
  id                : string;        // re_xxx
  name              : string;
  email             : string;
  document          : string;
  status            : string;
  type              : string;
  default_bank_account: { id: string; [k: string]: any };
  created_at        : string;
  updated_at        : string;
  [k: string]       : any;
}

/**
 * Cliente para a API /recipients do Pagar.me V5.
 * Fica isolado do PagarmeAdapter (que cuida só de transações) para facilitar teste.
 */
export class PagarmeRecipientsService {
  private readonly api: AxiosInstance;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.PAGARME_API_KEY;
    if (!key) throw new Error('PAGARME_API_KEY ausente');

    this.api = axios.create({
      baseURL: 'https://api.pagar.me/core/v5',
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
  }

  async createRecipient(input: CreateRecipientInput): Promise<PagarmeRecipient> {
    const payload = this.buildPayload(input);
    try {
      const { data } = await this.api.post<PagarmeRecipient>('/recipients', payload);
      logger.info({ recipientId: data.id, code: input.code }, 'Pagar.me: recebedor criado');
      return data;
    } catch (err: any) {
      logger.error(
        { pagarme: err?.response?.data, code: input.code },
        'Pagar.me: falha ao criar recebedor',
      );
      throw err;
    }
  }

  async getRecipient(recipientId: string): Promise<PagarmeRecipient> {
    const { data } = await this.api.get<PagarmeRecipient>(`/recipients/${recipientId}`);
    return data;
  }

  private buildPayload(input: CreateRecipientInput): Record<string, any> {
    const reg = input.registerInformation;

    const registerInformation = reg.type === 'individual'
      ? {
          type                  : 'individual',
          email                 : reg.email,
          document              : reg.document,
          name                  : reg.name,
          site_url              : undefined,
          birthdate             : reg.birthdate,
          monthly_income        : reg.monthlyIncome,
          professional_occupation: reg.professionalOccupation,
          mother_name           : reg.motherName,
          phone_numbers         : reg.phoneNumbers,
          address               : this.snakeCaseAddress(reg.address),
        }
      : {
          type             : 'corporation',
          email            : reg.email,
          document          : reg.document,
          company_name      : reg.companyName,
          trading_name      : reg.tradingName,
          site_url          : reg.siteUrl,
          annual_revenue    : reg.annualRevenue,
          corporation_type  : reg.corporationType,
          founding_date     : reg.foundingDate,
          phone_numbers     : reg.phoneNumbers,
          address           : this.snakeCaseAddress(reg.address),
          main_address      : this.snakeCaseAddress(reg.mainAddress),
          managing_partners : reg.managingPartners.map(p => ({
            type                  : 'individual',
            email                 : p.email,
            document              : p.document,
            name                  : p.name,
            mother_name           : p.motherName,
            birthdate             : p.birthdate,
            monthly_income        : p.monthlyIncome,
            professional_occupation: p.professionalOccupation,
            self_declared_legal_representative: p.selfDeclaredLegalRepresentative,
            phone_numbers         : p.phoneNumbers,
            address               : this.snakeCaseAddress(p.address),
          })),
        };

    return {
      register_information: registerInformation,
      default_bank_account: {
        holder_name       : input.defaultBankAccount.holderName,
        holder_type       : input.defaultBankAccount.holderType,
        holder_document   : input.defaultBankAccount.holderDocument,
        bank              : input.defaultBankAccount.bank,
        branch_number     : input.defaultBankAccount.branchNumber,
        branch_check_digit: input.defaultBankAccount.branchCheckDigit,
        account_number    : input.defaultBankAccount.accountNumber,
        account_check_digit: input.defaultBankAccount.accountCheckDigit,
        type              : input.defaultBankAccount.type,
      },
      transfer_settings: input.transferSettings
        ? {
            transfer_enabled : input.transferSettings.transferEnabled,
            transfer_interval: input.transferSettings.transferInterval,
            transfer_day     : input.transferSettings.transferDay,
          }
        : undefined,
      automatic_anticipation_settings: input.automaticAnticipationSettings
        ? {
            enabled           : input.automaticAnticipationSettings.enabled,
            type              : input.automaticAnticipationSettings.type,
            volume_percentage : input.automaticAnticipationSettings.volumePercentage,
            delay             : input.automaticAnticipationSettings.delay,
          }
        : { enabled: false },
      code    : input.code,
      metadata: input.metadata,
    };
  }

  private snakeCaseAddress(addr: RecipientAddress) {
    return {
      street         : addr.street,
      complementary  : addr.complementary || 'N/A',
      street_number  : addr.streetNumber,
      neighborhood   : addr.neighborhood,
      city           : addr.city,
      state          : addr.state,
      zip_code       : addr.zipCode,
      reference_point: addr.referencePoint || 'N/A',
    };
  }
}

export const pagarmeRecipients = new PagarmeRecipientsService();
