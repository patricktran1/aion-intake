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

/**
 * Default cap on a JSON request body.
 *
 * Generous next to the largest legitimate one — a 4,000-character answer plus
 * its envelope — and far below what an unbounded `req.json()` will happily
 * pull into memory. The photo route sets its own, larger limit.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * Parses a JSON body with a size ceiling.
 *
 * `await req.json()` reads whatever arrives. Every write route called it
 * directly, so a single request could allocate as much memory as a client was
 * willing to send — the smallest denial of service there is, and one that
 * needs no authentication because the parse happens before any check that
 * could reject it. Content-Length is checked first when present, and the
 * stream is measured as it arrives for the chunked case where it is not.
 */
export async function readJson(req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", `declared ${declared} bytes over ${maxBytes}`);
  }

  const body = req.body;
  let text: string;
  if (!body) {
    text = await req.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new AppError("PAYLOAD_TOO_LARGE", "body over limit");
    }
  } else {
    // A declared length can lie, and a chunked request declares none. Count
    // the bytes as they arrive and abandon the read the moment it goes over,
    // rather than buffering the whole thing and then measuring it.
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppError("PAYLOAD_TOO_LARGE", `over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  }

  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("BAD_REQUEST", "unparseable JSON body");
  }
}
