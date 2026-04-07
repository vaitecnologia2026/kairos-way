import IORedis from 'ioredis';
import { logger } from './logger';

export const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on('connect', () => logger.info('Redis conectado'));
redis.on('error', (err) => logger.error(err, 'Redis erro'));

export const redisConnection = {
  host: new URL(process.env.REDIS_URL || 'redis://localhost:6379').hostname,
  port: Number(new URL(process.env.REDIS_URL || 'redis://localhost:6379').port) || 6379,
};
