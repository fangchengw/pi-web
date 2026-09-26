"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import type { NotificationsResponse } from "@/lib/notifications";
import { NotificationsModal } from "./NotificationsModal";

/** Bell + badge next to the Pi Web title. Alerts are a projection of source
 * state (see lib/notifications.ts); dismiss is a UI-only flag persisted by
 * POST /api/notifications/dismiss. Polls only while the tab is visible. */
export function NotificationCenter() {
  const { t } = useI18n();
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [open, setOpen] = useState(false);

  const query = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as NotificationsResponse;
      if (body.status === "ready" || body.status === "unavailable") setData(body);
    } catch {
      // 网络瞬时失败：保留上一次结果，下轮自动重试。
    }
  }, []);

  useAutoRefresh({ onRefresh: query, intervalMs: 60_000, visibilityCooldownMs: 30_000 });
  useEffect(() => {
    void query();
  }, [query]);

  const toggleDismiss = useCallback(async (id: string, dismissed: boolean) => {
    try {
      const response = await fetch("/api/notifications/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, dismissed }),
      });
      if (!response.ok) return;
      setData((prev) => {
        if (!prev) return prev;
        const items = prev.items.map((item) =>
          item.id === id ? { ...item, dismissed } : item,
        );
        return { ...prev, items, badge: items.filter((item) => !item.dismissed).length };
      });
    } catch {
      // 提交失败时保持现状；下一轮轮询会重新对齐服务端状态。
    }
  }, []);

  const clearAll = useCallback(async () => {
    // 发当前渲染的未忽略 id 快照——快照后新建的错误不在列表里,不会被误吞。
    const snapshot = (data?.items ?? [])
      .filter((item) => !item.dismissed)
      .map((item) => item.id);
    if (snapshot.length === 0) return;
    try {
      const response = await fetch("/api/notifications/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: snapshot, dismissed: true }),
      });
      if (!response.ok) return;
      setData((prev) => {
        if (!prev) return prev;
        const hidden = new Set(snapshot);
        const items = prev.items.map((item) =>
          hidden.has(item.id) ? { ...item, dismissed: true } : item,
        );
        return { ...prev, items, badge: items.filter((item) => !item.dismissed).length };
      });
    } catch {
      // 提交失败保持现状，下一轮轮询对齐。
    }
  }, [data]);

  const badge = data?.status === "ready" ? data.badge : 0;
  const unavailable = data?.status === "unavailable";
  const badgeText = badge > 99 ? "99+" : String(badge);
  const bellTitle = unavailable
    ? `${t("notifications.title")}: ${t("notifications.unavailable")}`
    : badge > 0
      ? t("notifications.badge", { count: badge })
      : t("notifications.title");

  return (
    <>
      <button
        type="button"
        data-testid="notifications-bell"
        aria-label={bellTitle}
        aria-expanded={open}
        title={bellTitle}
        onClick={() => {
          setOpen(true);
          void query(); // 打开时立即取最新，不等下一轮轮询。
        }}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          background: "none",
          border: "none",
          borderRadius: 7,
          color: badge > 0 || unavailable ? "var(--text)" : "var(--text-dim)",
          cursor: "pointer",
          flexShrink: 0,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {(badge > 0 || unavailable) && (
          <span
            data-testid="notifications-badge"
            style={{
              position: "absolute",
              top: -3,
              right: -4,
              minWidth: 15,
              height: 15,
              padding: "0 4px",
              borderRadius: 8,
              background: unavailable && badge === 0 ? "#f59e0b" : "#ef4444",
              color: "#fff",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: "15px",
              textAlign: "center",
              boxSizing: "border-box",
            }}
          >
            {unavailable && badge === 0 ? "!" : badgeText}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <NotificationsModal
            data={data}
            onClose={() => setOpen(false)}
            onRefresh={query}
            onToggleDismiss={toggleDismiss}
            onClearAll={clearAll}
          />,
          document.body,
        )}
    </>
  );
}
