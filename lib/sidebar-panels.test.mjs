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

test("defaults show every registered panel", () => {
  const visibility = defaultSidebarPanelVisibility();
  for (const id of SIDEBAR_PANEL_IDS) assert.equal(visibility[id], true);
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
    JSON.stringify({ commandcode: false, mimo: "nope", retiredPanel: false, newPanel: 1 })
  );
  assert.equal(visibility.commandcode, false);
  for (const id of SIDEBAR_PANEL_IDS) {
    if (id !== "commandcode") assert.equal(visibility[id], true);
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
  visibility.mimo = false;
  const restored = parseSidebarPanelVisibility(serializeSidebarPanelVisibility(visibility));
  assert.deepEqual(restored, visibility);
});

test("serialize drops keys outside the registry", () => {
  const stored = serializeSidebarPanelVisibility(
    // Simulates a panel that was removed from the registry after being toggled off.
    { commandcode: false, mimo: true, oldPanel: false }
  );
  // Only registry ids survive; missing ids coerce to false (the hook always
  // passes a complete visibility object in practice).
  assert.deepEqual(JSON.parse(stored), { commandcode: false, mimo: true });
});
