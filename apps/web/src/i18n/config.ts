export const LOCALES = ['ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Язык хранится в cookie, а не в localStorage: корневой layout читает его на сервере,
 * и страница сразу рендерится на нужном языке — без мигания русского текста при загрузке.
 */
export const LOCALE_COOKIE = 'crm.locale';

export const LOCALE_NAMES: Record<Locale, string> = { ru: 'Русский', en: 'English' };

export const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale);

/** Без cookie — язык из Accept-Language, иначе английский */
export function negotiateLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  const preferred = acceptLanguage?.split(',').map((p) => p.trim().slice(0, 2).toLowerCase());
  return preferred?.find(isLocale) ?? DEFAULT_LOCALE;
}
