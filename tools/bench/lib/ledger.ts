// The tap driver's eyes. Everything else in tools/bench posts events and
// trusts the array index as the seq; a driver that taps a real pad cannot do
// that, because the pad decides when a held tap is sent and the server assigns
// the seq. So the driver has to ASK what was actually recorded.
//
// Two reads, both pinned against the live routes rather than against a
// remembered shape:
//   GET /api/v1/fixtures/{id}/events?since_seq=N
//     `events/route.ts` reads exactly `since_seq` and 400s anything that is
//     not a non-negative integer. The usecase (`listEvents`) selects
//     `seq > sinceSeq` ordered by seq, so N is EXCLUSIVE — pass the last seq
//     already seen, not the next one wanted.
//   GET /api/v1/fixtures/{id}/state
//     `reply(200, state)` over `FixtureStateOut`, whose fields here are
//     `status` and `last_seq`. The route's ETag is a digest of that whole
//     body (`fixtureStateEtag`), not of `last_seq`: a status change with no
//     new event is a new ETag.
// Both arrive inside the v1 envelope (`{ ok, data, requestId }`).
import { raw, type RawResult, type Session } from "./http.ts";

// ---------------------------------------------------------------------------
// Transport — the same narrow, injected, defaulted-to-the-real-thing shape
// every other file in this directory uses (`oracle.ts`'s `OracleTransport`,
// `simulate.ts`'s `SimTransport`): `raw()` only, so a refusal can be read back
// as a real status + body rather than thrown away by `request()`.
// ---------------------------------------------------------------------------
export interface LedgerTransport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

export const defaultLedgerTransport: LedgerTransport = { raw };

/** The v1 error envelope this file actually reads — same local-type convention
 *  `oracle.ts`/`simulate.ts`/`import.ts` each declare rather than importing
 *  anything out of `apps/web`. */
interface V1ErrorEnvelope {
  ok?: boolean;
  error?: { code?: string; message?: string };
}

/**
 * Any non-200 is fatal, and that is the whole point of this helper.
 *
 * A refusal carries no `data`, so a tolerant parser turns it into an empty
 * ledger / a fixture "at seq 0" — and the driver would then report that the
 * scorer's taps recorded NOTHING, which reads as a data defect when it is
 * really a broken call. A renamed query parameter is exactly how that arrives:
 * `since_seq` under any other spelling defaults to "0" and an unparseable one
 * 400s. Fail loudly at the seam instead, naming the path.
 */
function dataOrThrow(result: RawResult, path: string, label: string): unknown {
  if (result.status !== 200) {
    const body = result.json as unknown as V1ErrorEnvelope;
    const err = body?.ok === false ? body.error : undefined;
    throw new Error(
      `ledger: ${label} refused for ${path} — HTTP ${result.status} ` +
        `${err?.code ?? "(no code)"} — ${err?.message ?? "(no message)"}`,
    );
  }
  // A 200 that carried no `data` is an unrecognised shape, and it has to be
  // just as loud as a refusal. Falling through would hand the driver an empty
  // ledger — which reads downstream as "the scorer's taps recorded nothing",
  // a data defect pointing at entirely the wrong place. Same shape and same
  // message as the sibling `dataOf` (`oracle.ts:83-89`).
  const data = (result.json as unknown as { data?: unknown })?.data;
  if (data === undefined || data === null) {
    throw new Error(`ledger: ${label} response for ${path} carried no data`);
  }
  return data;
}

