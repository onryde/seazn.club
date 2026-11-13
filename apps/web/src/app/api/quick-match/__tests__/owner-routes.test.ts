// Quick match plan 3, Task 6 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7, C9, C13; plan 3 Amend T6 [B27,
// B28, D14, A5, E7]; ledger carry "rename + delete refuse under imp"): the saver's two actions on a saved quick match, through the
// REAL route, `PATCH /api/quick-match/<id> { name }` and `DELETE /api/quick-match/<id>`.
//
// The contract, in the order the route checks it:
//   - signed out: 401 QUICK_MATCH_SIGNED_OUT (a deleted account's old session is signed out too);
//   - a session staff impersonation started: 403, its own code per verb (QUICK_MATCH_RENAME_IMPERSONATED,
//     QUICK_MATCH_DELETE_IMPERSONATED): staff never rename or hard-delete the match of the person they look through;
//   - rename only: a name `CreateQuickMatch` would refuse (trimmed, 1 to 80) is 422 QUICK_MATCH_RENAME_INVALID;
//   - a match this person has not saved (someone else's, nobody's, one past its expiry, a missing or malformed id): 404
//     QUICK_MATCH_NOT_IN_ACCOUNT, one answer for all of them (B28: no oracle for whether a match exists);
//   - the saver: a rename writes the four names the create copied (quick_matches, competitions, divisions, the stage) in plain
//     UPDATEs, never the slug and never a slug_history row (D14); a delete is the hard delete, which leaves nothing (A5).
// Then the account list's own two requests (components/quick-match/my-list-requests.ts) are driven through this same route, so the
// method, path and body the island sends are the ones the route reads, and each refusal reaches the person as its own line.
//
// The real producers: every quick match is made by `createQuickMatch`, saved by the real save (the button's, or the address's at
// sign-in), scored through the events route's own door; every session by the real `createSession` on a Map-backed cookie jar; the
// impersonated one by the real impersonation page; the account deletion by the real `DELETE /api/users/me`. Stand-ins:
// `next/headers` (the jar), the limiter, Stripe, the outbox transport, PostHog and Sentry's capture (a spy).
//
// Expected values come from the spec and the plan (the codes' names, the 1..80 bound, the four names, 7 days), the dictionaries
// (each line by its key) and the rows the real producers wrote; never from the route's own answer.
//
// Sport: the delete's orphan check runs badminton AND football (E8: the cascade is the same tree whatever the sport, and a second
// sport proves it); everything else is the save rig's one sport, because a rename and a delete read no sport.
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every create seals a home token, every Score tap a link
vi.stubEnv("EMAIL_OUTBOX_KEK", kekBytes(32).toString("hex")); // the account deletion's notice and an emailed create's mail are sealed
vi.stubEnv("RESEND_API_KEY", "re_test_quick_match_owner_routes"); // an attempt reaches the transport (the stand-in), never Resend

const h = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.98" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (name: string) => void h.jar.delete(name),
  }),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { cancel: vi.fn(async () => ({})) } }) }));
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: vi.fn(async () => ({ ok: true, providerId: `re_qmowner_${crypto.randomUUID()}` })),
}));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(async () => {}),
}));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));

