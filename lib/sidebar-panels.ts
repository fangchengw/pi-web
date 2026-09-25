/**
 * Sidebar panel registry (Settings → Panels).
 *
 * Onboarding a new panel:
 *   1. Add its id + display label here (labels are brand names, not localized);
 *   2. Mount the component in the SIDEBAR_PANEL_ELEMENTS map in AppShell.
 * The Settings → Panels toggle list follows this registry automatically.
 */

export const SIDEBAR_PANEL_IDS = ["commandcode", "mimo", "cron"] as const;
export type SidebarPanelId = (typeof SIDEBAR_PANEL_IDS)[number];
export type SidebarPanelVisibility = Record<SidebarPanelId, boolean>;

export const SIDEBAR_PANEL_LABELS: Record<SidebarPanelId, string> = {
  commandcode: "Command Code",
  mimo: "MiMo Token Plan",
  cron: "Cron jobs",
};

export const SIDEBAR_PANELS_STORAGE_KEY = "pi-web:sidebar-panels";
/** Pre-rename key kept as a read fallback so existing toggles survive. */
export const LEGACY_QUOTA_PANELS_STORAGE_KEY = "pi-web:quota-panels";
export const SIDEBAR_PANELS_CHANGED_EVENT = "pi-web:sidebar-panels-changed";

/** Every registered panel starts visible. */
export function defaultSidebarPanelVisibility(): SidebarPanelVisibility {
  const visibility = {} as SidebarPanelVisibility;
  for (const id of SIDEBAR_PANEL_IDS) visibility[id] = true;
  return visibility;
}

/**
 * Read stored toggles, tolerating missing/malformed/partial payloads:
 * unknown keys are ignored, non-boolean values keep the default (visible).
 */
export function parseSidebarPanelVisibility(raw: string | null | undefined): SidebarPanelVisibility {
  const visibility = defaultSidebarPanelVisibility();
  if (!raw) return visibility;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const id of SIDEBAR_PANEL_IDS) {
        if (typeof record[id] === "boolean") visibility[id] = record[id];
      }
    }
  } catch {
    // Malformed storage falls back to defaults (everything visible).
  }
  return visibility;
}

/** Store only the registered ids so retired panels do not linger in storage. */
export function serializeSidebarPanelVisibility(visibility: SidebarPanelVisibility): string {
  const record: Record<string, boolean> = {};
  for (const id of SIDEBAR_PANEL_IDS) record[id] = Boolean(visibility[id]);
  return JSON.stringify(record);
}
