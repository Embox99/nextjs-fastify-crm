'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { LOCALE_COOKIE, type Locale } from './config';
import { en, ru, type MessageKey } from './messages';

const DICTIONARIES = { ru, en } satisfies Record<Locale, Record<MessageKey, string>>;
const INTL_LOCALE: Record<Locale, string> = { ru: 'ru-RU', en: 'en-US' };
/** Совпадает с default колонки deals.currency */
const DEFAULT_CURRENCY = 'USD';

type Vars = Record<string, string | number>;

function createI18n(locale: Locale) {
  const dict = DICTIONARIES[locale];
  const tag = INTL_LOCALE[locale];
  // Форматтер на валюту создаётся один раз: сделки несут свою валюту (по умолчанию USD)
  const moneyFormats = new Map<string, Intl.NumberFormat>();
  const money = (currency: string) => {
    let f = moneyFormats.get(currency);
    if (!f) moneyFormats.set(currency, (f = new Intl.NumberFormat(tag, { style: 'currency', currency, maximumFractionDigits: 0 })));
    return f;
  };
  const number = new Intl.NumberFormat(tag);
  const time = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' });
  const dayTime = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const full = new Intl.DateTimeFormat(tag, { dateStyle: 'short', timeStyle: 'medium' });
  const relative = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });

  const t = (key: MessageKey, vars?: Vars) =>
    vars ? dict[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : dict[key];

  return {
    locale,
    t,
    format: {
      money: (value: string | number, currency = DEFAULT_CURRENCY) => money(currency).format(Number(value)),
      number: (value: number) => number.format(value),
      time: (iso: string) => time.format(new Date(iso)),
      /** Сегодня — время, иначе дата */
      when: (iso: string) => {
        const d = new Date(iso);
        return d.toDateString() === new Date().toDateString() ? time.format(d) : day.format(d);
      },
      dayTime: (iso: string) => dayTime.format(new Date(iso)),
      full: (iso: string) => full.format(new Date(iso)),
      ago: (iso: string) => {
        const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
        if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
        if (Math.abs(minutes) < 1440) return relative.format(Math.round(minutes / 60), 'hour');
        return relative.format(Math.round(minutes / 1440), 'day');
      },
      duration: (minutes: number) => {
        if (minutes < 60) return t('duration.minutes', { n: minutes });
        if (minutes % 1440 === 0) return t('duration.days', { n: minutes / 1440 });
        if (minutes % 60 === 0) return t('duration.hours', { n: minutes / 60 });
        return t('duration.hoursMinutes', { h: Math.floor(minutes / 60), m: minutes % 60 });
      },
    },
  };
}

export type I18n = ReturnType<typeof createI18n> & { setLocale: (locale: Locale) => void };

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next;
  }, []);

  const value = useMemo(() => ({ ...createI18n(locale), setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('I18nProvider is missing');
  return ctx;
}
