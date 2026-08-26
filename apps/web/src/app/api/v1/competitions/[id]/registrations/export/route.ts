import { NextResponse } from "next/server";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { parseRegistrationListQuery } from "@/server/api-v1/registration-list-query";
import { exportRegistrationsCsv } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** CSV export of a competition's registrations — same filters as
 *  GET /competitions/{id}/registrations, parsed by the SAME parser so the two
 *  cannot drift apart on what they accept or reject. Raw text/csv — not the
 *  JSON envelope; errors still flow through v1() so 402/404 keep the standard
 *  shape (same pattern as the division export route). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const { divisionId, status, filters } = parseRegistrationListQuery(req.url, id);
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
