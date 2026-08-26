import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { parseRegistrationListQuery } from "@/server/api-v1/registration-list-query";
import { listRegistrations } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Cross-division organiser registration list — the Registrants tab's read
 * model (RS005 W1b), competition-scoped. Division-scoped filtering stays on
 * GET /divisions/{id}/registrations (unchanged call shape, RS005 W1a's own
 * doc comment on listRegistrations); this is the whole-competition twin,
 * reusing that SAME read model rather than a second query (RS005 prompt
 * gotcha: "a second SQL path here WILL drift"). The query string is parsed by
 * the shared parser this route and the CSV export both call, for the same
 * reason.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const { divisionId, status, filters } = parseRegistrationListQuery(req.url, id);
    return listRegistrations(auth, divisionId, status, filters);
  });
}
