/**
 * Sidebar quota panel registry.
 *
 * Onboarding a new plan panel:
 *   1. Add its id + display label here (labels are brand names, not localized);
 *   2. Mount the component in the QUOTA_PANEL_ELEMENTS map in AppShell.
 * The Settings → Quota panels toggle list follows this registry automatically.
 */

export const QUOTA_PANEL_IDS = ["commandcode", "mimo"] as const;
export type QuotaPanelId = (typeof QUOTA_PANEL_IDS)[number];
export type QuotaPanelVisibility = Record<QuotaPanelId, boolean>;

export const QUOTA_PANEL_LABELS: Record<QuotaPanelId, string> = {
  commandcode: "Command Code",
  mimo: "MiMo Token Plan",
};

export const QUOTA_PANELS_STORAGE_KEY = "pi-web:quota-panels";
export const QUOTA_PANELS_CHANGED_EVENT = "pi-web:quota-panels-changed";

/** Every registered panel starts visible. */
export function defaultQuotaPanelVisibility(): QuotaPanelVisibility {
  const visibility = {} as QuotaPanelVisibility;
  for (const id of QUOTA_PANEL_IDS) visibility[id] = true;
  return visibility;
}

/**
 * Read stored toggles, tolerating missing/malformed/partial payloads:
 * unknown keys are ignored, non-boolean values keep the default (visible).
 */
export function parseQuotaPanelVisibility(raw: string | null | undefined): QuotaPanelVisibility {
  const visibility = defaultQuotaPanelVisibility();
  if (!raw) return visibility;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const id of QUOTA_PANEL_IDS) {
        if (typeof record[id] === "boolean") visibility[id] = record[id];
      }
    }
  } catch {
    // Malformed storage falls back to defaults (everything visible).
  }
  return visibility;
}

/** Store only the registered ids so retired plans do not linger in storage. */
export function serializeQuotaPanelVisibility(visibility: QuotaPanelVisibility): string {
  const record: Record<string, boolean> = {};
  for (const id of QUOTA_PANEL_IDS) record[id] = Boolean(visibility[id]);
  return JSON.stringify(record);
}
