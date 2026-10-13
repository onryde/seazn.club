import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutFixtureRules } from "@/server/api-v1/schemas";
import { writeFixtureRulesOverride } from "@/server/usecases/fixture-rules";

type Ctx = { params: Promise<{ id: string }> };

/**
 * W2c (X-SR-2, X-SR-5) — one match's own format, and the live correction of a started match's format (owner Q11).
 * A WHOLE-FRAGMENT replace through the one writer (`usecases/fixture-rules.ts`): what you send is the match's format
 * over its stage's, `{"rules": null}` (or `{}`, or all-null values) sets it back to the stage's. Organiser auth, as
 * PATCH /fixtures/{id} — a device link never reaches it.
 */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PutFixtureRules);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return writeFixtureRulesOverride(auth, [id], body.rules);
  });
}
