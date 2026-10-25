import { describe, it, expect } from 'vitest'
import {
  judgeCommand,
  programName,
  type AliasResolver,
  type ShellDialect,
} from '../../src/lib/terminal-guard.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })

function verdictOf(command: string, dialect: ShellDialect = 'bash', resolveAlias: AliasResolver = NO_ALIASES): string {
  return judgeCommand(command, { dialect, resolveAlias }).verdict
}

const DENIED_BASH: string[] = [
  'git commit -m "x"',
  'git pull',
  'git pull origin main',
  'git pull --rebase',
  'git pull -r',
  'git pull --ff-only --rebase',
  'git pull --rebase=merges --ff-only',
  'git pull --ff-only --no-ff',
  'git -C repo pull',
  'git pull --no-ff --ff-only',
  'git pull --ff-only -r',
  'git pull --ff-only --reb',
  'X=--no-ff; git pull --ff-only $X',
  'git pull --ff-only "$FLAG"',
  'git -c pull.rebase=true pull --ff-only',
  'git -cpull.ff=false pull --ff-only',
  'git pull --ff-only . main',
  'git pull --ff-only ../other main',
  'git pull --ff-only file:///tmp/repo main',
  'git commit-tree HEAD^{tree} -m x',
  'git filter-branch --tree-filter true HEAD',
  'git fast-import < stream',
  'git quiltimport --patches p',
  'git replay --onto main topic',
  'git-pull origin',
  `node -e "require('child_process').execSync('git pull --ff-only')"`,
  `python3 -c "import subprocess; subprocess.run(['git', 'commit-tree', 'x'])"`,
  "gh alias set sync '!git pull'",
  'git push origin main',
  'git merge feature',
  'git rebase main',
  'git cherry-pick abc123',
  'git revert HEAD',
  'git am < patch.mbox',
  'git COMMIT -m x',
  'git -C ../other commit -m x',
  'git -c user.name=x commit -m y',
  'git --git-dir=.git --work-tree=. commit -m x',
  'git --no-pager -c core.hooksPath=/dev/null commit -m x',
  'git status && git commit -m x',
  'git status; git push',
  'npm test || git commit -am wip',
  'echo a | git commit -F -',
  'FOO=1 git commit -m x',
  'env git commit -m x',
  'env -i PATH=/usr/bin git commit -m x',
  'command git commit -m x',
  'nohup git push &',
  'time git commit -m x',
  'timeout 5 git push',
  'sudo -u someone git commit -m x',
  'xargs -I{} git commit -m {}',
  'find . -name x -exec git commit -m y \\;',
  '/usr/bin/git commit -m x',
  '/c/Program\\ Files/Git/cmd/git.exe commit -m x',
  'wsl -- git push',
  '"C:/Program Files/Git/cmd/git.exe" commit -m x',
  'git.exe push',
  '\\git commit -m x',
  'g\'\'it commit -m x',
  '"git" commit -m x',
  '(git commit -m x)',
  '{ git commit -m x; }',
  'if true; then git commit -m x; fi',
  'for f in a; do git push; done',
  'echo $(git commit -m x)',
  'echo "$(git push)"',
  'echo `git commit -m x`',
  'diff <(git commit -m x) b',
  'G=git; $G commit -m x',
  '"$G" commit -m x',
  '$(which git) commit -m x',
  'bash -c "git commit -m x"',
  "sh -c 'cd repo && git push'",
  'bash -lc "git push"',
  'zsh -c "git commit -m x"',
  "bash <<'EOF'\ngit commit -m x\nEOF",
  'bash <<< "git push"',
  'eval "git commit -m x"',
  'env -S "git commit -m x"',
  'su -c "git push" someone',
  'cmd /c git commit -m x',
  'cmd.exe /C "git push"',
  'powershell -NoProfile -Command "git commit -m x"',
  'pwsh -c "& git push"',
  'wsl git commit -m x',
  'wsl -d Ubuntu -e bash -c "git commit -m x"',
  'wsl.exe --cd /repo -- git push',
  'ubuntu run git commit -m x',
  'ssh host "cd repo && git push"',
  'ssh -p 22 host git commit -m x',
  'node -e "require(\'child_process\').execSync(\'git commit -m x\')"',
  'node -e "require(\'child_process\').spawnSync(\'git\', [\'push\'])"',
  'python3 -c "import os; os.system(\'git push\')"',
  'perl -e "system(\'git commit -m x\')"',
  'git submodule foreach git commit -m x',
  'git -c alias.ci=commit ci -m x',
  'git -c "alias.p=!git push" p',
  'gh pr merge 12 --squash',
  'gh -R owner/repo pr merge 12',
  'echo \'{"disableAllHooks": true}\' > .claude/settings.local.json',
  'echo \'{"disable\\u0041llHooks": true}\' > x.json',
  "printf '%s' disableAllHooks",
]

