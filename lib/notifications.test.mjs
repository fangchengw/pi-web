import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  return {
    notifications: await jiti.import("./notifications.ts"),
    dismiss: await jiti.import("./notification-dismiss.ts"),
    sources: await jiti.import("./notification-sources.ts"),
  };
}

const { notifications, dismiss, sources } = await loadSubject();
const {
  notificationId,
  alertPolicyKey,
  splitSource,
  buildNotificationView,
} = notifications;
const { hideIds, pruneHidden, setAlertOff, loadDismissState, saveDismissState } = dismiss;
const { projectWatchdog, aggregateSources } = sources;

function item(id, overrides = {}) {
  const [ns, ...rest] = id.split(":");
  return {
    id,
    namespace: ns,
    source: rest.slice(0, -1).join(":") || "src",
    origin: "ov",
    kind: "err",
    level: "error",
    title: id,
    body: "b",
    createdAt: 0,
    updatedAt: 0,
    count: 1,
    action: "errors",
    ...overrides,
  };
}

/* ------------------------------ id / display ----------------------------- */

test("notificationId embeds namespace + first_seen so a recurrence gets a fresh id", () => {
  const a = notificationId("watchdog", "OV server.log/WM创建失败", 1790405892);
  const b = notificationId("watchdog", "OV server.log/WM创建失败", 1790500000);
  assert.notEqual(a, b);
  assert.equal(a, "watchdog:OV server.log/WM创建失败:1790405892");
  // Same fingerprint from two different sources must NOT collide.
  assert.notEqual(
    notificationId("watchdog", "cron/x", 1),
    notificationId("cron", "cron/x", 1),
  );
});

test("alertPolicyKey is construction-only and tolerates colons in fingerprints", () => {
  assert.equal(alertPolicyKey("watchdog", "健康检查/ov:1933"), "watchdog:健康检查/ov:1933");
});

test("splitSource splits at the last slash and tolerates a missing one", () => {
  assert.deepEqual(splitSource("OV server.log/VLM/LLM调用失败"), {
    origin: "OV server.log/VLM",
    kind: "LLM调用失败",
  });
  assert.deepEqual(splitSource("no-slash"), { origin: "", kind: "no-slash" });
  assert.deepEqual(splitSource("/leading"), { origin: "", kind: "/leading" });
});

/* ------------------------------ projector -------------------------------- */

test("projectWatchdog maps state to namespaced items sorted by last activity", () => {
  const items = projectWatchdog({
    recent_issues: {
      older: { source: "健康检查/ov", error: "不可达", first_seen: 100, last_seen: 100, count: 1 },
      newer: {
        source: "OV server.log/WM创建失败",
        error: "3条 | 例: 2026-09-26 - ERROR - Memory extraction failed",
        first_seen: 200,
        last_seen: 300,
        count: 3,
      },
    },
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].source, "OV server.log/WM创建失败");
  assert.equal(items[0].namespace, "watchdog");
  assert.equal(items[0].createdAt, 200_000);
  assert.equal(items[0].updatedAt, 300_000);
  assert.equal(items[0].count, 3);
  assert.equal(items[0].origin, "OV server.log");
  assert.equal(items[0].kind, "WM创建失败");
  assert.equal(items[0].title, "OV server.log · WM创建失败");
  assert.equal(items[0].level, "error");
  assert.equal(items[1].level, "error"); // health checks are always errors
  assert.equal(items[1].id, "watchdog:健康检查/ov:100");
  assert.equal(items[1].action, "errors");
});

test("projectWatchdog tolerates missing fields and empty state", () => {
  assert.deepEqual(projectWatchdog({}), []);
  assert.deepEqual(projectWatchdog({ recent_issues: {} }), []);
});

test("warning inference from detail text", () => {
  const [entry] = projectWatchdog({
    recent_issues: {
      w: { source: "OV server.log/WM创建失败", error: "1条 | 例: ... WARNING ...", first_seen: 1, last_seen: 1, count: 1 },
    },
  });
  assert.equal(entry.level, "warning");
});

