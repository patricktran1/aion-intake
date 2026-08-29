import { bundleByToken, saveIntake } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import type { Photo } from "@/lib/domain/types";
import { fail, json, patientView } from "@/lib/api";
import { LIMITS, allow, intakeKey } from "@/lib/ratelimit";
import { MAX_PHOTOS, MAX_UPLOAD_BYTES, checkPhoto, inspectDataUrl, isAcceptedDataUrl } from "@/lib/photos";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

/**
 * Photos arrive already downscaled and re-encoded by the browser, which both
 * keeps the payload small and strips EXIF (including GPS) before it ever
 * reaches the server.
 */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  const found = bundleByToken(token);
  if (!found) return fail("This intake link is no longer valid.", 404);
  if (!allow(intakeKey(token, "photo"), LIMITS.photoUpload)) {
    return fail("You're going a little fast — give it a moment and try again.", 429);
  }

  // Reject an obviously oversized request before buffering/parsing its body.
  // Data-URL overhead is ~4/3, plus JSON envelope — anything past ~9MB cannot
  // contain a photo we would accept.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES * 1.5) {
    return fail("That photo is too large to upload. Try taking it again at a normal size.", 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("That photo didn't upload correctly. Please try again.", 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const dataUrl = typeof b.dataUrl === "string" ? b.dataUrl : "";
  // The client's declared mime is kept only to record WHAT was rejected when a
  // photo fails inspection; every gate below runs on the actual bytes, and the
  // declared width/height are ignored entirely.
  const mime = typeof b.mime === "string" ? b.mime : "";
  const kind = b.kind === "wide" || b.kind === "close" ? b.kind : "unspecified";
  const caption = typeof b.caption === "string" ? b.caption.slice(0, 120) : "";
  const sharpness = typeof b.sharpness === "number" ? b.sharpness : undefined;

  if (!isAcceptedDataUrl(dataUrl)) {
    return fail("That file didn't look like a photo. Please try again.", 400);
  }
  const bytes = Math.round((dataUrl.length * 3) / 4);

  // The lock covers the count check through the save: two simultaneous uploads
  // must not both read "2 photos" and leave the intake holding four.
  return withIntakeLock(found.intake.id, async () => {
    const bundle = bundleByToken(token);
    if (!bundle) return fail("This intake link is no longer valid.", 404);
    if (bundle.intake.status === "ready_for_review" || bundle.intake.status === "reviewed") {
      return fail("This intake has been submitted — photos can no longer be changed.", 409);
    }

    // The client DECLARES mime/width/height; a hostile client can declare
    // anything. Every gate below runs on what the actual bytes say instead.
    const inspected = inspectDataUrl(dataUrl);
    if (!inspected) {
      track("intake_photo_rejected", { intake_id: bundle.intake.id, mime, bytes, reason: "not_an_image" });
      return fail("That file didn't look like a photo. Please try again.", 400);
    }
    if (inspected.hasExif) {
      // The product's privacy claim is that photo metadata (incl. GPS) is
      // stripped before upload. The real client re-encodes through a canvas and
      // never produces EXIF, so an EXIF-bearing JPEG is a bypass attempt — and
      // accepting it would store location data we promised not to hold.
      track("intake_photo_rejected", { intake_id: bundle.intake.id, mime, bytes, reason: "exif_present" });
      return fail("That photo couldn't be added. Please retake it with your camera and try again.", 400);
    }

    const check = checkPhoto({
      mime: inspected.mime,
      bytes,
      width: inspected.width,
      height: inspected.height,
      sharpness,
      existingCount: bundle.intake.photos.length,
    });
    if (!check.ok) {
      track("intake_photo_rejected", { intake_id: bundle.intake.id, mime, bytes });
      return fail(check.error ?? "That photo couldn't be added.", 400);
    }

    const photo: Photo = {
      id: `pho_${Math.random().toString(36).slice(2, 12)}`,
      kind,
      mime: inspected.mime,
      bytes,
      width: inspected.width,
      height: inspected.height,
      dataUrl,
      caption,
      advisories: check.advisories,
      at: new Date().toISOString(),
    };
    const saved = saveIntake({
      ...bundle.intake,
      photos: [...bundle.intake.photos, photo].slice(0, MAX_PHOTOS),
    });
    track("intake_photo_uploaded", {
      intake_id: saved.id,
      kind,
      bytes,
      advisories: check.advisories.length,
      index: saved.photos.length,
    });
    return json(patientView({ ...bundle, intake: saved }));
  });
}
