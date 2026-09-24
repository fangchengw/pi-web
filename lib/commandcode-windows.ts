/**
 * Pure helpers for Command Code rolling usage windows.
 * Kept free of node: imports so client components can import it safely.
 */

export type CommandCodeWindowId = "fiveHour" | "weekly" | "monthly";

export interface CommandCodeWindow {
  id: CommandCodeWindowId;
  used: number;
  cap: number;
  /** Epoch ms when the window resets, or null when no reset is scheduled. */
  resetAt: number | null;
  exceeded: boolean;
}

interface RawWindow {
  used?: number;
  cap?: number;
  exceeded?: boolean;
  resetAt?: number;
}

export interface RawWindowLimits {
  fiveHour?: RawWindow;
  weekly?: RawWindow;
  monthly?: RawWindow;
}

const WINDOW_IDS: CommandCodeWindowId[] = ["fiveHour", "weekly", "monthly"];

function normalizeWindow(id: CommandCodeWindowId, raw: RawWindow | undefined): CommandCodeWindow | null {
  if (!raw || typeof raw.used !== "number" || typeof raw.cap !== "number") return null;
  const used = Math.max(0, raw.used);
  const cap = Math.max(0, raw.cap);
  const resetAt = typeof raw.resetAt === "number" && raw.resetAt > 0 ? raw.resetAt : null;
  return { id, used, cap, resetAt, exceeded: raw.exceeded ?? used >= cap };
}

/** Pick the known usage windows (5-hour / weekly / monthly) from the API payload. */
export function pickCommandCodeWindows(windowLimits: RawWindowLimits | null | undefined): CommandCodeWindow[] {
  if (!windowLimits) return [];
  const windows: CommandCodeWindow[] = [];
  for (const id of WINDOW_IDS) {
    const window = normalizeWindow(id, windowLimits[id]);
    if (window) windows.push(window);
  }
  return windows;
}

/** Pick the window with the highest used/cap ratio (ties keep the earlier window). */
export function pickHottestWindow(windows: readonly CommandCodeWindow[]): CommandCodeWindow | null {
  let hottest: CommandCodeWindow | null = null;
  let hottestRatio = -1;
  for (const window of windows) {
    const ratio = window.cap > 0 ? window.used / window.cap : 0;
    if (ratio > hottestRatio) {
      hottest = window;
      hottestRatio = ratio;
    }
  }
  return hottest;
}

/** Port of the CLI's `formatDuration`: minute/hour/day precision, never "0m". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
