'use client';

import type { DealDto, StageDto } from '@crm/contracts';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn, formatMoney } from '@/lib/utils';
import { SortableDealCard } from './deal-card';
import type { ReactNode } from 'react';

interface ColumnProps {
  stage: StageDto;
  deals: DealDto[];
  memberNames: Map<string, string>;
  currentUserId: string;
  onOpen: (dealId: string) => void;
  header?: ReactNode;
}

export function Column({ stage, deals, memberNames, currentUserId, onOpen, header }: ColumnProps) {
  // Колонка — droppable сама по себе, чтобы карточку можно было бросить в пустую колонку
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = deals.reduce((sum, d) => sum + Number(d.value), 0);

  return (
    <section
      aria-label={stage.name}
      className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-muted/70 transition-colors', isOver && 'bg-accent')}
    >
      <header className="space-y-0.5 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <h2 className={cn('text-sm font-semibold', stage.kind === 'won' && 'text-green-700 dark:text-green-400', stage.kind === 'lost' && 'text-muted-foreground')}>
            {stage.name}
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">{deals.length}</span>
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">{formatMoney(String(total))}</p>
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
