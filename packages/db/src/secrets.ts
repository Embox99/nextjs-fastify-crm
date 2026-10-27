import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Шифрование секретов каналов (AES-256-GCM). Ключ живёт в окружении (SECRETS_KEY), не в БД:
 * дамп базы без ключа не раскрывает HMAC-ключи и токены ботов.
 * Формат: v1:<iv>:<tag>:<ciphertext> в base64 — префикс версии оставляет место для ротации ключа.
 */
export function createSecretBox(keyBase64: string) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded');

  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join(':');
    },

    open(sealed: string): string {
      const [version, iv, tag, data] = sealed.split(':');
      if (version !== VERSION || !iv || !tag || !data) throw new Error('Unsupported secret format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;
