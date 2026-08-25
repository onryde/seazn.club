import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth, assertUuid } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { EntrantKind, RegistrationSort, RegistrationStatus } from "@/server/api-v1/schemas";
import { listRegistrations, type ListRegistrationsFilters } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** "1"/"0" (this file's boolean-query convention, matching e.g. ?archived=1
 *  elsewhere in api-v1) → true/false; absent → undefined (no filter). */
export function queryBool(raw: string | null, field: string): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new HttpError(400, `${field} must be 1 or 0`);
}

/**
 * Cross-division organiser registration list — the Registrants tab's read
 * model (RS005 W1b), competition-scoped. Division-scoped filtering stays on
 * GET /divisions/{id}/registrations (unchanged call shape, RS005 W1a's own
 * doc comment on listRegistrations); this is the whole-competition twin,
 * reusing that SAME read model rather than a second query (RS005 prompt
 * gotcha: "a second SQL path here WILL drift").
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const sp = new URL(req.url).searchParams;

    const status = sp.get("status");
    if (status !== null && !(RegistrationStatus.options as readonly string[]).includes(status)) {
      throw new HttpError(400, `status must be one of ${RegistrationStatus.options.join(", ")}`);
    }
    const divisionId = sp.get("division_id");
    if (divisionId !== null) assertUuid(divisionId, "division");
    const kind = sp.get("kind");
    if (kind !== null && !(EntrantKind.options as readonly string[]).includes(kind)) {
      throw new HttpError(400, `kind must be one of ${EntrantKind.options.join(", ")}`);
    }
    const sort = sp.get("sort");
    if (sort !== null && !(RegistrationSort.options as readonly string[]).includes(sort)) {
      throw new HttpError(400, `sort must be one of ${RegistrationSort.options.join(", ")}`);
    }

    const filters: ListRegistrationsFilters = { competition_id: id };
    if (kind) filters.kind = kind as ListRegistrationsFilters["kind"];
    const freeAgent = queryBool(sp.get("free_agent"), "free_agent");
    if (freeAgent !== undefined) filters.free_agent = freeAgent;
    const consentPending = queryBool(sp.get("consent_pending"), "consent_pending");
    if (consentPending !== undefined) filters.consent_pending = consentPending;
    const text = sp.get("q");
    if (text) filters.text = text;
    if (sort) filters.sort = sort as ListRegistrationsFilters["sort"];

    return listRegistrations(auth, divisionId, status, filters);
  });
}
