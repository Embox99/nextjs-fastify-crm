import type { NextConfig } from 'next';

const config: NextConfig = {
  // Внутренние пакеты монорепо публикуют исходники TS — Next их транспилирует
  transpilePackages: ['@crm/contracts', '@crm/domain'],
  // Типы проверяет `pnpm typecheck` (tsc) — отдельным шагом CI
  typescript: { ignoreBuildErrors: true },
  // Плавающий индикатор dev-режима мешает записи демо; ошибки сборки Next всё равно показывает оверлеем
  devIndicators: false,
};

export default config;
