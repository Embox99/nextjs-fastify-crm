'use client';

import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useMarkAllRead, useNotifications } from './queries';

const time = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function NotificationsBell() {
  const router = useRouter();
  const notifications = useNotifications();
  const markAll = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const unread = notifications.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={panel} className="relative">
      <Button variant="ghost" className="relative size-8 px-0" aria-label={`Уведомления${unread ? `: ${unread} новых` : ''}`}
        aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">Уведомления</span>
            {unread > 0 && (
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => markAll.mutate()}>Прочитать все</button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {notifications.data?.items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Пока пусто</li>}
            {notifications.data?.items.map((n) => (
              <li key={n.id}>
                <button type="button" disabled={!n.dealId}
                  className={cn('w-full px-3 py-2 text-left hover:bg-muted disabled:cursor-default', !n.readAt && 'bg-accent/60')}
                  onClick={() => {
                    if (!n.dealId) return;
                    setOpen(false);
                    router.push(`/board?deal=${n.dealId}`);
                  }}>
                  <p className="text-sm">{n.title}</p>
                  <p className="text-xs text-muted-foreground">{time.format(new Date(n.createdAt))}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
