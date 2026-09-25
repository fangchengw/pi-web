"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { formatDuration } from "@/lib/commandcode-windows";
import type { CronJobView, CronJobsResult, CronRunLog } from "@/lib/cron-jobs";

/**
 * Cron tasks modal (master-detail, modeled after the reference design):
 * left = searchable task list + daemon strip, right = selected task detail
 * (status badge, resume/pause + run-now, frequency/last/next/deliver-to/workdir,
 * prompt, and clickable run history). History rows jump to the original
 * session for session-scope jobs; user/project runs are `pi -p --no-session`
 * so they have no session — their history opens the run log in place.
 */

interface Props {
  onClose: () => void;
  /** Returns false when the session cannot be found (caller falls back to the log). */
  onOpenSessionId: (sessionId: string) => boolean;
}

const STORAGE_KEY = "pi-web:cron-jobs";
const CACHE_MAX_AGE_MS = 5 * 60_000;

type CachedResult = { fetchedAt: number; result: CronJobsResult };
type ActionBody = { action: "enable" | "disable" | "run" | "start-daemon"; id?: string };
type RunLogState = { key: string; loading: boolean; content: string | null; error: string | null };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function fmtDateTime(iso: string | number | undefined | null): string | null {
  if (iso === undefined || iso === null || iso === "") return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionIdFromSessionFile(sessionFile: string): string | null {
  const base = sessionFile.slice(sessionFile.lastIndexOf("/") + 1);
  const match = /^(?:\d{4}-\d{2}-\d{2}T[\d-]+Z)_([0-9a-f-]{36})\.jsonl$/i.exec(base);
  return match ? match[1] : null;
}

const labelStyle: CSSProperties = { fontSize: 12, color: "var(--text-dim)", width: 104, flexShrink: 0 };
const valueStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function CronJobsModal({ onClose, onOpenSessionId }: Props) {
  const [result, setResult] = useState<CronJobsResult | null>(null);
  const [querying, setQuerying] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [runCooldown, setRunCooldown] = useState(false);
  const [runToast, setRunToast] = useState<"run" | "resumed" | null>(null);
  const runTimers = useRef<number[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<RunLogState | null>(null);
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
      // `cron run` 官方语义会把暂停的任务顺带恢复排程（enabled:true）——toast 提醒。
      const beforeJob =
        body.action === "run" && result?.status === "ready" ? result.jobs.find((job) => job.id === body.id) : undefined;
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
        if (body.action === "run") {
          // 手动触发：成功 toast（3s 自动消失）+ 按钮同冷却，稍后补拉一次取回运行日志。
          setRunToast(beforeJob && !beforeJob.enabled ? "resumed" : "run");
          setRunCooldown(true);
          runTimers.current.push(
            window.setTimeout(() => {
              setRunToast(null);
              setRunCooldown(false);
            }, 3000),
            window.setTimeout(() => void query(), 5000),
          );
        }
      } catch (caught) {
        setResult({ status: "query-failed", message: caught instanceof Error ? caught.message : String(caught) });
      } finally {
        setBusyAction(null);
      }
    },
    [persist, query, result]
  );

  useEffect(() => () => runTimers.current.forEach((id) => window.clearTimeout(id)), []);

  useEffect(() => {
    let needsQuery = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as CachedResult;
        const cachedResult = cached?.result;
        if (cachedResult?.status) {
          // Caches written by older panel versions predate the `runs` field —
          // normalize so history rendering never crashes, and refresh anyway.
          let legacyRuns = false;
          let normalized: CronJobsResult = cachedResult;
          if (cachedResult.status === "ready") {
            const cachedJobs = Array.isArray(cachedResult.jobs) ? cachedResult.jobs : [];
            legacyRuns = cachedJobs.some((job) => !Array.isArray(job.runs));
            normalized = {
              ...cachedResult,
              jobs: cachedJobs.map((job) => ({ ...job, runs: Array.isArray(job.runs) ? job.runs : [] })),
            };
          }
          setResult(normalized);
          if (Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS && !legacyRuns) needsQuery = false;
        }
      }
    } catch {
      // Ignore malformed caches.
    }
    if (needsQuery) void query();
  }, [query]);

  useAutoRefresh({ intervalMs: 60_000, onRefresh: query, visibilityCooldownMs: 30_000 });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const ready = result?.status === "ready" ? result : null;
  // Normalize defensively: any job without `runs` (legacy cache/response)
  // renders as zero history instead of throwing.
  const jobs = useMemo(() => (ready?.jobs ?? []).map((job) => ({ ...job, runs: job.runs ?? [] })), [ready]);
  const daemon = ready?.daemon;
  const daemonUp = daemon?.daemonRunning ?? false;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return jobs;
    return jobs.filter((job) => job.name.toLowerCase().includes(needle) || job.id.toLowerCase().includes(needle));
  }, [jobs, search]);

  // 默认选中第一个（搜索后选中项不在列表里时也回落到第一个）。
  useEffect(() => {
    if (jobs.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !jobs.some((job) => job.id === selectedId)) {
      setSelectedId(filtered.length > 0 ? filtered[0].id : jobs[0].id);
    }
  }, [jobs, filtered, selectedId]);

  const selected = jobs.find((job) => job.id === selectedId) ?? null;

  const nextRunLabel = (job: CronJobView): string | null => {
    if (!job.nextRunAt) return null;
    const msLeft = new Date(job.nextRunAt).getTime() - Date.now();
    if (msLeft <= 0) return t("cron.dueNow");
    return formatDuration(msLeft);
  };

  const statusLine = (job: CronJobView): string => {
    if (job.running) return t("cron.running");
    if (job.disabledReason === "completed_once") return t("cron.completedOnce");
    const label = nextRunLabel(job);
    if (!job.enabled) {
      const future = job.nextRunAt != null && new Date(job.nextRunAt).getTime() > Date.now();
      return future && label ? `${t("cron.paused")} · ${label}` : t("cron.paused");
    }
    return label ?? "";
  };

  const scopeHint = (job: CronJobView): string =>
    job.scope === "project"
      ? t("cron.scopeProject")
      : job.scope === "session"
        ? t("cron.scopeSession")
        : t("cron.scopeUser");

  const toggleRunLog = async (job: CronJobView, run: CronRunLog) => {
    const key = `${job.id}/${run.name}`;
    if (runLog?.key === key) {
      setRunLog(null);
      return;
    }
    setRunLog({ key, loading: true, content: null, error: null });
    try {
      const response = await fetch(`/api/cron/jobs?runLog=${encodeURIComponent(key)}`, { cache: "no-store" });
      const data = (await response.json()) as { runLog?: { content: string }; error?: string };
      if (!response.ok || typeof data.runLog?.content !== "string") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setRunLog({ key, loading: false, content: data.runLog.content, error: null });
    } catch (caught) {
      setRunLog({ key, loading: false, content: null, error: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  const handleHistoryClick = (job: CronJobView, run: CronRunLog) => {
    if (job.scope === "session" && job.sessionFile) {
      const sessionId = sessionIdFromSessionFile(job.sessionFile);
      if (sessionId && onOpenSessionId(sessionId)) return; // jumped to the session
    }
    void toggleRunLog(job, run); // no session (user/project runs) → open the log in place
  };

  return (
    <div
      data-testid="cron-jobs"
      aria-label={t("cron.title")}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 700,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("cron.title")}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "relative",
          width: "min(1440px, 94vw)",
          height: "min(880px, 92vh)",
          background: "var(--bg-panel)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          border: "1px solid var(--border)",
          display: "flex",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          data-testid="cron-jobs-close"
          onClick={onClose}
          aria-label={t("cron.close")}
          title={t("cron.close")}
          style={{
            position: "absolute",
            top: 10,
            right: 12,
            zIndex: 5,
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "none",
            border: "none",
            borderRadius: 8,
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ✕
        </button>

        {/* ============ 左栏：任务列表 ============ */}
        <div
          style={{
            width: 300,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            padding: "18px 14px 12px",
            minWidth: 0,
          }}
        >
          <div style={{ padding: "0 4px" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t("cron.title")}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              {t("cron.count", { count: jobs.length })}
            </div>
          </div>

          {/* 搜索 */}
          <div style={{ position: "relative", margin: "12px 0 8px" }}>
            <span
              aria-hidden="true"
              style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", fontSize: 12, pointerEvents: "none" }}
            >
              ⌕
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("cron.searchPlaceholder")}
              aria-label={t("cron.searchPlaceholder")}
              style={{
                width: "100%",
                padding: "7px 10px 7px 27px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-subtle)",
                color: "var(--text)",
                fontSize: 12,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* 列表 */}
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
            {jobs.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6, padding: "8px 6px" }}>
                {t("cron.empty")}
              </span>
            ) : filtered.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 6px" }}>{t("cron.noMatch")}</span>
            ) : (
              filtered.map((job) => {
                const isSelected = job.id === selectedId;
                const dotColor =
                  job.disabledReason === "completed_once"
                    ? "#64748b"
                    : job.enabled
                      ? "#22c55e"
                      : "#f59e0b";
                return (
                  <button
                    key={job.id}
                    type="button"
                    data-testid={`cron-task-${job.id}`}
                    aria-current={isSelected}
                    onClick={() => {
                      setSelectedId(job.id);
                      setRunLog(null);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "none",
                      background: isSelected ? "var(--bg-selected)" : "transparent",
                      color: isSelected ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 12.5,
                      textAlign: "left",
                      minWidth: 0,
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: dotColor, flexShrink: 0 }} aria-hidden="true" />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {job.name}
                    </span>
                    {job.once && <span style={{ fontSize: 9, color: "var(--text-dim)", flexShrink: 0 }}>1×</span>}
                  </button>
                );
              })
            )}
          </div>

          {/* daemon 状态条 */}
          <div
            data-testid="cron-jobs-status"
            style={{
              borderTop: "1px solid var(--border)",
              marginTop: 10,
              paddingTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 7,
              flexWrap: "wrap",
              padding: "10px 4px 0",
            }}
          >
            <span
              data-testid="cron-jobs-dot"
              title={daemonUp ? t("cron.daemonRunning") : t("cron.daemonStopped")}
              style={{ width: 7, height: 7, borderRadius: 999, background: daemonUp ? "#22c55e" : "#f59e0b", flexShrink: 0, boxShadow: daemonUp ? "0 0 4px #22c55e" : undefined }}
              aria-hidden="true"
            />
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
              {daemonUp ? `${t("cron.daemonRunning")}${daemon?.pid ? ` · #${daemon.pid}` : ""}` : t("cron.daemonStopped")}
            </span>
            {!daemonUp && (
              <button
                type="button"
                data-testid="cron-start-daemon"
                disabled={busyAction === "__daemon"}
                onClick={() => void runAction({ action: "start-daemon" })}
                className="config-button config-button-small config-button-secondary"
                style={{ marginLeft: "auto" }}
              >
                {t("cron.startDaemon")}
              </button>
            )}
            {!daemon?.launchdInstalled && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", opacity: 0.7, width: "100%" }} title={t("cron.launchdMissing")}>
                {t("cron.launchdMissing")}
              </span>
            )}
          </div>
        </div>

        {/* ============ 右栏：任务详情 ============ */}
        <div style={{ flex: "1 1 auto", minWidth: 0, overflowY: "auto", padding: "22px 30px 26px" }}>
          {result?.status === "query-failed" && (
            <span style={{ fontSize: 12, color: "#f87171" }} title={(result as { message?: string }).message}>
              {t("providerUsage.queryFailed")}
            </span>
          )}

          {!ready && result?.status !== "query-failed" && (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {querying ? t("providerUsage.refreshing") : t("providerUsage.notQueried")}
            </span>
          )}

          {ready && !selected && (
            <span style={{ fontSize: 13, color: "var(--text-dim)" }}>{t("cron.selectHint")}</span>
          )}

          {ready && selected && (() => {
            const job = selected;
            const lastRun = fmtDateTime(job.lastRunAt);
            const nextAbs = fmtDateTime(job.nextRunAt);
            const runBusy = busyAction === job.id || runCooldown;
            return (
              <div data-testid={`cron-job-${job.id}`} style={{ minWidth: 0 }}>
                {ready.actionError && (
                  <div data-testid="cron-action-error" style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>
                    {ready.actionError}
                  </div>
                )}

                {/* 标题 + 状态 + 操作 */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flexWrap: "wrap", paddingRight: 34 }}>
                  <span style={{ fontSize: 19, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {job.name}
                  </span>
                  {job.enabled && !job.running && job.disabledReason !== "completed_once" && (
                    <span data-testid="cron-badge-scheduled" style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, background: "rgba(34,197,94,0.15)", color: "#22c55e", flexShrink: 0 }}>
                      {t("cron.badgeScheduled")}
                    </span>
                  )}
                  {!job.enabled && job.disabledReason !== "completed_once" && (
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, background: "rgba(245,158,11,0.15)", color: "#f59e0b", flexShrink: 0 }}>
                      {t("cron.paused")}
                    </span>
                  )}
                  {job.running && (
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, background: "rgba(34,197,94,0.15)", color: "#22c55e", flexShrink: 0 }}>
                      {t("cron.running")}
                    </span>
                  )}
                  {job.disabledReason === "completed_once" && (
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 999, background: "rgba(100,116,139,0.18)", color: "#94a3b8", flexShrink: 0 }}>
                      {t("cron.completedOnce")}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      data-testid={`cron-toggle-${job.id}`}
                      disabled={busyAction === job.id}
                      onClick={() => void runAction({ action: job.enabled ? "disable" : "enable", id: job.id })}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "7px 14px", borderRadius: 8,
                        border: "1px solid var(--border)", background: "transparent",
                        color: "var(--text)", fontSize: 12, cursor: busyAction === job.id ? "default" : "pointer",
                        opacity: busyAction === job.id ? 0.6 : 1,
                      }}
                    >
                      <span aria-hidden="true">{job.enabled ? "⏸" : "▷"}</span>
                      {job.enabled ? t("cron.pause") : t("cron.resume")}
                    </button>
                    <button
                      type="button"
                      data-testid={`cron-run-${job.id}`}
                      disabled={runBusy}
                      onClick={() => void runAction({ action: "run", id: job.id })}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "7px 14px", borderRadius: 8,
                        border: "none", background: "var(--accent)", color: "#fff",
                        fontSize: 12, fontWeight: 600, cursor: runBusy ? "default" : "pointer",
                        opacity: runBusy ? 0.6 : 1,
                      }}
                    >
                      <span aria-hidden="true">▶</span>
                      {t("cron.runNow")}
                    </button>
                  </span>
                </div>

                {runToast && (
                  <div
                    data-testid="cron-run-toast"
                    style={{
                      position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", zIndex: 5,
                      display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 999,
                      background: "rgba(17,17,17,0.94)", color: "#fff", border: "1px solid rgba(255,255,255,0.14)",
                      fontSize: 12.5, fontWeight: 600, boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                      pointerEvents: "none", whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ color: "#4ade80" }} aria-hidden="true">✓</span>
                    {runToast === "resumed" ? t("cron.runTriggeredResumed") : t("cron.runTriggered")}
                  </div>
                )}

                {/* 元数据 */}
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 9, columnGap: 14, margin: "18px 0 4px" }}>
                  <span style={labelStyle}>{t("cron.frequency")}</span>
                  <span style={valueStyle} title={job.kind === "cron" ? job.timezone : undefined}>
                    {job.kind === "cron" ? `${job.schedule}${job.timezone ? ` · ${job.timezone}` : ""}` : (fmtDateTime(job.runAt) ?? job.runAt ?? "—")}
                  </span>

                  <span style={labelStyle}>{t("cron.lastRun")}</span>
                  <span style={valueStyle}>
                    {lastRun ?? "—"}
                    {lastRun && job.lastExitCode !== undefined && (
                      <span style={{ color: job.lastExitCode === 0 ? "#4ade80" : "#f87171", marginLeft: 8 }}>
                        {job.lastExitCode === 0 ? "✓" : `!${job.lastExitCode}`}
                      </span>
                    )}
                  </span>

                  <span style={labelStyle}>{t("cron.nextRunLabel")}</span>
                  <span style={valueStyle} data-testid={`cron-next-${job.id}`}>
                    {statusLine(job)}
                    {statusLine(job) && nextAbs ? ` · ${nextAbs}` : nextAbs ?? ""}
                  </span>

                  <span style={labelStyle}>{t("cron.deliverTo")}</span>
                  <span style={valueStyle} title={scopeHint(job)}>
                    {job.scope ?? "user"} · {job.cwd ?? "—"}
                  </span>
                </div>

                {/* 提示词 */}
                <div style={{ fontSize: 12, color: "var(--text-dim)", margin: "14px 0 6px" }}>{t("cron.prompt")}</div>
                <pre
                  data-testid={`cron-prompt-${job.id}`}
                  style={{
                    margin: 0,
                    maxHeight: "40vh",
                    overflowY: "auto",
                    padding: "12px 14px",
                    borderRadius: 10,
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border-subtle, var(--border))",
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "var(--text-muted)",
                  }}
                >
                  {job.prompt ?? "—"}
                </pre>

                {/* 运行记录 */}
                <div style={{ fontSize: 12, color: "var(--text-dim)", margin: "18px 0 6px" }}>
                  {t("cron.runHistory", { count: job.runs.length })}
                </div>
                {job.runs.length === 0 ? (
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("cron.noRuns")}</span>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {job.runs.map((run, index) => {
                      const key = `${job.id}/${run.name}`;
                      const open = runLog?.key === key;
                      return (
                        <div key={run.name}>
                          <button
                            type="button"
                            data-testid={`cron-run-log-${index}`}
                            title={t("cron.viewLog")}
                            onClick={() => void handleHistoryClick(job, run)}
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 12,
                              padding: "8px 10px",
                              borderRadius: 8,
                              border: "none",
                              background: open ? "var(--bg-selected)" : "transparent",
                              color: "var(--text-muted)",
                              cursor: "pointer",
                              fontSize: 12,
                              textAlign: "left",
                            }}
                          >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {job.name} · {fmtDateTime(run.at)}
                            </span>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
                              {fmtDateTime(run.at)}
                            </span>
                          </button>
                          {open && (
                            <div style={{ marginTop: 4 }}>
                              {runLog?.loading ? (
                                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("providerUsage.refreshing")}</span>
                              ) : runLog?.error ? (
                                <span style={{ fontSize: 11, color: "#f87171" }} title={runLog.error}>
                                  {t("providerUsage.queryFailed")}
                                </span>
                              ) : (
                                <pre
                                  data-testid="cron-run-log-viewer"
                                  style={{
                                    margin: 0,
                                    maxHeight: 300,
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
                                  {runLog?.content ?? ""}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
