import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./mimo-usage.ts");
}

const {
  daysLeftFrom,
  fetchMimoUsage,
  formatTokens,
  parseMimoPeriodEnd,
  parseRelayOutput,
  projectMimoQuota,
  resolveMimoCookie,
} = await loadSubject();

// 2026-09-24 抓取的真实中继响应（数值为当时用量）
const REAL_ENVELOPE = {
  usage: {
    code: 0,
    message: "",
    data: {
      monthUsage: {
        percent: 0.2005,
        items: [{ name: "month_total_token", used: 822235904, limit: 4100000000, percent: 0.2005 }],
      },
      usage: {
        percent: 0.2,
        items: [
          { name: "plan_total_token", used: 822235904, limit: 4100000000, percent: 0.2 },
          { name: "compensation_total_token", used: 0, limit: 0, percent: 0 },
        ],
      },
    },
  },
  detail: {
    code: 0,
    message: "",
    data: {
      planCode: "lite",
      planName: "Lite",
      currentPeriodEnd: "2026-10-23 23:59:59",
      expired: false,
      enableAutoRenew: false,
    },
  },
  balance: {
    code: 0,
    message: "",
    data: { balance: "0.00", currency: "USD", giftBalance: "0.00", cashBalance: "0.00" },
  },
};

const NOW = Date.parse("2026-09-24T00:00:00+08:00");

test("projects the real relay envelope into the quota view", () => {
  const projected = projectMimoQuota(REAL_ENVELOPE, NOW);
  assert.equal(projected?.kind, "ok");
  const quota = projected.quota;
  assert.equal(quota.planName, "Lite");
  assert.equal(quota.planCode, "lite");
  assert.equal(quota.planUsed, 822235904);
  assert.equal(quota.planLimit, 4100000000);
  assert.ok(Math.abs(quota.planPercent - 20) < 1e-9);
  assert.equal(quota.compensation, null); // limit 0 → 不展示补偿积分
  assert.deepEqual(quota.balance, { total: 0, currency: "USD" });
  assert.equal(quota.periodEnd, Date.parse("2026-10-23T23:59:59+08:00"));
  assert.equal(quota.daysLeft, 30); // 2026-09-24 00:00 → 10-23 23:59:59 = 29d23h59m59s → ceil
  assert.equal(quota.expired, false);
});

test("falls back to used/limit and month_total_token when needed", () => {
  const projected = projectMimoQuota(
    {
      usage: {
        code: 0,
        data: {
          usage: { items: [{ name: "month_total_token", used: 500, limit: 1000 }] },
        },
      },
    },
    NOW
  );
  assert.equal(projected?.kind, "ok");
  assert.ok(Math.abs(projected.quota.planPercent - 50) < 1e-9);
  assert.equal(projected.quota.balance, null);
  assert.equal(projected.quota.planName, null);
  assert.equal(projected.quota.daysLeft, null);
});

test("maps 401 payloads to the auth marker and rejects garbage", () => {
  assert.equal(projectMimoQuota({ usage: { code: 401 } }, NOW)?.kind, "auth");
  assert.equal(projectMimoQuota({ detail: { code: 401 } }, NOW)?.kind, "auth");
  assert.equal(projectMimoQuota(null, NOW), null);
  assert.equal(projectMimoQuota({ usage: { code: 500 } }, NOW), null);
  assert.equal(projectMimoQuota({ usage: { code: 0, data: {} } }, NOW), null);
});

test("includes compensation credits when granted", () => {
  const projected = projectMimoQuota(
    {
      usage: {
        code: 0,
        data: {
          usage: {
            items: [
              { name: "plan_total_token", used: 10, limit: 100, percent: 0.1 },
              { name: "compensation_total_token", used: 5, limit: 50, percent: 0.1 },
            ],
          },
        },
      },
    },
    NOW
  );
  assert.deepEqual(projected.quota.compensation, { used: 5, limit: 50, percent: 10 });
});

test("parseMimoPeriodEnd pins Asia/Shanghai wall time", () => {
  assert.equal(parseMimoPeriodEnd("2026-10-23 23:59:59"), Date.parse("2026-10-23T23:59:59+08:00"));
  assert.equal(parseMimoPeriodEnd("2026-10-23T23:59:59Z"), Date.parse("2026-10-23T23:59:59Z"));
  assert.equal(parseMimoPeriodEnd(""), null);
  assert.equal(parseMimoPeriodEnd(undefined), null);
  assert.equal(parseMimoPeriodEnd("not a date"), null);
});

test("formatTokens compacts counts", () => {
  assert.equal(formatTokens(822235904), "822.2M");
  assert.equal(formatTokens(4100000000), "4.10B");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5K");
  assert.equal(daysLeftFrom(Date.parse("2026-10-24T00:00:00+08:00"), NOW), 30);
  assert.equal(daysLeftFrom(NOW - 1, NOW), 0);
});

test("parseRelayOutput tolerates banner noise and rejects non-data output", () => {
  const noisy = `  Update available: v1.8.7 -> v1.8.8\nMIMOQUOTA{"usage":{"code":0}}\nRun: npm install -g x\n`;
  assert.deepEqual(parseRelayOutput(noisy), { usage: { code: 0 } });
  assert.equal(parseRelayOutput("no sentinel here"), null);
  assert.equal(parseRelayOutput("MIMOQUOTAERROR: TypeError: Failed to fetch"), null);
  assert.equal(parseRelayOutput("MIMOQUOTA{broken json}"), null);
});