/* --------------------------- source registry ----------------------------- */

test("aggregateSources merges and sorts across sources", () => {
  const out = aggregateSources([
    { id: "alpha", load: () => ({ items: [item("alpha:s1:100", { updatedAt: 100 })], lastRun: 100 }) },
    { id: "beta", load: () => ({ items: [item("beta:s2:900", { updatedAt: 900 })], lastRun: 900 }) },
  ]);
  assert.equal(out.failures.length, 0);
  assert.equal(out.lastRun, 900);
  assert.deepEqual(out.items.map((i) => i.id), ["beta:s2:900", "alpha:s1:100"]);
});

test("one dead source degrades alone — others keep serving (一个死源不拖垮全端点)", () => {
  const out = aggregateSources([
    { id: "dead", load: () => ({ items: [], lastRun: 0, error: "boom" }) },
    { id: "ok", load: () => ({ items: [item("ok:s:1", { updatedAt: 10 })], lastRun: 10 }) },
  ]);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.failures, [{ id: "dead", message: "boom" }]);
  assert.equal(out.lastRun, 10);
});

test("aggregateSources survives a throwing source (defensive)", () => {
  const out = aggregateSources([
    { id: "throws", load: () => { throw new Error("kaboom"); } },
    { id: "ok", load: () => ({ items: [item("ok:s:1")], lastRun: 0 }) },
  ]);
  assert.equal(out.items.length, 1);
  assert.equal(out.failures[0].id, "throws");
});

/* -------------------------- two-layer view ------------------------------- */

test("hidden hides reminders but items stay in the data layer", () => {
  const { dtos, badge } = buildNotificationView(
    [item("watchdog:a:1"), item("watchdog:b:1")],
    { hidden: { "watchdog:a:1": 123 }, alertOff: {} },
  );
  assert.equal(badge, 1);
  assert.equal(dtos.length, 2);
  assert.equal(dtos[0].dismissed, true);
  assert.equal(dtos[1].dismissed, false);
  assert.equal(dtos[1].alertOff, false);
});

test("fresh id on an UNmuted line always counts — 新错误必回通知", () => {
  const { badge } = buildNotificationView(
    [item("watchdog:OV/x:2000")],
    { hidden: { "watchdog:OV/x:1000": 1 }, alertOff: {} },
  );
  assert.equal(badge, 1, "旧 id 被藏,新代际 id 必须计入");
});

test("mute does NOT hide pre-existing notifications (错误层不动现有)", () => {
  // Line muted at t=5000; this occurrence arrived at t=1000 (before muting).
  const state = { hidden: {}, alertOff: { "watchdog:src": 5000 } };
  const { dtos, badge, newlyHidden } = buildNotificationView(
    [item("watchdog:src:1000", { createdAt: 1000 })],
    state,
  );
  assert.equal(badge, 1, "静音前已存在的通知必须保持可见");
  assert.equal(dtos[0].dismissed, false);
  assert.equal(dtos[0].alertOff, true, "但行上要显示已静音");
  assert.equal(newlyHidden.length, 0);
});

test("arrival DURING mute is suppressed at arrival and reported for persistence", () => {
  const state = { hidden: {}, alertOff: { "watchdog:src": 5000 } };
  const { badge, newlyHidden } = buildNotificationView(
    [item("watchdog:src:9000", { createdAt: 9000 })],
    state,
  );
  assert.equal(badge, 0);
  assert.deepEqual(newlyHidden, ["watchdog:src:9000"]);
});

