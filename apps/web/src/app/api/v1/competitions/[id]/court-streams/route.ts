import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateCourtStream, type CourtStream } from "@/server/api-v1/schemas";
import { linkCourtStream, listCourtStreams, type CourtStreamShown } from "@/server/usecases/court-streams";

type Ctx = { params: Promise<{ id: string }> };

// The QR's tok is live: every answer is private, no-store (as the fixture's stream-code).
const NO_STORE = { "Cache-Control": "private, no-store", Pragma: "no-cache" };

function wire(s: CourtStreamShown): CourtStream {
  return {
    id: s.id,
    court_id: s.courtId,
    court_name: s.courtName,
    day: s.day,
    expires_at: s.expiresAt.toISOString(),
    target: s.target,
    qr: s.qr,
  };
}

/** Link a court to a connected YouTube channel for a day (court stream §5.1): editor session only. 201 with the court's QR. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    const body = await parseBody(req, CreateCourtStream);
    const shown = await linkCourtStream(auth, id, { courtId: body.court_id, targetId: body.target_id, day: body.day });
    return reply(201, wire(shown), NO_STORE);
  });
}

/** The competition's live court links, each with its QR (editor session only). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return reply(200, (await listCourtStreams(auth, id)).map(wire), NO_STORE);
  });
}
