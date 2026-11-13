import { describe, expect, it } from 'vitest'
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
