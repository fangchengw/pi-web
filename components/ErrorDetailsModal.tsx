"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { buildErrorPrompt } from "@/lib/error-prompt";
import { formatFullTimestamp, formatUpdatedTime } from "@/lib/i18n/format";
import type { NotificationDto, NotificationsResponse } from "@/lib/notifications";

const LEVEL_COLOR: Record<NotificationDto["level"], string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#60a5fa",
};

interface Props {
  /** Notification jump target: expand + scroll to this error id. */
  focusId?: string | null;
  onClose: () => void;
  /** Copy the full error prompt into the currently open composer. */
  onAskHere?: (prompt: string) => void;
  /** Copy the full error prompt into a brand-new draft composer. */
  onAskInNewChat?: (prompt: string) => void;
}

/**
 * Error details panel (top-bar entry, standalone — deliberately independent
 * from the notification modal: 错误管错误,通知管通知).
 *
 * The full data layer: every projected error regardless of reminder state.
 * Each row carries ONE control — a switch for the error line's FUTURE alert
 * policy (`alertOff`), which never changes which notifications are currently
 * visible. Expanding a row reveals the full error text with copy.
 */
export function ErrorDetailsModal({ focusId, onClose, onAskHere, onAskInNewChat }: Props) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(focusId ?? null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 固定按钮在展开行内；错误（无输入框/无工作目录）就地显示在按钮下方。
  const [askError, setAskError] = useState<{ itemId: string; message: string } | null>(null);

  const query = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as NotificationsResponse;
      if (body.status === "ready" || body.status === "unavailable") setData(body);
    } catch {
      // 瞬时失败保留上次结果。
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    void query();
  }, [query]);

  // 来自通知跳转的 focus：展开目标行并滚过去。
  useEffect(() => {
    if (!focusId) return;
    setExpandedId(focusId);
    const timer = setTimeout(() => {
      listRef.current
        ?.querySelector(`[data-error-row="${CSS.escape(focusId)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => clearTimeout(timer);
  }, [focusId]);

  const items = useMemo(
    () => [...(data?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [data],
  );
  const unavailable = data?.status === "unavailable";

  const copyBody = useCallback(async (item: NotificationDto) => {
    try {
      await copyText(item.body);
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // 复制失败静默；文本可手动选中。
    }
  }, []);

  /** Toggle this error line's FUTURE alert policy (error layer). Never
   * touches the reminder layer: muting arms/disarms arrivals only, existing
   * notifications stay put until the user trashes them. */
  const toggleAlertPolicy = useCallback(async (item: NotificationDto) => {
    try {
      const response = await fetch("/api/notifications/alert-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namespace: item.namespace,
          source: item.source,
          off: !item.alertOff,
        }),
      });
      if (response.ok) await query();
    } catch {
      // 提交失败保持现状，下次刷新重对。
    }
  }, [query]);

  // 完整错误提示：元数据 + id + 引用正文 + 问题占位 —— 所见即所得。
  const buildPrompt = useCallback(
    (item: NotificationDto) => buildErrorPrompt(item, {
      intro: t("errorDetails.quoteIntro"),
      question: t("chat.quoteQuestion"),
      lastSeen: formatFullTimestamp(item.updatedAt, locale),
    }),
    [t, locale],
  );

  const runAsk = useCallback((
    item: NotificationDto,
    ask: ((prompt: string) => void) | undefined,
  ) => {
    if (!ask) return;
    try {
      ask(buildPrompt(item));
      setAskError(null);
    } catch (error) {
      setAskError({ itemId: item.id, message: error instanceof Error ? error.message : String(error) });
    }
  }, [buildPrompt]);

  return (
    <div
      data-testid="error-details-modal"
      aria-label={t("errorDetails.title")}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 700,
        background: "rgba(0,0,0,0.45)",
        padding:
          "max(6px, env(safe-area-inset-top)) max(6px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(6px, env(safe-area-inset-left))",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("errorDetails.title")}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "relative",
          width: narrow ? "100%" : "min(760px, 94%)",
          height: narrow ? "100%" : "min(760px, 90%)",
          background: "var(--bg-panel)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* 头部 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1 }}>
            {t("errorDetails.title")}
          </span>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            {t("errorDetails.count", { count: items.length })}
          </span>
          <button
            type="button"
            data-testid="error-details-close"
            onClick={onClose}
            aria-label={t("notifications.close")}
            title={t("notifications.close")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              background: "none",
              border: "none",
              borderRadius: 8,
              color: "var(--text-dim)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 错误列表（全量含已忽略） */}
        <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 14px 14px" }}>
          {unavailable && (
            <div data-testid="error-details-unavailable" style={{ fontSize: 12, color: "#f59e0b", padding: "10px 0" }}>
              {t("notifications.unavailable")}
              {data?.message ? ` — ${data.message}` : ""}
            </div>
          )}
          {!unavailable && items.length === 0 && (
            <div data-testid="error-details-empty" style={{ fontSize: 12, color: "var(--text-dim)", padding: "14px 0" }}>
              {t("notifications.noErrors")}
            </div>
          )}
          {items.map((item) => {
            const expanded = expandedId === item.id;
            return (
              <div
                key={item.id}
                data-testid="error-details-item"
                data-error-row={item.id}
                style={{
                  borderBottom: "1px solid var(--border)",
                  padding: "8px 0",
                  background: focusId === item.id ? "rgba(239,68,68,0.06)" : undefined,
                  opacity: item.alertOff ? 0.66 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <button
                    type="button"
                    data-testid="error-details-item-toggle"
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                    aria-expanded={expanded}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: LEVEL_COLOR[item.level], flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.title}
                    </span>
                    {item.count > 1 && (
                      <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>×{item.count}</span>
                    )}
                    <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, marginLeft: "auto" }} title={formatFullTimestamp(item.updatedAt, locale)}>
                      {formatUpdatedTime(item.updatedAt, locale)}
                    </span>
                  </button>
                  {/* 铃铛 = 该错误线的未来提醒策略：正常铃铛=新发生会提醒，划掉=已静音；不碰现有通知 */}
                  <button
                    type="button"
                    data-testid="error-details-item-bell"
                    aria-label={item.alertOff ? t("notifications.switchOffTitle") : t("notifications.switchOnTitle")}
                    aria-pressed={!item.alertOff}
                    title={item.alertOff ? t("notifications.switchOffTitle") : t("notifications.switchOnTitle")}
                    onClick={() => void toggleAlertPolicy(item)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      background: "none",
                      border: "none",
                      borderRadius: 6,
                      /* 铃铛颜色与顶栏通知铃铛一致：提醒中 var(--text)，静音 var(--text-dim)（不再跟随错误级别变色） */
                      color: item.alertOff ? "var(--text-dim)" : "var(--text)",
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    {item.alertOff ? (
                      /* 已静音 → 划掉铃铛（当前状态：静默） */
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18.6 18.6c-.5.7-1.1 1.3-1.8 1.8V20a2 2 0 0 1-3.46-1.4" />
                        <path d="M13.73 15.4A6 6 0 0 0 6 8c0 7-3 9-3 9h13" />
                        <line x1="3" y1="3" x2="21" y2="21" />
                      </svg>
                    ) : (
                      /* 提醒中 → 正常铃铛（当前状态：在提醒） */
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                    )}
                  </button>
                </div>
                {expanded && (
                  /* 展开区整体左右各 13：正文框不再单边缩进，元数据/正文/按钮
                     共用同一条对称内容栏 [13, W-13]（圆点仍在最左悬挂）。 */
                  <div style={{ marginTop: 8, padding: "0 13px" }}>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", display: "flex", flexWrap: "wrap", gap: "0 14px", marginBottom: 6 }}>
                      <span title={formatFullTimestamp(item.createdAt, locale)}>
                        {t("notifications.firstSeen", { time: formatUpdatedTime(item.createdAt, locale) })}
                      </span>
                      <span title={formatFullTimestamp(item.updatedAt, locale)}>
                        {t("notifications.lastSeen", { time: formatUpdatedTime(item.updatedAt, locale) })}
                      </span>
                      <span>{t("notifications.occurrences", { count: item.count })}</span>
                    </div>
                    <pre
                      data-testid="error-details-item-body"
                      style={{
                        margin: 0,
                        padding: 10,
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 11,
                        lineHeight: 1.55,
                        color: "var(--text-muted)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        userSelect: "text",
                        maxHeight: "40vh",
                        overflowY: "auto",
                      }}
                    >
                      {item.body}
                    </pre>
                    <div
                      style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
                      title={t("errorDetails.attachHint")}
                    >
                      <button
                        type="button"
                        data-testid="error-details-item-copy"
                        onClick={() => void copyBody(item)}
                        style={{
                          fontSize: 11,
                          padding: "5px 12px",
                          borderRadius: 7,
                          border: "1px solid var(--border)",
                          background: "var(--bg-hover)",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                        }}
                      >
                        {copiedId === item.id ? t("i18n.copied") : t("i18n.copy")}
                      </button>
                      {onAskHere && (
                        <button
                          type="button"
                          data-testid="error-details-ask-here"
                          onClick={() => runAsk(item, onAskHere)}
                          aria-label={t("chat.askInCurrent")}
                          style={{
                            fontSize: 11,
                            padding: "5px 12px",
                            borderRadius: 7,
                            border: "1px solid var(--border)",
                            background: "var(--bg-hover)",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                          }}
                        >
                          <span aria-hidden="true" style={{ fontSize: 13 }}>@</span>
                          {t("chat.askInCurrent")}
                        </button>
                      )}
                      {onAskInNewChat && (
                        <button
                          type="button"
                          data-testid="error-details-ask-new-chat"
                          onClick={() => runAsk(item, onAskInNewChat)}
                          aria-label={t("chat.askInNewChat")}
                          style={{
                            fontSize: 11,
                            padding: "5px 12px",
                            borderRadius: 7,
                            border: "1px solid var(--border)",
                            background: "var(--bg-hover)",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
                          </svg>
                          {t("chat.askInNewChat")}
                        </button>
                      )}
                      {askError?.itemId === item.id && (
                        <span role="alert" style={{ fontSize: 11, color: "#dc2626", overflowWrap: "anywhere" }}>
                          {askError.message}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
