import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const { version } = JSON.parse(readFileSync(r('./package.json'), 'utf8')) as { version: string };

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: [
      { find: '@halvorai/schema/canonical', replacement: r('./vendor/schema/canonical.ts') },
      { find: '@halvorai/schema', replacement: r('./vendor/schema/index.ts') },
      { find: '@halvorai/packs/verify', replacement: r('./vendor/packs/verify.ts') },
    ],
  },
  test: {
    pool: 'forks',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.perf.test.ts'],
  },
});
