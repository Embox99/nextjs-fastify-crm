'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import type { Locale } from '@/i18n/config';
import { I18nProvider } from '@/i18n/i18n-provider';

export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      // Свежесть доски обеспечивает WebSocket, а не поллинг
      queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
    },
  }));

  return (
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>
        {children}
        <Toaster richColors position="bottom-right" />
      </QueryClientProvider>
    </I18nProvider>
  );
}
