import { handle, jsonOk, readJson } from "@/lib/http";
import { patientView } from "@/lib/api";
import { requireVerifiedPatient } from "@/lib/patient/access";
import { store } from "@/lib/store";
import { LIMITS, intakeKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { MAX_UPLOAD_BYTES, checkPhoto, inspectDataUrl, isAcceptedDataUrl } from "@/lib/photos";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

/**
 * Photo upload.
 *
 * All validation runs on the actual bytes, never on what the client declares.
 * Persistence goes through the store: the demo keeps the data URL in the
 * document, the pilot writes the bytes to private object storage and the
 * metadata to the photos table. The route does not know or care which.
 */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "POST /api/intake/[token]/photos", async ({ requestId }) => {
    if (!(await enforce(intakeKey(token, "photo"), LIMITS.photoUpload))) {
      throw new AppError("RATE_LIMITED", "photo upload rate exceeded");
    }

    const access = await requireVerifiedPatient(token);

    // Bounded as the body arrives, not from content-length alone: a chunked
    // request declares no length, so the header check this replaced was
    // bypassable by anyone who bothered to send one. The ceiling allows the
    // base64 envelope around a MAX_UPLOAD_BYTES image.
    let body: unknown;
    try {
      body = await readJson(req, Math.round(MAX_UPLOAD_BYTES * 1.5));
    } catch (err) {
      if (err instanceof AppError && err.code === "PAYLOAD_TOO_LARGE") {
        throw new AppError("PHOTO_TOO_LARGE", err.detail);
      }
      throw new AppError("PHOTO_INVALID", "unparseable photo body");
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const dataUrl = typeof b.dataUrl === "string" ? b.dataUrl : "";
    const mime = typeof b.mime === "string" ? b.mime : "";
    const kind = b.kind === "wide" || b.kind === "close" ? b.kind : "unspecified";
    const caption = typeof b.caption === "string" ? b.caption.slice(0, 120) : "";
    const sharpness = typeof b.sharpness === "number" ? b.sharpness : undefined;
    // A client-supplied idempotency key lets a retried upload converge to one
    // photo rather than duplicating on a flaky connection.
    const idempotencyKey =
      typeof b.idempotencyKey === "string" ? b.idempotencyKey.slice(0, 100) : null;

    if (!isAcceptedDataUrl(dataUrl)) throw new AppError("PHOTO_INVALID", "not an accepted data url");
    const bytes = Math.round((dataUrl.length * 3) / 4);

    // The client DECLARES mime/width/height; a hostile client declares anything.
    const inspected = inspectDataUrl(dataUrl);
    if (!inspected) {
      track("intake_photo_rejected", { intake_id: access.intakeId, mime, bytes, reason: "not_an_image" });
      throw new AppError("PHOTO_INVALID", "byte inspection found no image");
    }
    if (inspected.hasExif) {
      track("intake_photo_rejected", { intake_id: access.intakeId, mime, bytes, reason: "exif_present" });
      throw new AppError("PHOTO_INVALID", "exif present");
    }

    const s = await store();
    const existing = await s.bundleById(access.intakeId);
    if (!existing) throw new AppError("NOT_FOUND", "intake not found");

    const check = checkPhoto({
      mime: inspected.mime,
      bytes,
      width: inspected.width,
      height: inspected.height,
      sharpness,
      existingCount: existing.intake.photos.length,
    });
    if (!check.ok) {
      track("intake_photo_rejected", { intake_id: access.intakeId, mime, bytes });
      throw new AppError("PHOTO_INVALID", check.error ?? "photo rejected");
    }

    const result = await s.attachPhoto(access.intakeId, access.practiceId, {
      dataUrl,
      mime: inspected.mime,
      bytes,
      width: inspected.width,
      height: inspected.height,
      kind,
      caption,
      advisories: check.advisories,
      idempotencyKey,
    });

    if (!result.ok) {
      if (result.reason === "frozen") throw new AppError("INTAKE_COMPLETE", "photo after submission");
      throw new AppError("PHOTO_LIMIT_REACHED", "photo cap reached");
    }

    await audit({
      action: "photo.uploaded",
      actor: access.actor,
      practiceId: access.practiceId,
      resource: "intake",
      resourceId: access.intakeId,
      requestId,
      meta: { kind, bytes, advisories: check.advisories.length },
    });
    track("intake_photo_uploaded", { intake_id: access.intakeId, kind, bytes, advisories: check.advisories.length });
    return jsonOk(patientView(result.bundle, { token }));
  });
}
