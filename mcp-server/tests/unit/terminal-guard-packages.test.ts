import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { judgeCommand, type AliasResolver, type ShellDialect, type TerminalVerdict } from '../../src/lib/terminal-guard.js'
import { resolveFolder, type PackageLister, type PackageReader } from '../../src/lib/package-scripts.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })
const ROOT = resolve('/virtual/shop')

type Tree = Record<string, string | null>

function memoryFs(tree: Tree, complete = true): { readPackage: PackageReader; listPackages: PackageLister } {
  const entries = new Map<string, string | null>()
  for (const [rel, text] of Object.entries(tree)) entries.set(resolve(ROOT, rel), text)
  return {
    readPackage: (p) => {
      const key = resolve(p)
      if (!entries.has(key)) return { kind: 'missing' }
      const text = entries.get(key)
      return text === null || text === undefined ? { kind: 'unreadable', reason: `${key} is not a regular file` } : { kind: 'text', text }
    },
    listPackages: (root, file) => ({
      files: [...entries.keys()].filter((k) => basename(k) === file && entries.get(k) !== null && k.startsWith(resolve(root))),
      complete,
    }),
  }
}

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'shop', scripts }, null, 2)

const SHOP: Tree = {
  '.git': null,
  'package.json': pkg({
    release: 'git commit -am release && git push',
    chain: 'npm run release',
    deploy: "sh -c 'git push origin main'",
    caret: 'g^it push',
    tidy: 'cd packages/web && npm run ship',
    build: 'tsc -p .',
    test: 'vitest run',
    pretest: 'node scripts/check.js',
    postinstall: 'husky',
    loop: 'npm run loop',
    prepublishOnly: 'git push --tags',
    stage: 'echo stage',
    prestage: 'git push',
    regen: `node -e "require('fs').writeFileSync('package.json', '{}')" && npm run build`,
    prepare: 'node scripts/check-pkg.js package.json',
  }),
  'packages/web/package.json': pkg({ release: 'echo web', ship: 'git push', build: 'vite build' }),
  'packages/api/package.json': pkg({ build: 'tsc' }),
  'composer.json': JSON.stringify({
    scripts: {
      deploy: ['@php artisan optimize', 'git push'],
      'post-install-cmd': ['@php artisan package:discover'],
      ok: 'phpunit',
      nested: '@deploy',
      both: ['@composer ok', '@composer deploy'],
      cb: 'App\\Console\\Hooks::run',
    },
  }),
}

function judge(command: string, opts: { dialect?: ShellDialect; cwd?: string; tree?: Tree; complete?: boolean; database?: boolean } = {}): TerminalVerdict {
  return judgeCommand(command, {
    dialect: opts.dialect ?? 'bash',
    cwd: opts.cwd ?? ROOT,
    resolveAlias: NO_ALIASES,
    database: opts.database,
    ...memoryFs(opts.tree ?? SHOP, opts.complete ?? true),
  })
}

const REFUSED = [
  'npm run release',
  'npm run-script release',
  'npm run chain',
  'npm run deploy',
  'npm run caret',
  'npm run tidy',
  'yarn release',
  'yarn run release',
  'pnpm release',
  'pnpm run release',
  'bun run release',
  'bun release',
  'corepack pnpm release',
  'npm --prefix packages/web run ship',
  'npm run ship --prefix=packages/web',
  'pnpm -C packages/web ship',
  'pnpm --dir packages/web run ship',
  'yarn --cwd packages/web ship',
  'cd packages/web && npm run ship',
  'cd packages && cd web && npm run ship',
  'pushd packages/web && npm run ship',
  '(cd packages/web && npm run ship)',
  '(cd packages/web) && npm run release',
  'cd packages/web | cat; npm run release',
  'npm run ship --workspaces',
  'npm run ship -w web',
  'pnpm -r ship',
  'pnpm --filter web ship',
  'yarn workspaces foreach run ship',
  'yarn workspace web ship',
  'npm publish',
  'npm run build && npm run release',
  'sh -c "npm run release"',
  'cmd /c npm run release',
  'env CI=1 npm run release',
  'sudo npm run release',
  'composer deploy',
  'composer run-script deploy',
  'composer nested',
  'composer both',
  'php composer.phar deploy',
  'npm version patch',
  'npm version 2.0.0 --no-commit-hooks',
  'pnpm version minor',
  'yarn version',
  'yarn version --new-version 2.0.0',
  'npx git commit -am x',
  'npm exec -- git push',
  'pnpm exec git push',
  'pnpm git push',
  'yarn exec git push',
  'bunx git push',
  'bun x git push',
  'bun exec "git push"',
  'npx -c "git push"',
  'npm run "$TARGET"',
  'npm $CMD',
  'npm run stage',
  'pushd packages/web && popd && npm run release',
  'npx -c "cat notes.txt | sh"',
  'bun exec "cat notes.txt | sh"',
  'cat notes.txt | pnpm exec sh',
  'cat notes.txt | yarn exec bash',
  'cat notes.txt | pnpm bash',
  'npm run regen',
]

