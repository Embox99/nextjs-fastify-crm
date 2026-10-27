'use client';

import type { BoardDto, ClientToServerEvents, LockHolder, ServerToClientEvents } from '@crm/contracts';
import { applyDealRemoval } from '@crm/domain';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from '@/lib/api';
import type { Session } from '@/lib/session';
import { boardKeys, pendingMutations, upsertDealInCache } from '../board/queries';
import { inboxKeys, upsertConversationInCache, upsertMessageInCache } from '../inbox/queries';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Мягкие блокировки по всем сделкам workspace. Истёкшие (реплика упала без release) не показываются. */
function createLockStore() {
  let locks = new Map<string, LockHolder>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => locks,
    set(dealId: string, holder: LockHolder | null) {
      const next = new Map(locks);
      if (holder) next.set(dealId, holder);
      else next.delete(dealId);
      locks = next;
      notify();
    },
    pruneExpired(now = Date.now()) {
      const live = [...locks].filter(([, h]) => h.expiresAt > now);
      if (live.length !== locks.size) {
        locks = new Map(live);
        notify();
      }
    },
  };
}

type LockStore = ReturnType<typeof createLockStore>;

const RealtimeContext = createContext<{ socket: AppSocket | null; locks: LockStore } | null>(null);

export function RealtimeProvider({ session, children }: { session: Session; children: ReactNode }) {
  const qc = useQueryClient();
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [locks] = useState(createLockStore);

  useEffect(() => {
    const s: AppSocket = io(API_URL, {
      transports: ['websocket'],
      auth: { token: session.token, workspaceId: session.workspaceId },
    });
    let connectedBefore = false;

    s.on('connect', () => {
      // Pub/Sub не гарантирует доставку: всё, что пропущено за время разрыва, добираем рефетчем
      if (connectedBefore) {
        void qc.invalidateQueries({ queryKey: boardKeys.all });
        void qc.invalidateQueries({ queryKey: inboxKeys.conversations });
        void qc.invalidateQueries({ queryKey: ['messages'] });
      }
      connectedBefore = true;
    });
    s.on('deal.upserted', (e) => {
      if (e.clientMutationId && pendingMutations.has(e.clientMutationId)) return;
      upsertDealInCache(qc, e.deal);
    });
    s.on('deal.removed', ({ dealId }) => {
      qc.setQueriesData<BoardDto>({ queryKey: boardKeys.all }, (b) => (b ? applyDealRemoval(b, dealId) : b));
    });
    s.on('deal.lock', ({ dealId, lockedBy }) => locks.set(dealId, lockedBy));
    s.on('conversation.upserted', ({ conversation }) => upsertConversationInCache(qc, conversation));
    s.on('message.created', ({ message, clientMutationId }) => {
      if (clientMutationId && pendingMutations.has(clientMutationId)) return;
      upsertMessageInCache(qc, message);
    });
    s.on('message.updated', ({ message }) => upsertMessageInCache(qc, message));

    setSocket(s);
    const timer = setInterval(() => locks.pruneExpired(), 2_000);
    return () => {
      clearInterval(timer);
      s.disconnect();
      setSocket(null);
    };
  }, [qc, locks, session.token, session.workspaceId]);

  return <RealtimeContext.Provider value={{ socket, locks }}>{children}</RealtimeContext.Provider>;
}

function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('RealtimeProvider is missing');
  return ctx;
}

export const useSocket = () => useRealtime().socket;

export function useDealLock(dealId: string): LockHolder | null {
  const { locks } = useRealtime();
  const all = useSyncExternalStore(locks.subscribe, locks.snapshot, locks.snapshot);
  return all.get(dealId) ?? null;
}

export function useLockStore() {
  return useRealtime().locks;
}
