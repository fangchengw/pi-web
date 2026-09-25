"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { ConfigSwitch } from "./SettingsUi";
import { formatDuration } from "@/lib/commandcode-windows";
import type { CronJobView, CronJobsResult } from "@/lib/cron-jobs";

/**
 * Top-bar dropdown panel (System/Tools pattern): opened from the "Cron"
 * button in the session top bar via AppShell's activeTopPanel mechanism.
 * Full-width anchored panel — one grid row per job instead of the cramped
 * sidebar layout.
 */

const STORAGE_KEY = "pi-web:cron-jobs";
const CACHE_MAX_AGE_MS = 5 * 60_000;

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

const GRID_COLUMNS = "28px minmax(140px, 1.2fr) minmax(170px, 1.4fr) minmax(120px, auto) minmax(120px, auto) auto";

export function CronJobsPanel() {
  const [result, setResult] = useState<CronJobsResult | null>(null);
  const [querying, setQuerying] = useState(false);
  const [actionDone, setActionDone] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();

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

  // 面板打开期间自动刷新：60s 定时 + 切回 30s 冷却（本地读，便宜）。
  useAutoRefresh({ intervalMs: 60_000, onRefresh: query, visibilityCooldownMs: 30_000 });

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
    const label = nextRunLabel(job);
    if (!job.enabled) {
      const future = job.nextRunAt != null && new Date(job.nextRunAt).getTime() > Date.now();
      return future && label ? `${t("cron.paused")} · ${t("cron.nextRun")} ${label}` : t("cron.paused");
    }
    return label ? `${t("cron.nextRun")} ${label}` : "";
  };

  const scopeHint = (job: CronJobView): string =>
    job.scope === "project"
      ? t("cron.scopeProject")
      : job.scope === "session"
        ? t("cron.scopeSession")
        : t("cron.scopeUser");

  const lastRun = (job: CronJobView): string | null => {
    const when = fmtDateTime(job.lastRunAt);
    if (!when) return null;
    return when;
  };

  return (
    <section
      data-testid="cron-jobs"
      aria-label={t("cron.button")}
      style={{
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
        paddingBottom: 8,
      }}
    >
      {/* 头部：标题 + daemon 状态 + 操作 */}
      <div
        data-testid="cron-jobs-status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px 8px",
          borderBottom: "1px solid var(--border)",
          minWidth: 0,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          Cron jobs
        </span>
        {ready && jobs.length > 0 && (
          <span
            style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}
            title={`${enabledCount} / ${jobs.length}`}
          >
            {enabledCount}/{jobs.length}
          </span>
        )}
        <span
          data-testid="cron-jobs-dot"
          title={daemonUp ? t("cron.daemonRunning") : t("cron.daemonStopped")}
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            flexShrink: 0,
            background: daemonUp ? "#22c55e" : "#f59e0b",
            boxShadow: daemonUp ? "0 0 5px #22c55e" : undefined,
          }}
          aria-hidden="true"
        />
        <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
          {daemonUp
            ? `${t("cron.daemonRunning")}${daemon?.pid ? ` · #${daemon.pid}` : ""}`
            : t("cron.daemonStopped")}
        </span>
        {!daemon?.launchdInstalled && (
          <span
            style={{ fontSize: 10, color: "var(--text-dim)", opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={t("cron.launchdMissing")}
          >
            · {t("cron.launchdMissing")}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {ready && (ready.history?.length ?? 0) > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {t("cron.historyCount", { count: ready.history.length })}
            </span>
          )}
          {!daemonUp && (
            <button
              type="button"
              data-testid="cron-start-daemon"
              disabled={busyAction === "__daemon"}
              onClick={() => void runAction({ action: "start-daemon" })}
              className="config-button config-button-small config-button-secondary"
            >
              {t("cron.startDaemon")}
            </button>
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
              width: 26,
              height: 26,
              padding: 0,
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: actionDone ? "#4ade80" : "var(--text-dim)",
              cursor: querying ? "default" : "pointer",
              transition: "color 0.3s",
            }}
          >
            {actionDone ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={querying ? { animation: "spin 0.8s linear infinite" } : undefined} aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            )}
          </button>
        </span>
      </div>

      {/* 内容 */}
      <div style={{ padding: "6px 16px 0", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        {!ready ? (
          <span style={{ fontSize: 11, color: "var(--text-dim)", padding: "8px 0" }}>
            {result?.status === "query-failed"
              ? t("providerUsage.queryFailed")
              : querying
                ? t("providerUsage.refreshing")
                : t("providerUsage.notQueried")}
          </span>
        ) : (
          <>
            {ready.actionError && (
              <span data-testid="cron-action-error" style={{ fontSize: 11, color: "#f87171", lineHeight: 1.5 }}>
                {ready.actionError}
              </span>
            )}
            {!daemon?.extensionAvailable && (
              <span style={{ fontSize: 11, color: "#f87171", lineHeight: 1.5 }} title={t("cron.extensionMissing")}>
                {t("cron.extensionMissing")}
              </span>
            )}

            {jobs.length === 0 ? (
              <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, padding: "8px 0" }}>
                {t("cron.empty")}
              </span>
            ) : (
              jobs.map((job) => {
                const expanded = expandedId === job.id;
                const statusLine = jobStatusLine(job);
                const last = lastRun(job);
                const scheduleText = job.kind === "cron" ? job.schedule : fmtDateTime(job.runAt) ?? job.runAt;
                return (
                  <div key={job.id} data-testid={`cron-job-${job.id}`} style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: GRID_COLUMNS,
                        alignItems: "center",
                        gap: 12,
                        padding: "9px 0",
                        borderTop: "1px solid var(--border-subtle, var(--border))",
                        minWidth: 0,
                      }}
                    >
                      {/* 开关 */}
                      <ConfigSwitch
                        checked={job.enabled}
                        label={job.name}
                        disabled={busyAction === job.id}
                        onChange={(enabled) => void runAction({ action: enabled ? "enable" : "disable", id: job.id })}
                      />
                      {/* 名称 + 徽章 */}
                      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span
                          style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={job.cwd ? `${job.name} — ${job.cwd}` : job.name}
                        >
                          {job.name}
                        </span>
                        {job.scope && (
                          <span
                            title={scopeHint(job)}
                            style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)", flexShrink: 0, cursor: "help" }}
                          >
                            {job.scope}
                          </span>
                        )}
                        {job.once && (
                          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", flexShrink: 0 }} title="once">
                            1×
                          </span>
                        )}
                      </span>
                      {/* 规则 */}
                      <span
                        style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                        title={`${scheduleText}${job.timezone ? ` · ${job.timezone}` : ""}`}
                      >
                        {scheduleText}
                        {job.kind === "cron" && job.timezone ? ` · ${job.timezone}` : ""}
                      </span>
                      {/* 下次运行 / 状态 */}
                      <span
                        data-testid={`cron-next-${job.id}`}
                        style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {statusLine}
                      </span>
                      {/* 上次运行 */}
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {last ? (
                          <>
                            {last}
                            {job.lastRunAt && job.lastExitCode !== undefined && (
                              <span style={{ color: job.lastExitCode === 0 ? "#4ade80" : "#f87171", marginLeft: 5 }}>
                                {job.lastExitCode === 0 ? "✓" : `!${job.lastExitCode}`}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                      {/* 操作 */}
                      <span style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end", flexShrink: 0 }}>
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
                            padding: 0,
                            color: busyAction === job.id ? "var(--text-muted)" : "var(--text-dim)",
                            cursor: busyAction === job.id ? "default" : "pointer",
                            fontSize: 12,
                            lineHeight: 1,
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
                          }}
                        >
                          <svg
                            width="10"
                            height="10"
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
                      </span>
                    </div>

                    {/* 展开：prompt 全文 */}
                    {expanded && (
                      <pre
                        data-testid={`cron-prompt-${job.id}`}
                        style={{
                          margin: "0 0 4px",
                          maxHeight: 260,
                          overflowY: "auto",
                          padding: "10px 12px",
                          borderRadius: 8,
                          background: "var(--bg-subtle)",
                          border: "1px solid var(--border-subtle, var(--border))",
                          fontSize: 11,
                          lineHeight: 1.6,
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
          </>
        )}
      </div>
    </section>
  );
}
