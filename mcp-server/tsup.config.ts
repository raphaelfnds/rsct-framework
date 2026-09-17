import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/scripts/sanitize-permissions.ts',
    'src/scripts/edit-scope-guard.ts',
  ],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
  noExternal: ['@modelcontextprotocol/sdk', 'pino', 'zod', 'web-tree-sitter', 'parse5'],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
  dts: false,
  treeshake: true,
})
