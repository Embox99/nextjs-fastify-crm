'use client';

import type { ConversationDto, MessageDto } from '@crm/contracts';
import { AlertCircle, ArrowLeft, Check, Clock, Globe, Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '@/components/app-shell';
import { Avatar, Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-provider';
import { cn } from '@/lib/utils';
import { sendVars, useConversations, useMessages, useSendMessage } from './queries';

function ChannelBadge({ kind }: { kind: ConversationDto['channelKind'] }) {
  const { t } = useI18n();
  return kind === 'telegram'
    ? <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">Telegram</span>
    : <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium"><Globe className="size-3" aria-hidden />{t('inbox.website')}</span>;
}

export function Inbox() {
  const conversations = useConversations();
  const { t, format } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = conversations.data?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-full">
      <aside className={cn('flex w-full flex-col border-r border-border md:w-80 md:shrink-0', selected && 'hidden md:flex')}>
        <h1 className="px-4 py-3 text-base font-semibold">{t('inbox.title')}</h1>
        {conversations.isPending && <p className="px-4 text-sm text-muted-foreground">{t('common.loading')}</p>}
        {conversations.data?.length === 0 && (
          <p className="px-4 text-sm text-muted-foreground">
            {t('inbox.empty')} <code className="text-xs">pnpm --filter @crm/api demo:lead telegram</code>
          </p>
        )}
        <ul className="flex-1 overflow-y-auto">
          {conversations.data?.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelectedId(c.id)}
                aria-current={c.id === selectedId}
                className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-muted', c.id === selectedId && 'bg-accent')}
              >
                <Avatar name={c.contactName ?? '?'} className="size-9 text-xs" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.contactName ?? t('common.noName')}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{format.when(c.lastMessageAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <ChannelBadge kind={c.channelKind} />
                    <span className="truncate text-xs text-muted-foreground">{c.lastMessagePreview ?? ''}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className={cn('min-w-0 flex-1 flex-col', selected ? 'flex' : 'hidden md:flex')}>
        {selected
          ? <Thread key={selected.id} conversation={selected} onBack={() => setSelectedId(null)} />
          : <p className="m-auto text-sm text-muted-foreground">{t('inbox.select')}</p>}
      </section>
    </div>
  );
}

function Thread({ conversation, onBack }: { conversation: ConversationDto; onBack: () => void }) {
  const session = useSession();
  const messages = useMessages(conversation.id);
  const send = useSendMessage(conversation.id, session.user.id);
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const canReply = conversation.channelKind === 'telegram';

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.data?.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    send.mutate(sendVars(body));
    setDraft('');
  }

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" className="size-8 px-0 md:hidden" onClick={onBack} aria-label={t('inbox.back')}><ArrowLeft className="size-4" /></Button>
        <Avatar name={conversation.contactName ?? '?'} className="size-8" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{conversation.contactName ?? t('common.noName')}</p>
          <p className="text-xs text-muted-foreground">{conversation.channelName}</p>
        </div>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto bg-muted/40 px-4 py-4" aria-live="polite">
        {messages.data?.map((m) => <Bubble key={m.id} message={m} />)}
        <div ref={bottom} />
      </div>

      {canReply ? (
        <form onSubmit={submit} className="flex items-end gap-2 border-t border-border p-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            placeholder={t('inbox.replyPlaceholder')}
            aria-label={t('inbox.replyAria')}
            className="min-h-10 flex-1 resize-none rounded-md border border-border bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" disabled={!draft.trim()} aria-label={t('inbox.send')}><Send className="size-4" /></Button>
        </form>
      ) : (
        <p className="border-t border-border p-3 text-sm text-muted-foreground">
          {t('inbox.websiteNoReply')}
        </p>
      )}
    </>
  );
}

function Bubble({ message }: { message: MessageDto }) {
  const { format } = useI18n();
  const outbound = message.direction === 'outbound';
  return (
    <div className={cn('flex', outbound ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-xs',
        outbound ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-card',
      )}>
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <p className={cn('mt-1 flex items-center justify-end gap-1 text-[10px]', outbound ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
          {format.time(message.createdAt)}
          {outbound && <DeliveryStatus message={message} />}
        </p>
      </div>
    </div>
  );
}

function DeliveryStatus({ message }: { message: MessageDto }) {
  const { t } = useI18n();
  switch (message.deliveryStatus) {
    case 'pending': return <Clock className="size-3" aria-label={t('inbox.sending')} />;
    case 'sent': return <Check className="size-3" aria-label={t('inbox.sent')} />;
    case 'failed': return (
      <span className="inline-flex items-center gap-0.5 font-medium text-amber-200" title={message.deliveryError ?? undefined}>
        <AlertCircle className="size-3" aria-hidden /> {t('inbox.failed')}
      </span>
    );
    default: return null;
  }
}
