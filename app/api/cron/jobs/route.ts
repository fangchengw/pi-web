import { NextResponse } from "next/server";
import {
  listCronJobs,
  mutateCronJob,
  readCronRunLog,
  resolveCronPaths,
  startCronDaemon,
  type CronJobsResult,
  type CronJobAction,
} from "@/lib/cron-jobs";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

type JobsResponse = CronJobsResult & { actionError?: string };

export async function GET(request: Request): Promise<NextResponse> {
  const runLogParam = new URL(request.url).searchParams.get("runLog");
  if (runLogParam !== null) {
    const parts = runLogParam.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return NextResponse.json({ error: "Invalid runLog parameter" }, { status: 400 });
    }
    const content = readCronRunLog(resolveCronPaths(), parts[0], parts[1]);
    if (content === null) {
      return NextResponse.json({ error: "Run log not found" }, { status: 404 });
    }
    return NextResponse.json({ runLog: { name: parts[1], content } });
  }
  return NextResponse.json(await listCronJobs());
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Request not allowed" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const record = body as { action?: unknown; id?: unknown } | null;
  const action = record?.action;
  if (action !== "enable" && action !== "disable" && action !== "run" && action !== "start-daemon") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const paths = resolveCronPaths();
  const actionErrors: string[] = [];
  try {
    if (action === "start-daemon") {
      const started = startCronDaemon(paths);
      if (!started.ok) actionErrors.push(started.message);
    } else {
      if (typeof record?.id !== "string" || record.id.trim() === "") {
        return NextResponse.json({ error: "Missing job id" }, { status: 400 });
      }
      const updated = await mutateCronJob(paths, record.id, action as CronJobAction);
      if (!updated) {
        return NextResponse.json({ error: `Cron job not found: ${record.id}` }, { status: 404 });
      }
      if (action === "run") {
        // Official `cron run` queues nextRunAt=now and ensures the daemon.
        const started = startCronDaemon(paths);
        if (!started.ok) actionErrors.push(started.message);
      }
    }
    const refreshed = await listCronJobs(paths);
    const payload: JobsResponse =
      actionErrors.length > 0 && refreshed.status === "ready"
        ? { ...refreshed, actionError: actionErrors.join("; ") }
        : refreshed;
    return NextResponse.json(payload);
  } catch (error) {
    console.error("[api/cron/jobs] action failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ status: "query-failed", message, error: message }, { status: 500 });
  }
}
