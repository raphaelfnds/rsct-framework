#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { z } from 'zod';
import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join, resolve, dirname, isAbsolute, relative, basename } from 'path';
import { cwd } from 'process';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

// src/lib/audit-log.ts
var DEFAULT_RELATIVE_PATH = ".rsct/audit.log";
function resolveAuditPath(projectRoot, config) {
  const configured = config?.path;
  if (configured && configured.length > 0) {
    return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
  }
  return join(projectRoot, DEFAULT_RELATIVE_PATH);
}
function appendAuditEntry(projectRoot, entry, config) {
  if (config?.enabled === false) {
    return { ok: false, reason: "disabled" };
  }
  const path = resolveAuditPath(projectRoot, config);
  try {
    ensureParentDir(path);
    const stamped = { ...entry, ts: (/* @__PURE__ */ new Date()).toISOString() };
    const line = `${JSON.stringify(stamped)}
`;
    appendFileSync(path, line, { encoding: "utf8" });
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      reason: "write_failed",
      path,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// src/lib/project-root.ts
var TRUST_ALLOWED_TOOL_NAMES = [
  "rsct_request_commit",
  "rsct_request_push",
  "rsct_request_merge",
  "rsct_phase_verification_complete",
  "rsct_phase_research_complete",
  "rsct_phase_spec_complete",
  "rsct_phase_code_complete",
  "rsct_phase_test_complete",
  "rsct_phase_abandon",
  "rsct_capture_issue"
];
var RsctApprovalModesSchema = z.object({
  timestamp_skew_seconds: z.number().int().min(60).max(600).optional(),
  fabrication_signal_threshold_ms: z.number().int().min(100).max(5e3).optional(),
  trust_allowed_for: z.array(z.enum(TRUST_ALLOWED_TOOL_NAMES)).optional()
}).strict();
var RsctAuditConfigSchema = z.object({
  // `false` is the documented bypass vector — schema literal blocks it.
  // Absent or `true` are equivalent (audit defaults on).
  enabled: z.literal(true).optional(),
  path: z.string().min(1).optional()
}).strict();
var RsctConfigSchema = z.object({
  rsct_version: z.string().min(1),
  app: z.object({
    name: z.string().min(1),
    org: z.string().min(1)
  }),
  universe: z.object({
    name: z.string().min(1).optional(),
    local: z.string().min(1).optional(),
    remote: z.string().min(1).optional()
  }).optional(),
  // `.min(1)`: empty array disables the default protection wholesale and
  // is the HIGH-4 vector. If a project genuinely wants zero protected
  // branches, it should uninstall `.rsct.json`.
  protected_branches: z.array(z.string().min(1)).min(1).optional(),
  test_framework: z.string().optional(),
  install: z.object({
    applied_at: z.string().optional(),
    mode: z.string().optional(),
    setup_commit_sha_before: z.string().optional(),
    canonical_source_added: z.boolean().optional()
  }).optional(),
  mcp: z.object({
    server: z.string().optional(),
    version: z.string().optional(),
    registered_at: z.string().optional()
  }).optional(),
  approval_modes: RsctApprovalModesSchema.optional(),
  audit: RsctAuditConfigSchema.optional(),
  protected_patterns_extra: z.array(z.string().min(1)).optional(),
  secrets_extra_patterns: z.array(z.string().min(1)).optional()
}).strip();
function resolveProjectRoot(explicitRoot) {
  const direct = sanitizeRoot(explicitRoot, "project_root argument") ?? sanitizeRoot(readLaunchOverride(), "launch override (--project-root / RSCT_PROJECT_ROOT)");
  if (direct) return buildResolution(direct);
  const claudeDir = sanitizeRoot(process.env.CLAUDE_PROJECT_DIR, "CLAUDE_PROJECT_DIR");
  const startDir = claudeDir ?? resolve(cwd());
  if (claudeDir) {
    warnOnce(
      "CLAUDE_PROJECT_DIR:used",
      `resolving project root from CLAUDE_PROJECT_DIR ("${claudeDir}"). Pass an explicit project_root if this is wrong.`
    );
  }
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".rsct.json"))) {
      return buildResolution(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return buildResolution(startDir);
    }
    dir = parent;
  }
}
function buildResolution(root) {
  const config = readRsctConfig(root);
  return { root, rsct_installed: config !== null, config };
}
var PLACEHOLDER_RE = /\$\{[^}]*\}/;
var warnedSources = /* @__PURE__ */ new Set();
function warnOnce(key, message) {
  if (warnedSources.has(key)) return;
  warnedSources.add(key);
  process.stderr.write(`[rsct] ${message}
`);
}
function sanitizeRoot(value, sourceLabel) {
  if (!value || value.trim().length === 0) return void 0;
  if (PLACEHOLDER_RE.test(value)) {
    warnOnce(
      `${sourceLabel}:placeholder`,
      `${sourceLabel} contains an unsubstituted placeholder ("${value}") \u2014 ignoring it. Fix the MCP launch config (e.g. .mcp.json): use "args": [] and let the server auto-detect, or pass a real absolute path.`
    );
    return void 0;
  }
  if (!isAbsolute(value)) {
    warnOnce(
      `${sourceLabel}:relative`,
      `${sourceLabel} is a relative path ("${value}") \u2014 ignoring it; an absolute path is required (a relative path would resolve against the server cwd, e.g. C:\\Windows on WSL).`
    );
    return void 0;
  }
  return value;
}
function readLaunchOverride() {
  const envRoot = process.env.RSCT_PROJECT_ROOT;
  if (envRoot && envRoot.length > 0) return envRoot;
  const idx = process.argv.indexOf("--project-root");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return void 0;
}
function readRsctConfig(projectRoot) {
  const path = join(projectRoot, ".rsct.json");
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    emitConfigViolation(projectRoot, "malformed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
  const validation = RsctConfigSchema.safeParse(parsed);
  if (!validation.success) {
    emitConfigViolation(projectRoot, "bounds_violation", {
      validation_errors: validation.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        code: issue.code,
        message: issue.message
      }))
    });
    return null;
  }
  return validation.data;
}
function emitConfigViolation(projectRoot, reason, extras) {
  const event = reason === "malformed" ? "rsct_json.malformed" : "rsct_json.bounds_violation";
  process.stderr.write(
    `[rsct] .rsct.json rejected (${reason}); falling back to rsct_installed=false. See audit log for details.
`
  );
  appendAuditEntry(projectRoot, { event, reason, ...extras }, { enabled: true });
}
function readGitState(projectRoot) {
  if (!isGitRepo(projectRoot)) {
    return { available: false, branch: null, head_sha: null, is_clean: null };
  }
  const branch = safeGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head_sha = safeGit(projectRoot, ["rev-parse", "--short", "HEAD"]);
  const status = safeGit(projectRoot, ["status", "--porcelain"]);
  return {
    available: true,
    branch,
    head_sha,
    is_clean: status !== null ? status.length === 0 : null
  };
}
function getStagedDiff(projectRoot) {
  if (!isGitRepo(projectRoot)) return null;
  return safeGitRaw(projectRoot, ["diff", "--cached", "--no-color", "-U0"]);
}
function getUnstagedDiff(projectRoot) {
  if (!isGitRepo(projectRoot)) return null;
  return safeGitRaw(projectRoot, ["diff", "--no-color", "-U0"]);
}
function isGitRepo(projectRoot) {
  const out = safeGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  return out === "true";
}
function safeGit(cwd2, args) {
  const raw = safeGitRaw(cwd2, args);
  return raw !== null ? raw.trim() : null;
}
function safeGitRaw(cwd2, args) {
  try {
    return execFileSync("git", args, {
      cwd: cwd2,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    return null;
  }
}
var defaultGitExecutor = (cwd2, args) => {
  try {
    const stdout = execFileSync("git", args, {
      cwd: cwd2,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return normalizeGitExecError(err);
  }
};
function normalizeGitExecError(err) {
  if (err && typeof err === "object") {
    const e = err;
    const result = {
      ok: false,
      stdout: bufferOrStringToString(e.stdout),
      stderr: bufferOrStringToString(e.stderr),
      exitCode: typeof e.status === "number" ? e.status : -1
    };
    const message = e.message ?? (e.code ? `git exec failed: ${e.code}` : void 0);
    if (message) result.error = message;
    return result;
  }
  return { ok: false, stdout: "", stderr: "", exitCode: -1, error: String(err) };
}
function bufferOrStringToString(v) {
  if (v === void 0) return "";
  if (typeof v === "string") return v;
  return v.toString("utf8");
}
function getHeadSha(projectRoot, executor = defaultGitExecutor) {
  const r = executor(projectRoot, ["rev-parse", "--short", "HEAD"]);
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}
function gitCommit(projectRoot, message, executor = defaultGitExecutor) {
  const sha_before = getHeadSha(projectRoot, executor);
  const exec = executor(projectRoot, ["commit", "-m", message]);
  if (!exec.ok) {
    const result = { ok: false, sha_before, sha_after: null };
    if (exec.stderr) result.stderr = exec.stderr.trim();
    if (exec.error) result.error = exec.error;
    return result;
  }
  const sha_after = getHeadSha(projectRoot, executor);
  return { ok: true, sha_before, sha_after };
}
function gitPush(projectRoot, remote, branch, executor = defaultGitExecutor) {
  const exec = executor(projectRoot, ["push", remote, branch]);
  if (!exec.ok) {
    const result = { ok: false };
    if (exec.stderr) result.stderr = exec.stderr.trim();
    if (exec.error) result.error = exec.error;
    if (exec.stdout) result.stdout = exec.stdout.trim();
    return result;
  }
  return { ok: true, stdout: exec.stdout.trim() };
}
function gitMerge(projectRoot, sourceBranch, options, executor = defaultGitExecutor) {
  const args = ["merge"];
  if (options.no_ff) args.push("--no-ff");
  if (options.allow_unrelated_histories) args.push("--allow-unrelated-histories");
  args.push(sourceBranch);
  const sha_before = getHeadSha(projectRoot, executor);
  const exec = executor(projectRoot, args);
  if (!exec.ok) {
    const result = { ok: false, sha_before, sha_after: null };
    if (exec.stderr) result.stderr = exec.stderr.trim();
    if (exec.stdout) result.stdout = exec.stdout.trim();
    if (exec.error) result.error = exec.error;
    return result;
  }
  const sha_after = getHeadSha(projectRoot, executor);
  return { ok: true, sha_before, sha_after, stdout: exec.stdout.trim() };
}
var SESSION_ID = randomUUID();
var LOCK_RELATIVE_PATH = ".rsct/phase-state.lock";
var LOCK_STALE_MS = 3e4;
function phaseStateLockPath(projectRoot) {
  return join(projectRoot, LOCK_RELATIVE_PATH);
}
function tryAcquireLock(lockPath, now) {
  const content = {
    session_id: SESSION_ID,
    locked_at: now.toISOString()
  };
  const json = JSON.stringify(content);
  try {
    ensureParentDir(lockPath);
    writeFileSync(lockPath, json, { encoding: "utf8", flag: "wx" });
    return { ok: true };
  } catch (err) {
    const code = err?.code;
    if (code !== "EEXIST") {
      return {
        ok: false,
        reason: "error",
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
  let existing = null;
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      existing = parsed;
    }
  } catch {
  }
  const lockedAtMs = existing?.locked_at ? new Date(existing.locked_at).getTime() : 0;
  const ageMs = Math.max(0, now.getTime() - lockedAtMs);
  if (ageMs >= LOCK_STALE_MS || Number.isNaN(lockedAtMs)) {
    try {
      writeFileSync(lockPath, json, { encoding: "utf8", flag: "w" });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
  return {
    ok: false,
    reason: "locked",
    lock_age_ms: ageMs,
    held_by_session: existing?.session_id ?? null
  };
}
function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
  }
}
var PHASE_STATE_RELATIVE = ".rsct/phase-state.json";
function phaseStatePath(projectRoot) {
  return join(projectRoot, PHASE_STATE_RELATIVE);
}
function writePhaseState(projectRoot, state) {
  const path = phaseStatePath(projectRoot);
  const lockPath = phaseStateLockPath(projectRoot);
  const now = /* @__PURE__ */ new Date();
  const acquired = tryAcquireLock(lockPath, now);
  if (!acquired.ok) {
    if (acquired.reason === "locked") {
      return {
        ok: false,
        path,
        reason: "locked",
        lock_age_ms: acquired.lock_age_ms,
        held_by_session: acquired.held_by_session
      };
    }
    return {
      ok: false,
      path,
      reason: "write_failed",
      error: `lock acquisition failed: ${acquired.error}`
    };
  }
  try {
    ensureParentDir(path);
    writeFileSync(path, `${JSON.stringify(state, null, 2)}
`, "utf8");
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      path,
      reason: "write_failed",
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    releaseLock(lockPath);
  }
}
function readPhaseState(projectRoot) {
  const path = phaseStatePath(projectRoot);
  if (!existsSync(path)) {
    return { exists: false, state: null };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { exists: true, state: null, parse_error: "top-level value is not an object" };
    }
    return { exists: true, state: parsed };
  } catch (err) {
    return {
      exists: true,
      state: null,
      parse_error: err instanceof Error ? err.message : String(err)
    };
  }
}
function globToRegex(glob) {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  out += "$";
  return new RegExp(out);
}
function matchesAnyGlob(path, globs) {
  const normalized = path.replace(/\\/g, "/");
  for (const glob of globs) {
    const re = globToRegex(glob.replace(/\\/g, "/"));
    if (re.test(normalized)) return { matched: true, matched_glob: glob };
  }
  return { matched: false };
}
var TIER_RANK = {
  trivial: 0,
  small: 1,
  standard: 2,
  complex: 3
};
function tierRank(tier) {
  if (!tier) return 0;
  return TIER_RANK[tier] ?? 0;
}
var BOOTSTRAP_STALE_MS = 4 * 60 * 60 * 1e3;
function stampBootstrapMarker(projectRoot, now = /* @__PURE__ */ new Date()) {
  const existing = readPhaseState(projectRoot);
  const baseState = existing.state ?? {};
  const newState = {
    ...baseState,
    bootstrap_at: now.toISOString()
  };
  return writePhaseState(projectRoot, newState);
}
function evaluateBootstrapMarker(args) {
  const now = (args.now ?? /* @__PURE__ */ new Date()).getTime();
  const stateRead = readPhaseState(args.projectRoot);
  const stamped = stateRead.state?.bootstrap_at;
  if (!stamped) {
    return {
      status: "missing",
      bootstrap_at: null,
      age_ms: null,
      hint: `\u26A0 bootstrap not detected (no rsct_status / rsct_load_context call recorded in this project's phase-state). CLAUDE.md \xA70 mandates \xA70 bootstrap at session start \u2014 run rsct_status and rsct_load_context first.`
    };
  }
  const stampedMs = new Date(stamped).getTime();
  if (Number.isNaN(stampedMs)) {
    return {
      status: "missing",
      bootstrap_at: stamped,
      age_ms: null,
      hint: `\u26A0 bootstrap_at value '${stamped}' is unparseable. Re-run rsct_status to restamp.`
    };
  }
  const age = Math.max(0, now - stampedMs);
  if (age > BOOTSTRAP_STALE_MS) {
    return {
      status: "stale",
      bootstrap_at: stamped,
      age_ms: age,
      hint: `\u26A0 bootstrap_at is ${Math.round(age / 6e4)} min old (stale window=${Math.round(BOOTSTRAP_STALE_MS / 6e4)} min). Recommend re-running rsct_status + rsct_load_context to refresh session context.`
    };
  }
  return {
    status: "fresh",
    bootstrap_at: stamped,
    age_ms: age,
    hint: null
  };
}
function stampClassifyVerdict(projectRoot, args) {
  const existing = readPhaseState(projectRoot);
  const baseState = existing.state ?? {};
  const prevMaxRank = tierRank(baseState.last_classify?.tier_max);
  const currentRank = tierRank(args.tier);
  const tier_max = currentRank > prevMaxRank ? args.tier : baseState.last_classify?.tier_max ?? args.tier;
  const now = (args.now ?? /* @__PURE__ */ new Date()).toISOString();
  const block = {
    tier: args.tier,
    tier_max,
    classified_at: now
  };
  if (args.signalsSummary !== void 0) {
    block.signals_summary = args.signalsSummary;
  }
  const newState = {
    ...baseState,
    last_classify: block
  };
  return writePhaseState(projectRoot, newState);
}

// src/lib/version.ts
var RSCT_MCP_VERSION = "1.0.0";

// src/tools/status.ts
var statusInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection.")
}).strict();
var statusTool = {
  name: "rsct_status",
  description: "Bootstrap check: returns whether the current project is rsct-managed (has .rsct.json), the project identity, protected branches, current git branch, and one-line hints for Claude. Always succeeds \u2014 degrades gracefully when not in an rsct project. Call this near the start of any session in an unfamiliar project.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      }
    },
    additionalProperties: false
  }
};
var MCP_VERSION = RSCT_MCP_VERSION;
async function statusHandler(rawInput) {
  const input = statusInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const git = readGitState(resolution.root);
  if (resolution.rsct_installed) {
    stampBootstrapMarker(resolution.root);
  }
  const hints = buildStatusHints(resolution, git);
  return {
    mcp_server: { name: "rsct-mcp", version: MCP_VERSION },
    rsct_installed: resolution.rsct_installed,
    project: {
      root: resolution.root,
      app_name: resolution.config?.app?.name ?? null,
      org_slug: resolution.config?.app?.org ?? null,
      rsct_version: resolution.config?.rsct_version ?? null,
      protected_branches: resolution.config?.protected_branches ?? [],
      test_framework: resolution.config?.test_framework ?? null
    },
    git,
    hints
  };
}
function buildStatusHints(resolution, git) {
  const hints = [];
  if (!resolution.rsct_installed) {
    hints.push(
      "No .rsct.json found in this project \u2014 rsct-mcp tools are available but project-level governance is not configured. Suggest running /rsct-setup to initialize."
    );
    return hints;
  }
  const protected_branches = resolution.config?.protected_branches ?? [];
  if (git.available && git.branch && protected_branches.includes(git.branch)) {
    hints.push(
      `Current branch '${git.branch}' is in protected_branches. \xA7D requires a derived branch (feat/, fix/, chore/, docs/) for any mutating work \u2014 confirm with dev before proposing changes.`
    );
  }
  if (git.available && git.is_clean === false) {
    hints.push(
      "Working tree has uncommitted changes \u2014 surface them in the next plan/spec phase so they are not lost."
    );
  }
  if (!resolution.config?.test_framework) {
    hints.push(
      "No test_framework recorded in .rsct.json \u2014 \xA7G testing strategy will need explicit dev input until detected."
    );
  }
  return hints;
}
function findActivePlan(projectRoot) {
  let entries;
  try {
    entries = readdirSync(projectRoot);
  } catch {
    return null;
  }
  const candidates = entries.filter((name) => /^(?:plan|spec)_.+\.md$/.test(name)).map((name) => {
    const path = join(projectRoot, name);
    const slug = name.replace(/^(?:plan|spec)_/, "").replace(/\.md$/, "");
    const mtime = safeMtime(path);
    return { name, path, slug, mtime };
  }).filter((entry) => entry.mtime !== null).sort((a, b) => b.mtime - a.mtime);
  const winner = candidates[0];
  if (!winner) return null;
  const metadata = extractPlanMetadata(winner.path);
  const progress_path = join(projectRoot, `progress_${winner.slug}.md`);
  const progress_exists = safeMtime(progress_path) !== null;
  return {
    slug: winner.slug,
    plan_path: winner.path,
    progress_path: progress_exists ? progress_path : null,
    status: metadata.status,
    branch: metadata.branch,
    created: metadata.created
  };
}
function isPlanComplete(status) {
  if (!status) return false;
  return /\b(complete|done|closed|shipped|finished|conclu[ií])/i.test(status);
}
function safeMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
function extractPlanMetadata(path) {
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { status: null, branch: null, created: null };
  }
  const head = body.split("\n").slice(0, 60).join("\n");
  return {
    status: extractTableField(head, "Status"),
    branch: extractTableField(head, "Branch"),
    created: extractTableField(head, "Created")
  };
}
function extractTableField(text, field) {
  const regex = new RegExp(`\\|\\s*${field}\\s*\\|\\s*([^|]+?)\\s*\\|`, "i");
  const match = text.match(regex);
  if (!match || !match[1]) return null;
  return match[1].trim().replace(/`/g, "");
}
var DECISION_STATUSES = [
  "active",
  "superseded",
  "deprecated"
];
function readDecisions(projectRoot) {
  const path = join(projectRoot, "documentation", "decisions.md");
  if (!existsSync(path)) {
    return { exists: false, path: null, premises: [], adrs: [] };
  }
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { exists: true, path, premises: [], adrs: [] };
  }
  const { premises, adrs } = extractDecisions(body);
  return { exists: true, path, premises, adrs };
}
var PREMISE_HEADING = /^###\s+#(\d+)\s+[—-]\s+(.+?)\s*$/;
var ADR_HEADING = /^###\s+(ADR-\d+)\s+[—-]\s+(.+?)\s*$/;
function extractDecisions(body) {
  const lines = body.split("\n");
  const premises = [];
  const adrs = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const entry = buildEntry(
      current.kind,
      current.id,
      current.title,
      current.bodyLines.join("\n")
    );
    if (current.kind === "premise") premises.push(entry);
    else adrs.push(entry);
    current = null;
  };
  for (const line of lines) {
    const premiseMatch = line.match(PREMISE_HEADING);
    if (premiseMatch?.[1] && premiseMatch[2]) {
      flush();
      current = {
        kind: "premise",
        id: `#${premiseMatch[1]}`,
        title: premiseMatch[2].trim(),
        bodyLines: []
      };
      continue;
    }
    const adrMatch = line.match(ADR_HEADING);
    if (adrMatch?.[1] && adrMatch[2]) {
      flush();
      current = {
        kind: "adr",
        id: adrMatch[1],
        title: adrMatch[2].trim(),
        bodyLines: []
      };
      continue;
    }
    if (current && (/^##\s/.test(line) || /^###\s/.test(line) || /^---\s*$/.test(line))) {
      flush();
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  flush();
  return { premises, adrs };
}
function buildEntry(kind, id, title, section) {
  const meta = extractMeta(section);
  const entry = {
    kind,
    id,
    title,
    excerpt: extractExcerpt(section)
  };
  if (meta.status) entry.status = meta.status;
  if (meta.tags && meta.tags.length > 0) entry.tags = meta.tags;
  return entry;
}
var META_LINE_REGEX = /^\s*\*\*(Status|Tags)\*\*\s*:/i;
function extractMeta(section) {
  const out = {};
  const statusMatch = section.match(/^\s*\*\*Status\*\*\s*:\s*([A-Za-z]+)\s*$/im);
  if (statusMatch?.[1]) {
    const value = statusMatch[1].toLowerCase();
    if (DECISION_STATUSES.includes(value)) {
      out.status = value;
    }
  }
  const tagsMatch = section.match(/^\s*\*\*Tags\*\*\s*:\s*(.+?)\s*$/im);
  if (tagsMatch?.[1]) {
    const tags = tagsMatch[1].split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    if (tags.length > 0) out.tags = tags;
  }
  return out;
}
function extractExcerpt(section) {
  const lines = section.split("\n").map((line) => line.trim()).filter(
    (line) => line.length > 0 && !line.startsWith("<!--") && !META_LINE_REGEX.test(line)
  );
  const first = lines.slice(0, 3).join(" ");
  return first.length > 280 ? `${first.slice(0, 277)}...` : first;
}

// src/lib/markdown.ts
function parseSections(body) {
  const lines = body.split("\n");
  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const sectionBody = current.bodyLines.join("\n").trim();
    out.push({
      level: current.level,
      heading: current.heading,
      body: sectionBody,
      excerpt: makeExcerpt(sectionBody)
    });
  };
  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (headingMatch?.[1] && headingMatch[2]) {
      flush();
      current = {
        level: headingMatch[1].length,
        heading: headingMatch[2].trim(),
        bodyLines: []
      };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  flush();
  return out;
}
function makeExcerpt(body) {
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("<!--"));
  const first = lines.slice(0, 3).join(" ");
  return first.length > 280 ? `${first.slice(0, 277)}...` : first;
}

// src/lib/knowledge.ts
var KNOWN_CATEGORIES = [
  "business-glossary",
  "business-rules",
  "anti-decisions",
  "incident-log",
  "stakeholder-map",
  "team-capabilities",
  "vendor-relationships",
  "cost-constraints",
  "workflow-rituals",
  "domain-edge-cases"
];
function readKnowledgeIndex(projectRoot) {
  const dir = join(projectRoot, "documentation", "knowledge");
  if (!existsSync(dir)) {
    return {
      directory_exists: false,
      directory_path: null,
      categories_present: [],
      categories_missing: [...KNOWN_CATEGORIES],
      has_readme: false
    };
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return {
      directory_exists: true,
      directory_path: dir,
      categories_present: [],
      categories_missing: [...KNOWN_CATEGORIES],
      has_readme: false
    };
  }
  const mdFiles = entries.filter((name) => name.endsWith(".md")).map((name) => name.replace(/\.md$/, ""));
  const present = mdFiles.filter((name) => name !== "README");
  const missing = KNOWN_CATEGORIES.filter((cat) => !present.includes(cat));
  return {
    directory_exists: true,
    directory_path: dir,
    categories_present: present,
    categories_missing: missing,
    has_readme: mdFiles.includes("README")
  };
}
function readKnowledgeFile(projectRoot, category) {
  const path = join(projectRoot, "documentation", "knowledge", `${category}.md`);
  if (!existsSync(path)) {
    return { exists: false, path: null, sections: [] };
  }
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { exists: true, path, sections: [] };
  }
  return { exists: true, path, sections: parseSections(body) };
}

