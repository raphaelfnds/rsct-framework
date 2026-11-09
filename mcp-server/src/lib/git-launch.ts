import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ExecFileSyncOptions,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process'

const GIT_CHILD_CONFIG: readonly string[] = ['-c', 'core.fsmonitor=']

function gitChildArgs(args: readonly string[]): string[] {
  return [...GIT_CHILD_CONFIG, ...args]
}

function gitChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1' }
}

export function runGitText(args: readonly string[], options: Omit<ExecFileSyncOptions, 'encoding'>): string {
  return execFileSync('git', gitChildArgs(args), { ...options, encoding: 'utf8', env: gitChildEnv(options.env) })
}

export function runGitBuffer(args: readonly string[], options: Omit<ExecFileSyncOptions, 'encoding'>): Buffer {
  return execFileSync('git', gitChildArgs(args), { ...options, env: gitChildEnv(options.env) }) as Buffer
}

export function spawnGit(args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn('git', gitChildArgs(args), { ...options, env: gitChildEnv(options.env) })
}

export function spawnGitSync(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  return spawnSync('git', gitChildArgs(args), { ...options, env: gitChildEnv(options.env) })
}