const ALLOWED = [
  'npm test',
  'npm run build',
  'npm install',
  'npm ci',
  'npm run missing',
  'npm run loop',
  'yarn build',
  'pnpm build',
  'bun run build',
  'npm run build --workspaces',
  'cd packages/web && npm run release',
  '(cd packages/web) && npm run build',
  '(cd packages/web); npm test',
  'composer ok',
  'composer install',
  'composer cb',
  'npm version',
  'npm version patch --no-git-tag-version',
  'npm version patch --git-tag-version=false',
  'npm version patch --git-tag-version false',
  'cat package.json && npm test',
  'cp package.json dist/ && npm run build',
  'git add package.json && npm test',
  'jq .scripts package.json; npm test',
  'npx vitest run',
  'npx tsc --noEmit && npm test',
  'npm exec $BIN',
  'pnpm exec eslint .',
  'bunx prettier --check .',
  'npm test 2>&1 | tail -20',
  'npm run build -- --watch',
]

const WRITE_THEN_RUN = [
  "echo '{}' > package.json && npm test",
  "npm pkg set scripts.x='node x.js' && npm run x",
  'cp other.json package.json && npm test',
  "sed -i 's/a/b/' package.json && npm test",
  `node -e "require('fs').writeFileSync('package.json', '{}')" && npm test`,
  'mv next.json package.json; npm test',
  'tee package.json < next.json && npm install',
  'git checkout stash@{0} -- package.json && npm run build',
  "composer config scripts.x 'phpunit' && composer x",
]

describe('terminal guard — package scripts that run git', () => {
  it.each(REFUSED)('refuses: %s', (c) => {
    expect(judge(c).verdict).toBe('deny')
  })
  it.each(ALLOWED)('allows: %s', (c) => {
    expect(judge(c).verdict).toBe('allow')
  })
  it.each(WRITE_THEN_RUN)('refuses a package file change and a script run in one command: %s', (c) => {
    const v = judge(c)
    expect(v.verdict === 'deny' && v.reason).toMatch(/changes a package file and runs package scripts in the same go/)
  })

  it('names the script, the file and the refused verb', () => {
    const v = judge('npm run release')
    expect(v.verdict === 'deny' && v.reason).toMatch(/the package\.json script 'release' that this command runs is refused/)
    expect(v.verdict === 'deny' && v.reason).toMatch(/`git commit` from the terminal is refused/)
  })

  it('says how to run a version bump without the commit', () => {
    const v = judge('npm version minor')
    expect(v.verdict === 'deny' && v.reason).toMatch(/--no-git-tag-version/)
  })

  it('refuses when the package file cannot be read, and allows when there is none', () => {
    expect(judge('npm test', { tree: { 'package.json': '{ "scripts": ' } }).verdict).toBe('deny')
    expect(judge('npm test', { tree: { 'package.json': '[]' } }).verdict).toBe('deny')
    const dir = judge('npm test', { tree: { 'package.json': null } })
    expect(dir.verdict === 'deny' && dir.reason).toMatch(/not a regular file/)
    expect(judge('npm run release', { tree: {} }).verdict).toBe('allow')
  })

  it('reads a package file that starts with a byte order mark', () => {
    expect(judge('npm test', { tree: { 'package.json': '\uFEFF' + pkg({ test: 'git push' }) } }).verdict).toBe('deny')
    expect(judge('npm test', { tree: { 'package.json': '\uFEFF' + pkg({ test: 'vitest run' }) } }).verdict).toBe('allow')
  })

  it('refuses a workspace-wide run when the package files cannot all be listed', () => {
    const v = judge('npm run build --workspaces', { complete: false })
    expect(v.verdict === 'deny' && v.reason).toMatch(/more package files than the guard reads/)
  })

  it('finds the package file in a parent folder, as npm does', () => {
    expect(judge('npm run release', { cwd: join(ROOT, 'docs', 'guide') }).verdict).toBe('deny')
  })

  it('judges the scripts in the starting folder after a folder change it cannot read', () => {
    expect(judge('cd "$DIR" && npm run release').verdict).toBe('deny')
    expect(judge('cd "../$X" && npm run ship', { cwd: join(ROOT, 'packages', 'web') }).verdict).toBe('deny')
  })

  it('judges the hooks that install, ci and composer install run', () => {
    const hooks: Tree = { 'package.json': pkg({ postinstall: 'git push' }), 'composer.json': JSON.stringify({ scripts: { 'post-install-cmd': 'git push' } }) }
    for (const c of ['npm install', 'npm ci', 'npm i lodash', 'yarn', 'pnpm install', 'bun install', 'composer install', 'composer update']) {
      expect(judge(c, { tree: hooks }).verdict).toBe('deny')
    }
    expect(judge('npm run build', { tree: hooks }).verdict).toBe('allow')
  })
})

