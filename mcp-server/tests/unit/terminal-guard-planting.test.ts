import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { judgeCommand, type AliasResolver, type ShellDialect } from '../../src/lib/terminal-guard.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })

function verdictOf(command: string, dialect: ShellDialect = 'bash'): string {
  return judgeCommand(command, { dialect, resolveAlias: NO_ALIASES }).verdict
}

describe('terminal guard — git config writes in sections whose keys run programs (2.24.1)', () => {
  it.each([
    'git config core.hooksPath .hooks',
    'git config --global core.sshCommand "ssh -i k"',
    'git config --local filter.x.clean cat',
    'git config -f .git/config credential.helper store',
    'git config --file=x.cfg include.path other.cfg',
    'git config --add remote.origin.receivepack evil',
    'git config --replace-all gpg.program evil',
    'git config --unset core.fsmonitor',
    'git config --unset-all hook.pre-commit.command',
    'git config set core.hooksPath .hooks',
    'git config unset filter.lfs.clean',
    'git config --rename-section zz core',
    'git config --rename-section core zz',
    'git config rename-section zz.x filter.x',
    'git config --remove-section core',
    'git config Core.HooksPath .hooks',
    'git -C ../universe config core.hooksPath h',
    'git config --edit',
    'git config -e',
    'git config edit --global',
  ])('refuses %s', (command) => {
    expect(verdictOf(command)).toBe('deny')
  })

  it('refuses a key built from a variable in a config write', () => {
    expect(verdictOf('git config "$KEY" value')).toBe('deny')
  })

  it.each([
    'git config core.hooksPath',
    'git config --get core.sshCommand',
    'git config --get-regexp "^filter"',
    'git config -l',
    'git config --list --show-origin',
    'git config get core.hooksPath',
    'git config --global user.name "Someone"',
    'git config user.email a@b.invalid',
    'git config safe.directory /x',
  ])('allows %s', (command) => {
    expect(verdictOf(command)).toBe('allow')
  })

  it('reads the same rules in PowerShell', () => {
    expect(verdictOf("git config core.hooksPath '.hooks'", 'powershell')).toBe('deny')
    expect(verdictOf("git config user.name 'Someone'", 'powershell')).toBe('allow')
  })
})

describe('terminal guard — git init and clone that plant hooks (2.24.1)', () => {
  it.each([
    'git init --template=/tmp/t',
    'git init --template /tmp/t',
    'git init --separate-git-dir=../elsewhere',
    'GIT_TEMPLATE_DIR=/tmp/t git init',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=init.templateDir GIT_CONFIG_VALUE_0=/tmp/t git init',
    'git -c init.templateDir=/tmp/t init',
    'git clone -c core.hooksPath=h https://example.invalid/r.git',
    'git clone --config=core.sshCommand=x https://example.invalid/r.git',
    'git clone --template=/tmp/t https://example.invalid/r.git',
  ])('refuses %s', (command) => {
    expect(verdictOf(command)).toBe('deny')
  })

  it.each([
    'git init',
    'git init -q newrepo',
    'git clone https://example.invalid/r.git',
    'git clone -c http.extraHeader=x https://example.invalid/r.git',
  ])('allows %s', (command) => {
    expect(verdictOf(command)).toBe('allow')
  })
})

describe('terminal guard — remotes that run a transport helper (2.24.1)', () => {
  it.each([
    'git remote add evil evil://host/x',
    'git remote add o foo::bar',
    'git remote set-url origin ext::sh',
    'git remote set-url origin https://example.invalid/new.git foo::old',
  ])('refuses %s', (command) => {
    expect(verdictOf(command)).toBe('deny')
  })

  it.each([
    'git remote add origin https://example.invalid/r.git',
    'git remote add origin git@example.invalid:o/r.git',
    'git remote set-url --push origin ssh://example.invalid/r.git',
    'git remote -v',
  ])('allows %s', (command) => {
    expect(verdictOf(command)).toBe('allow')
  })
})

