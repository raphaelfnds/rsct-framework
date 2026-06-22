#!/usr/bin/env node
import { createRequire } from 'module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { resolve, isAbsolute, join, dirname } from 'path';
import { fileURLToPath } from 'url';

createRequire(import.meta.url);
var POISON_PILL_PATTERNS = [
  // Bare git mutations: Bash(git commit/push/merge ...)
  /^Bash\(\s*git\s+commit\b/i,
  /^Bash\(\s*git\s+push\b/i,
  /^Bash\(\s*git\s+merge\b/i,
  // git followed by colon or wildcard: Bash(git*), Bash(git:*)
  /^Bash\(\s*git\s*[:*]/i,
  // Blanket Bash wildcard at start: Bash(*), Bash(:*)
  /^Bash\(\s*[:*]/i,
  // Path-prefixed git mutation: Bash(/usr/bin/git commit), Bash(./bin/git push),
  // Bash(C:/Program Files/Git/bin/git merge). Lazy `[^)]*?` allows spaces inside
  // the path (Windows "Program Files") without sliding past the final separator.
  // The closing `git\s+(commit|push|merge)\b` anchor pins the basename so
  // Bash(/somewhere/git-credential-store ...) (a different binary) does NOT
  // match — the `\s+` requires whitespace, not a dash, after `git`.
  /^Bash\(\s*[^)]*?[/\\]git\s+(commit|push|merge)\b/i,
  // Shell wrapper around a git mutation: Bash(sh -c "git commit ..."), Bash(bash -c 'git push origin')
  // Any of the common POSIX shells + -c flag + content containing git commit/push/merge.
  /^Bash\(\s*(?:sh|bash|zsh|dash|fish|ksh|csh)\s+-c\b[^)]*\bgit\s+(commit|push|merge)\b/i,
  // Wildcard-around-git: Bash(*git*) and similar — the bash matcher would
  // pick up commit/push/merge inside the wildcard envelope.
  /^Bash\([^)]*\*[^)]*\bgit\b[^)]*\*/i
];
var SETTINGS_FILES = ["settings.json", "settings.local.json"];
function isPoisonPill(entry) {
  if (typeof entry !== "string") return false;
  return POISON_PILL_PATTERNS.some((re) => re.test(entry));
}
function sanitize(projectRoot, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const audit = options.auditWriter ?? ((entry) => defaultAuditWriter(projectRoot, entry, now));
  const result = { projectRoot, files: [] };
  for (const name of SETTINGS_FILES) {
    const path = join(projectRoot, ".claude", name);
    if (!existsSync(path)) {
      result.files.push({ path, status: "absent" });
      continue;
    }
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      result.files.push({
        path,
        status: "malformed",
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.files.push({ path, status: "malformed", error: message });
      audit({ event: "sanitize.malformed", file: path, error: message });
      continue;
    }
    const allow = parsed.permissions?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      result.files.push({ path, status: "no_change" });
      continue;
    }
    const stripped = [];
    const kept = [];
    for (const entry of allow) {
      if (isPoisonPill(entry)) {
        stripped.push(entry);
      } else {
        kept.push(entry);
      }
    }
    if (stripped.length === 0) {
      result.files.push({ path, status: "no_change" });
      continue;
    }
    const nextPermissions = { ...parsed.permissions ?? {}, allow: kept };
    const next = { ...parsed, permissions: nextPermissions };
    try {
      writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.files.push({ path, status: "malformed", error: message, stripped });
      continue;
    }
    result.files.push({ path, status: "sanitized", stripped });
    audit({
      event: "sanitize.stripped",
      file: path,
      stripped,
      count: stripped.length
    });
  }
  return result;
}
function defaultAuditWriter(projectRoot, entry, now) {
  try {
    const auditPath = join(projectRoot, ".rsct", "audit.log");
    mkdirSync(dirname(auditPath), { recursive: true });
    const stamped = { ...entry, ts: now.toISOString() };
    appendFileSync(auditPath, JSON.stringify(stamped) + "\n", "utf8");
  } catch {
  }
}
function resolveProjectRootFromArgs(options) {
  const { argv, env, cwd } = options;
  const idx = argv.indexOf("--project-root");
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (value && value.length > 0) {
      return isAbsolute(value) ? value : resolve(cwd, value);
    }
  }
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return cwd;
}
function main(options) {
  const projectRoot = resolveProjectRootFromArgs({
    argv: options.argv,
    env: options.env,
    cwd: options.cwd
  });
  const result = sanitize(projectRoot);
  for (const file of result.files) {
    if (file.status === "sanitized") {
      const count = file.stripped?.length ?? 0;
      const label = count === 1 ? "entry" : "entries";
      options.stderr(
        `[rsct-sanitize] stripped ${count} poison-pill ${label} from ${file.path}`
      );
    } else if (file.status === "malformed") {
      options.stderr(
        `[rsct-sanitize] could not process ${file.path}: ${file.error ?? "unknown error"}`
      );
    }
  }
  return 0;
}
function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}
if (isCliEntry()) {
  const exitCode = main({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stderr: (msg) => process.stderr.write(msg + "\n")
  });
  process.exit(exitCode);
}

export { isPoisonPill, main, resolveProjectRootFromArgs, sanitize };
//# sourceMappingURL=sanitize-permissions.js.map
//# sourceMappingURL=sanitize-permissions.js.map