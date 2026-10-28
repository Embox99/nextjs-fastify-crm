import type { ConversationDto, MessageDto } from '@crm/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-provider';
import { newMutationId } from '@/lib/utils';
import { pendingMutations } from '../board/queries';

export const inboxKeys = {
  conversations: ['conversations'] as const,
  messages: (conversationId: string) => ['messages', conversationId] as const,
};

export const useConversations = () =>
  useQuery({ queryKey: inboxKeys.conversations, queryFn: () => apiFetch<ConversationDto[]>('/conversations') });

export const useMessages = (conversationId: string | null) =>
  useQuery({
    queryKey: inboxKeys.messages(conversationId ?? ''),
    queryFn: () => apiFetch<MessageDto[]>(`/conversations/${conversationId}/messages`),
    enabled: Boolean(conversationId),
  });

const byRecency = (a: ConversationDto, b: ConversationDto) => b.lastMessageAt.localeCompare(a.lastMessageAt);

export function upsertConversationInCache(qc: QueryClient, conversation: ConversationDto) {
  qc.setQueryData<ConversationDto[]>(inboxKeys.conversations, (list) =>
    list && [conversation, ...list.filter((c) => c.id !== conversation.id)].sort(byRecency));
}

/** Статус доставки только растёт: pending → sent | failed */
const deliveryStage = (m: MessageDto) => (m.deliveryStatus === 'pending' ? 0 : 1);

/**
 * Новое или обновлённое сообщение; кэш треда трогаем, только если он уже загружен.
 * Воркер может доставить (или провалить) сообщение и прислать message.updated раньше,
 * чем браузер получит HTTP-ответ на отправку, — поэтому более поздний pending не затирает итог.
 */
export function upsertMessageInCache(qc: QueryClient, message: MessageDto, replaceId?: string) {
  qc.setQueryData<MessageDto[]>(inboxKeys.messages(message.conversationId), (list) => {
    if (!list) return list;
    const existing = list.find((m) => m.id === message.id);
    const winner = existing && deliveryStage(existing) > deliveryStage(message) ? existing : message;
    const without = list.filter((m) => m.id !== message.id && m.id !== replaceId);
    return [...without, winner].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
}

/**
 * Ответ клиенту: сообщение сразу появляется в треде со статусом «отправляется» (временный id),
 * ответ сервера подменяет его настоящим, а статус доставки придёт по WebSocket (message.updated).
 */
export function useSendMessage(conversationId: string, authorId: string) {
  const qc = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: ({ body, clientMutationId }: { body: string; clientMutationId: string }) =>
      apiFetch<MessageDto>(`/conversations/${conversationId}/messages`, { method: 'POST', body: { body, clientMutationId } }),
    onMutate: ({ body, clientMutationId }) => {
      pendingMutations.add(clientMutationId);
      upsertMessageInCache(qc, {
        id: clientMutationId, conversationId, direction: 'outbound', body, authorId,
        deliveryStatus: 'pending', deliveryError: null, createdAt: new Date().toISOString(),
      });
    },
    onSuccess: (message, { clientMutationId }) => upsertMessageInCache(qc, message, clientMutationId),
    onError: (_e, { clientMutationId }) => {
      qc.setQueryData<MessageDto[]>(inboxKeys.messages(conversationId), (list) => list?.filter((m) => m.id !== clientMutationId));
      toast.error(t('inbox.sendFailed'));
    },
    // Превью и порядок в списке диалогов обновит событие conversation.upserted
    onSettled: (_d, _e, { clientMutationId }) => pendingMutations.delete(clientMutationId),
  });
}

export const sendVars = (body: string) => ({ body, clientMutationId: newMutationId() });