import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { createImpersonationToken } from "@/lib/admin";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { createQuickMatch, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { ensureGuestDeviceLink } from "@/server/usecases/device-links";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { saveQuickMatchForUser, saveQuickMatchesForVerifiedUser } from "@/server/usecases/quick-match-save";
import { listQuickMatchSports } from "@/server/usecases/quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { playToDecided } from "@/server/usecases/__tests__/_quick-match-probe";
import { scoreEvent } from "@/server/usecases/scoring";
import { expectAllPresent, expectNoOrphans, idsOf, tablesRecorded } from "@/server/usecases/__tests__/_quick-match-orphans";
import { addressFor, createTypedMatch, deleteMadeMatches, saveStateOf } from "@/server/usecases/__tests__/_quick-match-save-rig";
import { deleteMyQuickMatch, renameMyQuickMatch, type OwnerAnswer } from "@/components/quick-match/my-list-requests";
import ImpersonatePage from "@/app/admin/impersonate/page";
import { DELETE as DELETE_ACCOUNT } from "@/app/api/users/me/route";
import QuickMatchHomePage from "@/app/q/[token]/page";
import * as ownerRoute from "../[id]/route";

const { PATCH, DELETE } = ownerRoute;
const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://qm-owner-routes.test";
const DAY_MS = 24 * 3600 * 1000;
/** C1: an unsaved quick match is kept this many days after its last activity. The spec's number, typed. */
const SPEC_EXPIRY_DAYS = 7;
/** The name's bound (plan 3 Amend T6 [D14]: `CreateQuickMatch.shape.name`, trimmed, 1 to 80). Typed from the plan. */
const NAME_MAX = 80;
/** The codes the routes answer with (plan 3 Amend T6; ledger carry for impersonation, one per verb). Typed, so a renamed constant
 *  reds here. */
const CODE = {
  signedOut: "QUICK_MATCH_SIGNED_OUT",
  renameImpersonated: "QUICK_MATCH_RENAME_IMPERSONATED",
  deleteImpersonated: "QUICK_MATCH_DELETE_IMPERSONATED",
  invalid: "QUICK_MATCH_RENAME_INVALID",
  notInAccount: "QUICK_MATCH_NOT_IN_ACCOUNT",
} as const;
const reported = () => vi.mocked(Sentry.captureException).mock.calls.map(([err]) => err);

const users: string[] = [];
async function account(tag: string, email = addressFor(tag)): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'QM owner', true) returning id`;
  users.push(id);
  return id;
}
/** Sign `userId` in on the jar, as every door does: the real `createSession`. */
async function signIn(userId: string): Promise<void> {
  h.jar.clear();
  await createSession(userId);
}
/** A match the save rig makes (unique name, no address), saved by `userId` through the real Save. */
async function savedBy(userId: string): Promise<CreatedQuickMatch> {
  const qm = await createTypedMatch(null);
  expect(await saveQuickMatchForUser(userId, qm.id), "premise: saved").toBe("saved");
  return qm;
}

/** A League → Final of three badminton pairs (plan 5: two stages) through the real create, saved by `userId` through the real
 *  Save. One sport, as the rest of the rename cases: a rename reads no sport. */
async function savedLeagueKnockout(userId: string): Promise<CreatedQuickMatch> {
  const sport = (await listQuickMatchSports()).find((s) => s.sport_key === "badminton");
  if (!sport) throw new Error("premise: badminton is offered for quick matches");
  const qm = await createQuickMatch(
    {
      name: `QM owner lk ${randomUUID().slice(0, 8)}`,
      sport_key: "badminton",
      variant_key: sport.variants[0]!.variant_key,
      kind: sport.kinds.at(-1)!,
      format: "league_knockout",
      qualifiers: 2,
      sides: ["Side A", "Side B", "Side C"],
      plays: 1,
      email: null,
      locale: "en",
    },
    { visitorHash: hashVisitorKey(mintVisitorKey()), mailAllowed: async () => true },
  );
  made.push(qm.competitionId);
  expect(await saveQuickMatchForUser(userId, qm.id), "premise: saved").toBe("saved");
  return qm;
}

const made: string[] = [];
/** A quick match of `sportKey` through the real create, its first offered variant and its widest kind, two sides. */
async function createOf(sportKey: string): Promise<CreatedQuickMatch> {
  const sport = (await listQuickMatchSports()).find((s) => s.sport_key === sportKey);
  if (!sport) throw new Error(`premise: ${sportKey} is offered for quick matches`);
  const out = await createQuickMatch(
    {
      name: `QM owner ${sportKey} ${randomUUID().slice(0, 8)}`,
      sport_key: sportKey,
      variant_key: sport.variants[0]!.variant_key,
      kind: sport.kinds.at(-1)!,
      format: "league",
      sides: ["Side A", "Side B"],
      plays: 1,
      email: null,
      locale: "en",
    },
    { visitorHash: hashVisitorKey(mintVisitorKey()), mailAllowed: async () => true },
  );
  made.push(out.competitionId);
  return out;
}
/** The guest's Score tap on the first match and the match played to its result, through the events route's own door. */
async function playFirst(out: CreatedQuickMatch): Promise<void> {
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error(`precondition: quick match ${out.id} does not resolve`);
  const [f0] = await sql<{ id: string }[]>`
    select f.id from fixtures f join divisions d on d.id = f.division_id
     where d.competition_id = ${out.competitionId} order by f.round_no, f.fixture_no limit 1`;
  const { secret } = await ensureGuestDeviceLink(row, f0!.id);
  const auth = await requireFixtureActor(
    new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${secret}` } }),
    f0!.id,
    "score",
  );
  expect(await playToDecided(auth, f0!.id), "premise: the match was played to a result").toMatchObject({ kind: "decided" });
}

