import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject(file) {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import(`./${file}`);
}

const { getPlanInfo, projectCommandCodeQuota, resolveCommandCodeAuthKey } = await loadSubject("commandcode-usage.ts");
const { formatDuration, pickCommandCodeWindows, pickHottestWindow } = await loadSubject("commandcode-windows.ts");

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

test("resolves plan info from plan ids with prefix matching", () => {
  assert.deepEqual(getPlanInfo("individual-pro-v1"), {
    planId: "individual-pro-v1",
    name: "Pro",
    monthlyCredits: 80,
  });
  assert.equal(getPlanInfo("individual-pro")?.monthlyCredits, 30);
  assert.deepEqual(getPlanInfo("INDIVIDUAL_MAX"), {
    planId: "individual-max",
    name: "Max",
    monthlyCredits: 150,
  });
  assert.equal(getPlanInfo("individual-ultra")?.name, "Ultra");
  assert.equal(getPlanInfo("teams-pro")?.name, "Teams Pro");
  assert.equal(getPlanInfo("individual-goat")?.name, "GOAT");
  assert.equal(getPlanInfo("unknown-plan"), null);
  assert.equal(getPlanInfo(""), null);
  assert.equal(getPlanInfo(null), null);
});

test("projects usage percent, balance, extra, and windows for an active plan", () => {
  const periodEnd = "2026-01-10T00:00:00.000Z";
  const quota = projectCommandCodeQuota({
    whoami: { org: { id: "org_1", login: "alice" } },
    credits: {
      credits: { planId: "individual-pro-v1", monthlyCredits: 30, purchasedCredits: 10, freeCredits: 0 },
      windowLimits: {
        limited: true,
        exceeded: "weekly",
        fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
        weekly: { used: 50, cap: 35, exceeded: true, resetAt: NOW + 3_600_000 },
      },
    },
    subscription: {
      data: {
        planId: "individual-pro-v1",
        status: "active",
        currentPeriodStart: "2025-12-15T00:00:00.000Z",
        currentPeriodEnd: periodEnd,
      },
    },
    summary: { totalCost: 50 },
    now: NOW,
  });
  assert.equal(quota.planName, "Pro");
  assert.equal(quota.balance, 40);
  assert.equal(quota.extra, 10);
  assert.equal(quota.spent, 50);
  // pool = max(planTotal 80, monthlyRemaining 30) + purchased 10 = 90
  assert.equal(quota.pool, 90);
  assert.ok(Math.abs(quota.percent - (50 / 90) * 100) < 1e-9);
  assert.equal(quota.daysLeft, 9);
  assert.equal(quota.orgLogin, "alice");
  assert.equal(quota.periodEnd, periodEnd);

  // windows: API 侧 5 小时 + 每周，外加从计划推导的每月窗口
  assert.deepEqual(quota.windows.map((window) => window.id), ["fiveHour", "weekly", "monthly"]);
  const [fiveHour, weekly, monthly] = quota.windows;
  assert.equal(fiveHour.used, 0);
  assert.equal(fiveHour.cap, 14);
  assert.equal(fiveHour.resetAt, null); // resetAt: 0 视为无排定重置
  assert.equal(fiveHour.exceeded, false);
  assert.equal(weekly.used, 50);
  assert.equal(weekly.exceeded, true);
  assert.equal(weekly.resetAt, NOW + 3_600_000);
  // monthly: used = max(80, 30) - 30 = 50，cap = 80，重置时间 = 订阅期末
  assert.equal(monthly.used, 50);
  assert.equal(monthly.cap, 80);
  assert.equal(monthly.resetAt, Date.parse(periodEnd));
  assert.equal(monthly.exceeded, false);
});

test("falls back to spent + balance when the plan is not active", () => {
  const quota = projectCommandCodeQuota({
    credits: { credits: { monthlyCredits: 0, purchasedCredits: 40, freeCredits: 0 } },
    subscription: { data: { planId: "individual-max", status: "canceled" } },
    summary: { totalCost: 20 },
    now: NOW,
  });
  assert.equal(quota.planName, "Max");
  assert.equal(quota.balance, 40);
  assert.equal(quota.extra, 40);
  assert.equal(quota.pool, 60);
  assert.ok(Math.abs(quota.percent - (20 / 60) * 100) < 1e-9);
  assert.equal(quota.daysLeft, null);
  // 非 active 计划不推导 monthly 窗口
  assert.deepEqual(quota.windows, []);
});

test("returns zero usage when no billing data exists", () => {
  const quota = projectCommandCodeQuota({ now: NOW });
  assert.equal(quota.planName, null);
  assert.equal(quota.balance, 0);
  assert.equal(quota.extra, 0);
  assert.equal(quota.spent, 0);
  assert.equal(quota.pool, 0);
  assert.equal(quota.percent, 0);
  assert.equal(quota.daysLeft, null);
  assert.deepEqual(quota.windows, []);
});

