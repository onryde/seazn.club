// POST /api/funnel/start queues the claim link on the email outbox (phase 3 wave 3, kind `funnel_claim`). The draft and the row that
// carries its token are one transaction on the pool (a visitor has no account and no organisation), the row's ref is the draft, and the
// first attempt is made in the request, after commit: the visitor waits for the link.
//
// Driven through the REAL route, the real draft writer, the real enqueue and the real dispatch. Stand-ins: the outbox's transport (the
// one network seam: captured, never sent), the limiter, and `next/headers`. Expected values come from the dictionary on disk
// (`dictionarySubject`) and from the draft's own row (`funnel_drafts`), never from the route's answer.
//
// Another sport: the claim's body names the sport the visitor chose (the one wave-3 body that does), so two sports are driven.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.41" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
// The outbox's one network seam. The rows, the claim and the render are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { LOCALES } from "@/lib/i18n-constants";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { POST as start } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `fc-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://funnel.test";

type Delivered = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
type ClaimRow = {
  id: string; kind: string; ref_type: string; ref_id: string; org_id: string | null; recipient: string;
  recipient_user_id: string | null; transactional: boolean; subject: string; status: string; cleared: boolean;
};

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;
const competition = (): string => `Spring Open ${randomUUID().slice(0, 6)}`;

/** What the route answers a start with (`handler`'s envelope, unwrapped). */
type Started = { message?: string; reference?: string; replaceKey?: string; claim_url?: string };
/** The visitor's start, as the /start page posts it (with the browser's cookie header, when one is given). */
async function post(body: Record<string, unknown>, cookie?: string): Promise<{ status: number; data: Started }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
  const res = await start(new Request(`${ORIGIN}/api/funnel/start`, { method: "POST", headers, body: JSON.stringify(body) }));
  const json = (await res.json()) as { data?: Started };
  return { status: res.status, data: json.data ?? {} };
}
/** The reference shape, from the owner's rule (0-9 and A-Z less 0, O, 1, I; six of them), never from the code. */
const RULE_SHAPE = new RegExp(`^SZ-[${[..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((c) => !"0O1I".includes(c)).join("")}]{6}$`);
const startFor = (email: string, name: string, sport = "Badminton") => post({ email, name, sport, entrants: 8 });

/** The drafts written for an address, oldest first. */
const draftsOf = (email: string) =>
  sql<{ id: string; token: string; reference: string; replaced: boolean }[]>`
    select id, token, reference, replaced_at is not null as replaced from funnel_drafts where email = ${email} order by created_at, id`;
