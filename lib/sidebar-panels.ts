/**
 * Sidebar panel registry (Settings → Panels).
 *
 * Onboarding a new panel:
 *   1. Add its id + display label here (labels are brand names, not localized);
 *   2. Mount the component in the SIDEBAR_PANEL_ELEMENTS map in AppShell.
 * The Settings → Panels toggle list follows this registry automatically.
 */

export const SIDEBAR_PANEL_IDS = ["commandcode", "mimo"] as const;
export type SidebarPanelId = (typeof SIDEBAR_PANEL_IDS)[number];
export type SidebarPanelVisibility = Record<SidebarPanelId, boolean>;

export const SIDEBAR_PANEL_LABELS: Record<SidebarPanelId, string> = {
  commandcode: "Command Code",
  mimo: "MiMo Token Plan",
};

export const SIDEBAR_PANELS_STORAGE_KEY = "pi-web:sidebar-panels";
/** Pre-rename key kept as a read fallback so existing toggles survive. */
export const LEGACY_QUOTA_PANELS_STORAGE_KEY = "pi-web:quota-panels";
export const SIDEBAR_PANELS_CHANGED_EVENT = "pi-web:sidebar-panels-changed";

/** 面板默认关闭（2026-09-26 侧栏拥挤反馈）；Settings → Panels 打开后状态记在 localStorage。 */
export function defaultSidebarPanelVisibility(): SidebarPanelVisibility {
  const visibility = {} as SidebarPanelVisibility;
  for (const id of SIDEBAR_PANEL_IDS) visibility[id] = false;
  return visibility;
}

/**
 * Read stored toggles, tolerating missing/malformed/partial payloads:
 * unknown keys are ignored, non-boolean values keep the default (hidden).
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
