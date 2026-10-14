import { requireResourceAuth } from "@/server/api-v1/auth";
import { parseBody, v1 } from "@/server/api-v1/http";
import { PutStageRules } from "@/server/api-v1/schemas";
import { putStageRules } from "@/server/usecases/stage-rules";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Per-stage match-format override (design 2026-09-17 §T3) — Best-of-1 in the
 * league stage, Best-of-3 in the playoff of the same division. Every sport
 * (W2c Task 11): what a stage can set is the ENGINE's declaration for its kind
 * and variant (400 UNKNOWN_RULE_KEY / RULE_NOT_SETTABLE otherwise).
 *
 * The body is a FRAGMENT that MERGES into the stage's stored rules: a key it
 * omits is kept, a null VALUE removes that key ("inherit" is key ABSENCE — a
 * stored null would be copied over the division's value by the resolver's
 * overlay), `[]` is a value, and `{"rules": null}` or `{}` clears it all back to
 * the division's format.
 */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = await parseBody(req, PutStageRules);
    return putStageRules(auth, id, body);
  });
}