// src/tools/load-context.ts
var loadContextInputSchema = z.object({
  project_root: z.string().optional(),
  decisions_excerpt_count: z.number().int().min(0).max(20).default(3).describe("How many recent firm-premise and ADR excerpts to include (default 3 each).")
}).strict();
var loadContextTool = {
  name: "rsct_load_context",
  description: "Session-bootstrap call \u2014 returns a structured snapshot of the project's current rsct state: identity, git, active plan (slug/status/branch), decisions summary, available knowledge categories, and contextual hints. Call this at the start of any non-trivial conversation in an rsct project before formulating a plan. Always succeeds \u2014 degrades gracefully when not in an rsct project.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      decisions_excerpt_count: {
        type: "number",
        description: "How many recent firm-premise and ADR excerpts to include (default 3 each, max 20).",
        minimum: 0,
        maximum: 20,
        default: 3
      }
    },
    additionalProperties: false
  }
};
var MCP_VERSION2 = RSCT_MCP_VERSION;
function buildActivePhase(projectRoot) {
  const read = readPhaseState(projectRoot);
  if (!read.exists || !read.state) return null;
  const state = read.state;
  if (!state.phase) return null;
  let verification = null;
  if (state.verification) {
    const findings = state.verification.findings;
    const findings_count = Array.isArray(findings) ? findings.length : 0;
    verification = {
      spec_ref: state.verification.spec_ref ?? null,
      spec_tier: state.verification.spec_tier ?? null,
      findings_count,
      started_at: state.verification.started_at ?? null
    };
  }
  return {
    phase: state.phase,
    spec_slug: state.spec_slug ?? null,
    started_at: state.started_at ?? null,
    scope_globs: state.scope_globs ?? [],
    verification
  };
}
async function loadContextHandler(rawInput) {
  const input = loadContextInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const git = readGitState(resolution.root);
  const active_plan = findActivePlan(resolution.root);
  const active_phase = buildActivePhase(resolution.root);
  const decisionsSnapshot = readDecisions(resolution.root);
  const knowledge = readKnowledgeIndex(resolution.root);
  if (resolution.rsct_installed) {
    stampBootstrapMarker(resolution.root);
  }
  const excerptCount = input.decisions_excerpt_count;
  const recent_premises = decisionsSnapshot.premises.slice(-excerptCount).reverse();
  const recent_adrs = decisionsSnapshot.adrs.slice(-excerptCount).reverse();
  return {
    mcp_server: { name: "rsct-mcp", version: MCP_VERSION2 },
    rsct_installed: resolution.rsct_installed,
    project: {
      root: resolution.root,
      app_name: resolution.config?.app?.name ?? null,
      org_slug: resolution.config?.app?.org ?? null,
      rsct_version: resolution.config?.rsct_version ?? null,
      protected_branches: resolution.config?.protected_branches ?? [],
      test_framework: resolution.config?.test_framework ?? null
    },
    git,
    active_plan,
    active_phase,
    decisions: {
      file_exists: decisionsSnapshot.exists,
      premises_count: decisionsSnapshot.premises.length,
      adrs_count: decisionsSnapshot.adrs.length,
      recent_premises,
      recent_adrs
    },
    knowledge,
    next_action_hints: buildHints({ resolution, git, active_plan, active_phase, knowledge })
  };
}
function buildHints({ resolution, git, active_plan, active_phase, knowledge }) {
  const hints = [];
  if (!resolution.rsct_installed) {
    hints.push(
      "Project is not rsct-managed yet \u2014 recommend `/rsct-setup` before applying \xA7B-\xA7H workflow."
    );
    return hints;
  }
  const protected_branches = resolution.config?.protected_branches ?? [];
  if (git.available && git.branch && protected_branches.includes(git.branch)) {
    hints.push(
      `On protected branch '${git.branch}' \u2014 \xA7D blocks mutating git ops without a per-action OK. Suggest deriving a branch before code phase.`
    );
  }
  if (active_phase) {
    if (active_phase.phase === "verification" && active_phase.verification) {
      hints.push(
        `Active phase: verification (spec_ref='${active_phase.verification.spec_ref ?? "?"}', ${active_phase.verification.findings_count} finding(s)). Call rsct_phase_verification_complete with findings_actions[] + dev_approval before editing code.`
      );
    } else {
      hints.push(
        `Active phase: ${active_phase.phase}${active_phase.spec_slug ? ` (spec_slug='${active_phase.spec_slug}')` : ""}. Read .rsct/phase-state.json before editing.`
      );
    }
  }
  if (active_plan) {
    const status = active_plan.status ?? "unknown";
    hints.push(
      `Active plan: ${active_plan.slug} (status: ${status}). Continue from progress file if status is 'approved' or 'in-progress'.`
    );
    if (active_plan.branch && git.available && git.branch && active_plan.branch !== git.branch) {
      hints.push(
        `Plan branch '${active_plan.branch}' differs from current branch '${git.branch}'. \xA7D recommends asking dev which branch to continue in.`
      );
    }
  } else {
    hints.push("No active plan file detected \u2014 \xA7B requires a plan before code editing for tasks above trivial tier.");
  }
  if (!knowledge.directory_exists) {
    hints.push(
      "Knowledge graph not scaffolded (documentation/knowledge/ missing) \u2014 recall tools will return empty results. Recommend `/rsct-setup` to scaffold; entries are then captured just-in-time during normal conversation (no daily ritual required)."
    );
  } else if (knowledge.categories_missing.length > 0) {
    hints.push(
      `Knowledge graph partial \u2014 ${knowledge.categories_missing.length} of ${knowledge.categories_missing.length + knowledge.categories_present.length} categories missing. Most-impactful to fill first: business-rules, anti-decisions.`
    );
  }
  return hints;
}
var filterSchema = z.object({
  kind: z.enum(["premise", "adr"]).optional(),
  tag: z.string().min(1).optional(),
  status: z.enum(["active", "superseded", "deprecated"]).optional()
}).strict();
var getDecisionsInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  filter: filterSchema.optional()
}).strict();
var getDecisionsTool = {
  name: "rsct_get_decisions",
  description: "Returns architectural decisions (firm premises + ADRs) from documentation/decisions.md, optionally filtered by kind, tag, or status. Use this to verify whether a proposed change conflicts with existing premises, surface the rationale behind a prior choice, or sweep for superseded ADRs. Returns an empty list (not an error) when the file is missing.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      filter: {
        type: "object",
        description: "Optional filter \u2014 all fields combined as AND.",
        properties: {
          kind: {
            type: "string",
            enum: ["premise", "adr"],
            description: "Restrict to firm premises (#N) or durable ADRs."
          },
          tag: {
            type: "string",
            description: "Match entries whose **Tags** line includes this exact tag (case-sensitive)."
          },
          status: {
            type: "string",
            enum: ["active", "superseded", "deprecated"],
            description: "Match entries whose **Status** line equals this value."
          }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
};
async function getDecisionsHandler(rawInput) {
  const input = getDecisionsInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const snapshot = readDecisions(resolution.root);
  const all = [...snapshot.premises, ...snapshot.adrs];
  const filtered = applyFilter(all, input.filter);
  return {
    rsct_installed: resolution.rsct_installed,
    decisions_file: { exists: snapshot.exists, path: snapshot.path },
    total: all.length,
    filtered_count: filtered.length,
    decisions: filtered,
    hints: buildHints2(snapshot, input.filter, filtered.length)
  };
}
function applyFilter(entries, filter) {
  if (!filter) return entries;
  return entries.filter((entry) => {
    if (filter.kind && entry.kind !== filter.kind) return false;
    if (filter.status && entry.status !== filter.status) return false;
    if (filter.tag && !(entry.tags ?? []).includes(filter.tag)) return false;
    return true;
  });
}
function buildHints2(snapshot, filter, filteredCount) {
  const hints = [];
  if (!snapshot.exists) {
    hints.push(
      "documentation/decisions.md not found \u2014 run /rsct-setup to scaffold the file before proposing decisions-dependent work."
    );
    return hints;
  }
  if (filter && filteredCount === 0) {
    hints.push(
      "Filter matched zero decisions. Re-run without the filter to see everything, or verify spelling of tag/status values."
    );
  }
  return hints;
}
var getKnowledgeInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  category: z.string().min(1).describe(
    "Knowledge category file slug, matching documentation/knowledge/<category>.md. Canonical categories: " + KNOWN_CATEGORIES.join(", ")
  ),
  query: z.string().min(1).optional().describe(
    "Optional case-insensitive substring filter; matches sections whose heading or body contain the query."
  )
}).strict();
var getKnowledgeTool = {
  name: "rsct_get_knowledge",
  description: "Reads documentation/knowledge/<category>.md and returns its sections (split by ## and ### headings). Optional query performs a case-insensitive substring filter across heading and body. Use to recall business rules, anti-decisions, incidents, vendor history, or any other knowledge-graph category before making design choices that depend on institutional context. Returns empty sections (not an error) when the file is missing.",
  inputSchema: {
    type: "object",
    required: ["category"],
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      category: {
        type: "string",
        description: "Knowledge category file slug \u2014 documentation/knowledge/<category>.md. Canonical: " + KNOWN_CATEGORIES.join(", ")
      },
      query: {
        type: "string",
        description: "Optional case-insensitive substring; only sections whose heading or body matches are returned."
      }
    },
    additionalProperties: false
  }
};
async function getKnowledgeHandler(rawInput) {
  const input = getKnowledgeInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const index = readKnowledgeIndex(resolution.root);
  const file = readKnowledgeFile(resolution.root, input.category);
  const isCanonical = KNOWN_CATEGORIES.includes(input.category);
  const sections = filterSections(file.sections, input.query);
  return {
    rsct_installed: resolution.rsct_installed,
    category: input.category,
    is_canonical_category: isCanonical,
    file: { exists: file.exists, path: file.path },
    query: input.query ?? null,
    sections_total: file.sections.length,
    sections_returned: sections.length,
    sections,
    available_categories: index.categories_present,
    hints: buildHints3({
      rsctInstalled: resolution.rsct_installed,
      category: input.category,
      isCanonical,
      fileExists: file.exists,
      sectionsTotal: file.sections.length,
      sectionsReturned: sections.length,
      query: input.query,
      availableCategories: index.categories_present
    })
  };
}
function filterSections(sections, query) {
  if (!query) return sections;
  const needle = query.toLowerCase();
  return sections.filter(
    (s) => s.heading.toLowerCase().includes(needle) || s.body.toLowerCase().includes(needle)
  );
}
function buildHints3(args) {
  const hints = [];
  if (!args.rsctInstalled) {
    hints.push(
      "Project is not rsct-managed \u2014 knowledge graph likely absent. Run /rsct-setup before relying on this tool."
    );
    return hints;
  }
  if (!args.fileExists) {
    if (!args.isCanonical) {
      hints.push(
        `Category '${args.category}' is not canonical and the file does not exist. Canonical categories: ${KNOWN_CATEGORIES.join(", ")}.`
      );
    } else {
      hints.push(
        `documentation/knowledge/${args.category}.md does not exist yet. Available now: ${args.availableCategories.length > 0 ? args.availableCategories.join(", ") : "(none)"}. Bootstrap with /rsct-setup or capture inline during conversation.`
      );
    }
    return hints;
  }
  if (args.sectionsTotal === 0) {
    hints.push(
      `${args.category}.md exists but has no ## or ### sections \u2014 file may only contain a top-level intro. Consider capturing structured entries.`
    );
    return hints;
  }
  if (args.query && args.sectionsReturned === 0) {
    hints.push(
      `Query '${args.query}' did not match any section in ${args.category}.md (${args.sectionsTotal} sections scanned). Try a broader term or call without query to see all sections.`
    );
  }
  return hints;
}

// src/lib/secrets.ts
var MASK_PLACEHOLDER = "***MASKED***";
var SECRET_KEY_PATTERN = /\b(jwt[._-]?secret|api[._-]?key|secret|token|password|bearer|credential)\b/i;
var SECRET_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,
  // OpenAI / Anthropic-style
  /^AKIA[0-9A-Z]{16}$/,
  // AWS access key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  // PEM private key block
];
function maskIfSecret(key, value) {
  if (value.length === 0) return { masked: false, value };
  if (SECRET_KEY_PATTERN.test(key)) {
    return { masked: true, value: MASK_PLACEHOLDER, reason: "key-name" };
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return { masked: true, value: MASK_PLACEHOLDER, reason: "value-shape" };
    }
  }
  return { masked: false, value };
}
var LINE_VALUE_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
function compileExtraPatterns(patternStrings) {
  const compiled = [];
  const invalid = [];
  patternStrings.forEach((str, index) => {
    try {
      compiled.push({ id: `extra-${index}`, pattern: new RegExp(str) });
    } catch (err) {
      invalid.push({
        index,
        pattern: str,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });
  return { compiled, invalid };
}
var FILE_HEADER_REGEX = /^\+\+\+\s+(?:b\/)?(.+?)\s*$/;
var HUNK_HEADER_REGEX = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
var KEY_VALUE_REGEX = /["']?([a-zA-Z][a-zA-Z0-9_.-]{1,})["']?\s*[:=]\s*["']?([^\s"',;}]+)["']?/g;
var EXCERPT_MAX_LENGTH = 160;
function* iterateAddedDiffLines(diff) {
  const lines = diff.split("\n");
  let currentFile = null;
  let newLineNumber = 0;
  for (const raw of lines) {
    if (raw.startsWith("diff ")) {
      currentFile = null;
      continue;
    }
    if (raw.startsWith("+++")) {
      if (raw === "+++ /dev/null") {
        currentFile = null;
      } else {
        const m = FILE_HEADER_REGEX.exec(raw);
        currentFile = m?.[1] ?? null;
      }
      continue;
    }
    if (raw.startsWith("---")) continue;
    const hunk = HUNK_HEADER_REGEX.exec(raw);
    if (hunk?.[1]) {
      newLineNumber = parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith("+")) {
      if (currentFile) {
        yield { file: currentFile, line_number: newLineNumber, content: raw.slice(1) };
      }
      newLineNumber++;
      continue;
    }
    if (raw.startsWith("-")) continue;
    if (raw.startsWith(" ")) {
      newLineNumber++;
      continue;
    }
  }
}
function maskExcerpt(line, matched) {
  const masked = matched.length > 0 ? line.split(matched).join(MASK_PLACEHOLDER) : line;
  return masked.length > EXCERPT_MAX_LENGTH ? `${masked.slice(0, EXCERPT_MAX_LENGTH - 3)}...` : masked;
}
function scanDiffForSecrets(diff, extraPatterns = []) {
  const findings = [];
  for (const line of iterateAddedDiffLines(diff)) {
    let valueShapeHit = false;
    for (const pattern of LINE_VALUE_PATTERNS) {
      const m = pattern.exec(line.content);
      if (m) {
        findings.push({
          file: line.file,
          line_number: line.line_number,
          reason: "value-shape",
          excerpt: maskExcerpt(line.content, m[0])
        });
        valueShapeHit = true;
        break;
      }
    }
    if (!valueShapeHit) {
      KEY_VALUE_REGEX.lastIndex = 0;
      let kv;
      while ((kv = KEY_VALUE_REGEX.exec(line.content)) !== null) {
        const key = kv[1];
        const value = kv[2];
        if (key && value && SECRET_KEY_PATTERN.test(key)) {
          findings.push({
            file: line.file,
            line_number: line.line_number,
            reason: "key-name",
            excerpt: maskExcerpt(line.content, value)
          });
          break;
        }
      }
    }
    for (const { id, pattern } of extraPatterns) {
      pattern.lastIndex = 0;
      const m = pattern.exec(line.content);
      if (m && m[0].length > 0) {
        findings.push({
          file: line.file,
          line_number: line.line_number,
          reason: "extra-pattern",
          pattern_id: id,
          excerpt: maskExcerpt(line.content, m[0])
        });
        break;
      }
    }
  }
  return findings;
}

// src/lib/env-files.ts
var SEARCH_PATHS = [
  "",
  "src/main/resources",
  "src/main/resources/config",
  "config",
  "resources"
];
function discoverEnvFiles(projectRoot) {
  const properties = [];
  const envs = [];
  const yamls = [];
  const searched = [];
  for (const sub of SEARCH_PATHS) {
    const dir = sub ? join(projectRoot, sub) : projectRoot;
    if (!existsSync(dir)) continue;
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    searched.push(dir);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (/^application(-.+)?\.properties$/i.test(name)) properties.push(full);
      else if (/^application(-.+)?\.ya?ml$/i.test(name)) yamls.push(full);
      else if (sub === "" && /^\.env(\..+)?$/i.test(name)) envs.push(full);
    }
  }
  const toRel = (p) => relative(projectRoot, p).split("\\").join("/");
  return {
    search_paths: searched.map((p) => relative(projectRoot, p).split("\\").join("/") || "."),
    properties_files: properties.map(toRel),
    env_files: envs.map(toRel),
    yaml_files: yamls.map(toRel)
  };
}
var PROFILE_REGEX = /^application-(.+)\.(properties|ya?ml)$/i;
function getProfileFromBasename(name) {
  const m = name.match(PROFILE_REGEX);
  return m?.[1] ?? null;
}
function parseProperties(content) {
  const out = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const separatorIndex = findSeparator(line);
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length === 0) continue;
    const mask = maskIfSecret(key, value);
    const entry = { key, value: mask.value, masked: mask.masked };
    if (mask.reason) entry.mask_reason = mask.reason;
    out.push(entry);
  }
  return out;
}
function findSeparator(line) {
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "=" || ch === ":") return i;
  }
  return -1;
}
function parseDotEnv(content) {
  const out = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const stripped = line.replace(/^export\s+/, "");
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (key.length === 0) continue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2 || value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    const mask = maskIfSecret(key, value);
    const entry = { key, value: mask.value, masked: mask.masked };
    if (mask.reason) entry.mask_reason = mask.reason;
    out.push(entry);
  }
  return out;
}
function parseEnvFileAt(projectRoot, relPath) {
  const full = join(projectRoot, relPath);
  if (!existsSync(full)) return null;
  let content;
  try {
    content = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  const basename2 = relPath.split("/").pop() ?? relPath;
  const isProperties = /\.properties$/i.test(basename2);
  const isEnv = /^\.env/.test(basename2);
  if (!isProperties && !isEnv) return null;
  const format = isProperties ? "properties" : "env";
  const profile = isProperties ? getProfileFromBasename(basename2) : null;
  const entries = isProperties ? parseProperties(content) : parseDotEnv(content);
  return { path: relPath, format, profile, entries };
}
function computeProfileDeltas(files) {
  const base = /* @__PURE__ */ new Map();
  for (const file of files) {
    if (file.profile === null && file.format === "properties") {
      base.set(file.format, file);
    }
  }
  const out = [];
  for (const file of files) {
    if (file.profile === null) continue;
    const baseFile = base.get(file.format);
    const baseMap = /* @__PURE__ */ new Map();
    if (baseFile) {
      for (const e of baseFile.entries) baseMap.set(e.key, e);
    }
    const added = [];
    const modified = [];
    for (const entry of file.entries) {
      const baseEntry = baseMap.get(entry.key);
      if (!baseEntry) {
        added.push(entry);
        continue;
      }
      if (baseEntry.value !== entry.value || baseEntry.masked !== entry.masked) {
        modified.push({
          key: entry.key,
          base_value: baseEntry.value,
          profile_value: entry.value,
          base_masked: baseEntry.masked,
          profile_masked: entry.masked
        });
      }
    }
    out.push({
      profile: file.profile,
      format: file.format,
      base_path: baseFile?.path ?? "",
      profile_path: file.path,
      added,
      modified
    });
  }
  return out;
}
function readInfrastructure(projectRoot) {
  const path = join(projectRoot, "documentation", "infrastructure.md");
  if (!existsSync(path)) return { exists: false, path: null, entries: [] };
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { exists: true, path, entries: [] };
  }
  return { exists: true, path, entries: extractEntries(body) };
}
var HEADING_REGEX = /^###\s+(INFRA-\d+)\s+[—-]\s+(.+?)\s*$/;
var FIELD_REGEX = /^\s*-\s+\*\*([^*]+?)\*\*\s*:?\s*(.*)$/;
var CONTINUATION_REGEX = /^\s{2,}-\s+(.+)$/;
function extractEntries(body) {
  const lines = body.split("\n");
  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    out.push({
      id: current.id,
      name: current.name,
      fields: current.fields,
      raw_body: current.bodyLines.join("\n").trim()
    });
  };
  for (const line of lines) {
    const heading = line.match(HEADING_REGEX);
    if (heading?.[1] && heading[2]) {
      flush();
      current = {
        id: heading[1],
        name: heading[2].trim(),
        bodyLines: [],
        fields: {},
        lastField: null
      };
      continue;
    }
    if (!current) continue;
    if (/^##?\s/.test(line) && !heading) {
      flush();
      current = null;
      continue;
    }
    current.bodyLines.push(line);
    const fieldMatch = line.match(FIELD_REGEX);
    if (fieldMatch?.[1]) {
      const label = fieldMatch[1].trim().replace(/:$/, "").trim();
      const value = (fieldMatch[2] ?? "").trim();
      current.fields[label] = value;
      current.lastField = label;
      continue;
    }
    const continuation = line.match(CONTINUATION_REGEX);
    if (continuation?.[1] && current.lastField) {
      const prev = current.fields[current.lastField] ?? "";
      const joined = prev.length > 0 ? `${prev}
${continuation[1].trim()}` : continuation[1].trim();
      current.fields[current.lastField] = joined;
    }
  }
  flush();
  return out;
}

// src/tools/get-environments.ts
var SCOPES = ["profiles", "infrastructure", "all"];
var getEnvironmentsInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  scope: z.enum(SCOPES)
}).strict();
var getEnvironmentsTool = {
  name: "rsct_get_environments",
  description: "Returns N2 environment profiles (application.properties / .env*) and/or N3 infrastructure inventory (documentation/infrastructure.md). Profile values matching INV-6 secret patterns are masked. Use scope=profiles to compare prod/dev/test config deltas, scope=infrastructure to recall what runtime services exist before proposing new ones, or scope=all for both. YAML files are detected but not parsed in v1 (limitation surfaced via hint).",
  inputSchema: {
    type: "object",
    required: ["scope"],
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      scope: {
        type: "string",
        enum: [...SCOPES],
        description: "profiles: parse .properties + .env*. infrastructure: parse documentation/infrastructure.md. all: both."
      }
    },
    additionalProperties: false
  }
};
async function getEnvironmentsHandler(rawInput) {
  const input = getEnvironmentsInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const hints = [];
  if (!resolution.rsct_installed) {
    hints.push(
      "Project is not rsct-managed \u2014 env discovery still runs but results may be incomplete. Run /rsct-setup before relying on this tool."
    );
  }
  const result = {
    rsct_installed: resolution.rsct_installed,
    scope: input.scope,
    hints
  };
  if (input.scope === "profiles" || input.scope === "all") {
    result.profiles = collectProfiles(resolution.root, hints);
  }
  if (input.scope === "infrastructure" || input.scope === "all") {
    result.infrastructure = collectInfrastructure(resolution.root, hints);
  }
  return result;
}
function collectProfiles(projectRoot, hints) {
  const discovered = discoverEnvFiles(projectRoot);
  const allPaths = [...discovered.properties_files, ...discovered.env_files];
  const files = [];
  for (const rel of allPaths) {
    const parsed = parseEnvFileAt(projectRoot, rel);
    if (parsed) files.push(parsed);
  }
  const detected_profiles = Array.from(
    new Set(files.map((f) => f.profile).filter((p) => p !== null))
  ).sort();
  const profile_deltas = computeProfileDeltas(files);
  if (files.length === 0 && discovered.yaml_files.length === 0) {
    hints.push(
      "No application.properties / .env / application.yml files detected in standard locations (project root, src/main/resources, src/main/resources/config, config, resources). Confirm naming/location with dev before drawing conclusions."
    );
  }
  if (discovered.yaml_files.length > 0) {
    hints.push(
      `YAML config files detected (${discovered.yaml_files.length}) but not parsed in v1 \u2014 open F2.3.1 to add YAML support if needed. Affected: ${discovered.yaml_files.join(", ")}.`
    );
  }
  const maskedCount = files.reduce(
    (n, f) => n + f.entries.filter((e) => e.masked).length,
    0
  );
  if (maskedCount > 0) {
    hints.push(
      `${maskedCount} env value(s) masked under INV-6 secret patterns; the canonical regex lives in mcp-server/src/lib/secrets.ts.`
    );
  }
  return {
    search_paths: discovered.search_paths,
    detected_profiles,
    files,
    profile_deltas,
    yaml_files_detected_but_not_parsed: discovered.yaml_files
  };
}
function collectInfrastructure(projectRoot, hints) {
  const snapshot = readInfrastructure(projectRoot);
  if (!snapshot.exists) {
    hints.push(
      "documentation/infrastructure.md does not exist \u2014 scope=infrastructure returned empty. Bootstrap via /rsct-setup (Phase 4.5b) or capture inline."
    );
  } else if (snapshot.entries.length === 0) {
    hints.push(
      "documentation/infrastructure.md exists but contains zero `### INFRA-NNN \u2014 ...` entries. Likely still on TODO scaffolding."
    );
  }
  return {
    file: { exists: snapshot.exists, path: snapshot.path },
    entries: snapshot.entries
  };
}
function readArchitectureOverview(projectRoot) {
  const path = join(projectRoot, "documentation", "architecture.md");
  if (!existsSync(path)) return { exists: false, path: null, sections: [] };
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { exists: true, path, sections: [] };
  }
  return { exists: true, path, sections: parseSections(body) };
}
function readArchitectureModules(projectRoot, subdir) {
  const dir = join(projectRoot, "documentation", subdir);
  if (!existsSync(dir)) {
    return { directory_exists: false, directory_path: null, files: [] };
  }
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return { directory_exists: false, directory_path: null, files: [] };
  }
  if (!stat.isDirectory()) {
    return { directory_exists: false, directory_path: null, files: [] };
  }
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { directory_exists: true, directory_path: dir, files: [] };
  }
  const files = [];
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    if (/^README\.md$/i.test(name)) continue;
    const full = join(dir, name);
    let body;
    try {
      body = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    files.push({
      name: name.replace(/\.md$/i, ""),
      path: relative(projectRoot, full).split("\\").join("/"),
      sections: parseSections(body)
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    directory_exists: true,
    directory_path: relative(projectRoot, dir).split("\\").join("/"),
    files
  };
}

// src/tools/get-architecture.ts
var SCOPES2 = ["overview", "module", "impact", "all"];
var getArchitectureInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  scope: z.enum(SCOPES2).default("overview"),
  module_name: z.string().min(1).optional().describe(
    "Optional module slug to narrow scope=module or scope=impact to a single file. Matches the basename without .md."
  )
}).strict();
var getArchitectureTool = {
  name: "rsct_get_architecture",
  description: "Returns architectural reference material. scope=overview reads documentation/architecture.md; scope=module reads documentation/modules/*.md (all modules unless module_name narrows it); scope=impact reads documentation/impact/*.md the same way; scope=all returns everything. Use this before proposing changes that touch a module \u2014 especially to check the impact file for non-obvious couplings and pre-merge checklists.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      scope: {
        type: "string",
        enum: [...SCOPES2],
        default: "overview",
        description: "overview: read architecture.md. module: read modules/*.md. impact: read impact/*.md. all: read all three."
      },
      module_name: {
        type: "string",
        description: "Optional module slug; narrows scope=module or scope=impact to one file (basename without .md). Ignored for overview."
      }
    },
    additionalProperties: false
  }
};
async function getArchitectureHandler(rawInput) {
  const input = getArchitectureInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const hints = [];
  const result = {
    rsct_installed: resolution.rsct_installed,
    scope: input.scope,
    module_name: input.module_name ?? null,
    hints
  };
  const wantsOverview = input.scope === "overview" || input.scope === "all";
  const wantsModules = input.scope === "module" || input.scope === "all";
  const wantsImpact = input.scope === "impact" || input.scope === "all";
  if (wantsOverview) {
    const overview = readArchitectureOverview(resolution.root);
    result.overview = overview;
    if (!overview.exists) {
      hints.push(
        "documentation/architecture.md not found \u2014 bootstrap with /rsct-setup or capture inline."
      );
    } else if (overview.sections.length === 0) {
      hints.push(
        "architecture.md exists but contains no ## or ### sections \u2014 likely still on TODO scaffolding."
      );
    }
  }
  if (wantsModules) {
    result.modules = applyNameFilter(
      readArchitectureModules(resolution.root, "modules"),
      input.module_name
    );
    surfaceFilterHints(hints, "modules", result.modules, input.module_name);
  }
  if (wantsImpact) {
    result.impacts = applyNameFilter(
      readArchitectureModules(resolution.root, "impact"),
      input.module_name
    );
    surfaceFilterHints(hints, "impacts", result.impacts, input.module_name);
  }
  if (!resolution.rsct_installed) {
    hints.unshift(
      "Project is not rsct-managed \u2014 architecture docs likely absent. Run /rsct-setup before relying on this tool."
    );
  }
  return result;
}
function applyNameFilter(set, moduleName) {
  if (!moduleName) return { ...set, filtered_by_name: false };
  const files = set.files.filter((f) => f.name === moduleName);
  return { ...set, files, filtered_by_name: true };
}
function surfaceFilterHints(hints, label, set, moduleName) {
  const subdirLabel = label === "modules" ? "documentation/modules" : "documentation/impact";
  if (!set.directory_exists) {
    hints.push(
      `${subdirLabel}/ directory missing \u2014 bootstrap with /rsct-setup or capture inline.`
    );
    return;
  }
  if (moduleName && set.files.length === 0) {
    hints.push(
      `No ${subdirLabel}/${moduleName}.md found. List of available ${label}: read with the same scope and no module_name to see all.`
    );
  }
  if (!moduleName && set.files.length === 0) {
    hints.push(
      `${subdirLabel}/ exists but contains zero .md files (besides README). Likely still on TODO scaffolding.`
    );
  }
}
function readAntiDecisions(projectRoot) {
  const path = join(
    projectRoot,
    "documentation",
    "knowledge",
    "anti-decisions.md"
  );
  if (!existsSync(path)) {
    return { exists: false, path: null, entries: [] };
  }
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { exists: true, path, entries: [] };
  }
  return { exists: true, path, entries: extractAntiDecisions(body) };
}
var AD_HEADING = /^###\s+(AD-\d+)\s+[—-]\s+(.+?)\s*$/;
function extractAntiDecisions(body) {
  const lines = body.split("\n");
  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    out.push(buildEntry2(current.id, current.title, current.bodyLines.join("\n")));
    current = null;
  };
  for (const line of lines) {
    const adMatch = line.match(AD_HEADING);
    if (adMatch?.[1] && adMatch[2]) {
      flush();
      current = { id: adMatch[1], title: adMatch[2].trim(), bodyLines: [] };
      continue;
    }
    if (current && (/^##\s/.test(line) || /^###\s/.test(line) || /^---\s*$/.test(line))) {
      flush();
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  flush();
  return out;
}
function buildEntry2(id, title, section) {
  const entry = {
    id,
    title,
    excerpt: extractExcerpt2(section)
  };
  const related = extractRelated(section);
  if (related.length > 0) entry.related = related;
  const captured = extractCaptured(section);
  if (captured) entry.captured = captured;
  return entry;
}
function extractExcerpt2(section) {
  const lines = section.split("\n").map((line) => line.trim()).filter(
    (line) => line.length > 0 && !line.startsWith("<!--") && !line.startsWith("<TODO:") && !line.startsWith("```")
  );
  const first = lines.slice(0, 4).join(" ");
  return first.length > 320 ? `${first.slice(0, 317)}...` : first;
}
function extractRelated(section) {
  const match = section.match(/^\s*-\s*\*\*Related:?\*\*:?\s*(.+?)\s*$/im);
  if (!match?.[1]) return [];
  return match[1].split(/[,;]/).map((s) => s.trim()).filter((s) => s.length > 0);
}
function extractCaptured(section) {
  const match = section.match(/^\s*-\s*\*\*Captured:?\*\*:?\s*(\d{4}-\d{2}-\d{2})/im);
  return match?.[1];
}

// src/lib/premise-check.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  // English filler
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "should",
  "would",
  "could",
  "will",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "use",
  "using",
  "want",
  "need",
  "needs",
  "add",
  "change",
  "make",
  "does",
  "into",
  "from",
  "about",
  "over",
  "under",
  "when",
  "while",
  "than",
  "then",
  // pt-BR filler
  "que",
  "para",
  "pelo",
  "pela",
  "usar",
  "usamos",
  "fazer",
  "mudar",
  "adicionar",
  "precisa",
  "quero",
  "queremos",
  "sobre",
  "como",
  "entre",
  "porque"
]);
var NEGATION_PATTERNS = [
  /\brolled[- ]?back\b/i,
  /\bsuperseded\b/i,
  /\bdeprecated\b/i,
  /\bdo[ -]?not\b/i,
  /\brejected\b/i,
  /\banti[- ]?pattern\b/i,
  /\bnever\b/i,
  /\bblock(ed|s)?\b/i,
  /\bavoid(ed)?\b/i,
  /\bbanned\b/i,
  /\brevogad[oa]\b/i,
  /\bnão usar\b/i
];
function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9áàâãéêíîóôõúüç_-]+/i).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
var MIN_SCORE = 2;
function checkPremise(claim, entries, antiDecisions = []) {
  const claimTokens = new Set(tokenize(claim));
  const matches = [];
  for (const entry of entries) {
    const match = scoreEntry(claimTokens, entry);
    if (match) matches.push(match);
  }
  matches.sort((a, b) => b.score - a.score);
  const antiMatches = [];
  for (const entry of antiDecisions) {
    const match = scoreAntiDecision(claimTokens, entry);
    if (match) antiMatches.push(match);
  }
  antiMatches.sort((a, b) => b.score - a.score);
  return {
    recommendation: recommend(matches, antiMatches),
    matches,
    anti_decision_matches: antiMatches,
    scanned: entries.length,
    scanned_anti_decisions: antiDecisions.length,
    reason: explain(matches, antiMatches, entries.length, antiDecisions.length)
  };
}
function scoreEntry(claimTokens, entry) {
  const entryText = `${entry.title} ${entry.excerpt}`;
  const entryTokens = new Set(tokenize(entryText));
  const shared = [];
  for (const t of claimTokens) {
    if (entryTokens.has(t)) shared.push(t);
  }
  if (shared.length < MIN_SCORE) return null;
  const negation = NEGATION_PATTERNS.some((re) => re.test(entryText));
  return {
    entry,
    score: shared.length,
    shared_tokens: shared.sort(),
    negation_signal: negation
  };
}
function scoreAntiDecision(claimTokens, entry) {
  const entryText = `${entry.title} ${entry.excerpt}`;
  const entryTokens = new Set(tokenize(entryText));
  const shared = [];
  for (const t of claimTokens) {
    if (entryTokens.has(t)) shared.push(t);
  }
  if (shared.length < MIN_SCORE) return null;
  return { entry, score: shared.length, shared_tokens: shared.sort() };
}
function recommend(matches, antiMatches) {
  if (antiMatches.length > 0) return "conflict";
  if (matches.length === 0) return "proceed";
  if (matches.some((m) => m.negation_signal)) return "conflict";
  if (matches.some((m) => m.entry.kind === "premise")) return "requires_revision";
  if (matches.some((m) => m.entry.status === "superseded" || m.entry.status === "deprecated")) {
    return "requires_revision";
  }
  return "requires_revision";
}
function explain(matches, antiMatches, scanned, scannedAnti) {
  if (antiMatches.length > 0) {
    const top = antiMatches[0];
    if (top) {
      return `Matched anti-decision ${top.entry.id} ('${top.entry.title}') \u2014 the team explicitly abandoned this approach. Read the full entry (anti-decisions.md) and either align the claim with the documented "do not revisit unless" conditions or surface an explicit override request to the dev.`;
    }
  }
  if (matches.length === 0) {
    const corpusNote = scannedAnti > 0 ? ` (Also cross-checked ${scannedAnti} anti-decision entries.)` : "";
    return `No decisions among ${scanned} scanned share \u2265${MIN_SCORE} significant tokens with the claim.${corpusNote} Proceed, but still check premises if the claim names a regulatory or financial concept.`;
  }
  const premiseHit = matches.find((m) => m.entry.kind === "premise");
  const negationHit = matches.find((m) => m.negation_signal);
  if (negationHit) {
    return `Matched decision ${negationHit.entry.id} ('${negationHit.entry.title}') contains a negation/rollback signal \u2014 claim likely revisits an explicitly rejected path. Read the full entry before proceeding.`;
  }
  if (premiseHit) {
    return `Matched firm premise ${premiseHit.entry.id} ('${premiseHit.entry.title}'). Firm premises are non-negotiable \u2014 claim must align or explicitly call out a premise waiver.`;
  }
  return `Matched ${matches.length} decision(s); top hit ${matches[0]?.entry.id} ('${matches[0]?.entry.title}'). Review before committing the direction.`;
}

