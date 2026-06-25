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
  // Self-contained dist: bundle the runtime deps so `dist/index.js` runs without
  // `node_modules` (prevents the npm-link/copied-dist boot crash). pino does a
  // dynamic `require('node:os')` that ESM output can't resolve, so the banner
  // restores a real `require` via createRequire (the shebang stays line 1).
  noExternal: ['@modelcontextprotocol/sdk', 'pino', 'zod'],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
  dts: false,
  treeshake: true,
})