const ALLOWED_BASH: string[] = [
  'git status',
  'git log --grep=commit --oneline',
  'git log --format="%s" -- commit.txt',
  'git diff HEAD~1',
  'git stash push -m wip',
  'git remote add origin https://example.invalid/x.git',
  'git worktree add ../w',
  'git fetch origin',
  'git pull --ff-only',
  'git pull --ff-only origin main',
  'git pull --rebase=false --ff-only',
  'git pull -q --prune --ff-only origin',
  'git -C repo pull --ff-only',
  'git add -A',
  'git checkout -b feature',
  'git branch -D old',
  'git reset --hard HEAD',
  'git tag v1',
  'git help commit',
  'git config alias.ci commit',
  'git merge --abort',
  'git rebase --continue',
  'git rebase --abort',
  'git cherry-pick --skip',
  'git revert --quit',
  'git am --abort',
  'git merge --continue',
  'grep -rn "git commit" docs/',
  'echo "remember to git push later"',
  "cat <<'EOF' > notes.md\nrun git commit after review\nEOF",
  'cat <<EOF > notes.md\nplain text git push\nEOF',
  '# git commit -m x is a comment here\nls',
  'ls # then git push',
  'npm run commit-msg-lint',
  'node scripts/build.js',
  'node -e "console.log(1)"',
  'python3 -c "print(\'git\')"',
  'gh pr view 12',
  'gh pr list',
  'gh api repos/x/y',
  "echo 'it''s fine'",
  "echo don't",
  'echo $((1 + 2))',
  'ls 2>&1 | head',
  'echo hi > commit.txt',
  'bash -x script.sh',
  'git lfs pull',
]

describe('judgeCommand — bash: refused', () => {
  for (const c of DENIED_BASH) {
    it(`refuses: ${JSON.stringify(c)}`, () => {
      expect(verdictOf(c)).toBe('deny')
    })
  }
})

describe('judgeCommand — bash: allowed', () => {
  for (const c of ALLOWED_BASH) {
    it(`allows: ${JSON.stringify(c)}`, () => {
      expect(verdictOf(c)).toBe('allow')
    })
  }
})

const DENIED_POWERSHELL: string[] = [
  'git commit -m "x"',
  "$x = '--no-ff'; git pull --ff-only $x",
  'git pull --% --ff-only',
  "Start-Process git -ArgumentList 'pull', $remote",
  '& git push',
  "& 'C:\\Program Files\\Git\\cmd\\git.exe' commit -m x",
  'Start-Process git -ArgumentList \'commit\',\'-m\',\'x\'',
  'cd repo; git push',
  'Invoke-Expression "git commit -m x"',
  'iex \'git push\'',
  'Invoke-Command -ScriptBlock { git commit -m x }',
  'Write-Output $(git push)',
  'cmd /c "git commit -m x"',
  'wsl -e git push',
  "powershell -EncodedCommand " + Buffer.from('git push', 'utf16le').toString('base64'),
  'git commit -m "it`"s"',
  '$env:FOO = 1; git commit -m x',
]

const ALLOWED_POWERSHELL: string[] = [
  'git status',
  "Get-ChildItem | Select-String 'git commit'",
  'Write-Output "git push later"',
  "Write-Output 'it''s ok'",
  '# git commit -m x\nGet-Date',
  '<# git push #> Get-Date',
  'git log --oneline -n 5',
  'git rebase --abort',
  "Write-Output `\n  'line'",
]

describe('judgeCommand — PowerShell: refused', () => {
  for (const c of DENIED_POWERSHELL) {
    it(`refuses: ${JSON.stringify(c)}`, () => {
      expect(verdictOf(c, 'powershell')).toBe('deny')
    })
  }
})

describe('judgeCommand — PowerShell: allowed', () => {
  for (const c of ALLOWED_POWERSHELL) {
    it(`allows: ${JSON.stringify(c)}`, () => {
      expect(verdictOf(c, 'powershell')).toBe('allow')
    })
  }
})

describe('judgeCommand — brace and glob patterns, and words built partly from a variable (REVIEW 2.17.0)', () => {
  it('refuses a git or gh subcommand, or a program, that a brace or glob pattern makes', () => {
    for (const c of [
      'git {commit,} -m x',
      'git co{mmit,} -m x',
      'git {push,} origin main',
      'git [c]ommit -m x',
      'git c?mmit -m x',
      'git comm*t -m x',
      '{git,} commit -m x',
      '{git,commit,-m,x}',
      'sudo {git,} commit -m x',
      'gi[t] commit -m x',
      'gh pr {merge,} 12',
    ]) expect(verdictOf(c), c).toBe('deny')
    for (const c of ['git [c]ommit -m x', 'git c?mmit -m x']) expect(verdictOf(c, 'powershell'), c).toBe('deny')
  })

  it('refuses a pull whose words a pattern or a variable could turn into another option', () => {
    for (const c of [
      'git pull --ff-only {--no-ff,}',
      'git pull --ff-only [-]-no-ff',
      'git pull --ff-only origin ma$X',
      'git pull --ff-only origin ma${X}',
      'git pull --ff-only origin ma$(echo in)',
      'git pull --ff-only origin ma`echo in`',
      'git pull --ff-only origin "ma$X"',
      'git-pull --ff-only origin ma$X',
      'G=git; "$G" pull --ff-only "$R"',
      'G=git; "$G" pull --ff-only origin ma$X',
      'X=mmit; git co$X -m x',
      'gh pr mer$X 12',
    ]) expect(verdictOf(c), c).toBe('deny')
    for (const c of ['$x = "--no-ff"; & $g pull --ff-only $x', 'git pull --ff-only origin ma$X']) expect(verdictOf(c, 'powershell'), c).toBe('deny')
  })

  it('still allows patterns and variables where git takes an argument, and the shell forms around them', () => {
    for (const c of [
      'git add src/*.ts',
      'git add {a,b}.ts',
      'git diff HEAD~1 -- src/*.ts',
      'git stash apply stash@{0}',
      'git log HEAD@{1}',
      'mkdir -p src/{a,b} && cp file{,.bak}',
      'echo {1..5}',
      'ls *.md',
      'for f in src/*.ts; do echo $f; done',
      '[ -f x ] && echo y',
      '[[ $x == *.md ]] && echo y',
      'a[0]=x; echo ${a[0]}',
      '$HOME/bin/tool --flag',
      'git -C $DIR log --oneline',
      'git log origin/$BRANCH..HEAD',
      'gh pr view $N --comments',
      'find . -name "*.ts" -exec grep -l x {} +',
      'git pull --ff-only origin main',
    ]) expect(verdictOf(c), c).toBe('allow')
    for (const c of ['Get-ChildItem *.ts | ? { $_.Length -gt 0 }', "[System.IO.File]::ReadAllText('x')", '$a = @(1,2); $a[0]']) {
      expect(verdictOf(c, 'powershell'), c).toBe('allow')
    }
  })

  it('still reads a brace group and a function body as commands', () => {
    for (const c of ['{ git commit -m x; }', '{ git commit -m x;}', 'f(){ git commit -m x; }; f', 'if true; then { git push; }; fi']) {
      expect(verdictOf(c), c).toBe('deny')
    }
  })
})