// src/tools/check-premise.ts
var AGAINST = ["premises", "adrs", "both"];
var checkPremiseInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  claim: z.string().min(5).describe(
    'A short proposal or design statement to vet against existing decisions (e.g., "use DynamoDB for orders" or "store session tokens in cookies").'
  ),
  against: z.enum(AGAINST).default("both")
}).strict();
var checkPremiseTool = {
  name: "rsct_check_premise",
  description: 'Heuristic check of a proposed claim or design direction against documentation/decisions.md AND documentation/knowledge/anti-decisions.md. Tokenizes the claim, finds decisions sharing \u22652 significant tokens, then scores. Returns a recommendation: "proceed" (no overlap), "conflict" (matched an anti-decision OR a decision with negation/rollback language), or "requires_revision" (matched a firm premise or an active ADR \u2014 dev must read the entry). Anti-decision hits ALWAYS upgrade to conflict \u2014 the team explicitly abandoned that path. Use BEFORE proposing a non-trivial design choice so prior rejected and abandoned paths surface early.',
  inputSchema: {
    type: "object",
    required: ["claim"],
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      claim: {
        type: "string",
        minLength: 5,
        description: 'Short proposal to check (e.g., "use DynamoDB for orders", "Istio sidecar for inter-service auth").'
      },
      against: {
        type: "string",
        enum: [...AGAINST],
        default: "both",
        description: "Restrict the scan to premises only, ADRs only, or both (default)."
      }
    },
    additionalProperties: false
  }
};
async function checkPremiseHandler(rawInput) {
  const input = checkPremiseInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const snapshot = readDecisions(resolution.root);
  const antiSnapshot = readAntiDecisions(resolution.root);
  const subset = selectSubset(snapshot.premises, snapshot.adrs, input.against);
  const result = checkPremise(input.claim, subset, antiSnapshot.entries);
  return {
    rsct_installed: resolution.rsct_installed,
    decisions_file: { exists: snapshot.exists, path: snapshot.path },
    anti_decisions_file: {
      exists: antiSnapshot.exists,
      path: antiSnapshot.path
    },
    claim: input.claim,
    against: input.against,
    recommendation: result.recommendation,
    reason: result.reason,
    matches: result.matches,
    anti_decision_matches: result.anti_decision_matches,
    scanned_decisions: result.scanned,
    scanned_anti_decisions: result.scanned_anti_decisions,
    hints: buildHints4(
      resolution.rsct_installed,
      snapshot.exists,
      antiSnapshot.exists,
      result.recommendation,
      result.anti_decision_matches.length
    )
  };
}
function selectSubset(premises, adrs, against) {
  if (against === "premises") return premises;
  if (against === "adrs") return adrs;
  return [...premises, ...adrs];
}
function buildHints4(installed, decisionsExist, antiDecisionsExist, recommendation, antiMatchCount) {
  const hints = [];
  if (!installed) {
    hints.push(
      "Project is not rsct-managed \u2014 decisions.md likely absent. Run /rsct-setup before relying on this check."
    );
    return hints;
  }
  if (!decisionsExist) {
    hints.push(
      'documentation/decisions.md not found \u2014 zero corpus to check against; recommendation defaulted to "proceed" only because there is nothing to compare with.'
    );
  }
  if (!antiDecisionsExist) {
    hints.push(
      'documentation/knowledge/anti-decisions.md not found \u2014 abandoned-path cross-check skipped. Bootstrap via /rsct-setup so "we already tried that" signals surface earlier.'
    );
  }
  if (antiMatchCount > 0) {
    hints.push(
      "ANTI-DECISION hit: the claim shares vocabulary with one or more entries the team explicitly abandoned. Read anti-decisions.md AD-NNN before proceeding; if the dev wants to revisit, require a stated revisit_reason citing what changed since the abandonment."
    );
  }
  if (recommendation === "conflict" && antiMatchCount === 0) {
    hints.push(
      "CONFLICT signal: the matched decision contains rollback / rejection language. Surface the matched entry to the dev verbatim and ask whether the claim is intentionally revisiting it before proceeding."
    );
  } else if (recommendation === "requires_revision") {
    hints.push(
      "REVISION required: a relevant decision exists. Read the matched entries and either align the claim with them or surface an explicit override request to the dev."
    );
  }
  return hints;
}

// src/lib/branch-protection.ts
var DEFAULT_PROTECTED_BRANCHES = [
  "main",
  "master",
  "test",
  "dev"
];
function effectiveProtectedList(config) {
  const fromConfig = config?.protected_branches;
  const usingConfig = Array.isArray(fromConfig);
  const base = usingConfig ? [...fromConfig] : [...DEFAULT_PROTECTED_BRANCHES];
  const extras = config?.protected_patterns_extra ?? [];
  const merged = [];
  for (const entry of [...base, ...extras]) {
    if (entry.length === 0) continue;
    if (!merged.includes(entry)) merged.push(entry);
  }
  let source;
  if (extras.length > 0) source = "config+extras";
  else if (usingConfig) source = "config";
  else source = "default";
  return { list: merged, source };
}
function isProtectedBranch(branch, list) {
  if (!branch) return false;
  return list.includes(branch);
}

