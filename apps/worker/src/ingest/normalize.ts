import { NormalizedLead, type ChannelKind } from '@crm/contracts';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

/** Payload нельзя обработать никогда — ретраи бессмысленны, событие помечается failed */
export class NormalizationError extends Error {}

/** Событие валидно, но лида не несёт (например, edited_message в Telegram) — помечается processed */
export class IgnoredEventError extends Error {}

const DEFAULT_REGION: CountryCode = 'RU';

/** Телефон в E.164; невалидный номер не превращается в идентификатор (иначе склеил бы чужих людей) */
export function normalizePhone(input: string | undefined, region: CountryCode = DEFAULT_REGION): string | undefined {
  if (!input) return undefined;
  const parsed = parsePhoneNumberFromString(input, region);
  return parsed?.isValid() ? parsed.number : undefined;
}

const WebsiteForm = z.object({
  name: z.string().trim().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().trim().max(320).optional(),
  message: z.string().max(10_000).optional(),
  title: z.string().trim().max(200).optional(),
});

const TelegramUpdate = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number(),
    from: z.object({
      id: z.number(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      username: z.string().optional(),
    }),
    chat: z.object({ id: z.number() }),
    text: z.string().optional(),
    contact: z.object({ phone_number: z.string() }).optional(),
  }).optional(),
});

/** Провайдер-специфичный payload → единый лид. externalId события — id сообщения для формы сайта. */
export function normalize(kind: ChannelKind, payload: unknown, externalId: string): NormalizedLead {
  return kind === 'telegram' ? normalizeTelegram(payload) : normalizeWebsiteForm(payload, externalId);
}

function normalizeWebsiteForm(payload: unknown, externalId: string): NormalizedLead {
  const parsed = WebsiteForm.safeParse(payload);
  if (!parsed.success) throw new NormalizationError(`Invalid website form payload: ${parsed.error.message}`);
  const form = parsed.data;

  const phone = normalizePhone(form.phone);
  const email = z.email().safeParse(form.email?.toLowerCase()).data;
  if (!phone && !email) throw new NormalizationError('Website form lead has neither a valid phone nor email');

  return NormalizedLead.parse({
    threadId: email ?? phone,
    messageId: externalId,
    name: form.name || undefined,
    phone,
    email,
    message: form.message || undefined,
    dealTitle: form.title || undefined,
  });
}

function normalizeTelegram(payload: unknown): NormalizedLead {
  const parsed = TelegramUpdate.safeParse(payload);
  if (!parsed.success) throw new NormalizationError(`Invalid Telegram update: ${parsed.error.message}`);
  const message = parsed.data.message;
  if (!message) throw new IgnoredEventError('Telegram update without a new message');

  const { from } = message;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username;
  const phone = normalizePhone(message.contact?.phone_number);

  return NormalizedLead.parse({
    threadId: String(message.chat.id),
    messageId: String(message.message_id),
    name,
    phone,
    telegramUserId: String(from.id),
    message: message.text ?? (message.contact ? 'Поделился контактом' : undefined),
  });
}
