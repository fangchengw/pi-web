"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import {
  formatDuration,
  pickHottestWindow,
  type CommandCodeWindow,
  type CommandCodeWindowId,
} from "@/lib/commandcode-windows";
import { formatFullTimestamp, formatUpdatedTime } from "@/lib/i18n/format";
import type { CommandCodeUsageResult } from "@/lib/commandcode-usage";

const STORAGE_KEY = "pi-web:commandcode-quota";
const QUOTA_PANE_MIN_HEIGHT = 28;
const QUOTA_PANE_DEFAULT_HEIGHT = 210;
const QUOTA_PANE_MAX_HEIGHT = 400;
const QUOTA_PANE_STORAGE_KEY = "pi-web:sidebar-quota-pane-height";
const QUOTA_PANE_CSS_VARIABLE = "--sidebar-quota-pane-height";
const OPEN_STORAGE_KEY = "pi-web:commandcode-quota-open";
const CACHE_MAX_AGE_MS = 5 * 60_000;

type CachedQuota = { fetchedAt: number; result: CommandCodeUsageResult };

const WINDOW_LABEL_KEYS: Record<CommandCodeWindowId, string> = {
  fiveHour: "commandcode.windowFiveHour",
  weekly: "commandcode.windowWeekly",
  monthly: "commandcode.windowMonthly",
};

