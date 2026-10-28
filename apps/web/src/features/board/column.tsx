'use client';

import type { DealDto, StageDto } from '@crm/contracts';
import { useDroppable } from '@dnd-kit/core';
import { Settings2 } from 'lucide-react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useI18n } from '@/i18n/i18n-provider';
import { cn } from '@/lib/utils';
import { SortableDealCard } from './deal-card';
import type { ReactNode } from 'react';

interface ColumnProps {
  stage: StageDto;
  deals: DealDto[];
  memberNames: Map<string, string>;
  currentUserId: string;
  onOpen: (dealId: string) => void;
  header?: ReactNode;
  /** Только для администраторов: открыть настройки колонки */
  onOpenSettings?: () => void;
}

export function Column({ stage, deals, memberNames, currentUserId, onOpen, header, onOpenSettings }: ColumnProps) {
  // Колонка — droppable сама по себе, чтобы карточку можно было бросить в пустую колонку
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const { format, t } = useI18n();
  const total = deals.reduce((sum, d) => sum + Number(d.value), 0);
  // Итог колонки — в валюте сделок (демо и новые сделки — USD)
  const currency = deals[0]?.currency;

  return (
    <section
      aria-label={stage.name}
      className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-muted transition-colors', isOver && 'bg-accent')}
    >
      <header className="space-y-0.5 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <h2 className={cn('text-sm font-semibold', stage.kind === 'won' && 'text-green-700 dark:text-green-400', stage.kind === 'lost' && 'text-muted-foreground')}>
            {stage.name}
          </h2>
          <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
            {deals.length}
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} aria-label={t('stage.settingsAria')}
                className="rounded p-0.5 hover:bg-card hover:text-foreground">
                <Settings2 className="size-3.5" />
              </button>
            )}
          </span>
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">{format.money(total, currency)}</p>
      </header>
      {header}
      <SortableContext id={stage.id} items={deals.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
          {deals.map((deal) => (
            <SortableDealCard
              key={deal.id}
              deal={deal}
              ownerName={deal.ownerId ? memberNames.get(deal.ownerId) ?? null : null}
              currentUserId={currentUserId}
              onOpen={onOpen}
            />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}
