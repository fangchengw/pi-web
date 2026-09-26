"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUpdatedTime } from "@/lib/i18n/format";
import { formatTokens } from "@/lib/mimo-format";
import {
  capDetailRows,
  filterRowsByRange,
  maxValue,
  sortedEntries,
  totalsForRows,
  type TokenAuditResult,
} from "@/lib/token-audit";

/**
 * Token Audit modal (top-bar "Audit" button, same overlay chrome as the Cron
 * modal). Range selection is *staged*: date/time inputs and preset chips only
 * edit the pending range — nothing recomputes until the user clicks refresh,
 * which also reruns audit.py (still zero model tokens). No polling, ever.
 */

interface Props {
  onClose: () => void;
}

const RANGE_STORAGE_KEY = "pi-web:token-audit-range";

type Range = { start: string; end: string };

const EMPTY_RANGE: Range = { start: "", end: "" };

/** null = 用户从未设过区间（首次使用）→ 调用方给默认值。 */
function loadRange(): Range | null {
  try {
    const raw = localStorage.getItem(RANGE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Range>;
      if (typeof parsed?.start === "string" && typeof parsed?.end === "string") {
        return { start: parsed.start, end: parsed.end };
      }
    }
  } catch {
    // Malformed storage → treat as never set.
  }
  return null;
}

/** 首次使用的默认区间 = 滚动最近 7 天（不落存储；点“全部”才会存空区间）。 */
function defaultRange(): Range {
  return { start: toLocalInput(new Date(Date.now() - 7 * 24 * 3_600_000)), end: "" };
}

function persistRange(range: Range): void {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(range));
  } catch {
    // Persistence is best-effort.
  }
}

/** datetime-local 值（YYYY-MM-DDTHH:MM，本地时区）。 */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const SOURCE_COLORS: Record<string, string> = {
  pi: "#22c55e",
  openviking: "#f59e0b",
  hermes: "#38bdf8",
  watchdog: "#a78bfa",
};

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? "#94a3b8";
}

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text-muted)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  flexShrink: 0,
};

const cellRight: CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const tableHeaderCell: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text-dim)",
  textAlign: "left",
  padding: "4px 8px",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  background: "var(--bg-panel)",
  zIndex: 1,
};

const PRESETS: { id: string; label: string; ms: number | null }[] = [
  { id: "1h", label: "1h", ms: 3_600_000 },
  { id: "6h", label: "6h", ms: 6 * 3_600_000 },
  { id: "24h", label: "24h", ms: 24 * 3_600_000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 3_600_000 },
  { id: "all", label: "", ms: null }, // 全部：清空两端
];

