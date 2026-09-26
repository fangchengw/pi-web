import { NextResponse } from "next/server";
import { loadDismissState, saveDismissState, setAlertOff } from "@/lib/notification-dismiss";

export const dynamic = "force-dynamic";

export interface AlertPolicyRequest {
  /** Source registry id, e.g. "watchdog". */
  namespace: string;
  /** Source fingerprint of the error line. */
  source: string;
  /** true = mute future occurrences of this error line. */
  off: boolean;
}

/**
 * ERROR LAYER only: writes `alertOff` for one error line, never `hidden`.
 *
 * Muting arms/disarms FUTURE arrivals of that error — it never changes which
 * notifications are currently visible (that's the reminder layer's job). The
 * caller must send namespace+source exactly as rendered in the item DTO.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: Partial<AlertPolicyRequest>;
  try {
    body = (await request.json()) as Partial<AlertPolicyRequest>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { namespace, source, off } = body;
  if (typeof namespace !== "string" || !namespace || namespace.length > 64) {
    return NextResponse.json({ error: "namespace (string) required" }, { status: 400 });
  }
  if (typeof source !== "string" || !source || source.length > 1024) {
    return NextResponse.json({ error: "source (string) required" }, { status: 400 });
  }
  if (typeof off !== "boolean") {
    return NextResponse.json({ error: "off (boolean) required" }, { status: 400 });
  }

  try {
    const state = loadDismissState();
    const key = `${namespace}:${source}`;
    state.alertOff = setAlertOff(state.alertOff, key, off, Date.now());
    saveDismissState(state);
    return NextResponse.json({ ok: true, key, alertOff: off });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