// src/tools/check-branch.ts
var checkBranchInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  branch: z.string().optional().describe(
    "Optional branch name to check instead of the current git HEAD. Useful for what-if queries."
  )
}).strict();
var checkBranchTool = {
  name: "rsct_check_branch",
  description: "Pure query: returns whether the current (or given) branch is in the protected list. Reads `protected_branches` and `protected_patterns_extra` from .rsct.json (falls back to the default list main/master/test/dev). Does NOT block \u2014 use rsct_request_commit/push/merge to actually gate a mutation. Always succeeds; degrades gracefully outside git or outside an rsct project.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      branch: {
        type: "string",
        description: "Optional branch name to check instead of the current git HEAD. Useful for what-if queries."
      }
    },
    additionalProperties: false
  }
};
async function checkBranchHandler(rawInput) {
  const input = checkBranchInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const git = readGitState(resolution.root);
  const { list, source } = effectiveProtectedList(resolution.config ?? void 0);
  const branch = input.branch ?? git.branch;
  const in_git_repo = git.available;
  const is_protected = isProtectedBranch(branch, list);
  return {
    rsct_installed: resolution.rsct_installed,
    in_git_repo,
    branch,
    is_protected,
    protected_list: list,
    source,
    hints: buildHints5({
      rsct_installed: resolution.rsct_installed,
      in_git_repo,
      branch,
      is_protected,
      explicitBranch: input.branch !== void 0
    })
  };
}
function buildHints5(input) {
  const hints = [];
  if (!input.rsct_installed) {
    hints.push(
      "No .rsct.json \u2014 using the default protected list (main/master/test/dev). Run /rsct-setup to customize."
    );
  }
  if (!input.in_git_repo && !input.explicitBranch) {
    hints.push(
      "Not inside a git repository \u2014 branch protection cannot be evaluated against a live HEAD. Pass `branch` explicitly for a what-if check."
    );
    return hints;
  }
  if (input.branch === null) {
    hints.push(
      "Could not resolve a branch name (detached HEAD?). Treating as unprotected."
    );
    return hints;
  }
  if (input.is_protected) {
    hints.push(
      `Branch '${input.branch}' is protected. Mutating tools (rsct_request_commit / _push / _merge) will reject unless dev_approval includes override_protected_branch: { reason }. Prefer creating a derived branch first: git checkout -b <slug>.`
    );
  } else {
    hints.push(`Branch '${input.branch}' is not in the protected list.`);
  }
  return hints;
}
var checkSecretsInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  staged_only: z.boolean().optional().describe(
    "When true (default), scan only `git diff --cached`. When false, scan unstaged changes too."
  ),
  diff_override: z.string().optional().describe(
    "For testing/programmatic use: provide a unified diff string directly instead of reading from git. Bypasses `staged_only`."
  )
}).strict();
var checkSecretsTool = {
  name: "rsct_check_secrets",
  description: "Pure query (INV-6): scan staged diff for credentials. Reports findings without blocking \u2014 rsct_request_commit will actually refuse the commit unless dev_approval.override_secrets_check is provided. Patterns come from the framework defaults plus optional `secrets_extra_patterns[]` regexes in .rsct.json. Excerpts are masked. Degrades gracefully outside git.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      staged_only: {
        type: "boolean",
        description: "When true (default), scan only `git diff --cached`. When false, scan unstaged changes too."
      },
      diff_override: {
        type: "string",
        description: "For testing/programmatic use: provide a unified diff string directly. Bypasses staged_only."
      }
    },
    additionalProperties: false
  }
};
async function checkSecretsHandler(rawInput) {
  const input = checkSecretsInputSchema.parse(rawInput ?? {});
  const staged_only = input.staged_only ?? true;
  const resolution = resolveProjectRoot(input.project_root);
  const git = readGitState(resolution.root);
  const extras = compileExtraPatterns(resolution.config?.secrets_extra_patterns ?? []);
  let diff;
  if (input.diff_override !== void 0) {
    diff = input.diff_override;
  } else if (staged_only) {
    diff = getStagedDiff(resolution.root);
  } else {
    const staged = getStagedDiff(resolution.root) ?? "";
    const unstaged = getUnstagedDiff(resolution.root) ?? "";
    diff = `${staged}
${unstaged}`;
  }
  const findings = diff !== null ? scanDiffForSecrets(diff, extras.compiled) : [];
  return {
    rsct_installed: resolution.rsct_installed,
    in_git_repo: git.available,
    staged_only,
    findings,
    scanned_extra_patterns: extras.compiled.length,
    invalid_extra_patterns: extras.invalid,
    hints: buildHints6({
      rsct_installed: resolution.rsct_installed,
      in_git_repo: git.available,
      diff_present: diff !== null,
      findings_count: findings.length,
      invalid_extras: extras.invalid.length
    })
  };
}
function buildHints6(input) {
  const hints = [];
  if (!input.rsct_installed) {
    hints.push(
      "No .rsct.json \u2014 running secrets scan with framework default patterns only."
    );
  }
  if (!input.in_git_repo && !input.diff_present) {
    hints.push(
      "Not inside a git repository \u2014 secrets scan returned empty. Pass `diff_override` for what-if checks."
    );
  }
  if (input.findings_count > 0) {
    hints.push(
      `${input.findings_count} secret finding(s). rsct_request_commit will reject this commit unless dev_approval includes override_secrets_check: { reason }.`
    );
  } else if (input.in_git_repo || input.diff_present) {
    hints.push("No secret patterns matched the scanned diff.");
  }
  if (input.invalid_extras > 0) {
    hints.push(
      `${input.invalid_extras} entry/entries in secrets_extra_patterns failed to compile as regex \u2014 they were skipped. See invalid_extra_patterns for details.`
    );
  }
  return hints;
}
var phaseStateOverrideSchema = z.object({
  spec_slug: z.string().optional(),
  phase: z.string().optional(),
  scope_globs: z.array(z.string()).optional(),
  started_at: z.string().optional()
}).strict();
var checkEditScopeInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  file_path: z.string().min(1, "file_path required").describe("Path to check against the active spec scope. Forward and backslash both accepted."),
  phase_state_override: phaseStateOverrideSchema.optional().describe(
    "Programmatic override of `.rsct/phase-state.json`. When provided, the file is NOT read from disk."
  )
}).strict();
var checkEditScopeTool = {
  name: "rsct_check_edit_scope",
  description: 'Pure query: returns whether `file_path` falls inside the active spec phase scope (`.rsct/phase-state.json` `scope_globs[]`). Until the M3 phase machine writes that file, this tool returns status="unknown" and a hint explaining why. Pass `phase_state_override` to test scoping without writing to disk.',
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      file_path: {
        type: "string",
        description: "Path to check against the active spec scope."
      },
      phase_state_override: {
        type: "object",
        description: "Programmatic override of `.rsct/phase-state.json`. When provided, the file is NOT read from disk.",
        properties: {
          spec_slug: { type: "string" },
          phase: { type: "string" },
          scope_globs: { type: "array", items: { type: "string" } },
          started_at: { type: "string" }
        },
        additionalProperties: false
      }
    },
    required: ["file_path"],
    additionalProperties: false
  }
};
async function checkEditScopeHandler(rawInput) {
  const input = checkEditScopeInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  let phase_state_exists;
  let state;
  let parse_error;
  if (input.phase_state_override !== void 0) {
    phase_state_exists = true;
    const override = input.phase_state_override;
    const rebuilt = {};
    if (override.spec_slug !== void 0) rebuilt.spec_slug = override.spec_slug;
    if (override.phase !== void 0) rebuilt.phase = override.phase;
    if (override.scope_globs !== void 0) rebuilt.scope_globs = override.scope_globs;
    if (override.started_at !== void 0) rebuilt.started_at = override.started_at;
    state = rebuilt;
  } else {
    const read = readPhaseState(resolution.root);
    phase_state_exists = read.exists;
    state = read.state;
    parse_error = read.parse_error;
  }
  const scope_globs = state?.scope_globs ?? [];
  let status;
  let matched_glob = null;
  if (!phase_state_exists || state === null || scope_globs.length === 0) {
    status = "unknown";
  } else {
    const match = matchesAnyGlob(input.file_path, scope_globs);
    status = match.matched ? "in_scope" : "out_of_scope";
    matched_glob = match.matched_glob ?? null;
  }
  const output = {
    rsct_installed: resolution.rsct_installed,
    phase_state_exists,
    spec_slug: state?.spec_slug ?? null,
    phase: state?.phase ?? null,
    file_path: input.file_path,
    status,
    matched_glob,
    scope_globs,
    hints: buildHints7({
      rsct_installed: resolution.rsct_installed,
      phase_state_exists,
      state,
      parse_error,
      status,
      file_path: input.file_path,
      matched_glob
    })
  };
  if (parse_error !== void 0) output.phase_state_parse_error = parse_error;
  return output;
}
function buildHints7(input) {
  const hints = [];
  if (!input.rsct_installed) {
    hints.push("No .rsct.json \u2014 running scope check with no project context.");
  }
  if (!input.phase_state_exists) {
    hints.push(
      "No .rsct/phase-state.json yet \u2014 the phase machine ships in M3. Until then, this tool always returns status=unknown for live queries; pass `phase_state_override` for what-if checks."
    );
    return hints;
  }
  if (input.parse_error) {
    hints.push(
      `.rsct/phase-state.json exists but failed to parse (${input.parse_error}). Treating scope as unknown.`
    );
    return hints;
  }
  if (input.state && (!input.state.scope_globs || input.state.scope_globs.length === 0)) {
    hints.push(
      ".rsct/phase-state.json is present but scope_globs is empty \u2014 cannot evaluate. Update the phase state to declare scope."
    );
    return hints;
  }
  if (input.status === "in_scope") {
    hints.push(
      `File is in scope via glob '${input.matched_glob}'. Edits proceed normally.`
    );
  } else if (input.status === "out_of_scope") {
    hints.push(
      `File '${input.file_path}' is OUTSIDE the active spec scope. Either expand scope_globs in the phase state with explicit dev approval, or pause and re-plan before editing.`
    );
  }
  return hints;
}
var DevApprovalSchema = z.object({
  timestamp: z.string().min(1, "timestamp required"),
  action_scope: z.string().min(1, "action_scope required"),
  reason: z.string().min(1, "reason required"),
  override_protected_branch: z.object({ reason: z.string().min(1, "override reason required") }).strict().optional(),
  override_secrets_check: z.object({ reason: z.string().min(1, "override reason required") }).strict().optional()
}).strict();
var EXPECTED_SCOPE_TOKEN = {
  rsct_request_commit: "commit",
  rsct_request_push: "push",
  rsct_request_merge: "merge",
  rsct_phase_verification_complete: "verification_complete",
  rsct_phase_research_complete: "research_complete",
  rsct_phase_spec_complete: "spec_complete",
  rsct_phase_code_complete: "code_complete",
  rsct_phase_test_complete: "test_complete",
  rsct_phase_abandon: "phase_abandon",
  rsct_capture_issue: "capture_issue"
};
var BURST_WINDOW_MS = 1e4;
var BURST_THRESHOLD_PRIOR = 3;
var DEFAULT_SKEW_SECONDS = 180;
var DEFAULT_FABRICATION_THRESHOLD_MS = 500;
var MIN_REASON_LENGTH = 10;
var APPROVALS_STORE_RELATIVE = ".rsct/approvals-seen.json";
function resolveStorePath(projectRoot) {
  return join(projectRoot, APPROVALS_STORE_RELATIVE);
}
function loadStore(projectRoot) {
  const path = resolveStorePath(projectRoot);
  if (!existsSync(path)) {
    return { store: { version: 1, entries: [] }, corrupt: false };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return { store: { version: 1, entries: [] }, corrupt: true };
    }
    return { store: parsed, corrupt: false };
  } catch {
    return { store: { version: 1, entries: [] }, corrupt: true };
  }
}
function lastConsumedAt(store) {
  let latest = null;
  for (const entry of store.entries) {
    const d = new Date(entry.consumed_at);
    if (Number.isNaN(d.getTime())) continue;
    if (!latest || d > latest) latest = d;
  }
  return latest;
}
function validateDevApproval(raw, options) {
  const parsed = DevApprovalSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const reason = issue ? `dev_approval schema invalid at '${issue.path.join(".") || "(root)"}': ${issue.message}` : "dev_approval schema invalid";
    return { status: "rejected", reason, fabrication_signals: [] };
  }
  const approval = parsed.data;
  const now = options.now ?? /* @__PURE__ */ new Date();
  const skewSeconds = options.approvalModes?.timestamp_skew_seconds ?? DEFAULT_SKEW_SECONDS;
  const fabricationThresholdMs = options.approvalModes?.fabrication_signal_threshold_ms ?? DEFAULT_FABRICATION_THRESHOLD_MS;
  const tsDate = new Date(approval.timestamp);
  if (Number.isNaN(tsDate.getTime())) {
    return {
      status: "rejected",
      reason: `dev_approval.timestamp is not a parseable date: ${approval.timestamp}`,
      fabrication_signals: []
    };
  }
  const diffMs = now.getTime() - tsDate.getTime();
  const skewMs = skewSeconds * 1e3;
  if (diffMs > skewMs) {
    return {
      status: "rejected",
      reason: `dev_approval.timestamp is older than ${skewSeconds}s skew tolerance (diff=${Math.round(diffMs / 1e3)}s)`,
      fabrication_signals: []
    };
  }
  if (diffMs < -skewMs) {
    return {
      status: "rejected",
      reason: `dev_approval.timestamp is more than ${skewSeconds}s in the future (diff=${Math.round(-diffMs / 1e3)}s)`,
      fabrication_signals: []
    };
  }
  const { store, corrupt } = loadStore(options.projectRoot);
  const signals = [];
  if (corrupt) signals.push("approvals_store_corrupt");
  const reused = store.entries.some(
    (e) => e.action_scope === approval.action_scope && e.timestamp === approval.timestamp
  );
  if (reused) {
    return {
      status: "rejected",
      reason: `dev_approval reused (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}')`,
      fabrication_signals: signals
    };
  }
  if (approval.reason.trim().length < MIN_REASON_LENGTH) {
    signals.push("reason_too_short");
  }
  const lastConsumed = lastConsumedAt(store);
  if (lastConsumed) {
    const gapMs = now.getTime() - lastConsumed.getTime();
    if (gapMs >= 0 && gapMs < fabricationThresholdMs) {
      signals.push("implausibly_fast");
    }
  }
  if (detectScopeMismatch(approval.action_scope, options.toolName)) {
    signals.push("scope_mismatch");
  }
  if (detectBurstPattern(store, now)) {
    signals.push("burst_pattern");
  }
  return {
    status: "valid",
    approval,
    fabrication_signals: signals,
    must_force_dialog: signals.length > 0
  };
}
function detectScopeMismatch(actionScope, toolName) {
  if (!toolName) return false;
  const expected = EXPECTED_SCOPE_TOKEN[toolName];
  if (expected === void 0) return false;
  const firstToken = actionScope.split(":")[0];
  return firstToken !== expected;
}
function detectBurstPattern(store, now) {
  const cutoff = now.getTime() - BURST_WINDOW_MS;
  let recent = 0;
  for (const entry of store.entries) {
    const t = new Date(entry.consumed_at).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= cutoff) {
      recent++;
      if (recent >= BURST_THRESHOLD_PRIOR) return true;
    }
  }
  return false;
}
function recordConsumedApproval(approval, options) {
  const path = resolveStorePath(options.projectRoot);
  const now = options.now ?? /* @__PURE__ */ new Date();
  try {
    ensureParentDir(path);
    const { store } = loadStore(options.projectRoot);
    store.entries.push({
      action_scope: approval.action_scope,
      timestamp: approval.timestamp,
      consumed_at: now.toISOString()
    });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8" });
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      path,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
var ENV_OVERRIDE_KEY = "RSCT_TEST_DIALOG_RESPONSE";
async function promptYesNo(options, internal = {}) {
  const env = internal.env ?? process.env;
  const override = readEnvOverride(env);
  if (override !== null) {
    return { response: override, channel: "env-override" };
  }
  const platform = internal.platform ?? process.platform;
  const executor = internal.executor ?? defaultExecutor;
  switch (platform) {
    case "win32":
      return runWindowsDialog(options, executor);
    case "darwin":
      return runMacDialog(options, executor);
    case "linux":
      return runLinuxDialog(options, executor);
    default:
      return {
        response: "no-channel",
        channel: "none",
        error: `unsupported platform: ${platform}`
      };
  }
}
function readEnvOverride(env) {
  const raw = env[ENV_OVERRIDE_KEY];
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "yes") return "yes";
  if (normalized === "no") return "no";
  return null;
}
function defaultExecutor(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return normalizeExecError(err);
  }
}
function normalizeExecError(err) {
  if (err && typeof err === "object") {
    const e = err;
    const result = {
      exitCode: typeof e.status === "number" ? e.status : -1,
      stdout: bufferOrStringToString2(e.stdout),
      stderr: bufferOrStringToString2(e.stderr)
    };
    const message = e.message ?? (e.code ? `exec failed: ${e.code}` : void 0);
    if (message) result.error = message;
    return result;
  }
  return { exitCode: -1, stdout: "", stderr: "", error: String(err) };
}
function bufferOrStringToString2(value) {
  if (value === void 0) return "";
  if (typeof value === "string") return value;
  return value.toString("utf8");
}
function escapePowerShellSingleQuoted(s) {
  return s.replace(/'/g, "''");
}
function runWindowsDialog(options, executor) {
  const msg = escapePowerShellSingleQuoted(options.message);
  const title = escapePowerShellSingleQuoted(options.title);
  const script = `Add-Type -AssemblyName System.Windows.Forms; $r = [System.Windows.Forms.MessageBox]::Show('${msg}', '${title}', 'YesNo', 'Question'); Write-Output $r`;
  const exec = executor("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ]);
  if (exec.error || exec.exitCode < 0) {
    return {
      response: "no-channel",
      channel: "none",
      error: exec.error ?? `powershell exit ${exec.exitCode}`
    };
  }
  const stdout = exec.stdout.trim();
  if (stdout === "Yes") return { response: "yes", channel: "windows" };
  if (stdout === "No") return { response: "no", channel: "windows" };
  return {
    response: "no-channel",
    channel: "none",
    error: `unexpected powershell output: ${stdout}`
  };
}
function escapeAppleScriptDoubleQuoted(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function runMacDialog(options, executor) {
  const msg = escapeAppleScriptDoubleQuoted(options.message);
  const title = escapeAppleScriptDoubleQuoted(options.title);
  const script = `display dialog "${msg}" with title "${title}" buttons {"No","Yes"} default button "Yes"`;
  const exec = executor("osascript", ["-e", script]);
  if (exec.exitCode !== 0) {
    if (exec.error && exec.exitCode < 0) {
      return { response: "no-channel", channel: "none", error: exec.error };
    }
    return { response: "no", channel: "macos" };
  }
  const stdout = exec.stdout.trim();
  if (stdout.includes("button returned:Yes")) return { response: "yes", channel: "macos" };
  if (stdout.includes("button returned:No")) return { response: "no", channel: "macos" };
  return {
    response: "no-channel",
    channel: "none",
    error: `unexpected osascript output: ${stdout}`
  };
}
function runLinuxDialog(options, executor) {
  const exec = executor("zenity", [
    "--question",
    `--title=${options.title}`,
    `--text=${options.message}`,
    "--no-wrap"
  ]);
  if (exec.error && exec.exitCode < 0) {
    return { response: "no-channel", channel: "none", error: exec.error };
  }
  if (exec.exitCode === 0) return { response: "yes", channel: "linux-zenity" };
  if (exec.exitCode === 1) return { response: "no", channel: "linux-zenity" };
  return {
    response: "no-channel",
    channel: "none",
    error: `zenity exit ${exec.exitCode}: ${exec.stderr.trim()}`
  };
}

// src/lib/request-gate.ts
async function gateRequest(opts) {
  const validateOpts = {
    projectRoot: opts.projectRoot,
    toolName: opts.toolName
  };
  if (opts.approvalModes !== void 0) validateOpts.approvalModes = opts.approvalModes;
  if (opts.now !== void 0) validateOpts.now = opts.now;
  const validation = validateDevApproval(opts.approval, validateOpts);
  if (validation.status === "rejected") {
    return {
      status: "rejected",
      reason: validation.reason,
      reject_kind: inferRejectKind(validation.reason),
      fabrication_signals: validation.fabrication_signals
    };
  }
  const promptFn = opts.promptFn ?? promptYesNo;
  const dialog = await promptFn(opts.dialog);
  if (validation.must_force_dialog) {
    if (dialog.response === "yes") {
      return {
        status: "approved",
        approval: validation.approval,
        channel: dialog.channel,
        fabrication_signals: validation.fabrication_signals
      };
    }
    if (dialog.response === "no") {
      return {
        status: "rejected",
        reason: "dev declined the \xA7C dialog (forced by fabrication signals)",
        reject_kind: "dialog_no",
        fabrication_signals: validation.fabrication_signals
      };
    }
    return {
      status: "rejected",
      reason: `dialog channel unavailable (${dialog.error ?? "no channel"}); fabrication signals [${validation.fabrication_signals.join(",")}] require forced dialog \u2014 trust_allowed_for is ignored`,
      reject_kind: "force_dialog_no_channel",
      fabrication_signals: validation.fabrication_signals
    };
  }
  if (dialog.response === "yes") {
    return {
      status: "approved",
      approval: validation.approval,
      channel: dialog.channel,
      fabrication_signals: validation.fabrication_signals
    };
  }
  if (dialog.response === "no") {
    return {
      status: "rejected",
      reason: "dev declined the \xA7C dialog",
      reject_kind: "dialog_no",
      fabrication_signals: validation.fabrication_signals
    };
  }
  const trustList = opts.approvalModes?.trust_allowed_for ?? [];
  if (trustList.includes(opts.toolName)) {
    return {
      status: "approved",
      approval: validation.approval,
      channel: "trust",
      fabrication_signals: validation.fabrication_signals
    };
  }
  return {
    status: "rejected",
    reason: `dialog channel unavailable (${dialog.error ?? "no channel"}) and '${opts.toolName}' is not listed in approval_modes.trust_allowed_for`,
    reject_kind: "no_channel",
    fabrication_signals: validation.fabrication_signals
  };
}
function inferRejectKind(reason) {
  if (reason.includes("reused")) return "reused";
  if (reason.includes("skew") || reason.includes("future")) return "expired";
  return "schema";
}

// src/tools/request-commit.ts
var requestCommitInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  message: z.string().min(1, "commit message required").describe("Commit message to pass to `git commit -m`."),
  dev_approval: z.unknown().describe(
    "The dev_approval payload (timestamp, action_scope, reason). Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication). To avoid the soft `scope_mismatch` fabrication signal (logged to .rsct/audit.log, non-blocking), make `action_scope`/`reason` mirror the ACTUAL staged diff \u2014 the files and branch being committed \u2014 instead of free-text intent that the validator cannot reconcile with the diff."
  ),
  staged_diff_override: z.string().optional().describe(
    "Programmatic override of `git diff --cached` for testing. Bypasses the real git fetch."
  )
}).strict();
var requestCommitTool = {
  name: "rsct_request_commit",
  description: "\xA7C-gated commit. Validates dev_approval (schema/skew/anti-reuse/fabrication), pops an OS dialog when required, runs INV-5 branch and INV-6 secrets checks, then executes `git commit -m`. On rejection the approval is NOT consumed \u2014 dev can add an override and retry with the same payload. Audit log entry written on every outcome.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      message: {
        type: "string",
        description: "Commit message."
      },
      dev_approval: {
        type: "object",
        description: "The dev_approval payload (timestamp, action_scope, reason, optional overrides)."
      },
      staged_diff_override: {
        type: "string",
        description: "For tests: substitute the staged diff with this unified-diff string."
      }
    },
    required: ["message", "dev_approval"],
    additionalProperties: false
  }
};
async function requestCommitHandler(rawInput, internal = {}) {
  const input = requestCommitInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config ?? void 0;
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor;
  const promptFn = internal.promptFn ?? promptYesNo;
  const now = internal.now ?? /* @__PURE__ */ new Date();
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot);
  const branchLabel = gitState.branch ?? "<no-branch>";
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval;
  const gate = await gateRequest({
    toolName: "rsct_request_commit",
    approval: input.dev_approval,
    dialog: {
      title: "RSCT \xA7C \u2014 commit approval",
      message: `Approve commit on '${branchLabel}'?

message: ${input.message}`
    },
    projectRoot,
    ...config?.approval_modes !== void 0 && { approvalModes: config.approval_modes },
    promptFn,
    now
  });
  if (gate.status === "rejected") {
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_commit.rejected",
        tool: "rsct_request_commit",
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        branch: gitState.branch,
        fabrication_signals: gate.fabrication_signals
      },
      config?.audit
    );
    return {
      status: "rejected",
      branch: gitState.branch,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      ...auditFields(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`\xA7C rejected (${gate.reject_kind}): ${gate.reason}`]
    };
  }
  const approval = gate.approval;
  const overrideBranch = approval.override_protected_branch;
  const overrideSecrets = approval.override_secrets_check;
  const { list: protectedList } = effectiveProtectedList(config);
  const branchProtected = isProtectedBranch(gitState.branch, protectedList);
  if (branchProtected && !overrideBranch) {
    const reason = `branch '${branchLabel}' is protected \u2014 pass dev_approval.override_protected_branch: { reason } to proceed`;
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_commit.rejected",
        tool: "rsct_request_commit",
        reject_kind: "protected_branch",
        reason,
        branch: gitState.branch,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "rejected",
      branch: gitState.branch,
      channel: gate.channel,
      reject_kind: "protected_branch",
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: true, override_used: false },
      secrets_check: { findings_count: 0, findings: [], override_used: false },
      ...auditFields(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  if (branchProtected && overrideBranch) {
    appendAudit(
      projectRoot,
      {
        event: "request_commit.override_invoked",
        tool: "rsct_request_commit",
        override_kind: "protected_branch",
        override_reason: overrideBranch.reason,
        branch: gitState.branch,
        channel: gate.channel
      },
      config?.audit
    );
  }
  const diff = input.staged_diff_override !== void 0 ? input.staged_diff_override : getStagedDiff(projectRoot) ?? "";
  const extras = compileExtraPatterns(config?.secrets_extra_patterns ?? []).compiled;
  const findings = scanDiffForSecrets(diff, extras);
  if (findings.length > 0 && !overrideSecrets) {
    const reason = `${findings.length} secret finding(s) in staged diff \u2014 pass dev_approval.override_secrets_check: { reason } to proceed`;
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_commit.rejected",
        tool: "rsct_request_commit",
        reject_kind: "secrets",
        reason,
        branch: gitState.branch,
        channel: gate.channel,
        findings_count: findings.length
      },
      config?.audit
    );
    return {
      status: "rejected",
      branch: gitState.branch,
      channel: gate.channel,
      reject_kind: "secrets",
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      secrets_check: { findings_count: findings.length, findings, override_used: false },
      ...auditFields(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  if (findings.length > 0 && overrideSecrets) {
    appendAudit(
      projectRoot,
      {
        event: "request_commit.override_invoked",
        tool: "rsct_request_commit",
        override_kind: "secrets_check",
        override_reason: overrideSecrets.reason,
        findings_count: findings.length,
        branch: gitState.branch,
        channel: gate.channel
      },
      config?.audit
    );
  }
  const commit = gitCommit(projectRoot, input.message, gitExecutor);
  if (!commit.ok) {
    const reason = commit.error ?? commit.stderr ?? "git commit failed";
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_commit.mutation_failed",
        tool: "rsct_request_commit",
        reason,
        branch: gitState.branch,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "mutation_failed",
      branch: gitState.branch,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: commit.sha_before,
      sha_after: null,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      secrets_check: {
        findings_count: findings.length,
        findings,
        override_used: findings.length > 0
      },
      ...auditFields(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: ["git commit failed \u2014 approval NOT consumed. Fix the underlying error and retry with the same dev_approval."]
    };
  }
  const record = recordApproval(approval, { projectRoot, now });
  const audit = appendAudit(
    projectRoot,
    {
      event: "request_commit.committed",
      tool: "rsct_request_commit",
      branch: gitState.branch,
      channel: gate.channel,
      sha_before: commit.sha_before,
      sha_after: commit.sha_after,
      fabrication_signals: gate.fabrication_signals
    },
    config?.audit
  );
  const hints = [
    `Committed ${commit.sha_after ?? "<unknown sha>"} on '${branchLabel}'.`
  ];
  if (!record.ok) {
    hints.push(
      `\u26A0 commit landed but anti-replay store update failed: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') may be replayable within the skew window \u2014 rotate the approval or repair .rsct/approvals-seen.json before the next \xA7C-gated call.`
    );
  }
  const afields = auditFields(audit);
  if (afields.audit_error !== null) {
    hints.push(
      `\u26A0 commit landed but audit log write failed: ${afields.audit_error}. Manual audit reconstruction may be needed for forensic traceability.`
    );
  }
  const bootstrap = evaluateBootstrapMarker({ projectRoot, now });
  if (bootstrap.status !== "fresh") {
    if (bootstrap.hint) hints.push(bootstrap.hint);
    appendAudit(
      projectRoot,
      {
        event: "request_commit.bootstrap_warning",
        tool: "rsct_request_commit",
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms,
        branch: gitState.branch,
        sha_after: commit.sha_after
      },
      config?.audit
    );
  }
  const activePlan = findActivePlan(projectRoot);
  if (activePlan) {
    hints.push(
      `\u2139 Active plan '${activePlan.slug}' \u2014 if this commit advances it, update progress_${activePlan.slug}.md (and plan_/spec_${activePlan.slug}.md if the plan itself changed).`
    );
  }
  return {
    status: "committed",
    branch: gitState.branch,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    sha_before: commit.sha_before,
    sha_after: commit.sha_after,
    branch_check: { protected: branchProtected, override_used: branchProtected },
    secrets_check: {
      findings_count: findings.length,
      findings,
      override_used: findings.length > 0
    },
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints
  };
}
function auditFields(r) {
  if (r.ok) return { audit_path: r.path, audit_error: null };
  if (r.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: r.path ?? null,
    audit_error: r.error ?? "write_failed"
  };
}
var requestPushInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  remote: z.string().optional().describe("Remote name (default: origin)."),
  branch: z.string().optional().describe("Branch name to push (default: current HEAD)."),
  dev_approval: z.unknown().describe(
    "The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication)."
  )
}).strict();
var requestPushTool = {
  name: "rsct_request_push",
  description: "\xA7C-gated push. Validates dev_approval, pops OS dialog when required, runs INV-5 branch check, then executes `git push <remote> <branch>`. No secrets scan \u2014 the commit step already enforced INV-6. On rejection the approval is NOT consumed; dev can add an override and retry.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      remote: { type: "string", description: "Remote name (default: origin)." },
      branch: { type: "string", description: "Branch to push (default: current HEAD)." },
      dev_approval: {
        type: "object",
        description: "dev_approval payload."
      }
    },
    required: ["dev_approval"],
    additionalProperties: false
  }
};
async function requestPushHandler(rawInput, internal = {}) {
  const input = requestPushInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config ?? void 0;
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor;
  const promptFn = internal.promptFn ?? promptYesNo;
  const now = internal.now ?? /* @__PURE__ */ new Date();
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot);
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? gitState.branch;
  const branchLabel = branch ?? "<no-branch>";
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval;
  const gate = await gateRequest({
    toolName: "rsct_request_push",
    approval: input.dev_approval,
    dialog: {
      title: "RSCT \xA7C \u2014 push approval",
      message: `Approve push of '${branchLabel}' to '${remote}'?`
    },
    projectRoot,
    ...config?.approval_modes !== void 0 && { approvalModes: config.approval_modes },
    promptFn,
    now
  });
  if (gate.status === "rejected") {
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_push.rejected",
        tool: "rsct_request_push",
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        branch,
        remote,
        fabrication_signals: gate.fabrication_signals
      },
      config?.audit
    );
    return {
      status: "rejected",
      branch,
      remote,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: false, override_used: false },
      ...auditFields2(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`\xA7C rejected (${gate.reject_kind}): ${gate.reason}`]
    };
  }
  const approval = gate.approval;
  const overrideBranch = approval.override_protected_branch;
  const { list: protectedList } = effectiveProtectedList(config);
  const branchProtected = isProtectedBranch(branch, protectedList);
  if (branchProtected && !overrideBranch) {
    const reason = `branch '${branchLabel}' is protected \u2014 pass dev_approval.override_protected_branch: { reason } to push`;
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_push.rejected",
        tool: "rsct_request_push",
        reject_kind: "protected_branch",
        reason,
        branch,
        remote,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "rejected",
      branch,
      remote,
      channel: gate.channel,
      reject_kind: "protected_branch",
      reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: true, override_used: false },
      ...auditFields2(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  if (branchProtected && overrideBranch) {
    appendAudit(
      projectRoot,
      {
        event: "request_push.override_invoked",
        tool: "rsct_request_push",
        override_kind: "protected_branch",
        override_reason: overrideBranch.reason,
        branch,
        remote,
        channel: gate.channel
      },
      config?.audit
    );
  }
  if (branch === null) {
    const reason = "no branch resolved \u2014 pass `branch` explicitly or run from inside a git worktree on a named branch";
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_push.mutation_failed",
        tool: "rsct_request_push",
        reason,
        remote,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "mutation_failed",
      branch: null,
      remote,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: false, override_used: false },
      ...auditFields2(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  const push = gitPush(projectRoot, remote, branch, gitExecutor);
  if (!push.ok) {
    const reason = push.error ?? push.stderr ?? "git push failed";
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_push.mutation_failed",
        tool: "rsct_request_push",
        reason,
        branch,
        remote,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "mutation_failed",
      branch,
      remote,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      branch_check: { protected: branchProtected, override_used: branchProtected },
      ...auditFields2(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: ["git push failed \u2014 approval NOT consumed. Fix the underlying error and retry with the same dev_approval."]
    };
  }
  const record = recordApproval(approval, { projectRoot, now });
  const audit = appendAudit(
    projectRoot,
    {
      event: "request_push.pushed",
      tool: "rsct_request_push",
      branch,
      remote,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals
    },
    config?.audit
  );
  const hints = [`Pushed '${branch}' to '${remote}'.`];
  if (!record.ok) {
    hints.push(
      `\u26A0 push landed but anti-replay store update failed: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') may be replayable within the skew window \u2014 rotate the approval or repair .rsct/approvals-seen.json before the next \xA7C-gated call.`
    );
  }
  const afields = auditFields2(audit);
  if (afields.audit_error !== null) {
    hints.push(
      `\u26A0 push landed but audit log write failed: ${afields.audit_error}. Manual audit reconstruction may be needed for forensic traceability.`
    );
  }
  const bootstrap = evaluateBootstrapMarker({ projectRoot, now });
  if (bootstrap.status !== "fresh") {
    if (bootstrap.hint) hints.push(bootstrap.hint);
    appendAudit(
      projectRoot,
      {
        event: "request_push.bootstrap_warning",
        tool: "rsct_request_push",
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms,
        branch,
        remote
      },
      config?.audit
    );
  }
  const activePlan = findActivePlan(projectRoot);
  if (activePlan && isPlanComplete(activePlan.status)) {
    hints.push(
      `\u2139 Plan '${activePlan.slug}' is marked complete. Optional, with your OK (not automated): delete plan_/progress_/spec_${activePlan.slug}.md so they never land on a protected branch.`
    );
  }
  return {
    status: "pushed",
    branch,
    remote,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    branch_check: { protected: branchProtected, override_used: branchProtected },
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints
  };
}
function auditFields2(r) {
  if (r.ok) return { audit_path: r.path, audit_error: null };
  if (r.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: r.path ?? null,
    audit_error: r.error ?? "write_failed"
  };
}
var requestMergeInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  source_branch: z.string().min(1, "source_branch required").describe("Branch to merge INTO the current HEAD."),
  no_ff: z.boolean().optional().describe("Pass --no-ff to git merge (default true)."),
  allow_unrelated_histories: z.boolean().optional().describe(
    "Pass --allow-unrelated-histories (default false). Setting true requires dev_approval.override_protected_branch as a proxy ack of force-like risk."
  ),
  dev_approval: z.unknown().describe(
    "The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication)."
  )
}).strict();
var requestMergeTool = {
  name: "rsct_request_merge",
  description: "\xA7C-gated merge. Validates dev_approval, pops OS dialog when required, runs INV-5 on the TARGET branch (current HEAD), then executes `git merge` (default --no-ff). Extra-strict: --allow-unrelated-histories is treated as a force-like operation and requires override_protected_branch even on a non-protected target. Detached HEAD and self-merge surface as mutation_failed/same_branch. This is the LOCAL merge-commit path; GitHub PR merges (merge commit / squash / rebase via `gh pr merge --merge|--squash|--rebase`) are equivalent for cleanup purposes. On a successful merge whose plan is complete, the hints suggest deleting the merged working branch + plan_/progress_/spec_ files (never automated; see \xA7D).",
  inputSchema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      source_branch: {
        type: "string",
        description: "Branch to merge INTO the current HEAD."
      },
      no_ff: {
        type: "boolean",
        description: "--no-ff (default true)."
      },
      allow_unrelated_histories: {
        type: "boolean",
        description: "--allow-unrelated-histories (default false; setting true requires override_protected_branch)."
      },
      dev_approval: {
        type: "object",
        description: "dev_approval payload."
      }
    },
    required: ["source_branch", "dev_approval"],
    additionalProperties: false
  }
};
async function requestMergeHandler(rawInput, internal = {}) {
  const input = requestMergeInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config ?? void 0;
  const gitExecutor = internal.gitExecutor ?? defaultGitExecutor;
  const promptFn = internal.promptFn ?? promptYesNo;
  const now = internal.now ?? /* @__PURE__ */ new Date();
  const gitState = internal.gitStateOverride ?? readGitState(projectRoot);
  const targetBranch = gitState.branch;
  const targetLabel = targetBranch ?? "<no-branch>";
  const no_ff = input.no_ff ?? true;
  const allow_unrelated_histories = input.allow_unrelated_histories ?? false;
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval;
  const gate = await gateRequest({
    toolName: "rsct_request_merge",
    approval: input.dev_approval,
    dialog: {
      title: "RSCT \xA7C \u2014 merge approval",
      message: `Approve merge of '${input.source_branch}' into '${targetLabel}'${no_ff ? " (--no-ff)" : ""}${allow_unrelated_histories ? " (--allow-unrelated-histories)" : ""}?`
    },
    projectRoot,
    ...config?.approval_modes !== void 0 && { approvalModes: config.approval_modes },
    promptFn,
    now
  });
  if (gate.status === "rejected") {
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_merge.rejected",
        tool: "rsct_request_merge",
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        fabrication_signals: gate.fabrication_signals
      },
      config?.audit
    );
    return {
      status: "rejected",
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields3(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`\xA7C rejected (${gate.reject_kind}): ${gate.reason}`]
    };
  }
  const approval = gate.approval;
  const overrideBranch = approval.override_protected_branch;
  if (targetBranch === null) {
    const reason = "cannot merge onto a detached HEAD \u2014 checkout the target branch first";
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_merge.rejected",
        tool: "rsct_request_merge",
        reject_kind: "detached_head",
        reason,
        source_branch: input.source_branch,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "rejected",
      source_branch: input.source_branch,
      target_branch: null,
      channel: gate.channel,
      reject_kind: "detached_head",
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: null,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields3(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  if (input.source_branch === targetBranch) {
    const reason = `cannot merge '${input.source_branch}' into itself`;
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_merge.rejected",
        tool: "rsct_request_merge",
        reject_kind: "same_branch",
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "rejected",
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: "same_branch",
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields3(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  if (allow_unrelated_histories && !overrideBranch) {
    const reason = "--allow-unrelated-histories is force-like and requires dev_approval.override_protected_branch: { reason }";
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_merge.rejected",
        tool: "rsct_request_merge",
        reject_kind: "unrelated_histories_without_override",
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "rejected",
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: "unrelated_histories_without_override",
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: false, override_used: false },
      ...auditFields3(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  const { list: protectedList } = effectiveProtectedList(config);
  const targetProtected = isProtectedBranch(targetBranch, protectedList);
  if (targetProtected && !overrideBranch) {
    const reason = `target branch '${targetLabel}' is protected \u2014 pass dev_approval.override_protected_branch: { reason } to merge`;
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_merge.rejected",
        tool: "rsct_request_merge",
        reject_kind: "protected_branch",
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "rejected",
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: "protected_branch",
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: gitState.head_sha,
      sha_after: null,
      branch_check: { protected: true, override_used: false },
      ...auditFields3(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [reason]
    };
  }
  if ((targetProtected || allow_unrelated_histories) && overrideBranch) {
    appendAudit(
      projectRoot,
      {
        event: "request_merge.override_invoked",
        tool: "rsct_request_merge",
        override_kind: "protected_branch",
        override_reason: overrideBranch.reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        allow_unrelated_histories,
        channel: gate.channel
      },
      config?.audit
    );
  }
  const merge = gitMerge(
    projectRoot,
    input.source_branch,
    { no_ff, allow_unrelated_histories },
    gitExecutor
  );
  if (!merge.ok) {
    const reason = merge.error ?? merge.stderr ?? "git merge failed";
    const audit2 = appendAudit(
      projectRoot,
      {
        event: "request_merge.mutation_failed",
        tool: "rsct_request_merge",
        reason,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        channel: gate.channel
      },
      config?.audit
    );
    return {
      status: "mutation_failed",
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      reject_kind: null,
      reason,
      fabrication_signals: gate.fabrication_signals,
      sha_before: merge.sha_before,
      sha_after: null,
      branch_check: { protected: targetProtected, override_used: targetProtected || allow_unrelated_histories },
      ...auditFields3(audit2),
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: ["git merge failed \u2014 approval NOT consumed. Resolve conflicts or fix the error, then retry with the same dev_approval."]
    };
  }
  const record = recordApproval(approval, { projectRoot, now });
  const audit = appendAudit(
    projectRoot,
    {
      event: "request_merge.merged",
      tool: "rsct_request_merge",
      source_branch: input.source_branch,
      target_branch: targetBranch,
      channel: gate.channel,
      sha_before: merge.sha_before,
      sha_after: merge.sha_after,
      no_ff,
      allow_unrelated_histories,
      fabrication_signals: gate.fabrication_signals
    },
    config?.audit
  );
  const hints = [
    `Merged '${input.source_branch}' into '${targetLabel}' (${merge.sha_after ?? "<unknown sha>"}).`
  ];
  if (!record.ok) {
    hints.push(
      `\u26A0 merge landed but anti-replay store update failed: ${record.error}. The same dev_approval (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}') may be replayable within the skew window \u2014 rotate the approval or repair .rsct/approvals-seen.json before the next \xA7C-gated call.`
    );
  }
  const afields = auditFields3(audit);
  if (afields.audit_error !== null) {
    hints.push(
      `\u26A0 merge landed but audit log write failed: ${afields.audit_error}. Manual audit reconstruction may be needed for forensic traceability.`
    );
  }
  const bootstrap = evaluateBootstrapMarker({ projectRoot, now });
  if (bootstrap.status !== "fresh") {
    if (bootstrap.hint) hints.push(bootstrap.hint);
    appendAudit(
      projectRoot,
      {
        event: "request_merge.bootstrap_warning",
        tool: "rsct_request_merge",
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms,
        source_branch: input.source_branch,
        target_branch: targetBranch,
        sha_after: merge.sha_after
      },
      config?.audit
    );
  }
  const activePlan = findActivePlan(projectRoot);
  if (activePlan && isPlanComplete(activePlan.status)) {
    hints.push(
      `\u2139 Plan '${activePlan.slug}' is marked complete. Optional, with your OK (never automated): (1) delete the merged working branch '${input.source_branch}' (local + remote), and (2) delete plan_/progress_/spec_${activePlan.slug}.md so they never reach a protected branch. The same cleanup applies after a GitHub PR merge \u2014 merge commit, squash, or rebase.`
    );
  }
  return {
    status: "merged",
    source_branch: input.source_branch,
    target_branch: targetBranch,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    sha_before: merge.sha_before,
    sha_after: merge.sha_after,
    branch_check: { protected: targetProtected, override_used: targetProtected || allow_unrelated_histories },
    bootstrap_marker: bootstrap,
    ...afields,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error,
    hints
  };
}
function auditFields3(r) {
  if (r.ok) return { audit_path: r.path, audit_error: null };
  if (r.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: r.path ?? null,
    audit_error: r.error ?? "write_failed"
  };
}
var DEFAULT_LANG_GLOBS = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs"
];
var DEFAULT_EXCLUDE_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**"
];
var DEFAULT_MAX_DEPTH = 2;
var RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
];
var INDEX_RESOLUTIONS = [
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs"
];
var IMPORT_PATTERNS = [
  /import\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g
];
function toPosix(p) {
  return p.split("\\").join("/");
}
function relPosix(projectRoot, abs) {
  return toPosix(relative(projectRoot, abs));
}
function walkFiles(root, langGlobs, excludeGlobs) {
  const results = [];
  const recurse = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relPosix(root, full);
      if (entry.isDirectory()) {
        if (matchesAnyGlob(`${rel}/probe`, excludeGlobs).matched) continue;
        recurse(full);
      } else if (entry.isFile()) {
        if (matchesAnyGlob(rel, excludeGlobs).matched) continue;
        if (matchesAnyGlob(rel, langGlobs).matched) results.push(full);
      }
    }
  };
  recurse(root);
  return results;
}
function extractImports(content) {
  const imports = /* @__PURE__ */ new Set();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (spec) imports.add(spec);
    }
  }
  return [...imports];
}
function resolveImport(importerAbs, spec) {
  if (!spec.startsWith(".") && !isAbsolute(spec)) return null;
  const target = isAbsolute(spec) ? spec : resolve(dirname(importerAbs), spec);
  if (existsSync(target)) {
    try {
      const s = statSync(target);
      if (s.isFile()) return target;
      if (s.isDirectory()) {
        for (const idx of INDEX_RESOLUTIONS) {
          const candidate = target + idx;
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
    }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = target + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function walkReverseDeps(input) {
  const projectRoot = input.projectRoot;
  const langGlobs = input.langGlobs ?? DEFAULT_LANG_GLOBS;
  const excludeGlobs = input.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS;
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const declared = input.seedPaths.map((p) => {
    const abs = isAbsolute(p) ? p : resolve(projectRoot, p);
    return relPosix(projectRoot, abs);
  });
  const hints = [];
  const stats = {
    files_scanned: 0,
    files_parsed: 0,
    parse_errors: 0,
    cycles_skipped: 0
  };
  if (declared.length === 0) {
    hints.push("No seed paths provided \u2014 reverse-dep walk skipped.");
    return { declared, discovered: [], stats, hints };
  }
  if (!existsSync(projectRoot)) {
    hints.push(
      `projectRoot '${projectRoot}' does not exist \u2014 reverse-dep walk skipped.`
    );
    return { declared, discovered: [], stats, hints };
  }
  if (maxDepth < 1) {
    hints.push(
      `maxDepth=${maxDepth} < 1 \u2014 reverse-dep walk has no depth budget; returning declared only.`
    );
    return { declared, discovered: [], stats, hints };
  }
  const candidates = walkFiles(projectRoot, langGlobs, excludeGlobs);
  stats.files_scanned = candidates.length;
  const reverseDeps = /* @__PURE__ */ new Map();
  for (const candidateAbs of candidates) {
    let content;
    try {
      content = readFileSync(candidateAbs, "utf8");
      stats.files_parsed++;
    } catch {
      stats.parse_errors++;
      continue;
    }
    const candidateRel = relPosix(projectRoot, candidateAbs);
    const imports = extractImports(content);
    for (const spec of imports) {
      const resolvedAbs = resolveImport(candidateAbs, spec);
      if (!resolvedAbs) continue;
      const resolvedRel = relPosix(projectRoot, resolvedAbs);
      if (resolvedRel === candidateRel) continue;
      let set = reverseDeps.get(resolvedRel);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        reverseDeps.set(resolvedRel, set);
      }
      set.add(candidateRel);
    }
  }
  const seen = new Set(declared);
  const discoveredMap = /* @__PURE__ */ new Map();
  const queue = declared.map((d) => ({ file: d, depth: 0, via: [d] }));
  while (queue.length > 0) {
    const item = queue.shift();
    if (item.depth >= maxDepth) continue;
    const importers = reverseDeps.get(item.file);
    if (!importers) continue;
    for (const importer of importers) {
      if (seen.has(importer)) {
        if (declared.includes(importer)) stats.cycles_skipped++;
        continue;
      }
      seen.add(importer);
      const nextDepth = item.depth + 1;
      const nextVia = [...item.via, importer];
      discoveredMap.set(importer, {
        file: importer,
        via_paths: nextVia,
        depth: nextDepth
      });
      if (nextDepth < maxDepth) {
        queue.push({ file: importer, depth: nextDepth, via: nextVia });
      }
    }
  }
  const discovered = [...discoveredMap.values()].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.file.localeCompare(b.file);
  });
  if (discovered.length === 0 && stats.files_scanned > 0) {
    hints.push(
      `Reverse-dep walk found 0 importers across ${stats.files_scanned} scanned files. If you expected importers, check that seed paths use project-relative posix form (e.g., 'src/lib/foo.ts') and that the project does not rely on tsconfig path aliases (not resolved in v1).`
    );
  }
  if (stats.parse_errors > 0) {
    hints.push(
      `${stats.parse_errors} file(s) failed to read and were excluded from the import graph.`
    );
  }
  if (stats.cycles_skipped > 0) {
    hints.push(
      `${stats.cycles_skipped} cycle path(s) skipped where a seed is also an importer of another seed.`
    );
  }
  return { declared, discovered, stats, hints };
}
var CATEGORY_PROMPTS = {
  "business-rules": "Did the spec consider business-rules.md? Check for invariants or compliance constraints.",
  "anti-decisions": "Did the spec consult anti-decisions.md? Avoid re-trying abandoned paths.",
  "cost-constraints": "Did the spec consider cost impact ($/month, infra footprint, free-tier limits)?",
  "vendor-relationships": "Does the spec lock into or depend on a vendor? Cross-check vendor-relationships.md.",
  "incident-log": "Are there past incidents touching this area? Check incident-log.md before proceeding.",
  "stakeholder-map": "Did the spec inform the right stakeholders? Check stakeholder-map.md.",
  "team-capabilities": "Does the team currently have the capability to maintain this? Check team-capabilities.md.",
  "workflow-rituals": "Does the change require updating a workflow ritual? Check workflow-rituals.md.",
  "domain-edge-cases": "Did the spec cover known domain edge cases? Check domain-edge-cases.md.",
  "business-glossary": "Does the spec use established terminology from business-glossary.md?"
};
var COMMON_BASENAMES = /* @__PURE__ */ new Set([
  "index",
  "utils",
  "util",
  "helpers",
  "helper",
  "types",
  "common",
  "main"
]);
function makeIdGenerator() {
  let counter = 0;
  return (cat) => `v-${cat}-${++counter}`;
}
function stripExt(p) {
  return basename(p).replace(/\.[^.]+$/, "");
}
function runVerificationChecklist(input) {
  const findings = [];
  const hints = [];
  const nextId = makeIdGenerator();
  const stats = {
    categories_run: [],
    knowledge_categories_present: [],
    knowledge_categories_missing: [],
    decisions_scanned: 0,
    anti_decisions_scanned: 0,
    impact_docs_consulted: 0,
    architecture_overview_present: false
  };
  if (input.specTier === "trivial" || input.specTier === "small") {
    hints.push(
      `spec_tier=${input.specTier} \u2014 verification checklist skipped per tier table.`
    );
    return { findings, stats, hints };
  }
  const decisions = readDecisions(input.projectRoot);
  const antiDecisions = readAntiDecisions(input.projectRoot);
  const knowledge = readKnowledgeIndex(input.projectRoot);
  const architecture = readArchitectureOverview(input.projectRoot);
  const impactModules = readArchitectureModules(input.projectRoot, "impact");
  stats.decisions_scanned = decisions.premises.length + decisions.adrs.length;
  stats.anti_decisions_scanned = antiDecisions.entries.length;
  stats.knowledge_categories_present = [...knowledge.categories_present];
  stats.knowledge_categories_missing = [...knowledge.categories_missing];
  stats.architecture_overview_present = architecture.exists;
  stats.impact_docs_consulted = impactModules.files.length;
  stats.categories_run.push("gap");
  if (input.specClaims && input.specClaims.length > 0) {
    const corpus = [...decisions.premises, ...decisions.adrs];
    for (const claim of input.specClaims) {
      const result = checkPremise(claim, corpus, antiDecisions.entries);
      const antiHit = result.anti_decision_matches[0];
      if (antiHit) {
        findings.push({
          id: nextId("gap"),
          category: "gap",
          severity: "block",
          title: `Anti-decision hit: ${antiHit.entry.id} \u2014 ${antiHit.entry.title}`,
          detail: `Claim "${claim}" overlaps an anti-decision. Read ${antiHit.entry.id} before proceeding; require a revisit_reason if the dev wants to retry.`,
          affected_paths: [...input.declaredPaths],
          source: "premise-check"
        });
        continue;
      }
      const topMatch = result.matches[0];
      if (result.recommendation === "conflict" && topMatch) {
        findings.push({
          id: nextId("gap"),
          category: "gap",
          severity: "address-now",
          title: `Conflict with ${topMatch.entry.id}: ${topMatch.entry.title}`,
          detail: `Claim "${claim}" matches a decision with rollback/rejection language. Surface ${topMatch.entry.id} to the dev and confirm the revisit is intentional.`,
          affected_paths: [...input.declaredPaths],
          source: "premise-check"
        });
      } else if (result.recommendation === "requires_revision" && topMatch) {
        findings.push({
          id: nextId("gap"),
          category: "gap",
          severity: "address-now",
          title: `Requires revision: matches ${topMatch.entry.id}`,
          detail: `Claim "${claim}" shares vocabulary with ${topMatch.entry.id} (${topMatch.entry.title}). Read the entry and align the claim or surface an explicit override.`,
          affected_paths: [...input.declaredPaths],
          source: "premise-check"
        });
      }
    }
  } else if (decisions.exists || antiDecisions.exists) {
    hints.push(
      "No specClaims provided \u2014 premise check skipped. Pass specClaims[] extracted from the spec to enable the gap category."
    );
  }
  stats.categories_run.push("breakage");
  if (input.discoveredImporters.length > 0) {
    const grouped = /* @__PURE__ */ new Map();
    for (const imp of input.discoveredImporters) {
      const seed = imp.via_paths[0] ?? "<unknown-seed>";
      let list = grouped.get(seed);
      if (!list) {
        list = [];
        grouped.set(seed, list);
      }
      list.push(imp);
    }
    for (const [seed, importers] of grouped) {
      const directCount = importers.filter((i) => i.depth === 1).length;
      const transCount = importers.length - directCount;
      const severity = directCount > 5 ? "address-now" : directCount > 0 ? "capture-as-issue" : "defer";
      const head = importers.slice(0, 10).map((i) => `  - ${i.file} (depth ${i.depth})`).join("\n");
      const overflow = importers.length > 10 ? `
  ... and ${importers.length - 10} more` : "";
      findings.push({
        id: nextId("breakage"),
        category: "breakage",
        severity,
        title: `Edits to ${seed} affect ${importers.length} importer(s) (${directCount} direct, ${transCount} transitive)`,
        detail: `Reverse-dep walk surfaced these files as candidates for breakage when ${seed} changes:
${head}${overflow}`,
        affected_paths: [seed, ...importers.map((i) => i.file)],
        source: "reverse-dep-walk"
      });
    }
  }
  for (const declaredPath of input.declaredPaths) {
    const guess = stripExt(declaredPath);
    const impactDoc = impactModules.files.find((f) => f.name === guess);
    if (impactDoc) {
      findings.push({
        id: nextId("breakage"),
        category: "breakage",
        severity: "address-now",
        title: `Impact doc exists for ${guess}`,
        detail: `documentation/impact/${guess}.md exists. Read it for non-obvious couplings and pre-merge checklists before editing ${declaredPath}.`,
        affected_paths: [declaredPath, impactDoc.path],
        source: "impact-doc"
      });
    }
  }
  stats.categories_run.push("redundancy");
  if (input.existingProjectFiles && input.existingProjectFiles.length > 0) {
    const declaredSet = new Set(input.declaredPaths);
    for (const declaredPath of input.declaredPaths) {
      const moduleName = stripExt(declaredPath);
      if (moduleName.length < 4) continue;
      if (COMMON_BASENAMES.has(moduleName)) continue;
      const overlaps = input.existingProjectFiles.filter((f) => {
        if (declaredSet.has(f)) return false;
        return stripExt(f) === moduleName;
      });
      if (overlaps.length > 0) {
        findings.push({
          id: nextId("redundancy"),
          category: "redundancy",
          severity: "capture-as-issue",
          title: `Possible redundancy: '${moduleName}' already in ${overlaps.length} other location(s)`,
          detail: `Declared path '${declaredPath}' has basename '${moduleName}', which already appears in: ${overlaps.slice(0, 5).join(", ")}${overlaps.length > 5 ? "..." : ""}. Consider whether the new file duplicates existing functionality.`,
          affected_paths: [declaredPath, ...overlaps],
          source: "basename-overlap"
        });
      }
    }
  }
  stats.categories_run.push("forgotten");
  const tierMaxPrompts = input.specTier === "complex" ? 10 : 5;
  let promptedCount = 0;
  for (const cat of knowledge.categories_present) {
    if (promptedCount >= tierMaxPrompts) break;
    const prompt = CATEGORY_PROMPTS[cat];
    if (!prompt) continue;
    findings.push({
      id: nextId("forgotten"),
      category: "forgotten",
      severity: "defer",
      title: `Checklist: ${cat}`,
      detail: prompt,
      affected_paths: [...input.declaredPaths],
      source: `knowledge-category:${cat}`
    });
    promptedCount++;
  }
  if (architecture.exists && architecture.sections.length > 0) {
    findings.push({
      id: nextId("forgotten"),
      category: "forgotten",
      severity: "defer",
      title: "Checklist: architecture overview",
      detail: `documentation/architecture.md has ${architecture.sections.length} sections. Confirm the spec aligns with the documented architecture before code-phase.`,
      affected_paths: [...input.declaredPaths],
      source: "architecture-overview"
    });
  }
  if (findings.length === 0) {
    if (!decisions.exists && !antiDecisions.exists && knowledge.categories_present.length === 0 && !architecture.exists) {
      hints.push(
        "Verification corpus is empty (no decisions.md, anti-decisions.md, knowledge categories, or architecture.md). Bootstrap via /rsct-setup so this checklist has signal to surface."
      );
    } else {
      hints.push(
        "Verification checklist found no findings to surface against the available corpus."
      );
    }
  }
  return { findings, stats, hints };
}

// src/tools/phase-verification-start.ts
var TIER_VALUES = ["trivial", "small", "standard", "complex"];
var phaseVerificationStartInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  spec_ref: z.string().min(1, "spec_ref required").describe(
    'Free-form spec identifier \u2014 typically the plan slug (e.g., "feat-aprovacao") or a path to plan_<slug>.md. Used to correlate start/complete and as audit key.'
  ),
  declared_paths: z.array(z.string()).default([]).describe("Project-relative paths the spec declares as affected. Used as seeds for reverse-dep walk."),
  spec_claims: z.array(z.string().min(5)).optional().describe("Short claim sentences extracted from the spec, each scanned via lib/premise-check against decisions + anti-decisions."),
  spec_tier: z.enum(TIER_VALUES).default("standard").describe("Tier per rsct_classify_task (pending its arrival). trivial+small skip the V phase; standard runs; complex runs and mandates _complete before code-start."),
  persona: z.string().optional().describe("Optional persona slug to bias the checklist lens (F3 personas). Accepted today but no-op until F3 ships; logged into audit as requested_persona."),
  max_depth: z.number().int().min(0).max(10).default(2).describe("Reverse-dep walk depth budget. 1 = direct importers only; default 2 covers two hops."),
  existing_project_files: z.array(z.string()).optional().describe("Optional list of all project files (project-relative posix) for the redundancy basename-overlap check. When absent, redundancy check is skipped.")
}).strict();
var phaseVerificationStartTool = {
  name: "rsct_phase_verification_start",
  description: "Start the V (Verification) phase between spec-approval and code-edit. Runs the reverse-dependency walk over declared_paths, executes the checklist (gap / breakage / redundancy / forgotten) against the project decisions + knowledge + architecture + impact docs, writes the verification block into .rsct/phase-state.json, and emits one audit event per finding. For spec_tier=trivial|small the phase is skipped (audit-only). Findings are recommendations \u2014 dev sets the action on each via rsct_phase_verification_complete.",
  inputSchema: {
    type: "object",
    required: ["spec_ref"],
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      spec_ref: {
        type: "string",
        description: "Free-form spec identifier (plan slug or plan_<slug>.md path)."
      },
      declared_paths: {
        type: "array",
        items: { type: "string" },
        description: "Project-relative paths the spec declares as affected. Seed set for reverse-dep walk."
      },
      spec_claims: {
        type: "array",
        items: { type: "string" },
        description: "Short claim sentences from the spec scanned for premise / anti-decision overlap."
      },
      spec_tier: {
        type: "string",
        enum: [...TIER_VALUES],
        default: "standard",
        description: "trivial+small skip the V phase; standard runs; complex runs + mandates _complete."
      },
      persona: {
        type: "string",
        description: "Optional persona slug; no-op until F3 ships. Logged into audit as requested_persona."
      },
      max_depth: {
        type: "number",
        default: 2,
        description: "Reverse-dep walk depth (1 = direct importers only)."
      },
      existing_project_files: {
        type: "array",
        items: { type: "string" },
        description: "Optional project-file index for redundancy basename-overlap check."
      }
    },
    additionalProperties: false
  }
};
function auditFields4(audit) {
  if (audit.ok) return { audit_path: audit.path, audit_error: null };
  if (audit.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? "write_failed"
  };
}
async function phaseVerificationStartHandler(rawInput) {
  const input = phaseVerificationStartInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config;
  const phaseStatePathStr = phaseStatePath(projectRoot);
  const requestedPersona = input.persona ?? null;
  const walk = walkReverseDeps({
    projectRoot,
    seedPaths: input.declared_paths,
    maxDepth: input.max_depth
  });
  const checklistArgs = {
    projectRoot,
    declaredPaths: walk.declared,
    discoveredImporters: walk.discovered,
    specTier: input.spec_tier
  };
  if (input.spec_claims !== void 0) checklistArgs.specClaims = input.spec_claims;
  if (input.existing_project_files !== void 0) {
    checklistArgs.existingProjectFiles = input.existing_project_files;
  }
  const checklist = runVerificationChecklist(checklistArgs);
  if (input.spec_tier === "trivial" || input.spec_tier === "small") {
    const skipAudit = appendAuditEntry(
      projectRoot,
      {
        event: "verification.skip",
        tool: "rsct_phase_verification_start",
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        requested_persona: requestedPersona
      },
      config?.audit
    );
    const fields2 = auditFields4(skipAudit);
    return {
      status: "skipped_tier",
      rsct_installed: resolution.rsct_installed,
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_paths: walk.declared,
      discovered_importers: [],
      findings: [],
      walk_stats: walk.stats,
      checklist_stats: checklist.stats,
      phase_state_path: phaseStatePathStr,
      phase_state_written: false,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      hints: [
        ...walk.hints,
        ...checklist.hints,
        `spec_tier=${input.spec_tier} \u2014 V phase skipped per tier table; no phase-state write.`
      ]
    };
  }
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const existing = readPhaseState(projectRoot);
  const baseState = existing.state ?? {};
  const verificationBlock = {
    spec_ref: input.spec_ref,
    spec_tier: input.spec_tier,
    declared_paths: walk.declared,
    discovered_importers: walk.discovered,
    findings: checklist.findings,
    started_at: startedAt
  };
  if (requestedPersona !== null) verificationBlock.persona = requestedPersona;
  const newState = {
    ...baseState,
    phase: "verification",
    spec_slug: baseState.spec_slug ?? input.spec_ref,
    verification: verificationBlock
  };
  const writeResult = writePhaseState(projectRoot, newState);
  const startAudit = appendAuditEntry(
    projectRoot,
    {
      event: "verification.start",
      tool: "rsct_phase_verification_start",
      spec_ref: input.spec_ref,
      spec_tier: input.spec_tier,
      requested_persona: requestedPersona,
      declared_count: walk.declared.length,
      discovered_count: walk.discovered.length,
      findings_count: checklist.findings.length,
      phase_state_written: writeResult.ok
    },
    config?.audit
  );
  for (const finding of checklist.findings) {
    appendAuditEntry(
      projectRoot,
      {
        event: "verification.finding",
        tool: "rsct_phase_verification_start",
        spec_ref: input.spec_ref,
        finding_id: finding.id,
        category: finding.category,
        severity: finding.severity,
        source: finding.source,
        title: finding.title
      },
      config?.audit
    );
  }
  const fields = auditFields4(startAudit);
  const hints = [];
  if (writeResult.ok) {
    hints.push(
      `Phase state written to ${writeResult.path}. ${checklist.findings.length} finding(s) surfaced \u2014 review and call rsct_phase_verification_complete with findings_actions[] + dev_approval.`
    );
  } else if (writeResult.reason === "locked") {
    hints.push(
      `\u26A0 phase-state.json is locked (held ${writeResult.lock_age_ms}ms by session ${writeResult.held_by_session ?? "unknown"}). Another writer is active \u2014 wait and retry. Verification ran but state was not persisted.`
    );
  } else {
    hints.push(
      `\u26A0 phase-state.json write failed: ${writeResult.error}. Verification ran but state was not persisted; rsct_phase_verification_complete will not find an active block.`
    );
  }
  hints.push(...walk.hints);
  hints.push(...checklist.hints);
  if (fields.audit_error !== null) {
    hints.push(`\u26A0 audit log write failed: ${fields.audit_error}.`);
  }
  return {
    status: writeResult.ok ? "verified" : "state_write_failed",
    rsct_installed: resolution.rsct_installed,
    spec_ref: input.spec_ref,
    spec_tier: input.spec_tier,
    requested_persona: requestedPersona,
    declared_paths: walk.declared,
    discovered_importers: walk.discovered,
    findings: checklist.findings,
    walk_stats: walk.stats,
    checklist_stats: checklist.stats,
    phase_state_path: phaseStatePathStr,
    phase_state_written: writeResult.ok,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    hints
  };
}
var ACTION_VALUES = [
  "accept",
  "address-now",
  "capture-as-issue",
  "defer",
  "block"
];
var findingActionSchema = z.object({
  finding_id: z.string().min(1, "finding_id required"),
  action: z.enum(ACTION_VALUES),
  note: z.string().optional()
}).strict();
var phaseVerificationCompleteInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  spec_ref: z.string().min(1, "spec_ref required").describe("Must match the spec_ref recorded by the open V phase in .rsct/phase-state.json."),
  findings_actions: z.array(findingActionSchema).default([]).describe('Per-finding actions chosen by the dev. Any action="block" aborts completion.'),
  dev_approval: z.unknown().describe("The dev_approval payload. Validated via lib/dev-approval (schema/skew/anti-reuse/fabrication)."),
  clear_phase: z.boolean().default(true).describe("When true, also clears the active phase block (phase/scope_globs/started_at). When false, only the verification sub-block is cleared.")
}).strict();
var phaseVerificationCompleteTool = {
  name: "rsct_phase_verification_complete",
  description: '\xA7C-gated V phase closure. Reads .rsct/phase-state.json (must contain an active verification block with matching spec_ref), validates dev_approval (schema/skew/anti-reuse/fabrication), pops an OS dialog when required, then writes the per-action audit entries + a verification.complete event and clears the verification block (and optionally the active phase). Suggested dev_approval.action_scope format: "verification_complete:spec_ref=<X>". Any findings_actions entry with action="block" aborts completion before the \xA7C dialog.',
  inputSchema: {
    type: "object",
    required: ["spec_ref", "dev_approval"],
    properties: {
      project_root: {
        type: "string",
        description: "Optional absolute path to override project root detection."
      },
      spec_ref: {
        type: "string",
        description: "Must match the open V phase spec_ref."
      },
      findings_actions: {
        type: "array",
        description: 'Per-finding actions. action="block" aborts completion.',
        items: {
          type: "object",
          required: ["finding_id", "action"],
          properties: {
            finding_id: { type: "string" },
            action: {
              type: "string",
              enum: [...ACTION_VALUES]
            },
            note: { type: "string" }
          },
          additionalProperties: false
        }
      },
      dev_approval: {
        type: "object",
        description: "The dev_approval payload (timestamp, action_scope, reason)."
      },
      clear_phase: {
        type: "boolean",
        default: true,
        description: "When true, clears the active phase block in addition to verification."
      }
    },
    additionalProperties: false
  }
};
function auditFields5(audit) {
  if (audit.ok) return { audit_path: audit.path, audit_error: null };
  if (audit.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? "write_failed"
  };
}
function emptySummary() {
  return {
    accept: 0,
    "address-now": 0,
    "capture-as-issue": 0,
    defer: 0,
    block: 0
  };
}
async function phaseVerificationCompleteHandler(rawInput, internal = {}) {
  const input = phaseVerificationCompleteInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config;
  const promptFn = internal.promptFn ?? promptYesNo;
  const now = internal.now ?? /* @__PURE__ */ new Date();
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval;
  const summary = emptySummary();
  for (const fa of input.findings_actions) {
    summary[fa.action]++;
  }
  const existing = readPhaseState(projectRoot);
  if (!existing.exists || !existing.state?.verification) {
    return {
      status: "no_active_verification",
      channel: null,
      reject_kind: null,
      reason: "no active verification block in .rsct/phase-state.json \u2014 call rsct_phase_verification_start first",
      fabrication_signals: [],
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        "No verification block in phase-state.json. Run rsct_phase_verification_start before _complete."
      ]
    };
  }
  const existingSpecRef = existing.state.verification.spec_ref;
  if (existingSpecRef && existingSpecRef !== input.spec_ref) {
    const audit = appendAudit(
      projectRoot,
      {
        event: "verification.complete.rejected",
        tool: "rsct_phase_verification_complete",
        spec_ref: input.spec_ref,
        reject_kind: "spec_ref_mismatch",
        existing_spec_ref: existingSpecRef
      },
      config?.audit
    );
    const fields2 = auditFields5(audit);
    return {
      status: "rejected",
      channel: null,
      reject_kind: "spec_ref_mismatch",
      reason: `verification block holds spec_ref='${existingSpecRef}' but input is '${input.spec_ref}'`,
      fabrication_signals: [],
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `spec_ref mismatch \u2014 pass the same spec_ref that started this V phase ('${existingSpecRef}').`
      ]
    };
  }
  if (summary.block > 0) {
    const audit = appendAudit(
      projectRoot,
      {
        event: "verification.complete.rejected",
        tool: "rsct_phase_verification_complete",
        spec_ref: input.spec_ref,
        reject_kind: "block_actions_present",
        blocked_count: summary.block
      },
      config?.audit
    );
    const fields2 = auditFields5(audit);
    return {
      status: "rejected",
      channel: null,
      reject_kind: "block_actions_present",
      reason: `${summary.block} finding(s) marked as block \u2014 cannot complete V phase`,
      fabrication_signals: [],
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        "One or more findings have action=block. Address them (change action to address-now/capture-as-issue/defer/accept) before retrying."
      ]
    };
  }
  const gate = await gateRequest({
    toolName: "rsct_phase_verification_complete",
    approval: input.dev_approval,
    dialog: {
      title: "RSCT \xA7C \u2014 verification complete",
      message: `Complete V phase for spec '${input.spec_ref}'?

${input.findings_actions.length} action(s): ${summary["address-now"]} address-now, ${summary["capture-as-issue"]} capture, ${summary.defer} defer, ${summary.accept} accept`
    },
    projectRoot,
    ...config?.approval_modes !== void 0 && {
      approvalModes: config.approval_modes
    },
    promptFn,
    now
  });
  if (gate.status === "rejected") {
    const audit = appendAudit(
      projectRoot,
      {
        event: "verification.complete.rejected",
        tool: "rsct_phase_verification_complete",
        spec_ref: input.spec_ref,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        fabrication_signals: gate.fabrication_signals
      },
      config?.audit
    );
    const fields2 = auditFields5(audit);
    return {
      status: "rejected",
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      spec_ref: input.spec_ref,
      cleared_verification: false,
      cleared_phase: false,
      actions_summary: summary,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`\xA7C rejected (${gate.reject_kind}): ${gate.reason}`]
    };
  }
  for (const fa of input.findings_actions) {
    appendAudit(
      projectRoot,
      {
        event: "verification.action",
        tool: "rsct_phase_verification_complete",
        spec_ref: input.spec_ref,
        finding_id: fa.finding_id,
        action: fa.action,
        ...fa.note ? { note: fa.note } : {}
      },
      config?.audit
    );
  }
  const completedAt = (/* @__PURE__ */ new Date()).toISOString();
  const newState = { ...existing.state };
  const prevV = existing.state.verification;
  const completedV = {
    completed_at: completedAt
  };
  if (prevV?.spec_ref !== void 0) completedV.spec_ref = prevV.spec_ref;
  if (prevV?.spec_tier !== void 0) completedV.spec_tier = prevV.spec_tier;
  if (prevV?.started_at !== void 0) completedV.started_at = prevV.started_at;
  if (prevV?.persona !== void 0) completedV.persona = prevV.persona;
  newState.verification = completedV;
  if (input.clear_phase) {
    delete newState.phase;
    delete newState.scope_globs;
    delete newState.started_at;
  }
  const writeResult = writePhaseState(projectRoot, newState);
  const completeAudit = appendAudit(
    projectRoot,
    {
      event: "verification.complete",
      tool: "rsct_phase_verification_complete",
      spec_ref: input.spec_ref,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
      actions_summary: summary,
      cleared_phase: input.clear_phase,
      completed_at: completedAt,
      phase_state_written: writeResult.ok
    },
    config?.audit
  );
  const record = recordApproval(gate.approval, { projectRoot, now });
  const fields = auditFields5(completeAudit);
  const hints = [];
  if (writeResult.ok) {
    hints.push(
      `V phase completed for spec '${input.spec_ref}'. ${input.findings_actions.length} action(s) recorded; verification block cleared${input.clear_phase ? " and active phase reset" : ""}.`
    );
  } else if (writeResult.reason === "locked") {
    hints.push(
      `\u26A0 V phase approved but phase-state.json is locked (held ${writeResult.lock_age_ms}ms by session ${writeResult.held_by_session ?? "unknown"}). State may be inconsistent; wait and retry, or manual cleanup may be needed.`
    );
  } else {
    hints.push(
      `\u26A0 V phase approved but phase-state.json write failed: ${writeResult.error}. State may be inconsistent; manual cleanup may be needed.`
    );
  }
  if (!record.ok) {
    hints.push(
      `\u26A0 Anti-replay store update failed: ${record.error}. The same dev_approval may be replayable within the skew window \u2014 rotate the approval or repair .rsct/approvals-seen.json before the next \xA7C-gated call.`
    );
  }
  if (fields.audit_error !== null) {
    hints.push(`\u26A0 verification.complete audit write failed: ${fields.audit_error}.`);
  }
  return {
    status: writeResult.ok ? "completed" : "state_write_failed",
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    spec_ref: input.spec_ref,
    cleared_verification: writeResult.ok,
    cleared_phase: writeResult.ok && input.clear_phase,
    actions_summary: summary,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error ?? null,
    hints
  };
}
var classifyTaskInputSchema = z.object({
  project_root: z.string().optional(),
  task_description: z.string().min(3, "task_description required (\u22653 chars)").describe(
    "Free-form natural-language description of the task. Heuristic v1 scans this text."
  ),
  use_active_plan_slug: z.boolean().default(false).describe(
    "When true, look up the most-recent plan_<slug>.md in the project root and surface the slug + status in the response. Does NOT change the tier."
  )
}).strict();
var classifyTaskTool = {
  name: "rsct_classify_task",
  description: "Heuristic-only task classifier. Scans task_description for keyword signals (architecture / security / multi-file / mutation / docs / typo) AND multi-concern + step-count signals (CAP-29) and returns a tier (trivial|small|standard|complex) + the recommended RSCT phase sequence. Tier recommendations are advisory at this layer; rsct_phase_code_start enforces the V gate mechanically per CAP-28 (standard+complex require completed verification). Optional `use_active_plan_slug` lifts the slug+status of the most-recent plan_<slug>.md into the response for context.",
  inputSchema: {
    type: "object",
    required: ["task_description"],
    properties: {
      project_root: { type: "string" },
      task_description: { type: "string", minLength: 3 },
      use_active_plan_slug: { type: "boolean", default: false }
    },
    additionalProperties: false
  }
};
var ARCHITECTURE_KEYWORDS = [
  // English — base
  "architecture",
  "redesign",
  "rearchitect",
  "migration",
  "migrate",
  "restructure",
  "refactor across",
  "auth",
  "authentication",
  "authorization",
  "security",
  "encryption",
  "rbac",
  "rls",
  "multi-tenant",
  "multi-region",
  // English — expanded (CAP-6 EN mirror)
  "decouple",
  "decoupling",
  "clean architecture",
  "hexagonal architecture",
  "onion architecture",
  "aggregate",
  "adapter",
  "microservices",
  "monolith",
  "gateway",
  "service mesh",
  "cqrs",
  "event sourcing",
  "event-driven",
  "breaking change",
  "api contract",
  "ports and adapters",
  // pt-BR formal
  "arquitetura",
  "redesenhar",
  "reformular",
  "reestruturar",
  "migra\xE7\xE3o",
  "migrar",
  "refatorar em",
  "autentica\xE7\xE3o",
  "autoriza\xE7\xE3o",
  "seguran\xE7a",
  "criptografia",
  "multi-tenant",
  "multi-regi\xE3o",
  // Architecture pt-BR specific (Cat C)
  "camadas",
  "ddd",
  "domain-driven",
  "bounded context",
  "contexto delimitado",
  "solid",
  "clean architecture",
  "arquitetura hexagonal",
  "arquitetura limpa",
  "invers\xE3o de depend\xEAncia",
  "baixo acoplamento",
  "alta coes\xE3o"
];
var MULTI_FILE_KEYWORDS = [
  // English — base
  "rename across",
  "replace all",
  "update all",
  "refactor across",
  "every file",
  "all files",
  "all callers",
  "across the codebase",
  "across packages",
  // English — expanded (CAP-6 EN mirror)
  "repository-wide",
  "project-wide",
  "system-wide",
  "throughout the codebase",
  "in all modules",
  "in all packages",
  "in every module",
  "in every package",
  // pt-BR
  "renomear em todos",
  "renomear em todo",
  "em todos os arquivos",
  "em todo o projeto",
  "em todo o codebase",
  "em todos os m\xF3dulos",
  "em v\xE1rios m\xF3dulos",
  "em v\xE1rios arquivos",
  "todos os chamadores",
  "em todos os pacotes"
];
var TRIVIAL_KEYWORDS = [
  // English — base
  "fix typo",
  "fix a typo",
  "rename a comment",
  "update comment",
  "update a comment",
  "docs",
  "readme",
  "documentation",
  // English — expanded (CAP-6 EN mirror)
  "one-liner",
  "comment fix",
  "formatting fix",
  "whitespace",
  "spelling",
  "spell check",
  // pt-BR
  "corrigir typo",
  "corrigir erro de digita\xE7\xE3o",
  "atualizar coment\xE1rio",
  "atualizar coment\xE1rios",
  "documenta\xE7\xE3o",
  "renomear coment\xE1rio"
];
var CONCERN_LEXICONS = {
  dto: [
    "dto",
    " record ",
    // word boundary via spaces — avoids "recorded"
    "schema",
    "entity",
    "value object",
    " vo ",
    "payload"
  ],
  service: [
    "service",
    "business logic",
    "regra de neg\xF3cio",
    "regra de negocio",
    "use case",
    "caso de uso"
  ],
  listener: [
    "listener",
    "event handler",
    "evento",
    "event-driven",
    "subscriber",
    "consumer",
    "publisher"
  ],
  template: [
    "template",
    "email template",
    "render",
    " html ",
    " view ",
    " ui "
  ],
  test: [
    " test ",
    "unit test",
    "integration test",
    "junit",
    "jest",
    "vitest",
    "assertj",
    "mockito",
    " mock ",
    "mocking"
  ],
  persistence: [
    " query ",
    " sql ",
    "repository",
    "jpa",
    "hibernate",
    "migration",
    "flyway",
    "liquibase",
    "database",
    "banco de dados"
  ],
  api: [
    "endpoint",
    "controller",
    " rest ",
    "route",
    " rota ",
    " http ",
    "webhook"
  ]
};
function countSteps(text) {
  const lower = text.toLowerCase();
  const stepMatches = lower.match(/\b(?:passo|step)\s+\d+\b/g) ?? [];
  const listMatches = text.match(/(?:^|\n|\s)(\d+)\.\s+\S/g) ?? [];
  return Math.max(stepMatches.length, listMatches.length);
}
function detectConcerns(text) {
  const lower = ` ${text.toLowerCase()} `;
  const hit = /* @__PURE__ */ new Set();
  for (const [category, terms] of Object.entries(CONCERN_LEXICONS)) {
    for (const term of terms) {
      if (lower.includes(term)) {
        hit.add(category);
        break;
      }
    }
  }
  return hit;
}
var MUTATION_VERBS = [
  // English — base
  "add",
  "implement",
  "fix",
  "change",
  "update",
  "modify",
  "create",
  "remove",
  "delete",
  "rename",
  // English — expanded (CAP-6 EN mirror)
  "refactor",
  "adjust",
  "replace",
  "substitute",
  "enable",
  "disable",
  "handle",
  "process",
  "calculate",
  "list",
  "filter",
  "sort",
  "save",
  "load",
  "send",
  "receive",
  "display",
  "show",
  "restart",
  "patch",
  "push",
  "pull",
  "sync",
  "spin up",
  "tear down",
  "roll out",
  "roll back",
  "restore",
  "rebuild",
  "regenerate",
  "bump",
  "upgrade",
  "downgrade",
  "validate",
  "verify",
  "treat",
  // pt-BR formal
  "adicionar",
  "acrescentar",
  "implementar",
  "corrigir",
  "consertar",
  "alterar",
  "mudar",
  "atualizar",
  "modificar",
  "criar",
  "remover",
  "excluir",
  "deletar",
  "apagar",
  "renomear",
  "ajustar",
  "substituir",
  "refatorar",
  // Brazilian dev jargon (verbiado do inglês — Cat A)
  "pushar",
  "comitar",
  "deployar",
  "dropar",
  "bugar",
  "crashar",
  "logar",
  "mockar",
  "stubbar",
  "lintar",
  // Common spec verbs (curated — Cat B; "permitir"/"garantir" skipped as too generic)
  "validar",
  "verificar",
  "tratar",
  "calcular",
  "listar",
  "filtrar",
  "ordenar",
  "salvar",
  "carregar",
  "enviar",
  "receber",
  "processar",
  "exibir",
  "bloquear"
];
function hits(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t));
}
function classify(description) {
  const wordCount = description.trim().split(/\s+/).length;
  const archHits = hits(description, ARCHITECTURE_KEYWORDS);
  const multiHits = hits(description, MULTI_FILE_KEYWORDS);
  const trivialHits = hits(description, TRIVIAL_KEYWORDS);
  const mutationHits = hits(description, MUTATION_VERBS);
  const concerns = detectConcerns(description);
  const stepCount = countSteps(description);
  const signals = [];
  if (archHits.length > 0) signals.push(`architecture:[${archHits.join(",")}]`);
  if (multiHits.length > 0) signals.push(`multi-file:[${multiHits.join(",")}]`);
  if (trivialHits.length > 0)
    signals.push(`trivial-shape:[${trivialHits.join(",")}]`);
  if (mutationHits.length > 0)
    signals.push(`mutation-verbs:[${mutationHits.join(",")}]`);
  if (concerns.size > 0)
    signals.push(`concerns:[${Array.from(concerns).sort().join(",")}]`);
  if (stepCount > 0) signals.push(`steps:${stepCount}`);
  signals.push(`word_count:${wordCount}`);
  if (archHits.length > 0) {
    return {
      tier: "complex",
      signals,
      reasoning: `Architecture / security keywords detected (${archHits.join(", ")}). Treat as complex \u2014 likely cross-cutting, deserves full R\u2192S\u2192V\u2192C\u2192T cycle.`
    };
  }
  if (multiHits.length > 0) {
    return {
      tier: "standard",
      signals,
      reasoning: `Multi-file scope keywords detected (${multiHits.join(", ")}). Treat as standard \u2014 runs full cycle with mandatory verification of importer breakage.`
    };
  }
  if (trivialHits.length > 0 && archHits.length === 0 && multiHits.length === 0 && concerns.size === 0 && stepCount < 4 && wordCount < 12) {
    return {
      tier: "trivial",
      signals,
      reasoning: `Trivial shape (${trivialHits.join(", ")}) and short description (${wordCount} words). Skip phase machine entirely.`
    };
  }
  if (stepCount >= 4) {
    return {
      tier: "complex",
      signals,
      reasoning: `Multi-step plan detected (${stepCount} numbered steps). Treat as complex \u2014 multi-step orchestration warrants R\u2192S\u2192V\u2192C\u2192T.`
    };
  }
  if (concerns.size >= 3) {
    return {
      tier: "complex",
      signals,
      reasoning: `${concerns.size} distinct technical concerns detected (${Array.from(concerns).sort().join(", ")}). Treat as complex \u2014 touching multiple concerns warrants V phase before code.`
    };
  }
  if (concerns.size === 2) {
    return {
      tier: "standard",
      signals,
      reasoning: `Two technical concerns detected (${Array.from(concerns).sort().join(", ")}). Treat as standard \u2014 full cycle recommended; V phase strongly advised.`
    };
  }
  if (mutationHits.length > 0 && wordCount <= 20 && concerns.size <= 1) {
    return {
      tier: "small",
      signals,
      reasoning: `Single mutation verb (${mutationHits.join(", ")}) in a short description (${wordCount} words). Small \u2014 collapse R into S; run S\u2192C\u2192T.`
    };
  }
  return {
    tier: "standard",
    signals,
    reasoning: `Defaulting to standard \u2014 no architecture / multi-file / trivial signals matched the description (${wordCount} words). Full R\u2192S\u2192C\u2192T cycle recommended; consider verification phase if the change touches code with many importers.`
  };
}
var RECOMMENDED_PHASES = {
  trivial: [],
  small: ["spec", "code", "test"],
  standard: ["research", "spec", "code", "test"],
  complex: ["research", "spec", "verification", "code", "test"]
};
async function classifyTaskHandler(rawInput) {
  const input = classifyTaskInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const { tier, signals, reasoning } = classify(input.task_description);
  const recommended = RECOMMENDED_PHASES[tier];
  if (resolution.rsct_installed) {
    stampClassifyVerdict(resolution.root, {
      tier,
      signalsSummary: signals.join(" | ")
    });
  }
  let activePlan = null;
  if (input.use_active_plan_slug) {
    const plan = findActivePlan(resolution.root);
    if (plan) activePlan = { slug: plan.slug, status: plan.status };
  }
  const hints = [];
  if (tier === "trivial") {
    hints.push(
      "Trivial tier \u2014 recommend skipping the phase machine. Edit directly under \xA7B exception (trivial doc-only fixes)."
    );
  } else if (tier === "small") {
    hints.push(
      "Small tier \u2014 research can be folded into the spec phase. Start with rsct_phase_spec_start."
    );
  } else if (tier === "standard") {
    hints.push(
      "Standard tier \u2014 recommend rsct_phase_research_start to begin. CAP-28: rsct_phase_code_start REJECTS with reject_kind=verification_required unless V phase completed (or override_verification_skip=true passed). Run rsct_phase_verification_start before code."
    );
  } else {
    hints.push(
      "Complex tier \u2014 full R\u2192S\u2192V\u2192C\u2192T cycle. CAP-28: rsct_phase_code_start REJECTS unless V phase completed. Verification phase is MANDATORY before code-phase."
    );
  }
  if (activePlan) {
    hints.push(
      `Active plan detected: ${activePlan.slug} (status: ${activePlan.status ?? "unknown"}). Pass as spec_ref to phase tools when starting the cycle.`
    );
  }
  return {
    tier,
    reasoning,
    recommended_phases: recommended,
    signals,
    active_plan: activePlan,
    hints
  };
}

