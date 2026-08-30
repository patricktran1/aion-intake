import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { requireVerifiedPatient } from "@/lib/patient/access";
import { store } from "@/lib/store";

type Params = { params: Promise<{ token: string; photoId: string }> };

/**
 * A patient removing their own photo before submitting. Frozen intakes ignore
 * the removal — the photos are part of the record under review — and return
 * the unchanged bundle rather than erroring, so a stale tab is harmless.
 */
export async function DELETE(req: Request, { params }: Params) {
  const { token, photoId } = await params;
  return handle(req, "DELETE /api/intake/[token]/photos/[photoId]", async () => {
    const access = await requireVerifiedPatient(token);
    const s = await store();
    const bundle = await s.removePhoto(access.intakeId, photoId);
    return jsonOk(patientView(bundle));
  });
}
