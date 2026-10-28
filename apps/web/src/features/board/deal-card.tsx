'use client';

import type { DealDto } from '@crm/contracts';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Pencil } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-provider';
import { cn, shortName } from '@/lib/utils';
import { useDealLock } from '../realtime/realtime-provider';

interface DealCardProps {
  deal: DealDto;
  ownerName: string | null;
  currentUserId: string;
  onOpen?: (dealId: string) => void;
  overlay?: boolean;
}

export function DealCardView({ deal, ownerName, currentUserId, overlay, dragging }: DealCardProps & { dragging?: boolean }) {
  const lock = useDealLock(deal.id);
  const { t, format } = useI18n();
  const lockedByOther = lock && lock.userId !== currentUserId;

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-shadow hover:shadow-md',
        overlay && 'rotate-2 shadow-lg ring-2 ring-ring',
        dragging && 'opacity-40',
        lockedByOther && 'border-warning',
      )}
    >
      <p className="text-sm font-medium leading-snug">{deal.title}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm tabular-nums text-muted-foreground">{format.money(deal.value, deal.currency)}</span>
        {ownerName ? <Avatar name={ownerName} /> : <span className="text-xs text-muted-foreground">{t('board.unassigned')}</span>}
      </div>
      {lockedByOther && (
        <p className="mt-2 flex items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-xs" data-testid="lock-indicator">
          <Pencil className="size-3" aria-hidden /> {t('board.editingBy', { name: shortName(lock.name) })}
        </p>
      )}
    </div>
  );
}

export function SortableDealCard(props: DealCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.deal.id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => props.onOpen?.(props.deal.id)}
      className="cursor-grab list-none touch-none active:cursor-grabbing"
      data-deal-id={props.deal.id}
    >
      <DealCardView {...props} dragging={isDragging} />
    </li>
  );
}
