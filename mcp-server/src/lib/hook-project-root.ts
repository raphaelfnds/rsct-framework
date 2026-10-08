import { isAbsolute, resolve } from 'node:path'

export interface ResolveOptions {
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export function resolveProjectRootFromArgs(options: ResolveOptions): string {
  const { argv, env, cwd } = options
  const idx = argv.indexOf('--project-root')
  if (idx !== -1) {
    const value = argv[idx + 1]
    if (value && value.length > 0) {
      return isAbsolute(value) ? value : resolve(cwd, value)
    }
  }
  const fromEnv = env.CLAUDE_PROJECT_DIR
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv
  }
  return cwd
}
