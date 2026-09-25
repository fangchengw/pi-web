"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { ConfigSwitch } from "./SettingsUi";
import { formatDuration } from "@/lib/commandcode-windows";
import type { CronJobView, CronJobsResult } from "@/lib/cron-jobs";

const STORAGE_KEY = "pi-web:cron-jobs";
const OPEN_STORAGE_KEY = "pi-web:cron-jobs-open";
const CACHE_MAX_AGE_MS = 5 * 60_000;
const PANE_MIN_HEIGHT = 28;
const PANE_DEFAULT_HEIGHT = 170;
const PANE_MAX_HEIGHT = 360;
const PANE_STORAGE_KEY = "pi-web:sidebar-cron-pane-height";
const PANE_CSS_VARIABLE = "--sidebar-cron-pane-height";

type CachedResult = { fetchedAt: number; result: CronJobsResult };

type ActionBody = { action: "enable" | "disable" | "run" | "start-daemon"; id?: string };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function fmtDateTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CronJobs() {
  const [result, setResult] = useState<CronJobsResult | null>(null);
  const [querying, setQuerying] = useState(false);
  const [actionDone, setActionDone] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();

  const paneHeightRef = useRef(PANE_DEFAULT_HEIGHT);
  const paneResizer = useResizablePanel({
    ariaLabel: t("layout.resizeSidebarSections"),
    axis: "vertical",
    cssVariable: PANE_CSS_VARIABLE,
    defaultWidth: PANE_DEFAULT_HEIGHT,
    getMaxWidth: () =>
      Math.max(PANE_MIN_HEIGHT, Math.min(PANE_MAX_HEIGHT, Math.round(window.innerHeight * 0.35))),
    growthDirection: "up",
    maxWidth: PANE_MAX_HEIGHT,
    minWidth: PANE_MIN_HEIGHT,
    storageKey: PANE_STORAGE_KEY,
    widthRef: paneHeightRef,
  });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(OPEN_STORAGE_KEY);
      if (stored !== null) setOpen(stored === "1");
    } catch {
      // Keep the default expanded state.
    }
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Best-effort persistence.
      }
      return next;
    });
  }, []);

  const persist = useCallback((data: CronJobsResult) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: Date.now(), result: data } satisfies CachedResult));
    } catch {
      // Storage errors are non-fatal.
    }
  }, []);

  const query = useCallback(async () => {
    setQuerying(true);
    try {
      const response = await fetch("/api/cron/jobs", { cache: "no-store" });
      const data = (await response.json()) as CronJobsResult;
      if (!response.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
      setResult(data);
      persist(data);
    } catch (caught) {
      setResult({ status: "query-failed", message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setQuerying(false);
    }
  }, [persist]);

  const runAction = useCallback(
    async (body: ActionBody) => {
      const key = body.action === "start-daemon" ? "__daemon" : (body.id ?? "__unknown");
      setBusyAction(key);
      try {
        const response = await fetch("/api/cron/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json()) as CronJobsResult & { error?: string };
        if (!response.ok) throw new Error(data.error ?? (data as { message?: string }).message ?? `HTTP ${response.status}`);
        setResult(data);
        persist(data);
        setActionDone(true);
        if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
        actionTimerRef.current = setTimeout(() => setActionDone(false), 2000);
      } catch (caught) {
        setResult({ status: "query-failed", message: caught instanceof Error ? caught.message : String(caught) });
      } finally {
        setBusyAction(null);
      }
    },
    [persist]
  );

  useEffect(() => {
    let needsQuery = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as CachedResult;
        if (cached?.result?.status) {
          setResult(cached.result);
          if (Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) needsQuery = false;
        }
      }
    } catch {
      // Ignore malformed caches.
    }
    if (needsQuery) void query();
    return () => {
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    };
  }, [query]);

  const ready = result?.status === "ready" ? result : null;
  const jobs = ready?.jobs ?? [];
  const enabledCount = jobs.filter((job) => job.enabled).length;
  const daemon = ready?.daemon;
  const daemonUp = daemon?.daemonRunning ?? false;

  const nextRunLabel = (job: CronJobView): string | null => {
    if (!job.nextRunAt) return null;
    const msLeft = new Date(job.nextRunAt).getTime() - Date.now();
    if (msLeft <= 0) return t("cron.dueNow");
    return formatDuration(msLeft);
  };

  const jobStatusLine = (job: CronJobView): string => {
    if (job.running) return t("cron.running");
    if (job.disabledReason === "completed_once") return t("cron.completedOnce");
    if (!job.enabled) return t("cron.paused");
    return nextRunLabel(job) ? `${t("cron.nextRun")} ${nextRunLabel(job)}` : "";
  };

  return (
    <>
      {open && (
        <div
          className={`sidebar-section-resize-handle${paneResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="cron-jobs"
          data-testid="cron-jobs-resizer"
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
          {...paneResizer.separatorProps}
        />
      )}
      <div
        data-testid="cron-jobs"
        ref={paneResizer.panelRef}
        style={{
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          height: open ? `var(${PANE_CSS_VARIABLE}, ${PANE_DEFAULT_HEIGHT}px)` : "auto",
          minHeight: open ? PANE_MIN_HEIGHT : undefined,
        }}
      >
        {/* explorer 同款折叠头 */}
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
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Cron jobs</span>
            <span
              data-testid="cron-jobs-dot"
              title={daemonUp ? t("cron.daemonRunning") : t("cron.daemonStopped")}
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                flexShrink: 0,
                background: daemonUp ? "#22c55e" : "#f59e0b",
                boxShadow: daemonUp ? "0 0 4px #22c55e" : undefined,
              }}
            />
          </button>

          {!open && ready && (
            <span
              style={{ marginRight: 2, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}
              title={`${enabledCount}/${jobs.length}`}
            >
              {enabledCount}/{jobs.length}
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
              color: actionDone ? "#4ade80" : "var(--text-dim)",
              cursor: querying ? "default" : "pointer",
              transition: "color 0.3s",
            }}
          >
            {actionDone ? (
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
            data-testid="cron-jobs-body"
            style={{
              padding: "2px 10px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minWidth: 0,
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
            }}
          >
            {!ready ? (
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                {result?.status === "query-failed"
                  ? t("providerUsage.queryFailed")
                  : querying
                    ? t("providerUsage.refreshing")
                    : t("providerUsage.notQueried")}
              </span>
            ) : (
              <>
                {ready.actionError && (
                  <span data-testid="cron-action-error" style={{ fontSize: 10, color: "#f87171", lineHeight: 1.4 }}>
                    {ready.actionError}
                  </span>
                )}

                {/* daemon 状态条 */}
                <div data-testid="cron-jobs-status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, minWidth: 0 }}>
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      flexShrink: 0,
                      background: daemonUp ? "#22c55e" : "#f59e0b",
                    }}
                    aria-hidden="true"
                  />
                  <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                    {daemonUp
                      ? `${t("cron.daemonRunning")}${daemon?.pid ? ` · #${daemon.pid}` : ""}`
                      : t("cron.daemonStopped")}
                  </span>
                  {!daemon?.launchdInstalled && (
                    <span style={{ color: "var(--text-dim)", opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t("cron.launchdMissing")}>
                      · {t("cron.launchdMissing")}
                    </span>
                  )}
                  {!daemonUp && (
                    <button
                      type="button"
                      data-testid="cron-start-daemon"
                      disabled={busyAction === "__daemon"}
                      onClick={() => void runAction({ action: "start-daemon" })}
                      className="config-button config-button-small config-button-secondary"
                      style={{ marginLeft: "auto", flexShrink: 0 }}
                    >
                      {t("cron.startDaemon")}
                    </button>
                  )}
                </div>

                {!daemon?.extensionAvailable && (
                  <span style={{ fontSize: 10, color: "#f87171", lineHeight: 1.4 }} title={t("cron.extensionMissing")}>
                    {t("cron.extensionMissing")}
                  </span>
                )}

                {jobs.length === 0 ? (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("cron.empty")}</span>
                ) : (
                  jobs.map((job) => {
                    const expanded = expandedId === job.id;
                    const lastRun = fmtDateTime(job.lastRunAt);
                    const runAt = fmtDateTime(job.runAt);
                    return (
                      <div
                        key={job.id}
                        data-testid={`cron-job-${job.id}`}
                        style={{
                          borderTop: "1px solid var(--border-subtle, var(--border))",
                          paddingTop: 6,
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                          minWidth: 0,
                        }}
                      >
                        {/* 行1：开关 + 名称 + 徽章 */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <ConfigSwitch
                            checked={job.enabled}
                            label={job.name}
                            disabled={busyAction === job.id}
                            onChange={(enabled) => void runAction({ action: enabled ? "enable" : "disable", id: job.id })}
                          />
                          <span
                            style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}
                            title={job.name}
                          >
                            {job.name}
                          </span>
                          {job.scope && (
                            <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)", flexShrink: 0 }}>
                              {job.scope}
                            </span>
                          )}
                          {job.once && (
                            <span style={{ fontSize: 8, fontWeight: 700, color: "var(--text-dim)", flexShrink: 0 }} title="once">
                              1×
                            </span>
                          )}
                        </div>

                        {/* 行2：规则 + 下次运行 */}
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-dim)", minWidth: 0 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {job.kind === "cron" ? job.schedule : runAt ?? job.runAt}
                            {job.kind === "cron" && job.timezone ? ` · ${job.timezone}` : ""}
                          </span>
                          <span style={{ flexShrink: 0, whiteSpace: "nowrap" }} data-testid={`cron-next-${job.id}`}>
                            {jobStatusLine(job)}
                          </span>
                        </div>

                        {/* 行3：上次运行 + 立即运行 + 展开 */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-dim)", minWidth: 0 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                            {t("cron.lastRun")} {lastRun ?? "—"}
                            {job.lastRunAt && job.lastExitCode !== undefined && (
                              <span style={{ color: job.lastExitCode === 0 ? "#4ade80" : "#f87171", marginLeft: 4 }}>
                                {job.lastExitCode === 0 ? "✓" : `!${job.lastExitCode}`}
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            data-testid={`cron-run-${job.id}`}
                            title={t("cron.runNow")}
                            aria-label={`${t("cron.runNow")}: ${job.name}`}
                            disabled={busyAction === job.id}
                            onClick={() => void runAction({ action: "run", id: job.id })}
                            style={{
                              background: "none",
                              border: "none",
                              padding: "0 2px",
                              color: busyAction === job.id ? "var(--text-muted)" : "var(--text-dim)",
                              cursor: busyAction === job.id ? "default" : "pointer",
                              fontSize: 10,
                              lineHeight: 1,
                              flexShrink: 0,
                            }}
                          >
                            ▶
                          </button>
                          <button
                            type="button"
                            data-testid={`cron-expand-${job.id}`}
                            aria-expanded={expanded}
                            aria-label={`${t("cron.prompt")}: ${job.name}`}
                            onClick={() => setExpandedId(expanded ? null : job.id)}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              color: "var(--text-dim)",
                              cursor: "pointer",
                              display: "flex",
                              flexShrink: 0,
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
                              style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                              aria-hidden="true"
                            >
                              <polyline points="3 2 7 5 3 8" />
                            </svg>
                          </button>
                        </div>

                        {/* 展开：prompt 全文 */}
                        {expanded && (
                          <pre
                            data-testid={`cron-prompt-${job.id}`}
                            style={{
                              margin: 0,
                              maxHeight: 170,
                              overflowY: "auto",
                              padding: "6px 8px",
                              borderRadius: 6,
                              background: "var(--bg-subtle)",
                              fontSize: 10,
                              lineHeight: 1.5,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              color: "var(--text-muted)",
                            }}
                          >
                            {job.prompt ?? "—"}
                          </pre>
                        )}
                      </div>
                    );
                  })
                )}

                {(ready.history?.length ?? 0) > 0 && (
                  <span style={{ fontSize: 9, color: "var(--text-dim)", opacity: 0.8, borderTop: "1px solid var(--border-subtle, var(--border))", paddingTop: 5 }}>
                    {t("cron.historyCount", { count: ready.history.length })}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
