import { listBundles } from "@/lib/store";
import { json, listRow } from "@/lib/api";
import { track } from "@/lib/analytics";

export async function GET() {
  const rows = listBundles().map(listRow);
  track("clinician_list_viewed", { count: rows.length });
  return json({ intakes: rows });
}
