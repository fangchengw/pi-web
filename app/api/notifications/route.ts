import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { projectWatchdog, type NotificationDto, type NotificationItem, type NotificationsResponse, type WatchdogState } from "@/lib/notifications";
import { loadDismissState, pruneDismissed, saveDismissState } from "@/lib/notification-dismiss";

export const dynamic = "force-dynamic";

/** ~/.openviking/watchdog-state.json — written by watchdog.py (launchd, 5min). */
const WATCHDOG_STATE_PATH = join(homedir(), ".openviking", "watchdog-state.json");

export async function GET(): Promise<NextResponse> {
  let items: NotificationItem[];
  let lastRun = 0;
  try {
    const raw = readFileSync(WATCHDOG_STATE_PATH, "utf8");
    const state = JSON.parse(raw) as WatchdogState;
    if (typeof state !== "object" || state === null) throw new Error("malformed watchdog state");
    items = projectWatchdog(state);
    lastRun = typeof state.last_run === "number" ? state.last_run * 1000 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      status: "unavailable",
      message: message.startsWith("ENOENT") ? "watchdog 未运行" : message,
      lastRun: 0,
      badge: 0,
      items: [],
    } satisfies NotificationsResponse);
  }

  // Dismiss state: merge, and GC ids whose issues vanished — but only now that
  // the source read succeeded, so a transient read failure can't wipe them.
  const dismissed = loadDismissState();
  const activeIds = items.map((item) => item.id);
  const pruned = pruneDismissed(dismissed, activeIds);
  if (Object.keys(pruned).length !== Object.keys(dismissed).length) {
    try {
      saveDismissState(pruned);
    } catch {
      // GC failure only delays cleanup; serving the response matters more.
    }
  }

  const dtos: NotificationDto[] = items.map((item) => ({
    ...item,
    dismissed: Object.hasOwn(pruned, item.id),
  }));
  const body: NotificationsResponse = {
    status: "ready",
    lastRun,
    badge: dtos.filter((item) => !item.dismissed).length,
    items: dtos,
  };
  return NextResponse.json(body);
}
