// The kind harness (phase 3 wave 1, T7): walks OUTBOX_KINDS and drives each kind that has moved to the outbox through its REAL producer,
// then judges the rows it left and what reached the transport against the SPEC's table of kinds, never against the code's own
// declaration (`OUTBOX_KIND_FACTS` is checked against the same table by enqueue-once.test.ts; this is the producer-level half of that
// one-directional guard: the writer refuses a literal kind with an account id, and this harness refuses the rest).
//
// A file that uses it installs the one network seam itself, `vi.mock("@/server/email-outbox/transport", ...)`, and the harness reads the
// calls back from that same mock (it imports `deliver` from the same module). It refuses to run against the real transport.
//
// Nothing here knows what a kind's email says: the subject it expects is read from the `emails` dictionary on disk, in the locale the
// scenario declares, so a producer that drops the locale, or a dictionary key that moves, is seen.
import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import type { Locale } from "@/lib/i18n-constants";
import { FIRST_ATTEMPT_WINDOW_MS, OUTBOX_KINDS, idempotencyKey, type OutboxKind } from "../constants";
import { dispatchNow } from "../attempt";
import { deliver } from "../transport";
import { runOutboxTick } from "../worker";

/** How long the harness waits for a request-path kind's own first attempt to finish. The request owns a never-attempted row for
 *  exactly `FIRST_ATTEMPT_WINDOW_MS` (the worker leaves it alone until then: constants.ts, M2), which is the longest a correct
 *  `dispatchNow` can still be working on it (budget + the one request in flight + the write transaction); the slack is the
 *  poll and the database round trip. Derived from the engine's own constant, never a number typed here that the day the
 *  budget moves would fail a correct producer (or wait less than a correct one needs). */
export const REQUEST_ATTEMPT_WAIT_MS = FIRST_ATTEMPT_WINDOW_MS + 5_000;

/** One kind's way into the outbox. `run` drives the real producer (a route, a usecase, a sweep); everything else is what the spec says
 *  the result must be. */
export type KindScenario = {
  /** The language the mail must be rendered in. */
  locale: Locale;
  /** A key of the `emails` dictionary (`src/dictionaries/<locale>/emails.json`) holding the subject. */
  subjectKey: string;
  /** The `{name}` values of that subject. */
  subjectVars: Record<string, string>;
  /** The run-unique address this scenario mails; the harness finds the kind's rows by it (case-insensitively). */
  recipient: string;
  /** Who makes the first attempt: the request that wrote the row (`dispatchNow`), or the retry worker (the row must wait for it). */
  firstAttempt: "request" | "worker";
  run: () => Promise<void>;
};

/** The spec's legend per kind: [to, transactional]. `account` (A) = an account, resolved at send; `literal` (L) = a literal address;
 *  `staff` (S) = the staff address. Typed from the spec by the caller, never taken from constants.ts. */
export type KindFacts = Readonly<Record<OutboxKind, readonly ["account" | "literal" | "staff", boolean]>>;

/** Age rows past the first-attempt window so the retry worker may take them (it leaves a never-attempted row to its request until
 *  then; worker.test.ts's pattern, on the database's clock). */
export async function bornAgo(ids: readonly string[], secs: number = FIRST_ATTEMPT_WINDOW_MS / 1000 + 60): Promise<void> {
  await sql`update email_outbox set created_at = now() - make_interval(secs => ${secs}) where id = any(${ids as string[]}::uuid[])`;
}

const dictionaries = new Map<Locale, Record<string, string>>();
const dictionaryOf = (locale: Locale): Record<string, string> => {
  let d = dictionaries.get(locale);
  if (d === undefined) {
    d = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries", locale, "emails.json"), "utf8")) as Record<string, string>;
    dictionaries.set(locale, d);
  }
  return d;
};

/** The subject a locale's dictionary gives a key, `{name}` tokens filled exactly as a translator writes them. Throws on a missing key
 *  and on a token no value was given for (the sentence would go out with a brace in it). */
export function dictionarySubject(locale: Locale, key: string, vars: Record<string, string>): string {
  const template = dictionaryOf(locale)[key];
  if (typeof template !== "string") throw new Error(`dictionarySubject: no key ${JSON.stringify(key)} in dictionaries/${locale}/emails.json`);
  const filled = Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), template);
  const left = /\{\w+\}/.exec(filled);
  if (left) throw new Error(`dictionarySubject: ${locale} ${key} still has ${left[0]} after the given values`);
  return filled;
}

type Sent = { to: string; subject: string; idempotencyKey: string };

/** Everything the transport double was called with, in order. */
function transportCalls(): Sent[] {
  if (!vi.isMockFunction(deliver)) {
    throw new Error(
      "kind harness: the outbox transport (@/server/email-outbox/transport) is not a mock; install vi.mock(...) for it in the importing test file",
    );
  }
  return deliver.mock.calls.map((c) => c[0] as Sent);
}

