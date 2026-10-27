// `queueStaffAlert`, the one writer every staff alert goes through (phase 3 wave 5, T2; spec §10, plan P-W5-1, P-W5-2, P-W5-3 / Q1).
// A staff alert has no org and no account: it is written on the pool, to `STAFF_ALERT_EMAIL`, once per incident (its once-key IS its
// ref, so two incidents of one kind about one id never replace each other), and the worker sends it after the first-attempt window.
// It never throws (Q1): an alert that cannot be queued is logged and sent to Sentry as an issue, without the address, the key or the
// body, and dropped, so the money action it reports goes on.
//
// Driven through the REAL writer, the real enqueue, the real seal and the real replace trigger. Stand-ins: the outbox's transport (the
// one network seam; a staff alert must not reach it in the request) and Sentry's `captureError` (observed). Expected values come from
// the spec (the expiry bound, the facts) and from the test's own render, never from the writer's answer. Sport: not applicable (no
// staff alert names a sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The outbox's one network seam. The rows, the seal and the trigger are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));
// Sentry's issue capture, observed: a dropped alert must open an issue (a `log.error` alone reaches Sentry Logs only).
const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sentry")>()),
  captureError: sentry.captureError,
}));

import { sql } from "@/lib/db";
import type { EmailContent } from "@/lib/email";
import { OutboxDedupeKeyError } from "@/server/email-outbox";
import { LOGGER_OPTIONS, log } from "@/server/logger";
import { stubOutboxEnv } from "./_invite-mail";
import { STAFF_ALERT_QUEUE_FAILED, queueStaffAlert } from "../staff-alert";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `sa-${randomUUID().slice(0, 8)}`;

/** Spec "Expiry" (phase-3 design, "24 h less a 7-minute margin"): a row may live at most this long, and a staff alert has no deadline
 *  of its own, so it gets the whole bound. Typed from the spec, not imported from the code under test. */
const SPEC_MAX_EXPIRY_MS = 24 * 3_600_000 - 7 * 60_000;

/** This test's own staff address: one per test, so no test counts another's rows. */
const staffAddress = (tag: string): string => `staff-${RUN}-${tag}@x.test`;
/** What the test's render returns: the mock's own value, which the row must carry. */
const content = (tag: string): EmailContent => ({ subject: `[Seazn staff] ${RUN} ${tag}`, html: `<p>${RUN} ${tag}</p>`, text: `${RUN} ${tag}` });

type Row = {
  id: string; kind: string; ref_type: string; ref_id: string; dedupe_key: string | null; org_id: string | null; recipient: string;
  recipient_user_id: string | null; transactional: boolean; status: string; attempts: number; subject: string; expires_at: Date;
  sealed: boolean;
};
const ROW_COLUMNS = sql`
  id, kind, ref_type, ref_id, dedupe_key, org_id, recipient, recipient_user_id, transactional, status, attempts, subject, expires_at,
  body_sealed is not null as sealed`;
/** The rows queued to an address, oldest first. */
const rowsTo = (address: string) =>
  sql<Row[]>`select ${ROW_COLUMNS} from email_outbox where lower(recipient) = lower(${address}) order by created_at, id`;
/** The rows of a kind whose ref starts with `prefix`, to ANY recipient (the unset case writes to no address at all). */
const rowsOfRef = (kind: string, prefix: string) =>
  sql<Row[]>`select ${ROW_COLUMNS} from email_outbox where kind = ${kind} and ref_id like ${`${prefix}%`} order by created_at, id`;

/** What a `log.error` call would put on the line: the logger's OWN `err` serializer (the one that strips Postgres's echo fields),
 *  then the rest of the fields, then the message. */
function loggedLine(args: unknown[]): string {
  const [fields, ...rest] = args as [Record<string, unknown>, ...unknown[]];
  const err = fields.err === undefined ? undefined : LOGGER_OPTIONS.serializers.err(fields.err);
  return JSON.stringify([{ ...fields, err }, ...rest]);
}

