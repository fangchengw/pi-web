/**
 * Pure MiMo formatting helpers — safe for client components to import
 * (lib/mimo-usage.ts pulls in node: child_process/fs and must stay server-only).
 */

/** Compact token counts: 822235904 → "822.2M", 4100000000 → "4.10B". */
export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}