type RowRec = {
  id: string;
  recipient: string;
  recipient_user_id: string | null;
  transactional: boolean;
  status: string;
  attempts: number;
  subject: string;
  last_error: string | null;
  cleared: boolean;
};

/** The columns both reads judge. A function, not a constant: a `sql` fragment built at import time opens the client, and a file that
 *  imports this module without a database (the transport-guard test) must still load. */
const columns = () => sql`id, recipient, recipient_user_id, transactional, status, attempts, subject, last_error, body_sealed is null as cleared`;

const rowsOfKind = (kind: OutboxKind, recipient: string) =>
  sql<RowRec[]>`select ${columns()} from email_outbox where kind = ${kind} and lower(recipient) = lower(${recipient}) order by created_at, id`;
const rowsById = (ids: readonly string[]) =>
  sql<RowRec[]>`select ${columns()} from email_outbox where id = any(${ids as string[]}::uuid[]) order by created_at, id`;

const fail = (kind: OutboxKind, message: string): never => {
  throw new Error(`outbox kind ${kind}: ${message}`);
};

/**
 * The second call. The rows are `sent`; both ways a second send could start are tried and must change nothing:
 *
 *  - the request path again: `dispatchNow(ids)` (a first-attempt claim of a row that is no longer queued);
 *  - the worker again: one tick, after the rows are made to LOOK due (`next_attempt_at` in the past). A `sent` row is never due,
 *    so a tick over rows that merely sit there proves nothing; this one hands the claim every reason to take them, and a claim
 *    that ignored `status` (or the first-attempt guard of `dispatchNow`) would take them.
 *
 * A row that was claimed again changes (`attempts + 1`, even if the attempt then fails for want of a body), so the check is on the
 * rows as well as on the transport: no new call under these keys, and every row's status, attempts, last error and cleared body as
 * they were. Exported for the harness's own test, which gives it rows that ARE due so that it can be seen to fail.
 */