describe('terminal guard — package scripts (PowerShell)', () => {
  const REFUSED_POWERSHELL = [
    'npm run release',
    'Set-Location packages/web; npm run ship',
    'cd packages/web; npm run ship',
    'Set-Location -Path packages/web; npm run ship',
    'Push-Location packages/web; npm run ship',
  ]
  const ALLOWED_POWERSHELL = ['npm test', 'Get-Content package.json; npm test', 'Set-Location packages/web; npm run release']
  it.each(REFUSED_POWERSHELL)('refuses: %s', (c) => {
    expect(judge(c, { dialect: 'powershell' }).verdict).toBe('deny')
  })
  it.each(ALLOWED_POWERSHELL)('allows: %s', (c) => {
    expect(judge(c, { dialect: 'powershell' }).verdict).toBe('allow')
  })
  it('refuses a package file change and a script run in one command', () => {
    expect(judge("Set-Content package.json '{}'; npm test", { dialect: 'powershell' }).verdict).toBe('deny')
  })
})

describe('terminal guard — package scripts on disk', () => {
  const base = mkdtempSync(join(tmpdir(), 'rsct-guard-pkg-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const app = join(base, 'app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), pkg({ ship: 'git push', build: 'tsc' }))
  mkdirSync(join(base, 'odd', 'package.json'), { recursive: true })
  const real = (command: string): string => judgeCommand(command, { cwd: base, resolveAlias: NO_ALIASES }).verdict

  it('follows a folder change written as an absolute path', () => {
    expect(real(`cd "${app}" && npm run ship`)).toBe('deny')
    expect(real(`cd '${app.replace(/\\/g, '/')}' && npm run ship`)).toBe('deny')
    expect(real(`cd "${app}" && npm run build`)).toBe('allow')
  })

  it('refuses when the package file is a folder', () => {
    expect(real('cd odd && npm test')).toBe('deny')
  })

  it.runIf(process.platform === 'win32')('reads a Git Bash drive path as a Windows path', () => {
    expect(resolveFolder(undefined, '/c/Users')).toBe('C:\\Users')
    const drive = app.slice(0, 1).toLowerCase()
    expect(real(`cd /${drive}${app.slice(2).replace(/\\/g, '/')} && npm run ship`)).toBe('deny')
  })
})

