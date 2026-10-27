import { z } from 'zod';

export const ChannelKind = z.enum(['website_form', 'telegram']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export interface ConversationDto {
  id: string;
  workspaceId: string;
  channelId: string;
  channelKind: ChannelKind;
  channelName: string;
  contactId: string;
  contactName: string | null;
  dealId: string | null;
  assigneeId: string | null;
  teamId: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  body: string;
  authorId: string | null;
  deliveryStatus: 'received' | 'pending' | 'sent' | 'failed';
  deliveryError: string | null;
  createdAt: string;
}

export const SendMessageInput = z.object({
  body: z.string().trim().min(1).max(4_000),
  clientMutationId: z.string().min(1).max(64).optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

/** Лид после нормализации провайдер-специфичного payload */
export const NormalizedLead = z.object({
  /** Ключ диалога у провайдера: chat.id в Telegram, email/телефон для формы */
  threadId: z.string().min(1),
  /** id сообщения у провайдера — идемпотентность вставки сообщения */
  messageId: z.string().min(1),
  name: z.string().trim().max(200).optional(),
  /** E.164 */
  phone: z.string().regex(/^\+\d{8,15}$/).optional(),
  email: z.email().optional(),
  telegramUserId: z.string().optional(),
  message: z.string().max(10_000).optional(),
  dealTitle: z.string().max(200).optional(),
});
export type NormalizedLead = z.infer<typeof NormalizedLead>;
