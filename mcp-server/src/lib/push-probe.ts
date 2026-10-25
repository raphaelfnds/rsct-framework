import { spawnSync } from 'node:child_process'

export interface ProbedRef {
  url: string
  flag: string
  to: string
  old: string | null
  next: string | null
}

export type PushProbeResult = { status: 'parsed'; refs: ProbedRef[] } | { status: 'unavailable' }

export type PushProbe = (projectRoot: string, remote: string, refspec: string) => PushProbeResult

export const PUSH_PROBE_TIMEOUT_MS = 20_000

const LINE = /^([ +\-*!=])\t([^\t]*)\t(.*)$/
const RANGE = /^([0-9a-f]{4,64})\.{2,3}([0-9a-f]{4,64})/i

export function parsePushPorcelain(stdout: string): PushProbeResult {
  const refs: ProbedRef[] = []
  let url: string | null = null
  for (const raw of stdout.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('To ')) {
      url = raw.slice(3)
      continue
    }
    if (url === null) continue
    const m = LINE.exec(raw)
    if (!m) continue
    const colon = m[2]!.lastIndexOf(':')
    if (colon < 0) continue
    const range = RANGE.exec(m[3]!.trim())
    refs.push({
      url,
      flag: m[1]!,
      to: m[2]!.slice(colon + 1),
      old: range ? range[1]! : null,
      next: range ? range[2]! : null,
    })
  }
  return refs.length > 0 ? { status: 'parsed', refs } : { status: 'unavailable' }
}

export function probeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' }
  delete env.GIT_ASKPASS
  delete env.SSH_ASKPASS
  return env
}

const PROBE_GIT_OPTIONS = ['-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'credential.interactive=never']

export const defaultPushProbe: PushProbe = (projectRoot, remote, refspec) => {
  const r = spawnSync('git', [...PROBE_GIT_OPTIONS, 'push', '--dry-run', '--porcelain', '--no-verify', '--', remote, refspec], {
    cwd: projectRoot,
    env: probeEnv(process.env),
    encoding: 'utf8',
    timeout: PUSH_PROBE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  })
  if (r.error || typeof r.stdout !== 'string') return { status: 'unavailable' }
  if (r.status !== 0 && r.status !== 1) return { status: 'unavailable' }
  return parsePushPorcelain(r.stdout)
}
