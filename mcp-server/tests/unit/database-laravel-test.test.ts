import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeCommand, type AliasResolver } from '../../src/lib/terminal-guard.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })
const roots: string[] = []

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-laravel-'))
  roots.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true })
})

const LARAVEL_COMPOSER = JSON.stringify({ require: { 'laravel/framework': '^11.0' } })
const PHPUNIT = (env: string): string => `<?xml version="1.0"?>\n<phpunit>\n  <php>\n${env}\n  </php>\n</phpunit>\n`
const judge = (command: string, cwd: string, databaseTestGuard = true): string =>
  judgeCommand(command, { cwd, resolveAlias: NO_ALIASES, database: true, databaseTestGuard }).verdict

describe('terminal guard — Laravel test database (5B)', () => {
  it('refuses a Laravel test run when no disposable test database is configured', () => {
    const dir = project({ 'composer.json': LARAVEL_COMPOSER, artisan: '#!/usr/bin/env php\n', 'phpunit.xml': PHPUNIT('    <env name="APP_ENV" value="testing"/>') })
    for (const c of ['php artisan test', 'phpunit', 'vendor/bin/phpunit', './vendor/bin/pest', 'php artisan test --filter X']) {
      const v = judgeCommand(c, { cwd: dir, resolveAlias: NO_ALIASES, database: true })
      expect(v.verdict).toBe('deny')
      expect(v.verdict === 'deny' && v.reason).toMatch(/throwaway test database/)
    }
  })

  it('allows the test run when phpunit.xml forces an in-memory sqlite database', () => {
    const dir = project({
      'composer.json': LARAVEL_COMPOSER,
      artisan: '#!/usr/bin/env php\n',
      'phpunit.xml': PHPUNIT('    <env name="DB_CONNECTION" value="sqlite" force="true"/>\n    <env name="DB_DATABASE" value=":memory:" force="true"/>'),
    })
    expect(judge('php artisan test', dir)).toBe('allow')
    expect(judge('phpunit', dir)).toBe('allow')
  })

  it('refuses even when .env.testing names a disposable database: only force="true" in phpunit.xml counts', () => {
    const dir = project({
      'composer.json': LARAVEL_COMPOSER,
      artisan: '#!/usr/bin/env php\n',
      'phpunit.xml': PHPUNIT('    <env name="APP_ENV" value="testing"/>'),
      '.env.testing': 'APP_ENV=testing\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\n',
    })
    const v = judgeCommand('php artisan test', { cwd: dir, resolveAlias: NO_ALIASES, database: true })
    expect(v.verdict).toBe('deny')
    expect(v.verdict === 'deny' && v.reason).not.toMatch(/\.env\.testing —/)
  })

  it('refuses when phpunit.xml forces a non-disposable database, even if .env.testing is disposable', () => {
    const dir = project({
      'composer.json': LARAVEL_COMPOSER,
      artisan: '#!/usr/bin/env php\n',
      'phpunit.xml': PHPUNIT('    <env name="DB_CONNECTION" value="mysql" force="true"/>\n    <env name="DB_DATABASE" value="production" force="true"/>'),
      '.env.testing': 'DB_CONNECTION=sqlite\nDB_DATABASE=:memory:\n',
    })
    expect(judge('php artisan test', dir)).toBe('deny')
  })

  it('does not fire on a non-Laravel PHP project (bare phpunit)', () => {
    const dir = project({ 'composer.json': JSON.stringify({ require: { 'phpunit/phpunit': '^11' } }) })
    expect(judge('phpunit', dir)).toBe('allow')
    expect(judge('vendor/bin/phpunit', dir)).toBe('allow')
  })

  it('does not fire on a project with an artisan file but no laravel/framework', () => {
    const dir = project({ 'composer.json': JSON.stringify({ require: { 'symfony/console': '^7' } }), artisan: '#!/usr/bin/env php\n', 'phpunit.xml': PHPUNIT('    <env name="APP_ENV" value="testing"/>') })
    expect(judge('php artisan test', dir)).toBe('allow')
  })

  it('does not fire when the Laravel test switch is off', () => {
    const dir = project({ 'composer.json': LARAVEL_COMPOSER, artisan: '#!/usr/bin/env php\n', 'phpunit.xml': PHPUNIT('    <env name="APP_ENV" value="testing"/>') })
    expect(judge('php artisan test', dir, false)).toBe('allow')
  })

  it('still refuses a real database change in a Laravel project regardless of the test switch', () => {
    const dir = project({ 'composer.json': LARAVEL_COMPOSER, artisan: '#!/usr/bin/env php\n' })
    expect(judge('php artisan migrate:fresh', dir, false)).toBe('deny')
  })
})

