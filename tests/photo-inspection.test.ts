import { describe, expect, it, beforeEach } from "vitest";
import { inspectDataUrl } from "@/lib/photos";
import { POST as photoRoute } from "@/app/api/intake/[token]/photos/route";
import { DEMO_TOKENS } from "@/lib/demo/seed";
import { getIntakeByToken, resetDb } from "@/lib/store";
import { resetAnalytics } from "@/lib/analytics";
import { resetRateLimits } from "@/lib/ratelimit";
import { fakeImageDataUrl, jpegDataUrl, pngDataUrl } from "./fixtures/images";

/**
 * Server-side image inspection: the gates run on what the BYTES say, never on
 * what the client declares. Found by the security critic: a hostile client
 * could declare any mime/width/height and every quality gate ran on the lie.
 */

const TOKEN = DEMO_TOKENS.acne;
const params = { params: Promise.resolve({ token: TOKEN }) };
const post = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  resetDb();
  resetAnalytics();
  resetRateLimits();
});

describe("header inspection", () => {
  it("reads real JPEG dimensions from SOF0", () => {
    const i = inspectDataUrl(jpegDataUrl(1234, 987));
    expect(i).toMatchObject({ mime: "image/jpeg", width: 1234, height: 987, hasExif: false });
  });

  it("detects an EXIF APP1 segment", () => {
    expect(inspectDataUrl(jpegDataUrl(1400, 1050, { exif: true }))?.hasExif).toBe(true);
  });

  it("reads real PNG dimensions from IHDR", () => {
    const i = inspectDataUrl(pngDataUrl(800, 600));
    expect(i).toMatchObject({ mime: "image/png", width: 800, height: 600 });
  });

  it("returns null for bytes that are not an image", () => {
    expect(inspectDataUrl(fakeImageDataUrl())).toBeNull();
  });
});

describe("the photo route trusts bytes, not declarations", () => {
  it("rejects a payload whose declared dimensions are a lie", async () => {
    // Client claims 1400x1050; actual bytes say 10x10 — below MIN_DIMENSION.
    const res = await photoRoute(
      post({ dataUrl: jpegDataUrl(10, 10), width: 1400, height: 1050, mime: "image/jpeg" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(0);
  });

  it("rejects a non-image dressed in an image data URL, whatever the client claims", async () => {
    const res = await photoRoute(
      post({ dataUrl: fakeImageDataUrl(), width: 1400, height: 1050, mime: "image/jpeg" }),
      params,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a JPEG carrying EXIF metadata — the privacy claim is enforced server-side", async () => {
    const res = await photoRoute(
      post({ dataUrl: jpegDataUrl(1400, 1050, { exif: true }), width: 1400, height: 1050, mime: "image/jpeg" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(0);
  });

  it("stores the inspected dimensions, not the declared ones", async () => {
    const res = await photoRoute(
      post({ dataUrl: jpegDataUrl(900, 700), width: 4000, height: 4000, mime: "image/png" }),
      params,
    );
    expect(res.status).toBe(200);
    const photo = getIntakeByToken(TOKEN)!.photos[0];
    expect(photo.width).toBe(900);
    expect(photo.height).toBe(700);
    expect(photo.mime).toBe("image/jpeg");
  });

  it("rejects an oversized request by content-length before parsing", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(20 * 1024 * 1024) },
      body: JSON.stringify({ dataUrl: jpegDataUrl(1400, 1050) }),
    });
    const res = await photoRoute(req, params);
    expect(res.status).toBe(413);
  });
});
