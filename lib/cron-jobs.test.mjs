import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./cron-jobs.ts");
}

const {
  applyCronAction,
  listCronJobs,
  mutateCronJob,
  parseCronStore,
  readCronPrompt,
  readCronStatus,
  readCronStore,
  resolveCronPaths,
  startCronDaemon,
} = await loadSubject();

const BASE_JOB = {
  id: "daily-report",
  name: "Daily report",
  enabled: true,
  kind: "cron",
  schedule: "0 9 * * *",
  timezone: "Asia/Shanghai",
  promptFile: "",
  createdAt: "2026-09-01T00:00:00.000Z",
};

function makePaths(root) {
  const cronDir = path.join(root, "cron");
  const extDir = path.join(root, "npm", "node_modules", "@ryan_nookpi", "pi-extension-cron");
  fs.mkdirSync(cronDir, { recursive: true });
  fs.mkdirSync(path.join(cronDir, "prompts"), { recursive: true });
  fs.mkdirSync(extDir, { recursive: true });
  return {
    agentDir: root,
    cronDir,
    jobsPath: path.join(cronDir, "jobs.json"),
    promptsDir: path.join(cronDir, "prompts"),
    daemonPidPath: path.join(cronDir, "daemon.pid"),
    daemonLogPath: path.join(cronDir, "daemon.log"),
    daemonErrLogPath: path.join(cronDir, "daemon.err.log"),
    extDir,
    daemonPath: path.join(extDir, "daemon.mjs"),
    storeLockPath: path.join(extDir, "store-lock.mjs"),
    launchdPlistPath: path.join(root, "LaunchAgents", "dev.pi.cron.plist"),
  };
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-jobs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseCronStore tolerates null/empty and rejects garbage", () => {
  assert.deepEqual(parseCronStore(null).jobs, []);
  assert.deepEqual(parseCronStore("").jobs, []);
  assert.throws(() => parseCronStore("{nope"));
  assert.throws(() => parseCronStore("[1,2]"));
  assert.throws(() => parseCronStore('"a string"'));
  assert.throws(() => parseCronStore("{}")); // no jobs/history arrays at all
});

test("parseCronStore keeps valid entries and drops malformed ones", () => {
  const store = parseCronStore(
    JSON.stringify({
      version: 2,
      jobs: [{ id: "a", name: "A" }, { name: "no id" }, null, "junk"],
      history: [{ id: "h", name: "done" }],
    })
  );
  assert.deepEqual(store.jobs.map((job) => job.id), ["a"]);
  assert.deepEqual(store.history.map((job) => job.id), ["h"]);
  assert.equal(store.version, 2);
});

test("readCronStore: missing file → empty; valid file → parsed", (t) => {
  const paths = makePaths(tmpdir(t));
  assert.deepEqual(readCronStore(paths).jobs, []);
  fs.writeFileSync(paths.jobsPath, JSON.stringify({ version: 2, jobs: [{ id: "x" }], history: [] }));
  assert.equal(readCronStore(paths).jobs[0].id, "x");
});

test("applyCronAction enable matches official field semantics", () => {
  const job = { ...BASE_JOB, enabled: false, disabledReason: "user_disabled", completedAt: "2026-09-10T00:00:00.000Z" };
  const updated = applyCronAction(job, "enable");
  assert.equal(updated.enabled, true);
  assert.equal(updated.disabledReason, undefined);
  assert.equal(updated.completedAt, undefined);
  assert.equal(updated.schedule, "0 9 * * *"); // untouched fields preserved
  assert.equal(updated.id, "daily-report");
  const roundTripped = JSON.parse(JSON.stringify(updated));
  assert.equal("disabledReason" in roundTripped, false);
  assert.equal("completedAt" in roundTripped, false);
});

test("applyCronAction disable clears scheduling and tags user_disabled", () => {
  const updated = applyCronAction({ ...BASE_JOB, nextRunAt: "2026-09-25T09:00:00.000Z" }, "disable");
  assert.equal(updated.enabled, false);
  assert.equal(updated.disabledReason, "user_disabled");
  assert.equal(updated.nextRunAt, undefined);
  const roundTripped = JSON.parse(JSON.stringify(updated));
  assert.equal("nextRunAt" in roundTripped, false); // official save drops undefined
});

