import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
      // next/font only exists inside the Next compiler; see the stub's note.
      'next/font/google': path.resolve(process.cwd(), 'tests/stubs/next-font-google.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // PGlite instances are heavy; keep suites serial within a file.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