/** The drops a `log.error` spy saw: `null` answers unset, a replay and a drop alike, and only this line tells a drop apart. */
const drops = (errors: { mock: { calls: unknown[][] } }): unknown[][] => errors.mock.calls.filter((c) => c[1] === STAFF_ALERT_QUEUE_FAILED);

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  sentry.captureError.mockReset();
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where lower(recipient) like ${`staff-${RUN}-%`}`;
});

describe.skipIf(!HAS_DB)("queueStaffAlert: one writer for staff alerts (DB)", () => {
  it("unset: no row, no render, no statement", async () => {
    // Unset is the normal case outside production (dev, CI, a preview): silent, like every staff alert before it. Blank counts as unset.
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const ref = `evt_${RUN}_unset`;
    let checked = 0;
    for (const value of ["", "   ", undefined]) {
      vi.stubEnv("STAFF_ALERT_EMAIL", value);
      const render = vi.fn(async () => content("unset"));
      const result = await queueStaffAlert({ kind: "staff_stuck_events", refType: "stripe_event", id: ref, suffix: "parked", render });
      expect(result, `STAFF_ALERT_EMAIL=${JSON.stringify(value)}`).toBeNull();
      expect(render, `STAFF_ALERT_EMAIL=${JSON.stringify(value)}: render must not run`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked, "anti-vacuity: unset, empty and blank were each driven").toBe(3);
    expect(await rowsOfRef("staff_stuck_events", ref), "no row, to any recipient").toHaveLength(0);
    expect(errors, "an unset address is not an error").not.toHaveBeenCalled();
    expect(sentry.captureError, "nor a Sentry issue").not.toHaveBeenCalled();
    expect(transport.deliver).not.toHaveBeenCalled();
  });

  it("one alert: one queued staff row, no org, no account, transactional, for the worker", async () => {
    const address = staffAddress("one");
    vi.stubEnv("STAFF_ALERT_EMAIL", address);
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const id = `evt_${RUN}`;
    const mail = content("one");

    const before = Date.now();
    const result = await queueStaffAlert({ kind: "staff_stuck_events", refType: "stripe_event", id, suffix: "parked", render: async () => mail });
    const after = Date.now();

    const rows = await rowsTo(address);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(result, "the writer answers the id of the row it wrote").toBe(row.id);
    expect(row).toMatchObject({
      kind: "staff_stuck_events",
      ref_type: "stripe_event",
      // P-W5-1: the ref IS the once-key, so this incident and another about the same event never share a ref.
      ref_id: `${id}:parked`,
      dedupe_key: `${id}:parked`,
      org_id: null,
      recipient_user_id: null,
      recipient: address,
      transactional: true,
      status: "queued",
      attempts: 0,
      subject: mail.subject,
      sealed: true,
    });
    // No deadline of its own: the spec's whole bound, within a minute of the call.
    const expires = row.expires_at.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + SPEC_MAX_EXPIRY_MS - 60_000);
    expect(expires).toBeLessThanOrEqual(after + SPEC_MAX_EXPIRY_MS + 60_000);
    // W: no first attempt in the request; the worker sends it after the window.
    expect(transport.deliver).not.toHaveBeenCalled();
    expect(drops(errors), "nothing was dropped").toHaveLength(0);
    expect(sentry.captureError).not.toHaveBeenCalled();
  });

  it("the same incident twice: one row, and the second call returns null", async () => {
    const address = staffAddress("twice");
    vi.stubEnv("STAFF_ALERT_EMAIL", address);
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const alert = () =>
      queueStaffAlert({ kind: "staff_stuck_events", refType: "stripe_event", id: `evt_${RUN}_twice`, suffix: "parked", render: async () => content("twice") });

    const first = await alert();
    const second = await alert();

    expect(first, "the first call queued a row").toEqual(expect.any(String));
    expect(second, "the replayed incident queued nothing").toBeNull();
    const rows = await rowsTo(address);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, status: "queued", ref_id: `evt_${RUN}_twice:parked` });
    // The second `null` is the once-key's answer, not a swallowed failure (a conflict that threw and was caught would read the same).
    expect(drops(errors), "the replay was deduplicated, not dropped").toHaveLength(0);
    expect(sentry.captureError).not.toHaveBeenCalled();
  });

  it("P-W5-1: two incidents of one kind and one id, different suffixes, both stay queued and neither is replaced", async () => {
    // A partial refund, then the full refund of the same charge: one recipient (every staff alert has the same one) and no org, so a
    // shared ref would let the replace trigger supersede the first while it waits for the worker.
    const address = staffAddress("p1");
    vi.stubEnv("STAFF_ALERT_EMAIL", address);
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const charge = `ch_${RUN}`;
    const clawback = (suffix: string) =>
      queueStaffAlert({ kind: "staff_stream_credit_clawback", refType: "charge", id: charge, suffix, render: async () => content(suffix) });

    const partial = await clawback("partial:500");
    const short = await clawback("short");

    expect(partial).toEqual(expect.any(String));
    expect(short).toEqual(expect.any(String));
    const rows = await rowsTo(address);
    expect(rows.map((r) => [r.id, r.ref_id, r.status])).toEqual([
      [partial, `${charge}:partial:500`, "queued"],
      [short, `${charge}:short`, "queued"],
    ]);
    expect(rows.filter((r) => r.status === "replaced"), "neither incident replaced the other").toHaveLength(0);
    expect(drops(errors), "nothing was dropped").toHaveLength(0);
    expect(sentry.captureError).not.toHaveBeenCalled();
  });

  it("Q1: a render that throws, a missing id, or a refused insert resolves null, logs the kind, opens a Sentry issue, and writes nothing", async () => {
    const address = staffAddress("q1");
    vi.stubEnv("STAFF_ALERT_EMAIL", address);
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);

    // The builder fails after the key is made: the money action it reports must still go on.
    const session = `cs_${RUN}`;
    const thrown = queueStaffAlert({
      kind: "staff_credit_pack_grant_failed",
      refType: "checkout_session",
      id: session,
      render: async () => {
        throw new Error("the alert builder failed");
      },
    });
    await expect(thrown, "a failed render is dropped, not thrown").resolves.toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]![0]).toMatchObject({ kind: "staff_credit_pack_grant_failed", refType: "checkout_session" });

    // No id (onceKey refuses): a key without its id would be one key for the whole kind, silencing every later alert of it.
    const render = vi.fn(async () => content("q1"));
    const missing = queueStaffAlert({ kind: "staff_connect_bank_changed", refType: "stripe_event", id: undefined, render });
    await expect(missing, "a missing id is dropped, not thrown").resolves.toBeNull();
    expect(render, "the refusal comes before the render").not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls[1]![0]).toMatchObject({ kind: "staff_connect_bank_changed", refType: "stripe_event" });
    expect((errors.mock.calls[1]![0] as { err: unknown }).err, "the refusal is onceKey's, by name").toBeInstanceOf(OutboxDedupeKeyError);

    // The statement itself fails, after the render (C4: a failing SQL statement, the simplest real one: the table refuses a blank ref
    // type). Postgres echoes the WHOLE failing row in the error's `detail`, address and subject included, so this is the line most
    // likely to leak them.
    const refused = `cs_${RUN}_sql`;
    const sqlFailed = queueStaffAlert({ kind: "staff_pass_unknown_competition", refType: "", id: refused, render: async () => content("q1") });
    await expect(sqlFailed, "a refused insert is dropped, not thrown").resolves.toBeNull();
    expect(errors).toHaveBeenCalledTimes(3);
    expect(errors.mock.calls[2]![0]).toMatchObject({ kind: "staff_pass_unknown_competition", refType: "", err: { code: "23514" } });
    expect(
      String((errors.mock.calls[2]![0] as { err: { detail?: unknown } }).err.detail),
      "premise: the raw error echoes the address, so a clean line below is the logger's doing, not an empty error",
    ).toContain(address);

    // The line carries the kind and the ref type, never the address, the key (its id) or the body.
    let lines = 0;
    for (const call of errors.mock.calls) {
      const line = loggedLine(call);
      expect(line).not.toContain(address);
      expect(line).not.toContain(session);
      expect(line).not.toContain(refused);
      expect(line).not.toContain(content("q1").subject);
      lines++;
    }
    expect(lines, "anti-vacuity: all three log lines were read").toBe(3);
    expect(drops(errors), "every line is the one drop message").toHaveLength(3);

    // One Sentry ISSUE per drop (a `log.error` reaches Sentry Logs only, and pages nobody), carrying the same error and exactly the
    // kind and ref type: no address, no key, no body.
    const failures = [
      { kind: "staff_credit_pack_grant_failed", refType: "checkout_session" },
      { kind: "staff_connect_bank_changed", refType: "stripe_event" },
      { kind: "staff_pass_unknown_competition", refType: "" },
    ];
    expect(sentry.captureError).toHaveBeenCalledTimes(failures.length);
    failures.forEach((extra, i) => {
      const [err, context] = sentry.captureError.mock.calls[i]!;
      expect(err, `failure ${i}: the error that was logged`).toBe((errors.mock.calls[i]![0] as { err: unknown }).err);
      expect(context, `failure ${i}: the route and exactly the kind and ref type`).toEqual({ route: "staff-alert", extra });
    });
    expect(await rowsTo(address), "nothing was written").toHaveLength(0);
    expect(await rowsOfRef("staff_credit_pack_grant_failed", session), "no row for the session, to any recipient").toHaveLength(0);
    expect(transport.deliver).not.toHaveBeenCalled();
  });
});
