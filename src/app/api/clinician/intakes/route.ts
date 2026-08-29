import { store } from "@/lib/store";
import { listRow } from "@/lib/api";
import { handle, jsonOk } from "@/lib/http";
import { clinicianScope } from "@/lib/auth/scope";
import { track } from "@/lib/analytics";

/**
 * The clinician's list.
 *
 * In pilot mode the practice comes from the signed-in session and is passed to
 * the store, so another practice's intakes are never read — not read and then
 * filtered, which would leave the filtering as the only thing between two
 * practices' patients.
 */
export async function GET(req: Request) {
  return handle(req, "GET /api/clinician/intakes", async () => {
    const scope = await clinicianScope(req);
    const s = await store();
    const rows = (await s.listBundles(scope.practiceId)).map(listRow);
    track("clinician_list_viewed", { count: rows.length });
    return jsonOk({ intakes: rows });
  });
}
