"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LEGACY_QUOTA_PANELS_STORAGE_KEY,
  SIDEBAR_PANELS_CHANGED_EVENT,
  SIDEBAR_PANELS_STORAGE_KEY,
  defaultSidebarPanelVisibility,
  parseSidebarPanelVisibility,
  serializeSidebarPanelVisibility,
  type SidebarPanelId,
  type SidebarPanelVisibility,
} from "@/lib/sidebar-panels";

function readVisibility(): SidebarPanelVisibility {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_PANELS_STORAGE_KEY);
    // Fall back to the pre-rename key so toggles set before the rename survive.
    const raw = stored ?? window.localStorage.getItem(LEGACY_QUOTA_PANELS_STORAGE_KEY);
    return parseSidebarPanelVisibility(raw);
  } catch {
    return defaultSidebarPanelVisibility();
  }
}

/**
 * Sidebar panel visibility (Settings → Panels).
 * localStorage is the single source of truth; a custom event keeps the
 * settings panel and the sidebar in sync without shared React state, and the
 * native `storage` event propagates changes across tabs.
 */
export function useSidebarPanels(): {
  visibility: SidebarPanelVisibility;
  setPanelEnabled: (id: SidebarPanelId, enabled: boolean) => void;
} {
  const [visibility, setVisibility] = useState<SidebarPanelVisibility>(defaultSidebarPanelVisibility);

  useEffect(() => {
    const sync = () => setVisibility(readVisibility());
    sync();
    window.addEventListener(SIDEBAR_PANELS_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SIDEBAR_PANELS_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setPanelEnabled = useCallback((id: SidebarPanelId, enabled: boolean) => {
    try {
      const next: SidebarPanelVisibility = { ...readVisibility(), [id]: enabled };
      window.localStorage.setItem(SIDEBAR_PANELS_STORAGE_KEY, serializeSidebarPanelVisibility(next));
    } catch {
      return; // Storage unavailable — do not emit a change that did not persist.
    }
    window.dispatchEvent(new CustomEvent(SIDEBAR_PANELS_CHANGED_EVENT));
  }, []);

  return { visibility, setPanelEnabled };
}
