import { getDictionary } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireFixtureActor, requireResourceAuth } from "@/server/api-v1/auth";
import { PutFixtureRules } from "@/server/api-v1/schemas";
import { writeFixtureRulesOverride } from "@/server/usecases/fixture-rules";
import { getFixtureRules } from "@/server/usecases/fixtures";

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

/**
 * W2c Task 15 (X-SR-7, owner P-1 "A") — the rules the match plays by NOW: what an open scoring pad reloads after a
 * correction refused its tap (409 FIXTURE_RULES_CHANGED) or an answer told it the version moved. The cfg its fold uses,
 * the version its next tap must send, and the format line in the READER's language (the locale the pad's own page
 * resolves: cookie, account, then the proxy's Accept-Language). Organiser or the match's device link, as
 * GET /fixtures/{id}/state — the scorer's pad is the reader.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireFixtureActor(req, id, "read");
    return getFixtureRules(auth, id, await getDictionary(await resolveLocale(), "public"));
  });
}
