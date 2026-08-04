#!/usr/bin/env node
import { createRequire } from 'module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { resolve, isAbsolute, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

createRequire(import.meta.url);
function stripBom(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function hashSettingsContent(text) {
  return createHash("sha256").update(stripBom(text).replace(/\r/g, "")).digest("hex");
}
function readTextOrNull(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
function hashSettingsFile(projectRoot) {
  const text = readTextOrNull(join(projectRoot, ".claude", "settings.json"));
  return text === null ? null : hashSettingsContent(text);
}

// src/scripts/sanitize-permissions.ts
var GIT_GLOBAL_OPT = [
  `-[cC]\\s+(?:"[^"]*"|'[^']*'|[^\\s)]+)`,
  // -C <path>, -c key=value
  '--(?:git-dir|work-tree|exec-path|namespace)=(?:"[^"]*"|[^\\s)]+)',
  "--(?:no-pager|paginate|bare|literal-pathspecs|no-replace-objects)",
  "-p\\b"
].join("|");
var GIT_GLOBALS = `(?:\\s+(?:${GIT_GLOBAL_OPT}))*`;
var POISON_PILL_PATTERNS = [
  // Git mutations, with any run of global options between `git` and the
  // subcommand: Bash(git commit ...), Bash(git -C /repo commit),
  // Bash(git --git-dir=/r/.git push), Bash(git -c user.name=x merge).
  new RegExp(`^Bash\\(\\s*git${GIT_GLOBALS}\\s+(?:commit|push|merge)(?![\\w-])`, "i"),
  // A wildcard stands where the SUBCOMMAND should be, so it authorises every
  // subcommand — commit included: Bash(git*), Bash(git:*), Bash(git -C:*).
  // The option class deliberately excludes `:` and `*` so the wildcard is not
  // swallowed as part of an option token.
  /^Bash\(\s*git(?:\s+-[^\s:*)]*)*\s*[:*]/i,
  // Blanket Bash wildcard at start: Bash(*), Bash(:*)
  /^Bash\(\s*[:*]/i,
  // Path-prefixed git mutation: Bash(/usr/bin/git commit), Bash(./bin/git push),
  // Bash(C:/Program Files/Git/bin/git merge). Lazy `[^)]*?` allows spaces inside
  // the path (Windows "Program Files") without sliding past the final separator.
  // The closing `git\s+(commit|push|merge)(?![\w-])` anchor pins the basename so
  // Bash(/somewhere/git-credential-store ...) (a different binary) does NOT
  // match — the `\s+` requires whitespace, not a dash, after `git`.
  /^Bash\(\s*[^)]*?[/\\]git\s+(commit|push|merge)(?![\w-])/i,
  // Shell wrapper around a git mutation: Bash(sh -c "git commit ..."), Bash(bash -c 'git push origin')
  // Any of the common POSIX shells + -c flag + content containing git commit/push/merge.
  /^Bash\(\s*(?:sh|bash|zsh|dash|fish|ksh|csh)\s+-c\b[^)]*\bgit\s+(commit|push|merge)(?![\w-])/i,
  // Wildcard-around-git: Bash(*git*) and similar — the bash matcher would
  // pick up commit/push/merge inside the wildcard envelope.
  /^Bash\([^)]*\*[^)]*\bgit\b[^)]*\*/i
];
var SETTINGS_FILES = ["settings.json", "settings.local.json"];
function isPoisonPill(entry) {
  if (typeof entry !== "string") return false;
  return POISON_PILL_PATTERNS.some((re) => re.test(entry));
}
function isAbsoluteEntry(v) {
  return typeof v === "string" && (isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v));
}
var MACHINE_HOME_RE = new RegExp(
  [
    // C:\Users\ · c:/users/ — a drive letter is unambiguous wherever it appears,
    // so this branch needs no anchor. Case-folded by explicit class rather than
    // the `i` flag, because the POSIX branches below MUST stay case-sensitive.
    "[A-Za-z]:[\\\\/]{1,2}[Uu][Ss][Ee][Rr][Ss][\\\\/]",
    // /home/<user>/ and /Users/<user>/ must start a TOKEN, not appear mid-path.
    // Unanchored, `/home/` matched `Read(src/pages/home/**)` and `/users/`
    // matched `Bash(gh api /users/octocat)` — and a false positive here DELETES a
    // working permission from the file the whole team shares.
    `(^|[\\s"'=(,;])/home/`,
    // Capital U is load-bearing: macOS is `/Users/`, while `/users/` lower-case
    // is an API path (`gh api /users/x`, `localhost:3000/api/users/1`).
    `(^|[\\s"'=(,;])/Users/`,
    // WSL reaching a Windows drive. Not subsumed by the branch above: here
    // `/Users/` is preceded by the drive letter, not by a token boundary.
    "/mnt/[a-z]/[Uu]sers/",
    // Windows reaching WSL, in both spellings — the `\\` form is what a Windows
    // shell actually produces, and it is the CAP-41 field-report environment.
    "//wsl\\.localhost/",
    "\\\\\\\\wsl\\.localhost\\\\"
  ].join("|")
);
function containsMachinePath(v) {
  return typeof v === "string" && MACHINE_HOME_RE.test(v);
}
function migrateAbsoluteEntries(projectRoot, key, matches, audit) {
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return null;
  let settings;
  try {
    settings = JSON.parse(stripBom(readFileSync(settingsPath, "utf8")));
  } catch {
    return null;
  }
  const dirs = settings.permissions?.[key];
  if (!Array.isArray(dirs) || dirs.length === 0) return null;
  const absolute = dirs.filter(matches);
  if (absolute.length === 0) return null;
  const localPath = join(projectRoot, ".claude", "settings.local.json");
  let local = {};
  if (existsSync(localPath)) {
    try {
      local = JSON.parse(stripBom(readFileSync(localPath, "utf8")));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      audit({ event: "sanitize.migration_skipped", file: settingsPath, reason: "local_malformed", error });
      return { path: settingsPath, status: "migration_skipped", error: `settings.local.json malformed: ${error}` };
    }
  }
  const localPerms = local.permissions && typeof local.permissions === "object" ? { ...local.permissions } : {};
  const localDirs = Array.isArray(localPerms[key]) ? localPerms[key] : [];
  const localSet = new Set(localDirs.filter((x) => typeof x === "string"));
  const toAdd = absolute.filter((a) => !localSet.has(a));
  const nextLocal = {
    ...local,
    permissions: { ...localPerms, [key]: [...localDirs, ...toAdd] }
  };
  try {
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, JSON.stringify(nextLocal, null, 2) + "\n", "utf8");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    audit({ event: "sanitize.migration_skipped", file: settingsPath, reason: "local_write_failed", error });
    return { path: settingsPath, status: "migration_skipped", error: `settings.local.json write failed: ${error}` };
  }
  const keptDirs = dirs.filter((d) => !matches(d));
  const nextSettings = {
    ...settings,
    permissions: { ...settings.permissions, [key]: keptDirs }
  };
  try {
    writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + "\n", "utf8");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    audit({ event: "sanitize.migration_skipped", file: settingsPath, reason: "source_write_failed", error });
    return { path: settingsPath, status: "migration_skipped", error: `settings.json write failed: ${error}` };
  }
  audit({ event: "sanitize.migrated", file: settingsPath, key, migrated: absolute, to: localPath, count: absolute.length });
  return { path: settingsPath, status: "migrated", stripped: absolute };
}
function mergeMigrations(results) {
  const present = results.filter((r) => r !== null);
  if (present.length === 0) return null;
  const skipped = present.find((r) => r.status === "migration_skipped");
  if (skipped) return skipped;
  const stripped = present.flatMap((r) => r.stripped ?? []);
  return { path: present[0].path, status: "migrated", stripped };
}
function sanitize(projectRoot, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const audit = options.auditWriter ?? ((entry) => defaultAuditWriter(projectRoot, entry, now));
  const result = { projectRoot, files: [] };
  const migration = mergeMigrations([
    migrateAbsoluteEntries(projectRoot, "additionalDirectories", isAbsoluteEntry, audit),
    migrateAbsoluteEntries(projectRoot, "allow", containsMachinePath, audit)
  ]);
  if (migration) result.files.push(migration);
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
      parsed = JSON.parse(stripBom(raw));
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
  const baselineHash = hashSettingsFile(projectRoot);
  if (baselineHash !== null) {
    audit({ event: "settings.baseline", file: join(projectRoot, ".claude", "settings.json"), hash: baselineHash });
  }
  return result;
}
function resolveAuditLogPath(projectRoot) {
  try {
    const raw = stripBom(readFileSync(join(projectRoot, ".rsct.json"), "utf8"));
    const cfg = JSON.parse(raw);
    const configured = cfg.audit?.path;
    if (typeof configured === "string" && configured.length > 0) {
      return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
    }
  } catch {
  }
  return join(projectRoot, ".rsct", "audit.log");
}
function defaultAuditWriter(projectRoot, entry, now) {
  try {
    const auditPath = resolveAuditLogPath(projectRoot);
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
    } else if (file.status === "migrated") {
      const count = file.stripped?.length ?? 0;
      const label = count === 1 ? "path" : "paths";
      options.stderr(
        `[rsct-sanitize] migrated ${count} machine-absolute ${label} from ${file.path} to settings.local.json (keep machine paths out of the versioned file)`
      );
    } else if (file.status === "migration_skipped") {
      options.stderr(
        `[rsct-sanitize] skipped migrating absolute paths from ${file.path}: ${file.error ?? "unknown error"} (settings.json left untouched)`
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

export { containsMachinePath, isAbsoluteEntry, isPoisonPill, main, resolveProjectRootFromArgs, sanitize };
//# sourceMappingURL=sanitize-permissions.js.map
//# sourceMappingURL=sanitize-permissions.js.map