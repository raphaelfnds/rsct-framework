#!/usr/bin/env node
import { createRequire } from 'module';
import { readFileSync, statSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { resolve, join, dirname, basename, isAbsolute } from 'path';
import { spawnSync } from 'child_process';

createRequire(import.meta.url);
var MAX_PACKAGE_BYTES = 1024 * 1024;
var MAX_LISTED = 200;
var MAX_LISTED_DIRS = 2e3;
var MAX_LIST_DEPTH = 5;
var MANAGERS = /* @__PURE__ */ new Map([
  ["npm", "npm"],
  ["pnpm", "pnpm"],
  ["yarn", "yarn"],
  ["yarnpkg", "yarn"],
  ["bun", "bun"],
  ["composer", "composer"],
  ["composer.phar", "composer"]
]);
var EXEC_RUNNERS = /* @__PURE__ */ new Set(["npx", "pnpx", "bunx"]);
var PACKAGE_FILE_NAME = /\b(?:package\.json5?|package\.yaml|composer\.json|packag~\d+\.(?:jso|yam)|compos~\d+\.jso)\b/i;
var defaultPackageReader = (path) => {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { kind: "missing" };
  }
  if (!st.isFile()) return { kind: "unreadable", reason: `${path} is not a regular file` };
  if (st.size > MAX_PACKAGE_BYTES) return { kind: "unreadable", reason: `${path} is larger than ${MAX_PACKAGE_BYTES / 1024} KiB` };
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (e) {
    return { kind: "unreadable", reason: `${path} could not be read (${e.message})` };
  }
};
var defaultPackageLister = (root, file) => {
  const files = [];
  let dirs = 0;
  let complete = true;
  const walk = (dir, depth) => {
    if (!complete) return;
    if (++dirs > MAX_LISTED_DIRS) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || e.name !== file) continue;
      if (files.length >= MAX_LISTED) {
        complete = false;
        return;
      }
      files.push(join(dir, e.name));
    }
    if (depth >= MAX_LIST_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== "vendor" && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return { files, complete };
};
function resolveFolder(base, target) {
  let t = target;
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) t = join(homedir(), t.slice(1));
  if (process.platform === "win32") {
    const drive = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(t);
    if (drive) t = `${drive[1].toUpperCase()}:\\${drive[2] ?? ""}`;
  }
  if (isAbsolute(t)) return resolve(t);
  return base === void 0 ? void 0 : resolve(base, t);
}
function findUp(dir, file, reader) {
  let current = resolve(dir);
  for (; ; ) {
    const path = join(current, file);
    const read = reader(path);
    if (read.kind !== "missing") return { path, read };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function repoRoot(dir, reader) {
  let current = resolve(dir);
  for (; ; ) {
    if (reader(join(current, ".git")).kind !== "missing") return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function parsePackage(path, read) {
  if (read.kind === "unreadable") return { ok: false, reason: read.reason };
  const text = read.text.charCodeAt(0) === 65279 ? read.text.slice(1) : read.text;
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: `${path} is not a JSON object` };
    return { ok: true, json };
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
}
function scriptsOf(json) {
  const s = json.scripts;
  return s && typeof s === "object" && !Array.isArray(s) ? s : null;
}
function scriptTexts(manager, json, name) {
  const scripts = scriptsOf(json);
  if (scripts === null || !Object.prototype.hasOwnProperty.call(scripts, name)) return [];
  if (manager !== "composer") {
    const v = scripts[name];
    return typeof v === "string" ? [v] : [];
  }
  return composerTexts(scripts, name, /* @__PURE__ */ new Set());
}
function composerTexts(scripts, name, seen) {
  if (seen.has(name) || !Object.prototype.hasOwnProperty.call(scripts, name)) return [];
  seen.add(name);
  const raw = scripts[name];
  const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  const texts = [];
  for (const item of items) {
    const s = item.trim();
    if (s.startsWith("@putenv")) continue;
    if (s.startsWith("@php ")) texts.push(`php ${s.slice(5)}`);
    else if (s.startsWith("@composer ")) texts.push(`composer ${s.slice(10)}`);
    else if (s.startsWith("@")) texts.push(...composerTexts(scripts, s.slice(1).split(/\s+/)[0], seen));
    else if (/^[A-Za-z_\\][\w\\]*::\w+$/.test(s)) continue;
    else texts.push(s);
  }
  return texts;
}
var INSTALL_WORDS = /* @__PURE__ */ new Set([
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "isntall-clean",
  "install-test",
  "it",
  "install-ci-test",
  "cit",
  "clean-install-test",
  "sit",
  "update",
  "up",
  "upgrade",
  "udpate",
  "rebuild",
  "rb",
  "link",
  "ln",
  "remove",
  "rm",
  "r",
  "un",
  "uninstall",
  "unlink",
  "dedupe",
  "ddp",
  "prune"
]);
var INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "dependencies"];
var TEST_LIFECYCLE = ["pretest", "test", "posttest"];
var COMPOSER_INSTALL_EVENTS = [
  "pre-install-cmd",
  "post-install-cmd",
  "pre-update-cmd",
  "post-update-cmd",
  "pre-autoload-dump",
  "post-autoload-dump",
  "pre-operations-exec",
  "pre-pool-create",
  "pre-package-install",
  "post-package-install",
  "pre-package-update",
  "post-package-update",
  "pre-package-uninstall",
  "post-package-uninstall"
];
var COMPOSER_EVENT_WORDS = /* @__PURE__ */ new Set(["install", "i", "update", "u", "upgrade", "require", "r", "remove", "rm", "dump-autoload", "dumpautoload", "reinstall", "create-project"]);
var COMPOSER_CREATE_PROJECT_EVENTS = ["post-root-package-install", "post-create-project-cmd"];
var NO_SCRIPT_SWITCHES = /* @__PURE__ */ new Set(["--no-scripts", "--ignore-scripts", "--ignore-scripts=true"]);
var COMPOSER_ARCHIVE_EVENTS = ["pre-archive-cmd", "post-archive-cmd"];
var DIRECT_LIFECYCLE = /* @__PURE__ */ new Map([
  ["test", TEST_LIFECYCLE],
  ["start", ["prestart", "start", "poststart"]],
  ["stop", ["prestop", "stop", "poststop"]],
  ["restart", ["prerestart", "restart", "postrestart", "prestop", "stop", "poststop", "prestart", "start", "poststart"]],
  ["publish", ["prepublishOnly", "prepack", "prepare", "postpack", "publish", "postpublish"]],
  ["pack", ["prepack", "prepare", "postpack"]]
]);
var VERSION_HOOKS = ["preversion", "version", "postversion"];
var WRITE_SUBWORDS = /* @__PURE__ */ new Set(["set", "delete", "fix"]);
var FOLDER_OPTIONS = /* @__PURE__ */ new Map([
  ["npm", /* @__PURE__ */ new Set(["--prefix", "-C"])],
  ["pnpm", /* @__PURE__ */ new Set(["-C", "--dir"])],
  ["yarn", /* @__PURE__ */ new Set(["--cwd"])],
  ["bun", /* @__PURE__ */ new Set(["--cwd"])],
  ["composer", /* @__PURE__ */ new Set(["-d", "--working-dir"])]
]);
var WORKSPACE_SWITCHES = /* @__PURE__ */ new Map([
  ["npm", /* @__PURE__ */ new Set(["--workspaces", "-ws", "--include-workspace-root"])],
  ["pnpm", /* @__PURE__ */ new Set(["-r", "--recursive"])],
  ["yarn", /* @__PURE__ */ new Set()],
  ["bun", /* @__PURE__ */ new Set()],
  ["composer", /* @__PURE__ */ new Set()]
]);
var WORKSPACE_VALUES = /* @__PURE__ */ new Map([
  ["npm", /* @__PURE__ */ new Set(["-w", "--workspace"])],
  ["pnpm", /* @__PURE__ */ new Set(["--filter", "-F"])],
  ["yarn", /* @__PURE__ */ new Set(["--filter", "-F"])],
  ["bun", /* @__PURE__ */ new Set(["--filter", "-F"])],
  ["composer", /* @__PURE__ */ new Set()]
]);
var GLOBAL_SWITCHES = /* @__PURE__ */ new Set(["-g", "--global", "--location=global", "--localtion=global"]);
var WORKSPACE_WORDS = /* @__PURE__ */ new Set(["workspace", "workspaces"]);
var RUN_WORDS = /* @__PURE__ */ new Set(["run", "run-script", "rum", "urn"]);
var VALUE_OPTIONS = /* @__PURE__ */ new Set(["--loglevel", "--registry", "--userconfig", "--globalconfig", "--cache", "--tag", "--otp", "--access", "--scope", "--reporter"]);
var EXEC_WORDS = /* @__PURE__ */ new Set(["exec", "x", "dlx"]);
var EXEC_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-p", "--package", "-w", "--workspace", "--prefix", "-C", "--dir", "--filter", "-F", "--cwd", "--registry"]);
var EXEC_CODE_OPTIONS = /* @__PURE__ */ new Set(["-c", "--call", "--shell-mode"]);
var NO_TAG_SWITCHES = /* @__PURE__ */ new Set(["--no-git-tag-version", "--git-tag-version=false"]);
var COMPOSER_BUILTINS = /* @__PURE__ */ new Set([
  "about",
  "archive",
  "audit",
  "browse",
  "home",
  "bump",
  "check-platform-reqs",
  "clear-cache",
  "clearcache",
  "config",
  "create-project",
  "depends",
  "why",
  "diagnose",
  "dump-autoload",
  "dumpautoload",
  "exec",
  "fund",
  "global",
  "help",
  "init",
  "install",
  "i",
  "licenses",
  "list",
  "outdated",
  "prohibits",
  "why-not",
  "reinstall",
  "remove",
  "require",
  "run-script",
  "run",
  "search",
  "self-update",
  "selfupdate",
  "show",
  "info",
  "status",
  "suggests",
  "update",
  "u",
  "upgrade",
  "validate"
]);
var YARN_BUILTINS = /* @__PURE__ */ new Set([
  "add",
  "audit",
  "autoclean",
  "bin",
  "cache",
  "check",
  "config",
  "constraints",
  "create",
  "dedupe",
  "dlx",
  "exec",
  "explain",
  "generate-lock-entry",
  "global",
  "help",
  "import",
  "info",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "login",
  "logout",
  "node",
  "npm",
  "outdated",
  "owner",
  "pack",
  "patch",
  "patch-commit",
  "plugin",
  "policies",
  "publish",
  "rebuild",
  "remove",
  "set",
  "stage",
  "tag",
  "team",
  "unlink",
  "unplug",
  "up",
  "upgrade",
  "upgrade-interactive",
  "version",
  "versions",
  "why",
  "workspace",
  "workspaces",
  "run"
]);
var PNPM_BUILTINS = /* @__PURE__ */ new Set([
  "add",
  "audit",
  "bin",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "doctor",
  "env",
  "exec",
  "fetch",
  "import",
  "init",
  "install",
  "i",
  "install-test",
  "it",
  "licenses",
  "link",
  "list",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "root",
  "server",
  "setup",
  "store",
  "unlink",
  "update",
  "up",
  "why",
  "version",
  "ci",
  "run",
  "test",
  "t",
  "start",
  "restart",
  "stop"
]);
var BUN_BUILTINS = /* @__PURE__ */ new Set([
  "test",
  "install",
  "i",
  "add",
  "a",
  "remove",
  "rm",
  "x",
  "build",
  "init",
  "create",
  "upgrade",
  "pm",
  "link",
  "unlink",
  "outdated",
  "publish",
  "patch",
  "repl",
  "exec",
  "run",
  "update",
  "audit",
  "info",
  "why"
]);
var FALLBACK_BUILTINS = /* @__PURE__ */ new Map([
  ["yarn", YARN_BUILTINS],
  ["pnpm", PNPM_BUILTINS],
  ["bun", BUN_BUILTINS]
]);
function withHooks(name) {
  return [`pre${name}`, name, `post${name}`];
}
function planExecRunner(args) {
  return execFrom(args, 0);
}
function execFrom(args, from) {
  const execCode = [];
  let k = from;
  while (k < args.length) {
    const a = args[k];
    if (a === "--") return { execAt: k + 1 < args.length ? k + 1 : null, execCode };
    const eq = /^(--[\w-]+)=(.*)$/s.exec(a);
    if (eq) {
      if (EXEC_CODE_OPTIONS.has(eq[1])) execCode.push({ at: k, value: eq[2] });
      k++;
      continue;
    }
    if (EXEC_CODE_OPTIONS.has(a)) {
      if (k + 1 < args.length) execCode.push({ at: k + 1, value: args[k + 1] });
      k += 2;
      continue;
    }
    if (a.startsWith("-")) {
      k += EXEC_VALUE_OPTIONS.has(a) ? 2 : 1;
      continue;
    }
    return { execAt: k, execCode };
  }
  return { execAt: null, execCode };
}
function planManager(manager, args) {
  const folderOptions = FOLDER_OPTIONS.get(manager);
  const workspaceSwitches = WORKSPACE_SWITCHES.get(manager);
  const workspaceValues = WORKSPACE_VALUES.get(manager);
  const words = [];
  const folders = [];
  const switches = /* @__PURE__ */ new Set();
  let workspaces = false;
  let global = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") break;
    const eq = /^(--?[\w-]+)=(.*)$/s.exec(a);
    if (eq) {
      switches.add(a);
      if (GLOBAL_SWITCHES.has(a.toLowerCase())) global = true;
      if (folderOptions.has(eq[1])) folders.push({ at: k, value: eq[2] });
      if (workspaceValues.has(eq[1])) workspaces = true;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      const takesValue = folderOptions.has(a) || workspaceValues.has(a) || VALUE_OPTIONS.has(a);
      if (manager !== "composer" && !takesValue && /^(true|false)$/.test(args[k + 1] ?? "")) {
        switches.add(`${a}=${args[k + 1]}`);
        k++;
        continue;
      }
      switches.add(a);
      if (GLOBAL_SWITCHES.has(a)) global = true;
      if (workspaceSwitches.has(a)) workspaces = true;
      if (folderOptions.has(a)) {
        if (k + 1 < args.length) folders.push({ at: k + 1, value: args[k + 1] });
        k++;
      } else if (workspaceValues.has(a)) {
        workspaces = true;
        if (args[k + 1] !== void 0 && !args[k + 1].startsWith("-")) k++;
      } else if (VALUE_OPTIONS.has(a)) k++;
      continue;
    }
    words.push({ value: a, at: k });
  }
  const file = manager === "composer" ? "composer.json" : "package.json";
  const first = words[0]?.value;
  const lifecycleFirst = (manager === "npm" || manager === "pnpm") && (first === "t" || first === "tst") ? "test" : first;
  const builtins = FALLBACK_BUILTINS.get(manager);
  let nameWord;
  const names = /* @__PURE__ */ new Set();
  if (manager === "composer") {
    if ((first === "run" || first === "run-script") && words[1] !== void 0) nameWord = words[1];
    else if (first !== void 0 && !COMPOSER_BUILTINS.has(first)) nameWord = words[0];
    if (first !== void 0 && COMPOSER_EVENT_WORDS.has(first)) for (const n of COMPOSER_INSTALL_EVENTS) names.add(n);
    if (first === "create-project") for (const n of COMPOSER_CREATE_PROJECT_EVENTS) names.add(n);
    if (first === "archive") for (const n of COMPOSER_ARCHIVE_EVENTS) names.add(n);
    if (nameWord !== void 0) names.add(nameWord.value);
  } else {
    if (RUN_WORDS.has(first ?? "")) nameWord = words[1];
    else if (manager === "yarn" && first === "workspace") nameWord = words[2];
    else if (manager === "yarn" && first === "workspaces") {
      const at = words.findIndex((w) => w.value === "run");
      nameWord = at !== -1 ? words[at + 1] : void 0;
    } else if (manager !== "npm" && first !== void 0 && !builtins.has(first) && !(manager === "bun" && /[./\\]/.test(first))) {
      nameWord = words[0];
    }
    if (first !== void 0) {
      if (INSTALL_WORDS.has(first)) for (const n of INSTALL_LIFECYCLE) names.add(n);
      for (const n of DIRECT_LIFECYCLE.get(lifecycleFirst ?? first) ?? []) names.add(n);
      if (first === "version" && (words.length > 1 || manager === "yarn")) for (const n of VERSION_HOOKS) names.add(n);
    }
    if (manager === "yarn" && words.length === 0) for (const n of INSTALL_LIFECYCLE) names.add(n);
    if (nameWord !== void 0) for (const n of withHooks(nameWord.value)) names.add(n);
  }
  if (manager === "yarn" && WORKSPACE_WORDS.has(first ?? "")) workspaces = true;
  if ((manager === "npm" || manager === "composer") && [...switches].some((s) => NO_SCRIPT_SWITCHES.has(s))) {
    names.clear();
    if (nameWord !== void 0) names.add(nameWord.value);
    if (lifecycleFirst !== void 0 && ["test", "start", "stop", "restart"].includes(lifecycleFirst)) names.add(lifecycleFirst);
  }
  const nameAt = [...new Set([words[0]?.at, nameWord?.at].filter((n) => n !== void 0))];
  const versionAt = words.findIndex((w) => w.value === "version");
  const versionIsCommand = versionAt === 0 || manager === "yarn" && WORKSPACE_WORDS.has(first ?? "") && versionAt > 0 || manager === "bun" && first === "pm" && versionAt === 1;
  let versionCommit = false;
  if (manager !== "composer" && versionIsCommand && !(manager === "bun" && versionAt === 0)) {
    const noTag = [...switches].some((s) => NO_TAG_SWITCHES.has(s)) || args.some((a, j) => a === "--git-tag-version" && args[j + 1] === "false");
    versionCommit = !noTag && (manager === "yarn" || words.length > versionAt + 1);
  }
  const writesPackage = isPackageWrite(manager, first, words);
  let exec = { execAt: null, execCode: [] };
  if (manager === "bun" && first === "exec") {
    if (words[1] !== void 0) exec = { execAt: null, execCode: [words[1]] };
  } else if (first !== void 0 && EXEC_WORDS.has(first) && (manager !== "composer" || first === "exec")) {
    exec = execFrom(args, words[0].at + 1);
  } else if (first !== void 0 && builtins !== void 0) {
    if (first === "run" && words[1] !== void 0) exec = { execAt: words[1].at, execCode: [] };
    else if (!builtins.has(first)) exec = { execAt: words[0].at, execCode: [] };
  }
  return { file, names: [...names], nameAt, folders, workspaces, versionCommit, writesPackage, global, ...exec };
}
function isPackageWrite(manager, first, words) {
  if (first === void 0) return false;
  if (manager === "composer") return first === "init" || first === "config" && words.length >= 3;
  if (first === "init" || first === "innit" || first === "create" || first === "set-script") return true;
  if ((manager === "npm" || manager === "pnpm") && first === "pkg") return WRITE_SUBWORDS.has(words[1]?.value ?? "");
  return false;
}

// src/lib/database-switches.ts
var ON = { database: true, test: true };
function readDatabaseSwitches(start, reader = defaultPackageReader) {
  const found = findUp(start, ".rsct.json", reader);
  if (found === null) return ON;
  const parsed = parsePackage(found.path, found.read);
  if (!parsed.ok) return ON;
  return { database: parsed.json.database_guard !== false, test: parsed.json.database_test_guard !== false };
}

// src/lib/database-guard.ts
var OK = { ok: true };
function refuse(reason) {
  return { ok: false, reason };
}
var READINGS = [true, false].flatMap(
  (backslashEscapes) => [true, false].flatMap((hashComments) => [false, true].map((dashNeedsSpace) => ({ backslashEscapes, hashComments, dashNeedsSpace })))
);
function stripSql(sql, reading = READINGS[0]) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--" && (!reading.dashNeedsSpace || /^\s?$/.test(sql[i + 2] ?? ""))) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (c === "#" && reading.hashComments) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === "/*") {
      const bang = /^\/\*!(?:\d+)?/.exec(sql.slice(i));
      if (bang) {
        out += " ";
        i += bang[0].length;
        continue;
      }
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (c === "*" && sql[i + 1] === "/") {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\" && reading.backslashEscapes) {
          j += 2;
          continue;
        }
        if (sql[j] === c && sql[j + 1] === c) {
          j += 2;
          continue;
        }
        if (sql[j] === c) break;
        j++;
      }
      out += " ";
      i = j + 1;
      continue;
    }
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      out += " ";
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
var WRITE_ANYWHERE = /\b(insert|update|delete|merge|upsert|drop|truncate|alter|create|rename|grant|revoke|call|do|exec|execute|copy|import|vacuum|reindex|analyze|analyse|checkpoint|discard|lock|unlock|flush|reset|purge|kill|shutdown|restore|backup|attach|detach|reassign|setval|nextval|lo_import|lo_export|dblink|dbms_\w*|utl_\w*|xp_cmdshell|sp_executesql|bulk|outfile|dumpfile|load_file|pg_read_\w*|pg_ls_\w*|pg_write_\w*|writefile)\b/i;
var READ_LEADERS = /^\s*(select|show|explain|describe|desc|with|values|table|pragma|use|begin|start|commit|rollback|end|savepoint|release|set|reset)\b/i;
var PSQL_READ_META = /^(d\w*|l|z|sf|sv|conninfo|encoding|echo|echon|qecho|x|timing|pset|a|t|h|copyright|errverbose|watch|list|q|c|connect|\?)$/;
var MYSQL_LINE_COMMAND = /^(system|source|tee|pager|edit|delimiter)\b/i;
var PRAGMA_READ = /^pragma\s+(?:\w+\.)?(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|foreign_key_check|integrity_check|quick_check|compile_options|database_list|collation_list|function_list|module_list|pragma_list)\s*\(/i;
var SET_SAFE = /^\s*set\s+(session\s+|local\s+|global\s+|@|@@session|@@global)?\s*(search_path|time\s*zone|timezone|statement_timeout|lock_timeout|idle_in_transaction_session_timeout|client_encoding|datestyle|names|autocommit|sql_safe_updates|role|session\s+authorization|application_name|work_mem|enable_\w+|transaction|standard_conforming_strings|bytea_output|foreign_key_checks|unique_checks)\b/i;
function lineCommandVerdict(line) {
  if (line.startsWith(".")) {
    const dot = line.split(/\s+/)[0].toLowerCase();
    return SQLITE_READ_DOT.has(dot) ? OK : refuse(`the client command ${dot} is not a known read-only command`);
  }
  if (line.startsWith(":")) return refuse("an sqlcmd command (:r, :!!, :setvar \u2026) reads a file or runs a shell");
  if (MYSQL_LINE_COMMAND.test(line)) return refuse(`the client command ${line.split(/\s+/)[0]} runs a shell, reads a file or changes how statements are read`);
  return null;
}
function splitStatements(text) {
  const parts = [];
  let current = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ";") {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    if (c !== "\\") {
      current += c === "\n" ? " " : c;
      i++;
      continue;
    }
    const meta = /^\\([A-Za-z]+|[!?\\.])/.exec(text.slice(i));
    if (!meta) {
      current += c;
      i++;
      continue;
    }
    const name = meta[1];
    parts.push(current);
    current = "";
    i += meta[0].length;
    if (name === "\\" || name === "g" || name === "G" || name === "gx") continue;
    if (!PSQL_READ_META.test(name)) return refuse(`the client meta-command \\${name} runs a shell, reads or writes a file, or is not a known read-only command`);
    while (i < text.length && text[i] !== "\n" && !(text[i] === "\\" && text[i + 1] === "\\")) i++;
  }
  parts.push(current);
  return parts;
}
function statementVerdict(sql) {
  for (const reading of READINGS) {
    const lines = [];
    for (const raw of stripSql(sql, reading).split("\n")) {
      const line = raw.trim();
      if (/^go(?:\s+\d+)?$/i.test(line)) {
        lines.push(";");
        continue;
      }
      const command = lineCommandVerdict(line);
      if (command === null) lines.push(line);
      else if (!command.ok) return command;
    }
    const parts = splitStatements(lines.join("\n"));
    if (!Array.isArray(parts)) return parts;
    for (const p of parts.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x !== "")) {
      const v = oneStatement(p);
      if (!v.ok) return v;
    }
  }
  return OK;
}
function oneStatement(s) {
  if (/^set\b/i.test(s)) return SET_SAFE.test(s) ? OK : refuse("it changes a server or session setting");
  if (/^show\s+create\b/i.test(s)) return WRITE_ANYWHERE.test(s.replace(/^show\s+create\b/i, "")) ? refuse("it contains a data- or schema-changing keyword") : OK;
  if (/^pragma\b/i.test(s) && (/=/.test(s) || /\(/.test(s) && !PRAGMA_READ.test(s))) return refuse("the PRAGMA changes a database setting");
  if (/^(select|with)\b[\s\S]*\binto\s+(?!@|:|strict\b|temp\w*\b)[`"\w]/i.test(s)) return refuse("SELECT \u2026 INTO creates a table or writes a file");
  if (/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(s)) return refuse("it locks rows (FOR UPDATE/SHARE)");
  if (/^explain\b/i.test(s)) {
    const inner = s.replace(/^explain\s*(\([^)]*\)\s*)?/i, "");
    return WRITE_ANYWHERE.test(inner) ? refuse("EXPLAIN of a data-changing statement") : OK;
  }
  if (!READ_LEADERS.test(s)) return refuse("the guard cannot confirm the statement only reads");
  if (WRITE_ANYWHERE.test(s)) return refuse("it contains a data- or schema-changing keyword");
  return OK;
}
var REDIS_WRITE = /* @__PURE__ */ new Set([
  "set",
  "setex",
  "setnx",
  "psetex",
  "getset",
  "getdel",
  "append",
  "setrange",
  "incr",
  "incrby",
  "incrbyfloat",
  "decr",
  "decrby",
  "del",
  "unlink",
  "expire",
  "pexpire",
  "expireat",
  "pexpireat",
  "persist",
  "rename",
  "renamenx",
  "move",
  "copy",
  "restore",
  "migrate",
  "flushall",
  "flushdb",
  "swapdb",
  "hset",
  "hsetnx",
  "hmset",
  "hincrby",
  "hincrbyfloat",
  "hdel",
  "lpush",
  "rpush",
  "lpushx",
  "rpushx",
  "lpop",
  "rpop",
  "lset",
  "linsert",
  "lrem",
  "ltrim",
  "rpoplpush",
  "lmove",
  "blpop",
  "brpop",
  "sadd",
  "srem",
  "spop",
  "smove",
  "sinterstore",
  "sunionstore",
  "sdiffstore",
  "zadd",
  "zincrby",
  "zrem",
  "zremrangebyscore",
  "zremrangebyrank",
  "zremrangebylex",
  "zpopmin",
  "zpopmax",
  "xadd",
  "xdel",
  "xtrim",
  "xsetid",
  "xgroup",
  "geoadd",
  "pfadd",
  "pfmerge",
  "setbit",
  "bitop",
  "bitfield",
  "eval",
  "evalsha",
  "eval_ro",
  "fcall",
  "function",
  "script",
  "config",
  "shutdown",
  "bgrewriteaof",
  "bgsave",
  "save",
  "debug",
  "cluster",
  "failover",
  "reset",
  "flushslots",
  "slaveof",
  "replicaof",
  "acl"
]);
var REDIS_STORE_VERBS = /* @__PURE__ */ new Set(["sort", "georadius", "georadiusbymember"]);
var REDIS_READ_SUBVERBS = /* @__PURE__ */ new Map([
  ["config", /* @__PURE__ */ new Set(["get", "help"])],
  ["cluster", /* @__PURE__ */ new Set(["info", "nodes", "slots", "shards", "myid", "myshardid", "links", "countkeysinslot", "getkeysinslot", "keyslot", "help"])],
  ["acl", /* @__PURE__ */ new Set(["whoami", "list", "users", "getuser", "cat", "log", "help"])],
  ["function", /* @__PURE__ */ new Set(["list", "dump", "stats", "help"])],
  ["script", /* @__PURE__ */ new Set(["exists", "help"])]
]);
function redisVerdict(args, piped) {
  const words = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--eval") return refuse("redis-cli --eval runs an arbitrary Lua script");
    if (a === "-x" || a === "--pipe") return refuse("redis-cli reads the command from stdin, which the guard cannot read");
    if (a.startsWith("-")) {
      if (/^-(n|u|a|h|p|s|t|r|i|D|-user|-pass|-cacert|-cert|-key|-sni|-cacertdir|-cluster-\w+)$/.test(a)) k++;
      continue;
    }
    words.push(a);
  }
  const verb = (words[0] ?? "").toLowerCase();
  if (verb === "") return piped ? refuse("redis-cli reads its commands from a pipe or file, which the guard cannot read") : OK;
  const sub = (words[1] ?? "").toLowerCase();
  const rest = words.slice(1).map((w) => w.toLowerCase());
  if (REDIS_READ_SUBVERBS.get(verb)?.has(sub)) return OK;
  if (REDIS_WRITE.has(verb)) return refuse(`redis '${verb}' changes data`);
  if (REDIS_STORE_VERBS.has(verb) && rest.some((w) => w === "store" || w === "storedist")) return refuse(`redis '${verb} \u2026 STORE' writes a key`);
  if (verb === "getex" && rest.some((w) => /^(ex|px|exat|pxat|persist)$/.test(w))) return refuse("redis 'getex' with an expiry option changes a key");
  return OK;
}
var MONGO_WRITE = /\.(insert\w*|update\w*|delete\w*|remove|replaceone|save|bulkwrite|findoneand(update|delete|replace)|findandmodify|drop\w*|create(collection|index\w*|view)|renamecollection|reindex|dropdatabase|deletemany|deleteone|updatemany|updateone|insertmany|insertone|mapreduce)\s*\(/i;
var MONGO_AGG_WRITE = /\$(out|merge)\b/i;
var MONGO_COMMAND = /\.(runcommand|admincommand)\s*\(/i;
var MONGO_COMPUTED_WRITE = /\[\s*['"`](insert|update|delete|remove|replace|save|bulkwrite|findoneand|drop|create|rename|reindex|mapreduce)\w*['"`]\s*\]/i;
function mongoVerdict(js) {
  if (MONGO_WRITE.test(js) || MONGO_AGG_WRITE.test(js) || MONGO_COMPUTED_WRITE.test(js)) return refuse("the mongosh script changes data");
  if (MONGO_COMMAND.test(js)) return refuse("the mongosh script sends a database command, which can change data");
  if (/\b(?:require|eval)\s*\(|\bchild_process\b|\bprocess\.|\bFunction\s*\(/.test(js)) return refuse("the mongosh script runs code the guard cannot read");
  return OK;
}
var SQLITE_READ_DOT = /* @__PURE__ */ new Set([
  ".schema",
  ".tables",
  ".databases",
  ".indexes",
  ".indices",
  ".fullschema",
  ".show",
  ".dump",
  ".mode",
  ".headers",
  ".nullvalue",
  ".width",
  ".help",
  ".version",
  ".print",
  ".echo",
  ".timer",
  ".explain",
  ".stats",
  ".separator",
  ".quit",
  ".exit",
  ".expert",
  ".changes",
  ".eqp",
  ".lint"
]);
var DB_CLIENTS = /* @__PURE__ */ new Map([
  ["psql", { mode: "sql", sqlFlags: /^(-[^dhpUFPoTRLvw]*c|--command)$/, attachedSql: /^(?:-c|--command=)([\s\S]+)$/, unreadable: /^(-[A-Za-z]*f|--file|--file=.*)$/ }],
  ["mysql", { mode: "sql", sqlFlags: /^(-[^uphPSD]*e|--execute|--init-command)$/, attachedSql: /^(?:-e|--execute=|--init-command=)([\s\S]+)$/ }],
  ["mariadb", { mode: "sql", sqlFlags: /^(-[^uphPSD]*e|--execute|--init-command)$/, attachedSql: /^(?:-e|--execute=|--init-command=)([\s\S]+)$/ }],
  ["mysqlsh", { mode: "sql", sqlFlags: /^(-[^uphPSD]*e|--execute)$/, attachedSql: /^(?:-e|--execute=)([\s\S]+)$/, unreadable: /^(-f|--file|--js|--py|--python)$/ }],
  ["sqlite3", { mode: "sqlite", unreadable: /^(-init|-cmd)$/ }],
  ["sqlite", { mode: "sqlite", unreadable: /^(-init|-cmd)$/ }],
  ["mongosh", { mode: "mongo", sqlFlags: /^(--eval|-e)$/, attachedSql: /^(?:--eval=)([\s\S]+)$/, unreadable: /^(-f|--file)$/ }],
  ["mongo", { mode: "mongo", sqlFlags: /^(--eval|-e)$/, attachedSql: /^(?:--eval=)([\s\S]+)$/ }],
  ["redis-cli", { mode: "redis" }],
  ["valkey-cli", { mode: "redis" }],
  ["cqlsh", { mode: "sql", sqlFlags: /^(-e|--execute)$/, attachedSql: /^(?:--execute=)([\s\S]+)$/, unreadable: /^(-f|--file)$/ }],
  ["clickhouse-client", { mode: "sql", sqlFlags: /^(-q|--query)$/, attachedSql: /^(?:-q|--query=)([\s\S]+)$/, unreadable: /^(--queries-file)$/ }],
  ["sqlcmd", { mode: "sql", sqlFlags: /^(-Q|-q)$/, attachedSql: /^(?:-Q|-q)([\s\S]+)$/, unreadable: /^-i$/ }],
  ["mssql-cli", { mode: "sql", sqlFlags: /^(-Q|--query)$/, attachedSql: /^(?:--query=)([\s\S]+)$/, unreadable: /^(-i|--input-file)$/ }],
  ["usql", { mode: "sql", sqlFlags: /^(-c|--command)$/, attachedSql: /^(?:-c|--command=)([\s\S]+)$/, unreadable: /^(-f|--file)$/ }]
]);
var WRANGLER_D1 = { mode: "sql", sqlFlags: /^--command$/, attachedSql: /^--command=([\s\S]+)$/, unreadable: /^--file(=.*)?$/ };
var SEQUELIZE = { refuse: /* @__PURE__ */ new Set(["db:migrate", "db:migrate:undo", "db:migrate:undo:all", "db:seed", "db:seed:all", "db:seed:undo", "db:seed:undo:all", "db:drop", "db:create"]) };
var TYPEORM = { refuse: /* @__PURE__ */ new Set(["migration:run", "migration:revert", "schema:sync", "schema:drop", "query"]) };
var MYSQL_ADMIN = {
  refuse: /* @__PURE__ */ new Set([
    "drop",
    "create",
    "shutdown",
    "kill",
    "password",
    "reload",
    "refresh",
    "flush-hosts",
    "flush-logs",
    "flush-privileges",
    "flush-tables",
    "flush-threads",
    "flush-status",
    "start-replica",
    "stop-replica",
    "start-slave",
    "stop-slave"
  ])
};
var MIKRO_ORM = { refuse: /* @__PURE__ */ new Set(["migration:up", "migration:down", "migration:fresh", "schema:drop", "schema:fresh", "schema:update", "schema:create", "seeder:run"]) };
var MIGRATION_TOOLS = /* @__PURE__ */ new Map([
  ["prisma", { refusePrefix: ["migrate dev", "migrate deploy", "migrate reset", "db push", "db execute", "db seed"] }],
  ["sequelize", SEQUELIZE],
  ["sequelize-cli", SEQUELIZE],
  ["knex", { refuse: /* @__PURE__ */ new Set(["migrate:latest", "migrate:up", "migrate:down", "migrate:rollback", "seed:run"]) }],
  ["typeorm", TYPEORM],
  ["typeorm-ts-node-commonjs", TYPEORM],
  ["typeorm-ts-node-esm", TYPEORM],
  ["drizzle-kit", { refuse: /* @__PURE__ */ new Set(["push", "migrate", "drop"]) }],
  ["alembic", { refuse: /* @__PURE__ */ new Set(["upgrade", "downgrade", "stamp"]), readOnlyFlags: /* @__PURE__ */ new Set(["--sql"]) }],
  ["flyway", { refuse: /* @__PURE__ */ new Set(["migrate", "clean", "undo", "baseline", "repair"]) }],
  ["dbmate", { refuse: /* @__PURE__ */ new Set(["up", "down", "drop", "migrate", "rollback"]) }],
  ["goose", { refuse: /* @__PURE__ */ new Set(["up", "up-by-one", "up-to", "down", "down-to", "reset", "redo"]) }],
  ["atlas", { refusePrefix: ["schema apply", "migrate apply"] }],
  ["node-pg-migrate", { refuse: /* @__PURE__ */ new Set(["up", "down", "redo"]) }],
  ["db-migrate", { refuse: /* @__PURE__ */ new Set(["up", "down", "reset"]) }],
  ["migrate", { refuse: /* @__PURE__ */ new Set(["up", "down", "drop", "force", "goto"]) }],
  ["sqlx", { refusePrefix: ["migrate run", "migrate revert", "database reset", "database drop", "database create"] }],
  ["diesel", { refusePrefix: ["migration run", "migration revert", "migration redo", "database reset", "database setup", "database drop"] }],
  ["phinx", { refuse: /* @__PURE__ */ new Set(["migrate", "rollback"]), refusePrefix: ["seed:run"] }],
  ["supabase", { refusePrefix: ["db reset", "db push", "migration up", "migration repair"] }],
  ["wrangler", { refusePrefix: ["d1 migrations apply", "d1 delete", "d1 time-travel restore"] }],
  ["turso", { refusePrefix: ["db destroy"] }],
  ["pscale", { refusePrefix: ["database delete", "branch delete"] }],
  ["planetscale", { refusePrefix: ["database delete", "branch delete"] }],
  ["mikro-orm", MIKRO_ORM],
  ["mikro-orm-esm", MIKRO_ORM],
  ["mysqladmin", MYSQL_ADMIN],
  ["mariadb-admin", MYSQL_ADMIN]
]);
var WRITE_PROGRAMS = /* @__PURE__ */ new Set(["mysqlimport", "mongoimport", "mongorestore", "dropdb", "createdb", "vacuumdb", "reindexdb", "clusterdb", "dropuser", "createuser"]);
var PG_RESTORE_TO_DATABASE = /^(--dbname(=|$)|-[acCelOsvx1]*d)/;
var ARTISAN_REFUSE = /* @__PURE__ */ new Set([
  "migrate",
  "migrate:fresh",
  "migrate:refresh",
  "migrate:reset",
  "migrate:rollback",
  "migrate:install",
  "db:wipe",
  "db:seed"
]);
var ARTISAN_GLOBAL_VALUES = /* @__PURE__ */ new Set(["--env"]);
var ARTISAN_TESTS = /* @__PURE__ */ new Set(["test", "dusk"]);
var DJANGO_REFUSE = /* @__PURE__ */ new Set(["migrate", "flush", "loaddata", "reset_db", "createcachetable"]);
var DJANGO_READ_FLAGS = /^--(plan|check)$/;
var LARAVEL_TEST = /* @__PURE__ */ new Set(["phpunit", "pest", "paratest"]);
var REPL_COMMANDS = /* @__PURE__ */ new Map([
  ["artisan", /* @__PURE__ */ new Set(["tinker", "db"])],
  ["rails", /* @__PURE__ */ new Set(["console", "c", "dbconsole", "db"])],
  ["manage.py", /* @__PURE__ */ new Set(["shell", "dbshell", "shell_plus"])],
  ["flask", /* @__PURE__ */ new Set(["shell"])]
]);
var RAILS_DB_WRITE = ["db:migrate", "db:rollback", "db:drop", "db:create", "db:reset", "db:setup", "db:prepare", "db:schema:load", "db:structure:load", "db:seed", "db:purge", "db:truncate_all", "db:fixtures:load"];
function railsTaskChangesDatabase(task) {
  const t = task.toLowerCase();
  if (/:status(:|$)/.test(t)) return false;
  return RAILS_DB_WRITE.some((p) => t === p || t.startsWith(p + ":"));
}
function toolSubVerdict(spec, args, label) {
  const positional = args.filter((a) => !a.startsWith("-")).map((p) => p.toLowerCase());
  if (positional.length === 0) return OK;
  if (spec.readOnlyFlags && args.some((a) => spec.readOnlyFlags.has(a))) return OK;
  if (spec.refuse) {
    const hit = positional.find((p) => spec.refuse.has(p));
    if (hit !== void 0) return refuse(`\`${label} ${hit}\` changes the database`);
  }
  for (const p of spec.refusePrefix ?? []) {
    const [head, ...tail] = p.split(" ");
    if (positional[0] !== head) continue;
    let at = 1;
    const inOrder = tail.every((word) => {
      const found = positional.indexOf(word, at);
      if (found === -1) return false;
      at = found + 1;
      return true;
    });
    if (inOrder) return refuse(`\`${label} ${p}\` changes the database`);
  }
  return OK;
}
function skipOptions(values, from, valueOptions) {
  let k = from;
  while (k < values.length && values[k].startsWith("-") && values[k] !== "--" && values[k] !== "-") k += valueOptions.has(values[k]) ? 2 : 1;
  return k;
}
var CONTAINER_GLOBAL_VALUES = /* @__PURE__ */ new Set(["-c", "--context", "-H", "--host", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey", "--connection", "--url", "--identity", "--root", "--runroot", "--storage-driver", "--tmpdir"]);
var COMPOSE_GLOBAL_VALUES = /* @__PURE__ */ new Set(["-f", "--file", "-p", "--project-name", "--env-file", "--profile", "--project-directory", "--ansi", "--progress", "--parallel"]);
var COMPOSE_EXEC_VALUES = /* @__PURE__ */ new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--index", "--entrypoint", "--name", "-v", "--volume", "-p", "--publish", "-l", "--label", "--env-from-file", "--pull", "--cap-add", "--cap-drop"]);
var CONTAINER_EXEC_VALUES = /* @__PURE__ */ new Set([
  "-e",
  "--env",
  "--env-file",
  "-u",
  "--user",
  "-w",
  "--workdir",
  "--detach-keys",
  "-v",
  "--volume",
  "-p",
  "--publish",
  "--name",
  "--network",
  "--net",
  "--entrypoint",
  "-l",
  "--label",
  "--label-file",
  "--mount",
  "--platform",
  "--pull",
  "-h",
  "--hostname",
  "-m",
  "--memory",
  "--cpus",
  "--restart",
  "--link",
  "--add-host",
  "--dns",
  "--ip",
  "--volumes-from",
  "--device",
  "--gpus",
  "--log-driver",
  "--log-opt",
  "--cap-add",
  "--cap-drop",
  "--pod"
]);
var COMPOSE_PROGRAMS = /* @__PURE__ */ new Set(["docker-compose", "podman-compose"]);
function containerSubAt(name, values) {
  if (name !== "docker" && name !== "podman") return null;
  return skipOptions(values, 0, CONTAINER_GLOBAL_VALUES);
}
function composeSubAt(name, values) {
  if (COMPOSE_PROGRAMS.has(name)) return skipOptions(values, 0, COMPOSE_GLOBAL_VALUES);
  const at = containerSubAt(name, values);
  if (at === null || values[at] !== "compose") return null;
  return skipOptions(values, at + 1, COMPOSE_GLOBAL_VALUES);
}
function containerCommandAt(name, values) {
  let target;
  const compose = composeSubAt(name, values);
  if (compose !== null) {
    if (values[compose] !== "exec" && values[compose] !== "run") return null;
    target = skipOptions(values, compose + 1, COMPOSE_EXEC_VALUES) + 1;
  } else {
    const at = containerSubAt(name, values);
    if (at === null) return null;
    const sub = values[at] === "container" ? values[at + 1] : values[at];
    if (sub !== "exec" && sub !== "run") return null;
    target = skipOptions(values, values[at] === "container" ? at + 2 : at + 1, CONTAINER_EXEC_VALUES) + 1;
  }
  return target < values.length ? target : null;
}
var volumeFlag = (args) => args.some((a) => a === "--volumes" || /^--volumes=(?!false$)/.test(a) || /^-[a-z]*v[a-z]*(=(?!false$).*)?$/.test(a));
function containerDataLoss(name, args) {
  const low = args.map((a2) => a2.toLowerCase());
  const compose = composeSubAt(name, low);
  if (compose !== null) {
    const sub = low[compose];
    if ((sub === "down" || sub === "rm") && volumeFlag(low.slice(compose + 1))) return refuse("it removes the compose volumes, where a database keeps its data");
    return OK;
  }
  const at = containerSubAt(name, low);
  if (at === null) return OK;
  const [a, b] = [low[at], low[at + 1]];
  const rest = low.slice(at + 1);
  if (a === "volume" && (b === "rm" || b === "remove" || b === "prune")) return refuse("it removes container volumes, where a database keeps its data");
  if (a === "system" && b === "prune" && volumeFlag(rest)) return refuse("it prunes volumes, where a database keeps its data");
  if (a === "system" && b === "reset") return refuse("it removes every container and volume, where a database keeps its data");
  if ((a === "rm" || a === "container" && (b === "rm" || b === "remove")) && volumeFlag(rest)) return refuse("it removes a container's volumes");
  return OK;
}

// src/lib/terminal-guard.ts
var BLOCKED_GIT_VERBS = /* @__PURE__ */ new Map([
  ["commit", "rsct_request_commit"],
  ["push", "rsct_request_push"],
  ["merge", "rsct_request_merge"],
  ["rebase", "rsct_request_rebase"],
  ["cherry-pick", "rsct_request_commit"],
  ["revert", "rsct_request_commit"],
  ["am", "rsct_request_commit"],
  ["commit-tree", "rsct_request_commit"],
  ["filter-branch", "rsct_request_commit"],
  ["fast-import", "rsct_request_commit"],
  ["quiltimport", "rsct_request_commit"],
  ["replay", "rsct_request_rebase"],
  ["pull", "rsct_request_merge"]
]);
var RECOVERY_VERBS = /* @__PURE__ */ new Set(["merge", "rebase", "cherry-pick", "revert", "am"]);
var RECOVERY_FLAGS = /* @__PURE__ */ new Set(["--abort", "--quit", "--continue", "--skip"]);
var GIT_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--list-cmds", "--attr-source"]);
var GIT_GLOBAL_FLAGS = /* @__PURE__ */ new Set([
  "-p",
  "-P",
  "--paginate",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
  "-v",
  "--version",
  "-h",
  "--help"
]);
var START_PROCESS = /* @__PURE__ */ new Set(["start-process", "saps", "start"]);
var START_PROCESS_PARAMS = /* @__PURE__ */ new Map([
  ["filepath", "program"],
  ["pspath", "program"],
  ["path", "program"],
  ["argumentlist", "arguments"],
  ["args", "arguments"],
  ["workingdirectory", "value"],
  ["windowstyle", "value"],
  ["verb", "value"],
  ["credential", "value"],
  ["environment", "value"],
  ["redirectstandardinput", "value"],
  ["redirectstandardoutput", "value"],
  ["redirectstandarderror", "value"],
  ["erroraction", "value"],
  ["warningaction", "value"],
  ["informationaction", "value"],
  ["progressaction", "value"],
  ["errorvariable", "value"],
  ["warningvariable", "value"],
  ["informationvariable", "value"],
  ["outvariable", "value"],
  ["outbuffer", "value"],
  ["pipelinevariable", "value"],
  ["loaduserprofile", "switch"],
  ["lup", "switch"],
  ["nonewwindow", "switch"],
  ["nnw", "switch"],
  ["passthru", "switch"],
  ["wait", "switch"],
  ["usenewenvironment", "switch"],
  ["verbose", "switch"],
  ["debug", "switch"],
  ["whatif", "switch"],
  ["confirm", "switch"]
]);
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "xargs", "builtin"]);
var RUNNERS = /* @__PURE__ */ new Set([...WRAPPERS, "timeout", "busybox", "stdbuf", "ionice", "chrt", "taskset"]);
var POWERSHELL_INVOKE = /* @__PURE__ */ new Set(["&", "."]);
function isRunnerName(name, dialect) {
  return RUNNERS.has(name) || dialect === "powershell" && POWERSHELL_INVOKE.has(name);
}
var RUNNER_VALUE_OPTIONS = /* @__PURE__ */ new Map([
  ["sudo", /* @__PURE__ */ new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--close-from", "--command-timeout"])],
  ["doas", /* @__PURE__ */ new Set(["-u", "-C"])],
  ["nice", /* @__PURE__ */ new Set(["-n", "--adjustment"])],
  ["xargs", /* @__PURE__ */ new Set(["-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--eof", "--arg-file", "--process-slot-var"])],
  ["time", /* @__PURE__ */ new Set(["-o", "-f", "--output", "--format"])],
  ["timeout", /* @__PURE__ */ new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["env", /* @__PURE__ */ new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["ionice", /* @__PURE__ */ new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"])],
  ["stdbuf", /* @__PURE__ */ new Set(["-i", "-o", "-e"])]
]);
var RUNNER_POSITIONALS = /* @__PURE__ */ new Map([["timeout", 1], ["taskset", 1], ["chrt", 1]]);
var SHELL_KEYWORDS = /* @__PURE__ */ new Set(["if", "then", "elif", "else", "do", "while", "until", "!"]);
var POWERSHELL_VALUE_OPTIONS = [
  "executionpolicy",
  "windowstyle",
  "inputformat",
  "outputformat",
  "version",
  "psconsolefile",
  "configurationname",
  "workingdirectory",
  "custompipename",
  "settingsfile"
];
var POWERSHELL_VALUE_ALIASES = /* @__PURE__ */ new Set(["ep", "ex", "w", "wd", "v"]);
var INTERPRETER_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-X", "-W", "-r", "--require", "--import", "--loader", "--experimental-loader", "--input-type", "-C", "--conditions", "--title", "--disable-warning"]);
var GH_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-R", "--repo", "--hostname"]);
var GIT_BUILTINS = new Set(
  "add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential credential-cache credential-store describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id grep gui hash-object help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-one-file merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm scalar send-email send-pack sh-i18n sh-setup shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree".split(" ")
);
var POSIX_SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "yash", "posh"]);
var POWERSHELLS = /* @__PURE__ */ new Set(["powershell", "pwsh", "powershell_ise"]);
var DISTRO_LAUNCHERS = /^(ubuntu[\d.]*|debian|kali|kali-linux|opensuse[\w.-]*|sles[\w.-]*|fedora[\w.-]*|alpine|oraclelinux[\w.-]*|almalinux[\w.-]*)$/;
var WSL_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-d", "--distribution", "-u", "--user", "--cd", "--shell-type", "--distribution-id"]);
var SSH_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B"]);
var NODE_CODE_FLAG = { separate: /^(-e|--eval|-p|--print|-pe|-ep)$/, attached: /^--(?:eval|print)=(.*)$/s };
var PYTHON_CODE_FLAG = {
  separate: /^-[bBdEhiIOPqsSuvVxR]*c$/,
  attached: /^-[bBdEhiIOPqsSuvVxR]*c(.+)$/s,
  switches: /^-[bBdEhiIOPqsSuvVxR]+$/
};
var INTERPRETER_FLAGS = /* @__PURE__ */ new Map([
  ["node", NODE_CODE_FLAG],
  ["nodejs", NODE_CODE_FLAG],
  ["bun", NODE_CODE_FLAG],
  ["tsx", NODE_CODE_FLAG],
  ["ts-node", NODE_CODE_FLAG],
  ["python", PYTHON_CODE_FLAG],
  ["python3", PYTHON_CODE_FLAG],
  ["python2", PYTHON_CODE_FLAG],
  ["py", PYTHON_CODE_FLAG],
  ["pythonw", PYTHON_CODE_FLAG],
  ["perl", { separate: /^-[acnpstTuUvwWXl0-9fg]*[eE]$/, attached: /^-[acnpstTuUvwWXl0-9fg]*[eE](.+)$/s, switches: /^-[acnpstTuUvwWXl0-9fg]+$/ }],
  ["ruby", { separate: /^-[acdlnpsSvwyU0-9]*e$/, attached: /^-[acdlnpsSvwyU0-9]*e(.+)$/s, switches: /^-[acdlnpsSvwyU0-9]+$/ }],
  ["php", { separate: /^-r$/, attached: /^-r(.+)$/s, switches: /^-[aChHiqsvw]+$/ }]
]);
var SU_COMMAND_FLAG = {
  separate: /^(-[a-zA-Z]*c|--command|--session-command)$/,
  attached: /^(?:-[a-zA-Z]*?c|--command=|--session-command=)(.+)$/s
};
var ENV_SPLIT_FLAG = { separate: /^(-[a-zA-Z0]*S|--split-string)$/, attached: /^(?:-[a-zA-Z0]*?S|--split-string=)(.+)$/s };
var STDIN_SCRIPTS = /* @__PURE__ */ new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
var BASH_QUOTED_ESCAPES = /* @__PURE__ */ new Set(["$", "`", '"', "\\"]);
var BASH_FOLDER_CHANGES = /* @__PURE__ */ new Set(["cd", "pushd", "popd", "chdir"]);
var POWERSHELL_FOLDER_CHANGES = /* @__PURE__ */ new Set(["cd", "chdir", "sl", "set-location", "pushd", "push-location", "popd", "pop-location"]);
var READ_ONLY_PROGRAMS = /* @__PURE__ */ new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "ag",
  "ack",
  "jq",
  "wc",
  "diff",
  "cmp",
  "ls",
  "dir",
  "stat",
  "file",
  "sha256sum",
  "sha1sum",
  "sha512sum",
  "md5sum",
  "shasum",
  "cksum",
  "echo",
  "printf",
  "test",
  "[",
  "[[",
  "type",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "get-content",
  "gc",
  "select-string",
  "sls",
  "test-path",
  "get-item",
  "gi",
  "get-childitem",
  "gci",
  "get-filehash",
  "write-output",
  "write-host",
  "convertfrom-json"
]);
var GIT_READ_VERBS = /* @__PURE__ */ new Set(["add", "diff", "show", "log", "status", "blame", "annotate", "ls-files", "ls-tree", "grep", "check-ignore", "check-attr", "cat-file", "rev-parse", "shortlog", "whatchanged"]);
var COPY_PROGRAMS = /* @__PURE__ */ new Set(["cp", "copy", "copy-item", "cpi", "rsync", "install", "ln", "mv", "move", "move-item", "mi", "scp"]);
var VERBS_PATTERN = "commit-tree|commit|push|merge|rebase|cherry-pick|revert|am|pull|filter-branch|fast-import|quiltimport|replay";
var VALUE_OPTIONS_PATTERN = ["-C", ...GIT_VALUE_OPTIONS].join("|");
var FLAG_TOKEN = String.raw`-[\w.=:/-]+`;
var VALUE_TOKEN = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])+`;
var QUOTE = String.raw`["'\x60]`;
var NOT_QUOTE = String.raw`[^"'\x60]`;
var CODE_GIT_TEXT = new RegExp(
  String.raw`\bgit(?:\.exe)?\s+(?:${FLAG_TOKEN}\s+|(?<=(?:^|\s)(?:${VALUE_OPTIONS_PATTERN})\s+)(?!${FLAG_TOKEN}\s)${VALUE_TOKEN}\s+)*(${VERBS_PATTERN})(?![\w-])`,
  "i"
);
var CODE_GIT_ARGV = new RegExp(
  String.raw`${QUOTE}git(?:\.exe)?${QUOTE}\s*,\s*(?:\{[^}]*?\bargs\s*:\s*)?(?:\[\s*)?` + String.raw`(?:${QUOTE}-${NOT_QUOTE}*${QUOTE}\s*,\s*|(?<=${QUOTE}(?:${VALUE_OPTIONS_PATTERN})${QUOTE}\s*,\s*)(?!${QUOTE}-)(?:${QUOTE}${NOT_QUOTE}*${QUOTE}|[\w.$]+)\s*,\s*)*` + String.raw`${QUOTE}(${VERBS_PATTERN})${QUOTE}`,
  "i"
);
var CODE_GH_MERGE = /\bgh(?:\.exe)?\s+(?:-\S+\s+|(?<=(?:^|\s)-\S+\s+)(?!-)\S+\s+)*pr\s+merge\b/i;
var CODE_GH_ARGV = new RegExp(
  `["'\`]gh(?:\\.exe)?["'\`]\\s*,\\s*(?:\\[\\s*)?(?:["'\`][^"'\`]*["'\`]\\s*,\\s*)*?["'\`]pr["'\`]\\s*,\\s*(?:["'\`]-[^"'\`]*["'\`]\\s*,\\s*)*["'\`]merge["'\`]`,
  "i"
);
var HOOKS_OFF_KEY = /disableallhooks/i;
var DATABASE_SWITCH_KEY = /database_(?:test_)?guard/i;
var MAX_DEPTH = 8;
var MAX_ALIAS_DEPTH = 5;
var DEFAULT_ALIAS_BUDGET_MS = 3e3;
var WORK_BUDGET_MS = 5e3;
var MAX_COMMAND_BYTES = 64 * 1024;
var MAX_COMMAND_WORDS = 2048;
var MAX_FOLDER_LENGTH = 4096;
var ALLOW = { verdict: "allow" };
function deny(reason) {
  return { verdict: "deny", reason };
}
function isDeny(v) {
  return v.verdict === "deny";
}
function decodeUnicodeEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
function programName(word) {
  const last = word.split(/[\\/]/).pop() ?? word;
  return last.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}
function readHeredocStart(text, from) {
  let j = from;
  const strip = text[j] === "-";
  if (strip) j++;
  while (text[j] === " " || text[j] === "	") j++;
  const m = /^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(text.slice(j));
  if (!m) return { heredoc: null, end: j };
  return { heredoc: { delim: (m[1] ?? m[2] ?? m[3] ?? "").replace(/["'\\]/g, ""), strip, quoted: /['"\\]/.test(m[0]) }, end: j + m[0].length };
}
function readHeredocBody(text, from, h) {
  const lines = [];
  let i = from;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    const raw = nl === -1 ? text.slice(i) : text.slice(i, nl);
    i = nl === -1 ? text.length : nl + 1;
    const line = raw.replace(/\r$/, "");
    if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
    lines.push(line);
  }
  return { body: lines.join("\n"), end: i };
}
function readBalanced(text, start, open, close) {
  let depth = 1;
  let i = start;
  const pending = [];
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      const heredoc = readHeredocStart(text, i + 2);
      if (heredoc.heredoc) pending.push(heredoc.heredoc);
      i = heredoc.end;
      continue;
    }
    if (c === "(" && text[i + 1] === "(") {
      const arithmetic = readBalanced(text, i + 2, "(", ")");
      i = text[arithmetic.end] === ")" ? arithmetic.end + 1 : arithmetic.end;
      continue;
    }
    if (c === "\n" && pending.length > 0) {
      i++;
      while (pending.length > 0) i = readHeredocBody(text, i, pending.shift()).end;
      continue;
    }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      i = j === -1 ? text.length : j + 1;
      continue;
    }
    if (c === '"') {
      i = skipDoubleQuoted(text, i + 1);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { inner: text.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return { inner: text.slice(start), end: text.length };
}
function skipDoubleQuoted(text, from) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" || c === "`") {
      i += 2;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      i = readBalanced(text, i + 2, "(", ")").end;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return text.length;
}
function readBacktick(text, start) {
  let i = start;
  let inner = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      inner += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") return { inner, end: i + 1 };
    inner += c;
    i++;
  }
  return { inner, end: text.length };
}
var ANSI_SIMPLE = { n: "\n", t: "	", r: "\r", a: "\x07", b: "\b", e: "\x1B", E: "\x1B", f: "\f", v: "\v" };
function ansiEscape(text, at) {
  const e = text[at];
  if (e in ANSI_SIMPLE) return { value: ANSI_SIMPLE[e], end: at + 1 };
  const rest = text.slice(at);
  const hex = /^x([0-9a-fA-F]{1,2})/.exec(rest) ?? /^u([0-9a-fA-F]{1,4})/.exec(rest) ?? /^U([0-9a-fA-F]{1,8})/.exec(rest);
  if (hex) return { value: String.fromCodePoint(Math.min(parseInt(hex[1], 16), 1114111)), end: at + hex[0].length };
  const oct = /^[0-7]{1,3}/.exec(rest);
  if (oct) return { value: String.fromCharCode(parseInt(oct[0], 8)), end: at + oct[0].length };
  const ctrl = /^c(.)/.exec(rest);
  if (ctrl) return { value: String.fromCharCode(ctrl[1].charCodeAt(0) & 31), end: at + 2 };
  return { value: e, end: at + 1 };
}
function substitutionsIn(text, dialect) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      const { inner, end } = readBalanced(text, i + 2, "(", ")");
      found.push(inner);
      i = end;
      continue;
    }
    if (dialect === "bash" && c === "`") {
      const { inner, end } = readBacktick(text, i + 1);
      found.push(inner);
      i = end;
      continue;
    }
    i++;
  }
  return found;
}
function lex(text, dialect) {
  const tokens = [];
  const nested = [];
  const pendingHeredocs = [];
  let word = "";
  let inWord = false;
  let expansion = true;
  let quoted = false;
  let redirectTarget = false;
  let afterComma = false;
  let bare = "";
  let spliced = false;
  let redirectIn = false;
  let i = 0;
  let parenDepth = 0;
  let pendingPipes = [];
  const endWord = () => {
    if (inWord) {
      const pattern = shellPattern(bare, dialect);
      const token = { kind: "word", value: word, expansion: pattern !== null || expansion && word.length > 0 };
      if (pattern === "glob") token.glob = true;
      if (spliced) token.spliced = true;
      if (quoted) token.quoted = true;
      if (afterComma) token.listed = true;
      if (redirectTarget) token.redirect = true;
      if (redirectIn) token.stdin = true;
      tokens.push(token);
      redirectTarget = false;
      redirectIn = false;
      afterComma = false;
    }
    word = "";
    bare = "";
    spliced = false;
    inWord = false;
    expansion = true;
    quoted = false;
  };
  const sep = () => {
    endWord();
    redirectTarget = false;
    afterComma = false;
    pendingPipes = [];
    if (tokens.length > 0 && tokens[tokens.length - 1].kind !== "sep") tokens.push({ kind: "sep" });
  };
  const pipeSep = () => {
    endWord();
    redirectTarget = false;
    afterComma = false;
    const last = tokens[tokens.length - 1];
    if (last === void 0) return;
    if (last.kind === "sep") {
      last.pipe = true;
      pendingPipes.push(last);
      return;
    }
    const token = { kind: "sep", pipe: true };
    tokens.push(token);
    pendingPipes.push(token);
  };
  const markScope = (side) => {
    if (dialect !== "bash") return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === "sep") last[side] = (last[side] ?? 0) + 1;
    else tokens.push({ kind: "sep", [side]: 1 });
  };
  const closeParen = () => {
    const subshell = parenDepth > 0;
    if (subshell) parenDepth--;
    else for (const p of pendingPipes) delete p.pipe;
    sep();
    if (subshell) markScope("closes");
  };
  const literal = (s) => {
    word += s;
    inWord = true;
    if (s.length > 0) expansion = false;
  };
  const bareChar = (c) => {
    literal(c);
    bare += c;
  };
  const splice = (s) => {
    word += s;
    inWord = true;
    spliced = true;
  };
  const readHeredocBodies = () => {
    while (pendingHeredocs.length > 0) {
      const h = pendingHeredocs.shift();
      const read = readHeredocBody(text, i, h);
      const body = read.body;
      i = read.end;
      if (!h.quoted) for (const s of substitutionsIn(body, "bash")) nested.push({ text: s, dialect: "bash" });
      tokens.push({ kind: "body", text: body, via: "heredoc" });
    }
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\n") {
      endWord();
      i++;
      if (pendingHeredocs.length > 0) readHeredocBodies();
      sep();
      continue;
    }
    if (c === " " || c === "	" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (dialect === "powershell" && c === "<" && next === "#") {
      const close = text.indexOf("#>", i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "'") {
      if (dialect === "powershell") {
        let j2 = i + 1;
        let value = "";
        while (j2 < text.length) {
          if (text[j2] === "'" && text[j2 + 1] === "'") {
            value += "'";
            j2 += 2;
            continue;
          }
          if (text[j2] === "'") break;
          value += text[j2];
          j2++;
        }
        literal(value);
        i = j2 + 1;
        continue;
      }
      const j = text.indexOf("'", i + 1);
      literal(j === -1 ? text.slice(i + 1) : text.slice(i + 1, j));
      i = j === -1 ? text.length : j + 1;
      continue;
    }
    if (dialect === "bash" && c === "$" && next === "'") {
      let j = i + 2;
      let value = "";
      while (j < text.length && text[j] !== "'") {
        if (text[j] === "\\" && j + 1 < text.length) {
          const decoded = ansiEscape(text, j + 1);
          value += decoded.value;
          j = decoded.end;
          continue;
        }
        value += text[j];
        j++;
      }
      literal(value);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      const escape = dialect === "powershell" ? "`" : "\\";
      const startJ = j;
      let substitutions = 0;
      let literalChars = false;
      let expands = false;
      while (j < text.length) {
        const d = text[j];
        if (d === escape && j + 1 < text.length) {
          const e = text[j + 1];
          if (dialect === "bash" && e === "\n") {
            j += 2;
            continue;
          }
          if (dialect === "bash" && !BASH_QUOTED_ESCAPES.has(e)) {
            value += d;
            literalChars = true;
            j++;
            continue;
          }
          value += e;
          literalChars = true;
          j += 2;
          continue;
        }
        if (dialect === "powershell" && d === '"' && text[j + 1] === '"') {
          value += '"';
          literalChars = true;
          j += 2;
          continue;
        }
        if (d === '"') break;
        if (d === "$" && text[j + 1] === "(" && text[j + 2] !== "(") {
          const { inner, end } = readBalanced(text, j + 2, "(", ")");
          nested.push({ text: inner, dialect });
          value += inner;
          substitutions++;
          j = end;
          continue;
        }
        if (dialect === "bash" && d === "`") {
          const { inner, end } = readBacktick(text, j + 1);
          nested.push({ text: inner, dialect });
          value += inner;
          substitutions++;
          j = end;
          continue;
        }
        if (d === "$" && /^\$[\w{(@*#?!$-]/.test(text.slice(j, j + 2))) expands = true;
        value += d;
        literalChars = true;
        j++;
      }
      const rawInner = text.slice(startJ, Math.min(j, text.length));
      const variable = /^\$(\{[^}]*\}|[A-Za-z_]\w*(?::\w+)?|[@*#?$!0-9-])$/.test(rawInner);
      if (!inWord && (variable || substitutions === 1 && !literalChars)) {
        word = variable ? rawInner : value;
        inWord = true;
        if (!/^\$(@|\{[^}]*\[@\]\})$/.test(rawInner)) quoted = true;
      } else {
        literal(value);
        if (substitutions > 0 || expands) spliced = true;
      }
      i = j + 1;
      continue;
    }
    if (c === "\\" && dialect === "bash") {
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next !== void 0) literal(next);
      i += 2;
      continue;
    }
    if (c === "`") {
      if (dialect === "powershell") {
        if (next === "\n") {
          i += 2;
          continue;
        }
        if (next !== void 0) literal(next);
        i += 2;
        continue;
      }
      const { inner, end } = readBacktick(text, i + 1);
      nested.push({ text: inner, dialect });
      splice(inner);
      i = end;
      continue;
    }
    if (c === "$") {
      if (next === "(") {
        if (text[i + 2] === "(") {
          const { inner: inner2, end: end2 } = readBalanced(text, i + 3, "(", ")");
          for (const s of substitutionsIn(inner2, dialect)) nested.push({ text: s, dialect });
          i = text[end2] === ")" ? end2 + 1 : end2;
          literal("0");
          continue;
        }
        const { inner, end } = readBalanced(text, i + 2, "(", ")");
        nested.push({ text: inner, dialect });
        splice(inner);
        i = end;
        continue;
      }
      if (next === "{") {
        const close = text.indexOf("}", i + 2);
        const end = close === -1 ? text.length : close + 1;
        for (const s of substitutionsIn(text.slice(i + 2, end), dialect)) nested.push({ text: s, dialect });
        splice(text.slice(i, end));
        i = end;
        continue;
      }
      const m = /^\$(?:[A-Za-z_]\w*(?::\w+)?|[@*#?$!0-9-])/.exec(text.slice(i));
      if (m) {
        splice(m[0]);
        i += m[0].length;
        continue;
      }
      literal("$");
      i++;
      continue;
    }
    if (dialect === "bash" && (c === "<" || c === ">") && next === "(") {
      const { inner, end } = readBalanced(text, i + 2, "(", ")");
      nested.push({ text: inner, dialect, ...c === ">" && { piped: true } });
      endWord();
      if (c === "<") tokens.push({ kind: "word", value: "/dev/fd/63", expansion: true, procsub: true });
      i = end;
      continue;
    }
    if (dialect === "powershell" && c === "@" && (next === "'" || next === '"') && /^\r?\n/.test(text.slice(i + 2))) {
      const closer = `
${next}@`;
      const close = text.indexOf(closer, i + 2);
      const body = (close === -1 ? text.slice(i + 2) : text.slice(i + 2, close)).replace(/^\r?\n/, "").replace(/\r$/, "");
      if (next === '"') for (const s of substitutionsIn(body, "powershell")) nested.push({ text: s, dialect });
      literal(body);
      i = close === -1 ? text.length : close + closer.length;
      continue;
    }
    if (dialect === "bash" && c === "<" && next === "<") {
      endWord();
      if (text[i + 2] === "<") {
        i += 3;
        while (text[i] === " " || text[i] === "	") i++;
        const m = /^("((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;&|<>()]*))/.exec(text.slice(i)) ?? [""];
        const raw = m[0] ?? "";
        const value = m[2] ?? m[3] ?? m[4] ?? "";
        if (!raw.startsWith("'")) for (const s of substitutionsIn(raw, "bash")) nested.push({ text: s, dialect: "bash" });
        tokens.push({ kind: "body", text: value, via: "herestring" });
        i += raw.length;
        continue;
      }
      const heredoc = readHeredocStart(text, i + 2);
      if (heredoc.heredoc) pendingHeredocs.push(heredoc.heredoc);
      i = heredoc.end;
      continue;
    }
    if (c === "&" && next === ">") {
      endWord();
      i += 2;
      if (text[i] === ">") i++;
      redirectTarget = true;
      continue;
    }
    if (c === "<" || c === ">") {
      const input = c === "<" && text[i + 1] !== ">";
      if (inWord && (/^\d+$/.test(word) || dialect === "powershell" && word === "*")) {
        word = "";
        bare = "";
        spliced = false;
        inWord = false;
        expansion = true;
      } else {
        endWord();
      }
      i++;
      if (text[i] === ">" || text[i] === "|" || text[i] === "<") i++;
      if (text[i] === "&" && /[0-9-]/.test(text[i + 1] ?? "")) {
        i++;
        while (/[0-9-]/.test(text[i] ?? "")) i++;
      } else {
        if (text[i] === "&") i++;
        redirectTarget = true;
        if (input) redirectIn = true;
      }
      continue;
    }
    if (dialect === "powershell" && c === ",") {
      endWord();
      afterComma = true;
      i++;
      continue;
    }
    if (dialect === "bash" && c === "(" && inWord && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(word)) {
      const { inner, end } = readBalanced(text, i + 1, "(", ")");
      for (const s of substitutionsIn(inner, "bash")) nested.push({ text: s, dialect: "bash" });
      literal(`(${inner})`);
      i = end;
      continue;
    }
    if (dialect === "bash" && c === "(" && next === "(" && !inWord) {
      const { inner, end } = readBalanced(text, i + 2, "(", ")");
      if (/\b(git|gh)\b/i.test(inner)) nested.push({ text: inner, dialect: "bash" });
      for (const s of substitutionsIn(inner, "bash")) nested.push({ text: s, dialect: "bash" });
      i = text[end] === ")" ? end + 1 : end;
      literal("0");
      continue;
    }
    if (c === "{" && next === "}" && !inWord && (text[i + 2] === void 0 || /[\s;|&)]/.test(text[i + 2]))) {
      literal("{}");
      i += 2;
      continue;
    }
    if (dialect === "powershell" && c === "&" && next !== "&" && !inWord && (tokens.length === 0 || tokens[tokens.length - 1].kind === "sep")) {
      literal("&");
      endWord();
      i++;
      continue;
    }
    if (dialect === "powershell" && (c === "(" || c === "@" && next === "(")) {
      endWord();
      if (tokens[tokens.length - 1]?.kind === "word") {
        const { inner, end } = readBalanced(text, c === "@" ? i + 2 : i + 1, "(", ")");
        nested.push({ text: inner, dialect });
        tokens.push({ kind: "word", value: inner, expansion: true });
        i = end;
        continue;
      }
    }
    if (dialect === "bash" && (c === "{" || c === "}") && (inWord || next !== void 0 && !(c === "{" ? /\s/ : /[\s;|&)<>]/).test(next))) {
      bareChar(c);
      i++;
      continue;
    }
    if (c === "|" && next === "|") {
      sep();
      i += 2;
      continue;
    }
    if (c === "|") {
      pipeSep();
      i += next === "&" ? 2 : 1;
      continue;
    }
    if (c === ")") {
      closeParen();
      i++;
      continue;
    }
    if (c === "(") {
      parenDepth++;
      sep();
      markScope("opens");
      i++;
      continue;
    }
    if (c === ";" || c === "&" || c === "{" || c === "}") {
      sep();
      i++;
      continue;
    }
    if (dialect === "powershell" && c === "@" && next === "(") {
      sep();
      i += 2;
      continue;
    }
    if (dialect === "powershell" && c === "@" && !inWord && /[A-Za-z_]/.test(next ?? "")) {
      const m = /^@\w+/.exec(text.slice(i));
      word += m[0];
      inWord = true;
      i += m[0].length;
      continue;
    }
    bareChar(c);
    i++;
  }
  endWord();
  readHeredocBodies();
  return { tokens, nested };
}
function shellPattern(bare, dialect) {
  if (dialect === "bash" && /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(bare)) return "brace";
  return /[*?]/.test(bare) || /\[[^\]]+\]/.test(bare) ? "glob" : null;
}
function splitCommands(tokens, firstPiped = false) {
  const commands = [{ tokens: [], piped: firstPiped, opens: 0, closes: 0 }];
  for (const t of tokens) {
    if (t.kind === "sep") {
      let current = commands[commands.length - 1];
      if (current.tokens.length > 0) {
        current.closes += t.closes ?? 0;
        current = { tokens: [], piped: t.pipe === true, opens: 0, closes: 0 };
        commands.push(current);
      } else {
        if (t.pipe === true) current.piped = true;
        const previous = commands[commands.length - 2];
        if (previous !== void 0) previous.closes += t.closes ?? 0;
      }
      current.opens += t.opens ?? 0;
      continue;
    }
    commands[commands.length - 1].tokens.push(t);
  }
  return commands.filter((c) => c.tokens.length > 0);
}
function programPositions(values, program, dialect) {
  const at = [];
  const xargs = [];
  if (program === -1) return { at, xargs };
  let viaXargs = false;
  let k = program;
  while (k < values.length) {
    const name = programName(values[k]);
    at[k] = true;
    xargs[k] = viaXargs;
    if (!isRunnerName(name, dialect) || name === "command" && /^-[a-zA-Z]*[vV]/.test(values[k + 1] ?? "")) break;
    if (name === "xargs") viaXargs = true;
    const valueOptions = RUNNER_VALUE_OPTIONS.get(name);
    let positionals = RUNNER_POSITIONALS.get(name) ?? 0;
    k++;
    while (k < values.length) {
      const x = values[k];
      if (x.startsWith("-") && x !== "-") {
        k += valueOptions?.has(x) ? 2 : 1;
        continue;
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) {
        k++;
        continue;
      }
      if (positionals > 0) {
        positionals--;
        k++;
        continue;
      }
      break;
    }
  }
  return { at, xargs };
}
var TEXT_ONLY_PROGRAMS = /* @__PURE__ */ new Set([
  "echo",
  "printf",
  "cat",
  "tee",
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "ag",
  "ack",
  "curl",
  "jq",
  "yq",
  "write-output",
  "write-host",
  "select-string",
  "set-content",
  "add-content",
  "out-file",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
  "gh",
  "glab"
]);
var SELF_JUDGED_PROGRAMS = /* @__PURE__ */ new Set([
  ...POSIX_SHELLS,
  ...POWERSHELLS,
  ...INTERPRETER_FLAGS.keys(),
  "cmd",
  "wsl",
  "ssh",
  "su",
  "script",
  "eval",
  "env",
  "deno",
  "invoke-expression",
  "iex",
  "start-process",
  "saps",
  "start",
  "source",
  "."
]);
var SHELL_BUILTINS = /* @__PURE__ */ new Set(["[", "[[", "test", "export", "declare", "local", "readonly", "typeset", "set", "unset", "alias"]);
var FIND_EXEC = /* @__PURE__ */ new Set(["-exec", "-execdir", "-ok", "-okdir"]);
function denyDb(reason) {
  return deny(`${reason}, so it is refused from the terminal: the developer runs it in their own terminal where a database change is their decision`);
}
var SAIL_CLIENTS = /* @__PURE__ */ new Map([["redis", "redis-cli"], ["mongodb", "mongosh"]]);
var SAIL_ARTISAN = /* @__PURE__ */ new Set(["test", "dusk", "tinker"]);
var PHP_NAME = /^php[\d.]*$/;
var PYTHON_NAME = /^(python|python2|python3|py|pythonw)(\d[\d.]*)?$/;
var PYTHON_MODULES = /^(alembic|flask|django)$/;
var DJANGO_NAMES = /* @__PURE__ */ new Set(["manage.py", "django-admin", "django"]);
var BUNDLE_VALUES = /* @__PURE__ */ new Set(["--gemfile"]);
var DOTENV_VALUES = /* @__PURE__ */ new Set(["-e", "-v"]);
var FLASK_VALUES = /* @__PURE__ */ new Set(["--app", "-A", "-e", "--env-file"]);
var TURSO_VALUES = /* @__PURE__ */ new Set(["--instance", "--location", "--proxy"]);
var RUN_WRAPPERS = /* @__PURE__ */ new Set(["uv", "poetry", "pipenv", "pdm", "rye", "hatch", "dotenvx", "doppler"]);
var RUN_VALUE_OPTIONS = /* @__PURE__ */ new Set(["--with", "--python", "-p", "--project", "-C", "--directory", "--env", "-e", "--config", "-c", "-f", "--env-file"]);
var ENV_CMD_VALUES = /* @__PURE__ */ new Set(["-f", "--file", "-e", "--environments", "--rc-file"]);
var MAX_UNWRAP_DEPTH = 8;
function scriptPathOf(word) {
  return /[\\/]/.test(word) || programName(word) === "artisan" ? word : null;
}
function minimistCommandAt(values) {
  let k = 0;
  while (k < values.length && values[k].startsWith("-") && values[k] !== "--") {
    const next = values[k + 1];
    k += !values[k].includes("=") && next !== void 0 && !next.startsWith("-") ? 2 : 1;
  }
  return k;
}
function dbUnwrap(name, args, scriptPath, depth = 0) {
  const here = { name, args, scriptPath };
  if (depth >= MAX_UNWRAP_DEPTH) return [{ ...here, tooDeep: true }];
  const values = args.map((w) => w.value);
  const enter = (at2) => at2 >= 0 && at2 < values.length ? dbUnwrap(programName(values[at2]), args.slice(at2 + 1), scriptPathOf(values[at2]) ?? scriptPath, depth + 1) : [here];
  const inner = execInnerCommand(name, args);
  if (inner !== null && inner.length > 0) return enter(args.length - inner.length);
  if (RUNNERS.has(name)) {
    const marks = programPositions([name, ...values], 0, "bash").at;
    const idx = marks.lastIndexOf(true);
    if (idx > 0) return enter(idx - 1);
    return [here];
  }
  if (RUN_WRAPPERS.has(name)) {
    const r = values.indexOf("run");
    if (r !== -1) {
      let k = skipOptions(values, r + 1, RUN_VALUE_OPTIONS);
      if (values[k] === "--") k++;
      return enter(k);
    }
  }
  if (name === "env-cmd") return enter(skipOptions(values, 0, ENV_CMD_VALUES));
  const phpAt = PHP_NAME.test(name) ? values.indexOf("-f") !== -1 ? values.indexOf("-f") + 1 : scriptIndex(values, INTERPRETER_FLAGS.get("php")) : -1;
  const flag = INTERPRETER_FLAGS.get(PYTHON_NAME.test(name) ? "python" : name);
  const at = PHP_NAME.test(name) ? phpAt : flag !== void 0 ? scriptIndex(values, flag) : -1;
  const script = programName(values[at] ?? "");
  if (PHP_NAME.test(name) && (script === "artisan" || LARAVEL_TEST.has(script))) return enter(at);
  if (PYTHON_NAME.test(name) && (script === "manage.py" || values[at - 1] === "-m" && PYTHON_MODULES.test(values[at] ?? ""))) return enter(at);
  if (name === "ruby" && (script === "rails" || script === "rake")) return enter(at);
  if (name === "bundle") {
    const e = skipOptions(values, 0, BUNDLE_VALUES);
    if (values[e] === "exec") return enter(skipOptions(values, e + 1, BUNDLE_VALUES));
  }
  if (name === "herd" || name === "winpty") return enter(0);
  if (name === "cross-env") return enter(values.findIndex((v) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)));
  if (name === "dotenv") {
    const dash = values.indexOf("--");
    if (dash !== -1) return enter(dash + 1);
    return [.../* @__PURE__ */ new Set([skipOptions(values, 0, DOTENV_VALUES), minimistCommandAt(values)])].flatMap(enter);
  }
  if (name === "sail" && values.length > 0) {
    const sub = values[0].toLowerCase();
    if (SAIL_ARTISAN.has(sub)) return [{ name: "artisan", args, scriptPath }];
    if (sub === "bin") return enter(1);
    const client = SAIL_CLIENTS.get(sub);
    if (client !== void 0) return [{ name: client, args: args.slice(1), scriptPath }];
    return enter(0);
  }
  return [here];
}
function fromDbVerdict(v) {
  return v.ok ? ALLOW : denyDb(v.reason);
}
function databaseVerdict(rawName, rawArgs, bodies, piped, ctx, programWord) {
  for (const u of dbUnwrap(rawName, rawArgs, scriptPathOf(programWord))) {
    const v = unwrappedVerdict(u, bodies, piped, ctx);
    if (isDeny(v)) return v;
    if (u.name !== rawName && u.tooDeep !== true) {
      const call = managerCall(u.name, u.args);
      if (call !== null) {
        const mv = judgeManager(call, ctx, piped);
        if (isDeny(mv)) return mv;
      }
    }
  }
  return ALLOW;
}
function replFromPipe(name, sub, piped) {
  if (!piped || REPL_COMMANDS.get(name)?.has(sub) !== true) return ALLOW;
  return denyDb(`\`${name} ${sub}\` reads code or statements from a pipe or file, which the guard cannot read`);
}
function unwrappedVerdict({ name, args, scriptPath, tooDeep }, bodies, piped, ctx) {
  if (tooDeep) return denyDb(`the command runs through more than ${MAX_UNWRAP_DEPTH} wrappers, too many to read`);
  const values = args.map((w) => w.value);
  const positional = values.filter((v) => !v.startsWith("-")).map((v) => v.toLowerCase());
  const container = containerDataLoss(name, values);
  if (!container.ok) return denyDb(container.reason);
  if (WRITE_PROGRAMS.has(name)) return denyDb(`\`${name}\` loads or restores data into a database`);
  if (name === "pg_restore" && values.some((v) => PG_RESTORE_TO_DATABASE.test(v))) return denyDb("`pg_restore -d` restores data into a database");
  const spec = DB_CLIENTS.get(name);
  if (spec) return clientVerdict(spec, name, args, bodies, piped);
  if (name === "wrangler" && positional[0] === "d1" && positional[1] === "execute") return clientVerdict(WRANGLER_D1, "wrangler d1 execute", args, bodies, piped);
  if (name === "turso" && positional[0] === "db" && positional[1] === "shell") return tursoShellVerdict(args, bodies, piped);
  if ((name === "pscale" || name === "planetscale") && positional[0] === "shell") {
    if (values.some((v) => /^(-e|--execute)(=|$)/.test(v))) return denyDb(`\`${name} shell\` runs a statement the guard does not read`);
    if (bodies.length > 0) return bodies.map(statementVerdict).map(fromDbVerdict).find(isDeny) ?? ALLOW;
    return piped ? denyDb(`\`${name} shell\` reads its statements from a pipe or file, which the guard cannot read`) : ALLOW;
  }
  const tool = MIGRATION_TOOLS.get(name);
  if (tool) return fromDbVerdict(toolSubVerdict(tool, values, name));
  if (name === "artisan") {
    const k = skipOptions(values, 0, ARTISAN_GLOBAL_VALUES);
    const sub = (values[k] ?? "").toLowerCase();
    const rest = args.slice(k + 1);
    if (ARTISAN_REFUSE.has(sub)) return denyDb(`\`artisan ${sub}\` changes the database`);
    if (sub === "tinker" && allFlagValues(rest, /^(--execute|--command)$/, /^--(?:execute|command)=([\s\S]+)$/).length > 0) {
      return denyDb("`artisan tinker --execute` runs arbitrary code against the database");
    }
    if (ARTISAN_TESTS.has(sub)) return laravelTestVerdict(ctx, scriptPath, rest, sub);
    return replFromPipe("artisan", sub, piped);
  }
  if (DJANGO_NAMES.has(name)) {
    const sub = (values[0] ?? "").toLowerCase();
    if (sub === "migrate" && values.some((v) => DJANGO_READ_FLAGS.test(v))) return ALLOW;
    if (DJANGO_REFUSE.has(sub)) return denyDb(`\`manage.py ${sub}\` changes the database`);
    if (sub === "shell" && values.some((v) => /^(-c|--command)(=|$)/.test(v))) return denyDb("`manage.py shell -c` runs arbitrary code against the database");
    if (sub === "dbshell" && values.includes("--")) return denyDb("`manage.py dbshell --` hands arguments the guard does not read to the database client");
    return replFromPipe("manage.py", sub, piped);
  }
  if (name === "rails" || name === "rake") {
    const sub = positional[0] ?? "";
    if (name === "rails" && (sub === "runner" || sub === "r")) return denyDb("`rails runner` runs arbitrary code against the database");
    const task = positional.find(railsTaskChangesDatabase);
    if (task !== void 0) return denyDb(`\`${name} ${task}\` changes the database`);
    return replFromPipe(name, sub, piped);
  }
  if (name === "flask") {
    const k = skipOptions(values, 0, FLASK_VALUES);
    const sub = (values[k] ?? "").toLowerCase();
    const rest = values.slice(k + 1);
    const action = (rest[0] ?? "").toLowerCase();
    if (sub === "db" && /^(upgrade|downgrade|stamp)$/.test(action) && !rest.includes("--sql")) return denyDb(`\`flask db ${action}\` changes the database`);
    return replFromPipe("flask", sub, piped);
  }
  if (LARAVEL_TEST.has(name)) return laravelTestVerdict(ctx, scriptPath, args, null);
  return ALLOW;
}
function tursoShellVerdict(args, bodies, piped) {
  const positional = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value;
    if (v.startsWith("-")) {
      if (TURSO_VALUES.has(v)) k++;
      continue;
    }
    positional.push(args[k]);
  }
  const statements = positional.slice(3);
  if (statements.length > 0) return statements.map((s) => sqliteVerdict("turso db shell", s)).find(isDeny) ?? ALLOW;
  if (bodies.length > 0) return bodies.map(statementVerdict).map(fromDbVerdict).find(isDeny) ?? ALLOW;
  return piped ? denyDb("`turso db shell` reads its statements from a pipe or file, which the guard cannot read") : ALLOW;
}
var DB_ENV_KEYS = /* @__PURE__ */ new Set(["DB_CONNECTION", "DB_DATABASE", "DB_URL", "DATABASE_URL"]);
var DB_URL_KEYS = ["DB_URL", "DATABASE_URL"];
var TEST_DB_NAME = /(^|[^a-z])test(s|ing)?([^a-z]|$)/i;
var PHPUNIT_FILES = ["phpunit.xml", "phpunit.dist.xml", "phpunit.xml.dist"];
var NO_TEST_RUN = /^(--version|--help|-h|--list-tests|--list-tests-xml|--list-suites|--list-groups|--list-test-files|--check-version|--generate-configuration|--migrate-configuration|--atleast-version)(=|$)/;
function phpunitEnv(xml) {
  const forced = /* @__PURE__ */ new Map();
  const unforced = [];
  for (const element of xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(?:server|env)\s([^>]*)>/g)) {
    const attrs = /* @__PURE__ */ new Map();
    for (const a of element[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs.set(a[1], a[2] ?? a[3] ?? "");
    const key = attrs.get("name");
    if (key === void 0 || !DB_ENV_KEYS.has(key)) continue;
    if ((attrs.get("force") ?? "").toLowerCase() === "true") forced.set(key, attrs.get("value") ?? "");
    else unforced.push(key);
  }
  return { forced, unforced };
}
function isDisposableDb(env) {
  if (DB_URL_KEYS.some((k) => (env.forced.get(k) ?? "") !== "")) return false;
  const database = env.forced.get("DB_DATABASE");
  if (database === void 0) return false;
  if (database === ":memory:") return (env.forced.get("DB_CONNECTION") ?? "").toLowerCase() === "sqlite";
  return TEST_DB_NAME.test(database.split(/[\\/]/).pop() ?? "");
}
function readTextAt(ctx, path) {
  const read = ctx.pkg.read(path);
  return read.kind === "text" ? read.text : null;
}
function laravelProject(ctx, here, scriptPath) {
  const script = scriptPath === null ? void 0 : resolveFolder(here, scriptPath);
  for (const start of [script === void 0 ? void 0 : dirname(script), here]) {
    if (start === void 0) continue;
    const found = findUp(start, "composer.json", ctx.pkg.read);
    if (found === null) continue;
    const dir = dirname(found.path);
    const laravel = found.read.kind === "unreadable" || /laravel\/framework/.test(found.read.text);
    if (laravel && ctx.pkg.read(join(dir, "artisan")).kind !== "missing") return dir;
  }
  return null;
}
function configOption(args) {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value;
    if (v === "--no-configuration") return "none";
    if (v === "-c" || v === "--configuration") {
      const next = args[k + 1];
      return next === void 0 ? { path: null, dynamic: false } : { path: next.value, dynamic: isDynamicWord(next) };
    }
    const m = /^(?:--configuration=|-c)(.+)$/.exec(v);
    if (m) return { path: m[1], dynamic: isDynamicWord(args[k]) };
  }
  return null;
}
function laravelTestVerdict(ctx, scriptPath, args, artisanSub) {
  if (!ctx.databaseTestGuard) return ALLOW;
  if (args.some((w) => NO_TEST_RUN.test(w.value))) return ALLOW;
  const here = ctx.folder.current;
  if (here === void 0) {
    if (ctx.cwd === void 0) return ALLOW;
    return deny(
      "this test run is refused: the guard lost track of the folder it runs in (a `cd` through a variable, or `cd -`), so it cannot confirm the tests use a throwaway database \u2014 write the folder out, run it from the project, or the developer runs it themselves. Turn this check off with database_test_guard=false in .rsct.json if it does not fit this project."
    );
  }
  const project = laravelProject(ctx, here, scriptPath);
  if (project === null) return ALLOW;
  if (artisanSub === "dusk") return refuseLaravelTest(project, null, ["Dusk swaps in its own environment file, which the guard does not read"]);
  const option = configOption(args);
  if (option === "none") return refuseLaravelTest(project, null, ["--no-configuration runs the tests without phpunit.xml"]);
  if (option !== null && (option.dynamic || option.path === null)) return refuseLaravelTest(project, null, ["the phpunit configuration file comes from a variable the guard cannot read"]);
  const configDir = artisanSub === null ? here : project;
  const named = option === null ? void 0 : resolveFolder(configDir, option.path);
  const candidates = option === null ? PHPUNIT_FILES.map((f) => join(configDir, f)) : named === void 0 ? [] : [...PHPUNIT_FILES.map((f) => join(named, f)), named];
  let file;
  let xml = null;
  for (const c of candidates) {
    const read = ctx.pkg.read(c);
    if (read.kind === "missing") continue;
    file = c;
    xml = read.kind === "text" ? read.text : null;
    break;
  }
  if (file === void 0) {
    return deny(
      `this Laravel test run is refused: no phpunit configuration file was found in ${option === null ? configDir : named} (${project} is a Laravel project), so the guard cannot confirm a throwaway test database. Run it from the project root, pass -c <file>, or the developer runs it themselves. Turn this check off with database_test_guard=false in .rsct.json.`
    );
  }
  if (xml === null) return refuseLaravelTest(project, file, [`${basename(file)} could not be read`]);
  const env = phpunitEnv(xml);
  const reasons = [];
  const loose = [...new Set(env.unforced.filter((k) => !env.forced.has(k)))];
  if (loose.length > 0) reasons.push(`${basename(file)} sets ${loose.join(", ")} without force="true", so a value from the environment or .env wins`);
  const envFiles = [".env", ".env.testing"].map((f) => readTextAt(ctx, join(project, f)) ?? "");
  const urlSet = DB_URL_KEYS.some((k) => !env.forced.has(k) && envFiles.some((t) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${k}[ \\t]*=[ \\t]*["']?[^\\s"'#]`, "m").test(t)));
  if (urlSet) reasons.push("DB_URL or DATABASE_URL is set in .env or .env.testing and overrides the database phpunit.xml names");
  if (urlSet || !isDisposableDb(env)) return refuseLaravelTest(project, file, reasons);
  return ALLOW;
}
function refuseLaravelTest(dir, file, reasons) {
  return deny(
    `this Laravel test run is refused: the guard cannot confirm it uses a throwaway test database, and a suite with RefreshDatabase recreates whatever database it connects to${dir === null ? "" : ` (${dir})`}. ` + (reasons.length > 0 ? `${reasons.join("; ")}. ` : "") + `Point the tests at a disposable database \u2014 add \`<env name="DB_CONNECTION" value="sqlite" force="true"/>\` and \`<env name="DB_DATABASE" value=":memory:" force="true"/>\` to ${file === null ? "phpunit.xml" : basename(file)} \u2014 or the developer runs the tests themselves. Turn this check off with database_test_guard=false in .rsct.json if it does not fit this project.`
  );
}
function allFlagValues(args, flag, attached) {
  const found = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value;
    if (flag.test(v)) {
      const next = args[k + 1];
      found.push(next === void 0 ? { text: "", dynamic: false } : { text: next.value, dynamic: isDynamicWord(next) });
      k++;
      continue;
    }
    const m = attached.exec(v);
    if (m) found.push({ text: m[1], dynamic: isDynamicWord(args[k]) });
  }
  return found;
}
var SQLITE_VALUE_OPTIONS = /* @__PURE__ */ new Set(["-separator", "-newline", "-nullvalue", "-vfs", "-lookaside", "-maxsize", "-mmap", "-pagecache", "-heap", "-escape"]);
function sqliteStatements(args) {
  const positionals = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value;
    if (v.startsWith("-")) {
      if (SQLITE_VALUE_OPTIONS.has(v)) k++;
      continue;
    }
    positionals.push(args[k]);
  }
  return positionals.slice(1);
}
function sqliteVerdict(name, statement) {
  if (isDynamicWord(statement)) return denyDb(`\`${name}\` runs a statement built from a variable the guard cannot read`);
  const dot = statement.value.trim().split(/\s+/)[0].toLowerCase();
  if (dot.startsWith(".")) return SQLITE_READ_DOT.has(dot) ? ALLOW : denyDb(`\`${name} ${dot}\` is not a read-only command`);
  return fromDbVerdict(statementVerdict(statement.value));
}
function clientVerdict(spec, name, args, bodies, piped) {
  for (const w of args) {
    if (spec.unreadable?.test(w.value) || w.value === "-") return denyDb(`\`${name}\` reads its statements from a file or stdin, which the guard cannot read`);
  }
  if (spec.mode === "redis") return fromDbVerdict(redisVerdict(args.map((w) => w.value), piped));
  if (spec.mode === "sqlite") {
    const statements2 = sqliteStatements(args);
    if (statements2.length > 0) return statements2.map((s) => sqliteVerdict(name, s)).find(isDeny) ?? ALLOW;
    if (bodies.length > 0) return bodies.map(statementVerdict).map(fromDbVerdict).find(isDeny) ?? ALLOW;
    if (piped) return denyDb(`\`${name}\` reads its statements from a pipe or file, which the guard cannot read`);
    return ALLOW;
  }
  const statements = spec.sqlFlags && spec.attachedSql ? allFlagValues(args, spec.sqlFlags, spec.attachedSql) : [];
  if (statements.some((s) => s.dynamic)) return denyDb(`\`${name}\` runs a statement built from a variable the guard cannot read`);
  if (statements.length > 0) {
    const judge = spec.mode === "mongo" ? mongoVerdict : statementVerdict;
    return statements.map((s) => fromDbVerdict(judge(s.text))).find(isDeny) ?? ALLOW;
  }
  if (bodies.length > 0 && spec.mode === "sql") return bodies.map(statementVerdict).map(fromDbVerdict).find(isDeny) ?? ALLOW;
  if (piped) return denyDb(`\`${name}\` reads its statements from a pipe, which the guard cannot read`);
  return ALLOW;
}
function literalGitVerdict(name, args, bodies, dialect) {
  if (TEXT_ONLY_PROGRAMS.has(name) || SELF_JUDGED_PROGRAMS.has(name) || SHELL_BUILTINS.has(name) || DISTRO_LAUNCHERS.test(name)) return ALLOW;
  if (dialect === "powershell" && (name.startsWith("$") || name.startsWith("-") || name.startsWith("'") || name.startsWith('"'))) return ALLOW;
  const values = args.map((a) => a.value);
  if (name === "git") {
    const configValues = [];
    for (let k = 0; k < values.length; k++) {
      if (values[k] === "-c" || values[k] === "--config-env") configValues.push(values[k + 1] ?? "");
      else if (/^-c./.test(values[k])) configValues.push(values[k].slice(2));
    }
    const at = gitGlobalEnd(values);
    if (values[at]?.toLowerCase() === "config") configValues.push(...values.slice(at + 1).filter((v) => !v.startsWith("-")));
    return configValues.map(judgeCode).find(isDeny) ?? ALLOW;
  }
  if (name === "find") {
    for (let k = 0; k < args.length; k++) {
      if (!FIND_EXEC.has(values[k])) {
        const v = judgeCode(values[k]);
        if (isDeny(v)) return v;
        continue;
      }
      let end = k + 1;
      while (end < args.length && values[end] !== ";" && values[end] !== "+") end++;
      const span = args.slice(k + 1, end);
      if (span.length > 0) {
        const v = literalGitVerdict(programName(span[0].value), span.slice(1), [], dialect);
        if (isDeny(v)) return v;
      }
      k = end;
    }
    return bodies.map(judgeCode).find(isDeny) ?? ALLOW;
  }
  return [...values, ...bodies].map(judgeCode).find(isDeny) ?? ALLOW;
}
function denyReader(name) {
  return deny(`'${name}' here would run commands it reads from a pipe or from another command's output; the guard cannot read them, so the command was refused \u2014 write the commands out`);
}
function shellScriptArg(args) {
  let code = false;
  let stdin = false;
  for (let k = 0; k < args.length; k++) {
    const x = args[k].value;
    if (x === "--") return { code, stdin, script: args[k + 1] };
    if (/^[-+]o$|^[-+]O$/.test(x)) {
      k++;
      continue;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(x)) code = true;
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(x)) stdin = true;
    if (x.startsWith("-") || x.startsWith("+")) {
      if (x === "-") return { code, stdin: true, script: void 0 };
      continue;
    }
    return { code, stdin, script: args[k] };
  }
  return { code, stdin, script: void 0 };
}
function execInnerCommand(name, args) {
  const sub = args[0]?.value;
  const at = containerCommandAt(name, args.map((a) => a.value));
  if (at !== null) return args.slice(at);
  if (name === "kubectl" && sub === "exec") {
    const dash = args.findIndex((a) => a.value === "--");
    return dash === -1 ? null : args.slice(dash + 1);
  }
  return null;
}
function readerVerdict(name, args, dialect, piped, viaXargs) {
  const values = args.map((a) => a.value);
  if (POSIX_SHELLS.has(name)) {
    if (piped && viaXargs) return denyReader(name);
    const s = shellScriptArg(args);
    if (s.script?.procsub === true) return denyReader(name);
    if (s.code) return ALLOW;
    if (piped && (s.stdin || s.script === void 0 || STDIN_SCRIPTS.has(s.script.value))) return denyReader(name);
    return ALLOW;
  }
  if (dialect === "bash" && (name === "source" || name === ".")) {
    const target = args[0];
    if (target !== void 0 && (target.procsub === true || STDIN_SCRIPTS.has(target.value))) return denyReader(name);
    return ALLOW;
  }
  if (POWERSHELLS.has(name)) {
    if (!piped) return ALLOW;
    const named = values.findIndex((v) => /^-(c|co|com|comm|comma|comman|command|f|fi|fil|file)$/i.test(v));
    if (named !== -1) return values[named + 1] === "-" ? denyReader(name) : ALLOW;
    return values.some((v) => !v.startsWith("-")) && !values.includes("-") ? ALLOW : denyReader(name);
  }
  if (name === "cmd") return piped && !values.some((v) => /^\/[ckCK]$/.test(v)) ? denyReader(name) : ALLOW;
  if (dialect === "powershell" && (name === "iex" || name === "invoke-expression")) return piped && values.length === 0 ? denyReader(name) : ALLOW;
  if (INTERPRETER_FLAGS.has(name)) {
    const flag = INTERPRETER_FLAGS.get(name);
    if (flagValues(values, flag).length > 0) return ALLOW;
    const at = scriptIndex(values, flag);
    const script = args[at];
    if (script?.procsub === true) return denyReader(name);
    if (piped && (script === void 0 || STDIN_SCRIPTS.has(script.value))) return denyReader(name);
    return ALLOW;
  }
  if (name === "at" || name === "batch") return piped ? denyReader(name) : ALLOW;
  if (name === "su") return piped && !values.some((v) => /^(-[a-zA-Z]*c|--command|--session-command)(=|$)/.test(v)) ? denyReader(name) : ALLOW;
  if (name === "ssh") {
    let k = 0;
    while (k < values.length && values[k].startsWith("-")) k += SSH_VALUE_OPTIONS.has(values[k]) ? 2 : 1;
    return piped && k + 1 >= values.length ? denyReader(name) : ALLOW;
  }
  if (name === "git" && viaXargs && piped) {
    const at = gitGlobalEnd(values);
    const verb = values[at];
    return verb === void 0 || verb.includes("{}") ? denyReader("xargs git") : ALLOW;
  }
  const inner = execInnerCommand(name, args);
  if (inner !== null && inner.length > 0) return readerVerdict(programName(inner[0].value), inner.slice(1), "bash", piped, false);
  return ALLOW;
}
function isVariable(w) {
  return w.expansion && w.value.startsWith("$");
}
function isDynamicWord(w) {
  return w.expansion || w.spliced === true;
}
function wordsOf(command) {
  return command.filter((t) => t.kind === "word" && t.redirect !== true);
}
function splitJoined(words) {
  return words.flatMap((w) => !w.expansion && /\s/.test(w.value) ? wordsOf(lex(w.value, "bash").tokens) : [w]);
}
function gitGlobalEnd(args) {
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === "-C" || GIT_VALUE_OPTIONS.has(a)) {
      j += 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(a) || /^--[\w-]+=/.test(a)) {
      j++;
      continue;
    }
    break;
  }
  return j;
}
function mayNameGatedVerb(next) {
  const lower = next.toLowerCase();
  return next.startsWith("-") || BLOCKED_GIT_VERBS.has(lower) || lower === "pr";
}
function judgeDynamicProgram(after) {
  const args = after.map((w) => w.value);
  const at = gitGlobalEnd(args);
  const verb = args[at]?.toLowerCase();
  const alias = verb === void 0 ? void 0 : scanGitOptions(args).aliases[verb]?.replace(/^\s*!/, "");
  const viaAlias = alias !== void 0 && (BLOCKED_GIT_VERBS.has(alias.trim().split(/\s+/)[0].toLowerCase()) || CODE_GIT_TEXT.test(alias));
  const gitVerb = viaAlias || verb !== void 0 && BLOCKED_GIT_VERBS.has(verb) && !isAllowedForm(verb, args.slice(0, at), args.slice(at + 1), after.slice(at + 1).map(isDynamicWord));
  const ghFirst = args.find((a, k) => !a.startsWith("-") && !GH_VALUE_OPTIONS.has(args[k - 1] ?? ""));
  const ghMerge = ghFirst?.toLowerCase() === "pr" && isDeny(judgeGh(args, after.map(isDynamicWord)));
  if (!gitVerb && !ghMerge) return ALLOW;
  return deny(`a command name built from a variable, a substitution or a brace or glob pattern is followed by '${gitVerb ? args[at] : "pr merge"}'; the guard cannot read which program that is, so the command was refused \u2014 write the program name out`);
}
function startProcessParam(word) {
  const m = /^-([A-Za-z]+)(?::(.*))?$/s.exec(word);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const exact = START_PROCESS_PARAMS.get(name);
  const kinds = exact !== void 0 ? [exact] : [...START_PROCESS_PARAMS].filter(([p]) => p.startsWith(name)).map(([, k]) => k);
  return kinds.length === 1 ? { kind: kinds[0], attached: m[2] ?? null } : null;
}
function judgeStartProcess(after, ctx) {
  if (ctx.depth > MAX_DEPTH) return deny("the command nests shells or substitutions too deeply to be read; write it out plainly");
  let program = null;
  const args = [];
  let inArguments = false;
  for (let k = 0; k < after.length; k++) {
    const w = after[k];
    if (inArguments && w.listed) {
      args.push(w);
      continue;
    }
    const p = w.expansion ? null : startProcessParam(w.value);
    if (p) {
      inArguments = false;
      if (p.kind === "switch") continue;
      const value = p.attached !== null ? { value: p.attached, expansion: false } : after[++k];
      if (value === void 0) continue;
      if (p.kind === "program") program = value;
      else if (p.kind === "arguments") {
        args.push(value);
        inArguments = true;
      }
      continue;
    }
    inArguments = false;
    if (program !== null) args.push(w);
    else program = w;
  }
  if (program === null) return ALLOW;
  const line = [program, ...splitJoined(args)].map((x) => ({ kind: "word", value: x.value, expansion: x.expansion, ...x.spliced ? { spliced: true } : {} }));
  return judgeCommandWords(line, "powershell", ctx);
}
function bodiesOf(command) {
  return command.filter((t) => t.kind === "body").map((t) => t.text);
}
function switchKeyVerdict(text) {
  const decoded = decodeUnicodeEscapes(text);
  if (HOOKS_OFF_KEY.test(text) || HOOKS_OFF_KEY.test(decoded)) return denyHooksOff();
  if (DATABASE_SWITCH_KEY.test(text) || DATABASE_SWITCH_KEY.test(decoded)) {
    return deny("a command that mentions database_guard or database_test_guard is refused: switching the database guard off is the developer's own edit of .rsct.json");
  }
  return ALLOW;
}
function judgeText(text, dialect, ctx, firstPiped = false) {
  if (ctx.depth > MAX_DEPTH) return deny("the command nests shells or substitutions too deeply to be read; write it out plainly");
  const keys = switchKeyVerdict(text);
  if (isDeny(keys)) return keys;
  const here = ctx.folder.current;
  const inner = { ...ctx, depth: ctx.depth + 1, folder: { start: here, current: here, stack: [] } };
  const lexed = lex(text, dialect);
  for (const n of lexed.nested) {
    const v = judgeText(n.text, n.dialect, inner, n.piped === true);
    if (isDeny(v)) return v;
  }
  const commands = splitCommands(lexed.tokens, firstPiped);
  const saved = [];
  for (let k = 0; k < commands.length; k++) {
    const command = commands[k];
    for (let n = 0; n < command.opens; n++) saved.push(inner.folder.current);
    const before = inner.folder.current;
    const v = judgeCommandWords(command.tokens, dialect, inner, command.piped);
    if (isDeny(v)) return v;
    if (dialect === "bash" && (command.piped || commands[k + 1]?.piped === true)) inner.folder.current = before;
    for (let n = 0; n < command.closes && saved.length > 0; n++) inner.folder.current = saved.pop();
  }
  return ALLOW;
}
function judgeCommandWords(command, dialect, ctx, piped = false) {
  const words = wordsOf(command);
  if (words.length > MAX_COMMAND_WORDS) {
    return deny(`a single command with more than ${MAX_COMMAND_WORDS} words is refused: the guard cannot judge it in time. Split it into shorter commands, or write long input to a file with the Write tool`);
  }
  const bodies = bodiesOf(command);
  const values = words.map((x) => x.value);
  const dynamic = words.map(isDynamicWord);
  const program = words.findIndex((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.value) && !SHELL_KEYWORDS.has(x.value));
  const runsHere = [];
  let chain = program !== -1;
  for (let k = 0; k < words.length; k++) {
    runsHere.push(chain && k >= program);
    if (k < program) continue;
    const x = values[k];
    if (programName(x) === "command" && /^-[a-zA-Z]*[vV]/.test(values[k + 1] ?? "")) chain = false;
    else if (!WRAPPERS.has(programName(x)) && !(k > program && x.startsWith("-"))) chain = false;
  }
  const runner = programPositions(values, program, dialect);
  recordPackageWrites(command, values, bodies, runner.at, ctx);
  for (let i = 0; i < words.length; i++) {
    if (ctx.now() > ctx.workDeadline) return denySlow();
    const w = words[i];
    const name = programName(w.value);
    let restCache = null;
    const rest = () => restCache ??= values.slice(i + 1);
    const restDynamic = () => dynamic.slice(i + 1);
    if (dialect === "bash" && w.expansion && !w.quoted && w.glob !== true && (runsHere[i] || runner.at[i] === true)) {
      return deny(`a command run from an unquoted variable, substitution or brace or glob pattern ('${w.value}') cannot be read: the shell splits it into a whole command line, so the command was refused \u2014 write the program name out (or quote the variable when it holds only a program path)`);
    }
    if (runner.at[i] === true && !isRunnerName(name, dialect)) {
      const after = words.slice(i + 1);
      const reader = readerVerdict(name, after, dialect, piped, runner.xargs[i] === true);
      if (isDeny(reader)) return reader;
      const literal = literalGitVerdict(name, after, bodies, dialect);
      if (isDeny(literal)) return literal;
      if (ctx.database) {
        const stdinFile = command.some((t) => t.kind === "word" && (t.stdin === true || t.procsub === true));
        const db = databaseVerdict(name, after, bodies, piped || stdinFile || bodies.length > 0, ctx, w.value);
        if (isDeny(db)) return db;
      }
      const call = managerCall(name, after);
      if (call !== null) {
        const v2 = judgeManager(call, ctx, piped);
        if (isDeny(v2)) return v2;
      }
      if ((dialect === "bash" ? BASH_FOLDER_CHANGES : POWERSHELL_FOLDER_CHANGES).has(name)) changeFolder(name, after, dialect, ctx.folder);
    }
    if (w.expansion && i + 1 < words.length && mayNameGatedVerb(values[i + 1])) {
      const v2 = judgeDynamicProgram(words.slice(i + 1));
      if (isDeny(v2)) return v2;
    }
    let v = ALLOW;
    const dashed = w.value.includes("://") ? void 0 : /^git-(.+)$/.exec(name)?.[1];
    if (name === "git") v = judgeGit(rest(), ctx, {}, restDynamic());
    else if (dashed !== void 0 && BLOCKED_GIT_VERBS.has(dashed)) v = isAllowedForm(dashed, [], rest(), restDynamic()) ? ALLOW : denyGit(dashed);
    else if (name === "gh") v = judgeGh(rest(), restDynamic());
    else if (POSIX_SHELLS.has(name)) v = judgeShellRunner(rest(), bodies, ctx);
    else if (POWERSHELLS.has(name)) v = judgePowerShellRunner(rest(), words.slice(i + 1).map(isVariable), bodies, ctx, name !== "pwsh");
    else if (dialect === "powershell" && START_PROCESS.has(name)) v = judgeStartProcess(words.slice(i + 1), { ...ctx, depth: ctx.depth + 1 });
    else if (name === "cmd") v = judgeCmdRunner(rest(), ctx);
    else if (name === "wsl") v = judgeWslRunner(rest(), ctx);
    else if (DISTRO_LAUNCHERS.test(name) && values[i + 1]?.toLowerCase() === "run") v = judgeText(rest().slice(1).join(" "), "bash", ctx);
    else if (name === "ssh") v = judgeSshRunner(rest(), ctx);
    else if (name === "su" || name === "script") v = flagValues(rest(), SU_COMMAND_FLAG).map((c) => judgeText(c.text, "bash", ctx)).find(isDeny) ?? ALLOW;
    else if (name === "eval" && dialect === "bash" && runsHere[i]) v = judgeText(rest().join(" "), "bash", ctx);
    else if ((name === "invoke-expression" || name === "iex") && dialect === "powershell" && (i === 0 || ["=", "&", "."].includes(values[i - 1]))) {
      v = words.slice(i + 1).some(isVariable) ? deny("Invoke-Expression with code built from a variable cannot be read, so the command was refused \u2014 write the command out") : judgeText(rest().join(" "), "powershell", ctx);
    } else if (name === "env") v = envSplitStrings(rest()).map((t) => judgeText(t, "bash", ctx)).find(isDeny) ?? ALLOW;
    else if (name === "deno" && values[i + 1] === "eval") {
      v = words.slice(i + 2).some((x) => x.expansion) ? deny("code passed to deno from a variable or a substitution cannot be read, so the command was refused \u2014 write the code out") : judgeCode(rest().slice(1).join(" "));
    } else if (INTERPRETER_FLAGS.has(name)) {
      const flag = INTERPRETER_FLAGS.get(name);
      const scriptAt = scriptIndex(rest(), flag);
      const codes = flagValues(rest(), flag, words.slice(i + 1).map((x) => x.expansion));
      if (codes.some((c) => c.dynamic && c.at < scriptAt)) {
        v = deny(`code passed to ${name} from a variable or a substitution cannot be read, so the command was refused \u2014 write the code out`);
      } else if (codes.length > 0) v = codes.map((c) => judgeCode(c.text)).find(isDeny) ?? ALLOW;
      else {
        const script = rest()[scriptAt];
        if (script === void 0 || STDIN_SCRIPTS.has(script)) v = bodies.map(judgeCode).find(isDeny) ?? ALLOW;
      }
    }
    if (isDeny(v)) return v;
  }
  return ALLOW;
}
function changeFolder(name, args, dialect, folder) {
  if (name === "popd" || name === "pop-location") {
    if (folder.stack.length > 0) folder.current = folder.stack.pop();
    return;
  }
  let target;
  for (let k = 0; k < args.length; k++) {
    const a = args[k].value;
    if (a === "--") {
      target = args[k + 1];
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      if (dialect === "powershell" && /^-stackname$/i.test(a)) k++;
      continue;
    }
    target = args[k];
    break;
  }
  if (name === "pushd" || name === "push-location") folder.stack.push(folder.current);
  if (target === void 0) {
    if (name === "pushd") folder.current = void 0;
    else if (name !== "push-location") folder.current = homedir();
  } else if (target.value === "-" || isDynamicWord(target)) folder.current = void 0;
  else {
    const next = resolveFolder(folder.current, target.value);
    folder.current = next !== void 0 && next.length <= MAX_FOLDER_LENGTH ? next : void 0;
  }
}
function copyDestination(args) {
  const flag = args.findIndex((a) => /^-(destination|t)$/i.test(a) || a === "--target-directory");
  if (flag !== -1) return args[flag + 1] ?? "";
  const attached = args.find((a) => a.startsWith("--target-directory="));
  if (attached !== void 0) return attached.slice("--target-directory=".length);
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional[positional.length - 1] ?? "";
}
function recordWrite(ctx, rel) {
  const folder = rel === void 0 ? ctx.folder.current : resolveFolder(ctx.folder.current, rel);
  if (folder === void 0) ctx.unit.wroteUnknown = true;
  else ctx.unit.wrote.add(folder);
}
function recordPackageWrites(command, values, bodies, at, ctx) {
  for (const t of command) {
    if (t.kind === "word" && t.redirect === true && PACKAGE_FILE_NAME.test(t.value)) recordWrite(ctx, dirname(t.value));
  }
  const main = at.lastIndexOf(true);
  if (main === -1) return;
  const args = values.slice(main + 1);
  const inBodies = bodies.some((b) => PACKAGE_FILE_NAME.test(b));
  const named = args.find((a) => PACKAGE_FILE_NAME.test(a));
  if (!inBodies && named === void 0) return;
  const name = programName(values[main]);
  if (READ_ONLY_PROGRAMS.has(name) || MANAGERS.has(name) || EXEC_RUNNERS.has(name)) return;
  if (name === "git" && GIT_READ_VERBS.has(args[gitGlobalEnd(args)]?.toLowerCase() ?? "")) return;
  if (COPY_PROGRAMS.has(name)) {
    if (inBodies) return;
    const dest = copyDestination(args);
    recordWrite(ctx, PACKAGE_FILE_NAME.test(basename(dest)) ? dirname(dest) : dest);
    return;
  }
  recordWrite(ctx, inBodies || named === void 0 ? void 0 : dirname(named));
}
function wroteInto(ctx, folder) {
  return ctx.unit.wroteUnknown || ctx.unit.wrote.has(folder);
}
function managerCall(name, after) {
  const manager = MANAGERS.get(name);
  if (manager !== void 0) return { manager, args: after, exec: false };
  if (EXEC_RUNNERS.has(name)) return { manager: "npm", args: after, exec: true };
  if (name === "corepack" && after[0] !== void 0) {
    const inner = MANAGERS.get(programName(after[0].value).replace(/@.*$/, ""));
    if (inner !== void 0) return { manager: inner, args: after.slice(1), exec: false };
  }
  if (name === "php") {
    const at = scriptIndex(after.map((w) => w.value), INTERPRETER_FLAGS.get("php"));
    const script = after[at];
    if (script !== void 0 && MANAGERS.get(programName(script.value)) === "composer") return { manager: "composer", args: after.slice(at + 1), exec: false };
  }
  return null;
}
function wordToken(w) {
  return {
    kind: "word",
    value: w.value,
    expansion: w.expansion,
    ...w.spliced ? { spliced: true } : {},
    ...w.quoted ? { quoted: true } : {},
    ...w.glob ? { glob: true } : {}
  };
}
function judgeManager(call, ctx, piped) {
  const values = call.args.map((w) => w.value);
  const plan = call.exec ? null : planManager(call.manager, values);
  const exec = plan ?? planExecRunner(values);
  for (const code of exec.execCode) {
    if (isDynamicWord(call.args[code.at])) return deny("code passed to a package manager from a variable or a substitution cannot be read, so the command was refused \u2014 write the code out");
    const v = judgeText(code.value, "bash", ctx);
    if (isDeny(v)) return v;
  }
  if (exec.execAt !== null && !isDynamicWord(call.args[exec.execAt])) {
    const v = judgeCommandWords(call.args.slice(exec.execAt).map(wordToken), "bash", { ...ctx, depth: ctx.depth + 1 }, piped);
    if (isDeny(v)) return v;
  }
  if (plan === null) return ALLOW;
  if (plan.versionCommit) return denyVersion(call.manager);
  const base = ctx.folder.current ?? ctx.folder.start;
  if (plan.writesPackage) {
    recordWrite(ctx, base === void 0 ? void 0 : ".");
    return ALLOW;
  }
  if (plan.global) return ALLOW;
  if (plan.nameAt.some((at) => isDynamicWord(call.args[at]))) {
    return deny("a package script named by a variable or a substitution cannot be read, so the command was refused \u2014 write the script name out");
  }
  if (plan.names.length === 0) return ALLOW;
  const options = plan.folders.filter((f) => !isDynamicWord(call.args[f.at]));
  const dirs = options.length === 0 ? [base] : options.map((f) => resolveFolder(base, f.value));
  for (const dir of new Set(dirs)) {
    if (dir === void 0) continue;
    const v = judgePackageScripts(call.manager, plan, dir, ctx);
    if (isDeny(v)) return v;
  }
  return ALLOW;
}
function judgePackageScripts(manager, plan, dir, ctx) {
  if (ctx.now() > ctx.workDeadline) return denySlow();
  if (wroteInto(ctx, resolve(dir))) return denyWriteThenRun();
  const found = findUp(dir, plan.file, ctx.pkg.read);
  if (found === null) return ALLOW;
  if (wroteInto(ctx, dirname(found.path))) return denyWriteThenRun();
  const first = parsePackage(found.path, found.read);
  if (!first.ok) return denyPackage(first.reason);
  const files = [{ path: found.path, json: first.json }];
  if (plan.workspaces) {
    const root = repoRoot(dirname(found.path), ctx.pkg.read) ?? dirname(found.path);
    const listing = ctx.pkg.list(root, plan.file);
    if (!listing.complete) {
      return deny(`this command runs a package script in every workspace, and ${root} holds more package files than the guard reads, so it was refused \u2014 run the script in one package, or the developer runs it`);
    }
    for (const path of listing.files) {
      if (resolve(path) === resolve(found.path)) continue;
      if (ctx.now() > ctx.workDeadline) return denySlow();
      const read = ctx.pkg.read(path);
      if (read.kind === "missing") continue;
      const parsed = parsePackage(path, read);
      if (!parsed.ok) return denyPackage(parsed.reason);
      files.push({ path, json: parsed.json });
    }
  }
  for (const f of files) {
    for (const name of plan.names) {
      const v = judgeScriptName(manager, f.path, f.json, name, ctx);
      if (isDeny(v)) return v;
    }
  }
  return ALLOW;
}
function judgeScriptName(manager, path, json, name, ctx) {
  const key = `${path}\0${name}`;
  if (ctx.pkg.memo.has(key)) return ctx.pkg.memo.get(key) ?? ALLOW;
  const texts = scriptTexts(manager, json, name);
  if (texts.length === 0) return ALLOW;
  ctx.pkg.memo.set(key, null);
  const v = judgeScriptTexts(texts, dirname(path), ctx);
  const verdict = isDeny(v) ? deny(`the ${basename(path)} script '${name}' that this command runs is refused (${path}): ${v.reason}`) : ALLOW;
  ctx.pkg.memo.set(key, verdict);
  return verdict;
}
function judgeScriptTexts(texts, dir, ctx) {
  for (const text of texts) {
    ctx.pkg.bytes += Buffer.byteLength(text, "utf8");
    if (ctx.pkg.bytes > MAX_COMMAND_BYTES) {
      return deny(`the command and the package scripts it runs are over ${MAX_COMMAND_BYTES / 1024} KiB together, too long to judge in time; the developer runs it`);
    }
    const unit = { wrote: /* @__PURE__ */ new Set(), wroteUnknown: false };
    const scriptCtx = { ...ctx, unit, folder: { start: dir, current: dir, stack: [] } };
    for (const variant of text.includes("^") ? [text, text.replace(/\^(.)/gs, "$1")] : [text]) {
      const v = judgeText(variant, "bash", scriptCtx);
      if (isDeny(v)) return v;
    }
  }
  return ALLOW;
}
function denyVersion(manager) {
  return deny(`\`${manager} version\` with a new version commits and tags with git, so it is refused from the terminal: add --no-git-tag-version and commit with rsct_request_commit, or the developer runs it in their own terminal`);
}
function denyPackage(reason) {
  return deny(`the package file this command runs scripts from could not be read (${reason}), so the command was refused \u2014 fix the file, or the developer runs the command`);
}
function denyWriteThenRun() {
  return deny("this command changes a package file and runs package scripts in the same go; the guard reads the scripts before anything runs, so it cannot judge the changed ones \u2014 make the change and run the scripts in separate commands");
}
function joinWords(words, dialect) {
  return words.map((w) => {
    if (w.length > 0 && !/[\s'"\\$`;&|<>(){}#]/.test(w)) return w;
    return "'" + w.replace(/'/g, "'\\''") + "'";
  }).join(" ");
}
function flagValues(rest, flag, dynamic = []) {
  const found = [];
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k];
    if (flag.separate.test(x)) found.push({ text: rest[k + 1] ?? "", dynamic: dynamic[k + 1] === true, at: k });
    else {
      const m = flag.attached.exec(x);
      if (m) found.push({ text: m[1], dynamic: /^\$(\{[^}]*\}|[A-Za-z_]\w*|[@*#?$!0-9-])$/.test(m[1]), at: k });
    }
  }
  return found;
}
function scriptIndex(rest, flag) {
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k];
    if (x === "-m") return k + 1;
    if (flag.separate.test(x) || INTERPRETER_VALUE_OPTIONS.has(x)) {
      k++;
      continue;
    }
    if (x.startsWith("-")) {
      if (flag.switches && x.length === 2 && !flag.switches.test(x)) k++;
      continue;
    }
    return k;
  }
  return rest.length;
}
function envSplitStrings(rest) {
  const found = [];
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k];
    if (ENV_SPLIT_FLAG.separate.test(x)) {
      found.push(rest[k + 1] ?? "");
      k++;
      continue;
    }
    const m = ENV_SPLIT_FLAG.attached.exec(x);
    if (m) found.push(m[1]);
    else if (/^(-[a-zA-Z0]*[uC]|--unset|--chdir)$/.test(x)) k++;
    else if (!x.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) break;
  }
  return found;
}
function judgeCode(code) {
  const m = CODE_GIT_TEXT.exec(code) ?? CODE_GIT_ARGV.exec(code);
  if (m) return denyGit(m[1].toLowerCase());
  if (CODE_GH_MERGE.test(code) || CODE_GH_ARGV.test(code)) return denyGhMerge();
  return ALLOW;
}
function denyGit(verb) {
  if (verb === "pull") {
    return deny("`git pull` from the terminal is refused unless it is fast-forward only: a pull that merges or rebases creates commits only the developer approves. Run `git pull --ff-only` or `git fetch`; if the branches diverged, ask the developer");
  }
  const tool = BLOCKED_GIT_VERBS.get(verb) ?? "the RSCT tools";
  const how = tool === "rsct_request_commit" && verb !== "commit" ? `make the change by editing the files and commit it with ${tool}` : `call ${tool} instead \u2014 it shows the developer the approval dialog`;
  return deny(`\`git ${verb}\` from the terminal is refused: ${how}. If the developer wants to run it by hand, they run it in their own terminal`);
}
function denyGhMerge() {
  return deny("`gh pr merge` from the terminal is refused: the developer merges the pull request on GitHub or in their own terminal");
}
function isAllowedForm(verb, globals, rest, restDynamic = []) {
  if (verb === "pull") return isSafePull(globals, rest, restDynamic);
  return RECOVERY_VERBS.has(verb) && rest.length > 0 && rest.every((r) => RECOVERY_FLAGS.has(r));
}
var PULL_SAFE_FLAGS = /* @__PURE__ */ new Set(["--ff-only", "-q", "--quiet", "-v", "--verbose", "--prune", "-p", "--no-rebase", "--rebase=false", "--tags", "--no-tags", "--stat", "--no-stat", "-n"]);
var PULL_CONFIG = /^(?:pull|branch|rebase)\./i;
function isSafePull(globals, rest, restDynamic) {
  for (let k = 0; k < globals.length; k++) {
    const g = globals[k];
    if (g === "-c" && PULL_CONFIG.test(globals[k + 1] ?? "")) return false;
    if (g.startsWith("-c") && g.length > 2 && PULL_CONFIG.test(g.slice(2))) return false;
  }
  if (restDynamic.some(Boolean) || !rest.includes("--ff-only")) return false;
  let positional = 0;
  for (const r of rest) {
    if (r.startsWith("-")) {
      if (!PULL_SAFE_FLAGS.has(r)) return false;
      continue;
    }
    positional += 1;
    if (positional === 1 && isLocalRepository(r)) return false;
  }
  return true;
}
function isLocalRepository(r) {
  return r === "." || r === ".." || /^\.{1,2}[\\/]/.test(r) || /^[\\/]/.test(r) || /^[A-Za-z]:/.test(r) || /^file:/i.test(r);
}
function scanGitOptions(args) {
  const aliases = {};
  let gitDir = null;
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === "-C") {
      gitDir = args[j + 1] ?? null;
      j += 2;
      continue;
    }
    if (GIT_VALUE_OPTIONS.has(a)) {
      if (a === "-c") {
        const kv = args[j + 1] ?? "";
        const m = /^alias\.([^=]+)=(.*)$/is.exec(kv);
        if (m) aliases[m[1].toLowerCase()] = m[2];
      }
      j += 2;
      continue;
    }
    if (a.startsWith("-")) {
      j++;
      continue;
    }
    break;
  }
  return { verbIndex: j, gitDir, aliases };
}
function judgeGit(args, ctx, inlineAliases, dynamic = []) {
  const flags = args.map((_, k) => dynamic[k] === true);
  const scan = scanGitOptions(args);
  const aliases = { ...inlineAliases, ...scan.aliases };
  const gitDir = scan.gitDir;
  const j = scan.verbIndex;
  const verbWord = args[j];
  if (verbWord === void 0) return ALLOW;
  if (flags[j]) {
    return deny(`a git subcommand built from a variable, a substitution or a brace or glob pattern ('${verbWord}') cannot be read, so the command was refused \u2014 write the subcommand out`);
  }
  const verb = verbWord.toLowerCase();
  const rest = args.slice(j + 1);
  if (BLOCKED_GIT_VERBS.has(verb)) {
    if (isAllowedForm(verb, args.slice(0, j), rest, flags.slice(j + 1))) return ALLOW;
    return denyGit(verb);
  }
  if (verb === "submodule" && rest[0] === "foreach") return judgeText(rest.slice(1).filter((r) => !r.startsWith("--")).join(" "), "bash", ctx);
  if (verb === "bisect" && rest[0] === "run") return judgeText(joinWords(rest.slice(1)), "bash", ctx);
  if (GIT_BUILTINS.has(verb)) return ALLOW;
  if (ctx.aliasDepth >= MAX_ALIAS_DEPTH) return deny(`the git alias '${verbWord}' expands through too many other aliases to be read; run the full git command`);
  let value = aliases[verb];
  if (value === void 0) {
    const left = ctx.deadline - ctx.now();
    if (left <= 0) return deny(`the git alias '${verbWord}' could not be resolved in time; the command was refused \u2014 run the full git command`);
    const found = ctx.resolveAlias(verbWord, gitDir, ctx.cwd, left);
    if ("error" in found) return deny(`the git alias '${verbWord}' could not be resolved (${found.error}); the command was refused \u2014 run the full git command`);
    if (!found.found) return ALLOW;
    value = found.value;
  }
  const deeper = { ...ctx, aliasDepth: ctx.aliasDepth + 1 };
  if (value.trimStart().startsWith("!")) return judgeText(value.trimStart().slice(1), "bash", deeper);
  const expanded = wordsOf(lex(value, "bash").tokens).map((w) => w.value);
  return judgeGit([...args.slice(0, j), ...expanded, ...rest], deeper, aliases, [...flags.slice(0, j), ...expanded.map(() => false), ...flags.slice(j + 1)]);
}
function judgeGh(args, dynamic = []) {
  const flags = args.map((_, k) => dynamic[k] === true);
  const positional = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (GH_VALUE_OPTIONS.has(a)) {
      j++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (flags[j] && (positional.length === 0 || positional[0] === "pr")) {
      return deny(`a gh subcommand built from a variable, a substitution or a brace or glob pattern ('${a}') cannot be read, so the command was refused \u2014 write the subcommand out`);
    }
    positional.push(a.toLowerCase());
    if (positional.length === 2) {
      if (positional[0] === "alias" && positional[1] === "set") {
        const definition = args.slice(j + 1).join(" ");
        if (/\bpr\s+merge\b/i.test(definition) || CODE_GIT_TEXT.test(definition)) {
          return deny("a gh alias that runs `gh pr merge` or a refused git verb is refused: the developer merges the pull request on GitHub or in their own terminal");
        }
      }
      break;
    }
  }
  if (positional[0] === "pr" && positional[1] === "merge") return denyGhMerge();
  return ALLOW;
}
function judgeShellRunner(args, bodies, ctx) {
  let command = false;
  let stdin = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a.startsWith("--command=")) return judgeText(a.slice("--command=".length), "bash", ctx);
    if (a === "--command") {
      command = true;
      continue;
    }
    if (a === "--rcfile" || a === "--init-file") {
      j++;
      continue;
    }
    if (/^[-+][a-zA-Z]+$/.test(a)) {
      if (a.startsWith("-") && a.includes("c")) command = true;
      if (a.startsWith("-") && a.includes("s")) stdin = true;
      if (/[oO]/.test(a)) j++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (command) return judgeText(a, "bash", ctx);
    if (stdin || STDIN_SCRIPTS.has(a)) break;
    return ALLOW;
  }
  for (const b of bodies) {
    const v = judgeText(b, "bash", ctx);
    if (isDeny(v)) return v;
  }
  return ALLOW;
}
function takesPowerShellValue(arg) {
  if (!arg.startsWith("-")) return false;
  const name = arg.slice(1);
  if (POWERSHELL_VALUE_ALIASES.has(name)) return true;
  return name.length >= 3 && POWERSHELL_VALUE_OPTIONS.some((o) => o.startsWith(name));
}
function judgePowerShellRunner(args, dynamic, bodies, ctx, bareIsCommand) {
  const command = (from) => dynamic.slice(from).some(Boolean) ? deny("a PowerShell command built from a variable cannot be read, so the command was refused \u2014 write the command out") : judgeText(args.slice(from).join(" "), "powershell", ctx);
  for (let j = 0; j < args.length; j++) {
    const a = args[j].toLowerCase();
    if (a.length >= 2 && "-command".startsWith(a)) return command(j + 1);
    if (a.length >= 2 && ("-encodedcommand".startsWith(a) || a === "-ec" || a === "-enc")) {
      let decoded = "";
      try {
        decoded = Buffer.from(args[j + 1] ?? "", "base64").toString("utf16le");
      } catch {
        return deny("an encoded PowerShell command could not be decoded, so it was refused");
      }
      return judgeText(decoded, "powershell", ctx);
    }
    if (a === "-file" || a === "-f") break;
    if (takesPowerShellValue(a)) {
      j++;
      continue;
    }
    if (bareIsCommand && !a.startsWith("-")) return command(j);
  }
  for (const b of bodies) {
    const v = judgeText(b, "powershell", ctx);
    if (isDeny(v)) return v;
  }
  return ALLOW;
}
function judgeCmdRunner(args, ctx) {
  const at = args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
  if (at === -1) return ALLOW;
  return judgeText(args.slice(at + 1).join(" "), "bash", ctx);
}
function remoteCtx(ctx) {
  return { ...ctx, folder: { start: void 0, current: void 0, stack: [] } };
}
function judgeWslRunner(args, ctx) {
  let j = 0;
  let cwdChanged = false;
  while (j < args.length) {
    const a = args[j];
    const inner = cwdChanged ? remoteCtx(ctx) : ctx;
    if (a === "-e" || a === "--exec") return judgeText(joinWords(args.slice(j + 1)), "bash", inner);
    if (a === "--") return judgeText(args.slice(j + 1).join(" "), "bash", inner);
    if (WSL_VALUE_OPTIONS.has(a)) {
      if (a === "--cd") cwdChanged = true;
      j += 2;
      continue;
    }
    if (a.startsWith("-")) {
      j++;
      continue;
    }
    return judgeText(args.slice(j).join(" "), "bash", inner);
  }
  return ALLOW;
}
function judgeSshRunner(args, ctx) {
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (SSH_VALUE_OPTIONS.has(a)) {
      j += 2;
      continue;
    }
    if (a.startsWith("-")) {
      j++;
      continue;
    }
    return judgeText(args.slice(j + 1).join(" "), "bash", remoteCtx(ctx));
  }
  return ALLOW;
}
function denyHooksOff() {
  return deny("a command that mentions disableAllHooks is refused: switching Claude Code hooks off is the developer's own edit");
}
function defaultAliasResolver(name, gitDir, cwd, timeoutMs) {
  const args = [...gitDir ? ["-C", gitDir] : [], "config", "--get", `alias.${name}`];
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: Math.max(1, Math.floor(timeoutMs)),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (r.error) return { error: r.error.message };
  if (r.status === 0) return { found: true, value: (r.stdout ?? "").trim() };
  if (r.status === 1) return { found: false };
  return { error: `git config exited ${r.status ?? r.signal}` };
}
function judgeCommand(text, options = {}) {
  if (Buffer.byteLength(text, "utf8") > MAX_COMMAND_BYTES) {
    return deny(`a command over ${MAX_COMMAND_BYTES / 1024} KiB is refused: the guard cannot judge it in time. Write long text to a file with the Write tool and run a short command`);
  }
  const now = options.now ?? Date.now;
  const start = now();
  const ctx = {
    depth: 0,
    aliasDepth: 0,
    cwd: options.cwd,
    resolveAlias: options.resolveAlias ?? defaultAliasResolver,
    deadline: start + (options.aliasBudgetMs ?? DEFAULT_ALIAS_BUDGET_MS),
    workDeadline: start + (options.workBudgetMs ?? WORK_BUDGET_MS),
    now,
    folder: { start: options.cwd, current: options.cwd, stack: [] },
    unit: { wrote: /* @__PURE__ */ new Set(), wroteUnknown: false },
    pkg: {
      read: options.readPackage ?? defaultPackageReader,
      list: options.listPackages ?? defaultPackageLister,
      memo: /* @__PURE__ */ new Map(),
      bytes: Buffer.byteLength(text, "utf8")
    },
    database: options.database ?? false,
    databaseTestGuard: options.databaseTestGuard ?? true
  };
  return judgeText(text, options.dialect ?? "bash", ctx);
}
function denySlow() {
  return deny("the guard could not finish judging this command in time, so it was refused. Split it into shorter commands");
}

