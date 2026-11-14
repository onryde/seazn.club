// The wizard's body, end to end (start-wizard redesign, plan 2026-11-13 Task 4): what an organiser builds on /start —
// state driven through the wizard's own reducer, posted as the island posts it (`buildFunnelBody`) — is accepted by the REAL
// POST /api/funnel/start, and the emailed claim builds exactly that: the format card picked, the field sized (clamped to the
// claiming organisation's cap) as the getting-started read's target — the claim writes no entrant (/start "Sent stepper",
// owner 2026-11-14) — the first day, and the courts only when Planning was opened. Then the analytics event the route fires
// carries exactly `{ sport, entrants }` and nothing the visitor typed, once per POST (a resubmit is counted too).
//
// The seam this closes: the model test proves the body parses the payload schema, the claim test proves a hand-written
// payload builds; neither proves the body the wizard WRITES is one the route takes and the claim builds as chosen.
//
// Stand-ins: the outbox transport (the network), the limiter, `next/headers`, and PostHog's capture (recorded). Expected
// values: the stage kinds are the rulebook's (typed below), the field is the live plan resolver's cap, the analytics props
// are typed here from what the test chose. Every funnel sport is driven, each format on at least two of them.
// Real Postgres required — skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.57" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));
const posthog = vi.hoisted(() => ({ captureServer: vi.fn<(args: unknown) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/posthog-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/posthog-server")>()),
  captureServer: posthog.captureServer,
}));

import { sql } from "@/lib/db";
import { consumeFunnelDraft, createFromDraft, funnelEntrantCap } from "@/lib/funnel";
import { FUNNEL_FORMATS, FUNNEL_MORE_FORMATS, type FunnelFormat } from "@/lib/funnel-formats";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { gettingStarted } from "@/server/usecases/getting-started";
import {
  buildFunnelBody,
  initialWizardState,
  nextEventDays,
  plausibleEmail,
  wizardReducer,
  wizardToday,
  type WizardAction,
  type WizardContext,
  type WizardState,
} from "@/components/start-wizard-model";
import { parseStartPrefill } from "@/app/[lang]/(marketing)/start/prefill";
import { POST as start } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `fwb-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://funnel.test";

/** The rulebook: the stages each format card stands for, in play order. */
const RULEBOOK_KINDS: Record<FunnelFormat, string[]> = {
  league: ["league"],
  "groups-knockout": ["group", "knockout"],
  knockout: ["knockout"],
  swiss: ["swiss"],
  double_elim: ["double_elim"],
};
const ALL_FORMATS: readonly FunnelFormat[] = [...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS];

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@example.com`;

async function seedUser(email: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Wizard Claimant', true) returning id`;
  return u!.id;
}

