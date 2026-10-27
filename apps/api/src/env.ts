import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** 32 байта в base64: ключ шифрования секретов каналов */
  SECRETS_KEY: z.string().min(40),
  CORS_ORIGIN: z.string().default('http://localhost:3000').transform((v) => v.split(',').map((s) => s.trim())),
});

export type Env = z.infer<typeof Env>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
