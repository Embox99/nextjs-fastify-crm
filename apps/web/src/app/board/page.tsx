'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { Board } from '@/features/board/board';
import { DealSheet } from '@/features/board/deal-sheet';
import { useBoard, useMe, usePipelines } from '@/features/board/queries';
import { RealtimeProvider } from '@/features/realtime/realtime-provider';
import { clearSession, readSession, type Session } from '@/lib/session';

const SCOPE_LABEL = { all: 'видит все сделки', team: 'видит сделки команды', own: 'видит свои сделки' } as const;

export default function BoardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const s = readSession();
    if (!s) router.replace('/login');
    else setSession(s);
  }, [router]);

  if (!session) return null;

  return (
    <RealtimeProvider session={session}>
      <BoardScreen session={session} onLogout={() => {
        clearSession();
        router.replace('/login');
      }} />
    </RealtimeProvider>
  );
}

function BoardScreen({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const me = useMe();
  const pipelines = usePipelines();
  const [pipelineId, setPipelineId] = useState<string>();
  const activePipeline = pipelineId ?? pipelines.data?.[0]?.id;
  const board = useBoard(activePipeline);
  const [openDealId, setOpenDealId] = useState<string | null>(null);

  const openDeal = openDealId ? board.data?.deals.find((d) => d.id === openDealId) : undefined;
  const permissions = new Set(me.data?.permissions);
  const workspace = session.workspaces.find((w) => w.id === session.workspaceId);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">Сделки</h1>
          {pipelines.data && pipelines.data.length > 1 && (
            <select value={activePipeline} onChange={(e) => setPipelineId(e.target.value)}
              className="h-8 rounded-md border border-border bg-card px-2 text-sm" aria-label="Воронка">
              {pipelines.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {board.data && <span className="text-sm text-muted-foreground">{board.data.pipeline.name} · {workspace?.name}</span>}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span>
            <span className="font-medium">{session.user.fullName}</span>
            {me.data && <span className="text-muted-foreground"> — {SCOPE_LABEL[me.data.scope]}</span>}
          </span>
          <Button variant="ghost" onClick={onLogout} aria-label="Выйти"><LogOut className="size-4" /></Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 pt-4">
        {board.isPending && <p className="px-6 text-sm text-muted-foreground">Загружаем доску…</p>}
        {board.isError && <p className="px-6 text-sm text-destructive">Не удалось загрузить доску</p>}
        {board.data && (
          <Board
            board={board.data}
            currentUserId={session.user.id}
            canCreate={permissions.has('deal:create')}
            onOpenDeal={setOpenDealId}
          />
        )}
      </main>

      {openDeal && board.data && (
        <DealSheet
          key={openDeal.id}
          deal={openDeal}
          members={board.data.members}
          currentUserId={session.user.id}
          canReassign={permissions.has('deal:reassign')}
          onClose={() => setOpenDealId(null)}
        />
      )}
    </div>
  );
}