const BASE = { 'composer.json': LARAVEL_COMPOSER, artisan: '#!/usr/bin/env php\n' }
const FORCED_SQLITE = PHPUNIT('    <env name="DB_CONNECTION" value="sqlite" force="true"/>\n    <env name="DB_DATABASE" value=":memory:" force="true"/>')
const UNFORCED = PHPUNIT('    <env name="DB_CONNECTION" value="sqlite"/>\n    <env name="DB_DATABASE" value=":memory:"/>')
const forcedDb = (connection: string, database: string): string =>
  PHPUNIT(`    <env name="DB_CONNECTION" value="${connection}" force="true"/>\n    <env name="DB_DATABASE" value="${database}" force="true"/>`)
const reasonOf = (command: string, cwd: string): string => {
  const v = judgeCommand(command, { cwd, resolveAlias: NO_ALIASES, database: true })
  return v.verdict === 'deny' ? v.reason : ''
}
const slashes = (p: string): string => p.replace(/\\/g, '/')

describe('terminal guard — Laravel test database: reading phpunit.xml the way PHPUnit does', () => {
  it('reads force="true" in any case, attribute order and quote style', () => {
    const dir = project({ ...BASE, 'phpunit.xml': PHPUNIT(`    <env force='TRUE' value='sqlite' name='DB_CONNECTION'/>\n    <env value=":memory:" force="True" name="DB_DATABASE"/>`) })
    expect(judge('php artisan test', dir)).toBe('allow')
  })

  it('does not count force="1" — PHPUnit reads only true and false', () => {
    const dir = project({ ...BASE, 'phpunit.xml': PHPUNIT('    <env name="DB_CONNECTION" value="sqlite" force="1"/>\n    <env name="DB_DATABASE" value=":memory:" force="1"/>') })
    expect(judge('php artisan test', dir)).toBe('deny')
  })

  it('ignores forced lines inside an XML comment', () => {
    const dir = project({ ...BASE, 'phpunit.xml': PHPUNIT('    <!-- <env name="DB_CONNECTION" value="sqlite" force="true"/>\n    <env name="DB_DATABASE" value=":memory:" force="true"/> -->') })
    expect(judge('php artisan test', dir)).toBe('deny')
  })

  it('reads only the first phpunit file PHPUnit would load', () => {
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': UNFORCED, 'phpunit.xml.dist': FORCED_SQLITE }))).toBe('deny')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, 'phpunit.xml.dist': UNFORCED }))).toBe('allow')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.dist.xml': FORCED_SQLITE }))).toBe('allow')
    const big = project({ ...BASE, 'phpunit.xml': UNFORCED + ' '.repeat(1024 * 1024), 'phpunit.xml.dist': FORCED_SQLITE })
    expect(reasonOf('php artisan test', big)).toMatch(/phpunit\.xml could not be read/)
  })

  it('does not count a forced sqlite connection without a forced in-memory or test database', () => {
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': PHPUNIT('    <env name="DB_CONNECTION" value="sqlite" force="true"/>') }))).toBe('deny')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': forcedDb('sqlite', 'database/database.sqlite') }))).toBe('deny')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': forcedDb('sqlite', 'database/testing.sqlite') }))).toBe('allow')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': forcedDb('mysql', ':memory:') }))).toBe('deny')
  })

  it('accepts a forced database named as a test database, and refuses one that only contains the letters', () => {
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': forcedDb('mysql', 'app_test') }))).toBe('allow')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': forcedDb('pgsql', 'testing') }))).toBe('allow')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': forcedDb('mysql', 'contest') }))).toBe('deny')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': forcedDb('mysql', 'latest_prod') }))).toBe('deny')
  })

  it('refuses when DB_URL in .env overrides the forced database, unless phpunit.xml forces it empty', () => {
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, '.env': 'APP_ENV=local\nDB_URL=mysql://root@prod/app\n' }))).toBe('deny')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, '.env.testing': 'DATABASE_URL="mysql://root@prod/app"\n' }))).toBe('deny')
    const emptied = PHPUNIT('    <env name="DB_CONNECTION" value="sqlite" force="true"/>\n    <env name="DB_DATABASE" value=":memory:" force="true"/>\n    <env name="DB_URL" value="" force="true"/>')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': emptied, '.env': 'DB_URL=mysql://root@prod/app\n' }))).toBe('allow')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, '.env': 'DB_URL=\n# DATABASE_URL=mysql://x\n' }))).toBe('allow')
    expect(judge('php artisan test', project({ ...BASE, 'phpunit.xml': PHPUNIT('    <env name="DB_URL" value="mysql://x/app_test" force="true"/>\n    <env name="DB_DATABASE" value="app_test" force="true"/>') }))).toBe('deny')
  })

  it('names the lines set without force="true"', () => {
    const dir = project({ ...BASE, 'phpunit.xml': UNFORCED })
    expect(reasonOf('php artisan test', dir)).toMatch(/phpunit\.xml sets DB_CONNECTION, DB_DATABASE without force="true"/)
  })
})

