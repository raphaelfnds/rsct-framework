import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const REPO = resolve(__dirname, '..', '..', '..')
const SCANNED_DIRS = [
  'docs',
  'prompts',
  'rules',
  'memory-templates',
  'doc-templates',
  'universe-templates',
  'examples',
  'scripts',
  '.github',
  join('mcp-server', 'src'),
]
const SCANNED_FILES = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'CLAUDE.md',
  join('mcp-server', 'README.md'),
]
const TEXT = /\.(md|sh|ts|mjs|cjs|js|json|ya?ml|template|txt)$/

const NAME = String.raw`["'\x60]?(?:@[\w.-]+\/)?rsct-mcp(?:@[\w.^~<>=*-]+)?(?![\w/-]|\.\w)`
const FLAG = String.raw`-{1,2}\w[\w=.]*(?:-[\w=.]+)*`
const FLAGS = String.raw`(?:\s+${FLAG})*`
const CMD = String.raw`(?:\.cmd)?`
const RUNNERS = String.raw`(?:(?:npx|pnpx|bunx)${CMD}|(?:pnpm|yarn)${CMD}\s+dlx|npm${CMD}\s+(?:exec|x)|bun${CMD}\s+x)`
const QUOTED_NAME = String.raw`["'](?:@[\w.-]+\/)?rsct-mcp(?:@[^"']*)?["']`
const INSTALLS = [
  new RegExp(String.raw`\b(?:npm|pnpm|bun)${CMD}${FLAGS}\s+(?:install|i|add|update|upgrade|up)\b${FLAGS}\s+${NAME}`),
  new RegExp(String.raw`\byarn${CMD}${FLAGS}\s+(?:global\s+)?(?:add|upgrade)\b${FLAGS}\s+${NAME}`),
  new RegExp(String.raw`\b${RUNNERS}\b(?:\s+(?:${FLAG}|--))*\s+${NAME}`),
  new RegExp(String.raw`\b${RUNNERS}\b[^\n&|;]*\s(?:-p|--package)[=\s]+${NAME}`),
]
const COMMAND_KEY = /["']?command["']?\s*:/
const RUNNER_ENTRY = new RegExp(
  String.raw`["']?command["']?\s*:\s*["'](?:npx|pnpx|bunx|pnpm|yarn|npm|bun)${CMD}["']|["'](?:npx|pnpx|bunx)${CMD}["']`,
)
const NAMED_IN_ENTRY = new RegExp(QUOTED_NAME)
const PUBLISHES = /\bpublish\b|semantic-release/i
const REACH = 8

function serverEntryAround(lines: string[], index: number): string {
  let start = index
  while (start > 0 && index - start < REACH && !COMMAND_KEY.test(lines[start - 1] ?? '')) start--
  let end = index
  while (end < lines.length - 1 && end - index < REACH && !COMMAND_KEY.test(lines[end + 1] ?? '')) end++
  return lines.slice(start, end + 1).join('\n')
}

function registryInstallIn(text: string): string[] {
  const lines = text.split('\n')
  return lines.filter((line, index) => {
    if (INSTALLS.some((pattern) => pattern.test(line))) return true
    return RUNNER_ENTRY.test(line) && NAMED_IN_ENTRY.test(serverEntryAround(lines, index))
  })
}

function textFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = join(dir, item.name)
    if (item.isDirectory()) return item.name === 'node_modules' || item.name === 'dist' ? [] : textFiles(full)
    return TEXT.test(item.name) ? [full] : []
  })
}

