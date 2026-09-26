import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import type { TokenAuditReport, TokenAuditResult } from "@/lib/token-audit";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

/**
 * The audit lives outside the repo (per workspace-file conventions):
 * audit.py is a stdlib-only local script, reports/latest.json its output.
 * Reading costs nothing; ?refresh=1 reruns the script — still zero model
 * tokens, it never calls an LLM.
 */
const SCRIPT_DIR = path.join(os.homedir(), "workspace", "projects", "token-audit");
const SCRIPT_PATH = path.join(SCRIPT_DIR, "audit.py");
const REPORT_PATH = path.join(SCRIPT_DIR, "reports", "latest.json");

async function readReport(): Promise<TokenAuditResult> {
  try {
    const raw = await fs.readFile(REPORT_PATH, "utf8");
    const report = JSON.parse(raw) as TokenAuditReport;
    if (!report || !Array.isArray(report.rows) || !report.totals) {
      return { status: "unavailable", message: "Report file is malformed — rerun refresh." };
    }
    return { status: "ready", report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      message: `No report yet (${message}) — click refresh to generate.`,
    };
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!refresh) return NextResponse.json(await readReport());

  try {
    await execFileAsync("python3", [SCRIPT_PATH], {
      cwd: SCRIPT_DIR,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    // Script failure still serves the previous report, flagged so the panel
    // can show that the numbers did not move.
    const message = error instanceof Error ? error.message : String(error);
    const fallback = await readReport();
    if (fallback.status === "ready") {
      return NextResponse.json({ ...fallback, refreshError: message });
    }
    return NextResponse.json({ status: "unavailable", message: `audit.py failed: ${message}` });
  }
  return NextResponse.json(await readReport());
}