// src/lib/terminal-guard-hook.ts
var TERMINAL_TOOLS = /* @__PURE__ */ new Map([
  ["Bash", "bash"],
  ["Monitor", "bash"],
  ["PowerShell", "powershell"]
]);
var PREFIX = "[rsct] Terminal command blocked";
function refuse2(reason) {
  return { exitCode: 2, message: `${PREFIX}: ${reason}.` };
}
function decideTerminal(rawStdin, env, cwd, judge = {}) {
  try {
    let payload;
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      return refuse2("the guard could not read the tool call it was given, so nothing ran");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return refuse2("the guard could not read the tool call it was given, so nothing ran");
    }
    const p = payload;
    if (typeof p.tool_name !== "string") return refuse2("the tool call names no tool, so nothing ran");
    const dialect = TERMINAL_TOOLS.get(p.tool_name);
    if (dialect === void 0) return { exitCode: 0, message: null };
    const input = p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
    const command = input.command;
    if (typeof command !== "string") {
      if (p.tool_name === "Monitor" && input.ws !== void 0) return { exitCode: 0, message: null };
      return refuse2(`the ${p.tool_name} call carries no command text the guard can read, so nothing ran`);
    }
    const callCwd = typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : env.CLAUDE_PROJECT_DIR ?? cwd;
    const switches = readDatabaseSwitches(env.CLAUDE_PROJECT_DIR ?? callCwd);
    const verdict = judgeCommand(command, {
      ...judge,
      dialect,
      cwd: callCwd,
      database: switches.database,
      databaseTestGuard: switches.test
    });
    if (verdict.verdict === "allow") return { exitCode: 0, message: null };
    return refuse2(verdict.reason);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 2,
      message: `${PREFIX}: the terminal guard failed (${why}), so nothing ran. STOP and tell the developer: they can run the command in their own terminal. If every command is refused, they repair the guard: in their own editor, remove the entry that runs terminal-guard.js from .claude/settings.json or .claude/settings.local.json, then run /rsct-setup again.`
    };
  }
}

// src/scripts/terminal-guard.ts
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
var decision = decideTerminal(readStdin(), process.env, process.cwd());
if (decision.message) process.stderr.write(`${decision.message}
`);
process.exit(decision.exitCode);
//# sourceMappingURL=terminal-guard.js.map
//# sourceMappingURL=terminal-guard.js.map