describe('the companion is not installed from a package registry (#112)', () => {
  it('recognises a registry install or a package-runner call of the companion, and nothing else', () => {
    const flagged = [
      'npm install -g rsct-mcp',
      'npm i -g rsct-mcp',
      'npm install rsct-mcp',
      'npm install rsct-mcp --global',
      'npm install -g --force rsct-mcp',
      'npm i -g "rsct-mcp"',
      'run `npm install -g `rsct-mcp` first',
      'pnpm add -g rsct-mcp',
      'bun add -g @someone/rsct-mcp',
      'yarn global add rsct-mcp',
      'yarn add rsct-mcp',
      'npx rsct-mcp',
      'npx -y rsct-mcp',
      'npx --yes -- rsct-mcp',
      'npx -p rsct-mcp rsct',
      'pnpm dlx rsct-mcp',
      'yarn dlx rsct-mcp',
      'bunx rsct-mcp',
      'pnpx rsct-mcp',
      'npm x rsct-mcp',
      'npm x -y rsct-mcp',
      'npm exec -- rsct-mcp',
      'bun x rsct-mcp',
      'npm install --save-dev rsct-mcp',
      'npm exec --package=rsct-mcp rsct',
      'npm -g install rsct-mcp',
      'pnpm -g add rsct-mcp',
      'npm install -g rsct-mcp@latest',
      'Then run npm install -g rsct-mcp.',
      '{ "command": "npx", "args": ["rsct-mcp"] }',
      '{ "command": "bun", "args": ["x", "rsct-mcp"] }',
      '{ "command": "cmd", "args": ["/c", "npx", "-y", "rsct-mcp"] }',
      '{ "args": ["-y", "rsct-mcp@2"], "command": "npx" }',
      "{ command: 'npx', args: ['-y', 'rsct-mcp'] }",
      '{ "command": "npx.cmd", "args": ["rsct-mcp"] }',
      'npm.cmd install -g rsct-mcp',
      'npm update -g rsct-mcp',
      'npm upgrade -g rsct-mcp',
      'pnpm up -g rsct-mcp',
      'yarn global upgrade rsct-mcp',
      'npx.cmd -y rsct-mcp',
      'npm.cmd exec rsct-mcp',
    ]
    const allowed = [
      'npm install -g . --install-links=false',
      'npm install && npm run build && npm install -g . --install-links=false',
      'npm uninstall -g rsct-mcp',
      'claude mcp add rsct rsct-mcp --scope user',
      '{ "command": "rsct-mcp", "args": [] }',
      '{ "command": "npx", "args": ["some-other-server"] }',
      'registered by absolute path or via `npx`',
      'npx vitest run',
      'npm install -g ./rsct-mcp',
      'npm install --prefix ./rsct-mcp',
      'npm explain rsct-mcp',
      'npm install -g . --install-links=false puts `rsct-mcp` on the PATH',
      'npm install -g rsct-mcp-2.14.0.tgz',
      'npx tsc && mkdir -p rsct-mcp',
    ]
    expect(flagged.filter((line) => registryInstallIn(line).length === 1)).toEqual(flagged)
    expect(allowed.filter((line) => registryInstallIn(line).length > 0)).toEqual([])
    expect(registryInstallIn('{\n  "command": "npx",\n  "args": [\n    "-y",\n    "rsct-mcp"\n  ]\n}')).toEqual(['  "command": "npx",'])
    expect(registryInstallIn('{\n  "args": [\n    "-y",\n    "rsct-mcp"\n  ],\n  "command": "npx"\n}')).toEqual(['  "command": "npx"'])
    expect(registryInstallIn('"command": "cmd",\n"args": [\n  "/c",\n  "npx",\n  "-y",\n  "rsct-mcp"\n]')).toEqual(['  "npx",'])
    expect(
      registryInstallIn('{\n  "command": "npx",\n  "env": { "A": "1" },\n  "args": ["-y", "rsct-mcp"]\n}'),
    ).toEqual(['  "command": "npx",'])
    const twoServers = [
      '{',
      '  "other": {',
      '    "command": "npx",',
      '    "args": ["-y", "some-other-server"]',
      '  },',
      '  "rsct": {',
      '    "command": "rsct-mcp"',
      '  }',
      '}',
    ]
    expect(registryInstallIn(twoServers.join('\n'))).toEqual([])
    const companionFirst = [
      '{',
      '  "rsct": { "command": "rsct-mcp" },',
      '  "other": {',
      '    "command": "npx",',
      '    "args": ["-y", "some-other-server"]',
      '  }',
      '}',
    ]
    expect(registryInstallIn(companionFirst.join('\n'))).toEqual([])
    const farApart = (gap: number): string => ['"command": "npx",', ...Array.from({ length: gap - 1 }, () => '"x",'), '"rsct-mcp"'].join('\n')
    expect(registryInstallIn(farApart(8))).toEqual(['"command": "npx",'])
    expect(registryInstallIn(farApart(9))).toEqual([])
  })

  it('no shipped page, prompt, rule, template, script, workflow or source file contains one', () => {
    const files = [
      ...SCANNED_DIRS.flatMap((dir) => textFiles(join(REPO, dir))),
      ...SCANNED_FILES.map((file) => join(REPO, file)).filter((file) => existsSync(file)),
    ]
    expect(SCANNED_DIRS.filter((dir) => textFiles(join(REPO, dir)).length === 0)).toEqual([])
    expect(SCANNED_FILES.filter((file) => !existsSync(join(REPO, file)))).toEqual([])
    expect(files.some((file) => file.endsWith('sync-version.mjs'))).toBe(true)
    const hits = files.flatMap((file) =>
      registryInstallIn(readFileSync(file, 'utf8')).map((line) => `${relative(REPO, file).split(sep).join('/')}: ${line.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('SECURITY.md keeps saying where the companion comes from', () => {
    const security = readFileSync(join(REPO, 'SECURITY.md'), 'utf8')
    expect(security).toContain('### `rsct-mcp` is not distributed through npm')
    expect(security).toMatch(/publishes nothing to the npm registry/)
    expect(security).toMatch(/is not ours/)
  })

  it('nothing in the repository publishes the package', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'mcp-server', 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.publishConfig).toBeUndefined()
    const scripts = Object.values((manifest.scripts ?? {}) as Record<string, string>)
    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts.filter((script) => PUBLISHES.test(script))).toEqual([])
    const automation = [...textFiles(join(REPO, '.github', 'workflows')), ...textFiles(join(REPO, 'scripts'))]
    expect(automation.some((file) => file.includes('workflows'))).toBe(true)
    expect(automation.some((file) => file.endsWith('install.sh'))).toBe(true)
    expect(
      automation.filter((file) => PUBLISHES.test(readFileSync(file, 'utf8'))).map((file) => relative(REPO, file).split(sep).join('/')),
    ).toEqual([])
    const publishing = ['npm publish', 'pnpm -r publish', 'uses: JS-DevTools/npm-publish@v3', 'npx changeset publish', 'npx semantic-release']
    expect(publishing.filter((line) => PUBLISHES.test(line))).toEqual(publishing)
    expect(PUBLISHES.test('npm run build && npm test')).toBe(false)
  })
})