test("resolveMimoCookie prefers env over the file and handles missing files", (t) => {
  assert.equal(
    resolveMimoCookie({ env: { MIMO_PLATFORM_COOKIE: "  c=1; t=2 " }, cookieFilePath: "/nonexistent" }),
    "c=1; t=2"
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cookieFile = path.join(dir, "mimo-platform-cookie.json");
  fs.writeFileSync(cookieFile, JSON.stringify({ cookie: "file-cookie" }));
  assert.equal(resolveMimoCookie({ env: {}, cookieFilePath: cookieFile }), "file-cookie");
  assert.equal(resolveMimoCookie({ env: {}, cookieFilePath: path.join(dir, "missing.json") }), null);
});

test("fetchMimoUsage uses the browser relay by default and surfaces auth failures", async () => {
  const relay = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec: async () => `noise\nMIMOQUOTA${JSON.stringify(REAL_ENVELOPE)}\n`,
    now: NOW,
  });
  assert.equal(relay.status, "ready");
  assert.equal(relay.quota.planName, "Lite");

  const noData = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec: async () => "nothing useful",
  });
  assert.equal(noData.status, "auth-unavailable");

  const expired = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec: async () => `MIMOQUOTA${JSON.stringify({ usage: { code: 401 } })}`,
  });
  assert.equal(expired.status, "auth-unavailable");

  const broken = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec: async () => {
      throw new Error("opencli ENOENT");
    },
  });
  assert.equal(broken.status, "query-failed");
});

test("fetchMimoUsage reopens the platform when the relay tab drifted to about:blank", async () => {
  const calls = [];
  let evals = 0;
  const relayExec = async (args) => {
    calls.push(args);
    if (args[2] !== "eval") return "";
    evals += 1;
    return evals === 1
      ? "MIMOQUOTAWRONGPAGE:about:blank"
      : `noise\nMIMOQUOTA${JSON.stringify(REAL_ENVELOPE)}\n`;
  };
  const result = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec,
    now: NOW,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.quota.planName, "Lite");
  // 垃圾页（about:blank）就地复用：open 导航当前标签页。
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [["browser", "mimo", "eval"], ["browser", "mimo", "open"], ["browser", "mimo", "eval"]]
  );
  assert.equal(calls[1][3], "https://platform.xiaomimimo.com");
  // 同源守卫必须在 snippet 里，否则跨源 fetch 又会退化成 Failed to fetch。
  assert.match(calls[0][3], /location\.origin==='https:\/\/platform\.xiaomimimo\.com'/);
});

test("fetchMimoUsage spares a real page by opening a new tab instead of navigating it away", async () => {
  const calls = [];
  let evals = 0;
  const relayExec = async (args) => {
    calls.push(args);
    if (args[2] !== "eval") return "";
    evals += 1;
    // 漂移到 Pi Web 应用自身 —— 绝不能把当前标签页导航走（否则面板刷新会销毁应用自身）。
    return evals === 1
      ? "MIMOQUOTAWRONGPAGE:http://localhost:30142/"
      : `noise\nMIMOQUOTA${JSON.stringify(REAL_ENVELOPE)}\n`;
  };
  const result = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec,
    now: NOW,
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [["browser", "mimo", "eval"], ["browser", "mimo", "tab", "new"].slice(0, 3), ["browser", "mimo", "eval"]]
  );
  assert.equal(calls[1][3], "new");
  assert.equal(calls[1][4], "https://platform.xiaomimimo.com");
  assert.ok(!calls.some((args) => args[2] === "open"), "open must never navigate a real page away");
});

test("fetchMimoUsage reports the stuck href when the relay tab stays off the platform", async () => {
  const calls = [];
  const relayExec = async (args) => {
    calls.push(args);
    return args[2] === "eval" ? "MIMOQUOTAWRONGPAGE:https://example.com/" : "";
  };
  const result = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec,
  });
  assert.equal(result.status, "auth-unavailable");
  assert.match(result.message, /https:\/\/example\.com\//);
  // 恢复尝试只做一次，不循环。
  assert.equal(calls.filter((args) => args[2] === "tab").length, 1);
  assert.equal(calls.filter((args) => args[2] === "eval").length, 2);
});

test("fetchMimoUsage maps relay fetch errors to query-failed with detail", async () => {
  const relayExec = async () => "MIMOQUOTAERROR:TypeError: Failed to fetch\nbanner noise";
  const result = await fetchMimoUsage({
    env: {},
    cookieFilePath: "/nonexistent/mimo.json",
    relayExec,
  });
  assert.equal(result.status, "query-failed");
  assert.match(result.message, /Browser relay fetch failed: TypeError: Failed to fetch$/);
});

test("fetchMimoUsage direct cookie path talks to the platform API", async () => {
  const calls = [];
  const result = await fetchMimoUsage({
    env: { MIMO_PLATFORM_COOKIE: "serviceToken=abc" },
    fetchImpl: async (input) => {
      calls.push(String(input));
      return {
        json: async () => (String(input).endsWith("/balance") ? REAL_ENVELOPE.balance : String(input).endsWith("/detail") ? REAL_ENVELOPE.detail : REAL_ENVELOPE.usage),
      };
    },
    now: NOW,
  });
  assert.equal(result.status, "ready");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => url.startsWith("https://platform.xiaomimimo.com/api/v1/")));
});