describe('terminal guard — abbreviations, short clusters and planting variables set earlier (REVIEW round 1)', () => {
  it.each([
    'git config --fil .git/config hook.a.command evil',
    'git config --typ path core.hooksPath .h',
    'git config -zf .git/config hook.a.command evil',
    'git config -fx.cfg core.hooksPath .h',
    'git config --comm x core.hooksPath .h',
    'git config --uns core.fsmonitor',
    'git config --replace core.sshCommand evil',
    'git config --ed',
    'git init --templ=tpl',
    'git init --t tpl',
    'git init --separate=../gd',
    'git clone --conf core.hooksPath=h src dst',
    'git clone -ccore.hooksPath=h src dst',
    'export GIT_TEMPLATE_DIR=tpl; git init',
    'GIT_TEMPLATE_DIR=/t; export GIT_TEMPLATE_DIR; git init',
    'GIT_CONFIG_GLOBAL=/x/cfg git init',
    'export GIT_CONFIG_SYSTEM=/x/cfg && git clone https://example.invalid/r.git',
  ])('refuses %s', (command) => {
    expect(verdictOf(command)).toBe('deny')
  })

  it('refuses a planting variable set in PowerShell before git init', () => {
    expect(verdictOf("$env:GIT_TEMPLATE_DIR='C:\t'; git init", 'powershell')).toBe('deny')
    expect(verdictOf("$env:GIT_CONFIG_COUNT=1; git init", 'powershell')).toBe('deny')
  })

  it.each([
    'git config --gl user.name Someone',
    'git config --get core.hooksPath',
    'git config --get-a core.hooksPath',
    'git config -l',
    'git config -z --list',
    'export FOO=1; git init',
  ])('allows %s', (command) => {
    expect(verdictOf(command)).toBe('allow')
  })
})

describe('terminal guard — short options that take a value (REVIEW round 2)', () => {
  it.each([
    'git config -tbool core.hooksPath true',
    'git config -tcolor core.hooksPath x',
    'git config -tbool-or-int core.hooksPath 1',
    'git config -t bool core.hooksPath true',
    'git config -zt bool core.hooksPath true',
    'git clone -qc core.sshCommand=evil-ssh proj dst',
    'git clone -qccore.hooksPath=h src dst',
    'git clone -nc core.hooksPath=h src dst',
  ])('refuses %s', (command) => {
    expect(verdictOf(command)).toBe('deny')
  })

  it.each([
    'git config -t bool --get core.bare',
    'git config -tbool --list',
    'git clone -qb main src dst',
    'git clone -ob c src dst',
    'git clone -j 4 src dst',
  ])('allows %s', (command) => {
    expect(verdictOf(command)).toBe('allow')
  })
})

describe('terminal guard — git init and clone with a home folder set on the command (REVIEW round 2)', () => {
  it.each([
    'HOME=/tmp/fake git init',
    'XDG_CONFIG_HOME=/x git init',
    'export HOME=/x; git init',
    'HOME=/x; git init',
    'env HOME=/x git clone https://example.invalid/r.git',
    'env -i HOMEPATH=x git init',
    'HOME+=/x git init',
  ])('refuses %s', (command) => {
    expect(verdictOf(command)).toBe('deny')
  })

  it('refuses a home folder set in PowerShell before git init or clone', () => {
    expect(verdictOf("$env:USERPROFILE='C:\\x'; git init", 'powershell')).toBe('deny')
    expect(verdictOf("$env:HOME = 'C:\\x'; git clone https://example.invalid/r.git", 'powershell')).toBe('deny')
    expect(verdictOf("Set-Item env:HOMEDRIVE 'D:'; git init", 'powershell')).toBe('deny')
    expect(verdictOf("[Environment]::SetEnvironmentVariable('HOME', 'C:\\x'); git init", 'powershell')).toBe('deny')
  })

  it.each([
    'git clone https://example.invalid/r.git $HOME/src/r',
    'cd "$HOME/projects" && git init',
    'git init "${XDG_CONFIG_HOME:-x}/repo"',
    'HOME=/x git status',
    'MYHOME=/x git init',
  ])('allows %s', (command) => {
    expect(verdictOf(command)).toBe('allow')
  })

  it('allows a home folder read in PowerShell', () => {
    expect(verdictOf('git clone https://example.invalid/r.git "$env:USERPROFILE\\src\\r"', 'powershell')).toBe('allow')
    expect(verdictOf('Set-Location $env:HOME; git init', 'powershell')).toBe('allow')
  })
})

