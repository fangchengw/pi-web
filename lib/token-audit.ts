/**
 * Token audit report types + pure helpers (date-range filtering and totals
 * recomputation), shared by the sidebar panel and its tests. The report file
 * itself is produced by ~/workspace/projects/token-audit/audit.py — a stdlib-only
 * local script that reads pi session files, OpenViking's usage_audit sqlite
 * and hermes logs, so generating a report costs zero model tokens.
 */

export type TokenAuditRow = {
  /** YYYY-MM-DD, local timezone of the audit host. */
  date: string;
  /** 0-23 local hour — rows are hourly buckets so ranges can pick hours. */
  hour: number;
  /** pi | openviking | hermes — who consumed. */
  source: string;
  /** sessions | vlm | gateway | cron — which channel inside the source. */
  channel: string;
  /** Endpoint the call went through ("" when the source does not record one). */
  provider: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
};

export type TokenAuditTotals = {
  all: number;
  bySource: Record<string, number>;
  byDay: Record<string, number>;
  /** Keyed "source|date" so a day belongs to each source separately. */
  bySourceDay: Record<string, number>;
  /** Same model summed across sources — the "who runs this model" view. */
  byModel: Record<string, number>;
};

export type TokenAuditReport = {
  generatedAt: string;
  tz: string;
  unit: string;
  rows: TokenAuditRow[];
  totals: TokenAuditTotals;
};

export type TokenAuditResult =
  | { status: "ready"; report: TokenAuditReport; refreshError?: string }
  | { status: "unavailable"; message: string };

/**
 * Normalize a stored range bound to local epoch ms.
 * Accepts `datetime-local` values (`YYYY-MM-DDTHH:MM`) and legacy date-only
 * values (`YYYY-MM-DD`, whole-day semantics: start→00:00, end→23:59:59.999).
 * Empty string = unbounded → null.
 */
export function parseRangeBound(value: string, side: "start" | "end"): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const base = new Date(`${value}T00:00:00`).getTime();
    if (Number.isNaN(base)) return null;
    return side === "start" ? base : base + 86_400_000 - 1;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A row covers one local hour bucket [bucketStart, bucketEnd). The range is a
 * closed interval: the row counts when the bucket intersects [start, end], so
 * "最近1小时" from now-60m includes the bucket containing now, and a date-only
 * end covers that whole day.
 */
export function isRowInRange(row: TokenAuditRow, start: string, end: string): boolean {
  const bucketStart = new Date(
    `${row.date}T${String(row.hour).padStart(2, "0")}:00`,
  ).getTime();
  if (Number.isNaN(bucketStart)) return false;
  const bucketEnd = bucketStart + 3_600_000;
  const from = parseRangeBound(start, "start");
  if (from !== null && bucketEnd <= from) return false;
  const to = parseRangeBound(end, "end");
  if (to !== null && bucketStart > to) return false;
  return true;
}

export function filterRowsByRange(
  rows: TokenAuditRow[],
  start: string,
  end: string,
): TokenAuditRow[] {
  return rows.filter((row) => isRowInRange(row, start, end));
}

/** Recompute every total for a (possibly filtered) row set, same shapes as audit.py. */
export function totalsForRows(rows: TokenAuditRow[]): TokenAuditTotals {
  const totals: TokenAuditTotals = {
    all: 0,
    bySource: {},
    byDay: {},
    bySourceDay: {},
    byModel: {},
  };
  const bump = (bucket: Record<string, number>, key: string, value: number): void => {
    bucket[key] = (bucket[key] ?? 0) + value;
  };
  for (const row of rows) {
    totals.all += row.total;
    bump(totals.bySource, row.source, row.total);
    bump(totals.byDay, row.date, row.total);
    bump(totals.bySourceDay, `${row.source}|${row.date}`, row.total);
    bump(totals.byModel, row.model, row.total);
  }
  return totals;
}

/** Largest value in a record — used for mini-bar scaling. */
export function maxValue(bucket: Record<string, number>): number {
  let max = 0;
  for (const value of Object.values(bucket)) if (value > max) max = value;
  return max;
}

/**
 * Details table safety fuse: rendering tens of thousands of table rows would
 * choke the DOM long before the JSON or the aggregates do. When the filtered
 * set exceeds the cap, keep the NEWEST rows (input rows are date-ascending) so
 * the tail the user most likely wants stays visible; the UI shows a note.
 */
export const DETAILS_ROW_CAP = 500;

export function capDetailRows(
  rows: TokenAuditRow[],
  cap: number = DETAILS_ROW_CAP,
): { rows: TokenAuditRow[]; truncated: boolean } {
  if (rows.length <= cap) return { rows, truncated: false };
  return { rows: rows.slice(-cap), truncated: true };
}

/** Descending entries so renderers do not each re-sort. */
export function sortedEntries(bucket: Record<string, number>): [string, number][] {
  return Object.entries(bucket).sort((a, b) => b[1] - a[1]);
}
