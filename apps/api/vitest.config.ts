import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Файлы делят одну БД с демо-данными и мутируют сделки — запускаем последовательно
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
