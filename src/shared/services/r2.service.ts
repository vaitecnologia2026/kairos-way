import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../utils/logger';
import { randomBytes } from 'crypto';
import { extname } from 'path';

/**
 * R2UploadService — Cloudflare R2 (S3-compatible)
 *
 * Variáveis de ambiente necessárias:
 * - R2_ACCOUNT_ID       → b43a83793b6c478328ccfaaf643caca8
 * - R2_ACCESS_KEY_ID    → af51a281d8c2da626afd72ac5feec707
 * - R2_SECRET_ACCESS_KEY → 0f4a0e668631ce0e53490b71fef40806af4852645a4bb57d70e772dc4d7e1f5b
 * - R2_BUCKET           → kairos-way
 * - R2_PUBLIC_URL       → URL pública do bucket (após habilitar acesso público)
 */

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE_MB   = 10;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

export class R2UploadService {
  private client: S3Client;
  private bucket : string;
  private publicUrl: string;

  constructor() {
    const accountId      = process.env.R2_ACCOUNT_ID!;
    const accessKeyId    = process.env.R2_ACCESS_KEY_ID!;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;

    this.bucket    = process.env.R2_BUCKET    || 'kairos-way';
    this.publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

    this.client = new S3Client({
      region  : 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /**
   * Faz upload de um buffer direto para o R2
   * Retorna a URL pública do arquivo
   */
  async upload(params: {
    buffer     : Buffer;
    mimeType   : string;
    originalName: string;
    folder     : string; // ex: 'products', 'offers'
  }): Promise<{ url: string; key: string }> {
    // Validação
    if (!ALLOWED_TYPES.includes(params.mimeType)) {
      throw new Error(`Tipo de arquivo não permitido. Use: ${ALLOWED_TYPES.join(', ')}`);
    }
    if (params.buffer.length > MAX_SIZE_BYTES) {
      throw new Error(`Arquivo muito grande. Máximo: ${MAX_SIZE_MB}MB`);
    }

    const ext = extname(params.originalName) || this.mimeToExt(params.mimeType);
    const key = `${params.folder}/${randomBytes(16).toString('hex')}${ext}`;

    await this.client.send(new PutObjectCommand({
      Bucket     : this.bucket,
      Key        : key,
      Body       : params.buffer,
      ContentType: params.mimeType,
      CacheControl: 'public, max-age=31536000', // 1 ano
    }));

    const url = `${this.publicUrl}/${key}`;
    logger.info({ key, url }, 'R2: arquivo enviado');
    return { url, key };
  }

  /**
   * Gera URL pré-assinada para upload direto do frontend (sem passar pelo backend)
   * Útil para arquivos grandes
   */
  async getPresignedUrl(params: {
    key     : string;
    mimeType: string;
    expiresIn?: number; // segundos — padrão 300 (5min)
  }): Promise<string> {
    const command = new PutObjectCommand({
      Bucket     : this.bucket,
      Key        : params.key,
      ContentType: params.mimeType,
    });

    return getSignedUrl(this.client, command, {
      expiresIn: params.expiresIn || 300,
    });
  }

  /**
   * Deleta um arquivo do R2 pela key ou URL pública
   */
  async delete(keyOrUrl: string): Promise<void> {
    const key = keyOrUrl.startsWith('http')
      ? keyOrUrl.replace(`${this.publicUrl}/`, '')
      : keyOrUrl;

    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key   : key,
    }));

    logger.info({ key }, 'R2: arquivo deletado');
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png' : '.png',
      'image/webp': '.webp',
      'image/gif' : '.gif',
    };
    return map[mime] || '.jpg';
  }
}

export const r2 = new R2UploadService();