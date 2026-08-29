/**
 * The route wrapper.
 *
 * Every API route runs inside `handle()`, which is the one place that:
 *
 *   - assigns or adopts a request id and returns it on the response, so a
 *     patient reporting a problem and a log line can be joined up;
 *   - turns any thrown value into a safe response via the error taxonomy, so
 *     a Postgres error or a provider response cannot reach a client;
 *   - logs the outcome with timing and no clinical content.
 *
 * Doing this per route was the alternative, and it fails the way per-route
 * security always fails: correctly thirteen times and then not on the
 * fourteenth.
 */

import { NextResponse } from "next/server";
import { AppError, toAppError } from "@/lib/errors";
import { REQUEST_ID_HEADER, log, requestIdFrom } from "@/lib/log";
import { runtimeMode } from "@/lib/config/runtime";

export interface RequestContext {
  requestId: string;
  req: Request;
}

export type Handler = (ctx: RequestContext) => Promise<Response>;

export async function handle(req: Request, route: string, fn: Handler): Promise<Response> {
  const requestId = requestIdFrom(req);
  const started = Date.now();
  let status = 200;
  let errorCode: string | undefined;

  try {
    const res = await fn({ requestId, req });
    status = res.status;
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  } catch (err) {
    const appErr = toAppError(err);
    status = appErr.status;
    errorCode = appErr.code;
    // The detail goes to the log; the client gets the taxonomy's message and
    // the request id, which is enough for support to find this line.
    log.error("request failed", {
      request_id: requestId,
      route,
      error_code: appErr.code,
      status,
      reason: appErr.detail.slice(0, 96).replace(/\s+/g, " "),
    });
    const body: Record<string, unknown> = {
      error: appErr.publicMessage,
      code: appErr.code,
      requestId,
    };
    if (appErr.retryable) body.retryable = true;
    return NextResponse.json(body, {
      status,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } finally {
    log.info("request", {
      request_id: requestId,
      route,
      method: req.method,
      status,
      mode: runtimeMode(),
      duration_ms: Date.now() - started,
      error_code: errorCode,
    });
  }
}

/** Throw-style helpers, so a route reads as a series of guarantees. */
export function require(condition: unknown, code: ConstructorParameters<typeof AppError>[0], detail = ""): void {
  if (!condition) throw new AppError(code, detail);
}

export const jsonOk = <T>(data: T, status = 200) => NextResponse.json(data, { status });