describe('terminal guard — package scripts, false refusals closed in REVIEW', () => {
  const version = { 'package.json': pkg({ postversion: 'git push', build: 'tsc' }) }
  const prepare = { 'package.json': pkg({ prepare: 'git push' }) }

  it('does not treat a package-file write on its own as running scripts', () => {
    for (const c of ['npm init -y', 'npm pkg get version', 'npm pkg get name', 'npm create vite@latest app', 'composer config --list', 'composer config -l']) {
      expect(judge(c).verdict).toBe('allow')
    }
  })

  it('reading a package field is not a write, so a later script run is not refused', () => {
    expect(judge('npm pkg get version && npm run build').verdict).toBe('allow')
    expect(judge('npm pkg set scripts.x=y && npm run build').verdict).toBe('deny')
  })

  it('judges the package file in the folder a later manager actually reads', () => {
    expect(judge("cd sub && echo '{}' > ../package.json && npm test").verdict).toBe('deny')
  })

  it('only reads the real script-name position, not every argument word', () => {
    for (const c of ['npm view react version', 'npm info vite version', 'npm show typescript version', 'npm help version', 'npm version']) {
      expect(judge(c, { tree: version }).verdict).toBe('allow')
    }
    expect(judge('npm version patch', { tree: version }).verdict).toBe('deny')
    expect(judge('npm version patch --no-git-tag-version', { tree: version }).verdict).toBe('deny')
  })

  it('skips the local package file for a global call', () => {
    for (const c of ['npm root -g', 'npm config get prefix', 'npm install -g some-cli', 'npm i --global some-cli']) {
      expect(judge(c, { tree: { 'package.json': pkg({ postinstall: 'git push' }) } }).verdict).toBe('allow')
    }
    expect(judge('npm install', { tree: { 'package.json': pkg({ postinstall: 'git push' }) } }).verdict).toBe('deny')
  })

  it('reads pnpm -w as a flag, not an option that swallows the next word', () => {
    expect(judge('pnpm -w install', { tree: prepare }).verdict).toBe('deny')
    expect(judge('pnpm -w add -D typescript', { tree: prepare }).verdict).toBe('deny')
    expect(judge('pnpm add -w -D typescript', { tree: prepare }).verdict).toBe('deny')
  })

  it('counts a copy or move of a package file into the folder a later script reads', () => {
    for (const c of ['cp ../other/package.json . && npm test', 'cp -t . ../other/package.json && npm test', 'mv ../other/package.json . ; npm test', 'cp ../other/package.json sub && cd sub && npm test']) {
      expect(judge(c).verdict).toBe('deny')
    }
    expect(judge('cp package.json dist/ && npm test').verdict).toBe('allow')
  })

  it('skips the hooks a no-scripts switch turns off, but still runs the script named on the command line', () => {
    const hooks = { 'package.json': pkg({ postinstall: 'git push', pretest: 'git push', test: 'vitest run', release: 'git push', prestage: 'git push', stage: 'echo stage' }) }
    for (const c of ['npm install --ignore-scripts', 'npm install --ignore-scripts=true', 'npm install --ignore-scripts true', 'npm ci --ignore-scripts', 'npm test --ignore-scripts', 'npm run stage --ignore-scripts']) {
      expect(judge(c, { tree: hooks }).verdict).toBe('allow')
    }
    for (const c of ['npm install', 'npm install --ignore-scripts=false', 'npm install --ignore-scripts false', 'npm --ignore-scripts false install', 'npm run release --ignore-scripts', 'npm run stage -- --ignore-scripts']) {
      expect(judge(c, { tree: hooks }).verdict).toBe('deny')
    }
    expect(judge('npm test --ignore-scripts', { tree: { 'package.json': pkg({ test: 'git push' }) } }).verdict).toBe('deny')
  })

  it('reads a true or false after a flag as that flag\'s value, the way npm does', () => {
    expect(judge('npm --json false run release').verdict).toBe('deny')
    expect(judge('npm --loglevel-quiet true install', { tree: { 'package.json': pkg({ postinstall: 'git push' }) } }).verdict).toBe('deny')
  })

  it('runs the composer install events but not the create-project ones on composer install', () => {
    const laravel = { 'composer.json': JSON.stringify({ scripts: { 'post-create-project-cmd': ['git push'], 'post-root-package-install': ['git push'] } }) }
    expect(judge('composer install', { tree: laravel }).verdict).toBe('allow')
    expect(judge('composer update', { tree: laravel }).verdict).toBe('allow')
    expect(judge('composer create-project', { tree: laravel }).verdict).toBe('deny')
    const install = { 'composer.json': JSON.stringify({ scripts: { 'post-install-cmd': ['git push'] } }) }
    expect(judge('composer install', { tree: install }).verdict).toBe('deny')
    expect(judge('composer install --no-scripts', { tree: install }).verdict).toBe('allow')
  })

  it('honours a no-scripts switch only for npm and composer, never after the script name for pnpm/yarn/bun', () => {
    const hooks = { 'package.json': pkg({ preship: 'git push', ship: 'echo ship', dbship: 'echo x', predbship: 'git push', pretest: 'git push', test: 'echo t' }) }
    for (const c of ['pnpm run ship --ignore-scripts', 'yarn run ship --ignore-scripts', 'yarn ship --ignore-scripts', 'bun run ship --ignore-scripts', 'pnpm test --ignore-scripts', 'pnpm run dbship --ignore-scripts']) {
      expect(judge(c, { tree: hooks }).verdict).toBe('deny')
    }
    expect(judge('npm run ship --ignore-scripts', { tree: hooks }).verdict).toBe('allow')
  })

  it('reads npm t and npm tst as the test script, like npm does', () => {
    const t = { 'package.json': pkg({ pretest: 'git push', test: 'vitest run' }) }
    for (const c of ['npm t', 'npm tst', 'pnpm t']) {
      expect(judge(c, { tree: t }).verdict).toBe('deny')
    }
  })

  it('keeps npm start/stop/restart under a no-scripts switch', () => {
    const tree = { 'package.json': pkg({ start: 'git push', stop: 'git push', restart: 'git push' }) }
    for (const c of ['npm start --ignore-scripts', 'npm stop --ignore-scripts', 'npm restart --ignore-scripts']) {
      expect(judge(c, { tree }).verdict).toBe('deny')
    }
  })

  it('reads a true or false after an npm flag, but a composer argument is not a flag value', () => {
    expect(judge('npm --loglevel false run release').verdict).toBe('deny')
    expect(judge('composer true', { tree: { 'composer.json': JSON.stringify({ scripts: { true: 'git push' } }) } }).verdict).toBe('deny')
  })

  it('reads a package script a database command runs behind a wrapper', () => {
    const tree = { 'package.json': pkg({ migrate: 'prisma migrate deploy', build: 'tsc' }) }
    for (const c of ['docker compose exec app npm run migrate', 'cross-env NODE_ENV=test npm run migrate', 'dotenv -- npm run migrate', 'sail npm run migrate']) {
      expect(judge(c, { tree, database: true }).verdict).toBe('deny')
    }
    expect(judge('docker compose exec app npm run build', { tree, database: true }).verdict).toBe('allow')
  })

  it('reads a Windows 8.3 short name as the package file it stands for', () => {
    expect(judge("echo '{}' > PACKAG~1.JSO && npm test").verdict).toBe('deny')
    expect(judge("echo '{}' > COMPOS~1.JSO && composer ok").verdict).toBe('deny')
  })
})

