import { NextResponse } from "next/server";
import { runtimeMode } from "@/lib/config/runtime";
import { store } from "@/lib/store";
import { isUpToDate } from "@/lib/db/migrate";
import { log } from "@/lib/log";
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
 * failing check says "not ready", not why — the why goes to the logs, behind
 * access control. That last part was a comment describing a log that did not
 * exist: the catch swallowed everything, so an operator got a red check and an
 * empty log. A readiness probe with no diagnostic anywhere is worse than none,
 * because it looks like it is telling you something.
 */
export async function GET() {
  const mode = runtimeMode();

  // Demo mode has no external dependency; if the process answers, it is ready.
  if (mode === "demo") {
    return NextResponse.json({ status: "ok", mode }, { headers: { "cache-control": "no-store" } });
  }

  let database = false;
  let schema = false;
  let reason: string | null = null;
  try {
    const s = await store();
    database = await s.ping();
    if (database) {
      const driver = (s as SqlStore).driver;
      schema = await isUpToDate(driver).catch(() => false);
      if (!schema) reason = "schema_behind";
    } else {
      reason = "ping_failed";
    }
  } catch (err) {
    reason = err instanceof Error ? err.name : "unknown";
  }

  const ready = database && schema;
  if (!ready) {
    // To the log, never to the response: the caller of a health endpoint is
    // frequently an unauthenticated load balancer. `log` allowlists its fields,
    // so this cannot become a channel for a connection string or a driver
    // message that quotes one.
    log.warn("health.not_ready", { mode, reason: reason ?? "unknown" });
  }
  return NextResponse.json(
    { status: ready ? "ok" : "not_ready", mode, checks: { database, schema } },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