// src/lib/phase-machine.ts
var RSCT_PHASES = [
  "research",
  "spec",
  "verification",
  "code",
  "test"
];
var PHASE_ORDER = [
  "research",
  "spec",
  "verification",
  "code",
  "test"
];
function nextPhase(current) {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1];
}
function auditFields6(audit) {
  if (audit.ok) return { audit_path: audit.path, audit_error: null };
  if (audit.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? "write_failed"
  };
}
function startPhaseGeneric(input, config, internal = {}) {
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const startedAt = (internal.now ?? /* @__PURE__ */ new Date()).toISOString();
  const existing = readPhaseState(input.projectRoot);
  const baseState = existing.state ?? {};
  const existingPhase = baseState.phase;
  if (existingPhase && existingPhase !== input.phase) {
    const audit2 = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.start.rejected`,
        tool: `rsct_phase_${input.phase}_start`,
        spec_ref: input.specRef,
        reject_kind: "phase_already_active",
        existing_phase: existingPhase
      },
      config?.audit
    );
    const fields2 = auditFields6(audit2);
    return {
      status: "phase_already_active",
      phase: input.phase,
      spec_ref: input.specRef,
      spec_slug: baseState.spec_slug ?? null,
      started_at: startedAt,
      scope_globs: input.scopeGlobs ?? [],
      requested_persona: input.persona ?? null,
      phase_state_path: "",
      phase_state_written: false,
      existing_phase: existingPhase,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      hints: [
        `Phase '${existingPhase}' is already active. Call rsct_phase_${existingPhase}_complete first, or wipe .rsct/phase-state.json, before starting a different phase.`
      ]
    };
  }
  const newState = {
    ...baseState,
    phase: input.phase,
    spec_slug: input.specSlug ?? baseState.spec_slug ?? input.specRef,
    started_at: startedAt
  };
  if (input.scopeGlobs !== void 0) newState.scope_globs = input.scopeGlobs;
  const writeResult = writePhaseState(input.projectRoot, newState);
  const audit = appendAudit(
    input.projectRoot,
    {
      event: `${input.phase}.start`,
      tool: `rsct_phase_${input.phase}_start`,
      spec_ref: input.specRef,
      spec_slug: newState.spec_slug,
      requested_persona: input.persona ?? null,
      scope_globs: input.scopeGlobs ?? [],
      phase_state_written: writeResult.ok
    },
    config?.audit
  );
  const fields = auditFields6(audit);
  const hints = [];
  if (writeResult.ok) {
    hints.push(
      `Phase '${input.phase}' started for spec_ref='${input.specRef}'. State at ${writeResult.path}. Call rsct_phase_${input.phase}_complete with dev_approval (action_scope='${input.phase}_complete:spec_ref=${input.specRef}') when ready.`
    );
  } else if (writeResult.reason === "locked") {
    hints.push(
      `\u26A0 phase-state.json is locked (held ${writeResult.lock_age_ms}ms by session ${writeResult.held_by_session ?? "unknown"}). Wait and retry.`
    );
  } else {
    hints.push(`\u26A0 phase-state.json write failed: ${writeResult.error}.`);
  }
  return {
    status: writeResult.ok ? "started" : "state_write_failed",
    phase: input.phase,
    spec_ref: input.specRef,
    spec_slug: newState.spec_slug ?? null,
    started_at: startedAt,
    scope_globs: input.scopeGlobs ?? [],
    requested_persona: input.persona ?? null,
    phase_state_path: writeResult.path,
    phase_state_written: writeResult.ok,
    existing_phase: null,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    hints
  };
}
async function gatePhaseComplete(input, config, internal = {}) {
  const promptFn = internal.promptFn ?? promptYesNo;
  const now = internal.now ?? /* @__PURE__ */ new Date();
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval;
  const existing = readPhaseState(input.projectRoot);
  if (!existing.exists || !existing.state?.phase) {
    return {
      status: "no_active_phase",
      phase: input.phase,
      channel: null,
      reject_kind: null,
      reason: "no active phase in .rsct/phase-state.json \u2014 call rsct_phase_*_start first",
      fabrication_signals: [],
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `No active phase in phase-state.json. Run rsct_phase_${input.phase}_start before _complete.`
      ]
    };
  }
  const state = existing.state;
  if (state.phase !== input.phase) {
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.complete.rejected`,
        tool: `rsct_phase_${input.phase}_complete`,
        spec_ref: input.specRef,
        reject_kind: "phase_mismatch",
        active_phase: state.phase
      },
      config?.audit
    );
    const fields2 = auditFields6(audit);
    return {
      status: "rejected",
      phase: input.phase,
      channel: null,
      reject_kind: "phase_mismatch",
      reason: `active phase is '${state.phase}', not '${input.phase}'`,
      fabrication_signals: [],
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `phase-state.json holds phase='${state.phase}', not '${input.phase}'. Call rsct_phase_${state.phase}_complete instead, or wipe the state.`
      ]
    };
  }
  if (state.spec_slug && state.spec_slug !== input.specRef) {
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.complete.rejected`,
        tool: `rsct_phase_${input.phase}_complete`,
        spec_ref: input.specRef,
        reject_kind: "spec_ref_mismatch",
        existing_spec_slug: state.spec_slug
      },
      config?.audit
    );
    const fields2 = auditFields6(audit);
    return {
      status: "rejected",
      phase: input.phase,
      channel: null,
      reject_kind: "spec_ref_mismatch",
      reason: `phase-state holds spec_slug='${state.spec_slug}' but input spec_ref is '${input.specRef}'`,
      fabrication_signals: [],
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `spec_ref mismatch \u2014 pass spec_ref='${state.spec_slug}' to match the active phase.`
      ]
    };
  }
  const gate = await gateRequest({
    toolName: `rsct_phase_${input.phase}_complete`,
    approval: input.devApproval,
    dialog: {
      title: `RSCT \xA7C \u2014 ${input.phase} complete`,
      message: `Complete the ${input.phase} phase for spec '${input.specRef}'?`
    },
    projectRoot: input.projectRoot,
    ...config?.approval_modes !== void 0 && {
      approvalModes: config.approval_modes
    },
    promptFn,
    now
  });
  if (gate.status === "rejected") {
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.complete.rejected`,
        tool: `rsct_phase_${input.phase}_complete`,
        spec_ref: input.specRef,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        fabrication_signals: gate.fabrication_signals
      },
      config?.audit
    );
    const fields2 = auditFields6(audit);
    return {
      status: "rejected",
      phase: input.phase,
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`\xA7C rejected (${gate.reject_kind}): ${gate.reason}`]
    };
  }
  const newState = { ...state };
  delete newState.phase;
  delete newState.scope_globs;
  delete newState.started_at;
  const writeResult = writePhaseState(input.projectRoot, newState);
  const record = recordApproval(gate.approval, {
    projectRoot: input.projectRoot,
    now
  });
  const recommended = nextPhase(input.phase);
  const completedAt = now.toISOString();
  const completeAudit = appendAudit(
    input.projectRoot,
    {
      event: `${input.phase}.complete`,
      tool: `rsct_phase_${input.phase}_complete`,
      spec_ref: input.specRef,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
      next_recommended_phase: recommended,
      completed_at: completedAt,
      phase_state_written: writeResult.ok
    },
    config?.audit
  );
  const fields = auditFields6(completeAudit);
  const hints = [];
  if (writeResult.ok) {
    if (recommended) {
      hints.push(
        `${input.phase} complete for '${input.specRef}'. Next recommended phase: '${recommended}' \u2014 call rsct_phase_${recommended}_start when ready.`
      );
    } else {
      hints.push(
        `${input.phase} complete for '${input.specRef}' \u2014 task cycle finished. spec_slug retained for traceability.`
      );
    }
  } else if (writeResult.reason === "locked") {
    hints.push(
      `\u26A0 ${input.phase} complete approved but phase-state.json is locked (held ${writeResult.lock_age_ms}ms). State may be inconsistent.`
    );
  } else {
    hints.push(
      `\u26A0 ${input.phase} complete approved but phase-state.json write failed: ${writeResult.error}.`
    );
  }
  if (!record.ok) {
    hints.push(
      `\u26A0 Anti-replay store update failed: ${record.error}. dev_approval may be replayable; rotate or repair .rsct/approvals-seen.json.`
    );
  }
  if (fields.audit_error !== null) {
    hints.push(`\u26A0 ${input.phase}.complete audit write failed: ${fields.audit_error}.`);
  }
  return {
    status: writeResult.ok ? "completed" : "state_write_failed",
    phase: input.phase,
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    spec_ref: input.specRef,
    cleared: writeResult.ok,
    next_recommended_phase: recommended,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error ?? null,
    hints
  };
}