function usageColor(percent: number): string {
  return percent >= 85 ? "#ef4444" : percent >= 60 ? "#f59e0b" : "#22c55e";
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function CommandCodeQuota() {
  const [result, setResult] = useState<CommandCodeUsageResult | null>(null);
  // 最近一次成功取数的时刻，用来标示面板数据是不是 up to date。
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [querying, setQuerying] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const [open, setOpen] = useState(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { locale, t } = useI18n();

  const quotaPaneHeightRef = useRef(QUOTA_PANE_DEFAULT_HEIGHT);
  const quotaPaneResizer = useResizablePanel({
    ariaLabel: t("layout.resizeSidebarSections"),
    axis: "vertical",
    cssVariable: QUOTA_PANE_CSS_VARIABLE,
    defaultWidth: QUOTA_PANE_DEFAULT_HEIGHT,
    getMaxWidth: () =>
      Math.max(
        QUOTA_PANE_MIN_HEIGHT,
        Math.min(QUOTA_PANE_MAX_HEIGHT, Math.round(window.innerHeight * 0.45)),
      ),
    growthDirection: "up",
    maxWidth: QUOTA_PANE_MAX_HEIGHT,
    minWidth: QUOTA_PANE_MIN_HEIGHT,
    storageKey: QUOTA_PANE_STORAGE_KEY,
    widthRef: quotaPaneHeightRef,
  });

  // 折叠偏好在 hydration 之后恢复（与 explorer 的做法一致）。
  useEffect(() => {
    try {
      const stored = localStorage.getItem(OPEN_STORAGE_KEY);
      if (stored !== null) setOpen(stored === "1");
    } catch {
      // 存储不可用时保持默认展开。
    }
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Persistence is best-effort.
      }
      return next;
    });
  }, []);

  const query = useCallback(async () => {
    setQuerying(true);
    try {
      const response = await fetch("/api/commandcode/usage", { cache: "no-store" });
      const data = (await response.json()) as CommandCodeUsageResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      const at = Date.now();
      setResult(data);
      setFetchedAt(at);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: at, result: data } satisfies CachedQuota));
      } catch {
        // Storage quota errors are non-fatal; the widget still works in memory.
      }
      setRefreshDone(data.status === "ready");
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
    } catch (caught) {
      setResult({ status: "query-failed", message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setQuerying(false);
    }
  }, []);

  // 自动刷新：只在页面可见时跑，后台标签页零请求（额度面板求稳，cron 更勤）。
  useAutoRefresh({
    intervalMs: 600000,
    onRefresh: query,
    visibilityCooldownMs: 300000,
  });

  useEffect(() => {
    let needsQuery = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as CachedQuota;
        if (cached?.result?.status) {
          setResult(cached.result);
          if (typeof cached.fetchedAt === "number") setFetchedAt(cached.fetchedAt);
          // 只有成功的缓存才免于重查；失败结果必须在挂载时立即重试，
          // 否则一次瞬时失败会把面板卡在错误态直到缓存过期。
          if (cached.result.status === "ready" && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) {
            needsQuery = false;
          }
        }
      }
    } catch {
      // Ignore malformed caches and fall through to a fresh query.
    }
    if (needsQuery) void query();
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [query]);

  const quota = result?.status === "ready" ? result.quota : null;
  const percent = quota ? Math.min(100, Math.max(0, Math.round(quota.percent))) : 0;
  const barColor = usageColor(percent);
  const now = Date.now();

  const windowStatus = (window: CommandCodeWindow): string => {
    if (window.used <= 0) return t("commandcode.noUsage");
    if (window.resetAt !== null && window.resetAt > now) {
      return t("commandcode.resetsIn", { duration: formatDuration(window.resetAt - now) });
    }
    return "";
  };

  // 折叠态展示最吃紧的窗口（如已打满的 Weekly），没有窗口时回退到总体进度。
  const hottestWindow = pickHottestWindow(quota?.windows ?? []);
  const collapsedPct = hottestWindow
    ? hottestWindow.cap > 0
      ? Math.min(100, Math.max(0, Math.round((hottestWindow.used / hottestWindow.cap) * 100)))
      : 0
    : percent;
  const collapsedColor = usageColor(collapsedPct);
  const hottestLabel = hottestWindow ? t(WINDOW_LABEL_KEYS[hottestWindow.id]) : "";
  const hottestStatus = hottestWindow ? windowStatus(hottestWindow) : "";

  return (
    <>
      {open && (
        <div
          className={`sidebar-section-resize-handle${quotaPaneResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="commandcode-quota"
          data-testid="commandcode-quota-resizer"
          title={`${t("layout.resizeSidebarSections")}: ${t("layout.resizeHeightHint")}`}
          style={{
            position: "relative",
            zIndex: 20,
            width: "100%",
            height: 12,
            margin: "-6px 0",
            flex: "0 0 12px",
            cursor: "row-resize",
            touchAction: "none",
          }}
          {...quotaPaneResizer.separatorProps}
        />
      )}
      <div
        data-testid="commandcode-quota"
        ref={quotaPaneResizer.panelRef}
        style={{
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          height: open ? `var(${QUOTA_PANE_CSS_VARIABLE}, ${QUOTA_PANE_DEFAULT_HEIGHT}px)` : "auto",
          minHeight: open ? QUOTA_PANE_MIN_HEIGHT : undefined,
        }}
      >
      {/* 折叠头（与 EXPLORER 同款样式） */}
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, minWidth: 0 }}>
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          title={t("commandcode.toggle")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: "6px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            textAlign: "left",
          }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
            aria-hidden="true"
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Command Code{quota?.planName ? ` · ${quota.planName}` : ""}
          </span>
        </button>

        {!open && quota && (
          <span
            style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginRight: 2, minWidth: 0 }}
            title={
              `${hottestWindow
                ? `${hottestLabel}: ${collapsedPct}%${hottestStatus ? ` · ${hottestStatus}` : ""}`
                : `${percent}%`}${fetchedAt !== null ? ` · ${t("providerUsage.updated", { time: formatUpdatedTime(fetchedAt, locale) })}` : ""}`
            }
          >
            {hottestWindow && (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: "var(--text-dim)",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  maxWidth: 56,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {hottestLabel}
              </span>
            )}
            <span
              data-testid="commandcode-quota-minibar"
              style={{
                width: 44,
                height: 5,
                borderRadius: 999,
                background: "var(--bg-subtle)",
                overflow: "hidden",
                display: "inline-block",
                flexShrink: 0,
              }}
            >
              <span
                data-testid="commandcode-quota-minifill"
                style={{
                  display: "block",
                  width: `${collapsedPct}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: collapsedColor,
                  transition: "width 0.35s ease, background 0.35s ease",
                }}
              />
            </span>
            <span
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: collapsedColor,
                minWidth: 24,
                textAlign: "right",
                flexShrink: 0,
              }}
            >
              {collapsedPct}%
            </span>
          </span>
        )}

        <button
          type="button"
          onClick={() => void query()}
          disabled={querying}
          title={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          aria-label={t(querying ? "providerUsage.refreshing" : "providerUsage.refresh")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            background: "none",
            border: "none",
            borderRadius: 5,
            flexShrink: 0,
            marginRight: 6,
            color: refreshDone ? "#4ade80" : "var(--text-dim)",
            cursor: querying ? "default" : "pointer",
            transition: "color 0.3s",
          }}
        >
          {refreshDone ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={querying ? { animation: "spin 0.8s linear infinite" } : undefined} aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          )}
        </button>
      </div>

      {open && (
        <div
          id="commandcode-quota-body"
          data-testid="commandcode-quota-body"
          style={{
            padding: "2px 10px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 5,
            minWidth: 0,
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          {quota ? (
            <>
              {/* 总体额度进度 */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <div
                  role="progressbar"
                  aria-label={t("commandcode.quotaLabel")}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  data-testid="commandcode-quota-progress"
                  style={{ flex: 1, minWidth: 0, height: 6, borderRadius: 999, background: "var(--bg-subtle)", overflow: "hidden" }}
                >
                  <div
                    data-testid="commandcode-quota-bar"
                    style={{
                      width: `${percent}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: barColor,
                      transition: "width 0.35s ease, background 0.35s ease",
                    }}
                  />
                </div>
                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text-muted)", flexShrink: 0 }}>
                  {percent}%
                </span>
              </div>

              {/* 余额 · 额外额度 */}
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, minWidth: 0 }}>
                <span
                  style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={`${t("commandcode.balance")}: $${quota.balance.toFixed(2)}`}
                >
                  {t("commandcode.balance")} ${quota.balance.toFixed(2)}
                </span>
                <span
                  style={{ color: "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}
                  title={`${t("commandcode.extra")}: $${quota.extra.toFixed(2)}`}
                >
                  {t("commandcode.extra")} ${quota.extra.toFixed(2)}
                </span>
              </div>

              {/* 本期花费 · 重置 */}
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", minWidth: 0 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t("commandcode.spent")} ${quota.spent.toFixed(2)}
                </span>
                {quota.daysLeft !== null && (
                  <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                    {t("commandcode.renewsIn", { days: quota.daysLeft })}
                  </span>
                )}
              </div>

              {/* 5 小时 / 每周 / 每月 窗口限制 */}
              {quota.windows.length > 0 && (
                <div
                  data-testid="commandcode-windows"
                  style={{
                    borderTop: "1px solid var(--border)",
                    paddingTop: 6,
                    marginTop: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    minWidth: 0,
                  }}
                >
                  {quota.windows.map((window) => {
                    const windowPct = window.cap > 0 ? Math.min(100, Math.max(0, Math.round((window.used / window.cap) * 100))) : 0;
                    const windowColor = usageColor(windowPct);
                    const status = windowStatus(window);
                    const label = t(WINDOW_LABEL_KEYS[window.id]);
                    return (
                      <div
                        key={window.id}
                        data-testid={`commandcode-window-${window.id}`}
                        style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}
                      >
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, minWidth: 0 }}>
                          <span
                            style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            title={`${formatAmount(window.used)} / ${formatAmount(window.cap)}`}
                          >
                            {label}
                          </span>
                          <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 600, color: windowColor, flexShrink: 0 }}>
                            {windowPct}%
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <div
                            role="progressbar"
                            aria-label={label}
                            aria-valuenow={windowPct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            style={{ flex: 1, minWidth: 0, height: 4, borderRadius: 999, background: "var(--bg-subtle)", overflow: "hidden" }}
                          >
                            <div
                              style={{
                                width: `${windowPct}%`,
                                height: "100%",
                                borderRadius: 999,
                                background: windowColor,
                                transition: "width 0.35s ease, background 0.35s ease",
                              }}
                            />
                          </div>
                          <span
                            title={status}
                            style={{
                              fontSize: 9,
                              color: "var(--text-dim)",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              maxWidth: "55%",
                              textAlign: "right",
                              flexShrink: 1,
                            }}
                          >
                            {status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : result?.status === "auth-unavailable" ? (
            <span style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.45, wordBreak: "break-word" }}>
              {t("commandcode.notLoggedIn")}
            </span>
          ) : result?.status === "query-failed" ? (
            <span style={{ fontSize: 10, color: "#f87171", lineHeight: 1.45, wordBreak: "break-word" }} title={result.message}>
              {t("providerUsage.queryFailed")}
            </span>
          ) : (
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                {querying ? t("providerUsage.refreshing") : t("providerUsage.notQueried")}
              </span>
            )}
          </div>
        )}

        {/* 上次成功取数时间：固定在滚动区之外，用来判断面板数据是不是 up to date。 */}
        {open && fetchedAt !== null && (
          <div style={{ padding: "0 10px 6px", flexShrink: 0, display: "flex", justifyContent: "flex-end", minWidth: 0 }}>
            <span
              data-testid="commandcode-quota-updated"
              title={formatFullTimestamp(fetchedAt, locale)}
              style={{
                fontSize: 9,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {t("providerUsage.updated", { time: formatUpdatedTime(fetchedAt, locale) })}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
