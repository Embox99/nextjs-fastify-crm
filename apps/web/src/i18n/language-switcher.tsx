'use client';

import { Languages } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LOCALE_NAMES, LOCALES, type Locale } from './config';
import { useI18n } from './i18n-provider';

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={cn('inline-flex items-center gap-1 text-sm text-muted-foreground', className)}>
      <Languages className="size-4" aria-hidden />
      <span className="sr-only">{t('lang.label')}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-8 rounded-md border border-transparent bg-transparent px-1 text-sm hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_NAMES[l]}</option>)}
      </select>
    </label>
  );
}