async function post(body: Record<string, unknown>): Promise<number> {
  const res = await start(
    new Request(`${ORIGIN}/api/funnel/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  await res.text();
  return res.status;
}

/** The organiser's walk, as the island dispatches it: every action through the wizard's own reducer. */
function drive(sportKey: string, ctx: WizardContext, actions: WizardAction[]): WizardState {
  let s = initialWizardState(parseStartPrefill({ sport: sportKey }, ctx.today), ctx);
  for (const a of actions) s = wizardReducer(s, a, ctx);
  return s;
}

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  posthog.captureServer.mockClear();
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
  const ids = (await sql<{ id: string }[]>`select id from users where email like ${like}`).map((u) => u.id);
  // Courts first: their (venue, org) key does not cascade from the venue, so an org delete would trip on it.
  await sql`delete from courts where org_id in (select id from organizations where created_by = any(${ids}::uuid[]))`;
  await sql`delete from organizations where created_by = any(${ids}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${ids}::uuid[])`;
  await sql`delete from users where id = any(${ids}::uuid[])`;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the wizard's body → POST /api/funnel/start → the claim builds what was chosen (DB)", () => {
  it("every funnel sport: the picked format's stages, the field, the first day, the courts only with Planning, and the event's props", async () => {
    const cap = await funnelEntrantCap();
    const today = wizardToday(new Date());
    const ctx: WizardContext = { maxEntrants: cap, today };
    let checked = 0;
    const formatsSeen = new Map<FunnelFormat, number>();
    for (const [i, sport] of FUNNEL_SPORTS.entries()) {
      const format = ALL_FORMATS[i % ALL_FORMATS.length]!;
      const entrants = i === 1 ? 100 : 12; // one over the free cap: the body asks 100, the claim builds the cap
      const planning = i % 2 === 0;
      const courts = 1 + (i % 4);
      const date = i % 3 === 0 ? nextEventDays(today)[0]! : null;
      const email = address();
      const name = `${RUN} ${sport.key}`;
      const label = `${sport.key} ${format}`;

      const s = drive(sport.key, ctx, [
        { type: "name", value: name },
        { type: "next" },
        { type: "entrants", value: entrants },
        ...(planning ? ([{ type: "planning" }, { type: "courts", value: courts }] as WizardAction[]) : []),
        { type: "format", slug: format },
        { type: "next" },
        { type: "date", value: date },
        { type: "next" },
        { type: "email", value: email },
      ]);
      expect(s.step, `${label}: the walk reached B4`).toBe("email");
      expect(s.format, `${label}: the card was pickable`).toBe(format);
      const body = buildFunnelBody(s, "en", "unused default");
      expect(await post(body), label).toBe(200);

      const [draft] = await sql<{ id: string; token: string }[]>`select id, token from funnel_drafts where email = ${email}`;
      expect(draft, `${label}: one draft`).toBeTruthy();

      // The analytics event: exactly the sport the claim resolves and the size ASKED, nothing the visitor typed.
      const events = posthog.captureServer.mock.calls
        .map((c) => c[0] as { event: string; distinctId: string; properties: unknown })
        .filter((e) => e.event === "funnel_draft_created");
      expect(events, label).toHaveLength(1);
      expect(events[0]!.distinctId).toBe(`funnel:${draft!.id}`);
      expect(events[0]!.properties).toEqual({ sport: sport.name, entrants });
      posthog.captureServer.mockClear();

      // The claim, as the emailed link runs it.
      const userId = await seedUser(email);
      const consumed = await consumeFunnelDraft(draft!.token);
      expect(consumed, `${label}: claimable`).not.toBeNull();
      const { orgId } = await createFromDraft(userId, consumed!);
      const [comp] = await sql<{ id: string; starts_on: string | null; division_id: string }[]>`
        select c.id, to_char(c.starts_on, 'YYYY-MM-DD') as starts_on, d.id as division_id
          from competitions c join divisions d on d.competition_id = c.id
         where c.org_id = ${orgId} and c.name = ${name}`;
      expect(comp, `${label}: the competition the organiser named`).toBeTruthy();
      expect(comp!.starts_on, `${label}: the first day`).toBe(date);
      const kinds = (await sql<{ kind: string }[]>`select kind from stages where division_id = ${comp!.division_id} order by seq`).map((r) => r.kind);
      expect(kinds, label).toEqual(RULEBOOK_KINDS[format]);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${comp!.division_id}`;
      expect(n, `${label}: no entrant is written`).toBe(0);
      const state = await gettingStarted({ orgId, via: "session", userId, role: "owner", keyId: null }, comp!.id);
      expect(state.entrants, `${label}: the field chosen is the target`).toEqual({ count: 0, target: cap === null ? entrants : Math.min(entrants, cap) });
      const [{ c }] = await sql<{ c: number }[]>`
        select count(*)::int as c from courts k join venues v on v.id = k.venue_id
         where k.org_id = ${orgId} and k.archived_at is null and v.archived_at is null`;
      expect(c, `${label}: courts only once Planning was opened`).toBe(planning ? courts : 0);

      formatsSeen.set(format, (formatsSeen.get(format) ?? 0) + 1);
      checked++;
    }
    expect(checked).toBe(FUNNEL_SPORTS.length);
    expect([...formatsSeen.keys()].sort(), "every format driven").toEqual([...ALL_FORMATS].sort());
    expect(Math.min(...formatsSeen.values()), "each format on two sports at least").toBeGreaterThanOrEqual(2);
    expect(cap === null || cap < 100, "the over-cap row really is over a cap (or the plan is unlimited)").toBe(true);
  });

  it("a resubmit from the wizard (the visitor went back and sent again) is counted: one funnel_draft_created per POST, one live draft", async () => {
    const email = address();
    const today = wizardToday(new Date());
    const ctx: WizardContext = { maxEntrants: await funnelEntrantCap(), today };
    const walk = (entrants: number) =>
      drive("badminton", ctx, [
        { type: "name", value: `${RUN} resubmit` },
        { type: "next" },
        { type: "entrants", value: entrants },
        { type: "format", slug: "league" },
        { type: "next" },
        { type: "date", value: null },
        { type: "next" },
        { type: "email", value: email },
      ]);
    expect(await post(buildFunnelBody(walk(8), "en", "unused default"))).toBe(200);
    expect(await post(buildFunnelBody(walk(10), "en", "unused default"))).toBe(200);
    const drafts = await sql<{ id: string; live: boolean }[]>`
      select id, (replaced_at is null) as live from funnel_drafts where email = ${email} order by created_at, id`;
    expect(drafts.map((d) => d.live), "the first replaced, the second live").toEqual([false, true]);
    const events = posthog.captureServer.mock.calls
      .map((c) => c[0] as { event: string; distinctId: string; properties: unknown })
      .filter((e) => e.event === "funnel_draft_created");
    expect(events.map((e) => [e.distinctId, e.properties]), "one event per POST, each its own draft and size").toEqual([
      [`funnel:${drafts[0]!.id}`, { sport: "Badminton", entrants: 8 }],
      [`funnel:${drafts[1]!.id}`, { sport: "Badminton", entrants: 10 }],
    ]);
  });

  it("an address the wizard holds back as short of its ending is one the route refuses: no draft, no email, no event", async () => {
    const email = `${RUN}-${randomUUID().slice(0, 8)}@harbourvale`;
    expect(plausibleEmail(email), "premise: the wizard's own reading").toBe("missingTld");
    const today = wizardToday(new Date());
    const s = drive("badminton", { maxEntrants: null, today }, [{ type: "email", value: email }]);
    expect(await post(buildFunnelBody(s, "en", `${RUN} short`))).toBe(400);
    expect(await sql`select 1 from funnel_drafts where email = ${email}`).toHaveLength(0);
    expect(await sql`select 1 from email_outbox where kind = 'funnel_claim' and lower(recipient) = lower(${email})`).toHaveLength(0);
    expect(posthog.captureServer.mock.calls.filter((c) => (c[0] as { event: string }).event === "funnel_draft_created")).toHaveLength(0);
  });
});
