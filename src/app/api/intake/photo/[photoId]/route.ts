import { handle } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { requireClinician, requirePilotMode } from "@/lib/auth/guard";
import { store, SqlStore } from "@/lib/store";
import { objectStore } from "@/lib/objects/select";
import { LIMITS } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ photoId: string }> };

/**
 * Photo bytes, for an authorized clinician only.
 *
 * This route exists so that no photograph is ever reachable by URL alone.
 * There is no public object URL and no pre-signed link: a pre-signed URL is a
 * bearer token for a picture of someone's skin — forwardable, cacheable, and
 * unrevokable — which is precisely the property the patient-token work removed.
 * Instead the server checks who is asking, then streams the bytes itself.
 *
 * Every read is audited, because "who looked at this photograph" is a question
 * a practice must be able to answer.
 */
export async function GET(req: Request, { params }: Params) {
  const { photoId } = await params;
  return handle(req, "GET /api/intake/photo/[photoId]", async ({ requestId }) => {
    requirePilotMode();
    const ctx = await requireClinician();
    if (!(await enforce(`photo:${ctx.practiceId}`, LIMITS.photoRead))) {
      throw new AppError("RATE_LIMITED", "photo read rate exceeded");
    }

    const s = (await store()) as SqlStore;
    const row = await s.photoForAccess(photoId);
    // A photo from another practice is indistinguishable from one that does
    // not exist. Anything else confirms the id is real to someone who should
    // not know that.
    if (!row || row.practiceId !== ctx.practiceId) {
      await audit({
        action: "authz.denied",
        actor: ctx.actor,
        resource: "photo",
        resourceId: photoId,
        requestId,
        meta: { reason: row ? "wrong_practice" : "not_found" },
      });
      throw new AppError("NOT_FOUND", "photo not visible to this practice");
    }

    const objects = await objectStore();
    const object = await objects.get(row.objectKey);
    if (!object) throw new AppError("NOT_FOUND", "object missing from storage");

    await audit({
      action: "photo.accessed",
      actor: ctx.actor,
      resource: "photo",
      resourceId: photoId,
      requestId,
      meta: { intake_id: row.intakeId, bytes: object.body.byteLength },
    });

    return new Response(new Uint8Array(object.body), {
      status: 200,
      headers: {
        "content-type": row.mime,
        "content-length": String(object.body.byteLength),
        // Never cached by a shared cache, and not written to disk by the
        // browser: a clinic machine should not accumulate patient photographs.
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
