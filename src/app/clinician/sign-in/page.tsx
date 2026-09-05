import { notFound } from "next/navigation";
import { isPilot } from "@/lib/config/runtime";
import { SignInForm } from "@/components/clinician/SignInForm";

export const dynamic = "force-dynamic";

/**
 * Clinician sign-in.
 *
 * Pilot mode had a login endpoint and no screen to reach it from, so a
 * dermatologist could not sign in through a browser at all. The demo has no
 * accounts, so this page does not exist there — a sign-in form on the public
 * demo would invite people to try passwords against something that has none.
 */
export default function SignInPage() {
  if (!isPilot()) notFound();
  return <SignInForm />;
}