/** The claim rows queued for an address, oldest first. */
const claimRows = (email: string) =>
  sql<ClaimRow[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, transactional, subject, status, body_sealed is null as cleared
      from email_outbox where kind = 'funnel_claim' and lower(recipient) = lower(${email})
     order by created_at, id`;
/** What the transport was handed under this row's own key. */
const callsFor = (rowId: string): Delivered[] =>
  transport.deliver.mock.calls.map((c) => c[0] as Delivered).filter((m) => m.idempotencyKey === `email-outbox/${rowId}`);

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB) return;
  const like = `${RUN}-%`;
  await sql`delete from email_outbox where kind = 'funnel_claim' and lower(recipient) like ${like}`;
  await sql`delete from funnel_drafts where email like ${like}`;
});

describe.skipIf(!HAS_DB)("POST /api/funnel/start queues the claim link on the outbox (DB)", () => {
  it("a start queues one claim email and sends it in the request", async () => {
    const email = address();
    const name = competition();

    expect((await startFor(email, name)).status).toBe(200);

    const drafts = await draftsOf(email);
    expect(drafts, "one draft").toHaveLength(1);
    const rows = await claimRows(email);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Sent before the response: the request made the first attempt, so nothing is left queued when it answers.
    expect(row).toMatchObject({
      kind: "funnel_claim",
      ref_type: "funnel_draft",
      ref_id: drafts[0]!.id,
      org_id: null,
      recipient: email,
      recipient_user_id: null,
      transactional: true,
      status: "sent",
      cleared: true,
    });
    expect(row.subject).toBe(dictionarySubject("en", "funnelClaim.subject", { competitionName: name }));
    const calls = callsFor(row.id);
    expect(calls, "one transport call, under the row's own key").toHaveLength(1);
    expect(calls[0]!.to).toBe(email);
    expect(calls[0]!.text, "the mail carries the draft's own token, on the claim page").toContain(`/start/claim?token=${drafts[0]!.token}`);
  });

  it("another sport: the claim names the sport the visitor chose", async () => {
    // The sport is in the body's sentence (`funnelClaim.body`), not in the plain-text line, so the HTML is what is read.
    const sports = ["Badminton", "Chess"] as const;
    const sentence = (sport: string) => dictionarySubject("en", "funnelClaim.body", { sport });
    const html: Record<string, string> = {};
    for (const sport of sports) {
      const email = address();
      expect((await startFor(email, competition(), sport)).status).toBe(200);
      const [row] = await claimRows(email);
      const calls = callsFor(row!.id);
      expect(calls, `${sport}: one transport call`).toHaveLength(1);
      html[sport] = calls[0]!.html;
    }
    expect(html.Badminton).toContain(sentence("Badminton"));
    expect(html.Badminton).not.toContain(sentence("Chess"));
    expect(html.Chess).toContain(sentence("Chess"));
    expect(html.Chess).not.toContain(sentence("Badminton"));
    expect(Object.keys(html), "anti-vacuity: both sports were driven").toHaveLength(sports.length);
  });

  it("the language the visitor chose (the seazn_locale cookie) is the claim's; a cookie naming no shipped language keeps English", async () => {
    // D4's explicit pick is the footer switcher's cookie, as on the public register route. There is no account and no organisation to
    // follow, so a cookie that names no shipped language ends at `en` (test 1 is the no-cookie case).
    // `stored` is what the draft remembers for its +24h reminder (Q3): the visitor's pick, or nothing when there was none.
    const cases = [
      { cookie: "seazn_locale=fr", locale: "fr", stored: "fr" },
      { cookie: "seazn_locale=de", locale: "en", stored: null },
    ] as const;
    let checked = 0;
    for (const c of cases) {
      const email = address();
      const name = competition();
      expect((await post({ email, name, sport: "Badminton", entrants: 8 }, c.cookie)).status, c.cookie).toBe(200);
      const [row] = await claimRows(email);
      expect(row!.subject, c.cookie).toBe(dictionarySubject(c.locale, "funnelClaim.subject", { competitionName: name }));
      expect(callsFor(row!.id).map((m) => m.subject), `${c.cookie}: the mail sent is the row's`).toEqual([row!.subject]);
      const [draft] = await sql<{ locale: string | null }[]>`select locale from funnel_drafts where email = ${email}`;
      expect(draft!.locale, `${c.cookie}: the draft remembers the same pick`).toBe(c.stored);
      checked++;
    }
    expect(checked, "anti-vacuity: every cookie was driven").toBe(cases.length);
    // The French case can tell the two apart only while the dictionaries differ.
    expect(dictionarySubject("fr", "funnelClaim.subject", { competitionName: "x" })).not.toBe(
      dictionarySubject("en", "funnelClaim.subject", { competitionName: "x" }),
    );
  });

  it("the language the /start page was shown in (its posted locale) is the claim's; an unsupported one falls back", async () => {
    // A visitor who reached /fr/start, or whose page language came from Accept-Language, never set the cookie: the page posts the locale
    // it rendered in, and that outranks the cookie. A value naming no shipped language is ignored, so the cookie, then `en`, applies.
    // `stored` is what the draft remembers for its +24h reminder (Q3): the same pick the claim used, or nothing when it fell to `en`.
    const cases = [
      { locale: "fr", cookie: undefined, expected: "fr", stored: "fr" },
      { locale: "nl", cookie: "seazn_locale=es", expected: "nl", stored: "nl" },
      { locale: "de", cookie: undefined, expected: "en", stored: null },
      { locale: "de", cookie: "seazn_locale=es", expected: "es", stored: "es" },
    ] as const;
    let checked = 0;
    for (const c of cases) {
      const label = `${c.locale} with ${c.cookie ?? "no cookie"}`;
      const email = address();
      const name = competition();
      expect((await post({ email, name, sport: "Badminton", entrants: 8, locale: c.locale }, c.cookie)).status, label).toBe(200);
      const [row] = await claimRows(email);
      expect(row!.subject, label).toBe(dictionarySubject(c.expected, "funnelClaim.subject", { competitionName: name }));
      // The claim re-reads the draft strictly (`funnelPayloadSchema`), so the page language must not be written into it.
      const [draft] = await sql<{ payload: Record<string, unknown>; locale: string | null }[]>`
        select payload, locale from funnel_drafts where email = ${email}`;
      expect(draft!.payload, `${label}: the draft stays claimable`).not.toHaveProperty("locale");
      expect(draft!.locale, `${label}: the draft remembers the claim's language for its reminder`).toBe(c.stored);
      checked++;
    }
    expect(checked, "anti-vacuity: every case was driven").toBe(cases.length);
    // Each case can tell its language from the fallback only while the dictionaries differ.
    const subjects = new Set(LOCALES.map((l) => dictionarySubject(l, "funnelClaim.subject", { competitionName: "x" })));
    expect(subjects.size, "premise: every shipped language has its own subject").toBe(LOCALES.length);
  });

  it("a second start for the address replaces the first: one live draft, two emails, ONE reference — printed in both, returned by both", async () => {
    // /start "Sent stepper" T1 (owner, 2026-11-14): the visitor went back and sent the wizard again. Each start still emails its own
    // link (the newest is the one that works), the first draft is retired, and the reference — the code the visitor can quote —
    // is the same in both answers and both emails. Every start is counted (funnel_draft_created fires per POST, in the other file).
    const email = address();
    const first = await startFor(email, competition());
    const second = await startFor(email, competition());
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.data.reference, "the answer carries the reference").toMatch(RULE_SHAPE);
    expect(second.data.reference, "the resubmit keeps it").toBe(first.data.reference);
    expect(second.data.replaceKey, "each start answers its own replace key").not.toBe(first.data.replaceKey);

    const drafts = await draftsOf(email);
    expect(drafts.map((d) => [d.reference, d.replaced]), "the first is replaced, the second is live").toEqual([
      [first.data.reference, true],
      [first.data.reference, false],
    ]);
    const rows = await claimRows(email);
    expect(rows.map((r) => [r.ref_id, r.status]), "two emails, one per draft, both sent").toEqual(drafts.map((d) => [d.id, "sent"]));
    let checked = 0;
    for (const [i, row] of rows.entries()) {
      const mail = callsFor(row.id)[0]!;
      expect(mail.text, `row ${i} carries its own draft's token`).toContain(`/start/claim?token=${drafts[i]!.token}`);
      const line = dictionarySubject("en", "funnelClaim.reference", { reference: first.data.reference! });
      expect(mail.text, `row ${i}: the plain text prints the reference`).toContain(line);
      expect(mail.html, `row ${i}: so does the HTML`).toContain(line);
      checked++;
    }
    expect(checked, "anti-vacuity: both emails read").toBe(2);
  });

  it("the reference line is the visitor's language in every shipped locale", async () => {
    let checked = 0;
    const lines = new Set<string>();
    for (const locale of LOCALES) {
      const email = address();
      const got = await post({ email, name: competition(), sport: "Badminton", entrants: 8, locale });
      expect(got.status, locale).toBe(200);
      const [row] = await claimRows(email);
      const mail = callsFor(row!.id)[0]!;
      const line = dictionarySubject(locale, "funnelClaim.reference", { reference: got.data.reference! });
      expect(mail.text, `${locale}: plain text`).toContain(line);
      expect(mail.html, `${locale}: HTML`).toContain(line);
      lines.add(dictionarySubject(locale, "funnelClaim.reference", { reference: "SZ-XXXXXX" }));
      checked++;
    }
    expect(checked, "anti-vacuity: every locale").toBe(LOCALES.length);
    expect(lines.size, "premise: every locale words the line its own way").toBe(LOCALES.length);
  });

  it("Change email: the earlier start's reference and replace key, posted with a new address, carry the reference over", async () => {
    const before = address();
    const after = address();
    const first = await startFor(before, competition());
    const moved = await post({
      email: after,
      name: competition(),
      sport: "Badminton",
      entrants: 8,
      previousReference: first.data.reference,
      replaceKey: first.data.replaceKey,
    });
    expect(moved.status).toBe(200);
    expect(moved.data.reference).toBe(first.data.reference);
    expect((await draftsOf(before)).map((d) => d.replaced), "the old address's draft is replaced").toEqual([true]);
    expect((await draftsOf(after)).map((d) => [d.reference, d.replaced])).toEqual([[first.data.reference, false]]);

    // A wrong key is no error (the route says nothing about another visitor's draft): a fresh start, the other draft untouched.
    const stranger = address();
    const guessed = await post({
      email: stranger,
      name: competition(),
      sport: "Badminton",
      entrants: 8,
      previousReference: first.data.reference,
      replaceKey: "x".repeat(43),
    });
    expect(guessed.status).toBe(200);
    expect(guessed.data.reference).not.toBe(first.data.reference);
    expect((await draftsOf(after)).map((d) => d.replaced), "the live draft is untouched").toEqual([false]);
  });

  it("half a replace pair, or a reference out of shape, is refused: no draft, no email", async () => {
    const bodies = [
      { label: "a reference without its key", extra: { previousReference: "SZ-23HJKZ" } },
      { label: "a key without its reference", extra: { replaceKey: "k".repeat(43) } },
      { label: "a reference out of shape", extra: { previousReference: "SZ-0OI1AA", replaceKey: "k".repeat(43) } },
    ];
    let checked = 0;
    for (const b of bodies) {
      const email = address();
      expect((await post({ email, name: competition(), sport: "Badminton", entrants: 8, ...b.extra })).status, b.label).toBe(400);
      expect(await draftsOf(email), `${b.label}: no draft`).toEqual([]);
      expect(await claimRows(email), `${b.label}: no row`).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(bodies.length);
  });

  it("a body with courts and hours is accepted and stored; out-of-range planning is refused and stores nothing", async () => {
    // The wizard's Planning fold (start-wizard redesign T2): the claim builds the courts, so they ride the draft. The bounds are
    // the fold's own (courts 1..32, hours 1..72).
    const email = address();
    const body = { email, name: competition(), sport: "Badminton", entrants: 8, format: "knockout", courts: 3, hours: 5 };
    expect((await post(body)).status).toBe(200);
    const [draft] = await sql<{ payload: Record<string, unknown> }[]>`select payload from funnel_drafts where email = ${email}`;
    expect(draft!.payload).toEqual({ name: body.name, sport: "Badminton", entrants: 8, format: "knockout", courts: 3, hours: 5 });

    const refused = [{ courts: 0 }, { courts: 33 }, { courts: 2.5 }, { hours: 0 }, { hours: 73 }, { courts: "3" }];
    let checked = 0;
    for (const bad of refused) {
      const other = address();
      expect((await post({ email: other, name: competition(), sport: "Badminton", entrants: 8, ...bad })).status, JSON.stringify(bad)).toBe(400);
      expect(await draftsOf(other), `${JSON.stringify(bad)}: no draft`).toEqual([]);
      expect(await claimRows(other), `${JSON.stringify(bad)}: no row`).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: every out-of-range body was posted").toBe(refused.length);
  });

  it("a bad email is a 400 and stores no draft", async () => {
    // The wizard's missing-ending case (mock A3): an address with no domain ending is refused by the route, not only the page.
    const email = `${RUN}-sam@harbourvale`;
    expect((await post({ email, name: competition(), sport: "Badminton", entrants: 8 })).status).toBe(400);
    expect(await draftsOf(email), "no draft").toEqual([]);
    expect(await claimRows(email), "no row").toEqual([]);
    expect(transport.deliver, "nothing sent").not.toHaveBeenCalled();
  });

  it("empty: an invalid payload queues nothing", async () => {
    const email = address();

    // One entrant is below the schema's minimum of two.
    expect((await post({ email, name: competition(), sport: "Badminton", entrants: 1 })).status).toBe(400);

    expect(await draftsOf(email), "no draft").toEqual([]);
    expect(await claimRows(email), "no row").toEqual([]);
    expect(transport.deliver, "nothing sent").not.toHaveBeenCalled();
  });
});