describe('judgeCommand — git aliases', () => {
  const table: Record<string, string> = { ci: 'commit -v', p: '!git push origin', lg: 'log --oneline', loop: 'loop', up: '!f() { git push; }; f', sync: 'pull', ffsync: 'pull --ff-only' }

  it('judges an alias to pull like the pull it runs', () => {
    expect(verdictOf('git sync', 'bash', resolver)).toBe('deny')
    expect(verdictOf('git ffsync', 'bash', resolver)).toBe('allow')
    expect(verdictOf('git -C repo ffsync', 'bash', resolver)).toBe('allow')
    expect(verdictOf('git -c pull.rebase=true ffsync', 'bash', resolver)).toBe('deny')
    expect(verdictOf('git -c pull.rebase=true -c alias.p=pull p --ff-only')).toBe('deny')
    expect(verdictOf('git -c alias.p=pull p --ff-only')).toBe('allow')
  })
  const resolver: AliasResolver = (name) => (name in table ? { found: true, value: table[name]! } : { found: false })

  it('refuses an alias that expands to a refused verb', () => {
    expect(verdictOf('git ci -m x', 'bash', resolver)).toBe('deny')
    expect(verdictOf('git p', 'bash', resolver)).toBe('deny')
    expect(verdictOf('git up', 'bash', resolver)).toBe('deny')
  })

  it('allows an alias that expands to an allowed verb, and an unknown external command', () => {
    expect(verdictOf('git lg', 'bash', resolver)).toBe('allow')
    expect(verdictOf('git lfs pull', 'bash', resolver)).toBe('allow')
  })

  it('refuses an alias loop instead of spinning', () => {
    expect(verdictOf('git loop', 'bash', resolver)).toBe('deny')
  })

  it('never asks about a git built-in command', () => {
    const asked: string[] = []
    const spy: AliasResolver = (name) => {
      asked.push(name)
      return { found: false }
    }
    judgeCommand('git status && git log && git diff', { resolveAlias: spy })
    expect(asked).toEqual([])
  })

  it('refuses when the alias cannot be resolved', () => {
    const failing: AliasResolver = () => ({ error: 'spawn git ENOENT' })
    const v = judgeCommand('git ci -m x', { resolveAlias: failing })
    expect(v.verdict).toBe('deny')
    if (v.verdict === 'deny') expect(v.reason).toContain('ENOENT')
  })

  it('refuses when the alias budget is spent', () => {
    let clock = 0
    const slow: AliasResolver = () => {
      clock += 5000
      return { found: false }
    }
    const v = judgeCommand('git aa && git bb', { resolveAlias: slow, aliasBudgetMs: 3000, now: () => clock })
    expect(v.verdict).toBe('deny')
  })

  it('looks the alias up in the folder that -C names, from the call cwd', () => {
    const seen: Array<[string, string | null, string | undefined]> = []
    const spy: AliasResolver = (name, gitDir, cwd) => {
      seen.push([name, gitDir, cwd])
      return { found: false }
    }
    judgeCommand('git -C ../other ci', { resolveAlias: spy, cwd: '/work/repo' })
    expect(seen).toEqual([['ci', '../other', '/work/repo']])
  })
})

describe('judgeCommand — messages', () => {
  it('names the RSCT tool and the developer route for a refused verb', () => {
    const v = judgeCommand('git push', { resolveAlias: NO_ALIASES })
    expect(v.verdict).toBe('deny')
    if (v.verdict === 'deny') {
      expect(v.reason).toContain('rsct_request_push')
      expect(v.reason).toContain('their own terminal')
    }
  })

  it('says why a hooks-off command was refused', () => {
    const v = judgeCommand('echo disableAllHooks', { resolveAlias: NO_ALIASES })
    expect(v.verdict).toBe('deny')
    if (v.verdict === 'deny') expect(v.reason).toContain('disableAllHooks')
  })
})

describe('programName', () => {
  it('takes the last path segment, lower-cased, without a Windows extension', () => {
    expect(programName('C:\\Program Files\\Git\\cmd\\git.exe')).toBe('git')
    expect(programName('/usr/bin/GIT')).toBe('git')
    expect(programName('git.cmd')).toBe('git')
    expect(programName('gitk')).toBe('gitk')
  })
})

describe('judgeCommand — text a runner re-reads', () => {
  it('refuses a quoted command handed to wsl, ssh, cmd or a distro launcher', () => {
    for (const c of ['wsl "git push"', 'wsl.exe -d Ubuntu "git commit -m x"', "ssh host 'git push'", 'cmd /c "git push"', 'ubuntu2204 run "git commit -m x"']) {
      expect(verdictOf(c)).toBe('deny')
    }
  })
})

