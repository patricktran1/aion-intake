import { NextResponse } from "next/server";
import { runtimeMode } from "@/lib/config/runtime";
import { store } from "@/lib/store";
import { isUpToDate } from "@/lib/db/migrate";
import type { SqlStore } from "@/lib/store";

/**
 * Liveness and readiness.
 *
 * Deliberately shallow and deliberately quiet. It reports whether the app is
 * up and whether its hard dependency — the database and a current schema — is
 * reachable, and nothing else. Object storage and the model provider are NOT
 * checked: the app degrades without the model, and a photo-store blip should
 * not take the whole service out of a load balancer while patients can still
 * answer questions.
 *
 * It exposes no versions, hostnames, connection strings, or error detail. A
 * failing check says "not ready", not why — the why is in the logs, behind
 * access control.
 */
export async function GET() {
  const mode = runtimeMode();

  // Demo mode has no external dependency; if the process answers, it is ready.
  if (mode === "demo") {
    return NextResponse.json({ status: "ok", mode }, { headers: { "cache-control": "no-store" } });
  }

  let database = false;
  let schema = false;
  try {
    const s = await store();
    database = await s.ping();
    if (database) {
      const driver = (s as SqlStore).driver;
      schema = await isUpToDate(driver).catch(() => false);
    }
  } catch {
    // Any failure is simply "not ready". The detail is logged elsewhere.
  }

  const ready = database && schema;
  return NextResponse.json(
    { status: ready ? "ok" : "not_ready", mode, checks: { database, schema } },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
