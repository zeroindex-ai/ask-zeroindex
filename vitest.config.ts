import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'evals/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx', 'evals/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', 'src/**/types.ts'],
      // Honest, enforced gate. Measured 2026-05-20: statements 60.6%,
      // branches 55.2%, functions 62.5%, lines 62.4%. Thresholds sit ~3%
      // below the lowest measured metric (branches) so CI run-to-run variance
      // doesn't flake the gate. Raise these as coverage of the remaining
      // I/O-bound modules (claude/db/embeddings) and route.ts improves.
      thresholds: {
        lines: 52,
        functions: 52,
        branches: 52,
        statements: 52,
      },
    },
  },
});