describe('terminal guard — Laravel test database: which runs and which project', () => {
  it('lets commands that run no test through', () => {
    const dir = project({ ...BASE, 'phpunit.xml': UNFORCED })
    for (const c of ['php artisan test --version', 'phpunit --help', 'vendor/bin/pest --list-tests', 'phpunit -h', 'paratest --version']) {
      expect(judge(c, dir)).toBe('allow')
    }
  })

  it('reads the configuration file named on the command line', () => {
    const dir = project({ ...BASE, 'phpunit.xml': UNFORCED, 'phpunit.ci.xml': FORCED_SQLITE, 'ci/phpunit.xml': FORCED_SQLITE })
    expect(judge('phpunit -c phpunit.ci.xml', dir)).toBe('allow')
    expect(judge('php artisan test --configuration=phpunit.ci.xml', dir)).toBe('allow')
    expect(judge('vendor/bin/pest --configuration ci', dir)).toBe('allow')
    expect(judge('phpunit --configuration missing.xml', dir)).toBe('deny')
    expect(reasonOf('phpunit --no-configuration', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE }))).toMatch(/--no-configuration runs the tests without phpunit\.xml/)
    expect(reasonOf('phpunit -c "$CFG"', dir)).toMatch(/comes from a variable the guard cannot read/)
    expect(judge('phpunit', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, 'phpunit.ci.xml': UNFORCED }))).toBe('allow')
    expect(judge('phpunit -c phpunit.ci.xml', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, 'phpunit.ci.xml': UNFORCED }))).toBe('deny')
  })

  it('treats an unreadable composer.json next to an artisan file as Laravel, and a Laravel package without artisan as not', () => {
    expect(judge('phpunit', project({ 'composer.json': LARAVEL_COMPOSER + ' '.repeat(1024 * 1024), artisan: '#!/usr/bin/env php\n', 'phpunit.xml': UNFORCED }))).toBe('deny')
    expect(judge('phpunit', project({ 'composer.json': LARAVEL_COMPOSER, 'phpunit.xml': UNFORCED }))).toBe('allow')
  })

  it('finds the project from the artisan or vendor/bin path, wherever the command runs', () => {
    const dir = project({ ...BASE, 'phpunit.xml': UNFORCED })
    const outside = project({})
    expect(judge(`php ${slashes(join(dir, 'artisan'))} test`, outside)).toBe('deny')
    expect(judge(`${slashes(join(dir, 'vendor', 'bin', 'pest'))}`, outside)).toBe('deny')
    expect(judge(`cd ${slashes(dir)} && php artisan test`, outside)).toBe('deny')
    expect(judge('php artisan test', outside)).toBe('allow')
  })

  it('reads phpunit.xml from the folder phpunit runs in, and from the project root for artisan test', () => {
    const dir = project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, 'tests/.keep': '' })
    expect(judge('../vendor/bin/pest', join(dir, 'tests'))).toBe('deny')
    expect(judge('php ../artisan test', join(dir, 'tests'))).toBe('allow')
    expect(judge('php artisan test', dir)).toBe('allow')
  })

  it('runs the check for artisan options before test, for Sail and for Dusk', () => {
    const dir = project({ ...BASE, 'phpunit.xml': UNFORCED })
    for (const c of ['php artisan --env=testing test', 'php artisan --env testing test', './vendor/bin/sail test', 'sail pest', 'php8.3 artisan test', 'herd php artisan test', 'docker compose exec app php artisan test']) {
      expect(judge(c, dir)).toBe('deny')
    }
    const safe = project({ ...BASE, 'phpunit.xml': FORCED_SQLITE })
    expect(judge('./vendor/bin/sail test', safe)).toBe('allow')
    expect(reasonOf('php artisan dusk', safe)).toMatch(/Dusk swaps in its own environment file/)
    expect(judge('php artisan dusk', safe, false)).toBe('allow')
  })

  it('refuses when the folder the tests run in is not known, with a message that is not Laravel-specific', () => {
    const dir = project({ ...BASE, 'phpunit.xml': FORCED_SQLITE })
    for (const c of ['cd "$APP" && php artisan test', 'cd "$APP" && bash -c "php artisan test"', 'cd - && vendor/bin/phpunit']) {
      const r = reasonOf(c, dir)
      expect(r).toMatch(/the guard lost track of the folder/)
      expect(r).not.toMatch(/add `<env/)
    }
  })
})

describe('terminal guard — Laravel test run through php and wrappers (REVIEW round 2)', () => {
  it('reads the runner the test suite runs behind php, sail, docker, ssh and env runners', () => {
    const dir = project({ ...BASE, 'phpunit.xml': UNFORCED })
    writeFileSync(join(dir, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^11' }, scripts: { unit: '@php vendor/bin/phpunit', test: '@php artisan test' } }))
    mkdirSync(join(dir, 'vendor', 'bin'), { recursive: true })
    for (const c of ['php vendor/bin/phpunit', 'php vendor/bin/pest', 'php -d memory_limit=-1 vendor/bin/phpunit', 'php -f artisan test', './vendor/bin/sail php vendor/bin/phpunit', 'composer unit', 'docker compose exec app composer test', 'herd composer test']) {
      expect(judge(c, dir)).toBe('deny')
    }
    expect(judgeCommand(String.raw`php vendor\bin\phpunit`, { cwd: dir, dialect: 'powershell', resolveAlias: NO_ALIASES, database: true }).verdict).toBe('deny')
  })

  it('refuses a test run over ssh or a cd-changed WSL folder, where the remote database cannot be read', () => {
    const dir = project({ ...BASE, 'phpunit.xml': FORCED_SQLITE })
    expect(judge('ssh staging "php artisan test"', dir)).toBe('deny')
    expect(judge('wsl --cd ~/app php artisan test', dir)).toBe('deny')
    expect(judge('ssh staging "ls -la"', dir)).toBe('allow')
  })

  it('reads the phpunit files in PHPUnit order: phpunit.dist.xml before phpunit.xml.dist', () => {
    expect(judge('phpunit', project({ ...BASE, 'phpunit.dist.xml': FORCED_SQLITE, 'phpunit.xml.dist': UNFORCED }))).toBe('allow')
    expect(judge('phpunit', project({ ...BASE, 'phpunit.dist.xml': UNFORCED, 'phpunit.xml.dist': FORCED_SQLITE }))).toBe('deny')
  })

  it('does not count an env or force attribute written in the wrong case (XML is case-sensitive)', () => {
    const dir = project({ ...BASE, 'phpunit.xml': PHPUNIT('    <ENV NAME="DB_CONNECTION" VALUE="sqlite" FORCE="true"/>\n    <ENV NAME="DB_DATABASE" VALUE=":memory:" FORCE="true"/>') })
    expect(judge('php artisan test', dir)).toBe('deny')
    const mixed = project({ ...BASE, 'phpunit.xml': PHPUNIT('    <env name="DB_CONNECTION" value="sqlite" Force="true"/>\n    <env name="DB_DATABASE" value=":memory:" Force="true"/>') })
    expect(judge('php artisan test', mixed)).toBe('deny')
    const upperEl = project({ ...BASE, 'phpunit.xml': PHPUNIT('    <ENV name="DB_CONNECTION" value="sqlite" force="true"/>\n    <ENV name="DB_DATABASE" value=":memory:" force="true"/>') })
    expect(judge('php artisan test', upperEl)).toBe('deny')
  })

  it('refuses sail dusk and reads a forced <server> element like PHPUnit does', () => {
    expect(judge('./vendor/bin/sail dusk', project({ ...BASE, 'phpunit.xml': FORCED_SQLITE }))).toBe('deny')
    const server = project({ ...BASE, 'phpunit.xml': PHPUNIT('    <server name="DB_CONNECTION" value="sqlite" force="true"/>\n    <server name="DB_DATABASE" value=":memory:" force="true"/>') })
    expect(judge('php artisan test', server)).toBe('allow')
  })

  it('names the folder searched and suggests -c when no phpunit file is found there', () => {
    const dir = project({ ...BASE, 'phpunit.xml': FORCED_SQLITE, 'sub/.keep': '' })
    const r = reasonOf('cd sub && ../vendor/bin/phpunit', dir)
    expect(r).toMatch(/no phpunit configuration file was found/)
    expect(r).toMatch(/-c <file>/)
  })
})
