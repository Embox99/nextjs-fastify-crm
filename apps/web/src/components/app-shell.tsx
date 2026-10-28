'use client';

import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { NotificationsBell } from '@/features/automations/notifications-bell';
import { useMe } from '@/features/board/queries';
import { useI18n } from '@/i18n/i18n-provider';
import { LanguageSwitcher } from '@/i18n/language-switcher';
import type { MessageKey } from '@/i18n/messages';
import { RealtimeProvider } from '@/features/realtime/realtime-provider';
import { clearSession, readSession, type Session } from '@/lib/session';
import { cn } from '@/lib/utils';

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside AppShell');
  return session;
}

const NAV: { href: string; label: MessageKey; permission?: string }[] = [
  { href: '/board', label: 'nav.board' },
  { href: '/inbox', label: 'nav.inbox' },
  { href: '/automations', label: 'nav.automations', permission: 'settings:manage' },
];

/** Каркас авторизованных страниц: сессия, WebSocket-соединение (одно на вкладку) и навигация */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const s = readSession();
    if (!s) router.replace('/login');
    else setSession(s);
  }, [router]);

  if (!session) return null;

  return (
    <SessionContext.Provider value={session}>
      <RealtimeProvider session={session}>
        <div className="flex h-dvh flex-col">
          <Header session={session} onLogout={() => {
            clearSession();
            router.replace('/login');
          }} />
          <main className="min-h-0 flex-1">{children}</main>
        </div>
      </RealtimeProvider>
    </SessionContext.Provider>
  );
}

function Header({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const pathname = usePathname();
  const me = useMe();
  const { t } = useI18n();
  const workspace = session.workspaces.find((w) => w.id === session.workspaceId);

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-6">
      <nav className="flex items-center gap-1" aria-label={t('nav.sections')}>
        {NAV.filter((item) => !item.permission || me.data?.permissions.includes(item.permission)).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
              pathname.startsWith(item.href) && 'bg-muted text-foreground',
            )}
          >
            {t(item.label)}
          </Link>
        ))}
        {workspace && <span className="ml-2 hidden text-sm text-muted-foreground sm:inline">{workspace.name}</span>}
      </nav>
      <div className="flex items-center gap-3 text-sm">
        <LanguageSwitcher />
        <NotificationsBell />
        <span>
          <span className="font-medium">{session.user.fullName}</span>
          {me.data && <span className="text-muted-foreground"> — {t(`scope.${me.data.scope}`)}</span>}
        </span>
        <Button variant="ghost" onClick={onLogout} aria-label={t('nav.logout')}><LogOut className="size-4" /></Button>
      </div>
    </header>
  );
}
