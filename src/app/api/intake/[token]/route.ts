import { bundleByToken } from "@/lib/store";
import { fail, json, patientView } from "@/lib/api";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  const bundle = bundleByToken(token);
  if (!bundle) return fail("This intake link is no longer valid.", 404);
  track("intake_opened", { intake_id: bundle.intake.id, status: bundle.intake.status });
  return json(patientView(bundle));
}
