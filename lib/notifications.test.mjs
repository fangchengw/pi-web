import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const notifications = await jiti.import("./notifications.ts");
  const dismiss = await jiti.import("./notification-dismiss.ts");
  return { ...notifications, ...dismiss };
}

const {
  notificationId,
  splitSource,
  projectWatchdog,
  pruneDismissed,
  loadDismissState,
} = await loadSubject();

test("notificationId embeds first_seen so a recurrence gets a fresh id", () => {
  const a = notificationId("OV server.log/WM创建失败", 1790405892);
  const b = notificationId("OV server.log/WM创建失败", 1790500000);
  assert.notEqual(a, b);
  assert.equal(a, "watchdog:OV server.log/WM创建失败:1790405892");
});

test("splitSource splits at the last slash and tolerates a missing one", () => {
  assert.deepEqual(splitSource("OV server.log/VLM/LLM调用失败"), {
    origin: "OV server.log/VLM",
    kind: "LLM调用失败",
  });
  assert.deepEqual(splitSource("no-slash"), { origin: "", kind: "no-slash" });
  assert.deepEqual(splitSource("/leading"), { origin: "", kind: "/leading" });
});

test("projectWatchdog maps state to items sorted by last activity", () => {
  const items = projectWatchdog({
    recent_issues: {
      older: { source: "健康检查/ov", error: "不可达", first_seen: 100, last_seen: 100, count: 1 },
      newer: {
        source: "OV server.log/WM创建失败",
        error: "3条 | 例: 2026-09-26 00:42:02 - openviking.session - ERROR - Memory extraction failed",
        first_seen: 200,
        last_seen: 300,
        count: 3,
      },
    },
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].source, "OV server.log/WM创建失败");
  assert.equal(items[0].createdAt, 200_000);
  assert.equal(items[0].updatedAt, 300_000);
  assert.equal(items[0].count, 3);
  assert.equal(items[0].origin, "OV server.log");
  assert.equal(items[0].kind, "WM创建失败");
  assert.equal(items[0].title, "OV server.log · WM创建失败");
  assert.equal(items[0].level, "error");
  assert.equal(items[1].level, "error"); // health checks are always errors
  assert.equal(items[1].id, "watchdog:健康检查/ov:100");
});

test("projectWatchdog tolerates missing fields and empty state", () => {
  assert.deepEqual(projectWatchdog({}), []);
  assert.deepEqual(projectWatchdog({ recent_issues: {} }), []);
});

test("warning inference from detail text", () => {
  const [item] = projectWatchdog({
    recent_issues: {
      w: { source: "OV server.log/WM创建失败", error: "1条 | 例: 2026-09-26 - WARNING - WM creation failed", first_seen: 1, last_seen: 1, count: 1 },
    },
  });
  assert.equal(item.level, "warning");
});

test("pruneDismissed drops ids whose issue no longer exists", () => {
  const dismissed = { keep: 1, "stale:old:1": 2 };
  assert.deepEqual(pruneDismissed(dismissed, ["keep", "other"]), { keep: 1 });
  assert.deepEqual(pruneDismissed(dismissed, []), {});
});

test("loadDismissState returns {} for missing or malformed files", async () => {
  assert.deepEqual(loadDismissState("/nonexistent/path/state.json"), {});
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dismiss-"));
  const bad = path.join(dir, "bad.json");
  await fs.writeFile(bad, "{not json");
  assert.deepEqual(loadDismissState(bad), {});
  const good = path.join(dir, "good.json");
  await fs.writeFile(good, JSON.stringify({ version: 1, dismissed: { a: 1 } }));
  assert.deepEqual(loadDismissState(good), { a: 1 });
});