export async function assertNothingMoreToSend(kind: OutboxKind, ids: readonly string[]): Promise<void> {
  const keys = new Set(ids.map(idempotencyKey));
  const callsOf = (): number => transportCalls().filter((c) => keys.has(c.idempotencyKey)).length;
  const settled = (rows: RowRec[]) => rows.map((r) => ({ id: r.id, status: r.status, attempts: r.attempts, last_error: r.last_error, cleared: r.cleared }));

  const rowsBefore = settled(await rowsById(ids));
  const callsBefore = callsOf();

  await dispatchNow(ids);
  await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = any(${ids as string[]}::uuid[])`;
  await runOutboxTick({ onlyIds: ids as string[], sleep: async () => undefined });

  const callsAfter = callsOf();
  if (callsAfter !== callsBefore) fail(kind, `a second call sent ${callsAfter - callsBefore} more time(s)`);
  const rowsAfter = settled(await rowsById(ids));
  if (JSON.stringify(rowsAfter) !== JSON.stringify(rowsBefore)) {
    fail(kind, `a second call changed the rows: ${JSON.stringify(rowsBefore)} -> ${JSON.stringify(rowsAfter)}`);
  }
}

/**
 * Sweep every kind in `OUTBOX_KINDS` that is not listed in `opts.notYetMoved`, each through its scenario's real producer.
 *
 * Checked up front, before any scenario runs: every kind is either listed as not yet moved or has a scenario (`no scenario for outbox
 * kind <k>`), a kind is not both (a stale list entry would silently skip a sweep that now exists), the list names only kinds, and
 * the legend has an entry for every kind that will be swept.
 *
 * Then, per kind: run the producer; find its rows by kind and recipient (at least one); judge each row against the legend (its
 * `transactional` flag, and `recipient_user_id` non-null exactly when the kind is an account's); see the first attempt through
 * (`request`: wait for the rows to leave `queued`/`sending`; `worker`: they must still be `queued` with no attempt, then one tick
 * sends them); require every row `sent` with its body gone; the transport reached exactly once per row under `email-outbox/<id>`,
 * addressed to the recipient, with the subject the dictionary gives in the scenario's locale; and a second call (`dispatchNow` again, and a
 * tick over rows made to look due) that sends nothing and changes no row.
 *
 * Returns how many kinds were swept and which. Zero is the CALLER's failure to refuse: a harness that swept nothing proves nothing.
 *
 * `requestWaitMs` is for the harness's own test of its wait; a real sweep leaves it at `REQUEST_ATTEMPT_WAIT_MS`.
 */
export async function forEachOutboxKind(
  scenarios: Partial<Record<OutboxKind, KindScenario>>,
  opts: { notYetMoved: readonly OutboxKind[]; specFacts: KindFacts; requestWaitMs?: number },
): Promise<{ checked: number; kinds: OutboxKind[] }> {
  transportCalls(); // refuses a real transport before anything runs

  const unmoved = new Set<string>();
  for (const k of opts.notYetMoved) {
    if (!(OUTBOX_KINDS as readonly string[]).includes(k)) throw new Error(`kind harness: notYetMoved names ${JSON.stringify(k)}, which is not an outbox kind`);
    unmoved.add(k);
  }
  for (const k of Object.keys(scenarios)) {
    if (!(OUTBOX_KINDS as readonly string[]).includes(k)) throw new Error(`kind harness: a scenario is given for ${JSON.stringify(k)}, which is not an outbox kind`);
  }
  for (const k of OUTBOX_KINDS) {
    if (unmoved.has(k)) {
      if (scenarios[k]) fail(k, "it has a scenario but is listed in notYetMoved; remove it from the list so it is swept");
      continue;
    }
    if (!scenarios[k]) throw new Error(`no scenario for outbox kind ${k}`);
    if (!opts.specFacts[k]) throw new Error(`no spec fact for outbox kind ${k}`);
  }

  const kinds: OutboxKind[] = [];
  for (const k of OUTBOX_KINDS) {
    if (unmoved.has(k)) continue;
    const s = scenarios[k]!;
    const [to, transactional] = opts.specFacts[k];

    await s.run();

    // The rows the producer left, and what the spec says they are.
    const written = await rowsOfKind(k, s.recipient);
    if (written.length === 0) fail(k, "no outbox row for the scenario's recipient after the producer ran");
    for (const r of written) {
      if (r.transactional !== transactional) {
        fail(k, `row ${r.id} has transactional=${r.transactional}, the spec's legend says ${transactional}`);
      }
      if ((r.recipient_user_id !== null) !== (to === "account")) {
        fail(k, `row ${r.id} ${r.recipient_user_id === null ? "names no account" : "names an account"} (recipient_user_id), the spec's legend says this kind is "${to}"`);
      }
    }
    const ids = written.map((r) => r.id);

    // The first attempt.
    if (s.firstAttempt === "request") {
      try {
        await vi.waitFor(
          async () => {
            const [open] = await sql<{ n: number }[]>`
              select count(*)::int as n from email_outbox where id = any(${ids}::uuid[]) and status in ('queued', 'sending')`;
            if (open!.n > 0) throw new Error(`${open!.n} row(s) still queued or sending`);
          },
          { timeout: opts.requestWaitMs ?? REQUEST_ATTEMPT_WAIT_MS, interval: 50 },
        );
      } catch (err) {
        fail(k, `the request's own attempt did not finish: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const waiting = written.filter((r) => r.status !== "queued" || r.attempts !== 0);
      if (waiting.length > 0) {
        fail(k, `firstAttempt is "worker" but ${waiting.map((r) => `row ${r.id} is ${r.status} with ${r.attempts} attempt(s)`).join(", ")}; the row must wait queued for the worker`);
      }
      await bornAgo(ids);
      await runOutboxTick({ onlyIds: ids, sleep: async () => undefined });
    }

    // The outcome, row by row.
    const expectedSubject = dictionarySubject(s.locale, s.subjectKey, s.subjectVars);
    for (const r of await rowsById(ids)) {
      if (r.status !== "sent") fail(k, `row ${r.id} ended ${r.status} (last_error ${JSON.stringify(r.last_error)}), expected sent`);
      if (!r.cleared) fail(k, `row ${r.id} is sent but still holds its sealed body`);
      if (r.subject !== expectedSubject) {
        fail(k, `row ${r.id} was queued with subject ${JSON.stringify(r.subject)}, the ${s.locale} dictionary's ${s.subjectKey} is ${JSON.stringify(expectedSubject)}`);
      }
      const calls = transportCalls().filter((c) => c.idempotencyKey === idempotencyKey(r.id));
      if (calls.length !== 1) fail(k, `row ${r.id} reached the transport ${calls.length} times, expected exactly once`);
      const call = calls[0]!;
      if (call.subject !== expectedSubject) {
        fail(k, `row ${r.id} was sent with subject ${JSON.stringify(call.subject)}, the ${s.locale} dictionary's ${s.subjectKey} is ${JSON.stringify(expectedSubject)}`);
      }
      if (call.to.toLowerCase() !== s.recipient.toLowerCase()) fail(k, `row ${r.id} was sent to another address than the scenario's recipient`);
    }

    // The second call: nothing is left to send.
    await assertNothingMoreToSend(k, ids);

    kinds.push(k);
  }
  return { checked: kinds.length, kinds };
}
