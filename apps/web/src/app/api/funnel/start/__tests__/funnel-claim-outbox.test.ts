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

/** The visitor's start, as the /start page posts it (with the browser's cookie header, when one is given). */
async function post(body: Record<string, unknown>, cookie?: string): Promise<{ status: number }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
  const res = await start(new Request(`${ORIGIN}/api/funnel/start`, { method: "POST", headers, body: JSON.stringify(body) }));
  await res.text();
  return { status: res.status };
}
const startFor = (email: string, name: string, sport = "Badminton") => post({ email, name, sport, entrants: 8 });

/** The drafts written for an address, oldest first. */
const draftsOf = (email: string) =>
  sql<{ id: string; token: string }[]>`select id, token from funnel_drafts where email = ${email} order by created_at, id`;
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
    const cases = [
      { cookie: "seazn_locale=fr", locale: "fr" },
      { cookie: "seazn_locale=de", locale: "en" },
    ] as const;
    let checked = 0;
    for (const c of cases) {
      const email = address();
      const name = competition();
      expect((await post({ email, name, sport: "Badminton", entrants: 8 }, c.cookie)).status, c.cookie).toBe(200);
      const [row] = await claimRows(email);
      expect(row!.subject, c.cookie).toBe(dictionarySubject(c.locale, "funnelClaim.subject", { competitionName: name }));
      expect(callsFor(row!.id).map((m) => m.subject), `${c.cookie}: the mail sent is the row's`).toEqual([row!.subject]);
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
    const cases = [
      { locale: "fr", cookie: undefined, expected: "fr" },
      { locale: "nl", cookie: "seazn_locale=es", expected: "nl" },
      { locale: "de", cookie: undefined, expected: "en" },
      { locale: "de", cookie: "seazn_locale=es", expected: "es" },
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
      const [draft] = await sql<{ payload: Record<string, unknown> }[]>`select payload from funnel_drafts where email = ${email}`;
      expect(draft!.payload, `${label}: the draft stays claimable`).not.toHaveProperty("locale");
      checked++;
    }
    expect(checked, "anti-vacuity: every case was driven").toBe(cases.length);
    // Each case can tell its language from the fallback only while the dictionaries differ.
    const subjects = new Set(LOCALES.map((l) => dictionarySubject(l, "funnelClaim.subject", { competitionName: "x" })));
    expect(subjects.size, "premise: every shipped language has its own subject").toBe(LOCALES.length);
  });

  it("a second start is a second draft and a second email; neither replaces the other", async () => {
    // Each start writes its own draft with its own single-use token, and both links work (P-W3-2): the ref is the draft, so the two
    // rows are two documents and the replace rule leaves both alone.
    const email = address();

    expect((await startFor(email, competition())).status).toBe(200);
    expect((await startFor(email, competition())).status).toBe(200);

    const drafts = await draftsOf(email);
    expect(drafts, "two drafts").toHaveLength(2);
    const rows = await claimRows(email);
    expect(rows.map((r) => [r.ref_id, r.status])).toEqual(drafts.map((d) => [d.id, "sent"]));
    for (const [i, row] of rows.entries()) {
      expect(callsFor(row.id)[0]!.text, `row ${i} carries its own draft's token`).toContain(`/start/claim?token=${drafts[i]!.token}`);
    }
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