describe('terminal guard — package scripts via the PowerShell call operator', () => {
  for (const op of ['&', '.']) {
    it(`judges a manager run through '${op}'`, () => {
      expect(judge(`${op} npm run release`, { dialect: 'powershell' }).verdict).toBe('deny')
      expect(judge(`${op} npm test`, { dialect: 'powershell' }).verdict).toBe('allow')
    })
  }
  it("judges a quoted manager path invoked with '&'", () => {
    expect(judge('& "C:\\Program Files\\nodejs\\npm.cmd" run release', { dialect: 'powershell' }).verdict).toBe('deny')
  })
  it("keeps the git text exemptions for a program run through '&'", () => {
    expect(judge('& gh pr create --body "runs git push in CI"', { dialect: 'powershell' }).verdict).toBe('allow')
    expect(judge('& git log --grep "git push"', { dialect: 'powershell' }).verdict).toBe('allow')
  })
})

describe('terminal guard — a variable command after a runner value option', () => {
  const run = (c: string): string => judgeCommand(c, { resolveAlias: NO_ALIASES }).verdict
  it('refuses a variable program that a runner value option precedes', () => {
    for (const c of ['CMD=x; nice -n 5 $CMD', 'CMD=x; timeout 5 $CMD', 'CMD=x; sudo -u bob $CMD', 'CMD=x; stdbuf -o0 $CMD', 'CMD=x; ionice -c 3 $CMD', 'CMD=x; xargs -n1 $CMD']) {
      expect(run(c)).toBe('deny')
    }
  })
  it('still allows a literal program after a runner value option', () => {
    for (const c of ['nice -n 5 ls', 'timeout 5 cat x', 'sudo -u bob whoami']) {
      expect(run(c)).toBe('allow')
    }
  })
})

describe('terminal guard — backslashes inside bash double quotes', () => {
  it('keeps a backslash that bash keeps, so a quoted Windows path to git is read', () => {
    expect(judge('"C:\\Program Files\\Git\\bin\\git.exe" push origin main').verdict).toBe('deny')
    expect(judge('"C:\\Program Files\\Git\\cmd\\git.exe" commit -am x').verdict).toBe('deny')
  })
  it('still drops the backslash before $, `, " and \\', () => {
    expect(judge('echo "a \\"git push\\" b"').verdict).toBe('allow')
    expect(judge('sh -c "git \\\\ push"').verdict).toBe('allow')
  })
})