describe('judgeCommand — a verb that is not a plain word (REVIEW #91)', () => {
  it('refuses a verb carried with its arguments in the one string Start-Process joins', () => {
    expect(verdictOf("Start-Process git -ArgumentList 'commit -m x'", 'powershell')).toBe('deny')
    expect(verdictOf("Start-Process -FilePath git -ArgumentList 'push origin main'", 'powershell')).toBe('deny')
  })

  it('refuses a verb built from a variable, a substitution or a PowerShell splat', () => {
    expect(verdictOf('c=commit; git $c -m x')).toBe('deny')
    expect(verdictOf('git "$c" -m x')).toBe('deny')
    expect(verdictOf('git $(echo commit) -m x')).toBe('deny')
    expect(verdictOf('git `echo push`')).toBe('deny')
    expect(verdictOf("$a = @('commit'); git @a", 'powershell')).toBe('deny')
    expect(verdictOf('$v = "push"; git $v', 'powershell')).toBe('deny')
  })

  it('still allows a variable where git takes an argument, and an ordinary option value', () => {
    expect(verdictOf('git log $REV')).toBe('allow')
    expect(verdictOf('git -C "$DIR" status')).toBe('allow')
    expect(verdictOf('git log --format="%h %s" -n 5')).toBe('allow')
    expect(verdictOf("Start-Process git -ArgumentList 'status --short'", 'powershell')).toBe('allow')
  })
})

