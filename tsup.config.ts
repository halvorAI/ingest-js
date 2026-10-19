import { defineConfig } from 'tsup';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/init.ts',
    bin: 'src/cli/bin.ts',
    stripe: 'src/stripe/index.ts',
    x402: 'src/x402/index.ts',
    mpp: 'src/mpp/index.ts',
    mcp: 'src/mcp/index.ts',
    evidence: 'src/evidence/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts', cli: 'src/cli/init.ts', stripe: 'src/stripe/index.ts', x402: 'src/x402/index.ts', mpp: 'src/mpp/index.ts', mcp: 'src/mcp/index.ts', evidence: 'src/evidence/index.ts' }, resolve: [/^@halvorai\//] },
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  noExternal: [/^@halvorai\//],
  external: ['jose', 'ulid', 'zod', 'fflate'],
  esbuildOptions(o) {
    o.alias = {
      '@halvorai/schema/canonical': r('./vendor/schema/canonical.ts'),
      '@halvorai/schema': r('./vendor/schema/index.ts'),
      '@halvorai/packs/verify': r('./vendor/packs/verify.ts'),
    };
  },
});
