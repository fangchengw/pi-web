import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./sidebar-panels.ts");
}

const {
  SIDEBAR_PANEL_IDS,
  SIDEBAR_PANEL_LABELS,
  defaultSidebarPanelVisibility,
  parseSidebarPanelVisibility,
  serializeSidebarPanelVisibility,
} = await loadSubject();

test("registry has a label for every panel id", () => {
  for (const id of SIDEBAR_PANEL_IDS) {
    assert.equal(typeof SIDEBAR_PANEL_LABELS[id], "string");
    assert.ok(SIDEBAR_PANEL_LABELS[id].length > 0);
  }
});

test("defaults hide every registered panel (panels opt-in, toggles remembered)", () => {
  const visibility = defaultSidebarPanelVisibility();
  for (const id of SIDEBAR_PANEL_IDS) assert.equal(visibility[id], false);
});

test("parse handles missing and malformed payloads", () => {
  assert.deepEqual(parseSidebarPanelVisibility(null), defaultSidebarPanelVisibility());
  assert.deepEqual(parseSidebarPanelVisibility(undefined), defaultSidebarPanelVisibility());
  assert.deepEqual(parseSidebarPanelVisibility(""), defaultSidebarPanelVisibility());
  assert.deepEqual(parseSidebarPanelVisibility("{broken"), defaultSidebarPanelVisibility());
  assert.deepEqual(parseSidebarPanelVisibility("[1,2]"), defaultSidebarPanelVisibility());
  assert.deepEqual(parseSidebarPanelVisibility("null"), defaultSidebarPanelVisibility());
});

test("parse applies known booleans and ignores unknown or invalid keys", () => {
  const visibility = parseSidebarPanelVisibility(
    JSON.stringify({ commandcode: true, mimo: "nope", retiredPanel: false, newPanel: 1 })
  );
  // 记忆中的 true 保留（开关带记忆）。
  assert.equal(visibility.commandcode, true);
  // 非法值回落到默认（隐藏）；未记录的面板也是默认隐藏。
  for (const id of SIDEBAR_PANEL_IDS) {
    if (id !== "commandcode") assert.equal(visibility[id], false);
  }
  assert.equal("retiredPanel" in visibility, false);
  assert.equal("newPanel" in visibility, false);
});

test("legacy quota-panels payloads keep working", () => {
  // Shape written before the rename (no cron key yet).
  const visibility = parseSidebarPanelVisibility(JSON.stringify({ commandcode: false, mimo: true, cron: true }));
  assert.equal(visibility.commandcode, false);
  assert.equal(visibility.mimo, true);
  // cron moved out of the sidebar registry (top-bar dropdown) — unknown keys are dropped.
  assert.equal("cron" in visibility, false);
});

test("round-trips through serialize", () => {
  const visibility = defaultSidebarPanelVisibility();
  // 默认关；用户打开的面板（true）必须能记住并还原。
  visibility.mimo = true;
  const restored = parseSidebarPanelVisibility(serializeSidebarPanelVisibility(visibility));
  assert.deepEqual(restored, visibility);
});

test("serialize drops keys outside the registry", () => {
  const stored = serializeSidebarPanelVisibility(
    // watchdog/tokenAudit were removed from the registry after being toggled,
    // plus other stale ids.
    { commandcode: false, mimo: true, watchdog: true, tokenAudit: true, oldPanel: false }
  );
  // Only registry ids survive; missing ids coerce to false (the hook always
  // passes a complete visibility object in practice).
  assert.deepEqual(JSON.parse(stored), { commandcode: false, mimo: true });
});