describe('judgeCommand — the recovery forms are exact (REVIEW #91 round 2)', () => {
  it('refuses a recovery flag used as the value of another option', () => {
    for (const c of [
      'git merge -m --abort feature',
      'git rebase --exec --continue main',
      'git am --directory --skip x.mbox',
      'git cherry-pick --strategy --skip abc123',
      'git revert --strategy --quit HEAD',
      'git merge --abort feature',
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
  })

  it('still allows each recovery form, with redirects and global options around it', () => {
    for (const c of [
      'git rebase --continue 2>&1',
      'git merge --abort > /dev/null',
      'GIT_EDITOR=true git -c core.editor=true rebase --continue',
      'git -C "$WT" rebase --continue',
      'git -C "$DIR" merge --abort',
    ]) {
      expect(verdictOf(c)).toBe('allow')
    }
  })
})

describe('judgeCommand — redirects (REVIEW #91 round 2)', () => {
  it('does not take a redirect target for the git subcommand', () => {
    for (const c of ['git >out commit -m x', 'git 2>/dev/null push', 'git <in commit -m x', 'git &>log push', 'git >&log merge x', 'git 2>&1 >out commit -m x']) {
      expect(verdictOf(c)).toBe('deny')
    }
  })

  it('does not let a redirect with no target swallow the next command', () => {
    expect(verdictOf('echo > ; git commit -m x')).toBe('deny')
    expect(verdictOf('echo >\ngit push')).toBe('deny')
  })

  it('does not take a redirect target for a word of the command', () => {
    expect(verdictOf('echo hi > git commit')).toBe('allow')
    expect(verdictOf('"$X" > push')).toBe('allow')
    expect(verdictOf('git rebase --abort *> $null', 'powershell')).toBe('allow')
    expect(verdictOf('git merge --abort *>&1 | Out-Null', 'powershell')).toBe('allow')
  })
})

describe('judgeCommand — a word built from a variable (REVIEW #91 round 2)', () => {
  it('refuses it when a blocked verb follows, after git global options too', () => {
    for (const c of [
      '"$G" -C dir commit -m x',
      '"$G" -c k=v push',
      '"$G" --no-pager merge feature',
      '"$G" --git-dir=.git merge x',
      '"$G" rebase $X',
      '"$G" pr merge 5',
      '"$G" pr $V 5',
      '"$G" pr -R o/r merge 5',
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
  })

  it('allows it before a gh read, a git recovery form, or an option git does not take', () => {
    for (const c of ['gh -R "$REPO" pr view 5', '"$G" pr view 5', '"$G" rebase --continue', 'find "$DIR" -name commit', 'docker compose -f "$F" --dry-run push']) {
      expect(verdictOf(c)).toBe('allow')
    }
    expect(verdictOf("$s = git status; if ($s -match 'rebase') { 'x' }", 'powershell')).toBe('allow')
    expect(verdictOf("git log --oneline | Where-Object { $_ -match 'Revert' }", 'powershell')).toBe('allow')
  })
})

describe('judgeCommand — a command that is a whole variable (REVIEW #91 round 3)', () => {
  it('refuses an unquoted variable or substitution run as the command, also behind a wrapper', () => {
    for (const c of ['C="git commit -m x"; $C', "$(printf 'git commit -m x')", 'FOO=1 $C', 'sudo $C', 'env ${C}', 'eval $C', 'bash -c "$C"']) {
      expect(verdictOf(c)).toBe('deny')
    }
  })

  it('refuses a quoted substitution that names git', () => {
    expect(verdictOf('"$(which git)" commit -m x')).toBe('deny')
    expect(verdictOf('"`which git`" push')).toBe('deny')
  })

  it('refuses Invoke-Expression of a variable', () => {
    expect(verdictOf("$c = 'git push'; iex $c", 'powershell')).toBe('deny')
    expect(verdictOf('Invoke-Expression $code', 'powershell')).toBe('deny')
  })

  it('allows a quoted variable as the program, and a variable as an argument', () => {
    for (const c of ['"$PY" script.py', '"$(which node)" x.js', 'echo "$X" "commit message"', 'echo "at $(date)" push', 'FOO=$BAR npm test', 'node "$HOME/x.js"', 'cd "$(git rev-parse --show-toplevel)" && git status']) {
      expect(verdictOf(c)).toBe('allow')
    }
    expect(verdictOf('iex (irm https://example.invalid/i.ps1)', 'powershell')).toBe('allow')
  })
})

describe('judgeCommand — Start-Process joins its arguments (REVIEW #91 round 3)', () => {
  it('refuses a blocked verb whatever item of the argument list carries it', () => {
    for (const c of [
      '$v = "commit"; Start-Process git -ArgumentList " -C .", $v',
      '$v = "merge"; Start-Process gh -ArgumentList " -R o/r pr", $v',
      '$v = "commit"; Start-Process git -ArgumentList "$v -m x"',
      '$v = "merge"; Start-Process gh -ArgumentList "pr $v 5"',
      "$g = 'git'; Start-Process $g -ArgumentList 'commit -m x'",
      "$g = 'git'; Start-Process -FilePath $g -ArgumentList 'push'",
      "$g = 'gh'; Start-Process $g 'pr merge 5'",
      "$g = 'gh'; Start-Process $g -ArgumentList 'pr merge 5'",
    ]) {
      expect(verdictOf(c, 'powershell')).toBe('deny')
    }
  })

  it('allows an ordinary Start-Process', () => {
    for (const c of ['Start-Process notepad -ArgumentList $file', "Start-Process $exe -ArgumentList '/S'", "Start-Process git -ArgumentList 'status'"]) {
      expect(verdictOf(c, 'powershell')).toBe('allow')
    }
  })
})

describe('judgeCommand — round 4 (REVIEW #91)', () => {
  it('reads Start-Process as the command line it starts, in any parameter order', () => {
    for (const c of [
      "Start-Process git -WorkingDirectory C:\\repo -ArgumentList 'commit -m x'",
      "Start-Process -ArgumentList 'push' -FilePath git",
      "Start-Process -ArgumentList 'push' git",
      "Start-Process -FilePath:git -ArgumentList 'push'",
      "Start-Process cmd -ArgumentList '/c git push'",
      "Start-Process git -Wait -WorkingDirectory . -ArgumentList 'merge','x'",
      "Start-Process -ArgumentList 'commit','-m' git",
    ]) {
      expect(verdictOf(c, 'powershell')).toBe('deny')
    }
    for (const c of ['Start-Process node -ArgumentList $script, $port', "Start-Process git -ArgumentList 'fetch', $remote, $branch", 'Start-Process -FilePath $exe -ArgumentList $argList -Wait']) {
      expect(verdictOf(c, 'powershell')).toBe('allow')
    }
  })

  it('reads more runner forms', () => {
    for (const c of ['bash -o pipefail -c "git push"', 'bash -euo pipefail -c "git push"', 'script -qc "git push" /dev/null', 'su -lc "git push" root', 'cmd //c "git commit -m x"', 'powershell "git push"']) {
      expect(verdictOf(c)).toBe('deny')
    }
    expect(verdictOf("$c = 'git push'; pwsh -c $c", 'powershell')).toBe('deny')
    expect(verdictOf('pwsh -WorkingDirectory dir -c "Get-ChildItem"', 'powershell')).toBe('allow')
    expect(verdictOf('pwsh -WorkingDirectory $dir -File build.ps1', 'powershell')).toBe('allow')
    expect(verdictOf('pwsh -File build.ps1')).toBe('allow')
  })

  it('reads a variable command behind shell keywords and wrapper options', () => {
    for (const c of ['C="git push"; for x in 1; do $C; done', 'C="git push"; if true; then $C; fi', '! $C', 'if true; then eval "git push"; fi', 'FOO=1 eval "git push"', 'sudo -E $C', 'env -i $C', 'xargs -n1 $C']) {
      expect(verdictOf(c)).toBe('deny')
    }
  })

  it('reads special parameters, arrays, ${…} and arithmetic', () => {
    for (const c of ['f() { git "$@"; }; f push', 'f() { git $1; }; f push', 'c=(git); c+=(push); "${c[@]}"', 'echo ${X:-$(git push)}', 'C="git push"; $C""', "C=\"git push\"; ''$C", 'echo $(( $(git commit -m x) ))', 'arr=($(git push))', '((git push) )', 'git --attr-source HEAD commit -m x', '"$G" -R o/r pr merge 5', '"$G" --repo=o/r pr merge 5']) {
      expect(verdictOf(c)).toBe('deny')
    }
    for (const c of ['files=($(git ls-files))', 'local pids=($(pgrep node))', 'arr=($LIST); arr+=($X)', '(( $n > 0 )) && echo ok', 'if (( ${#files[@]} == 0 )); then echo none; fi', 'while (( $i < 10 )); do i=$((i+1)); done']) {
      expect(verdictOf(c)).toBe('allow')
    }
  })

  it('reads PowerShell parentheses after a command word', () => {
    expect(verdictOf("git @('commit','-m','x')", 'powershell')).toBe('deny')
    expect(verdictOf("git ('push')", 'powershell')).toBe('deny')
    expect(verdictOf('$s = git status; if ($s -match "rebase") { "x" }', 'powershell')).toBe('allow')
  })

  it('reads code from a heredoc fed to an interpreter, and gh in an argument list', () => {
    expect(verdictOf("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'push'])\nEOF")).toBe('deny')
    expect(verdictOf("node <<'EOF'\nrequire('child_process').execSync('git commit -m x')\nEOF")).toBe('deny')
    expect(verdictOf('python3 -c "import subprocess; subprocess.run([\'gh\', \'pr\', \'merge\', \'5\'])"')).toBe('deny')
    expect(verdictOf("python3 script.py <<'EOF'\ninput that says git push\nEOF")).toBe('allow')
  })

  it('does not take a wrapper name used as an argument, or {} of find, for a command', () => {
    for (const c of ['docker exec $CID ls', 'docker exec $(docker ps -qf name=db) psql', 'kubectl exec $POD -- env', 'npm exec $BIN', 'sudo usermod -aG sudo $USER', 'grep -rn exec $DIR', "find . -name '*.ts' -exec cp {} $DEST \\;", 'xargs -I {} mv {} $DIR']) {
      expect(verdictOf(c)).toBe('allow')
    }
  })

  it('passes the usual PowerShell launches and command -v (REVIEW #91 round 4)', () => {
    expect(verdictOf('powershell -NoProfile -ExecutionPolicy Bypass -File $script', 'powershell')).toBe('allow')
    expect(verdictOf('powershell.exe -ExecutionPolicy Bypass -File "$SCRIPT"')).toBe('allow')
    expect(verdictOf('powershell -w Hidden -ep Bypass -File $script', 'powershell')).toBe('allow')
    expect(verdictOf('Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""', 'powershell')).toBe('allow')
    expect(verdictOf('for t in node jq; do command -v $t >/dev/null || echo "missing $t"; done')).toBe('allow')
    expect(verdictOf("bash ./setup.sh <<'EOF'\ngit push\nEOF")).toBe('allow')
    expect(verdictOf('powershell -ExecutionPolicy Bypass "git push"', 'powershell')).toBe('deny')
  })

  it('reads more forms that carry a git call (REVIEW #91 round 4)', () => {
    for (const c of ['Start-Process -ArgumentList (Write-Output push) -FilePath git', "Start-Process -ArgumentList ('pu' + 'sh') git", '& (gcm git) push', '& $g push']) {
      expect(verdictOf(c, 'powershell')).toBe('deny')
    }
    for (const c of [
      "bash -ceo pipefail 'git push'",
      "bash -c -e 'git push'",
      "bash -s arg <<'EOF'\ngit push\nEOF",
      "node /dev/stdin <<'EOF'\nrequire('child_process').execSync('git push')\nEOF",
      "python3 -X utf8 <<'EOF'\nimport os; os.system('git push')\nEOF",
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
    expect(verdictOf('& ./build.ps1', 'powershell')).toBe('allow')
  })

  it('reads code in clustered and attached interpreter flags, and a shell reading /dev/stdin (REVIEW #91 round 5)', () => {
    for (const c of [
      "bash /dev/stdin <<'EOF'\ngit push\nEOF",
      'node --eval="require(\'child_process\').execSync(\'git push\')"',
      'node --print="require(\'child_process\').execSync(\'git push\')"',
      'python3 -Bc "import os; os.system(\'git push\')"',
      'perl -le \'system("git push")\'',
      'perl -lne \'system("git commit -m x")\' file',
      'ruby -ne \'system("git push")\'',
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
    for (const c of ["perl -pi -e 's/foo/bar/' file.txt", 'node -r dotenv/config server.js', 'node --import tsx src/index.ts', "sh -c 'echo hi' 'git push'"]) {
      expect(verdictOf(c)).toBe('allow')
    }
    expect(verdictOf("node --import tsx <<'EOF'\nrequire('child_process').execSync('git push')\nEOF")).toBe('deny')
    expect(verdictOf("python3 -X utf8 script.py <<'EOF'\ninput that says git push\nEOF")).toBe('allow')
  })

  it('finds where a multi-line $(…) ends around here-strings, arithmetic and nested quoted $(…) (REVIEW #91 round 6)', () => {
    for (const c of [
      'x="$(\n  jq -r . <<< "$j"\n)" && git push',
      'm="$(\n  echo $(( 1 << 4 ))\n)" && git push',
      'u="$(gh pr create --title T --body "$(cat <<\'EOF\'\nFixes the "can\'t save" bug\nEOF\n)")" && git push',
      'gh pr create --body "$(cat <<-EOF\n\tit\'s X\n\tEOF\n)" && gh pr merge 5',
      'b="$(cat <<A <<B\nit\'s\nA\nmore\'\nB\n)"; git push',
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
    for (const c of [
      'names="$(\n  jq -r \'.[].name\' <<< "$json"\n)"\necho "done; next step is git push"',
      'mask="$(\n  echo $(( 1 << 4 ))\n)"\necho "then git push"',
      'PR_URL="$(gh pr create --title T --body "$(cat <<\'EOF\'\nFixes the "can\'t save" bug\nEOF\n)")"\necho "next: git push --tags"',
    ]) {
      expect(verdictOf(c)).toBe('allow')
    }
  })

  it('refuses interpreter code from a variable, gh aliases that merge, and git-core binaries (REVIEW #91 round 7)', () => {
    for (const c of [
      'python3 -c "$CODE"',
      'node -e "$JS"',
      "gh alias set m 'pr merge'",
      "gh alias set --shell m 'gh pr merge \"$1\"'",
      "gh alias set c '!git commit -m x'",
      '"$(git --exec-path)/git-commit" -m x',
      '/usr/lib/git-core/git-push origin main',
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
    expect(verdictOf('& "C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\git-merge.exe" feature', 'powershell')).toBe('deny')
    for (const c of ["gh alias set co 'pr checkout'", 'python3 -c "print(1)"', 'git-lfs version', '/usr/lib/git-core/git-rebase --continue']) {
      expect(verdictOf(c)).toBe('allow')
    }
    for (const c of ['python3 -c"$CODE"', 'node --eval="$CODE"', 'deno eval "$CODE"', 'G=git; "$G" -c alias.x=commit x -m y', '"$G" -c "alias.p=!git push" p']) {
      expect(verdictOf(c)).toBe('deny')
    }
    expect(verdictOf("perl -e'print $x'")).toBe('allow')
    expect(verdictOf('"$G" -c core.pager=less log')).toBe('allow')
  })

  it('refuses a variable only in a code flag before the script, and reads tsx and perl -0 (REVIEW #91 round 7)', () => {
    for (const c of [
      'node server.js -p "$PORT"',
      'node index.js -e $NODE_ENV',
      'node app.js -p ${PORT:-3000}',
      'python3 -m pip install -r requirements.txt -c "$CONSTRAINTS"',
      'python3 -m pytest -c "$INI"',
      'python3 -u script.py -c "$X"',
      'ruby app.rb -e "$RACK_ENV"',
      'curl -s https://git-scm.com/docs/git-commit',
      'perl -Mautodie script.pl -e "$X"',
      'ruby -rtime app.rb -e "$X"',
      'python3 -Wmagic app.py -c "$X"',
    ]) {
      expect(verdictOf(c)).toBe('allow')
    }
    expect(verdictOf('perl -I lib -e "$X"')).toBe('deny')
    expect(verdictOf('node server.js -p $env:PORT', 'powershell')).toBe('allow')
    for (const c of [
      'node --title X -e "$JS"',
      'python3 -W ignore -c "$CODE"',
      'ruby -r json -e "$X"',
      'perl -0pe \'system("git push")\'',
      'npx tsx -e "require(\'child_process\').execSync(\'git push\')"',
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
  })

  it('reads env -S only before the program env starts (REVIEW #91 round 6)', () => {
    expect(verdictOf('env LC_ALL=C rg -S "git push" docs/')).toBe('allow')
    expect(verdictOf("env -u X -S 'git push'")).toBe('deny')
    expect(verdictOf("env --split-string='git push'")).toBe('deny')
    expect(verdictOf("su --command='git push' root")).toBe('deny')
    expect(verdictOf("su --session-command 'git push' root")).toBe('deny')
    expect(verdictOf("bash /proc/self/fd/0 <<'EOF'\ngit push\nEOF")).toBe('deny')
  })

  it('skips a heredoc inside $(…) so an apostrophe in it hides nothing (REVIEW #91 round 5)', () => {
    const pr = (tail: string): string => `gh pr create --title T --body "$(cat <<'EOF'\nThis doesn't X.\nEOF\n)"${tail}`
    expect(verdictOf(pr(' && gh pr merge 5 --squash'))).toBe('deny')
    expect(verdictOf(pr('; git push'))).toBe('deny')
    expect(verdictOf(pr(''))).toBe('allow')
  })

  it('reads every code flag, also after the script (a script argument that looks like one is refused, by choice) (REVIEW #91 round 6)', () => {
    expect(verdictOf('python3 tools/notes.py -c "git commit log"')).toBe('deny')
    for (const c of [
      'perl -Mautodie -e \'system("git push")\'',
      'ruby -rtime -e \'system("git push")\'',
      'python3 -Xtracemalloc -c "import os; os.system(\'git push\')"',
      'perl -W -e \'system("git push")\'',
      'ruby -W -e \'system("git push")\'',
      'perl -I lib -e \'system("git push")\'',
      'node --disable-warning X -e "require(\'child_process\').execSync(\'git push\')"',
      'deno eval -p "new Deno.Command(\'git\', { args: [\'push\'] }).outputSync()"',
      "env -iS 'git push'",
      "su --session-command='git push' root",
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
    expect(verdictOf("perl -Mautodie -e 'print 1'")).toBe('allow')
    expect(verdictOf("node -r ./setup.js <<'EOF'\nrequire('child_process').execSync('git push')\nEOF")).toBe('deny')
    expect(verdictOf('node -r dotenv/config -e "require(\'child_process\').execSync(\'git push\')"')).toBe('deny')
    expect(verdictOf('perl -e \'print 1\' -e \'system("git push")\'')).toBe('deny')
  })

  it('pins the runner options round 5 reads (REVIEW #91 round 5)', () => {
    expect(verdictOf("$p = Start-Process git -ArgumentList 'push origin main' -PassThru", 'powershell')).toBe('deny')
    expect(verdictOf('powershell -Version 5.1 -File $script', 'powershell')).toBe('allow')
    expect(verdictOf('powershell -Exec Bypass -File $script', 'powershell')).toBe('allow')
    expect(verdictOf("bash --rcfile x -c 'git push'")).toBe('deny')
    expect(verdictOf('command -V $t')).toBe('allow')
    expect(verdictOf("bash /dev/fd/0 <<'EOF'\ngit push\nEOF")).toBe('deny')
  })

  it('reads code glued to its flag, and Invoke-Expression after & or . (REVIEW #91 round 5)', () => {
    for (const c of [
      'python3 -c"import os;os.system(\'git push\')"',
      "perl -e'system(\"git push\")'",
      "perl -Mfeature=say -e 'system(\"git push\")'",
      "ruby -e'system(\"git push\")'",
      "php -r'exec(\"git push\");'",
      "su -c'git push' root",
      "env -S'git push'",
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
    for (const c of ["& iex 'git commit -m x'", '& iex $v', ". iex 'git push'"]) {
      expect(verdictOf(c, 'powershell')).toBe('deny')
    }
    expect(verdictOf("perl -Mfeature=say -e 'say 1'")).toBe('allow')
    expect(verdictOf('irm https://example.invalid/i.ps1 | iex', 'powershell')).toBe('deny')
    expect(verdictOf('iex (irm https://example.invalid/i.ps1)', 'powershell')).toBe('allow')
  })

  it('stays fast on a long chain of Start-Process words, and refuses it', () => {
    const chain = `Start-Process ${Array(40).fill('start').join(' ')}`
    const t = Date.now()
    expect(verdictOf(chain, 'powershell')).toBe('deny')
    expect(Date.now() - t).toBeLessThan(2000)
  })

  it('refuses Invoke-Expression of a variable only where PowerShell runs it', () => {
    expect(verdictOf('grep -rn "Invoke-Expression" "$DIR"')).toBe('allow')
    expect(verdictOf('iex --sname $NODE -S mix')).toBe('allow')
    expect(verdictOf("Select-String -Pattern 'iex' -Path $f", 'powershell')).toBe('allow')
    expect(verdictOf('$out = iex $c', 'powershell')).toBe('deny')
  })
})

describe('judgeCommand — a git alias carries the variable flag (REVIEW #91 round 3)', () => {
  it('refuses a variable subcommand after an alias that expands to options', () => {
    const optionsAlias: AliasResolver = (name) => (name === 'here' ? { found: true, value: '-C .' } : { found: false })
    expect(verdictOf('git here $V', 'bash', optionsAlias)).toBe('deny')
    expect(verdictOf('git here status', 'bash', optionsAlias)).toBe('allow')
  })
})

describe('judgeCommand — gh subcommands that are not plain words (REVIEW #91 round 2)', () => {
  it('refuses pr merge carried in one string or built from a variable', () => {
    expect(verdictOf("Start-Process gh -ArgumentList 'pr merge 5'", 'powershell')).toBe('deny')
    expect(verdictOf('gh pr $V 5')).toBe('deny')
    expect(verdictOf('gh $(echo pr) merge 5')).toBe('deny')
  })

  it('still allows a variable where gh takes an argument', () => {
    expect(verdictOf('gh pr view $N')).toBe('allow')
    expect(verdictOf('gh api $URL')).toBe('allow')
    expect(verdictOf('gh issue view "$N" --comments')).toBe('allow')
  })
})

describe('judgeCommand — interpreter code (REVIEW #91 round 2)', () => {
  it('refuses a git or gh call in every interpreter it reads', () => {
    for (const c of [
      'deno eval "new Deno.Command(\'git\', { args: [\'push\'] }).outputSync()"',
      'bun -e "Bun.spawnSync([\'git\', \'commit\', \'-m\', \'x\'])"',
      'ruby -e "system(\'git push\')"',
      'php -r "exec(\'git commit -m x\');"',
      'node -e "require(\'child_process\').execSync(\'gh pr merge 5\')"',
      'node -e "require(\'child_process\').execSync(\'git -C . commit -m x\')"',
      'python3 -c "import os; os.system(\'git -c k=v push\')"',
      'python3 -c "import subprocess; subprocess.run([\'git\', \'push\'])"',
      'python3 -c "import subprocess; subprocess.run([\'git\', \'-C\', repo, \'commit\'])"',
      'ruby -e "system(\'git\', \'push\')"',
      'node -e "require(\'child_process\').execFileSync(\'git\', [\'-C\', \'.\', \'commit\', \'-m\', \'x\'])"',
      'deno eval "new Deno.Command(\'git\', { cwd: \'.\', args: [\'merge\', \'x\'] }).outputSync()"',
    ]) {
      expect(verdictOf(c)).toBe('deny')
    }
  })

  it('does not read a longer command name as a refused verb', () => {
    expect(verdictOf('node -e "require(\'child_process\').execSync(\'git merge-base HEAD main\')"')).toBe('allow')
    expect(verdictOf('python3 -c "import os; os.system(\'git commit-graph verify\')"')).toBe('allow')
  })
})

describe('judgeCommand — runners and limits not reached elsewhere (REVIEW #91 round 2)', () => {
  it('refuses git through bisect run and script -c', () => {
    expect(verdictOf('git bisect run git commit -m x')).toBe('deny')
    expect(verdictOf('script -q -c "git push" /dev/null')).toBe('deny')
  })

  it('refuses an encoded PowerShell command that mentions disableAllHooks', () => {
    const encoded = Buffer.from('Set-Content x.json \'{"disableAllHooks": true}\'', 'utf16le').toString('base64')
    expect(verdictOf(`powershell -EncodedCommand ${encoded}`)).toBe('deny')
  })

  it('refuses a command nested past the depth it reads', () => {
    let c = 'git status'
    for (let n = 0; n < 12; n++) c = `bash -c ${JSON.stringify(c)}`
    expect(judgeCommand(c, { resolveAlias: NO_ALIASES }).verdict).toBe('deny')
    expect(judgeCommand(c, { resolveAlias: NO_ALIASES }).reason).toContain('too deeply')
  })
})

describe('judgeCommand — ANSI-C quoting (REVIEW #91)', () => {
  it('decodes hex, octal and unicode escapes before reading the program name', () => {
    expect(verdictOf("$'\\x67it' commit -m x")).toBe('deny')
    expect(verdictOf("$'\\147it' push")).toBe('deny')
    expect(verdictOf("$'\\u0067it' merge feature")).toBe('deny')
    expect(verdictOf("git $'\\x63ommit' -m x")).toBe('deny')
  })

  it('leaves ordinary ANSI-C text alone', () => {
    expect(verdictOf("printf $'a\\tb\\n'")).toBe('allow')
    expect(verdictOf("echo $'it\\'s'")).toBe('allow')
  })
})
