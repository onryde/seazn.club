// The tap driver's eyes. Everything else in scripts/bench posts events and
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
//     `status` and `last_seq` (the same `last_seq` the route's ETag is built
//     from).
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

function rowsOf(data: unknown, sinceSeq: number, path: string): readonly LedgerRow[] {
  if (!Array.isArray(data)) {
    throw new Error(
      `ledger: fixture events response for ${path} was not a list of rows (got ${typeof data})`,
    );
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
  return rowsOf(dataOrThrow(result, path, "fixture events"), sinceSeq, path);
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
  const data = dataOrThrow(result, path, "fixture state") as Record<string, unknown>;
  // `(absent)` rather than a plausible-looking default: an unrecognised state
  // shape has to READ as unrecognised downstream (oracle.ts's own convention),
  // never as a fixture that merely hasn't started.
  return {
    status: typeof data.status === "string" ? data.status : "(absent)",
    lastSeq: typeof data.last_seq === "number" ? data.last_seq : 0,
  };
}
