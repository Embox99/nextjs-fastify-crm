'use client';

import type { BoardDto } from '@crm/contracts';
import { columnDeals } from '@crm/domain';
import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useMemo, useState } from 'react';
import { Column } from './column';
import { DealCardView } from './deal-card';
import { NewDealForm } from './new-deal-form';
import { useMoveDeal } from './queries';

type Columns = Record<string, string[]>;

interface BoardProps {
  board: BoardDto;
  currentUserId: string;
  canCreate: boolean;
  onOpenDeal: (dealId: string) => void;
}

export function Board({ board, currentUserId, canCreate, onOpenDeal }: BoardProps) {
  const moveDeal = useMoveDeal(board.pipeline.id);
  const sensors = useSensors(
    // Небольшой порог, чтобы клик по карточке открывал её, а не начинал перетаскивание
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dealsById = useMemo(() => new Map(board.deals.map((d) => [d.id, d])), [board.deals]);
  const memberNames = useMemo(() => new Map(board.members.map((m) => [m.id, m.fullName])), [board.members]);
  const serverColumns = useMemo<Columns>(
    () => Object.fromEntries(board.stages.map((s) => [s.id, columnDeals(board.deals, s.id).map((d) => d.id)])),
    [board],
  );

  // Пока идёт перетаскивание, раскладка живёт локально: карточка «переезжает» между колонками на лету
  const [dragColumns, setDragColumns] = useState<Columns | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const columns = dragColumns ?? serverColumns;

  const containerOf = (id: string, cols: Columns) =>
    id in cols ? id : Object.keys(cols).find((stageId) => cols[stageId]!.includes(id));

  function onDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
    setDragColumns(serverColumns);
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    setDragColumns((cols) => {
      if (!cols) return cols;
      const from = containerOf(String(active.id), cols);
      const to = containerOf(String(over.id), cols);
      if (!from || !to || from === to) return cols;

      const target = cols[to]!;
      const overIndex = target.indexOf(String(over.id));
      const insertAt = overIndex === -1 ? target.length : overIndex;
      return {
        ...cols,
        [from]: cols[from]!.filter((id) => id !== active.id),
        [to]: [...target.slice(0, insertAt), String(active.id), ...target.slice(insertAt)],
      };
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const cols = dragColumns;
    setActiveId(null);
    setDragColumns(null);
    if (!cols || !over) return;

    const dealId = String(active.id);
    const stageId = containerOf(dealId, cols);
    if (!stageId) return;

    let ids = cols[stageId]!;
    const overIndex = ids.indexOf(String(over.id));
    if (overIndex !== -1) ids = arrayMove(ids, ids.indexOf(dealId), overIndex);

    const index = ids.indexOf(dealId);
    const move = { dealId, toStageId: stageId, beforeId: ids[index - 1] ?? null, afterId: ids[index + 1] ?? null };

    // Бросили туда же, откуда взяли — запрос не нужен
    const original = serverColumns[dealsById.get(dealId)!.stageId]!;
    const originalIndex = original.indexOf(dealId);
    const unchanged = dealsById.get(dealId)!.stageId === stageId
      && (original[originalIndex - 1] ?? null) === move.beforeId
      && (original[originalIndex + 1] ?? null) === move.afterId;
    if (!unchanged) moveDeal(move);
  }

  const activeDeal = activeId ? dealsById.get(activeId) : undefined;
  const firstOpenStage = board.stages.find((s) => s.kind === 'open');

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setDragColumns(null);
      }}
    >
      <div className="flex h-full gap-3 overflow-x-auto px-4 pb-4 sm:px-6">
        {board.stages.map((stage) => (
          <Column
            key={stage.id}
            stage={stage}
            deals={(columns[stage.id] ?? []).map((id) => dealsById.get(id)!).filter(Boolean)}
            memberNames={memberNames}
            currentUserId={currentUserId}
            onOpen={onOpenDeal}
            header={canCreate && stage.id === firstOpenStage?.id
              ? <NewDealForm pipelineId={board.pipeline.id} stageId={stage.id} />
              : undefined}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDeal && (
          <DealCardView
            deal={activeDeal}
            ownerName={activeDeal.ownerId ? memberNames.get(activeDeal.ownerId) ?? null : null}
            currentUserId={currentUserId}
            overlay
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}
