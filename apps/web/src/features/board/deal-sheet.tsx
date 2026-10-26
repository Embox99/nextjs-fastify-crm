'use client';

import { LOCK_HEARTBEAT_MS, type DealDto, type MemberDto, type Viewer } from '@crm/contracts';
import { Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Avatar, Button, Input, Label } from '@/components/ui';
import { formatMoney, shortName } from '@/lib/utils';
import { useDealLock, useLockStore, useSocket } from '../realtime/realtime-provider';
import { useUpdateDeal } from './queries';

interface DealSheetProps {
  deal: DealDto;
  members: MemberDto[];
  currentUserId: string;
  canReassign: boolean;
  onClose: () => void;
}

/**
 * Карточка сделки. Открытие — presence («кто смотрит»), «Редактировать» — мягкая блокировка
 * с heartbeat. Блокировка информирует, а от потери правок защищает version (409 при конфликте).
 */
export function DealSheet({ deal, members, currentUserId, canReassign, onClose }: DealSheetProps) {
  const socket = useSocket();
  const locks = useLockStore();
  const lock = useDealLock(deal.id);
  const update = useUpdateDeal();

  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [editing, setEditing] = useState(false);
  const [contested, setContested] = useState(false);
  const [form, setForm] = useState({ title: deal.title, value: deal.value, ownerId: deal.ownerId ?? '' });
  /** Версия, с которой начали правку: если сделку за это время изменили, сервер вернёт 409 */
  const baseVersion = useRef(deal.version);
  const editingRef = useRef(false);

  const lockedByOther = lock && lock.userId !== currentUserId ? lock : null;
  const staleWhileEditing = editing && deal.version !== baseVersion.current;

  useEffect(() => {
    if (!socket) return;
    const dealId = deal.id;
    // Состояние «открыта/редактируется» живёт в серверной сессии сокета: после переподключения
    // (рестарт или смена реплики) его нужно восстановить, иначе edit.start вернёт deal_not_open
    const openOnServer = () => {
      socket.emit('deal.open', { dealId }, (res) => {
        if (!res.ok) return;
        setViewers(res.viewers);
        locks.set(dealId, res.lockedBy);
        if (editingRef.current) socket.emit('deal.edit.start', { dealId }, () => {});
      });
    };
    if (socket.connected) openOnServer();
    socket.on('connect', openOnServer);

    const onPresence = (e: { dealId: string; viewers: Viewer[] }) => {
      if (e.dealId === dealId) setViewers(e.viewers);
    };
    socket.on('deal.presence', onPresence);

    return () => {
      socket.off('connect', openOnServer);
      socket.off('deal.presence', onPresence);
      if (editingRef.current) socket.emit('deal.edit.stop', { dealId });
      socket.emit('deal.close', { dealId });
    };
  }, [socket, locks, deal.id]);

  useEffect(() => {
    if (!editing || !socket) return;
    const timer = setInterval(() => socket.emit('deal.edit.heartbeat', { dealId: deal.id }), LOCK_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [editing, socket, deal.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function startEditing(force = false) {
    const begin = () => {
      baseVersion.current = deal.version;
      setForm({ title: deal.title, value: deal.value, ownerId: deal.ownerId ?? '' });
      editingRef.current = true;
      setEditing(true);
      setContested(false);
    };
    if (force || !socket) return begin();

    socket.emit('deal.edit.start', { dealId: deal.id }, (res) => {
      if (!res.ok) return void toast.error('Не удалось начать редактирование — попробуйте ещё раз');
      if (res.acquired) begin();
      else setContested(true);
    });
  }

  function stopEditing() {
    if (editingRef.current) socket?.emit('deal.edit.stop', { dealId: deal.id });
    editingRef.current = false;
    setEditing(false);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    update.mutate({
      dealId: deal.id,
      version: baseVersion.current,
      ...(form.title !== deal.title && { title: form.title }),
      ...(form.value !== deal.value && { value: form.value }),
      ...(canReassign && form.ownerId !== (deal.ownerId ?? '') && { ownerId: form.ownerId || null }),
    }, { onSettled: stopEditing });
  }

  const owner = members.find((m) => m.id === deal.ownerId);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={deal.title}>
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col gap-5 overflow-y-auto border-l border-border bg-background p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold leading-snug">{deal.title}</h2>
          <Button variant="ghost" className="size-8 px-0" onClick={onClose} aria-label="Закрыть"><X className="size-4" /></Button>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="viewers">
          <span>Сейчас смотрят:</span>
          {viewers.map((v) => <Avatar key={v.userId} name={v.name} />)}
        </div>

        {lockedByOther && (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-sm">
            <Pencil className="mr-1 inline size-3.5" aria-hidden />
            Сейчас редактирует <b>{shortName(lockedByOther.name)}</b> — ваши изменения могут конфликтовать
          </p>
        )}
        {staleWhileEditing && (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-sm">
            Пока вы редактировали, сделку изменили. При сохранении вы получите конфликт — обновите форму.
          </p>
        )}

        {editing ? (
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Название</Label>
              <Input id="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="value">Сумма, ₽</Label>
              <Input id="value" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })} />
            </div>
            {canReassign && (
              <div className="space-y-2">
                <Label htmlFor="owner">Ответственный</Label>
                <select id="owner" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
                  className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm">
                  <option value="">Не назначен</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
                </select>
              </div>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={update.isPending}>Сохранить</Button>
              <Button type="button" variant="outline" onClick={stopEditing}>Отмена</Button>
            </div>
          </form>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Сумма</dt>
              <dd className="tabular-nums">{formatMoney(deal.value)}</dd>
              <dt className="text-muted-foreground">Ответственный</dt>
              <dd>{owner?.fullName ?? 'Не назначен'}</dd>
              <dt className="text-muted-foreground">В этапе с</dt>
              <dd>{new Date(deal.stageEnteredAt).toLocaleString('ru-RU')}</dd>
              <dt className="text-muted-foreground">Версия</dt>
              <dd className="tabular-nums">{deal.version}</dd>
            </dl>
            {contested && lockedByOther ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => startEditing(true)}>Редактировать всё равно</Button>
              </div>
            ) : (
              <Button className="self-start" onClick={() => startEditing()}>
                <Pencil className="size-4" /> Редактировать
              </Button>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