// src/tools/phase-status.ts
var phaseStatusInputSchema = z.object({
  project_root: z.string().optional()
}).strict();
var phaseStatusTool = {
  name: "rsct_phase_status",
  description: "Pure query: returns the current state of the RSCT phase machine from .rsct/phase-state.json. Reports the active phase (or null), spec_slug, scope globs, verification block summary when active, and the next recommended phase per the canonical R\u2192S\u2192V\u2192C\u2192T order. Use to check where the task is mid-session before starting a new phase.",
  inputSchema: {
    type: "object",
    properties: {
      project_root: { type: "string" }
    },
    additionalProperties: false
  }
};
function isKnownPhase(value) {
  return value !== void 0 && RSCT_PHASES.includes(value);
}
async function phaseStatusHandler(rawInput) {
  const input = phaseStatusInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const read = readPhaseState(resolution.root);
  const hints = [];
  if (!resolution.rsct_installed) {
    hints.push(
      "Project is not rsct-managed \u2014 phase machine state will be unknown. Run /rsct-setup before relying on this tool."
    );
  }
  if (!read.exists) {
    hints.push(
      "No .rsct/phase-state.json yet \u2014 no active phase. Call rsct_classify_task to choose a tier, then rsct_phase_<phase>_start."
    );
    return {
      rsct_installed: resolution.rsct_installed,
      phase_state_exists: false,
      active_phase: null,
      spec_slug: null,
      started_at: null,
      scope_globs: [],
      verification: null,
      next_recommended_phase: null,
      rsct_phase_order: RSCT_PHASES,
      hints
    };
  }
  const state = read.state;
  const phaseValue = state?.phase;
  const active = isKnownPhase(phaseValue) ? phaseValue : null;
  let verification = null;
  if (state?.verification) {
    const findings = state.verification.findings;
    verification = {
      spec_ref: state.verification.spec_ref ?? null,
      spec_tier: state.verification.spec_tier ?? null,
      findings_count: Array.isArray(findings) ? findings.length : 0,
      started_at: state.verification.started_at ?? null
    };
  }
  const recommended = active ? nextPhase(active) : null;
  if (active === null && phaseValue !== void 0) {
    hints.push(
      `phase-state.json holds an unrecognized phase value '${phaseValue}'. Either the file was hand-edited or a future phase tool wrote it; M3 expects one of [${RSCT_PHASES.join(", ")}].`
    );
  } else if (active) {
    hints.push(
      `Active phase: ${active}${state?.spec_slug ? ` (spec_slug='${state.spec_slug}')` : ""}.${recommended ? ` Next recommended: '${recommended}' \u2014 call rsct_phase_${active}_complete before rsct_phase_${recommended}_start.` : " This is the last phase; rsct_phase_test_complete ends the cycle."}`
    );
    if (active === "verification" && verification) {
      hints.push(
        `Verification has ${verification.findings_count} finding(s). Resolve actions and call rsct_phase_verification_complete with findings_actions[] + dev_approval.`
      );
    }
  } else {
    hints.push(
      "phase-state.json present but no active phase field. Start a phase with rsct_phase_<phase>_start."
    );
  }
  return {
    rsct_installed: resolution.rsct_installed,
    phase_state_exists: true,
    active_phase: active,
    spec_slug: state?.spec_slug ?? null,
    started_at: state?.started_at ?? null,
    scope_globs: state?.scope_globs ?? [],
    verification,
    next_recommended_phase: recommended,
    rsct_phase_order: RSCT_PHASES,
    hints
  };
}
var phaseResearchStartInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  spec_ref: z.string().min(1, "spec_ref required").describe(
    'Free-form spec identifier \u2014 typically the plan slug (e.g., "feat-foo") or a path to plan_<slug>.md. Correlates start/complete and used as audit key.'
  ),
  spec_slug: z.string().optional().describe(
    "Optional spec_slug to write into phase-state.json. Defaults to spec_ref if absent."
  ),
  scope_globs: z.array(z.string()).optional().describe(
    "Optional scope globs for rsct_check_edit_scope. Research is exploratory \u2014 usually omitted at this phase."
  ),
  persona: z.string().optional().describe(
    "Optional persona slug. No-op until F3; logged into audit as requested_persona."
  )
}).strict();
var phaseResearchStartTool = {
  name: "rsct_phase_research_start",
  description: 'Start the R (Research) phase of the RSCT cycle. Writes phase="research" into .rsct/phase-state.json and emits research.start to the audit log. Use for exploratory work before committing to a spec \u2014 read code, look at decisions, scan for prior art. Refuses if a different phase is already active.',
  inputSchema: {
    type: "object",
    required: ["spec_ref"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      spec_slug: { type: "string" },
      scope_globs: { type: "array", items: { type: "string" } },
      persona: { type: "string" }
    },
    additionalProperties: false
  }
};
async function phaseResearchStartHandler(rawInput) {
  const input = phaseResearchStartInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const args = {
    projectRoot: resolution.root,
    phase: "research",
    specRef: input.spec_ref
  };
  if (input.spec_slug !== void 0) args.specSlug = input.spec_slug;
  if (input.scope_globs !== void 0) args.scopeGlobs = input.scope_globs;
  if (input.persona !== void 0) args.persona = input.persona;
  return startPhaseGeneric(args, resolution.config);
}
var phaseResearchCompleteInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(1, "spec_ref required").describe("Must match the spec_slug of the active research phase."),
  dev_approval: z.unknown().describe(
    'The dev_approval payload. action_scope SHOULD start with "research_complete:" (INV-2.2 scope_mismatch detection).'
  )
}).strict();
var phaseResearchCompleteTool = {
  name: "rsct_phase_research_complete",
  description: '\xA7C-gated R phase closure. Reads .rsct/phase-state.json (must hold phase="research" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "research_complete:spec_ref=<X>". Next recommended phase: spec.',
  inputSchema: {
    type: "object",
    required: ["spec_ref", "dev_approval"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      dev_approval: {
        type: "object",
        description: "dev_approval payload (timestamp, action_scope, reason, optional overrides)."
      }
    },
    additionalProperties: false
  }
};
async function phaseResearchCompleteHandler(rawInput, internal = {}) {
  const input = phaseResearchCompleteInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: "research",
      specRef: input.spec_ref,
      devApproval: input.dev_approval
    },
    resolution.config,
    internal
  );
}
var phaseSpecStartInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(1),
  spec_slug: z.string().optional(),
  scope_globs: z.array(z.string()).optional(),
  persona: z.string().optional()
}).strict();
var phaseSpecStartTool = {
  name: "rsct_phase_spec_start",
  description: 'Start the S (Spec) phase. Writes phase="spec" into .rsct/phase-state.json and emits spec.start audit. Use after research is complete (or skipped) to formalize the plan with the \xA7B "2 options + reuse analysis" template. Refuses if a different phase is already active.',
  inputSchema: {
    type: "object",
    required: ["spec_ref"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      spec_slug: { type: "string" },
      scope_globs: { type: "array", items: { type: "string" } },
      persona: { type: "string" }
    },
    additionalProperties: false
  }
};
async function phaseSpecStartHandler(rawInput) {
  const input = phaseSpecStartInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const args = {
    projectRoot: resolution.root,
    phase: "spec",
    specRef: input.spec_ref
  };
  if (input.spec_slug !== void 0) args.specSlug = input.spec_slug;
  if (input.scope_globs !== void 0) args.scopeGlobs = input.scope_globs;
  if (input.persona !== void 0) args.persona = input.persona;
  return startPhaseGeneric(args, resolution.config);
}
var phaseSpecCompleteInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(1),
  dev_approval: z.unknown()
}).strict();
var phaseSpecCompleteTool = {
  name: "rsct_phase_spec_complete",
  description: '\xA7C-gated S phase closure. Reads .rsct/phase-state.json (must hold phase="spec" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "spec_complete:spec_ref=<X>". Next recommended phase: verification (optional \u2014 call rsct_phase_verification_start to run the audit-level sweep) or code (skip V phase).',
  inputSchema: {
    type: "object",
    required: ["spec_ref", "dev_approval"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      dev_approval: { type: "object" }
    },
    additionalProperties: false
  }
};
async function phaseSpecCompleteHandler(rawInput, internal = {}) {
  const input = phaseSpecCompleteInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: "spec",
      specRef: input.spec_ref,
      devApproval: input.dev_approval
    },
    resolution.config,
    internal
  );
}
var TIER_VALUES2 = ["trivial", "small", "standard", "complex"];
var TIERS_BYPASSING_V_GATE = /* @__PURE__ */ new Set(["trivial", "small"]);
var phaseCodeStartInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(1),
  spec_slug: z.string().optional(),
  scope_globs: z.array(z.string()).optional(),
  persona: z.string().optional(),
  spec_tier: z.enum(TIER_VALUES2).default("standard").describe(
    "Tier per rsct_classify_task. trivial+small bypass the verification gate; standard+complex require a completed V phase OR override_verification_skip=true."
  ),
  override_verification_skip: z.boolean().default(false).describe(
    "When true, allows code phase to start without a completed verification block for tier \u2208 {standard, complex}. The override is logged to audit; use sparingly when the dev has explicitly chosen to bypass V."
  ),
  override_classify_downgrade: z.boolean().default(false).describe(
    "CAP-30: when true, allows spec_tier lower than the highest tier ever returned by rsct_classify_task (`last_classify.tier_max` in phase-state). Override is audit-logged. Use only when the dev has explicitly chosen to downgrade."
  )
}).strict();
var phaseCodeStartTool = {
  name: "rsct_phase_code_start",
  description: 'Start the C (Code) phase. Writes phase="code" into .rsct/phase-state.json and emits code.start audit. `scope_globs[]` are honored by rsct_check_edit_scope to gate which files may be edited during this phase. **CAP-28: verification gate** \u2014 for spec_tier \u2208 {standard, complex} this tool reads phase-state.json and rejects unless a verification block matching spec_ref has completed_at set. Pass `override_verification_skip=true` to bypass (override is audit-logged). **CAP-30: classify gate** \u2014 also rejects when `spec_tier` is lower than `last_classify.tier_max` (the highest tier ever returned by rsct_classify_task for this project). Pass `override_classify_downgrade=true` to bypass (audit-logged). **CAP-31: bootstrap visibility** \u2014 warns (hint + audit) if `bootstrap_at` is missing or older than 4 hours. For spec_tier \u2208 {trivial, small} the V gate is automatically bypassed.',
  inputSchema: {
    type: "object",
    required: ["spec_ref"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      spec_slug: { type: "string" },
      scope_globs: { type: "array", items: { type: "string" } },
      persona: { type: "string" },
      spec_tier: {
        type: "string",
        enum: [...TIER_VALUES2],
        default: "standard",
        description: "trivial+small bypass V gate; standard+complex require completed V or override."
      },
      override_verification_skip: {
        type: "boolean",
        default: false,
        description: "When true, bypass the V gate for standard+complex (audit-logged)."
      },
      override_classify_downgrade: {
        type: "boolean",
        default: false,
        description: "When true, bypass the CAP-30 classify-downgrade gate (audit-logged)."
      }
    },
    additionalProperties: false
  }
};
function auditFields7(audit) {
  if (audit.ok) return { audit_path: audit.path, audit_error: null };
  if (audit.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? "write_failed"
  };
}
function evaluateVerificationGate(args) {
  const { specRef, specTier, overrideVerificationSkip } = args;
  if (TIERS_BYPASSING_V_GATE.has(specTier)) {
    return {
      status: "bypassed_tier",
      spec_tier: specTier,
      v_block_found: false,
      v_spec_ref: null,
      v_completed_at: null,
      hint: `tier=${specTier} bypasses verification gate per canonical tier table.`
    };
  }
  const stateRead = readPhaseState(args.projectRoot);
  const vBlock = stateRead.state?.verification;
  const vSpecRef = vBlock?.spec_ref ?? null;
  const vCompletedAt = vBlock?.completed_at ?? null;
  const vMatchesSpec = vSpecRef !== null && vSpecRef === specRef;
  if (vMatchesSpec && vCompletedAt !== null) {
    return {
      status: "satisfied",
      spec_tier: specTier,
      v_block_found: true,
      v_spec_ref: vSpecRef,
      v_completed_at: vCompletedAt,
      hint: `Verification phase completed at ${vCompletedAt} for this spec_ref. Code phase may proceed.`
    };
  }
  if (vMatchesSpec && vCompletedAt === null) {
    return {
      status: "rejected_incomplete",
      spec_tier: specTier,
      v_block_found: true,
      v_spec_ref: vSpecRef,
      v_completed_at: null,
      hint: `Verification phase started for spec_ref='${specRef}' but not completed. Call rsct_phase_verification_complete first, OR pass override_verification_skip=true to bypass.`
    };
  }
  if (overrideVerificationSkip) {
    return {
      status: "overridden",
      spec_tier: specTier,
      v_block_found: vBlock !== void 0,
      v_spec_ref: vSpecRef,
      v_completed_at: vCompletedAt,
      hint: `override_verification_skip=true acknowledged. Override logged to audit (.rsct/audit.log).`
    };
  }
  return {
    status: "rejected_required",
    spec_tier: specTier,
    v_block_found: vBlock !== void 0,
    v_spec_ref: vSpecRef,
    v_completed_at: vCompletedAt,
    hint: `tier='${specTier}' requires a completed verification phase for spec_ref='${specRef}'. Run rsct_phase_verification_start + _complete, OR pass override_verification_skip=true (logged to audit) when V is intentionally skipped.`
  };
}
function evaluateClassifyGate(args) {
  const { specTier, overrideClassifyDowngrade } = args;
  const stateRead = readPhaseState(args.projectRoot);
  const block = stateRead.state?.last_classify;
  if (!block) {
    return {
      status: "no_record",
      spec_tier: specTier,
      tier_max_recorded: null,
      classified_at: null,
      hint: `No classify_task verdict on record \u2014 gate inactive. Run rsct_classify_task before code_start to enable the downgrade guard.`
    };
  }
  const requestedRank = tierRank(specTier);
  const maxRank = tierRank(block.tier_max);
  if (requestedRank >= maxRank) {
    return {
      status: "satisfied",
      spec_tier: specTier,
      tier_max_recorded: block.tier_max,
      classified_at: block.classified_at,
      hint: `spec_tier='${specTier}' \u2265 recorded tier_max='${block.tier_max}'. Classify gate satisfied.`
    };
  }
  if (overrideClassifyDowngrade) {
    return {
      status: "overridden",
      spec_tier: specTier,
      tier_max_recorded: block.tier_max,
      classified_at: block.classified_at,
      hint: `override_classify_downgrade=true acknowledged. Downgrade from '${block.tier_max}' to '${specTier}' logged to audit.`
    };
  }
  return {
    status: "rejected_downgrade",
    spec_tier: specTier,
    tier_max_recorded: block.tier_max,
    classified_at: block.classified_at,
    hint: `spec_tier='${specTier}' is lower than recorded tier_max='${block.tier_max}' (classified at ${block.classified_at}). Pass override_classify_downgrade=true (audit-logged) to bypass, OR re-classify with rsct_classify_task if the task scope genuinely changed.`
  };
}
async function phaseCodeStartHandler(rawInput) {
  const input = phaseCodeStartInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const classifyGate = evaluateClassifyGate({
    projectRoot: resolution.root,
    specTier: input.spec_tier,
    overrideClassifyDowngrade: input.override_classify_downgrade
  });
  if (classifyGate.status === "rejected_downgrade") {
    const audit = appendAuditEntry(
      resolution.root,
      {
        event: "code.start.rejected",
        tool: "rsct_phase_code_start",
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        reject_kind: "classify_downgrade",
        tier_max_recorded: classifyGate.tier_max_recorded,
        classified_at: classifyGate.classified_at
      },
      resolution.config?.audit
    );
    const fields = auditFields7(audit);
    const placeholderVGate = {
      status: "bypassed_tier",
      spec_tier: input.spec_tier,
      v_block_found: false,
      v_spec_ref: null,
      v_completed_at: null,
      hint: "classify gate rejected before V evaluation"
    };
    return {
      status: "classify_gate_rejected",
      reject_kind: "classify_downgrade",
      reason: classifyGate.hint,
      spec_ref: input.spec_ref,
      verification_gate: placeholderVGate,
      classify_gate: classifyGate,
      phase_state_path: "",
      phase_state_written: false,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [classifyGate.hint]
    };
  }
  if (classifyGate.status === "overridden") {
    appendAuditEntry(
      resolution.root,
      {
        event: "code.start.classify_downgrade_override",
        tool: "rsct_phase_code_start",
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        tier_max_recorded: classifyGate.tier_max_recorded
      },
      resolution.config?.audit
    );
  }
  const gate = evaluateVerificationGate({
    projectRoot: resolution.root,
    specRef: input.spec_ref,
    specTier: input.spec_tier,
    overrideVerificationSkip: input.override_verification_skip
  });
  if (gate.status === "rejected_required" || gate.status === "rejected_incomplete") {
    const rejectKind = gate.status === "rejected_required" ? "verification_required" : "verification_incomplete";
    const audit = appendAuditEntry(
      resolution.root,
      {
        event: "code.start.rejected",
        tool: "rsct_phase_code_start",
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        reject_kind: rejectKind,
        v_block_found: gate.v_block_found,
        v_spec_ref: gate.v_spec_ref,
        v_completed_at: gate.v_completed_at
      },
      resolution.config?.audit
    );
    const fields = auditFields7(audit);
    return {
      status: "verification_gate_rejected",
      reject_kind: rejectKind,
      reason: gate.hint,
      spec_ref: input.spec_ref,
      verification_gate: gate,
      classify_gate: classifyGate,
      phase_state_path: "",
      phase_state_written: false,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      hints: [gate.hint]
    };
  }
  if (gate.status === "overridden") {
    appendAuditEntry(
      resolution.root,
      {
        event: "code.start.verification_override",
        tool: "rsct_phase_code_start",
        spec_ref: input.spec_ref,
        spec_tier: input.spec_tier,
        v_block_found: gate.v_block_found,
        v_spec_ref: gate.v_spec_ref
      },
      resolution.config?.audit
    );
  }
  const bootstrap = evaluateBootstrapMarker({ projectRoot: resolution.root });
  if (bootstrap.status !== "fresh") {
    appendAuditEntry(
      resolution.root,
      {
        event: "code.start.bootstrap_warning",
        tool: "rsct_phase_code_start",
        spec_ref: input.spec_ref,
        bootstrap_status: bootstrap.status,
        bootstrap_at: bootstrap.bootstrap_at,
        age_ms: bootstrap.age_ms
      },
      resolution.config?.audit
    );
  }
  const args = {
    projectRoot: resolution.root,
    phase: "code",
    specRef: input.spec_ref
  };
  if (input.spec_slug !== void 0) args.specSlug = input.spec_slug;
  if (input.scope_globs !== void 0) args.scopeGlobs = input.scope_globs;
  if (input.persona !== void 0) args.persona = input.persona;
  const result = startPhaseGeneric(args, resolution.config);
  const extras = {
    verification_gate: gate,
    classify_gate: classifyGate,
    bootstrap_marker: bootstrap
  };
  const baseHints = result.hints ?? [];
  if (bootstrap.status !== "fresh" && bootstrap.hint) {
    baseHints.push(bootstrap.hint);
  }
  return { ...result, ...extras, hints: baseHints };
}
var phaseCodeCompleteInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(1),
  dev_approval: z.unknown()
}).strict();
var phaseCodeCompleteTool = {
  name: "rsct_phase_code_complete",
  description: '\xA7C-gated C phase closure. Reads .rsct/phase-state.json (must hold phase="code" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "code_complete:spec_ref=<X>". Next recommended phase: test.',
  inputSchema: {
    type: "object",
    required: ["spec_ref", "dev_approval"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      dev_approval: { type: "object" }
    },
    additionalProperties: false
  }
};
async function phaseCodeCompleteHandler(rawInput, internal = {}) {
  const input = phaseCodeCompleteInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: "code",
      specRef: input.spec_ref,
      devApproval: input.dev_approval
    },
    resolution.config,
    internal
  );
}
var phaseTestStartInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(1),
  spec_slug: z.string().optional(),
  scope_globs: z.array(z.string()).optional(),
  persona: z.string().optional()
}).strict();
var phaseTestStartTool = {
  name: "rsct_phase_test_start",
  description: 'Start the T (Test) phase. Writes phase="test" into .rsct/phase-state.json and emits test.start audit. Use after code phase is complete to add unit/integration tests + run the test suite end-to-end before sign-off.',
  inputSchema: {
    type: "object",
    required: ["spec_ref"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      spec_slug: { type: "string" },
      scope_globs: { type: "array", items: { type: "string" } },
      persona: { type: "string" }
    },
    additionalProperties: false
  }
};
async function phaseTestStartHandler(rawInput) {
  const input = phaseTestStartInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const args = {
    projectRoot: resolution.root,
    phase: "test",
    specRef: input.spec_ref
  };
  if (input.spec_slug !== void 0) args.specSlug = input.spec_slug;
  if (input.scope_globs !== void 0) args.scopeGlobs = input.scope_globs;
  if (input.persona !== void 0) args.persona = input.persona;
  return startPhaseGeneric(args, resolution.config);
}
var phaseTestCompleteInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(1),
  dev_approval: z.unknown()
}).strict();
var phaseTestCompleteTool = {
  name: "rsct_phase_test_complete",
  description: '\xA7C-gated T phase closure \u2014 the task-completion event. Reads .rsct/phase-state.json (must hold phase="test" + matching spec_slug), validates dev_approval, pops the OS dialog when required, and clears the active phase on success. Suggested action_scope: "test_complete:spec_ref=<X>". This is the last phase in the cycle \u2014 next_recommended_phase will be null.',
  inputSchema: {
    type: "object",
    required: ["spec_ref", "dev_approval"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string" },
      dev_approval: { type: "object" }
    },
    additionalProperties: false
  }
};
async function phaseTestCompleteHandler(rawInput, internal = {}) {
  const input = phaseTestCompleteInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  return gatePhaseComplete(
    {
      projectRoot: resolution.root,
      phase: "test",
      specRef: input.spec_ref,
      devApproval: input.dev_approval
    },
    resolution.config,
    internal
  );
}
var phaseAbandonInputSchema = z.object({
  project_root: z.string().optional().describe("Optional absolute path to override project root detection."),
  reason: z.string().min(10, "reason must be \u226510 chars \u2014 explain why this phase is being discarded").describe(
    "Human-readable reason for abandoning the active phase. Lands in the audit log so a future reader can understand why work was discarded."
  ),
  dev_approval: z.unknown().describe(
    'dev_approval payload. action_scope SHOULD start with "phase_abandon:" (INV-2.2 scope_mismatch).'
  )
}).strict();
var phaseAbandonTool = {
  name: "rsct_phase_abandon",
  description: '\xA7C-gated abandon \u2014 discards the active phase (and any verification sub-block) WITHOUT advancing the RSCT cycle. Use when a phase was started against the wrong spec_ref, the task pivoted, or the spec was rejected after research. Requires dev_approval with action_scope starting with "phase_abandon:" and a reason (min 10 chars). The reason lands in the audit log so future readers know why work was discarded. Spec_slug is also cleared. NOT for ending a phase cleanly \u2014 use rsct_phase_<phase>_complete for that.',
  inputSchema: {
    type: "object",
    required: ["reason", "dev_approval"],
    properties: {
      project_root: { type: "string" },
      reason: {
        type: "string",
        minLength: 10,
        description: "Human-readable reason. \u226510 chars. Lands in audit log."
      },
      dev_approval: {
        type: "object",
        description: "dev_approval payload (timestamp, action_scope, reason)."
      }
    },
    additionalProperties: false
  }
};
function auditFields8(audit) {
  if (audit.ok) return { audit_path: audit.path, audit_error: null };
  if (audit.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? "write_failed"
  };
}
async function phaseAbandonHandler(rawInput, internal = {}) {
  const input = phaseAbandonInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config;
  const promptFn = internal.promptFn ?? promptYesNo;
  const now = internal.now ?? /* @__PURE__ */ new Date();
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval;
  const existing = readPhaseState(projectRoot);
  if (!existing.exists || !existing.state?.phase) {
    return {
      status: "no_active_phase",
      channel: null,
      reject_kind: null,
      reason: "no active phase in .rsct/phase-state.json \u2014 nothing to abandon",
      fabrication_signals: [],
      abandoned_phase: null,
      abandoned_spec_slug: null,
      abandoned_verification_block_present: false,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        "No active phase to abandon. If phase-state.json exists but has no phase field, the state is already clean."
      ]
    };
  }
  const state = existing.state;
  const phase = state.phase ?? "";
  const specSlug = state.spec_slug ?? null;
  const hasVerification = state.verification !== void 0;
  const gate = await gateRequest({
    toolName: "rsct_phase_abandon",
    approval: input.dev_approval,
    dialog: {
      title: "RSCT \xA7C \u2014 abandon phase",
      message: `Abandon phase '${phase}'${specSlug ? ` for spec '${specSlug}'` : ""}?

Reason: ${input.reason}

This discards the phase without advancing the RSCT cycle.`
    },
    projectRoot,
    ...config?.approval_modes !== void 0 && {
      approvalModes: config.approval_modes
    },
    promptFn,
    now
  });
  if (gate.status === "rejected") {
    const audit = appendAudit(
      projectRoot,
      {
        event: "phase_abandon.rejected",
        tool: "rsct_phase_abandon",
        active_phase: phase,
        spec_slug: specSlug,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        provided_reason: input.reason,
        fabrication_signals: gate.fabrication_signals
      },
      config?.audit
    );
    const fields2 = auditFields8(audit);
    return {
      status: "rejected",
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      abandoned_phase: null,
      abandoned_spec_slug: null,
      abandoned_verification_block_present: hasVerification,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`\xA7C rejected (${gate.reject_kind}): ${gate.reason}`]
    };
  }
  const newState = {};
  const writeResult = writePhaseState(projectRoot, newState);
  const record = recordApproval(gate.approval, { projectRoot, now });
  const abandonedAudit = appendAudit(
    projectRoot,
    {
      event: "phase_abandon.complete",
      tool: "rsct_phase_abandon",
      abandoned_phase: phase,
      abandoned_spec_slug: specSlug,
      abandoned_verification_block_present: hasVerification,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
      reason: input.reason,
      abandoned_at: now.toISOString(),
      phase_state_written: writeResult.ok
    },
    config?.audit
  );
  const fields = auditFields8(abandonedAudit);
  const hints = [];
  if (writeResult.ok) {
    hints.push(
      `Phase '${phase}' abandoned${specSlug ? ` for spec '${specSlug}'` : ""}. State cleared. Next: call rsct_classify_task or rsct_phase_<phase>_start to restart.`
    );
  } else if (writeResult.reason === "locked") {
    hints.push(
      `\u26A0 Abandon approved but phase-state.json is locked (held ${writeResult.lock_age_ms}ms). Retry; state may be inconsistent until then.`
    );
  } else {
    hints.push(
      `\u26A0 Abandon approved but phase-state.json write failed: ${writeResult.error}. Phase still appears active until the write succeeds.`
    );
  }
  if (!record.ok) {
    hints.push(
      `\u26A0 Anti-replay store update failed: ${record.error}. dev_approval may be replayable.`
    );
  }
  if (fields.audit_error !== null) {
    hints.push(`\u26A0 phase_abandon.complete audit write failed: ${fields.audit_error}.`);
  }
  return {
    status: writeResult.ok ? "abandoned" : "state_write_failed",
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    abandoned_phase: phase,
    abandoned_spec_slug: specSlug,
    abandoned_verification_block_present: hasVerification,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error ?? null,
    hints
  };
}
function isGhAvailable() {
  try {
    execFileSync("gh", ["--version"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
function createIssue(input) {
  if (!isGhAvailable()) {
    return {
      ok: false,
      reason: "not_installed",
      error: "gh CLI not found in PATH. Install from https://cli.github.com/ or use mode=draft to get the issue body for manual creation."
    };
  }
  const args = ["issue", "create", "--title", input.title, "--body", input.body];
  for (const label of input.labels ?? []) {
    args.push("--label", label);
  }
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      cwd: input.cwd,
      stdio: "pipe"
    });
    const url = stdout.trim().split("\n").find((line) => /^https?:\/\//.test(line)) ?? stdout.trim();
    return { ok: true, url, raw_stdout: stdout };
  } catch (err) {
    const errObj = err;
    const stderr = errObj?.stderr ? String(errObj.stderr) : "";
    const errorText = errObj?.message ?? "gh issue create failed";
    if (stderr.toLowerCase().includes("authentication") || stderr.toLowerCase().includes("not logged in") || stderr.toLowerCase().includes("gh auth login")) {
      return {
        ok: false,
        reason: "not_authenticated",
        error: stderr || errorText
      };
    }
    if (stderr.toLowerCase().includes("no git remote") || stderr.toLowerCase().includes("gh_repo") || stderr.toLowerCase().includes("not a git repository")) {
      return { ok: false, reason: "no_remote", error: stderr || errorText };
    }
    return { ok: false, reason: "failed", error: stderr || errorText };
  }
}

// src/tools/capture-issue.ts
var SEVERITY_VALUES = ["critical", "high", "medium", "low"];
var MODE_VALUES = ["draft", "create"];
var captureIssueInputSchema = z.object({
  project_root: z.string().optional(),
  title: z.string().min(10, "title must be \u226510 chars").max(200, "title must be \u2264200 chars").describe("Issue title \u2014 shown in the GitHub issue list."),
  body: z.string().min(50, "body must be \u226550 chars").describe(
    "Markdown body of the issue. The tool prepends a severity badge + Affected paths section + captured footer."
  ),
  severity: z.enum(SEVERITY_VALUES).describe(
    "critical / high / medium / low. Surfaced as a badge at the top of the issue."
  ),
  affected_paths: z.array(z.string()).optional().describe(
    'Project-relative paths the finding touches. Rendered as a bullet list under "Affected paths".'
  ),
  labels: z.array(z.string()).optional().describe(
    'GitHub labels to attach (mode=create only). Repo must have the labels created beforehand or gh issue create errors. Defaults: ["auto-captured", "rsct"] when omitted in create mode.'
  ),
  mode: z.enum(MODE_VALUES).default("draft").describe(
    '"draft" returns the formatted body for manual creation via web (no \xA7C, no external mutation). "create" invokes gh issue create with \xA7C-gate.'
  ),
  dev_approval: z.unknown().optional().describe(
    'Required when mode="create". action_scope SHOULD start with "capture_issue:" (INV-2.2).'
  )
}).strict();
var DEFAULT_LABELS = ["auto-captured", "rsct"];
var captureIssueTool = {
  name: "rsct_capture_issue",
  description: 'Capture a non-blocking finding as a GitHub issue. mode="draft" (default) returns a formatted markdown body for manual creation via web \u2014 no external mutation, no \xA7C-gate. mode="create" requires dev_approval (action_scope starting with "capture_issue:") and invokes `gh issue create` via Bash with \xA7C-gate. Use during verification sweeps, scan analyses, and post-task reviews to log "we should fix this later" items without scope-creeping the current task.',
  inputSchema: {
    type: "object",
    required: ["title", "body", "severity"],
    properties: {
      project_root: { type: "string" },
      title: { type: "string", minLength: 10, maxLength: 200 },
      body: { type: "string", minLength: 50 },
      severity: { type: "string", enum: [...SEVERITY_VALUES] },
      affected_paths: { type: "array", items: { type: "string" } },
      labels: { type: "array", items: { type: "string" } },
      mode: {
        type: "string",
        enum: [...MODE_VALUES],
        default: "draft"
      },
      dev_approval: {
        type: "object",
        description: 'Required when mode="create".'
      }
    },
    additionalProperties: false
  }
};
function auditFields9(audit) {
  if (audit.ok) return { audit_path: audit.path, audit_error: null };
  if (audit.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? "write_failed"
  };
}
function formatBody(input) {
  const sevBadge = `> **Severity:** \`${input.severity}\``;
  const pathsSection = input.affected_paths && input.affected_paths.length > 0 ? `

## Affected paths

${input.affected_paths.map((p) => `- \`${p}\``).join("\n")}` : "";
  const captured = `_Captured via \`rsct_capture_issue\` on ${input.now.toISOString()}._`;
  return `${sevBadge}

${input.body}${pathsSection}

---

${captured}`;
}
function suggestedGhCommand(title, labels) {
  const labelArgs = labels.map((l) => `--label ${JSON.stringify(l)}`).join(" ");
  return `gh issue create --title ${JSON.stringify(title)} --body-file <(cat) ${labelArgs}`.trim();
}
function mapGhReason(reason) {
  switch (reason.reason) {
    case "not_installed":
      return { reject_kind: "gh_not_installed", status: "gh_unavailable" };
    case "not_authenticated":
      return { reject_kind: "gh_not_authenticated", status: "gh_failed" };
    case "no_remote":
      return { reject_kind: "gh_no_remote", status: "gh_failed" };
    default:
      return { reject_kind: "gh_other", status: "gh_failed" };
  }
}
async function captureIssueHandler(rawInput, internal = {}) {
  const input = captureIssueInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config;
  const promptFn = internal.promptFn ?? promptYesNo;
  const now = internal.now ?? /* @__PURE__ */ new Date();
  const appendAudit = internal.auditWriter ?? appendAuditEntry;
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval;
  const ghCreate = internal.ghCreate ?? createIssue;
  const ghAvailableFn = internal.ghAvailable ?? isGhAvailable;
  const labels = input.labels ?? DEFAULT_LABELS;
  const formattedBody = formatBody({
    body: input.body,
    severity: input.severity,
    ...input.affected_paths !== void 0 && {
      affected_paths: input.affected_paths
    },
    now
  });
  const ghCmd = suggestedGhCommand(input.title, labels);
  if (input.mode === "draft") {
    const audit = appendAudit(
      projectRoot,
      {
        event: "capture_issue.drafted",
        tool: "rsct_capture_issue",
        title: input.title,
        severity: input.severity,
        affected_paths_count: input.affected_paths?.length ?? 0,
        labels
      },
      config?.audit
    );
    const fields2 = auditFields9(audit);
    return {
      status: "drafted",
      mode: "draft",
      channel: null,
      reject_kind: null,
      reason: null,
      fabrication_signals: [],
      formatted_body: formattedBody,
      suggested_gh_command: ghCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        "Draft mode \u2014 paste formatted_body into a new issue on GitHub web, or use the suggested gh command piped from a file."
      ]
    };
  }
  if (input.dev_approval === void 0) {
    return {
      status: "missing_dev_approval",
      mode: "create",
      channel: null,
      reject_kind: null,
      reason: 'mode="create" requires dev_approval',
      fabrication_signals: [],
      formatted_body: formattedBody,
      suggested_gh_command: ghCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        "Pass a dev_approval payload (timestamp / action_scope=capture_issue:... / reason) to enable mode=create."
      ]
    };
  }
  if (!ghAvailableFn()) {
    const audit = appendAudit(
      projectRoot,
      {
        event: "capture_issue.gh_unavailable",
        tool: "rsct_capture_issue",
        title: input.title,
        severity: input.severity
      },
      config?.audit
    );
    const fields2 = auditFields9(audit);
    return {
      status: "gh_unavailable",
      mode: "create",
      channel: null,
      reject_kind: "gh_not_installed",
      reason: "gh CLI not found in PATH",
      fabrication_signals: [],
      formatted_body: formattedBody,
      suggested_gh_command: ghCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        'gh CLI is not installed. Install from https://cli.github.com/ then retry, or fall back to mode="draft".'
      ]
    };
  }
  const gate = await gateRequest({
    toolName: "rsct_capture_issue",
    approval: input.dev_approval,
    dialog: {
      title: "RSCT \xA7C \u2014 create GitHub issue",
      message: `Create issue '${input.title}' (severity=${input.severity})?

Labels: ${labels.join(", ")}
GH CLI will run in '${projectRoot}'.`
    },
    projectRoot,
    ...config?.approval_modes !== void 0 && {
      approvalModes: config.approval_modes
    },
    promptFn,
    now
  });
  if (gate.status === "rejected") {
    const audit = appendAudit(
      projectRoot,
      {
        event: "capture_issue.create.rejected",
        tool: "rsct_capture_issue",
        title: input.title,
        severity: input.severity,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        fabrication_signals: gate.fabrication_signals
      },
      config?.audit
    );
    const fields2 = auditFields9(audit);
    return {
      status: "rejected",
      mode: "create",
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      formatted_body: formattedBody,
      suggested_gh_command: ghCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`\xA7C rejected (${gate.reject_kind}): ${gate.reason}`]
    };
  }
  const ghResult = ghCreate({
    cwd: projectRoot,
    title: input.title,
    body: formattedBody,
    labels
  });
  if (!ghResult.ok) {
    const mapped = mapGhReason(ghResult);
    const audit = appendAudit(
      projectRoot,
      {
        event: "capture_issue.create_failed",
        tool: "rsct_capture_issue",
        title: input.title,
        severity: input.severity,
        reject_kind: mapped.reject_kind,
        gh_reason: ghResult.reason,
        gh_error: ghResult.error,
        channel: gate.channel
      },
      config?.audit
    );
    const fields2 = auditFields9(audit);
    return {
      status: mapped.status,
      mode: "create",
      channel: gate.channel,
      reject_kind: mapped.reject_kind,
      reason: ghResult.error,
      fabrication_signals: gate.fabrication_signals,
      formatted_body: formattedBody,
      suggested_gh_command: ghCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields2.audit_path,
      audit_error: fields2.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `gh issue create failed (${ghResult.reason}). ${ghResult.error}`
      ]
    };
  }
  const record = recordApproval(gate.approval, { projectRoot, now });
  const createdAudit = appendAudit(
    projectRoot,
    {
      event: "capture_issue.created",
      tool: "rsct_capture_issue",
      title: input.title,
      severity: input.severity,
      affected_paths_count: input.affected_paths?.length ?? 0,
      labels,
      issue_url: ghResult.url,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals
    },
    config?.audit
  );
  const fields = auditFields9(createdAudit);
  const hints = [`Issue created: ${ghResult.url}`];
  if (!record.ok) {
    hints.push(
      `\u26A0 Anti-replay store update failed: ${record.error}. dev_approval may be replayable; rotate or repair .rsct/approvals-seen.json.`
    );
  }
  if (fields.audit_error !== null) {
    hints.push(`\u26A0 capture_issue.created audit write failed: ${fields.audit_error}.`);
  }
  return {
    status: "created",
    mode: "create",
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    formatted_body: formattedBody,
    suggested_gh_command: ghCmd,
    issue_url: ghResult.url,
    raw_gh_stdout: ghResult.raw_stdout,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : record.error ?? null,
    hints
  };
}

