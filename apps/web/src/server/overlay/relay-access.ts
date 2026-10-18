// R2005 change 1 — the overlay's RELAY access: the second door into a fixture's overlay, for the compositor.
//
// A composed stream session can carry a fixture that is NOT public (a private competition), and the public gate would
// 404 the compositor's page there — the stream would go out with no score bug, an inert seam nobody sees until it is
// live. So the composed session's `overlayUrl` (`sessionFactsForJob`, R2004) carries `sid` + `st`, and both present
// open this door when ALL of these hold:
//
//  - `st` verifies as a `relay-page` token FOR `sid` (`verifyRelayToken`: signature, audience, expiry, sid, scope);
//  - the session row exists and is on THIS fixture;
//  - the session is `composed` (a passthrough session has no compositor to render the page);
//  - the session is not terminal (`!isTerminal(state)`, the domain's own rule — so `ending`, the compositor's final
//    hold, still opens it: a CEF reload during the hold must load, and fallback B must still deliver `final`).
//
// Every refusal is the same `null`, and every caller turns it into the same opaque answer it gives a missing fixture —
// a verifier that said which check failed would be an oracle. A MISCONFIGURATION (no signing key) is not a refusal and
// is not swallowed: it throws, so a config outage reads as an outage rather than as "every page 404s".
import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isProgrammePhase, type ProgrammePhaseWire } from "@/lib/relay-phase";
import { isTerminal, type Mode, type SessionState } from "@/server/relay/domain/session";
import { verifyRelayToken } from "@/server/relay/tokens";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RelayParams {
  sid: string;
  st: string;
}

export interface RelayPageAccess extends RelayParams {
  /** The programme phase the compositor last put on its heartbeat (fallback B, spec §4.3). ABSENT when the stored beat
   *  carries none — never defaulted — and when what it carries is not a declared phase. */
  programmePhase?: ProgrammePhaseWire;
}

/** `sid` and `st` as the page and the route read them: both present, each ONE non-empty string. Anything else (one of
 *  them, a repeated parameter, an empty value) is no relay request at all, and the caller takes the public path. */
export function relayParamsOf(q: { sid?: unknown; st?: unknown }): RelayParams | null {
  const { sid, st } = q;
  if (typeof sid !== "string" || typeof st !== "string" || sid === "" || st === "") return null;
  return { sid, st };
}

/** The relay door for `fixtureId`, or null. Uncached on purpose: it is one indexed row read per page load and per
 *  poll, and a cached grant would outlive the session it was read from. */
export async function relayPageAccess(fixtureId: string, params: RelayParams): Promise<RelayPageAccess | null> {
  if (!UUID.test(fixtureId) || !UUID.test(params.sid)) return null;
  try {
    await verifyRelayToken(params.st, { sid: params.sid, scope: "relay-page" });
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
  const [row] = await sql<{ fixture_id: string; mode: Mode; state: SessionState; programme_phase: string | null }[]>`
    select fixture_id, mode, state, last_heartbeat->>'programmePhase' as programme_phase
    from fixture_stream_sessions where id = ${params.sid}`;
  if (!row) return null;
  if (row.fixture_id !== fixtureId) return null;
  if (row.mode !== "composed") return null;
  if (isTerminal(row.state)) return null;
  return {
    sid: params.sid,
    st: params.st,
    ...(isProgrammePhase(row.programme_phase) ? { programmePhase: row.programme_phase } : {}),
  };
}