test("applyCronAction run queues now and re-enables", () => {
  const now = new Date("2026-09-24T08:00:00.000Z");
  const updated = applyCronAction({ ...BASE_JOB, enabled: false, disabledReason: "user_disabled" }, "run", now);
  assert.equal(updated.enabled, true);
  assert.equal(updated.nextRunAt, "2026-09-24T08:00:00.000Z");
  assert.equal(updated.disabledReason, undefined);
});

test("resolveCronPaths honors PI_CODING_AGENT_DIR", () => {
  const paths = resolveCronPaths({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" });
  assert.equal(paths.agentDir, "/tmp/custom-agent");
  assert.equal(paths.cronDir, "/tmp/custom-agent/cron");
  assert.ok(paths.storeLockPath.endsWith("pi-extension-cron/store-lock.mjs"));
});

test("readCronStatus reports daemon, extension, and launchd state", (t) => {
  const root = tmpdir(t);
  const paths = makePaths(root);
  // Nothing present yet.
  let status = readCronStatus(paths);
  assert.deepEqual(status, {
    extensionAvailable: false,
    daemonRunning: false,
    pid: null,
    launchdInstalled: false,
    storeExists: false,
  });
  // Extension files + a live pid (our own process) + launchd plist.
  fs.writeFileSync(paths.daemonPath, "// stub");
  fs.writeFileSync(paths.storeLockPath, "export function withStoreLock() {}");
  fs.writeFileSync(paths.daemonPidPath, String(process.pid));
  fs.mkdirSync(path.dirname(paths.launchdPlistPath), { recursive: true });
  fs.writeFileSync(paths.launchdPlistPath, "<plist/>");
  status = readCronStatus(paths);
  assert.equal(status.extensionAvailable, true);
  assert.equal(status.daemonRunning, true);
  assert.equal(status.pid, process.pid);
  assert.equal(status.launchdInstalled, true);
  // Stale pid → not running, pid reported as null.
  fs.writeFileSync(paths.daemonPidPath, "999999999");
  status = readCronStatus(paths);
  assert.equal(status.daemonRunning, false);
  assert.equal(status.pid, null);
});

test("readCronPrompt uses promptFile first, then prompts/<id>.md", (t) => {
  const paths = makePaths(tmpdir(t));
  const explicit = path.join(paths.cronDir, "explicit.md");
  fs.writeFileSync(explicit, "# From promptFile");
  assert.equal(readCronPrompt({ ...BASE_JOB, promptFile: explicit }, paths), "# From promptFile");
  fs.writeFileSync(path.join(paths.promptsDir, "daily-report.md"), "# From prompts dir");
  assert.equal(readCronPrompt({ ...BASE_JOB }, paths), "# From prompts dir");
  assert.equal(readCronPrompt({ ...BASE_JOB, id: "missing-job" }, paths), null);
});

test("listCronJobs returns views with prompts and embedded status", async (t) => {
  const paths = makePaths(tmpdir(t));
  fs.writeFileSync(path.join(paths.promptsDir, "a.md"), "Say hello.");
  fs.writeFileSync(
    paths.jobsPath,
    JSON.stringify({ version: 2, jobs: [{ ...BASE_JOB, id: "a" }], history: [{ ...BASE_JOB, id: "old", enabled: false }] })
  );
  const result = await listCronJobs(paths);
  assert.equal(result.status, "ready");
  assert.equal(result.jobs[0].prompt, "Say hello.");
  assert.equal(result.history[0].id, "old");
  assert.equal(result.daemon.extensionAvailable, false);
  assert.equal(typeof result.capturedAt, "number");
});

test("listCronJobs surfaces corrupt stores as query-failed", async (t) => {
  const paths = makePaths(tmpdir(t));
  fs.writeFileSync(paths.jobsPath, "{broken json");
  const result = await listCronJobs(paths);
  assert.equal(result.status, "query-failed");
  assert.match(result.message, /JSON|cron/);
});

test("mutateCronJob refuses to write without the extension lock", async (t) => {
  const paths = makePaths(tmpdir(t));
  fs.writeFileSync(paths.jobsPath, JSON.stringify({ version: 2, jobs: [{ ...BASE_JOB }], history: [] }));
  await assert.rejects(() => mutateCronJob(paths, "daily-report", "disable"), /cron extension not found/);
});

test("startCronDaemon fails cleanly when the extension is absent", () => {
  const result = startCronDaemon(makePaths(os.tmpdir()));
  assert.equal(result.ok, false);
  assert.match(result.message, /cron extension not found/);
});

test("computeNextRunFallback forces enabled semantics and wires the schedule module", async (t) => {
  const root = tmpdir(t);
  const paths = makePaths(root);
  // Fake extension module with type annotations so the .mts strip path is exercised.
  fs.writeFileSync(
    paths.daemonPath.replace("daemon.mjs", "schedule.ts"),
    `export function calculateNextRun(job, from) {
  if (!job.enabled) return undefined;
  if (job.kind === "at") return job.runAt;
  return "FAKE:" + job.schedule + "@" + (from ? from.toISOString() : "");
}
`
  );
  const { computeNextRunFallback, listCronJobs } = await loadSubject();

  // Paused cron job → passed enabled:true internally → FAKE marker returned.
  const paused = {
    ...BASE_JOB,
    enabled: false,
    disabledReason: "user_disabled",
    nextRunAt: undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
  };
  const next = await computeNextRunFallback(paused, paths, new Date("2026-09-25T00:00:00-07:00"));
  assert.equal(next, "FAKE:0 9 * * *@2026-09-25T07:00:00.000Z");

  // completed_once → null (never show a next run for finished one-shots).
  assert.equal(
    await computeNextRunFallback({ ...paused, disabledReason: "completed_once" }, paths),
    null
  );

  // Timezone mismatch with the server → null (schedule.ts matches server-local).
  assert.equal(await computeNextRunFallback({ ...paused, timezone: "Asia/Tokyo" }, paths), null);

  // at kind passes runAt through.
  assert.equal(
    await computeNextRunFallback({ ...paused, kind: "at", runAt: "2026-10-01T12:00:00.000Z", schedule: undefined }, paths),
    "2026-10-01T12:00:00.000Z"
  );

  // listCronJobs fills a missing nextRunAt via the fallback.
  fs.writeFileSync(paths.jobsPath, JSON.stringify({ version: 2, jobs: [{ ...paused }], history: [] }));
  const listed = await listCronJobs(paths);
  assert.equal(listed.status, "ready");
  // listCronJobs computes with the current clock — assert the wiring, not the time.
  assert.match(listed.jobs[0].nextRunAt, /^FAKE:0 9 \* \* \*@\d{4}-\d{2}-\d{2}T/);
});

test("computeNextRunFallback degrades to null without the extension", async (t) => {
  const paths = makePaths(tmpdir(t)); // ext dir empty — no schedule.ts
  const { computeNextRunFallback } = await loadSubject();
  assert.equal(await computeNextRunFallback({ ...BASE_JOB, enabled: false }, paths), null);
});

test("real extension computes the exact next 9am America/Los_Angeles", {
  skip: !fs.existsSync(path.join(os.homedir(), ".pi/agent/npm/node_modules/@ryan_nookpi/pi-extension-cron/schedule.ts")),
}, async () => {
  const { computeNextRunFallback, resolveCronPaths } = await loadSubject();
  const job = {
    ...BASE_JOB,
    enabled: false,
    disabledReason: "user_disabled",
    timezone: "America/Los_Angeles",
  };
  const next = await computeNextRunFallback(job, resolveCronPaths(), new Date("2026-09-25T00:00:00-07:00"));
  assert.equal(next, new Date("2026-09-25T09:00:00-07:00").toISOString());
});
