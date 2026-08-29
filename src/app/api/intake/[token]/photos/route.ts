import { bundleByToken, saveIntake } from "@/lib/store";
import type { Photo } from "@/lib/domain/types";
import { fail, json, patientView } from "@/lib/api";
import { LIMITS, allow, intakeKey } from "@/lib/ratelimit";
import { MAX_PHOTOS, checkPhoto, isAcceptedDataUrl } from "@/lib/photos";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

/**
 * Photos arrive already downscaled and re-encoded by the browser, which both
 * keeps the payload small and strips EXIF (including GPS) before it ever
 * reaches the server.
 */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  const bundle = bundleByToken(token);
  if (!bundle) return fail("This intake link is no longer valid.", 404);
  if (!allow(intakeKey(token, "photo"), LIMITS.photoUpload)) {
    return fail("You're going a little fast — give it a moment and try again.", 429);
  }
  if (bundle.intake.status === "ready_for_review" || bundle.intake.status === "reviewed") {
    return fail("This intake has been submitted — photos can no longer be changed.", 409);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("That photo didn't upload correctly. Please try again.", 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const dataUrl = typeof b.dataUrl === "string" ? b.dataUrl : "";
  const width = Number(b.width) || 0;
  const height = Number(b.height) || 0;
  const mime = typeof b.mime === "string" ? b.mime : "";
  const kind = b.kind === "wide" || b.kind === "close" ? b.kind : "unspecified";
  const caption = typeof b.caption === "string" ? b.caption.slice(0, 120) : "";
  const sharpness = typeof b.sharpness === "number" ? b.sharpness : undefined;

  if (!isAcceptedDataUrl(dataUrl)) {
    return fail("That file didn't look like a photo. Please try again.", 400);
  }
  const bytes = Math.round((dataUrl.length * 3) / 4);

  const check = checkPhoto({ mime, bytes, width, height, sharpness, existingCount: bundle.intake.photos.length });
  if (!check.ok) {
    track("intake_photo_rejected", { intake_id: bundle.intake.id, mime, bytes });
    return fail(check.error ?? "That photo couldn't be added.", 400);
  }

  const photo: Photo = {
    id: `pho_${Math.random().toString(36).slice(2, 12)}`,
    kind,
    mime,
    bytes,
    width,
    height,
    dataUrl,
    caption,
    advisories: check.advisories,
    at: new Date().toISOString(),
  };
  const saved = saveIntake({ ...bundle.intake, photos: [...bundle.intake.photos, photo].slice(0, MAX_PHOTOS) });
  track("intake_photo_uploaded", {
    intake_id: saved.id,
    kind,
    bytes,
    advisories: check.advisories.length,
    index: saved.photos.length,
  });
  return json(patientView({ ...bundle, intake: saved }));
}
