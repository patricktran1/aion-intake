import { notFound } from "next/navigation";
import { bundleByToken, store } from "@/lib/store";
import { isPilot } from "@/lib/config/runtime";
import { patientView } from "@/lib/api";
import { IntakeApp } from "@/components/patient/IntakeApp";
import { VerifyGate } from "@/components/patient/VerifyGate";
import { secondFactorFor, type SecondFactorKind } from "@/lib/patient/second-factor";
import { pilotConfig } from "@/lib/config/runtime";

export const dynamic = "force-dynamic";

/**
 * The patient's screen.
 *
 * This page read the synchronous in-memory helper, which meant that in pilot
 * mode — where the memory store is empty — every patient's link rendered a 404.
 * The API routes had already been moved onto `store()`; the pages had not, so
 * the pilot had working endpoints and no working interface. Nothing caught it:
 * the tests exercise the store and the routes, and browser QA had only ever run
 * in demo mode.
 *
 * The second factor is also enforced here, not only in the API. Rendering the
 * interview before verification would hand over the patient's name, date of
 * birth and answers to anyone holding the link, leaving the factor guarding
 * writes alone — which is not what it is for.
 */
export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!isPilot()) {
    const bundle = bundleByToken(token);
    if (!bundle) notFound();
    return <IntakeApp initial={patientView(bundle)} />;
  }

  const s = await store();
  const resolved = await s.resolveToken(token);
  // Expired, revoked, locked and unknown all render the same 404. Telling the
  // holder of a dead link which kind of dead it is confirms the link was real.
  if (!resolved.ok) notFound();

  if (!resolved.access.verifiedAt) {
    const kind = (resolved.access.secondFactorKind || "dob") as SecondFactorKind;
    const known = (["dob", "code", "otp"] as const).includes(kind) ? kind : "dob";
    // Nothing about the patient crosses to the client here — only the question.
    return <VerifyGate token={token} challenge={secondFactorFor(known, pilotConfig().tokenPepper).challenge()} />;
  }

  const bundle = await s.bundleById(resolved.access.intakeId);
  if (!bundle) notFound();
  return <IntakeApp initial={patientView(bundle, { token })} />;
}