// src/lib/personas.ts
var PERSONAS = [
  {
    slug: "architect",
    name: "Architect",
    one_liner: "Evaluates changes against system boundaries, contracts, coupling, and downstream blast radii.",
    focus_areas: [
      "system design",
      "module boundaries",
      "data flow",
      "contracts",
      "coupling",
      "layer separation"
    ],
    questions_to_ask: [
      "Which modules does this couple to, and are those couplings new?",
      "Does it violate any architecture invariants documented in architecture.md or impact/*.md?",
      "What is the rollback path if this fails in production?",
      "Does this introduce new layer dependencies (e.g., domain importing infra)?",
      "What is the blast radius of changes to this file (count of importers, transitive consumers)?"
    ],
    anti_patterns_to_check: [
      "God object \u2014 single class doing too many unrelated things",
      "Circular dependencies between modules or layers",
      "Tight coupling to volatile external interfaces without a port/adapter",
      "Hidden state shared across layers (singleton magic, ambient context)",
      "Re-implementing functionality that already exists as a library or service"
    ],
    knowledge_categories_to_consult: [
      "anti-decisions",
      "vendor-relationships",
      "cost-constraints"
    ],
    keywords: [
      // English
      "architecture",
      "architect",
      "design",
      "boundary",
      "boundaries",
      "contract",
      "coupling",
      "layer",
      "module",
      "rearchitect",
      "redesign",
      "refactor across",
      "restructure",
      "migration",
      // English — expanded (CAP-6 EN mirror)
      "decouple",
      "decoupling",
      "clean architecture",
      "hexagonal architecture",
      "onion architecture",
      "aggregate",
      "adapter",
      "port",
      "microservices",
      "monolith",
      "gateway",
      "service mesh",
      "cqrs",
      "event sourcing",
      "event-driven",
      "breaking change",
      "api contract",
      "ports and adapters",
      // pt-BR formal
      "arquitetura",
      "arquiteto",
      "desenho",
      "fronteira",
      "fronteiras",
      "contrato",
      "acoplamento",
      "camada",
      "m\xF3dulo",
      "redesenhar",
      "reformular",
      "reestruturar",
      "refatorar em",
      "migra\xE7\xE3o",
      // Architecture pt-BR specific (Cat C)
      "camadas",
      "ddd",
      "domain-driven",
      "bounded context",
      "contexto delimitado",
      "agregado",
      "adaptador",
      "porta",
      "solid",
      "single responsibility",
      "clean architecture",
      "arquitetura hexagonal",
      "arquitetura limpa",
      "invers\xE3o de depend\xEAncia",
      "baixo acoplamento",
      "alta coes\xE3o"
    ]
  },
  {
    slug: "senior-dev",
    name: "Senior Dev",
    one_liner: "Evaluates code quality, patterns, readability, and consistency with the existing codebase.",
    focus_areas: [
      "code style",
      "maintainability",
      "patterns",
      "idioms",
      "error handling",
      "testability"
    ],
    questions_to_ask: [
      "Is this consistent with how similar problems are solved elsewhere in the codebase?",
      "Are errors handled at the appropriate boundary, not paved over with try-catch-ignore?",
      "Will this be readable by someone joining the team in 6 months?",
      "Is there a simpler way to express this logic?",
      "Are there hidden complexities (implicit ordering, race conditions, lazy initialization)?"
    ],
    anti_patterns_to_check: [
      "Copy-paste duplication of existing utilities",
      "Premature abstraction (interface for one implementation)",
      "Inconsistent naming or style with adjacent files",
      "Magic numbers or strings without constants",
      "Mutable shared state without synchronization"
    ],
    knowledge_categories_to_consult: [
      "anti-decisions",
      "business-rules",
      "workflow-rituals"
    ],
    keywords: [
      // English
      "refactor",
      "cleanup",
      "readability",
      "code quality",
      "patterns",
      "style",
      "consistency",
      "duplication",
      "idiom",
      // English — expanded (CAP-6 EN mirror)
      "clean code",
      "tech debt",
      "code smell",
      "antipattern",
      "anti-pattern",
      "dry",
      "kiss",
      "yagni",
      "design pattern",
      "best practices",
      "rewrite",
      "simplify",
      "generalize",
      "generalise",
      "encapsulate",
      "abstract",
      "abstraction",
      // pt-BR formal
      "refatorar",
      "limpar",
      "legibilidade",
      "qualidade",
      "padr\xE3o",
      "padr\xF5es",
      "estilo",
      "consist\xEAncia",
      "duplica\xE7\xE3o",
      "manuten\xE7\xE3o",
      "manutenibilidade",
      // Code quality pt-BR specific (Cat G)
      "clean code",
      "c\xF3digo limpo",
      "d\xE9bito t\xE9cnico",
      "tech debt",
      "code smell",
      "smell de c\xF3digo",
      "antipadr\xE3o",
      "antipattern",
      "padr\xE3o de projeto",
      "design pattern",
      "boas pr\xE1ticas",
      "melhores pr\xE1ticas",
      "reescrever",
      "simplificar",
      "encapsular",
      "modular",
      "generalizar"
    ]
  },
  {
    slug: "qa",
    name: "QA",
    one_liner: "Evaluates test coverage, edge cases, regression risk, and observability.",
    focus_areas: [
      "test coverage",
      "edge cases",
      "happy path vs failure paths",
      "observability",
      "regression risk"
    ],
    questions_to_ask: [
      "What edge cases is this not handling (empty inputs, null, max sizes, concurrency)?",
      "How will failures be observed in production (logs, metrics, alerts)?",
      "What regression risk does this introduce (which existing flows could break)?",
      "Are the new tests reproducing the original bug deterministically?",
      "Are integration test seams visible enough to exercise without heavy mocking?"
    ],
    anti_patterns_to_check: [
      "Tests that only cover the happy path",
      "Tests that mock the system under test (testing the mock, not the code)",
      "Untestable async code (no seams for fake time / cancellation)",
      "Snapshot tests that obscure the change being verified",
      'Tests without observable assertions (just "should not throw")'
    ],
    knowledge_categories_to_consult: [
      "incident-log",
      "domain-edge-cases",
      "business-rules"
    ],
    keywords: [
      // English
      "test",
      "edge case",
      "regression",
      "qa",
      "validation",
      "coverage",
      "verify",
      "reproduce",
      "snapshot",
      "integration test",
      "unit test",
      // English — expanded (CAP-6 EN mirror)
      "e2e test",
      "end-to-end test",
      "bdd",
      "tdd",
      "contract test",
      "mutation testing",
      "fuzz test",
      "chaos test",
      "chaos engineering",
      "load test",
      "stress test",
      "soak test",
      "a/b test",
      "acceptance criteria",
      "code coverage",
      "branch coverage",
      "line coverage",
      "fake",
      "spy",
      // pt-BR formal
      "teste",
      "testes",
      "caso de borda",
      "caso limite",
      "regress\xE3o",
      "valida\xE7\xE3o",
      "cobertura",
      "verificar",
      "reproduzir",
      "asser\xE7\xE3o",
      "mock",
      "teste de integra\xE7\xE3o",
      "teste unit\xE1rio",
      // QA pt-BR specific (Cat F)
      "cen\xE1rio de teste",
      "caso de teste",
      "caso de uso",
      "crit\xE9rio de aceita\xE7\xE3o",
      "defini\xE7\xE3o de pronto",
      "dod",
      "teste e2e",
      "teste fim a fim",
      "smoke test",
      "teste de fuma\xE7a",
      "fixture",
      "stub",
      "code coverage",
      "cobertura de c\xF3digo",
      "cen\xE1rio feliz",
      "caminho infeliz",
      "happy path"
    ]
  },
  {
    slug: "devops",
    name: "DevOps",
    one_liner: "Evaluates infrastructure impact, deploy ordering, rollback paths, and operational cost.",
    focus_areas: [
      "infrastructure impact",
      "deploy ordering",
      "rollback paths",
      "operational cost",
      "observability",
      "capacity"
    ],
    questions_to_ask: [
      "Does this require a config / secret change in the deploy pipeline?",
      "What is the deploy ordering vs other services (who must ship first)?",
      "Can this be rolled back without data migration?",
      "What is the resource cost (CPU / memory / storage / network egress)?",
      "How does this affect the runtime SLOs and monitoring?"
    ],
    anti_patterns_to_check: [
      "Hardcoded environment URLs, paths, or region identifiers",
      "Implicit assumptions about deploy order between services",
      "Long-running operations without timeouts or circuit breakers",
      "Schema changes without backward-compat shims",
      "Logs without correlation IDs in distributed systems"
    ],
    knowledge_categories_to_consult: [
      "cost-constraints",
      "vendor-relationships",
      "incident-log"
    ],
    keywords: [
      // English
      "deploy",
      "deployment",
      "infra",
      "infrastructure",
      "kubernetes",
      "k8s",
      "docker",
      "ci",
      "cd",
      "pipeline",
      "rollback",
      "cost",
      "observability",
      "monitoring",
      "metric",
      "alert",
      "slo",
      "capacity",
      // English — expanded (CAP-6 EN mirror)
      "spin up",
      "tear down",
      "spin down",
      "roll out",
      "roll back",
      "canary",
      "canary release",
      "canary deploy",
      "blue-green",
      "blue/green",
      "shadow traffic",
      "staging",
      "prod",
      "production",
      "iac",
      "terraform",
      "ansible",
      "puppet",
      "chef",
      "argocd",
      "fluxcd",
      "prometheus",
      "grafana",
      "kibana",
      "elastic",
      "splunk",
      "pagerduty",
      "opsgenie",
      "runbook",
      "postmortem",
      "post-mortem",
      "on-call",
      "oncall",
      "sre",
      "error budget",
      "latency",
      "p99",
      "p95",
      "p50",
      "throughput",
      "rps",
      "qps",
      // pt-BR formal
      "implanta\xE7\xE3o",
      "implantar",
      "infraestrutura",
      "pipeline",
      "revers\xE3o",
      "custo",
      "observabilidade",
      "monitoramento",
      "monitorar",
      "m\xE9trica",
      "alerta",
      "capacidade",
      "rolar de volta",
      // DevOps pt-BR specific (Cat E)
      "subir aplica\xE7\xE3o",
      "subir servi\xE7o",
      "derrubar",
      "rolar deploy",
      "promover release",
      "voltar vers\xE3o",
      "reverter",
      "hotfix",
      "hot fix",
      "esteira de deploy",
      "esteira ci/cd",
      "cluster",
      "pod",
      "helm chart",
      "service mesh",
      "balanceador",
      "load balancer",
      "cache hit",
      "hit rate",
      "ttl",
      "timeout",
      "circuit breaker"
    ]
  },
  {
    slug: "security",
    name: "Security",
    one_liner: "Evaluates secret handling, injection vectors, auth/authz boundaries, and data exposure.",
    focus_areas: [
      "secret handling",
      "injection vectors",
      "auth/authz boundaries",
      "data exposure",
      "supply chain"
    ],
    questions_to_ask: [
      "Are user inputs validated and escaped at every trust boundary?",
      "Is sensitive data logged, cached, or echoed unintentionally?",
      "What is the auth/authz check for this code path? Where does it live?",
      "Does this introduce a new dependency? Is its supply chain trusted?",
      "Could this be abused for resource exhaustion or amplification?"
    ],
    anti_patterns_to_check: [
      "String concatenation of user input into SQL / HTML / shell commands",
      "Hardcoded credentials or API keys",
      "Trust-on-first-use without verification",
      "Permissive CORS or unsigned tokens",
      "Crypto rolled by hand instead of vetted library primitives"
    ],
    knowledge_categories_to_consult: [
      "anti-decisions",
      "incident-log",
      "vendor-relationships"
    ],
    keywords: [
      // English
      "auth",
      "authentication",
      "authorization",
      "login",
      "logout",
      "secret",
      "credential",
      "token",
      "encrypt",
      "encryption",
      "security",
      "vulnerability",
      "injection",
      "xss",
      "csrf",
      "rbac",
      "rls",
      "sso",
      "jwt",
      "oauth",
      // English — expanded (CAP-6 EN mirror)
      "threat model",
      "threat modeling",
      "attack surface",
      "privilege escalation",
      "privesc",
      "rce",
      "remote code execution",
      "ssrf",
      "server-side request forgery",
      "owasp top 10",
      "csp",
      "content security policy",
      "hsts",
      "https",
      "tls",
      "mtls",
      "zero trust",
      "least privilege",
      "defense in depth",
      "input validation",
      "output encoding",
      "command injection",
      "path traversal",
      "session fixation",
      "session hijacking",
      "replay attack",
      // pt-BR formal
      "autentica\xE7\xE3o",
      "autenticar",
      "autoriza\xE7\xE3o",
      "autorizar",
      "login",
      "logout",
      "segredo",
      "credencial",
      "credenciais",
      "criptografia",
      "criptografar",
      "seguran\xE7a",
      "vulnerabilidade",
      "inje\xE7\xE3o",
      "vazamento",
      "exposi\xE7\xE3o",
      "acesso indevido",
      // Security pt-BR specific (Cat D)
      "hash",
      "hashear",
      "salt",
      "bcrypt",
      "argon2",
      "oauth2",
      "oidc",
      "saml",
      "mfa",
      "2fa",
      "valida\xE7\xE3o de entrada",
      "sanitiza\xE7\xE3o",
      "escapar input",
      "escapar string",
      "owasp",
      "brute force",
      "for\xE7a bruta",
      "ataque",
      "sql injection",
      "n\xE3o autorizado",
      "n\xE3o autenticado",
      "token expirado",
      "token revogado",
      "refresh token",
      "access token"
    ]
  },
  {
    slug: "tutor",
    name: "Tutor",
    one_liner: "Interactive step-by-step facilitator. Proposes ONE step at a time, waits for the dev to execute or consent, observes the result, proposes the next step. Use for learning, live production work, sensitive ops, and code reviews where every change deserves a deliberate beat.",
    focus_areas: [
      "one step at a time",
      "human-in-the-loop pacing",
      "explicit consent per action",
      "observation before next step",
      "understanding over speed"
    ],
    questions_to_ask: [
      "What is the smallest next step that produces an observable signal?",
      "Did the dev consent to executing this step, or do they want to run it themselves?",
      "What did the result of the previous step actually show \u2014 should the next step adapt?",
      "Are these read-only commands batchable in one beat, or must each run separately?",
      "Is the dev still tracking, or should I pause and recap?"
    ],
    anti_patterns_to_check: [
      "Chaining multiple mutations without per-step consent",
      'Skipping ahead because the next step "feels obvious"',
      "Long autonomous loops without checking back in",
      "Hiding intermediate output behind a summary instead of showing the raw result",
      "Mixing read-only and mutating commands in the same batch"
    ],
    knowledge_categories_to_consult: [
      "workflow-rituals",
      "incident-log",
      "team-capabilities"
    ],
    keywords: [
      // English
      "tutor",
      "step by step",
      "step-by-step",
      "walk through",
      "walkthrough",
      "teach me",
      "show me",
      "learn",
      "debug live",
      "production",
      "manual",
      "guide",
      // English — expanded (CAP-6 EN mirror)
      "mentor",
      "mentoring",
      "pair programming",
      "pair",
      "explain",
      // pt-BR
      "me ensine",
      "me ensina",
      "me mostre",
      "me mostra",
      "passo a passo",
      "passo-a-passo",
      "me guie",
      "me guia",
      "aprender",
      "debug ao vivo",
      "produ\xE7\xE3o",
      "guia",
      "tutorial"
    ],
    auto_pickable: false
  }
];
var PERSONA_SLUGS = PERSONAS.map(
  (p) => p.slug
);
function getPersonaBySlug(slug) {
  return PERSONAS.find((p) => p.slug === slug) ?? null;
}
function scorePersonas(subject) {
  const lower = subject.toLowerCase();
  const scores = [];
  for (const persona of PERSONAS) {
    if (persona.auto_pickable === false) continue;
    const matched = [];
    for (const kw of persona.keywords) {
      if (lower.includes(kw)) matched.push(kw);
    }
    if (matched.length === 0) continue;
    scores.push({
      persona: persona.slug,
      name: persona.name,
      score: matched.length,
      matched_keywords: matched
    });
  }
  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.persona.localeCompare(b.persona);
  });
  return scores;
}