export interface LedgerRow {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

function rowsOf(data: unknown, sinceSeq: number, path: string, label: string): readonly LedgerRow[] {
  if (!Array.isArray(data)) {
    // Threaded from the caller rather than hardcoded (Minors row 5 /
    // task-1-re-review.md §2) — `dataOrThrow`, one call up, already takes a
    // `label`; hardcoding "fixture events" here was asymmetric and would go
    // stale silently if this helper were ever reused for a differently-
    // labelled read.
    throw new Error(`ledger: ${label} response for ${path} was not a list of rows (got ${typeof data})`);
  }
  const rows: LedgerRow[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.seq !== "number" || typeof r.type !== "string") continue;
    // `since_seq` is EXCLUSIVE — `listEvents` selects `seq > ${sinceSeq}`
    // (`fixtures.ts:503`). Enforced here rather than merely documented,
    // because the driver spends this contract as "exactly one new row per
    // tap": a row AT the anchor drifting through would surface there as a
    // phantom extra event, blamed on the pad rather than on the read.
    if (r.seq <= sinceSeq) continue;
    // Deliberate, not drift (Minors row 6 / task-1-re-review.md §3): this is
    // the one TOLERANT branch in a module whose whole thesis is that an
    // unrecognised shape must be loud. A row at-or-before the anchor should
    // never come back at all given `since_seq` is exclusive server-side, so
    // seeing one here is itself a sign of drift — but dropping it silently
    // is what keeps the driver's "exactly one new row per tap" contract
    // correct downstream; throwing here would turn a single stray boundary
    // row into an outage for every caller, for a case the boundary test
    // below already guards against reappearing.
    // Narrowed rather than `String(r.id ?? "")`: `r.id` is `unknown` here, and
    // coercing an object id would mint the literal string "[object Object]"
    // and hand it to the driver as a real event id (@typescript-eslint/
    // no-base-to-string flags exactly this).
    rows.push({
      id: typeof r.id === "string" ? r.id : "",
      seq: r.seq,
      type: r.type,
      payload: r.payload,
    });
  }
  // The route's order is not part of its contract; the driver compares position
  // by position, so sort rather than trust it.
  return rows.sort((a, b) => a.seq - b.seq);
}

/** Rows recorded AFTER `sinceSeq` (exclusive), in seq order. */
export async function fetchFixtureLedger(
  base: string,
  session: Session,
  fixtureId: string,
  sinceSeq: number,
  transport: LedgerTransport = defaultLedgerTransport,
): Promise<readonly LedgerRow[]> {
  const path = `/api/v1/fixtures/${fixtureId}/events?since_seq=${sinceSeq}`;
  const result = await transport.raw(base, session, path, "GET");
  return rowsOf(dataOrThrow(result, path, "fixture events"), sinceSeq, path, "fixture events");
}

/**
 * The fixture's status and the server's own ledger tip.
 *
 * `lastSeq` is what the NEXT ledger read should be anchored on, and what an
 * append's `expected_seq` is measured against — the driver must never derive
 * it by counting its own taps, because a held tap the pad has not sent yet is
 * a tap the server has not seq'd.
 */
export async function fetchFixtureStatus(
  base: string,
  session: Session,
  fixtureId: string,
  transport: LedgerTransport = defaultLedgerTransport,
): Promise<{ status: string; lastSeq: number }> {
  const path = `/api/v1/fixtures/${fixtureId}/state`;
  const result = await transport.raw(base, session, path, "GET");
  const raw = dataOrThrow(result, path, "fixture state");
  // Status-side twin of `rowsOf`'s "was not a list of rows" throw (Minors
  // row 4 / task-1-re-review.md §1): without this, a primitive or an array
  // `data` cast straight to `Record<string, unknown>` and read back as
  // `{status:"(absent)", lastSeq:-1}` — the SAME output an unrecognised-but-
  // object-shaped state produces, hiding a genuinely broken envelope behind
  // a merely-unusual one.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `ledger: fixture state response for ${path} was not an object (got ${Array.isArray(raw) ? "array" : typeof raw})`,
    );
  }
  const data = raw as Record<string, unknown>;
  // `(absent)` rather than a plausible-looking default: an unrecognised state
  // shape has to READ as unrecognised downstream (oracle.ts's own convention),
  // never as a fixture that merely hasn't started.
  //
  // `lastSeq` used to fall back to a plausible `0` here — the one line in this
  // function with a philosophy different from its sibling `status` (Minors
  // row 2 / task-1-review.md M4). `0` IS the correct value for a genuinely
  // unscored fixture (the server always sends `last_seq: 0` for one,
  // `fixtures.ts:551`), so it cannot be reused as the "absent" sentinel too —
  // `-1` never a real seq (rows start at 1), and is loud downstream: fed back
  // as `since_seq=-1` on the next ledger read, it 400s at the route rather
  // than silently anchoring the driver on a wrong tip.
  return {
    status: typeof data.status === "string" ? data.status : "(absent)",
    lastSeq: typeof data.last_seq === "number" ? data.last_seq : -1,
  };
}
