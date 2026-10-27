'use client';

import { AppShell } from '@/components/app-shell';
import { Automations } from '@/features/automations/automations';

export default function AutomationsPage() {
  return (
    <AppShell>
      <div className="h-full overflow-y-auto">
        <Automations />
      </div>
    </AppShell>
  );
}
