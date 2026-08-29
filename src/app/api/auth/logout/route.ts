import { NextResponse } from "next/server";
import { handle, jsonOk } from "@/lib/http";
import { requirePilotMode } from "@/lib/auth/guard";
import { SESSION_COOKIE } from "@/lib/auth/session";

/** Clears the session cookie. Deliberately does not require a valid session. */
export async function POST(req: Request) {
  return handle(req, "POST /api/auth/logout", async () => {
    requirePilotMode();
    const res = jsonOk({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res as NextResponse;
  });
}
