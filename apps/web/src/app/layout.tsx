import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { LOCALE_COOKIE, negotiateLocale } from '@/i18n/config';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Lead-to-Deal Engine',
  description: 'B2B CRM: leads, deals, omnichannel inbox, automations',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Язык известен до рендера: из cookie, при первом визите — из Accept-Language
  const locale = negotiateLocale((await cookies()).get(LOCALE_COOKIE)?.value, (await headers()).get('accept-language'));

  return (
    <html lang={locale} className={inter.variable}>
      <body className="min-h-dvh font-sans antialiased">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
