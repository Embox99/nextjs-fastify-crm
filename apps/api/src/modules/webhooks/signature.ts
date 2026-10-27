import { createHmac, timingSafeEqual } from 'node:crypto';

/** Допустимый разброс времени подписи: защита от повторной отправки перехваченного запроса */
export const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Заголовок `X-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`, подпись = HMAC-SHA256(secret, `${t}.${rawBody}`).
 * Считается от сырых байтов тела, а не от JSON.parse → stringify (пробелы и порядок ключей меняют подпись).
 * Несколько секретов — ротация: старый ключ принимается, пока все отправители не перейдут на новый.
 */
export function verifyHmacSignature(raw: Buffer, header: string | undefined, secrets: string[], now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string | undefined]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k, v]) => k === 'v1' && v && /^[0-9a-f]{64}$/i.test(v)).map(([, v]) => Buffer.from(v!, 'hex'));
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_SEC || signatures.length === 0) return false;

  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
    return signatures.some((s) => timingSafeEqual(s, expected));
  });
}

export function signPayload(raw: string | Buffer, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return `t=${t},v1=${sig}`;
}

/** Telegram не подписывает тело, а присылает заданный при setWebhook secret_token в заголовке */
export function verifySecretToken(header: string | undefined, secrets: string[]): boolean {
  if (!header) return false;
  const received = Buffer.from(header);
  return secrets.some((secret) => {
    const expected = Buffer.from(secret);
    return expected.length === received.length && timingSafeEqual(expected, received);
  });
}
