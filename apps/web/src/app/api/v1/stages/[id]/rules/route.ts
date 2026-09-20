import { requireResourceAuth } from "@/server/api-v1/auth";
import { parseBody, v1 } from "@/server/api-v1/http";
import { PutStageRules } from "@/server/api-v1/schemas";
import { putStageRules } from "@/server/usecases/stage-rules";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Per-stage match-format override (design 2026-09-17 §T3) — Best-of-1 in the
 * league stage, Best-of-3 in the playoff of the same division. Sets-based
 * sports only (tennis, badminton, tabletennis, volleyball).
 *
 * A WHOLE-FRAGMENT replace: what you send is what the stage carries, and
 * `{"rules": null}` clears it back to the division's format. "Inherit" is key
 * ABSENCE — a null VALUE inside `rules` is stripped rather than stored, since
 * the resolver's overlay would otherwise copy it over the division's value.
 */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = await parseBody(req, PutStageRules);
    return putStageRules(auth, id, body);
  });
}
