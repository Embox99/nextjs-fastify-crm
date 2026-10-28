'use client';

import type { LoginResponse } from '@crm/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-provider';
import { LanguageSwitcher } from '@/i18n/language-switcher';
import type { MessageKey } from '@/i18n/messages';
import { ApiError, apiFetch } from '@/lib/api';
import { writeSession } from '@/lib/session';

const DEMO_USERS: { email: string; role: MessageKey }[] = [
  { email: 'admin@acme.test', role: 'login.demo.admin' },
  { email: 'lead@acme.test', role: 'login.demo.lead' },
  { email: 'rep1@acme.test', role: 'login.demo.rep1' },
  { email: 'rep3@acme.test', role: 'login.demo.rep3' },
];

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [organization, setOrganization] = useState('acme');
  const [email, setEmail] = useState('lead@acme.test');
  const [password, setPassword] = useState('demo');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch<LoginResponse>('/auth/login', { method: 'POST', body: { organization, email, password } });
      const workspaceId = res.workspaces[0]?.id;
      if (!workspaceId) throw new Error(t('login.noWorkspace'));
      writeSession({ ...res, workspaceId });
      router.replace('/board');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('login.invalid') : (err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-4">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('app.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="org">{t('login.organization')}</Label>
            <Input id="org" value={organization} onChange={(e) => setOrganization(e.target.value)} autoComplete="organization" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t('login.email')}</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('login.password')}</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending}>{pending ? t('login.submitting') : t('login.submit')}</Button>
        </form>

        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">{t('login.demoUsers', { password: 'demo' })}</p>
          <ul className="space-y-1">
            {DEMO_USERS.map((u) => (
              <li key={u.email}>
                <button type="button" className="text-left hover:underline" onClick={() => setEmail(u.email)}>
                  <span className="font-medium">{u.email}</span> <span className="text-muted-foreground">— {t(u.role)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
