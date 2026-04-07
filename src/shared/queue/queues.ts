import { Queue } from 'bullmq';
import { redisConnection } from '../utils/redis';

// Instâncias de Queue centralizadas — sem imports de services
// Importado tanto por workers.ts quanto por enqueue.ts
export const webhookQueue   = new Queue('webhooks',  { connection: redisConnection });
export const dunningQueue   = new Queue('dunning',   { connection: redisConnection });
export const repasesQueue   = new Queue('repasses',  { connection: redisConnection });
export const emailQueue     = new Queue('emails',    { connection: redisConnection });
export const nfeQueue       = new Queue('nfe',       { connection: redisConnection });
export const logisticsQueue = new Queue('logistics', { connection: redisConnection });