const patch = (id: string, body: unknown, raw?: string) =>
  PATCH(
    new Request(`${ORIGIN}/api/quick-match/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
const del = (id: string) =>
  DELETE(new Request(`${ORIGIN}/api/quick-match/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

/** A refusal: its status and its code, and the body it carried (for comparing two refusals). */
async function refusedWith(res: Response, status: number, code: string): Promise<unknown> {
  const body = (await res.json()) as { ok?: boolean; code?: string; error?: string };
  expect([res.status, body.code, body.ok], JSON.stringify(body)).toEqual([status, code, false]);
  return body;
}

interface Names {
  quickMatch: string;
  competition: string;
  competitionSlug: string;
  divisions: { name: string; slug: string }[];
  stages: string[];
  slugHistory: number;
}
/** Every place a quick match's name lives (Amend T6 [D14, B27]: the create copies it into four), and the slugs that must not move,
 *  read on the pool (past RLS) so a read cannot hide a row. */
async function namesOf(qm: CreatedQuickMatch): Promise<Names> {
  const [row] = await sql<{ name: string; competition: string; slug: string }[]>`
    select q.name, c.name as competition, c.slug from quick_matches q join competitions c on c.id = q.competition_id
     where q.id = ${qm.id}`;
  if (!row) throw new Error(`precondition: quick match ${qm.id} has no row`);
  const divisions = await sql<{ id: string; name: string; slug: string }[]>`
    select id, name, slug from divisions where competition_id = ${qm.competitionId} order by id`;
  const stages = await sql<{ name: string }[]>`
    select s.name from stages s join divisions d on d.id = s.division_id where d.competition_id = ${qm.competitionId} order by s.id`;
  const ids = [qm.competitionId, ...divisions.map((d) => d.id)];
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from slug_history where entity_id = any(${ids}::uuid[])`;
  return {
    quickMatch: row.name,
    competition: row.competition,
    competitionSlug: row.slug,
    divisions: divisions.map((d) => ({ name: d.name, slug: d.slug })),
    stages: stages.map((s) => s.name),
    slugHistory: n,
  };
}
/** All four names read `name`; the slugs are `before`'s; no slug history (D14). */
function expectRenamed(after: Names, before: Names, name: string): void {
  expect(after.quickMatch, "quick_matches.name").toBe(name);
  expect(after.competition, "competitions.name").toBe(name);
  expect(after.divisions.map((d) => d.name), "divisions.name (the create copies it)").toEqual([name]);
  expect(after.stages, "the stage's name (quickMatchStageInput copies it)").toEqual([name]);
  expect(after.competitionSlug, "the competition's slug never changes").toBe(before.competitionSlug);
  expect(after.divisions.map((d) => d.slug), "the division's slug never changes").toEqual(before.divisions.map((d) => d.slug));
  expect(after.slugHistory, "no slug_history row: a keyless row the hard delete would orphan").toBe(0);
}

/** The REAL home page for a token, rendered as Next renders it. */
async function homeHtml(token: string): Promise<string> {
  const tree = await QuickMatchHomePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(tree as ReactElement);
}
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

beforeAll(async () => {
  process.env.AUTH_SECRET ??= "auth-secret-for-quick-match-owner-routes-test-0123456789-0123456789";
  if (!HAS_DB) return;
  // The account deletion's landing imports these lazily; loaded once here, as the deletion suite does.
  await import("@/server/usecases/me");
  await import("@/lib/activation");
});
beforeEach(() => {
  h.jar.clear();
  vi.mocked(Sentry.captureException).mockClear();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  await deleteMadeMatches();
  for (const id of made) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  if (users.length > 0) {
    await sql`delete from impersonation_sessions where actor_id = any(${users}::uuid[]) or target_id = any(${users}::uuid[])`;
    await sql`delete from staff_audit_log where actor_id = any(${users}::uuid[])`;
    await sql`delete from organizations where created_by = any(${users}::uuid[])`;
    await sql`delete from subscriptions where owner_user_id = any(${users}::uuid[])`;
    await sql`delete from users where id = any(${users}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("the route's shape", () => {
  it("answers PATCH and DELETE only: no read, no create on this path", () => {
    expect(Object.keys(ownerRoute).sort()).toEqual(["DELETE", "PATCH"]);
  });
});

describe.skipIf(!HAS_DB)("PATCH /api/quick-match/<id>: the saver renames", () => {
  it("the saver: 200 with the new name, written to all four places the create copied it; the slugs stay and no slug_history row appears; the home reads it", async () => {
    const me = await account("rename");
    const qm = await savedBy(me);
    const before = await namesOf(qm);
    await signIn(me);
    const name = `Renamed ${randomUUID().slice(0, 8)}`;

    const res = await patch(qm.id, { name });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { data?: { name?: string } }).data?.name).toBe(name);
    expectRenamed(await namesOf(qm), before, name);
    // The link still opens the match, under its new name (C13: the link keeps working for friends).
    expect((await resolveQuickMatchToken(qm.token))?.name).toBe(name);
    expect(await homeHtml(qm.token)).toContain(`>${name}<`);
    expect((await saveStateOf(qm.id)).saved_by_user_id, "still the saver's").toBe(me);
  });

  it("twice: the second rename wins, everywhere, and still no slug moves", async () => {
    const me = await account("rename-twice");
    const qm = await savedBy(me);
    const before = await namesOf(qm);
    await signIn(me);

    expect((await patch(qm.id, { name: "First new name" })).status).toBe(200);
    expectRenamed(await namesOf(qm), before, "First new name");
    const second = await patch(qm.id, { name: "Second new name" });

    expect(second.status).toBe(200);
    expectRenamed(await namesOf(qm), before, "Second new name");
  });

  it("the bound is CreateQuickMatch's, after trimming: 80 characters and a padded name pass; 81, 200, empty, only spaces, no name, a number and a body that is not JSON are each 422, and nothing changes", async () => {
    const me = await account("rename-bound");
    const qm = await savedBy(me);
    await signIn(me);
    const unchanged = await namesOf(qm);

    const refused: [string, unknown, string?][] = [
      ["81 characters", { name: "x".repeat(NAME_MAX + 1) }],
      ["200 characters", { name: "y".repeat(200) }],
      ["empty", { name: "" }],
      ["only spaces", { name: "     " }],
      ["no name", {}],
      ["a number", { name: 42 }],
      ["null", { name: null }],
      ["a body that is not JSON", undefined, "name=Plain"],
    ];
    let checked = 0;
    for (const [label, body, raw] of refused) {
      await refusedWith(await patch(qm.id, body, raw), 422, CODE.invalid);
      expect([label, await namesOf(qm)]).toEqual([label, unchanged]);
      checked++;
    }
    expect(checked, "refused names checked").toBe(refused.length);
    expect(checked).toBeGreaterThan(0);

    // The positive pairs: the longest allowed name, and a padded one, which is stored trimmed.
    const longest = "z".repeat(NAME_MAX);
    expect((await patch(qm.id, { name: longest })).status).toBe(200);
    expectRenamed(await namesOf(qm), unchanged, longest);
    expect((await patch(qm.id, { name: "   Padded name   " })).status).toBe(200);
    expectRenamed(await namesOf(qm), unchanged, "Padded name");
  });

  it("someone else's match, a match nobody saved, an id that matches nothing and one that is no id: the same 404, nothing renamed", async () => {
    const owner = await account("rename-owner");
    const intruder = await account("rename-intruder");
    const theirs = await savedBy(owner);
    const nobodys = await createTypedMatch(null);
    const before = [await namesOf(theirs), await namesOf(nobodys)];
    await signIn(intruder);

    const answers: unknown[] = [];
    let checked = 0;
    for (const id of [theirs.id, nobodys.id, randomUUID(), "not-a-uuid", "'; drop table quick_matches; --"]) {
      answers.push(await refusedWith(await patch(encodeURIComponent(id), { name: "Hijacked" }), 404, CODE.notInAccount));
      checked++;
    }
    expect(checked).toBe(5);
    // B28: no oracle. Someone else's match answers exactly as an id that names nothing does.
    expect(answers[0]).toEqual(answers[2]);
    expect([await namesOf(theirs), await namesOf(nobodys)]).toEqual(before);
    expect((await saveStateOf(theirs.id)).saved_by_user_id).toBe(owner);
  });

  it("a League + Knockout (plan 5 D10): the rename writes its competition, its division and BOTH stages; a League's one stage alongside", async () => {
    const me = await account("rename-lk");
    const [lk, league] = [await savedLeagueKnockout(me), await savedBy(me)];
    const [lkBefore, leagueBefore] = [await namesOf(lk), await namesOf(league)];
    expect(lkBefore.stages, "premise: a League + Knockout is two stages, both named after the match").toHaveLength(2);
    expect(leagueBefore.stages, "premise: a League is one stage").toHaveLength(1);
    await signIn(me);

    const lkRes = await patch(lk.id, { name: "League then final" });
    expect(lkRes.status, await lkRes.clone().text()).toBe(200);
    const after = await namesOf(lk);
    expect(after.stages, "both stages renamed").toEqual(["League then final", "League then final"]);
    expectRenamed({ ...after, stages: after.stages.slice(0, 1) }, lkBefore, "League then final");
    expect((await patch(league.id, { name: "Just a league" })).status).toBe(200);
    expectRenamed(await namesOf(league), leagueBefore, "Just a league");
    // The second rename touched only its own match.
    expect((await namesOf(lk)).quickMatch).toBe("League then final");
  });

  it("an assumption made a guard: a League + Knockout missing one of its two stages is refused as a fault, rolled back whole", async () => {
    const me = await account("rename-lk-broken");
    const lk = await savedLeagueKnockout(me);
    // One stage of the two goes (the knockout, its waiting lines with it): a shape the create never makes.
    await sql`delete from stages where id = ${lk.knockoutStageId}`;
    const before = await namesOf(lk);
    expect(before.stages, "premise: one stage left").toHaveLength(1);
    await signIn(me);

    const res = await patch(lk.id, { name: "Never written" });

    expect(res.status).toBe(500);
    expect(await namesOf(lk), "nothing renamed").toEqual(before);
    expect(reported(), "a fault is reported").toHaveLength(1);
  });

  it("an assumption made a guard: a quick match without its one stage is refused as a fault, the rename rolled back whole", async () => {
    const me = await account("rename-broken");
    const qm = await savedBy(me);
    // Break the shape the create guarantees (one competition, one division, one stage): the stage goes, its fixtures with it.
    await sql`delete from stages where division_id in (select id from divisions where competition_id = ${qm.competitionId})`;
    const before = await namesOf(qm);
    await signIn(me);

    const res = await patch(qm.id, { name: "Never written" });

    expect(res.status).toBe(500);
    expect(await namesOf(qm), "nothing renamed: the quick match's and the competition's names rolled back").toEqual(before);
    expect(reported(), "a fault is reported").toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("DELETE /api/quick-match/<id>: the saver deletes", () => {
  it.each(["badminton", "football"])(
    "%s: a played, saved match goes with everything under it (A5); the link opens the dead screen; a second DELETE and a PATCH after it are 404",
    async (sportKey) => {
      const me = await account(`delete-${sportKey}`);
      const qm = await createOf(sportKey);
      await playFirst(qm);
      expect(await saveQuickMatchForUser(me, qm.id)).toBe("saved");
      const neighbour = await createOf(sportKey);
      const probes = await idsOf(qm);
      // A played quick match holds rows in at least these (anti-vacuity on the shape, not only on the count).
      for (const t of ["competitions", "divisions", "stages", "entrants", "fixtures", "score_events", "match_states", "device_links", "quick_matches"]) {
        expect(tablesRecorded(probes), `the match held rows in ${t} before its delete`).toContain(t);
      }
      const kept = await idsOf(neighbour);
      await signIn(me);

      const res = await del(qm.id);

      expect(res.status, await res.clone().text()).toBe(204);
      expect(await res.text(), "a 204 carries no body").toBe("");
      await expectNoOrphans(probes, `saver's delete, ${sportKey}`);
      await expectAllPresent(kept, `${sportKey} neighbour`);
      expect(await resolveQuickMatchToken(qm.token), "the link resolves to nothing").toBeNull();
      const dead = await homeHtml(qm.token);
      expect(has(dead, "qm-dead-link"), "the home is the dead screen").toBe(true);

      // B28: the second DELETE, and a rename after it, answer as for any match not in the account.
      await refusedWith(await del(qm.id), 404, CODE.notInAccount);
      await refusedWith(await patch(qm.id, { name: "After the delete" }), 404, CODE.notInAccount);
    },
  );

  it("someone else's match, a match nobody saved and an id that is none: 404, and every one of them is whole", async () => {
    const owner = await account("delete-owner");
    const intruder = await account("delete-intruder");
    const theirs = await savedBy(owner);
    const nobodys = await createTypedMatch(null);
    const probes = [await idsOf(theirs), await idsOf(nobodys)];
    await signIn(intruder);

    let checked = 0;
    for (const id of [theirs.id, nobodys.id, randomUUID(), "not-a-uuid"]) {
      await refusedWith(await del(id), 404, CODE.notInAccount);
      checked++;
    }
    expect(checked).toBe(4);
    await expectAllPresent(probes[0]!, "someone else's match");
    await expectAllPresent(probes[1]!, "a match nobody saved");
    expect((await saveStateOf(theirs.id)).saved_by_user_id).toBe(owner);
  });

  it("Review Focus 1: a person who never made the match, saved to them by the address typed on it at sign-in, can delete it", async () => {
    const email = addressFor("typed-owner");
    const me = await account("typed-owner", email);
    const qm = await createTypedMatch(email); // a guest typed this person's address; this person never saw the setup page
    expect(await saveQuickMatchesForVerifiedUser(me), "premise: the sign-in's save by address").toEqual({ savedByEmail: 1 });
    // The typed address queued the match's link mail (plan 3 Task 1): its outbox row is the match's too, and goes with it
    // (T6 review m4: the outbox delete on the saver's path, witnessed).
    const probes = await idsOf(qm);
    expect(tablesRecorded(probes), "premise: the emailed create queued its link mail").toContain("email_outbox");
    await signIn(me);

    expect((await del(qm.id)).status).toBe(204);
    expect(await resolveQuickMatchToken(qm.token)).toBeNull();
    await expectNoOrphans(probes, "saver's delete of an emailed match");
  });

  it("after a take-back: the deciding rally voided by the guest's own Void, the saver's delete still takes everything, the void with it", async () => {
    const me = await account("delete-after-void");
    const qm = await createOf("badminton");
    const row = await resolveQuickMatchToken(qm.token);
    const [f0] = await sql<{ id: string }[]>`
      select f.id from fixtures f join divisions d on d.id = f.division_id
       where d.competition_id = ${qm.competitionId} order by f.round_no, f.fixture_no limit 1`;
    const { secret } = await ensureGuestDeviceLink(row!, f0!.id);
    const auth = await requireFixtureActor(
      new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${secret}` } }),
      f0!.id,
      "score",
    );
    const played = await playToDecided(auth, f0!.id);
    if (played.kind !== "decided") throw new Error(`premise: the match was played to a result, got ${played.kind}`);
    // The guest's take-back, as the pad's "Void my last entry" posts it: core.void of the deciding event, expected_seq = the tip.
    await scoreEvent(auth, f0!.id, { expected_seq: played.lastSeq, type: "core.void", payload: { event_id: played.lastEventId } });
    const [voids] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${f0!.id} and type = 'core.void' and voids_event_id = ${played.lastEventId}`;
    expect(voids!.n, "premise: the take-back is recorded, pointing at the deciding rally").toBe(1);
    expect(await saveQuickMatchForUser(me, qm.id)).toBe("saved");
    const probes = await idsOf(qm);
    await signIn(me);

    expect((await del(qm.id)).status).toBe(204);
    await expectNoOrphans(probes, "saver's delete after a take-back");
    expect(await resolveQuickMatchToken(qm.token), "the link resolves to nothing").toBeNull();
  });
});

describe.skipIf(!HAS_DB)("who may act at all: signed out, impersonated, a deleted account, a match past its expiry", () => {
  it("signed out: 401 SIGNED_OUT on both verbs, and nothing changes", async () => {
    const me = await account("signed-out");
    const qm = await savedBy(me);
    const before = await namesOf(qm);
    const probes = await idsOf(qm);

    await refusedWith(await patch(qm.id, { name: "Nobody's rename" }), 401, CODE.signedOut);
    await refusedWith(await del(qm.id), 401, CODE.signedOut);

    expect(await namesOf(qm)).toEqual(before);
    await expectAllPresent(probes, "signed out");
  });

  it("a session staff impersonation started: rename 403 RENAME_IMPERSONATED, delete 403 DELETE_IMPERSONATED, nothing changes; the person's own session then does both", async () => {
    const target = await account("impersonated");
    const staff = await account("staff");
    const qm = await savedBy(target);
    const before = await namesOf(qm);
    const probes = await idsOf(qm);
    const token = await createImpersonationToken(staff, target);
    const thrown = await ImpersonatePage({ searchParams: Promise.resolve({ token }) }).then(
      () => null,
      (e: unknown) => e as { digest?: string },
    );
    expect(String(thrown?.digest), "premise: the page signed the target in and redirected").toContain("/dashboard");

    await refusedWith(await patch(qm.id, { name: "Staff rename" }), 403, CODE.renameImpersonated);
    await refusedWith(await del(qm.id), 403, CODE.deleteImpersonated);
    expect(await namesOf(qm), "not renamed").toEqual(before);
    await expectAllPresent(probes, "impersonated delete");

    // The positive pair, in sequence: the same person, signed in by a door of their own.
    await signIn(target);
    expect((await patch(qm.id, { name: "Their own rename" })).status).toBe(200);
    expectRenamed(await namesOf(qm), before, "Their own rename");
    expect((await del(qm.id)).status).toBe(204);
    expect(await resolveQuickMatchToken(qm.token)).toBeNull();
  });

  it("after the account is deleted: its old session is signed out (401) on both verbs; the match was released, not deleted, and still opens", async () => {
    const leaver = await account("leaver");
    const qm = await savedBy(leaver);
    await signIn(leaver);
    const leaversCookie = new Map(h.jar);
    const del0 = await DELETE_ACCOUNT(
      new Request(`${ORIGIN}/api/users/me`, { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }),
    );
    expect(del0.status, await del0.text()).toBe(200);
    const released = await saveStateOf(qm.id);
    expect(released.saved_by_user_id, "released by the deletion (D8)").toBeNull();
    expect(released.expires_at?.getTime(), "7 days after its last activity (C1)").toBe(
      released.last_activity_at.getTime() + SPEC_EXPIRY_DAYS * DAY_MS,
    );
    const before = await namesOf(qm);

    h.jar.clear();
    for (const [k, v] of leaversCookie) h.jar.set(k, v);
    await refusedWith(await patch(qm.id, { name: "From beyond" }), 401, CODE.signedOut);
    await refusedWith(await del(qm.id), 401, CODE.signedOut);

    expect(await namesOf(qm)).toEqual(before);
    expect(await resolveQuickMatchToken(qm.token), "friends keep the link until it expires").not.toBeNull();
  });

  it("a match past its expiry that the sweep has not reached (it expired mid-session): 404 on both verbs; it is neither renamed nor revived", async () => {
    const me = await account("expired");
    const qm = await createTypedMatch(null);
    await sql`update quick_matches set expires_at = now() - interval '1 minute' where id = ${qm.id}`;
    const before = await namesOf(qm);
    const state = await saveStateOf(qm.id);
    await signIn(me);

    await refusedWith(await patch(qm.id, { name: "Too late" }), 404, CODE.notInAccount);
    await refusedWith(await del(qm.id), 404, CODE.notInAccount);

    expect(await namesOf(qm)).toEqual(before);
    expect(await saveStateOf(qm.id), "never revived").toEqual(state);
  });
});

// The account list's two requests, sent through this route exactly as the island sends them: the client's method, path and body
// are what the route reads (a real seam), and each refusal reaches the person as its own line, in every locale.
describe.skipIf(!HAS_DB)("the account list's requests (my-list-requests.ts) through the real route", () => {
  /** A `fetch` that hands the island's request to the route file that serves its path, as Next would. */
  const sent: { method: string; path: string }[] = [];
  const viaRoute: typeof fetch = async (input, init) => {
    const url = new URL(String(input), ORIGIN);
    const match = /^\/api\/quick-match\/([^/]+)$/.exec(url.pathname);
    if (!match) throw new Error(`the island asked for ${url.pathname}, which app/api/quick-match/[id]/route.ts does not serve`);
    const method = init?.method ?? "GET";
    sent.push({ method, path: url.pathname });
    const req = new Request(url, init);
    const ctx = { params: Promise.resolve({ id: decodeURIComponent(match[1]!) }) };
    if (method === "PATCH") return PATCH(req, ctx);
    if (method === "DELETE") return DELETE(req, ctx);
    throw new Error(`the island sent ${method}, which the route does not answer`);
  };
  const line = (a: OwnerAnswer) => (a.ok ? null : a.key);

  it("rename then delete, as the saver taps them: both land, and the island hears each answer", async () => {
    const me = await account("island");
    const qm = await savedBy(me);
    const before = await namesOf(qm);
    await signIn(me);
    sent.length = 0;

    expect(await renameMyQuickMatch(qm.id, "  From the island  ", viaRoute)).toEqual({ ok: true, name: "From the island" });
    expectRenamed(await namesOf(qm), before, "From the island");
    expect(await deleteMyQuickMatch(qm.id, viaRoute)).toEqual({ ok: true });
    expect(await resolveQuickMatchToken(qm.token)).toBeNull();
    expect(sent).toEqual([
      { method: "PATCH", path: `/api/quick-match/${qm.id}` },
      { method: "DELETE", path: `/api/quick-match/${qm.id}` },
    ]);
  });

  it("every refusal the route answers reaches the person as its OWN line, present in all four languages", async () => {
    const me = await account("island-refusals");
    const staff = await account("island-staff");
    const mine = await savedBy(me);
    const theirs = await savedBy(staff);

    const answers: Record<string, string | null> = {};
    h.jar.clear();
    answers.signedOutRename = line(await renameMyQuickMatch(mine.id, "x", viaRoute));
    answers.signedOutDelete = line(await deleteMyQuickMatch(mine.id, viaRoute));
    const token = await createImpersonationToken(staff, me);
    await ImpersonatePage({ searchParams: Promise.resolve({ token }) }).catch(() => undefined);
    answers.renameImpersonated = line(await renameMyQuickMatch(mine.id, "x", viaRoute));
    answers.deleteImpersonated = line(await deleteMyQuickMatch(mine.id, viaRoute));
    await signIn(me);
    answers.invalid = line(await renameMyQuickMatch(mine.id, " ", viaRoute));
    answers.notInAccountRename = line(await renameMyQuickMatch(theirs.id, "Mine now", viaRoute));
    answers.notInAccountDelete = line(await deleteMyQuickMatch(theirs.id, viaRoute));

    // Each refusal's line, by its key (the plan's renameInvalid; one line per impersonated verb, the ledger carry).
    expect(answers).toEqual({
      signedOutRename: "quickMatch.me.signedOut",
      signedOutDelete: "quickMatch.me.signedOut",
      renameImpersonated: "quickMatch.me.renameImpersonating",
      deleteImpersonated: "quickMatch.me.deleteImpersonating",
      invalid: "quickMatch.me.renameInvalid",
      notInAccountRename: "quickMatch.me.notInAccount",
      notInAccountDelete: "quickMatch.me.notInAccount",
    });
    const keys = [...new Set(Object.values(answers))] as string[];
    expect(keys, "five refusals, five lines, none of them the generic one").toHaveLength(5);
    let checked = 0;
    for (const [locale, dict] of Object.entries({ en, es, fr, nl }) as [string, Record<string, string>][]) {
      for (const key of keys) {
        const text = tRuntime(dict, key, { max: NAME_MAX });
        expect([locale, key, typeof dict[key] === "string" && text.length > 0 && text !== key]).toEqual([locale, key, true]);
        checked++;
      }
    }
    expect(checked, "lines checked across the four dictionaries").toBe(keys.length * 4);
    // The bound in the invalid line is the plan's number.
    expect(tRuntime(en, "quickMatch.me.renameInvalid", { max: NAME_MAX })).toContain(String(NAME_MAX));
  });

  it("a fault and a broken network are the generic line, never a raw message", async () => {
    const me = await account("island-fault");
    const qm = await savedBy(me);
    await signIn(me);
    const failing: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const fiveHundred: typeof fetch = async () => new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 500 });

    expect(line(await renameMyQuickMatch(qm.id, "x", failing))).toBe("quickMatch.flash.generic");
    expect(line(await deleteMyQuickMatch(qm.id, failing))).toBe("quickMatch.flash.generic");
    expect(line(await renameMyQuickMatch(qm.id, "x", fiveHundred))).toBe("quickMatch.flash.generic");
    expect(line(await deleteMyQuickMatch(qm.id, fiveHundred))).toBe("quickMatch.flash.generic");
    expect((await saveStateOf(qm.id)).saved_by_user_id, "nothing happened to the match").toBe(me);
  });
});
