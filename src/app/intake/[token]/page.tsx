import { notFound } from "next/navigation";
import { bundleByToken } from "@/lib/store";
import { patientView } from "@/lib/api";
import { IntakeApp } from "@/components/patient/IntakeApp";

export const dynamic = "force-dynamic";

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bundle = bundleByToken(token);
  if (!bundle) notFound();
  return <IntakeApp initial={patientView(bundle)} />;
}
