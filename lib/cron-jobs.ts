import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { openSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Server-only access to the @ryan_nookpi/pi-extension-cron store.
 *
 * Read path: jobs.json + prompts/*.md directly (atomic writes by the extension
 * mean readers never see partial JSON).
 * Write path: the extension's own store-lock.mjs (same `jobs.lock` the daemon
 * takes) so enable/disable/run cannot race the scheduler.
 *
 * Field semantics mirror the extension's own handlers (index.ts):
 *   enable  → enabled:true, disabledReason/completedAt cleared
 *             (nextRunAt deliberately left unset — the daemon's repair pass
 *             recomputes it for enabled jobs, see daemon.mjs)
 *   disable → enabled:false, nextRunAt cleared, disabledReason:"user_disabled"
 *   run     → enabled:true, nextRunAt:now (daemon claims it on its next pass)
 *             + ensure the daemon is running (official `cron run` does this).
 *
 * Client components must only type-import from this module (it pulls in
 * node:child_process — value imports would break the browser bundle).
 */

export type CronJobKind = "cron" | "at" | "delay";
export type CronScope = "user" | "project" | "session";
export type CronJobAction = "enable" | "disable" | "run";

export interface StoredCronJob {
  id: string;
  name: string;
  enabled: boolean;
  kind: CronJobKind;
  once?: boolean;
  schedule?: string;
  runAt?: string;
  timezone?: string;
  cwd?: string;
  promptFile?: string;
  scope?: CronScope;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  running?: boolean;
  lastExitCode?: number;
  disabledReason?: "completed_once" | "user_disabled" | "error";
  completedAt?: string;
  lastRunLog?: string;
}

export interface CronJobView extends StoredCronJob {
  /** Full self-contained prompt markdown (null when the file is missing). */
  prompt: string | null;
}

export interface CronStore {
  version: number;
  jobs: StoredCronJob[];
  history: StoredCronJob[];
}

export interface CronDaemonStatus {
  extensionAvailable: boolean;
  daemonRunning: boolean;
  pid: number | null;
  launchdInstalled: boolean;
  storeExists: boolean;
}

export type CronJobsResult =
  | {
      status: "ready";
      jobs: CronJobView[];
      history: CronJobView[];
      daemon: CronDaemonStatus;
      capturedAt: number;
      actionError?: string;
    }
  | { status: "query-failed"; message: string };

export interface CronPaths {
  agentDir: string;
  cronDir: string;
  jobsPath: string;
  promptsDir: string;
  daemonPidPath: string;
  daemonLogPath: string;
  daemonErrLogPath: string;
  extDir: string;
  daemonPath: string;
  storeLockPath: string;
  launchdPlistPath: string;
}

export const CRON_EXTENSION_PACKAGE = "@ryan_nookpi/pi-extension-cron";
const MAX_PROMPT_CHARS = 40_000;

export function resolveCronPaths(env: NodeJS.ProcessEnv = process.env): CronPaths {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const cronDir = join(agentDir, "cron");
  const extDir = join(agentDir, "npm", "node_modules", CRON_EXTENSION_PACKAGE);
  return {
    agentDir,
    cronDir,
    jobsPath: join(cronDir, "jobs.json"),
    promptsDir: join(cronDir, "prompts"),
    daemonPidPath: join(cronDir, "daemon.pid"),
    daemonLogPath: join(cronDir, "daemon.log"),
    daemonErrLogPath: join(cronDir, "daemon.err.log"),
    extDir,
    daemonPath: join(extDir, "daemon.mjs"),
    storeLockPath: join(extDir, "store-lock.mjs"),
    launchdPlistPath: join(homedir(), "Library", "LaunchAgents", "dev.pi.cron.plist"),
  };
}

export function emptyCronStore(): CronStore {
  return { version: 2, jobs: [], history: [] };
}

/** Pure parser: null/empty → empty store; bad JSON or shape → throws. */
export function parseCronStore(raw: string | null | undefined): CronStore {
  if (raw === null || raw === undefined || raw.trim() === "") return emptyCronStore();
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cron jobs.json is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const jobs = Array.isArray(record.jobs) ? record.jobs : null;
  const history = Array.isArray(record.history) ? record.history : null;
  if (!jobs && !history) throw new Error("cron jobs.json has no jobs/history arrays");
  const keep = (list: unknown[] | null): StoredCronJob[] =>
    (list ?? []).filter(
      (entry): entry is StoredCronJob =>
        Boolean(entry) && typeof entry === "object" && typeof (entry as StoredCronJob).id === "string"
    );
  return {
    version: typeof record.version === "number" ? record.version : 2,
    jobs: keep(jobs),
    history: keep(history),
  };
}

/** Missing file → empty store (extension present but never created a job). */
export function readCronStore(paths: CronPaths): CronStore {
  try {
    return parseCronStore(readFileSync(paths.jobsPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCronStore();
    throw error;
  }
}

export function readCronPrompt(job: StoredCronJob, paths: CronPaths): string | null {
  const candidates: string[] = [];
  if (job.promptFile) candidates.push(job.promptFile);
  candidates.push(join(paths.promptsDir, `${job.id}.md`));
  for (const candidate of candidates) {
    try {
      const markdown = readFileSync(candidate, "utf8");
      return markdown.length > MAX_PROMPT_CHARS ? `${markdown.slice(0, MAX_PROMPT_CHARS)}\n…` : markdown;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function toCronJobView(job: StoredCronJob, paths: CronPaths): CronJobView {
  return { ...job, prompt: readCronPrompt(job, paths) };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readCronStatus(paths: CronPaths): CronDaemonStatus {
  let pid: number | null = null;
  try {
    const raw = readFileSync(paths.daemonPidPath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    // No pid file → not running.
  }
  return {
    extensionAvailable: existsSync(paths.daemonPath) && existsSync(paths.storeLockPath),
    daemonRunning: pid !== null && pidAlive(pid),
    pid: pid !== null && pidAlive(pid) ? pid : null,
    launchdInstalled: existsSync(paths.launchdPlistPath),
    storeExists: existsSync(paths.jobsPath),
  };
}

/**
 * Official field semantics (mirrors index.ts handlers). Pure — unit tested.
 * nextRunAt uses `undefined` on enable/disable; JSON.stringify drops the key,
 * which is exactly what the extension's saveStore produces.
 */
export function applyCronAction(
  job: StoredCronJob,
  action: CronJobAction,
  now: Date = new Date()
): StoredCronJob {
  if (action === "enable") {
    const enabled = { ...job, enabled: true, disabledReason: undefined, completedAt: undefined };
    return enabled;
  }
  if (action === "disable") {
    return { ...job, enabled: false, nextRunAt: undefined, disabledReason: "user_disabled" };
  }
  return { ...job, enabled: true, nextRunAt: now.toISOString(), disabledReason: undefined };
}

interface StoreLockModule {
  withStoreLock: <T>(cronDir: string, action: () => T) => T;
  writeAtomicFile: (path: string, content: string) => void;
}

function historySortKey(job: StoredCronJob): string {
  return job.completedAt ?? job.lastRunAt ?? job.updatedAt ?? "";
}

function saveCronStore(paths: CronPaths, lock: StoreLockModule, store: CronStore): void {
  const jobs = [...store.jobs].sort((a, b) => a.id.localeCompare(b.id));
  const history = [...store.history].sort(
    (a, b) => historySortKey(b).localeCompare(historySortKey(a)) || a.id.localeCompare(b.id)
  );
  lock.writeAtomicFile(
    paths.jobsPath,
    `${JSON.stringify({ version: 2, jobs, history }, null, 2)}\n`
  );
}

/** Read-modify-write under the extension's shared jobs.lock. */
async function withCronLock<T>(paths: CronPaths, update: (store: CronStore) => T): Promise<T> {
  if (!existsSync(paths.storeLockPath)) {
    throw new Error(`cron extension not found at ${paths.extDir}`);
  }
  const lock = (await importExternalModule(pathToFileURL(paths.storeLockPath).href)) as StoreLockModule;
  return lock.withStoreLock(paths.cronDir, () => {
    const store = readCronStore(paths);
    const result = update(store);
    saveCronStore(paths, lock, store);
    return result;
  });
}

export async function mutateCronJob(
  paths: CronPaths,
  id: string,
  action: CronJobAction,
  now: Date = new Date()
): Promise<StoredCronJob | undefined> {
  return withCronLock(paths, (store) => {
    const index = store.jobs.findIndex((job) => job.id === id);
    if (index < 0) return undefined;
    const updated = applyCronAction(store.jobs[index], action, now);
    store.jobs[index] = updated;
    return updated;
  });
}

export interface DaemonStartResult {
  ok: boolean;
  message: string;
  pid: number | null;
}

/**
 * Replica of the extension's startDaemon() (daemon-client.ts): spawn
 * `node daemon.mjs` detached with appended logs and PI_CODING_AGENT_DIR.
 */
export function startCronDaemon(paths: CronPaths = resolveCronPaths()): DaemonStartResult {
  if (!existsSync(paths.daemonPath)) {
    return { ok: false, message: `cron extension not found at ${paths.extDir}`, pid: null };
  }
  const status = readCronStatus(paths);
  if (status.daemonRunning) {
    return { ok: true, message: `cron daemon is already running (PID ${status.pid})`, pid: status.pid };
  }
  const stdoutFd = openSync(paths.daemonLogPath, "a");
  const stderrFd = openSync(paths.daemonErrLogPath, "a");
  try {
    const child = spawn(process.execPath, [paths.daemonPath], {
      cwd: paths.agentDir,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: { ...process.env, PI_CODING_AGENT_DIR: paths.agentDir },
    });
    child.unref();
    return { ok: true, message: `cron daemon started (PID ${child.pid})`, pid: child.pid ?? null };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), pid: null };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

/**
 * Dynamic import that survives both worlds: bundlers wrap `import(variable)`
 * and then 500 on absolute file URLs (so Function-constructed import first),
 * while jiti/vm test harnesses lack the import callback inside `new Function`
 * (so fall back to the plain specifier import they transform themselves).
 */
async function importExternalModule(specifier: string): Promise<unknown> {
  try {
    const nativeImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
    return await nativeImport(specifier);
  } catch {
    return await import(specifier);
  }
}

interface ScheduleModule {
  calculateNextRun: (
    job: { enabled: boolean; kind: string; schedule?: string; runAt?: string },
    from?: Date
  ) => string | undefined;
}

/** Server IANA timezone, e.g. "America/Los_Angeles". */
function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

/**
 * Load the extension's own calculateNextRun (schedule.ts).
 *
 * Node refuses to type-strip .ts under node_modules, and bundlers refuse to
 * import() an external file:// URL at runtime — so copy the single self-
 * contained module (its only import is type-only, erased by stripping) to a
 * tmp cache keyed by size+mtime and import that. Keeps the OFFICIAL cron
 * semantics with zero ported code.
 */
async function loadScheduleModule(paths: CronPaths): Promise<ScheduleModule | null> {
  const source = join(paths.extDir, "schedule.ts");
  try {
    const stat = statSync(source);
    const cacheDir = join(tmpdir(), "pi-web-cron");
    const target = join(cacheDir, `schedule-${stat.size}-${stat.mtimeMs}.mts`);
    if (!existsSync(target)) {
      mkdirSync(cacheDir, { recursive: true });
      copyFileSync(source, target);
    }
    return (await importExternalModule(pathToFileURL(target).href)) as ScheduleModule;
  } catch {
    return null;
  }
}

/**
 * Next run for jobs whose stored nextRunAt is missing (paused jobs have it
 * cleared; the daemon's self-heal only covers enabled jobs). Paused jobs get
 * their next *would-be* occurrence so the panel can always show a countdown.
 * Returns null for completed one-shots, timezone mismatches (schedule.ts
 * matches in server-local time, the daemon in job time), or any failure.
 */
export async function computeNextRunFallback(
  job: StoredCronJob,
  paths: CronPaths = resolveCronPaths(),
  now: Date = new Date()
): Promise<string | null> {
  if (job.disabledReason === "completed_once") return null;
  if (job.timezone && serverTimeZone() && job.timezone !== serverTimeZone()) return null;
  const scheduleModule = await loadScheduleModule(paths);
  if (!scheduleModule) return null;
  try {
    // calculateNextRun returns undefined when !enabled — force enabled:true so
    // paused jobs still yield their next scheduled occurrence.
    return (
      scheduleModule.calculateNextRun(
        { enabled: true, kind: job.kind, schedule: job.schedule, runAt: job.runAt },
        now
      ) ?? null
    );
  } catch {
    return null;
  }
}

export async function listCronJobs(
  paths: CronPaths = resolveCronPaths()
): Promise<CronJobsResult> {
  try {
    const store = readCronStore(paths);
    const jobs: CronJobView[] = [];
    for (const job of store.jobs) {
      let view = toCronJobView(job, paths);
      if (!view.nextRunAt) {
        const computed = await computeNextRunFallback(job, paths);
        if (computed) view = { ...view, nextRunAt: computed };
      }
      jobs.push(view);
    }
    return {
      status: "ready",
      jobs,
      history: store.history.map((job) => toCronJobView(job, paths)),
      daemon: readCronStatus(paths),
      capturedAt: Date.now(),
    };
  } catch (error) {
    return { status: "query-failed", message: error instanceof Error ? error.message : String(error) };
  }
}
