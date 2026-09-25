"use client";

import { useEffect, useRef } from "react";

interface AutoRefreshOptions {
  onRefresh: () => void;
  /** 定时刷新间隔；只在页面可见时触发。 */
  intervalMs: number;
  /** 任意两次自动刷新之间的最小间隔（也约束定时器）。 */
  visibilityCooldownMs: number;
}

/**
 * Background refresh for sidebar panels:
 *   1. a timer that fires only while the document is visible, and
 *   2. a visibilitychange listener that refreshes when returning to the tab.
 * Both paths share one cooldown, and nothing at all runs while the tab is
 * hidden — so remote quota APIs only get hit at the caller's chosen cadence.
 */
export function useAutoRefresh({
  onRefresh,
  intervalMs,
  visibilityCooldownMs,
}: AutoRefreshOptions): void {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const lastCallRef = useRef(0);

  useEffect(() => {
    // The panel just ran its mount query — treat that as the first call so a
    // tab-return immediately after load does not double-fetch.
    lastCallRef.current = Date.now();
    const call = () => {
      lastCallRef.current = Date.now();
      refreshRef.current();
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCallRef.current >= visibilityCooldownMs) call();
    }, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCallRef.current >= visibilityCooldownMs) call();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, visibilityCooldownMs]);
}
