import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateMatchDayCode, type MatchDayCode, type MatchDayCodeScope } from "@/server/api-v1/schemas";
import {
  listMatchDayCodes,
  mintMatchDayCode,
  type MatchDayCodeRow,
  type MatchDayScope,
} from "@/server/usecases/match-day-codes";

type Ctx = { params: Promise<{ id: string }> };

/** The wire's scope (snake_case ids) as the use-case takes it, and back. */
function scopeIn(s: MatchDayCodeScope): MatchDayScope {
  if (s.kind === "venue") return { kind: "venue", venueId: s.venue_id };
  if (s.kind === "courts") return { kind: "courts", courtIds: s.court_ids };
  return { kind: "competition" };
}
function scopeOut(s: MatchDayScope): MatchDayCodeScope {
  if (s.kind === "venue") return { kind: "venue", venue_id: s.venueId };
  if (s.kind === "courts") return { kind: "courts", court_ids: s.courtIds };
  return { kind: "competition" };
}
function wire(row: MatchDayCodeRow, url: string | null): MatchDayCode {
  return {
    id: row.id,
    url,
    scope: scopeOut(row.scope),
    day: row.day,
    opens_at: row.opensAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    can_approve: row.canApprove,
  };
}

/**
 * Mint a Match Day code (capture S4 design §3, §9 item 1): editor session only — never an API key, a device link or a
 * Match Day code. 201 with the code and its URL, the QR's payload. 503 DEVICE_LINK_KEK_MISSING when the server has no key.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    const body = await parseBody(req, CreateMatchDayCode);
    const { row, url } = await mintMatchDayCode(auth, id, { scope: scopeIn(body.scope), day: body.day, canApprove: body.can_approve });
    return reply(201, wire(row, url));
  });
}

/** The competition's codes that can still open — live and not yet open — each with its URL, so the desk can show the
 *  same QR again (null for a code whose sealed copy will not open: listed, so it can still be withdrawn). Editor session
 *  only. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    const codes = await listMatchDayCodes(auth, id);
    return codes.map((c) => wire(c, c.url));
  });
}