// src/tools/persona-review.ts
var personaReviewInputSchema = z.object({
  project_root: z.string().optional(),
  subject: z.string().min(10, "subject must be \u226510 chars").describe(
    "The thing being reviewed \u2014 a task description, a spec excerpt, a code block, a diff summary. The persona returns a checklist tailored to it."
  ),
  persona: z.enum(PERSONA_SLUGS).describe(
    `Persona slug. One of: ${PERSONA_SLUGS.join(", ")}. Call rsct_auto_persona first if you do not know which to use.`
  )
}).strict();
var personaReviewTool = {
  name: "rsct_persona_review",
  description: "Returns the chosen persona's lens (focus areas + questions + anti-patterns + knowledge categories) tailored to a subject. Read-only, no \xA7C-gate, no state. Use when you have a concrete subject (a spec, a code block, a diff) and want to review it through a specific lens. Call rsct_auto_persona first if you need help picking the persona.",
  inputSchema: {
    type: "object",
    required: ["subject", "persona"],
    properties: {
      project_root: { type: "string" },
      subject: { type: "string", minLength: 10 },
      persona: { type: "string", enum: [...PERSONA_SLUGS] }
    },
    additionalProperties: false
  }
};
async function personaReviewHandler(rawInput) {
  const input = personaReviewInputSchema.parse(rawInput ?? {});
  const persona = getPersonaBySlug(input.persona);
  if (persona === null) {
    throw new Error(
      `unknown persona slug: ${input.persona} (this should be unreachable via Zod enum)`
    );
  }
  const lower = input.subject.toLowerCase();
  const subjectSignals = persona.keywords.filter((kw) => lower.includes(kw));
  const hints = [];
  if (subjectSignals.length === 0) {
    const ranked = scorePersonas(input.subject);
    const top = ranked[0];
    if (top && top.persona !== persona.slug) {
      hints.push(
        `None of '${persona.slug}'s keywords matched the subject. The '${top.persona}' persona has ${top.score} keyword hit(s) \u2014 consider rsct_persona_review with persona='${top.persona}' for a more relevant lens.`
      );
    } else {
      hints.push(
        `None of '${persona.slug}'s keywords matched the subject \u2014 the lens is still valid, but the persona may not be the best fit. Try rsct_auto_persona to see alternatives.`
      );
    }
  } else {
    hints.push(
      `Persona '${persona.slug}' matched ${subjectSignals.length} signal(s): ${subjectSignals.join(", ")}. Review the subject against the listed questions and anti-patterns; consult the named knowledge categories before proceeding.`
    );
  }
  return {
    persona: persona.slug,
    name: persona.name,
    one_liner: persona.one_liner,
    focus_areas: [...persona.focus_areas],
    questions_to_ask: [...persona.questions_to_ask],
    anti_patterns_to_check: [...persona.anti_patterns_to_check],
    knowledge_categories_to_consult: [...persona.knowledge_categories_to_consult],
    subject_signals: subjectSignals,
    hints
  };
}
var autoPersonaInputSchema = z.object({
  project_root: z.string().optional(),
  task_description: z.string().min(10, "task_description must be \u226510 chars").describe(
    "Natural-language description of the task or subject being reviewed. The heuristic scans for each persona's keyword set (substring, case-insensitive)."
  )
}).strict();
var autoPersonaTool = {
  name: "rsct_auto_persona",
  description: "Heuristic recommendation of the best-fit persona for a task. Scans the task description for each persona's keyword set (substring, case-insensitive) and returns the top match plus ranked alternatives. Returns recommended_persona=null when no persona keyword matches \u2014 that usually means the task description is too short or generic; consider rephrasing or calling rsct_persona_review with an explicit choice (e.g., 'senior-dev' as the default reviewer).",
  inputSchema: {
    type: "object",
    required: ["task_description"],
    properties: {
      project_root: { type: "string" },
      task_description: { type: "string", minLength: 10 }
    },
    additionalProperties: false
  }
};
async function autoPersonaHandler(rawInput) {
  const input = autoPersonaInputSchema.parse(rawInput ?? {});
  const ranked = scorePersonas(input.task_description);
  const top = ranked[0];
  const alternatives = ranked.slice(1);
  const hints = [];
  if (!top) {
    hints.push(
      "No persona keyword matched the task description. The description may be too short or too abstract. Default to 'senior-dev' as a generalist reviewer, or pass an explicit slug to rsct_persona_review."
    );
    return {
      recommended_persona: null,
      recommendation_score: 0,
      reasoning: "no persona keywords matched the task description",
      alternatives: [],
      all_persona_slugs: PERSONA_SLUGS,
      hints
    };
  }
  hints.push(
    `Recommended persona: '${top.persona}' (${top.score} keyword hit(s): ${top.matched_keywords.join(", ")}). ${alternatives.length > 0 ? `${alternatives.length} alternative(s) available.` : "No alternatives matched."}`
  );
  return {
    recommended_persona: top.persona,
    recommendation_score: top.score,
    reasoning: `Top persona '${top.persona}' matched ${top.score} keyword(s): ${top.matched_keywords.join(", ")}.`,
    alternatives,
    all_persona_slugs: PERSONA_SLUGS,
    hints
  };
}
var STEP_KIND_VALUES = [
  "propose",
  "execute",
  "read-batch",
  "observe",
  "complete"
];
var tutorStepInputSchema = z.object({
  project_root: z.string().optional(),
  spec_ref: z.string().min(3, "spec_ref required (\u22653 chars)").describe(
    "Free-form identifier correlating steps of one Tutor session. Typically a plan slug or task name."
  ),
  step_description: z.string().min(10, "step_description must be \u226510 chars").describe(
    "What this step is. For step_kind=propose: the action to take next. For execute/observe: a one-line description of what happened. For complete: the close-out summary."
  ),
  step_kind: z.enum(STEP_KIND_VALUES).describe(
    "propose = Claude suggests next step; execute = step was executed (by dev or Claude with consent); read-batch = multiple read-only commands in one beat; observe = recording a finding; complete = end the Tutor session for this spec_ref."
  ),
  result: z.string().optional().describe(
    "Outcome of the step. For propose: usually omitted. For execute/observe/read-batch/complete: a short summary of the result the dev observed."
  ),
  batch_commands: z.array(z.string()).optional().describe(
    'Only meaningful when step_kind=read-batch. List of read-only commands run in one beat (e.g., ["df -h","free -m","systemctl status nginx"]).'
  )
}).strict();
var tutorStepTool = {
  name: "rsct_tutor_step",
  description: 'Log one step of an interactive Tutor session. Tutor (the 6th persona) walks the dev through a task ONE step at a time: propose \u2192 consent \u2192 execute \u2192 observe \u2192 next. Each call appends a `tutor.step` event to .rsct/audit.log so the session is auditable and can resume after /clear. The tool returns a resume_block \u2014 a markdown snippet the dev can paste in a new chat to continue from the last step. NOT \xA7C-gated (audit append only). Opt-in: rsct_auto_persona never recommends Tutor; the dev must choose it explicitly via rsct_persona_review with slug="tutor".',
  inputSchema: {
    type: "object",
    required: ["spec_ref", "step_description", "step_kind"],
    properties: {
      project_root: { type: "string" },
      spec_ref: { type: "string", minLength: 3 },
      step_description: { type: "string", minLength: 10 },
      step_kind: { type: "string", enum: [...STEP_KIND_VALUES] },
      result: { type: "string" },
      batch_commands: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
  }
};
function auditFields10(audit) {
  if (audit.ok) return { audit_path: audit.path, audit_error: null };
  if (audit.reason === "disabled") return { audit_path: null, audit_error: null };
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? "write_failed"
  };
}
function countPriorSteps(auditPath, specRef) {
  if (!existsSync(auditPath)) return 0;
  let raw;
  try {
    raw = readFileSync(auditPath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.event === "tutor.step" && entry.spec_ref === specRef) count++;
  }
  return count;
}
function buildResumeBlock(input) {
  const resultLine = input.result !== void 0 ? `
> Last result: ${input.result.length > 200 ? `${input.result.slice(0, 200)}\u2026` : input.result}` : "";
  const status = input.isComplete ? "completed" : `at step ${input.stepNumber}`;
  return [
    `> Resume Tutor session for spec '${input.specRef}' (${status}).`,
    `> Last step (${input.stepKind}): ${input.stepDescription}`,
    resultLine.trim() ? resultLine.replace(/^\n/, "") : "",
    `> Next: ${input.isComplete ? "session is complete \u2014 start a new spec or session" : "propose the next step deliberately; do not chain ahead"}.`
  ].filter((line) => line.length > 0).join("\n");
}
async function tutorStepHandler(rawInput) {
  const input = tutorStepInputSchema.parse(rawInput ?? {});
  const resolution = resolveProjectRoot(input.project_root);
  const projectRoot = resolution.root;
  const config = resolution.config;
  if (input.step_kind === "read-batch" && !input.batch_commands) ;
  const auditPath = resolveAuditPath(projectRoot, config?.audit);
  const priorCount = countPriorSteps(auditPath, input.spec_ref);
  const stepNumber = priorCount + 1;
  const isComplete = input.step_kind === "complete";
  const baseEntry = {
    event: "tutor.step",
    tool: "rsct_tutor_step",
    spec_ref: input.spec_ref,
    step_kind: input.step_kind,
    step_number: stepNumber,
    step_description: input.step_description,
    ...input.result !== void 0 ? { result: input.result } : {},
    ...input.batch_commands !== void 0 ? { batch_commands: input.batch_commands } : {}
  };
  const audit = appendAuditEntry(projectRoot, baseEntry, config?.audit);
  const fields = auditFields10(audit);
  const resume = buildResumeBlock({
    specRef: input.spec_ref,
    stepKind: input.step_kind,
    stepDescription: input.step_description,
    stepNumber,
    result: input.result,
    isComplete
  });
  const hints = [];
  if (isComplete) {
    hints.push(
      `Tutor session for '${input.spec_ref}' marked complete after ${stepNumber} step(s). To start a new session, call rsct_tutor_step with a new spec_ref + step_kind='propose'.`
    );
  } else {
    hints.push(
      `Step ${stepNumber} logged (${input.step_kind}). Continue with the NEXT step only after the dev has executed/observed this one \u2014 never chain ahead in Tutor mode.`
    );
  }
  if (input.step_kind === "read-batch" && input.batch_commands && input.batch_commands.length > 5) {
    hints.push(
      `${input.batch_commands.length} commands in one batch is generous \u2014 consider splitting at the next opportunity so the dev keeps tracking the output between groups.`
    );
  }
  if (fields.audit_error !== null) {
    hints.push(`\u26A0 tutor.step audit write failed: ${fields.audit_error}.`);
  }
  return {
    spec_ref: input.spec_ref,
    step_kind: input.step_kind,
    step_number: stepNumber,
    is_complete: isComplete,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    resume_block: resume,
    hints
  };
}
var MIME_MARKDOWN = "text/markdown";
var STATIC_RESOURCES = [
  {
    uri: "rsct://decisions",
    name: "Decisions",
    description: "documentation/decisions.md \u2014 firm premises + ADRs.",
    mimeType: MIME_MARKDOWN
  },
  {
    uri: "rsct://architecture",
    name: "Architecture overview",
    description: "documentation/architecture.md \u2014 stack, runtime flow, source layout.",
    mimeType: MIME_MARKDOWN
  },
  {
    uri: "rsct://plan",
    name: "Active plan",
    description: "The most-recently-modified plan_<slug>.md at project root \u2014 the current in-flight work plan.",
    mimeType: MIME_MARKDOWN
  },
  {
    uri: "rsct://progress",
    name: "Active progress",
    description: "progress_<slug>.md matching the active plan.",
    mimeType: MIME_MARKDOWN
  }
];
var RESOURCE_TEMPLATES = [
  {
    uriTemplate: "rsct://knowledge/{category}",
    name: "Knowledge category",
    description: "documentation/knowledge/{category}.md \u2014 institutional knowledge by category (business-rules, anti-decisions, incident-log, etc.).",
    mimeType: MIME_MARKDOWN
  }
];
function readResource(uri, projectRoot) {
  const root = resolveProjectRoot(projectRoot).root;
  if (uri === "rsct://decisions") {
    return readFileResource(uri, join(root, "documentation", "decisions.md"));
  }
  if (uri === "rsct://architecture") {
    return readFileResource(uri, join(root, "documentation", "architecture.md"));
  }
  if (uri === "rsct://plan") {
    const plan = findActivePlan(root);
    if (!plan) throw notFound(uri, "no plan_<slug>.md found at project root");
    return readFileResource(uri, plan.plan_path);
  }
  if (uri === "rsct://progress") {
    const plan = findActivePlan(root);
    if (!plan) throw notFound(uri, "no active plan, so no matching progress file");
    if (!plan.progress_path) {
      throw notFound(uri, `progress_${plan.slug}.md does not exist next to the active plan`);
    }
    return readFileResource(uri, plan.progress_path);
  }
  const knowledgeMatch = uri.match(/^rsct:\/\/knowledge\/([A-Za-z0-9_-]+)$/);
  if (knowledgeMatch?.[1]) {
    return readFileResource(
      uri,
      join(root, "documentation", "knowledge", `${knowledgeMatch[1]}.md`)
    );
  }
  throw notFound(uri, "URI does not match any rsct:// resource or template");
}
function readFileResource(uri, path) {
  if (!existsSync(path)) throw notFound(uri, `file does not exist: ${path}`);
  const text = readFileSync(path, "utf8");
  return { uri, mimeType: MIME_MARKDOWN, text };
}
function notFound(uri, detail) {
  return new Error(`Resource not found (${uri}): ${detail}`);
}

// src/index.ts
var SERVER_NAME = "rsct-mcp";
var SERVER_VERSION = RSCT_MCP_VERSION;
var logger = pino(
  {
    level: process.env.RSCT_LOG_LEVEL ?? "info",
    base: { name: SERVER_NAME, version: SERVER_VERSION },
    timestamp: pino.stdTimeFunctions.isoTime
  },
  pino.destination(2)
);
var TOOLS = [
  statusTool,
  loadContextTool,
  getDecisionsTool,
  getKnowledgeTool,
  getEnvironmentsTool,
  getArchitectureTool,
  checkPremiseTool,
  checkBranchTool,
  checkSecretsTool,
  checkEditScopeTool,
  requestCommitTool,
  requestPushTool,
  requestMergeTool,
  classifyTaskTool,
  phaseStatusTool,
  phaseResearchStartTool,
  phaseResearchCompleteTool,
  phaseSpecStartTool,
  phaseSpecCompleteTool,
  phaseVerificationStartTool,
  phaseVerificationCompleteTool,
  phaseCodeStartTool,
  phaseCodeCompleteTool,
  phaseTestStartTool,
  phaseTestCompleteTool,
  phaseAbandonTool,
  captureIssueTool,
  personaReviewTool,
  autoPersonaTool,
  tutorStepTool
];
var HANDLERS = {
  rsct_status: statusHandler,
  rsct_load_context: loadContextHandler,
  rsct_get_decisions: getDecisionsHandler,
  rsct_get_knowledge: getKnowledgeHandler,
  rsct_get_environments: getEnvironmentsHandler,
  rsct_get_architecture: getArchitectureHandler,
  rsct_check_premise: checkPremiseHandler,
  rsct_check_branch: checkBranchHandler,
  rsct_check_secrets: checkSecretsHandler,
  rsct_check_edit_scope: checkEditScopeHandler,
  rsct_request_commit: requestCommitHandler,
  rsct_request_push: requestPushHandler,
  rsct_request_merge: requestMergeHandler,
  rsct_classify_task: classifyTaskHandler,
  rsct_phase_status: phaseStatusHandler,
  rsct_phase_research_start: phaseResearchStartHandler,
  rsct_phase_research_complete: phaseResearchCompleteHandler,
  rsct_phase_spec_start: phaseSpecStartHandler,
  rsct_phase_spec_complete: phaseSpecCompleteHandler,
  rsct_phase_verification_start: phaseVerificationStartHandler,
  rsct_phase_verification_complete: phaseVerificationCompleteHandler,
  rsct_phase_code_start: phaseCodeStartHandler,
  rsct_phase_code_complete: phaseCodeCompleteHandler,
  rsct_phase_test_start: phaseTestStartHandler,
  rsct_phase_test_complete: phaseTestCompleteHandler,
  rsct_phase_abandon: phaseAbandonHandler,
  rsct_capture_issue: captureIssueHandler,
  rsct_persona_review: personaReviewHandler,
  rsct_auto_persona: autoPersonaHandler,
  rsct_tutor_step: tutorStepHandler
};
async function main() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const handler = HANDLERS[name];
    if (!handler) {
      logger.warn({ name }, "unknown tool requested");
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }
        ],
        isError: true
      };
    }
    try {
      const result = await handler(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ name, err }, "tool handler threw");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message, tool: name })
          }
        ],
        isError: true
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    try {
      const result = readResource(uri);
      return {
        contents: [
          {
            uri: result.uri,
            mimeType: result.mimeType,
            text: result.text
          }
        ]
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ uri, err }, "resource read failed");
      throw new Error(message);
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    {
      tools: TOOLS.map((t) => t.name),
      resources: STATIC_RESOURCES.map((r) => r.uri),
      resource_templates: RESOURCE_TEMPLATES.map((r) => r.uriTemplate)
    },
    "rsct-mcp ready"
  );
}
main().catch((err) => {
  logger.fatal({ err }, "rsct-mcp failed to start");
  process.exit(1);
});
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map