'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AppShell, useSession } from '@/components/app-shell';
import { Board } from '@/features/board/board';
import { DealSheet } from '@/features/board/deal-sheet';
import { useBoard, useMe, usePipelines } from '@/features/board/queries';
import { useI18n } from '@/i18n/i18n-provider';

export default function BoardPage() {
  return (
    <AppShell>
      {/* useSearchParams требует границы Suspense */}
      <Suspense>
        <BoardScreen />
      </Suspense>
    </AppShell>
  );
}

function BoardScreen() {
  const session = useSession();
  const { t } = useI18n();
  const me = useMe();
  const pipelines = usePipelines();
  const [pipelineId, setPipelineId] = useState<string>();
  const activePipeline = pipelineId ?? pipelines.data?.[0]?.id;
  const board = useBoard(activePipeline);
  const [openDealId, setOpenDealId] = useState<string | null>(null);
  // Переход из уведомления: /board?deal=<id> открывает карточку
  const dealFromUrl = useSearchParams().get('deal');
  useEffect(() => {
    if (dealFromUrl) setOpenDealId(dealFromUrl);
  }, [dealFromUrl]);

  const openDeal = openDealId ? board.data?.deals.find((d) => d.id === openDealId) : undefined;
  const permissions = new Set(me.data?.permissions);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <h1 className="text-base font-semibold">{board.data?.pipeline.name ?? t('board.title')}</h1>
        {pipelines.data && pipelines.data.length > 1 && (
          <select value={activePipeline} onChange={(e) => setPipelineId(e.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 text-sm" aria-label={t('board.pipeline')}>
            {pipelines.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {board.isPending && <p className="px-6 text-sm text-muted-foreground">{t('common.loading')}</p>}
        {board.isError && <p className="px-6 text-sm text-destructive">{t('board.loadFailed')}</p>}
        {board.data && (
          <Board
            board={board.data}
            currentUserId={session.user.id}
            canCreate={permissions.has('deal:create')}
            canManageStages={permissions.has('settings:manage')}
            onOpenDeal={setOpenDealId}
          />
        )}
      </div>

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
