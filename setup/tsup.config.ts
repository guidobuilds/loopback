import { defineConfig } from 'tsup';

export default defineConfig([
  // Primary bundle — the CLI entrypoint with shebang.
  {
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    banner: {
      js: '#!/usr/bin/env node',
    },
    clean: true,
    dts: false,
    sourcemap: false,
    splitting: false,
    minify: false,
  },
  // Library entries — emitted unbundled so test/ can import individual
  // modules under node --test (no shebang, no bundling).
  {
    entry: {
      style: 'src/style.ts',
      prompts: 'src/prompts.ts',
      'detect-agent': 'src/detect-agent.ts',
    },
    outDir: 'dist',
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    bundle: false,
    clean: false,
    dts: false,
    sourcemap: false,
    splitting: false,
    minify: false,
  },
]);
