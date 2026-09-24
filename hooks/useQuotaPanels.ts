"use client";

import { useCallback, useEffect, useState } from "react";
import {
  QUOTA_PANELS_CHANGED_EVENT,
  QUOTA_PANELS_STORAGE_KEY,
  defaultQuotaPanelVisibility,
  parseQuotaPanelVisibility,
  serializeQuotaPanelVisibility,
  type QuotaPanelId,
  type QuotaPanelVisibility,
} from "@/lib/quota-panels";

function readVisibility(): QuotaPanelVisibility {
  try {
    return parseQuotaPanelVisibility(window.localStorage.getItem(QUOTA_PANELS_STORAGE_KEY));
  } catch {
    return defaultQuotaPanelVisibility();
  }
}

/**
 * Sidebar quota panel visibility (Settings → Quota panels).
 * localStorage is the single source of truth; a custom event keeps the
 * settings panel and the sidebar in sync without shared React state, and the
 * native `storage` event propagates changes across tabs.
 */
export function useQuotaPanels(): {
  visibility: QuotaPanelVisibility;
  setPanelEnabled: (id: QuotaPanelId, enabled: boolean) => void;
} {
  const [visibility, setVisibility] = useState<QuotaPanelVisibility>(defaultQuotaPanelVisibility);

  useEffect(() => {
    const sync = () => setVisibility(readVisibility());
    sync();
    window.addEventListener(QUOTA_PANELS_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(QUOTA_PANELS_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setPanelEnabled = useCallback((id: QuotaPanelId, enabled: boolean) => {
    try {
      const next: QuotaPanelVisibility = { ...readVisibility(), [id]: enabled };
      window.localStorage.setItem(QUOTA_PANELS_STORAGE_KEY, serializeQuotaPanelVisibility(next));
    } catch {
      return; // Storage unavailable — do not emit a change that did not persist.
    }
    window.dispatchEvent(new CustomEvent(QUOTA_PANELS_CHANGED_EVENT));
  }, []);

  return { visibility, setPanelEnabled };
}
