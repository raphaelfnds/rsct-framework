import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/scripts/sanitize-permissions.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
  banner: { js: '#!/usr/bin/env node' },
  dts: false,
  treeshake: true,
})
