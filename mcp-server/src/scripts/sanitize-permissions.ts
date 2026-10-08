import { main } from '../lib/sanitize-permissions.js'

process.exit(
  main({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stderr: (msg) => process.stderr.write(msg + '\n'),
  }),
)
