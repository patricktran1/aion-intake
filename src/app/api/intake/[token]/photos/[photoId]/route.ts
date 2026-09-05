import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { requireVerifiedPatient } from "@/lib/patient/access";
import { store, SqlStore } from "@/lib/store";
import { objectStore } from "@/lib/objects/select";
import { isPilot } from "@/lib/config/runtime";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ token: string; photoId: string }> };

/**
 * Serve one of the patient's own uploaded photos back to them.
 *
 * The review screen shows what they added so they can check it before
 * submitting. In pilot the bytes live in private object storage, so this route
 * fetches and streams them — but only for a verified patient whose token
 * resolves to the intake that owns the photo. In demo the photo is an inline
 * data URL and this route is never hit.
 */
export async function GET(req: Request, { params }: Params) {
  const { token, photoId } = await params;
  return handle(req, "GET /api/intake/[token]/photos/[photoId]", async ({ requestId }) => {
    const access = await requireVerifiedPatient(token);
    if (!isPilot()) throw new AppError("NOT_FOUND", "photo bytes are inline in demo mode");

    const s = (await store()) as SqlStore;
    const photo = await s.photoForAccess(photoId);
    // The photo must belong to THIS patient's intake. Anything else is
    // indistinguishable from a photo that does not exist.
    if (!photo || photo.intakeId !== access.intakeId) {
      throw new AppError("NOT_FOUND", "photo not on this intake");
    }

    const objects = await objectStore();
    const object = await objects.get(photo.objectKey);
    if (!object) throw new AppError("NOT_FOUND", "object missing from storage");

    await audit({
      action: "photo.accessed",
      actor: access.actor,
      practiceId: access.practiceId,
      resource: "photo",
      resourceId: photoId,
      requestId,
      meta: { by: "patient" },
    });

    return new Response(new Uint8Array(object.body), {
      status: 200,
      headers: {
        "content-type": photo.mime,
        "content-length": String(object.body.byteLength),
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  });
}

/**
 * A patient removing their own photo before submitting. Frozen intakes ignore
 * the removal — the photos are part of the record under review — and return
 * the unchanged bundle rather than erroring, so a stale tab is harmless.
 */
export async function DELETE(req: Request, { params }: Params) {
  const { token, photoId } = await params;
  return handle(req, "DELETE /api/intake/[token]/photos/[photoId]", async ({ requestId }) => {
    const access = await requireVerifiedPatient(token);
    const s = await store();
    const { bundle, removed } = await s.removePhoto(access.intakeId, photoId);
    // Only a deletion that happened is audited. This route used to write
    // photo.deleted unconditionally, so an unknown photo id, another intake's
    // photo id, or a frozen record all produced an audit event for a deletion
    // that never occurred — and a patient could write as many of them as they
    // liked. An audit trail carrying invented events is worse than one with
    // gaps: nothing in it can be relied on afterwards.
    if (removed) {
      await audit({
        action: "photo.deleted",
        actor: access.actor,
        practiceId: access.practiceId,
        resource: "photo",
        resourceId: photoId,
        requestId,
        meta: { by: "patient" },
      });
    }
    return jsonOk(patientView(bundle, { token }));
  });
}
