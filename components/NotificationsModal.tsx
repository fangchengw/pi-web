"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatFullTimestamp, formatUpdatedTime } from "@/lib/i18n/format";
import {
  NOTIFICATION_JUMP_EVENT,
  type NotificationDto,
  type NotificationsResponse,
} from "@/lib/notifications";

const LEVEL_COLOR: Record<NotificationDto["level"], string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#60a5fa",
};

interface Props {
  data: NotificationsResponse | null;
  onClose: () => void;
  onRefresh: () => void;
  onToggleDismiss: (id: string, dismissed: boolean) => void;
}

/**
 * Notification center modal — pure reminder layer.
 *
 * Deliberately knows nothing about errors/details: clicking a row dispatches
 * NOTIFICATION_JUMP_EVENT so AppShell opens the interface that owns the
 * source's details (today always the standalone ErrorDetails panel). The trash
 * icon dismisses (UI-only flag); data lives in the source projections.
 */
export function NotificationsModal({ data, onClose, onRefresh, onToggleDismiss }: Props) {
  const { locale, t } = useI18n();
  const [narrow, setNarrow] = useState(false);

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
    onRefresh();
    // 打开时刷新一次；后续轮询由铃铛负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => data?.items ?? [], [data]);
  const alerts = useMemo(() => items.filter((item) => !item.dismissed), [items]);
  const unavailable = data?.status === "unavailable";
  const stale = Boolean(data && data.lastRun > 0 && Date.now() - data.lastRun > 900_000);

  const jump = (item: NotificationDto) => {
    window.dispatchEvent(
      new CustomEvent(NOTIFICATION_JUMP_EVENT, {
        detail: { target: item.action, errorId: item.id },
      }),
    );
    onClose();
  };

  return (
    <div
      data-testid="notifications-modal"
      aria-label={t("notifications.title")}
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
        aria-label={t("notifications.title")}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "relative",
          width: narrow ? "100%" : "min(680px, 94%)",
          height: narrow ? "100%" : "min(640px, 88%)",
          background: "var(--bg-panel)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* 头部：标题 + 关闭 */}
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
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("notifications.title")}
          </span>
          {stale && (
            <span style={{ fontSize: 10, color: "#f59e0b", flexShrink: 0 }} title={formatFullTimestamp(data?.lastRun ?? 0, locale)}>
              {t("notifications.stale")}
            </span>
          )}
          <button
            type="button"
            data-testid="notifications-close"
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

        {/* 通知列表（纯提醒层） */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 14px 14px" }}>
          <div data-testid="notifications-list">
            {unavailable && (
              <div data-testid="notifications-unavailable" style={{ fontSize: 12, color: "#f59e0b", padding: "10px 0" }}>
                {t("notifications.unavailable")}
                {data?.message ? ` — ${data.message}` : ""}
              </div>
            )}
            {!unavailable && alerts.length === 0 && (
              <div data-testid="notifications-empty" style={{ fontSize: 12, color: "var(--text-dim)", padding: "14px 0" }}>
                {t("notifications.empty")}
              </div>
            )}
            {alerts.map((item) => (
              <div
                key={item.id}
                data-testid="notifications-item"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <button
                  type="button"
                  data-testid="notifications-item-open"
                  onClick={() => jump(item)}
                  title={t("notifications.jump")}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
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
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 3,
                      marginLeft: 13,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      wordBreak: "break-word",
                    }}
                  >
                    {item.body}
                  </div>
                </button>
                {/* 垃圾桶 = dismiss（只是移出提醒层，数据不删） */}
                <button
                  type="button"
                  data-testid="notifications-item-dismiss"
                  aria-label={t("notifications.dismiss")}
                  title={t("notifications.dismiss")}
                  onClick={() => onToggleDismiss(item.id, true)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    marginTop: 2,
                    background: "none",
                    border: "none",
                    borderRadius: 6,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