test("clamps percent to 0 when remaining exceeds the plan total", () => {
  const quota = projectCommandCodeQuota({
    credits: { credits: { monthlyCredits: 120, purchasedCredits: 0, freeCredits: 0 } },
    subscription: { data: { planId: "individual-pro-v1", status: "active", currentPeriodEnd: "2026-01-10T00:00:00.000Z" } },
    summary: { totalCost: 0 },
    now: NOW,
  });
  assert.equal(quota.pool, 120);
  assert.equal(quota.percent, 0);
  // monthlyRemaining > 计划总额时 used 归零
  assert.equal(quota.windows.find((window) => window.id === "monthly")?.used, 0);
});

test("prefers the env api key and trims it", () => {
  assert.deepEqual(
    resolveCommandCodeAuthKey({ env: { COMMAND_CODE_API_KEY: "  env-key  " }, authFilePath: "/nonexistent/auth.json" }),
    { apiKey: "env-key", source: "env" }
  );
});

test("reads the api key from the commandcode auth file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ apiKey: "file-key", userName: "alice" }));

  assert.deepEqual(resolveCommandCodeAuthKey({ env: {}, authFilePath: authFile }), {
    apiKey: "file-key",
    source: "file",
  });
  // An empty env key must fall through to the file.
  assert.deepEqual(
    resolveCommandCodeAuthKey({ env: { COMMAND_CODE_API_KEY: "" }, authFilePath: authFile }),
    { apiKey: "file-key", source: "file" }
  );
});

test("returns null when unauthenticated", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(resolveCommandCodeAuthKey({ env: {}, authFilePath: path.join(dir, "auth.json") }), null);

  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{not json");
  assert.equal(resolveCommandCodeAuthKey({ env: {}, authFilePath: broken }), null);

  const noKey = path.join(dir, "nokey.json");
  fs.writeFileSync(noKey, JSON.stringify({ userName: "alice" }));
  assert.equal(resolveCommandCodeAuthKey({ env: {}, authFilePath: noKey }), null);
});

test("formatDuration matches the CLI's duration format", () => {
  assert.equal(formatDuration(0), "1m");
  assert.equal(formatDuration(45 * 60_000), "45m");
  assert.equal(formatDuration(60 * 60_000), "1h");
  assert.equal(formatDuration(90 * 60_000), "1h 30m");
  assert.equal(formatDuration(25 * 3_600_000), "1d 1h");
  assert.equal(formatDuration(2 * 86_400_000), "2d");
});

test("pickCommandCodeWindows normalizes window payloads", () => {
  const windows = pickCommandCodeWindows({
    limited: true,
    exceeded: "weekly",
    fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
    weekly: { used: 35.0007738324, cap: 35, exceeded: true, resetAt: 1790378949409 },
  });
  assert.deepEqual(windows.map((window) => window.id), ["fiveHour", "weekly"]);
  assert.equal(windows[0].resetAt, null);
  assert.equal(windows[0].exceeded, false);
  assert.equal(windows[1].exceeded, true);
  assert.equal(windows[1].resetAt, 1790378949409);

  // 缺少 cap/used 的条目被跳过；exceeded 缺省由 used >= cap 推导
  const partial = pickCommandCodeWindows({ fiveHour: { used: 1 } });
  assert.deepEqual(partial, []);
  const derived = pickCommandCodeWindows({ weekly: { used: 5, cap: 5 } });
  assert.equal(derived[0]?.exceeded, true);
  assert.equal(pickCommandCodeWindows(null).length, 0);
  assert.equal(pickCommandCodeWindows(undefined).length, 0);
});

test("pickHottestWindow picks the window with the highest usage ratio", () => {
  const windows = pickCommandCodeWindows({
    fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
    weekly: { used: 35.0007738324, cap: 35, exceeded: true, resetAt: 1790378949409 },
  });
  assert.equal(pickHottestWindow(windows)?.id, "weekly");
  assert.equal(pickHottestWindow([]), null);

  // 并列时保留靠前的窗口；cap 为 0 视为 0 进度
  const tied = pickCommandCodeWindows({
    fiveHour: { used: 7, cap: 14, exceeded: false, resetAt: 0 },
    weekly: { used: 5, cap: 10, exceeded: false, resetAt: 0 },
  });
  assert.equal(pickHottestWindow(tied)?.id, "fiveHour");
  assert.equal(pickHottestWindow([{ id: "monthly", used: 3, cap: 0, resetAt: null, exceeded: false }])?.id, "monthly");
});
