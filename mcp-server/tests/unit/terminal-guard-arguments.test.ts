import { describe, it, expect } from 'vitest'
import { judgeCommand, type AliasResolver, type ShellDialect } from '../../src/lib/terminal-guard.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })
const verdictOf = (command: string, dialect: ShellDialect = 'bash'): string => judgeCommand(command, { dialect, resolveAlias: NO_ALIASES }).verdict

const REFUSED = [
  "psql -c '\\! git commit -am x'",
  "sqlite3 app.db '.shell git commit -am x'",
  "mysql -e 'system git push origin main'",
  "awk 'BEGIN{system(\"git commit -am x\")}'",
  "vim -c '!git commit -am x' -c q",
  "watch -n 60 'git push'",
  "git -c core.sshCommand='sh -c \"git commit -am x\"' fetch",
  "git -c diff.external='git push' diff",
  "git config core.pager 'sh -c \"git push\"'",
  "npx -c 'git push'",
  "npm exec -c 'git push'",
  "mongosh --eval \"require('child_process').execSync('git commit -am x')\"",
  "psql <<'SQL'\n\\! git push\nSQL",
  "make -f - <<'EOF'\nall:\n\tgit push\nEOF",
  "find . -maxdepth 0 -exec vim -c '!git push' {} \\;",
]

const ALLOWED = [
  'grep -rn "git push" docs/',
  'rg "git commit" src',
  'echo "remember to git push later"',
  "printf '%s\\n' 'git push'",
  'git log --grep "git push"',
  'git stash list',
  'git config alias.ci commit',
  "find . -name '*.md' -exec grep -l \"git push\" {} +",
  'ls docs | xargs grep -l "git merge"',
  '[ "$s" = "git merge x" ]',
  'export NOTE="after git push"',
  "curl -d '{\"text\":\"git push\"}' https://example.invalid/hook",
  "jq --arg m 'git push' '.msg = $m' in.json",
  'gh pr create --title "Docs" --body "run git push after review"',
  "cat <<'EOF'\ngit push\nEOF",
  "tee notes.md <<'EOF'\ngit push\nEOF",
  "node scripts/notify.js --text 'git push done'",
  "python3 tools/report.py 'git push'",
]

const REFUSED_ACCEPTED = [
  'npx vitest run -t "git push"',
  "sed -n '/git push/p' notes.md",
  'make ARGS="git push"',
]

const ALLOWED_POWERSHELL = [
  "$c = $c -replace 'git push', 'x'",
  "if ($l -match 'git push') { 1 }",
  "Write-Output 'git push later'",
  "Select-String 'git commit' notes.md",
  "$body = 'run git push'",
]

describe('terminal guard — a git call written inside another program\'s arguments', () => {
  it.each(REFUSED)('refuses: %s', (c) => {
    expect(verdictOf(c)).toBe('deny')
  })
  it.each(ALLOWED)('allows: %s', (c) => {
    expect(verdictOf(c)).toBe('allow')
  })
  it.each(REFUSED_ACCEPTED)('refuses, by choice, text naming a verb that a program could run: %s', (c) => {
    expect(verdictOf(c)).toBe('deny')
  })
  it.each(ALLOWED_POWERSHELL)('allows a PowerShell expression statement: %s', (c) => {
    expect(verdictOf(c, 'powershell')).toBe('allow')
  })
  it('still refuses the same call in a PowerShell command', () => {
    expect(verdictOf("sqlite3 app.db '.shell git push'", 'powershell')).toBe('deny')
  })
})
