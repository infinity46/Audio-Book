import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws when imported outside a React Server Component.
      // The proxy and session modules are plain functions under test, so the
      // guard is stubbed rather than the modules being restructured to avoid it.
      'server-only': fileURLToPath(new URL('./src/test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', '.next', 'e2e'],
    css: false,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/components/**'],
      exclude: ['src/test/**'],
    },
  },
});
