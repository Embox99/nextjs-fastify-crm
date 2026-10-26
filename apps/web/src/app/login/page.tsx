'use client';

import type { LoginResponse } from '@crm/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';
import { writeSession } from '@/lib/session';

const DEMO_USERS = [
  { email: 'admin@acme.test', role: 'Администратор — видит всё' },
  { email: 'lead@acme.test', role: 'Руководитель — команда Enterprise' },
  { email: 'rep1@acme.test', role: 'Менеджер — только свои сделки' },
  { email: 'rep3@acme.test', role: 'Менеджер команды SMB' },
];

export default function LoginPage() {
  const router = useRouter();
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
      if (!workspaceId) throw new Error('У пользователя нет доступных workspace');
      writeSession({ ...res, workspaceId });
      router.replace('/board');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Неверная организация, email или пароль' : (err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Lead-to-Deal Engine</h1>
          <p className="text-sm text-muted-foreground">Войдите, чтобы открыть доску сделок</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="org">Организация</Label>
            <Input id="org" value={organization} onChange={(e) => setOrganization(e.target.value)} autoComplete="organization" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Пароль</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending}>{pending ? 'Входим…' : 'Войти'}</Button>
        </form>

        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">Демо-пользователи (пароль <code>demo</code>):</p>
          <ul className="space-y-1">
            {DEMO_USERS.map((u) => (
              <li key={u.email}>
                <button type="button" className="text-left hover:underline" onClick={() => setEmail(u.email)}>
                  <span className="font-medium">{u.email}</span> <span className="text-muted-foreground">— {u.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