describe('terminal guard — planting names spelled without the plain name (2.24.2)', () => {
  it.each([
    String.raw`export GIT_TEMPLATE""_DIR=/x; git init`,
    String.raw`export GIT_TEMPLATE\_DIR=/x; git init`,
    String.raw`env GIT_TEMPLATE""_DIR=/x git init`,
    String.raw`export GIT_TEMPLATE$''_DIR=/x; git init`,
    String.raw`export GIT_TEMPLATE$""_DIR=/x; git init`,
    String.raw`export GIT_TEMPLATE$'\x5f'DIR=/x; git init`,
    'export GIT_TEMPLATE$(true)_DIR=/x; git init',
    'export GIT_TEMPLATE`true`_DIR=/x; git init',
    'V=GIT_TEMPLATE; export $' + '{V}_DIR=/x; git init',
    'export "$' + '{V}_DIR"=/x; git init',
    'export GIT_TEMPLATE{,}_DIR=/x; git init',
    'declare -x "$' + '{V}_DIR=/x"; git clone https://example.invalid/r.git',
    'eval "$' + '{V}_DIR=/x git init"',
    String.raw`bash -c 'export GIT_TEMPLATE""_DIR=/x; git init'`,
    'env "$ASSIGN" git init',
    'env -i "$ASSIGN" git init',
    'env -u FOO "$ASSIGN" git init',
    'env --chdir /tmp "$ASSIGN" git clone https://example.invalid/r.git',
    'read HOME <<< /x; git init',
    'printf -v HOME %s /x; git init',
    'local XDG_CONFIG_HOME; git clone https://example.invalid/r.git',
  ])('refuses %s', (command) => {
    expect(verdictOf(command)).toBe('deny')
  })

  it.each([
    "$env:GIT_TEMPLATE`_DIR = 'C:\\x'; git init",
    "Set-Item ('env:GIT_TEMPLATE' + '_DIR') C:\\x; git init",
    "Set-Item ('env:GIT_TEMPLATE'+'_DIR') C:\\x; git init",
    "Set-Item (\"env:GIT_TEMPLATE\" + '_DIR') C:\\x; git init",
    "[Environment]::SetEnvironmentVariable('GIT_' + 'TEMPLATE_DIR', 'C:\\x'); git init",
    "Set-Item ('env:HO' + 'ME') C:\\x; git clone https://example.invalid/r.git",
  ])('refuses in PowerShell %s', (command) => {
    expect(verdictOf(command, 'powershell')).toBe('deny')
  })

  it.each([
    'export PATH=$PATH:/x; git clone https://example.invalid/r.git',
    'export FOO="$BAR"; git init',
    'export "PATH=$PATH:/x"; git init',
    'env FOO=1 git clone "$url"',
    'env -u FOO git init',
    'env -C /tmp git clone "$url"',
    'git clone https://example.invalid/HOME.git',
    'git init && echo "status=ok"',
    'git init && printf "%s\\n" "$HOME"',
    'read -r name; git init "$name"',
    'for d in a b; do git init "$d"; done',
    'declare -A map=( [k]=v ); git init',
  ])('allows %s', (command) => {
    expect(verdictOf(command)).toBe('allow')
  })

  it.each([
    "$env:Path += ';C:\\x'; git clone https://example.invalid/r.git",
    "Set-Item ('env:' + 'FOO') 1; git init",
    'git clone C:\\HOME\\r C:\\x\\y',
  ])('allows in PowerShell %s', (command) => {
    expect(verdictOf(command, 'powershell')).toBe('allow')
  })
})

describe('terminal guard — planting names inside the package scripts a command runs (2.24.2)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsct-tg-pkg-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'p',
      scripts: {
        plant: 'GIT_TEMPLATE_DIR=/t git init',
        home: 'export HOME=/x; git clone https://example.invalid/r.git',
        spelled: 'export GIT_TEMPLATE$(true)_DIR=/x; git init',
        plain: 'git init',
      },
    }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it.each(['npm run plant', 'npm run home', 'npm run spelled', 'pnpm run plant', 'yarn plant'])('refuses %s', (command) => {
    expect(judgeCommand(command, { dialect: 'bash', resolveAlias: NO_ALIASES, cwd: dir }).verdict).toBe('deny')
  })

  it('allows a script that runs a plain git init', () => {
    expect(judgeCommand('npm run plain', { dialect: 'bash', resolveAlias: NO_ALIASES, cwd: dir }).verdict).toBe('allow')
  })
})

describe('terminal guard — a value from a variable is still a value (REVIEW round 1)', () => {
  it('allows a config value built from a variable, refuses a key built from one', () => {
    expect(verdictOf('git config user.email "$EMAIL"')).toBe('allow')
    expect(verdictOf('git config "$KEY" value')).toBe('deny')
  })
})
