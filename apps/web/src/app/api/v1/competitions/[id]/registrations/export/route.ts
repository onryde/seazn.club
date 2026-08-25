import { NextResponse } from "next/server";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth, assertUuid } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { EntrantKind, RegistrationSort, RegistrationStatus } from "@/server/api-v1/schemas";
import { exportRegistrationsCsv, type ListRegistrationsFilters } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** "1"/"0" (this file's boolean-query convention, matching e.g. ?archived=1
 *  elsewhere in api-v1) → true/false; absent → undefined (no filter). */
function queryBool(raw: string | null, field: string): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new HttpError(400, `${field} must be 1 or 0`);
}

/** CSV export of a competition's registrations — same filters as
 *  GET /competitions/{id}/registrations (`exports` entitlement). Raw
 *  text/csv — not the JSON envelope; errors still flow through v1() so
 *  402/404 keep the standard shape (same pattern as the division export
 *  route). */
export async function GET(req: Request, { params }: Ctx) {
  try {
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

    const filters: ListRegistrationsFilters = {};
    if (kind) filters.kind = kind as ListRegistrationsFilters["kind"];
    const freeAgent = queryBool(sp.get("free_agent"), "free_agent");
    if (freeAgent !== undefined) filters.free_agent = freeAgent;
    const consentPending = queryBool(sp.get("consent_pending"), "consent_pending");
    if (consentPending !== undefined) filters.consent_pending = consentPending;
    const text = sp.get("q");
    if (text) filters.text = text;
    if (sort) filters.sort = sort as ListRegistrationsFilters["sort"];

    const csv = await exportRegistrationsCsv(auth, {
      competitionId: id,
      divisionId,
      status,
      filters,
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="registrations-${id}.csv"`,
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
