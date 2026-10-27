'use client';

import { AppShell } from '@/components/app-shell';
import { Inbox } from '@/features/inbox/inbox';

export default function InboxPage() {
  return (
    <AppShell>
      <Inbox />
    </AppShell>
  );
}
