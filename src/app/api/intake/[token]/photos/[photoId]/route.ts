import { bundleByToken, saveIntake } from "@/lib/store";
import { fail, json, patientView } from "@/lib/api";

type Params = { params: Promise<{ token: string; photoId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const { token, photoId } = await params;
  const bundle = bundleByToken(token);
  if (!bundle) return fail("This intake link is no longer valid.", 404);
  if (bundle.intake.status === "ready_for_review" || bundle.intake.status === "reviewed") {
    return fail("This intake has been submitted — photos can no longer be changed.", 409);
  }
  const saved = saveIntake({
    ...bundle.intake,
    photos: bundle.intake.photos.filter((p) => p.id !== photoId),
  });
  return json(patientView({ ...bundle, intake: saved }));
}