export function TokenAuditModal({ onClose }: Props) {
  const { locale, t } = useI18n();
  const [result, setResult] = useState<TokenAuditResult | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  // staged = 输入框里的暂存条件；applied = 实际用于筛选的条件（只在点 Refresh 时更新）。
  const [staged, setStaged] = useState<Range>({ ...EMPTY_RANGE });
  const [applied, setApplied] = useState<Range>({ ...EMPTY_RANGE });
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const init = loadRange() ?? defaultRange();
    setStaged(init);
    setApplied(init);
  }, []);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(refresh ? "/api/token-audit?refresh=1" : "/api/token-audit", {
        cache: "no-store",
      });
      const data = (await response.json()) as TokenAuditResult;
      setResult(data);
      if (data.status === "ready") {
        setFetchedAt(Date.now());
        if (refresh && !data.refreshError) {
          setRefreshDone(true);
          if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
          doneTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
        }
      }
    } catch (caught) {
      setResult({
        status: "unavailable",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // 打开默认空白（2026-09-26 用户要求）：不自动读现成报告，首次数据必须手动点 Refresh。
  useEffect(() => {
    return () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const setStagedKey = useCallback((key: keyof Range, value: string) => {
    setStaged((prev) => {
      const next = { ...prev, [key]: value };
      persistRange(next);
      return next;
    });
  }, []);

  /** 快捷选项只改暂存值：设起点（终点清空 = 到最新），“全部”两端清空。 */
  const applyPreset = useCallback((ms: number | null) => {
    setStaged(() => {
      const next: Range = ms === null
        ? { ...EMPTY_RANGE }
        : { start: toLocalInput(new Date(Date.now() - ms)), end: "" };
      persistRange(next);
      return next;
    });
  }, []);

  const dirty = staged.start !== applied.start || staged.end !== applied.end;

  /** 点 Refresh = 应用暂存区间 + 重跑 audit.py（唯一的数据更新入口）。 */
  const refresh = useCallback(() => {
    setApplied(staged);
    void load(true);
  }, [staged, load]);

  const report = result?.status === "ready" ? result.report : null;
  const rows = report ? filterRowsByRange(report.rows, applied.start, applied.end) : [];
  const { rows: detailRows, truncated } = capDetailRows(rows);
  const totals = totalsForRows(rows);
  const bySource = sortedEntries(totals.bySource);
  const byModel = sortedEntries(totals.byModel);
  const sourceMax = maxValue(totals.bySource);
  const rangeActive = Boolean(applied.start || applied.end);

  const dateInput: CSSProperties = {
    fontSize: 12,
    padding: "4px 6px",
    width: 195, // datetime-local 完整显示「日期, 时:分」需要 ~190px，避免时间被截断
    color: "var(--text)",
    background: "var(--bg-subtle)",
    border: `1px solid ${dirty ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 6,
    fontVariantNumeric: "tabular-nums",
  };

  const chipStyle = (active: boolean): CSSProperties => ({
    padding: "3px 8px",
    fontSize: 11,
    borderRadius: 999,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--bg-selected)" : "var(--bg-subtle)",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
  });

  return (
    <div
      data-testid="token-audit-modal"
      aria-label={t("tokenAudit.button")}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 700,
        background: "rgba(0,0,0,0.45)",
        padding: "max(6px, env(safe-area-inset-top)) max(6px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(6px, env(safe-area-inset-left))",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("tokenAudit.button")}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "relative",
          width: "min(880px, 96%)",
          maxHeight: "min(780px, 92dvh)",
          boxSizing: "border-box",
          background: "var(--bg-panel)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* 标题 + 关闭 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 44px 10px 16px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 650, color: "var(--text)" }}>Token Audit</span>
          {report && (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("tokenAudit.rows", { count: String(rows.length) })}
            </span>
          )}
          {fetchedAt !== null && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>
              {t("providerUsage.updated", { time: formatUpdatedTime(fetchedAt, locale) })}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="token-audit-close"
          onClick={onClose}
          aria-label={t("cron.close")}
          title={t("cron.close")}
          style={{
            position: "absolute",
            top: 8,
            right: 10,
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
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {/* 工具行：暂存的区间选择（点 Refresh 才生效）+ 快捷选项 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            flexWrap: "wrap",
            rowGap: 8,
          }}
        >
          <input
            data-testid="token-audit-from"
            type="datetime-local"
            aria-label={t("tokenAudit.from")}
            value={staged.start}
            max={staged.end || undefined}
            onChange={(event) => setStagedKey("start", event.target.value)}
            style={dateInput}
          />
          <span style={{ color: "var(--text-dim)" }}>–</span>
          <input
            data-testid="token-audit-to"
            type="datetime-local"
            aria-label={t("tokenAudit.to")}
            value={staged.end}
            min={staged.start || undefined}
            onChange={(event) => setStagedKey("end", event.target.value)}
            style={dateInput}
          />
          {(staged.start || staged.end) && (
            <button
              type="button"
              data-testid="token-audit-clear"
              onClick={() => {
                setStaged({ ...EMPTY_RANGE });
                persistRange({ ...EMPTY_RANGE });
              }}
              title={t("tokenAudit.clearRange")}
              aria-label={t("tokenAudit.clearRange")}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 13,
                padding: "0 4px",
              }}
            >
              ×
            </button>
          )}

          {/* 快捷选项：只改暂存条件 */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }} data-testid="token-audit-presets">
            {PRESETS.map((preset) =>
              preset.ms === null ? (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(null)}
                  style={chipStyle(staged.start === "" && staged.end === "")}
                >
                  {t("tokenAudit.all")}
                </button>
              ) : (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`token-audit-preset-${preset.id}`}
                  title={t("tokenAudit.recent", { n: preset.label })}
                  onClick={() => applyPreset(preset.ms)}
                  style={chipStyle(false)}
                >
                  {preset.label}
                </button>
              ),
            )}
          </div>

          <button
            type="button"
            data-testid="token-audit-refresh"
            onClick={refresh}
            disabled={refreshing || loading}
            title={dirty ? t("tokenAudit.unapplied") : t(refreshing || loading ? "providerUsage.refreshing" : "providerUsage.refresh")}
            aria-label={dirty ? t("tokenAudit.unapplied") : t(refreshing || loading ? "providerUsage.refreshing" : "providerUsage.refresh")}
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              background: "var(--bg-subtle)",
              border: `1px solid ${dirty ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 7,
              color: refreshDone ? "#22c55e" : dirty ? "var(--accent)" : "var(--text)",
              fontSize: 12,
              cursor: refreshing || loading ? "default" : "pointer",
              opacity: refreshing || loading ? 0.6 : 1,
            }}
          >
            {refreshDone ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={refreshing ? { animation: "spin 0.8s linear infinite" } : undefined} aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            )}
            {refreshing ? t("providerUsage.refreshing") : t("providerUsage.refresh")}
            {dirty && (
              <span data-testid="token-audit-dirty" style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)", display: "inline-block" }} />
            )}
          </button>

          {/* 留空语义提示 */}
          <span style={{ flexBasis: "100%", fontSize: 10, color: "var(--text-dim)" }} data-testid="token-audit-hint">
            {t("tokenAudit.rangeHint")}{dirty ? ` · ${t("tokenAudit.unapplied")}` : ""}
          </span>
        </div>

        {/* 内容 */}
        <div
          style={{
            padding: "12px 16px 16px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {result === null && (
            <div
              data-testid="token-audit-empty"
              style={{ padding: "36px 0", textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}
            >
              {t("tokenAudit.emptyState")}
            </div>
          )}

          {result?.status === "unavailable" && (
            <div data-testid="token-audit-unavailable" style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {result.message}
            </div>
          )}

          {result?.status === "ready" && result.refreshError && (
            <div style={{ fontSize: 11, color: "#ef4444" }}>
              {t("tokenAudit.refreshFailed", { message: result.refreshError })}
            </div>
          )}

          {report && (
            <>
              {/* 合计 */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("tokenAudit.total")}</span>
                <span
                  data-testid="token-audit-total"
                  style={{
                    fontSize: 22,
                    fontWeight: 650,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatTokens(totals.all)}
                </span>
                {rangeActive && (
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    / {formatTokens(report.totals.all)}
                  </span>
                )}
                <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>
                  {t("tokenAudit.generated", { time: report.generatedAt.replace("T", " ").slice(0, 19) })}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
                {/* 按源 */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>{t("tokenAudit.bySource")}</span>
                  {bySource.length === 0 && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("tokenAudit.empty")}</span>
                  )}
                  {bySource.map(([source, value]) => (
                    <div
                      key={source}
                      data-testid={`token-audit-source-${source}`}
                      style={{ display: "grid", gridTemplateColumns: "86px 1fr 64px", alignItems: "center", gap: 8 }}
                    >
                      <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {source}
                      </span>
                      <span style={{ height: 6, borderRadius: 999, background: "var(--bg-subtle)", overflow: "hidden", display: "block" }}>
                        <span
                          style={{
                            display: "block",
                            width: sourceMax > 0 && value > 0 ? `${Math.max(3, Math.round((value / sourceMax) * 100))}%` : "0%",
                            height: "100%",
                            borderRadius: 999,
                            background: sourceColor(source),
                            transition: "width 0.3s ease",
                          }}
                        />
                      </span>
                      <span style={{ ...cellRight, fontSize: 11 }}>{formatTokens(value)}</span>
                    </div>
                  ))}
                </div>

                {/* 按模型（跨源合计） */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>{t("tokenAudit.byModel")}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
                    {byModel.map(([model, value]) => (
                      <div
                        key={model}
                        style={{ display: "grid", gridTemplateColumns: "1fr 64px", alignItems: "baseline", gap: 8 }}
                        title={model}
                      >
                        <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {model}
                        </span>
                        <span style={{ ...cellRight, fontSize: 11 }}>{formatTokens(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 明细：完整表格（小时桶，源 × 模型 × 端点分列） */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <span style={labelStyle}>{t("tokenAudit.details")}</span>
                  {truncated && (
                    <span data-testid="token-audit-capped" style={{ fontSize: 10, color: "var(--text-dim)" }}>
                      {t("tokenAudit.showingRecent", { shown: String(detailRows.length), total: String(rows.length) })}
                    </span>
                  )}
                </div>
                <div data-testid="token-audit-details" style={{ maxHeight: 300, overflow: "auto", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ ...tableHeaderCell, width: 64 }}>date</th>
                        <th style={{ ...tableHeaderCell, width: 48 }}>time</th>
                        <th style={tableHeaderCell}>source</th>
                        <th style={tableHeaderCell}>channel</th>
                        <th style={tableHeaderCell}>provider</th>
                        <th style={tableHeaderCell}>model</th>
                        <th style={{ ...tableHeaderCell, textAlign: "right" }}>input</th>
                        <th style={{ ...tableHeaderCell, textAlign: "right" }}>cache</th>
                        <th style={{ ...tableHeaderCell, textAlign: "right" }}>cacheW</th>
                        <th style={{ ...tableHeaderCell, textAlign: "right" }}>output</th>
                        <th style={{ ...tableHeaderCell, textAlign: "right" }}>total</th>
                      </tr>
                    </thead>
                    <tbody data-testid="token-audit-details-body">
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={11} style={{ padding: 10, color: "var(--text-dim)", fontSize: 11 }}>
                            {t("tokenAudit.empty")}
                          </td>
                        </tr>
                      )}
                      {detailRows.map((row, index) => (
                        <tr
                          key={`${row.date}-${row.hour}-${row.source}-${row.channel}-${row.provider}-${row.model}-${index}`}
                          style={{ borderBottom: "1px solid var(--border)" }}
                        >
                          <td style={{ padding: "4px 8px", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                            {row.date.slice(5)}
                          </td>
                          <td style={{ padding: "4px 8px", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                            {String(row.hour).padStart(2, "0")}:00
                          </td>
                          <td style={{ padding: "4px 8px", color: sourceColor(row.source), whiteSpace: "nowrap" }}>
                            {row.source}
                          </td>
                          <td style={{ padding: "4px 8px", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.channel}</td>
                          <td style={{ padding: "4px 8px", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.provider || "—"}</td>
                          <td style={{ padding: "4px 8px", color: "var(--text-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.model}
                          </td>
                          <td style={{ ...cellRight, padding: "4px 8px" }}>{row.input.toLocaleString()}</td>
                          <td style={{ ...cellRight, padding: "4px 8px" }}>{row.cacheRead.toLocaleString()}</td>
                          <td style={{ ...cellRight, padding: "4px 8px" }}>{row.cacheWrite.toLocaleString()}</td>
                          <td style={{ ...cellRight, padding: "4px 8px" }}>{row.output.toLocaleString()}</td>
                          <td style={{ ...cellRight, padding: "4px 8px", fontWeight: 600 }}>{row.total.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