test("核心: restore arms FUTURE only — 现有不回,新错误才回 (2026-09-26)", () => {
  const line = "watchdog:src";
  const state = { hidden: {}, alertOff: { [line]: 5000 } };

  // 静音期间到达 → 抑制并持久化
  const during = item(`${line}:9000`, { createdAt: 9000 });
  const r1 = buildNotificationView([during], state);
  assert.equal(r1.badge, 0);
  state.hidden = hideIds(state.hidden, r1.newlyHidden, 10000);

  // 恢复:删掉 alertOff —— 现有那条必须回不来
  delete state.alertOff[line];
  const r2 = buildNotificationView([during], state);
  assert.equal(r2.badge, 0, "恢复提醒以后 notification 不变");
  assert.equal(r2.dtos[0].dismissed, true);

  // 直到新错误到来
  const after = item(`${line}:20000`, { createdAt: 20000 });
  const r3 = buildNotificationView([during, after], state);
  assert.equal(r3.badge, 1, "新的错误到来才进通知");
  assert.equal(r3.dtos[1].dismissed, false);
});

test("Clear all only touches the rendered snapshot — 快照后新错误不被吞", () => {
  const snapshot = ["watchdog:n1:1", "watchdog:n2:1"];
  const hidden = hideIds({}, snapshot, 1000);
  assert.deepEqual(Object.keys(hidden).sort(), ["watchdog:n1:1", "watchdog:n2:1"]);
  const { badge } = buildNotificationView(
    [item("watchdog:n1:1"), item("watchdog:n2:1"), item("watchdog:brand-new:1")],
    { hidden, alertOff: {} },
  );
  assert.equal(badge, 1, "Clear all 后新到错误必须仍亮红点");
});

test("hideIds: empty/duplicate ids never pollute state", () => {
  const next = hideIds({ keep: 1 }, ["", "dup", "dup", "x"], 5);
  assert.deepEqual(next, { keep: 1, dup: 5, x: 5 });
});

test("setAlertOff toggles only its own key", () => {
  let alertOff = { "watchdog:a": 1 };
  alertOff = setAlertOff(alertOff, "watchdog:b", true, 42);
  assert.equal(alertOff["watchdog:b"], 42);
  assert.equal(alertOff["watchdog:a"], 1);
  alertOff = setAlertOff(alertOff, "watchdog:b", false, 99);
  assert.equal("watchdog:b" in alertOff, false);
});

test("prune: GC keeps active dismissals, drops vanished ids; alertOff is never pruned", () => {
  const dismissed = { active: 1, ghost: 2 };
  assert.deepEqual(pruneHidden(dismissed, ["active"]), { active: 1 });
  // 幽灵 id 的源问题消失 → 清除;其复发是新 id,会重新提醒
  const recycled = buildNotificationView([item("watchdog:ghost:2:999")], { hidden: { ghost: 2 }, alertOff: {} });
  assert.equal(recycled.badge, 1, "旧 hidden 不可能命中新代际 id");
});

/* -------------------------- state persistence ---------------------------- */

test("loadDismissState: v1 file migrates dismissed → hidden, malformed → empty", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-state-"));

  // v1 → hidden
  const v1 = path.join(dir, "v1.json");
  await fs.writeFile(v1, JSON.stringify({ version: 1, dismissed: { a: 1, b: 2 } }));
  assert.deepEqual(loadDismissState(v1), { hidden: { a: 1, b: 2 }, alertOff: {} });

  // v2 round-trip
  const v2 = path.join(dir, "v2.json");
  saveDismissState({ hidden: { x: 7 }, alertOff: { "watchdog:y": 9 } }, v2);
  assert.deepEqual(loadDismissState(v2), { hidden: { x: 7 }, alertOff: { "watchdog:y": 9 } });

  // malformed → empty (notification center must survive)
  const bad = path.join(dir, "bad.json");
  await fs.writeFile(bad, "{not json");
  assert.deepEqual(loadDismissState(bad), { hidden: {}, alertOff: {} });
  assert.deepEqual(loadDismissState(path.join(dir, "missing.json")), { hidden: {}, alertOff: {} });
});
