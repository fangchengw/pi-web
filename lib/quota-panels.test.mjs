import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./quota-panels.ts");
}

const {
  QUOTA_PANEL_IDS,
  QUOTA_PANEL_LABELS,
  defaultQuotaPanelVisibility,
  parseQuotaPanelVisibility,
  serializeQuotaPanelVisibility,
} = await loadSubject();

test("registry has a label for every panel id", () => {
  for (const id of QUOTA_PANEL_IDS) {
    assert.equal(typeof QUOTA_PANEL_LABELS[id], "string");
    assert.ok(QUOTA_PANEL_LABELS[id].length > 0);
  }
});

test("defaults show every registered panel", () => {
  const visibility = defaultQuotaPanelVisibility();
  for (const id of QUOTA_PANEL_IDS) assert.equal(visibility[id], true);
});

test("parse handles missing and malformed payloads", () => {
  assert.deepEqual(parseQuotaPanelVisibility(null), defaultQuotaPanelVisibility());
  assert.deepEqual(parseQuotaPanelVisibility(undefined), defaultQuotaPanelVisibility());
  assert.deepEqual(parseQuotaPanelVisibility(""), defaultQuotaPanelVisibility());
  assert.deepEqual(parseQuotaPanelVisibility("{broken"), defaultQuotaPanelVisibility());
  assert.deepEqual(parseQuotaPanelVisibility("[1,2]"), defaultQuotaPanelVisibility());
  assert.deepEqual(parseQuotaPanelVisibility("null"), defaultQuotaPanelVisibility());
});

test("parse applies known booleans and ignores unknown or invalid keys", () => {
  const visibility = parseQuotaPanelVisibility(
    JSON.stringify({ commandcode: false, mimo: "nope", retiredPlan: false, newPlan: 1 })
  );
  assert.equal(visibility.commandcode, false);
  for (const id of QUOTA_PANEL_IDS) {
    if (id !== "commandcode") assert.equal(visibility[id], true);
  }
  assert.equal("retiredPlan" in visibility, false);
  assert.equal("newPlan" in visibility, false);
});

test("round-trips through serialize", () => {
  const visibility = defaultQuotaPanelVisibility();
  visibility.mimo = false;
  const restored = parseQuotaPanelVisibility(serializeQuotaPanelVisibility(visibility));
  assert.deepEqual(restored, visibility);
});

test("serialize drops keys outside the registry", () => {
  const stored = serializeQuotaPanelVisibility(
    // Simulates a plan that was removed from the registry after being toggled off.
    { commandcode: false, mimo: true, oldPlan: false }
  );
  assert.deepEqual(JSON.parse(stored), { commandcode: false, mimo: true });
});
