# Player Profile — Upcoming Matches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor on a player's public card sees that player's next scheduled matches across every public competition of the same org (plus the card's own competition), in one chronological "Upcoming" section above Matches.

**Architecture:** One new relational reader, `readPlayerUpcoming`, sits beside `readPlayerMatchSeeds` in `public-player-matches.ts`. It reuses that file's visibility joins, its opponent-masking pass, and the match centre's public seat namer. `data.ts` gets a thin, uncached `getPublicPlayerUpcoming` that the page calls only after `getPublicPlayer` has passed the gate. A server component, `PlayerUpcoming`, renders the rows, with the date helper moved out of the Matches client island so both can share it. It uses a native `<details>` for "Show N more".

**Tech Stack:** Next 16.2 (App Router, ISR), React server components, postgres.js, Tailwind v4, vitest (node env, real Postgres for DB tests), Playwright, `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-23-player-profile-upcoming-matches-design.md` (the spec header says "awaiting owner review". Get the owner's sign-off on it and on the plan-level decisions below before Task 1).

**Worktree:** `/Users/ashokhein/github/seazn.club-player-upcoming`, branch `feat/player-upcoming-matches`. Start **every** shell call with `cd /Users/ashokhein/github/seazn.club-player-upcoming &&`, because the cwd resets to the main checkout between calls, and a run from there tests `main`.

---

## Premise corrections (spec vs the tree, verified 2026-09-23 on `b369f3ed7`)

| # | Spec says | Tree says | Plan does |
|---|-----------|-----------|-----------|
| P1 | Opponent fallback is "the side's slot label (e.g. 'Winner of QF2')", and "TBD" is a new string | `fixtures.home_slot_label`/`away_slot_label` are **jsonb `{key, params}` i18n refs** (V360/V362), not display text. Public surfaces name a waiting seat through `publicRoundNamer(...).seat()` (`server/public-site/feeder-slot-label.ts`), whose fallback is the existing `ui` key `schedule.tbd` ("TBD" / "Por confirmar" / "À déterminer" / "NNB"). | Reuse the namer, the same way `match-centre-load.ts:346-387` does. **No new TBD key.** The reader takes `locale`. |
| P2 | Row reads "vs {opponent}" | Matches rows use `player.opponent` = "v {opponent}" (en), "vs. {opponent}" (es), "contre {opponent}" (fr), "tegen {opponent}" (nl) | Reuse `player.opponent` so the two sections read the same. |
| P3 | Source is `public_fixtures_v` joined to its division | `public_fixtures_v` does **not** hide archived divisions. Only `public_divisions_v` (V262/V268) does, which is why `readPlayerMatchSeeds` joins both. | Join `public_divisions_v` too. Add a test for the archived case. |
| P4 | "entrant status registered or confirmed" | V412 moved that filter **out** of `public_entrants_v`, so the view now publishes withdrawn entrants | Filter `entrants.status` in the membership CTE. Opponent names still come through `public_entrants_v` and the masking pass. |
| P5 | Mutation "drop NULLS LAST ⇒ ordering test goes red" | Postgres already sorts `ASC` with **NULLS LAST by default**, so that mutant is equivalent and cannot go red | Use the mutant `nulls first` instead. |
| P6 | "Dates/times formatted with the same helper … as the Matches section" | That helper (`formatIn`) is private to `player-matches.tsx`, which is `"use client"`. A server component that imports a function from a client module receives a client *reference* and cannot call it. | Move it to `lib/public-date-locale.ts` as `formatPublicInstant` (no imports, so it stays isomorphic). Both components import it. |
| P7 | Loader input is `orgId, personId, currentCompetitionId, now` | Hrefs need the org slug, and seat labels need the org locale | Input also takes `orgSlug` and `locale`. |
| P8 | "the same naming the existing Matches rows use" | That is `maskedOpponentNames` → `maskPublicEntrantNames`, applied per division policy (youth / `player_name_display`) | Widen `maskedOpponentNames`' parameter to the six fields it reads, and reuse it. |

## Plan-level decisions (the owner should confirm them; each is reversible)

- **D1: finished places are not upcoming.** A competition with `status in ('completed','archived')` or a division with `status = 'completed'` contributes no rows. The spec does not mention this. Without it, a finished event's undated leftover fixtures would read "Time TBD" on every card forever. See Review Focus 1.
- **D2: "Show N more" is a native `<details>/<summary>`** inside the server component, not a client island. It needs no JS and no dictionary slice sent to the client (`player-matches-dict.ts` exists because an island's `dict` prop gets serialised). The rows are server-rendered and stay in the DOM while collapsed.
- **D3: `getPublicPlayerUpcoming` is uncached.** Its only freshness bound is the page's ISR (measured `s-maxage=30`, see `publicPlayerGate`'s comment). No tag could cover it: a schedule write in *another* competition fires that competition's tags, and none of them is on this card's entry. The cost is one indexed query per ISR regeneration, plus one masking pass.
- **D4: layout.** On desktop, Upcoming and Matches share the left 7-column cell (one new wrapper, `data-testid="player-main-column"`). Upcoming renders first, and nothing renders when there are no rows.

## Global Constraints

- **R1:** same org only. Never read `persons.user_id` or claims.
- **R2:** show `public` competitions, plus the card's own competition whatever its visibility. A foreign `unlisted` competition never appears. `private` never appears.
- **R3:** show `status = 'scheduled'` only. Dated rows come first (ascending), then undated rows labelled "Time TBD". Show 5, then "Show N more". `in_play` is excluded.
- **Staleness:** exclude a row when `scheduled_at < now − 3 hours`. Keep `scheduled_at IS NULL` rows.
- **Order:** `scheduled_at ASC NULLS LAST, round_no, seq_in_round, id`, with a safety cap of 50.
- **R4:** Upcoming is its own section **above** Matches. Each row names competition › division, and rows from another competition carry an "Other event" chip.
- **Links:** the whole row links to `/shared/{orgSlug}/{thatCompetitionSlug}/{divisionSlug}/fixtures/{fixtureId}`.
- **Empty:** no rows means no section and no empty state.
- **Gates** are unchanged: `publicPlayerGate` (the entitlement for the *current* competition, plus `public_name` consent). Other competitions' entitlements are not checked.
- **i18n:** new strings go into all 4 `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`. Then run `pnpm i18n:gen-keys`, because `apps/web/src/lib/i18n-keys.ts` is generated and CI diffs it.
- **UI:** one DOM, phone-first. No horizontal page scroll at 320 / 768 / 1280. Put `min-w-0` on the whole truncation chain.
- **Repo:** use pnpm, never npm. `grep -a`. No `git stash`, because the stash stack is shared with the main checkout. Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Write each commit message to a file and use `git commit -F`; heredocs are blocked in worktrees.
- **Vitest:** trust only the JSON reporter. Delete the output file before each run, then check `numPassedTests`/`numTotalTests`, `numPendingTests == 0`, and the resolved `.testResults[].name` paths. Only `cd apps/web && npx vitest run <exact path>` is valid, because positionals are literal filename filters.
- **tsc / lint:** run both through `rtk proxy`. The plain wrapper hides lint output and rewrites `pnpm exec tsc`.

## Review Focus

1. **A finished competition or division with undated leftover `scheduled` fixtures.** Someone reading the card expects nothing from an event that is over. Without D1 those rows would say "Time TBD" forever. *Test: Task 1, "finished and archived places are not upcoming".*
2. **A sibling competition's archived division.** Archived divisions 404 on the public site, so their fixtures must not be listed and linked into a dead page. *Test: Task 1, same test.*
3. **A bracket seat still waiting on a feeder, and a youth pair opponent.** The row must read the public round-named label ("Winner of Group A"), or the localised TBD, never a raw key or a UUID. A youth division's pair must be masked exactly as on the division page. *Test: Task 1, "opponent: the masked entrant name, else the seat's public label, else the localised TBD".*
4. **Realistically long competition, division and opponent names at 320px.** They should truncate, never cause horizontal scroll. *Test: Task 4 e2e, long seeded names plus `expectNoHorizontalScroll` at 320/768/1280.*
5. **The sibling row's link.** It must use the sibling's own competition slug. A link built with the current card's slug renders the wrong competition's chrome or 404s. *Test: Task 1 "flags ONLY the other competition's row…", and the Task 4 e2e row click.*

---

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `apps/web/src/server/public-site/public-player-matches.ts` | Modify | Add the `readPlayerUpcoming` reader, its row type and its constants. Widen `maskedOpponentNames`' parameter type. |
| `apps/web/src/server/public-site/data.ts` | Modify | Add `getPublicPlayerUpcoming`, a lazy-import wrapper (same cycle rule as `getPublicPlayer`). |
| `apps/web/src/server/public-site/__tests__/public-player-upcoming.test.ts` | Create | DB integration tests for the reader and the wrapper. |
| `apps/web/src/lib/public-date-locale.ts` | Modify | Add `formatPublicInstant` (moved out of `player-matches.tsx`). |
| `apps/web/src/lib/__tests__/public-date-locale.test.ts` | Modify | Add tests for `formatPublicInstant`. |
| `apps/web/src/components/public-site/player-matches.tsx` | Modify | Delete the local `formatIn` and import the shared helper instead. No behaviour change. |
| `apps/web/src/components/public-site/player-upcoming.tsx` | Create | `PlayerUpcoming` server component. |
| `apps/web/src/components/public-site/__tests__/player-upcoming.test.tsx` | Create | Static-markup tests for the component. |
| `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` | Modify | Add 4 keys. |
| `apps/web/src/lib/i18n-keys.ts` | Regenerate | Only via `pnpm i18n:gen-keys`. |
| `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx` | Modify | Mount the section above Matches. |
| `…/players/[personId]/__tests__/page.test.tsx` | Modify | Add the data mock, the Upcoming tests and the column test. |
| `apps/web/e2e/player-upcoming.spec.ts` | Create | Browser proof: order, chip, R2, show-more, link, widths. Runs in the `parallel` project; it is **not** a `walkthrough/` spec, so the `WALKTHROUGH_SPECS` registry does not apply. |
| `scripts/smoke.ts` | Modify | Two checks in `passGrantsSuite`. |

---

### Task 1: The reader, `readPlayerUpcoming`, and the gate-side wrapper

**Files:**
- Modify: `apps/web/src/server/public-site/public-player-matches.ts`. Add imports at the top (around lines 46-67). Retype `maskedOpponentNames` (at the end of the file, ~`:642`). Append the Upcoming section at the end.
- Modify: `apps/web/src/server/public-site/data.ts`. Change the type import at `:34`, and add the wrapper right after the closing brace of `getPublicPlayer` (anchor: `export async function getPublicPlayer(`).
- Create: `apps/web/src/server/public-site/__tests__/public-player-upcoming.test.ts`

**Interfaces:**
- Consumes: `maskPublicEntrantNames` (data.ts), `publicRoundNamer` / `NamedFixture` (feeder-slot-label.ts), `resolveSlotLabel` / `SlotLabelLookup` (lib/slot-label.ts), `msgFor` (lib/messages-i18n.ts), `routes.sharedFixture`, `isoDateTime`, `resolveVenueTz`, `getDictionary`.
- Produces (later tasks rely on these exact names):
  - `export interface PlayerUpcomingRow { fixtureId: string; href: string; scheduledAt: string | null; tz: string; venue: string | null; courtLabel: string | null; opponentLabel: string; competitionName: string; competitionSlug: string; divisionName: string; divisionSlug: string; isOtherCompetition: boolean }`
  - `export type UpcomingArgs = { orgId: string; orgSlug: string; personId: string; currentCompetitionId: string; locale: Locale; now: Date }`
  - `export const UPCOMING_STALE_AFTER_MS = 3 * 60 * 60 * 1000`, `export const UPCOMING_SAFETY_CAP = 50`
  - `export async function readPlayerUpcoming(sql: Sql, args: UpcomingArgs): Promise<PlayerUpcomingRow[]>`
  - data.ts: `export async function getPublicPlayerUpcoming(args: { org: PublicOrg; competition: PublicCompetition; personId: string; now?: Date }): Promise<PlayerUpcomingRow[]>`

- [ ] **Step 0: Environment (once per session; `~/.claude/skills/seazn-local-env/SKILL.md`)**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && pnpm install --frozen-lockfile
cd /Users/ashokhein/github/seazn.club-player-upcoming && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label player-upcoming
```

`up` runs `db:apply` **and** `sync:sports`. `db:apply` alone is not a fresh schema. Confirm that `status` prints `tree /Users/ashokhein/github/seazn.club-player-upcoming`. Every vitest call below starts with `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label player-upcoming)"` **in the same call**, because the environment does not persist between calls.

- [ ] **Step 1: Write the failing test file**

Create `apps/web/src/server/public-site/__tests__/public-player-upcoming.test.ts`:

```ts
// Player profile — upcoming matches across the org
// (docs/superpowers/specs/2026-09-23-player-profile-upcoming-matches-design.md,
//  plan docs/superpowers/plans/2026-09-23-player-profile-upcoming-matches.md).
//
// DB-only: seeds ONE scene in beforeAll and asks `readPlayerUpcoming` about it.
// Every exclusion test states its PREMISE first — the fixture exists, has Ada on
// a side, carries the status the test is about — so an absent row is about the
// rule under test, never about a fixture the query could not see anyway.
// Expected strings are derived from the dictionaries and the one masking
// function, never typed as a table.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>) => fn,
  revalidateTag: vi.fn(),
}));

import enUi from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { resolveVenueTz } from "@/lib/tz";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db/append-event";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { getPublicPlayerUpcoming, maskPublicEntrantNames, type PublicCompetition, type PublicOrg } from "../data";
import { readPlayerUpcoming, UPCOMING_STALE_AFTER_MS, type PlayerUpcomingRow } from "../public-player-matches";

const HAS_DB = !!process.env.DATABASE_URL;
const HOUR = 60 * 60 * 1000;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

type FixtureRow = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
type Side = { kind: "individual" | "pair"; name: string; members: string[] };
interface League {
  divisionId: string;
  slug: string;
  entrantIds: string[];
  fixtures: FixtureRow[];
}
interface Comp {
  id: string;
  slug: string;
  name: string;
}

interface Scene {
  orgId: string;
  orgSlug: string;
  now: Date;
  ada: string;
  cur: Comp;
  sib: Comp;
  unl: Comp;
  prv: Comp;
  slugs: { singles: string; sib: string };
  doublesDivisionId: string;
  pairOpponent: { id: string; raw: string };
  f: Record<
    | "di" | "bo" | "cy" | "hal" | "ian" | "jo" | "pair" | "seatNamed" | "seatTbd" | "setup"
    | "withdrawn" | "doneDivision" | "ned" | "archived" | "oli" | "pat" | "oldComp" | "foreign",
    string
  >;
}

let scene: Scene;

const member = (personId: string) => ({
  person_id: personId,
  squad_number: null,
  default_position_key: null,
  is_captain: false,
  roles: [] as string[],
});

async function seedPerson(orgId: string, fullName: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, consent)
    values (${orgId}, ${fullName}, '2000-04-03', 'f', ${sql.json({ public_name: true })})
    returning id`;
  return id;
}

async function openOrg(label: string): Promise<{ orgId: string; orgSlug: string; auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `pup-${label}-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${`PUP ${label} ${suffix}`}, ${orgSlug}) returning id`;
  await setOrgPlan(orgId);
  // No caps: a create over a cap silently comes back PRIVATE, which would make
  // every visibility test pass for the wrong reason (premise asserted in seed()).
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test'),
           (${orgId}, 'dashboard.public.max', 50, 'test')`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function league(auth: AuthCtx, competitionId: string, slug: string, sides: Side[], start = true): Promise<League> {
  const division = await createDivision(auth, competitionId, {
    name: slug,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const created = (await createEntrants(
    auth,
    division.id,
    sides.map((s, i) => ({ kind: s.kind, display_name: s.name, seed: i + 1, members: s.members.map(member) })) as never,
  )) as { id: string }[];
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: slug, config: {} });
  await generateStageFixtures(auth, stage!.id);
  if (start) await startDivision(auth, division.id);
  const [{ slug: stored }] = await sql<{ slug: string }[]>`select slug from divisions where id = ${division.id}`;
  const fixtures = await sql<FixtureRow[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where division_id = ${division.id}`;
  return { divisionId: division.id, slug: stored, entrantIds: created.map((e) => e.id), fixtures };
}

function vs(l: League, a: number, b: number): string {
  const [x, y] = [l.entrantIds[a]!, l.entrantIds[b]!];
  const row = l.fixtures.find(
    (f) => (f.home_entrant_id === x && f.away_entrant_id === y) || (f.home_entrant_id === y && f.away_entrant_id === x),
  );
  if (!row) throw new Error(`seed: no fixture between entrants ${a} and ${b} in ${l.slug}`);
  return row.id;
}

const at = (fixtureId: string, when: Date) =>
  sql`update fixtures set scheduled_at = ${when.toISOString()} where id = ${fixtureId}`;

/** The real write path: core.start puts a fixture in play; a result decides it. */
async function play(orgId: string, fixtureId: string, finish: boolean): Promise<void> {
  await appendEvent(orgId, fixtureId, 0, { type: "core.start", payload: {}, recordedBy: null });
  if (finish) {
    await appendEvent(orgId, fixtureId, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 1 }, recordedBy: null });
  }
}

async function seed(): Promise<Scene> {
  const now = new Date();
  const inHours = (h: number) => new Date(now.getTime() + h * HOUR);
  const { orgId, orgSlug, auth } = await openOrg("main");
  await sql`update organizations set timezone = 'Europe/London' where id = ${orgId}`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;

  const ada = await seedPerson(orgId, "Ada Quill");
  const adaSide = (): Side => ({ kind: "individual", name: "Ada Quill", members: [ada] });
  const opponent = async (name: string): Promise<Side> => ({ kind: "individual", name, members: [await seedPerson(orgId, name)] });
  const comp = async (name: string, visibility: "public" | "unlisted" | "private"): Promise<Comp> => {
    const c = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: `${name} ${randomUUID().slice(0, 6)}`,
      visibility,
      branding: {},
    });
    return { id: c.id, slug: c.slug, name: c.name };
  };
  const cur = await comp("Current Cup", "public");
  const sib = await comp("Sibling League", "public");
  const unl = await comp("Unlisted Open", "unlisted");
  const prv = await comp("Private Friendly", "private");
  const old = await comp("Old Cup", "public");
  const landed = await sql<{ id: string; visibility: string }[]>`
    select id, visibility from competitions where id in ${sql([cur.id, sib.id, unl.id, prv.id, old.id])}`;
  const vis = Object.fromEntries(landed.map((r) => [r.id, r.visibility]));
  // Premise: nothing degraded to private under a cap.
  expect([vis[cur.id], vis[sib.id], vis[unl.id], vis[prv.id], vis[old.id]]).toEqual([
    "public", "public", "unlisted", "private", "public",
  ]);

  // ---- CUR singles: Ada v six opponents, one per rule --------------------------
  const singles = await league(auth, cur.id, "singles", [
    adaSide(),
    ...(await Promise.all(["Bo Birch", "Cy Cole", "Di Dunn", "Hal Hart", "Ian Ives", "Jo Jay"].map(opponent))),
  ]);
  const [bo, cy, di, hal, ian, jo] = [1, 2, 3, 4, 5, 6].map((n) => vs(singles, 0, n)) as [string, string, string, string, string, string];
  await at(bo, inHours(48));
  await sql`update fixtures set court_label = 'Court 3', venue = 'Riverside Hall' where id = ${bo}`;
  await at(cy, inHours(24));
  await play(orgId, cy, false); // in_play
  await at(di, inHours(-2)); // inside the 3h grace
  await at(hal, inHours(-4)); // stale
  await at(ian, inHours(30));
  await play(orgId, ian, true); // decided
  await at(jo, inHours(36));
  await sql`update fixtures set status = 'cancelled' where id = ${jo}`;
  await sql`
    insert into schedule_settings (division_id, org_id, tz) values (${singles.divisionId}, ${orgId}, 'America/New_York')
    on conflict (division_id) do update set tz = excluded.tz`;

  // ---- CUR doubles: a PAIR membership, in a YOUTH division ---------------------
  const [ed, fi, gus] = [await seedPerson(orgId, "Ed Ennis"), await seedPerson(orgId, "Fiona Grant"), await seedPerson(orgId, "Gus Hale")];
  const pairRaw = "Fiona Grant & Gus Hale";
  const doubles = await league(auth, cur.id, "doubles", [
    { kind: "pair", name: "Ada Quill & Ed Ennis", members: [ada, ed] },
    { kind: "pair", name: pairRaw, members: [fi, gus] },
  ]);
  await sql`update divisions set youth = true, player_name_display = 'first_initial' where id = ${doubles.divisionId}`;
  const pair = vs(doubles, 0, 1);
  await at(pair, inHours(72));

  // ---- CUR seats: Ada HOME, the away seat empty — labelled once, bare once -----
  const seats = await league(auth, cur.id, "seats", [adaSide(), await opponent("Lu Lane"), await opponent("Mo Moss")]);
  const seatNamed = vs(seats, 0, 1);
  const seatTbd = vs(seats, 0, 2);
  for (const id of [seatNamed, seatTbd]) {
    await sql`update fixtures set home_entrant_id = ${seats.entrantIds[0]!}, away_entrant_id = null where id = ${id}`;
  }
  await sql`update fixtures set away_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })}
            where id = ${seatNamed}`;
  await at(seatNamed, inHours(144));
  await at(seatTbd, inHours(168));

  // ---- CUR setup: generated, never started — the view withholds time/court ------
  const setupL = await league(auth, cur.id, "setup", [adaSide(), await opponent("Quin Rowe")], false);
  const setup = vs(setupL, 0, 1);
  await at(setup, inHours(12));
  await sql`update fixtures set court_label = 'Court 9' where id = ${setup}`;

  // ---- CUR withdrawn: Ada's entrant withdrew, the fixture was left scheduled ----
  const wd = await league(auth, cur.id, "withdrawn", [adaSide(), await opponent("Kim Knox")]);
  const withdrawn = vs(wd, 0, 1);
  await at(withdrawn, inHours(20));
  await sql`update entrants set status = 'withdrawn' where id = ${wd.entrantIds[0]!}`;

  // ---- CUR completed division, undated leftover (Review Focus 1) ----------------
  const done = await league(auth, cur.id, "done", [adaSide(), await opponent("Sy Stone")]);
  const doneDivision = vs(done, 0, 1);
  await sql`update divisions set status = 'completed' where id = ${done.divisionId}`;

  // ---- SIB: public sibling, own venue zone; plus an ARCHIVED division ------------
  const sibL = await league(auth, sib.id, "sib-open", [adaSide(), await opponent("Ned North")]);
  const ned = vs(sibL, 0, 1);
  await at(ned, inHours(26));
  await sql`
    insert into schedule_settings (division_id, org_id, tz) values (${sibL.divisionId}, ${orgId}, 'Asia/Kolkata')
    on conflict (division_id) do update set tz = excluded.tz`;
  const arch = await league(auth, sib.id, "sib-archived", [adaSide(), await opponent("Tia Todd")]);
  const archived = vs(arch, 0, 1);
  await at(archived, inHours(28));
  await sql`update divisions set archived_at = now() where id = ${arch.divisionId}`;

  // ---- UNL / PRV / OLD ------------------------------------------------------------
  const unlL = await league(auth, unl.id, "unl-open", [adaSide(), await opponent("Oli Otter")]);
  const oli = vs(unlL, 0, 1);
  await at(oli, inHours(1));
  const prvL = await league(auth, prv.id, "prv-open", [adaSide(), await opponent("Pat Pike")]);
  const pat = vs(prvL, 0, 1);
  await at(pat, inHours(1));
  const oldL = await league(auth, old.id, "old-open", [adaSide(), await opponent("Rae Reed")]);
  const oldComp = vs(oldL, 0, 1); // undated leftover
  await sql`update competitions set status = 'completed' where id = ${old.id}`;

  // ---- ANOTHER ORG, with Ada on one of its rosters -------------------------------
  const other = await openOrg("other");
  const otherComp = await createCompetition(other.auth, {
    ends_on: "2030-12-31",
    name: `Elsewhere ${randomUUID().slice(0, 6)}`,
    visibility: "public",
    branding: {},
  });
  const foreignL = await league(other.auth, otherComp.id, "foreign", [
    { kind: "individual", name: "Xen Yu", members: [await seedPerson(other.orgId, "Xen Yu")] },
    { kind: "individual", name: "Yul Zed", members: [await seedPerson(other.orgId, "Yul Zed")] },
  ]);
  const foreign = foreignL.fixtures[0]!.id;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${foreignL.entrantIds[0]!}, ${ada}, ${other.orgId})`;
  await at(foreign, inHours(4));

  return {
    orgId,
    orgSlug,
    now,
    ada,
    cur,
    sib,
    unl,
    prv,
    slugs: { singles: singles.slug, sib: sibL.slug },
    doublesDivisionId: doubles.divisionId,
    pairOpponent: { id: doubles.entrantIds[1]!, raw: pairRaw },
    f: { di, bo, cy, hal, ian, jo, pair, seatNamed, seatTbd, setup, withdrawn, doneDivision, ned, archived, oli, pat, oldComp, foreign },
  };
}

const read = (current: string, over: { personId?: string; now?: Date } = {}) =>
  readPlayerUpcoming(sql, {
    orgId: scene.orgId,
    orgSlug: scene.orgSlug,
    personId: over.personId ?? scene.ada,
    currentCompetitionId: current,
    locale: "en",
    now: over.now ?? scene.now,
  });
const ids = (rows: PlayerUpcomingRow[]) => rows.map((r) => r.fixtureId);
const byId = (rows: PlayerUpcomingRow[], id: string) => {
  const row = rows.find((r) => r.fixtureId === id);
  if (!row) throw new Error(`row ${id} missing`);
  return row;
};

/** Premise: the fixture exists, has Ada on a side, and carries its status. */
async function premise(fixtureId: string) {
  const [row] = await sql<{ status: string; scheduled_at: Date | null; ada_side: boolean }[]>`
    select f.status, f.scheduled_at,
           exists (select 1 from entrant_members em
                   where em.person_id = ${scene.ada}
                     and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)) as ada_side
    from fixtures f where f.id = ${fixtureId}`;
  if (!row) throw new Error(`premise: fixture ${fixtureId} not found`);
  return row;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 180_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("readPlayerUpcoming against real Postgres", () => {
  it("EMPTY: a person with no fixtures has no upcoming rows", async () => {
    expect(await read(scene.cur.id, { personId: randomUUID() })).toEqual([]);
  });

  it("lists Ada's scheduled fixtures across the org — ONE merged sort, dated ascending, then undated", async () => {
    const f = scene.f;
    // Ned (another competition) sits BETWEEN two of the card's own rows: the
    // list is one sort, not the card's competition first.
    expect(ids(await read(scene.cur.id))).toEqual([f.di, f.ned, f.bo, f.pair, f.seatNamed, f.seatTbd, f.setup]);
  });

  it("flags ONLY the other competition's row, and links every row under its OWN competition's slug", async () => {
    const rows = await read(scene.cur.id);
    expect(rows.filter((r) => r.isOtherCompetition).map((r) => r.fixtureId)).toEqual([scene.f.ned]);
    expect(byId(rows, scene.f.ned)).toMatchObject({
      href: `/shared/${scene.orgSlug}/${scene.sib.slug}/${scene.slugs.sib}/fixtures/${scene.f.ned}`,
      competitionSlug: scene.sib.slug,
      competitionName: scene.sib.name,
      divisionSlug: scene.slugs.sib,
    });
    expect(byId(rows, scene.f.bo)).toMatchObject({
      href: `/shared/${scene.orgSlug}/${scene.cur.slug}/${scene.slugs.singles}/fixtures/${scene.f.bo}`,
      isOtherCompetition: false,
      courtLabel: "Court 3",
      venue: "Riverside Hall",
    });
  });

  it("R2: an UNLISTED sibling never reaches another competition's card", async () => {
    expect(await premise(scene.f.oli)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.oli);
  });

  it("R2: …but its OWN card lists it, beside the org's public rows flagged as other events (the positive pair)", async () => {
    const rows = await read(scene.unl.id);
    expect(byId(rows, scene.f.oli).isOtherCompetition).toBe(false);
    expect(byId(rows, scene.f.bo).isOtherCompetition).toBe(true);
    expect(byId(rows, scene.f.ned).isOtherCompetition).toBe(true);
  });

  it("R2: a PRIVATE competition never appears, even named as the card's own", async () => {
    expect(await premise(scene.f.pat)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.pat);
    expect(ids(await read(scene.prv.id))).not.toContain(scene.f.pat);
  });

  it("R3: in-play, decided and cancelled fixtures are excluded — only 'scheduled' is upcoming", async () => {
    expect((await premise(scene.f.cy)).status).toBe("in_play");
    expect((await premise(scene.f.ian)).status).toBe("decided");
    expect((await premise(scene.f.jo)).status).toBe("cancelled");
    const got = ids(await read(scene.cur.id));
    for (const id of [scene.f.cy, scene.f.ian, scene.f.jo]) expect(got).not.toContain(id);
  });

  it("staleness: a slot 2h past is still upcoming, one 4h past is not — and the window moves with `now`", async () => {
    expect(UPCOMING_STALE_AFTER_MS).toBe(3 * HOUR); // the spec's value
    const got = ids(await read(scene.cur.id));
    expect(got).toContain(scene.f.di);
    expect(got).not.toContain(scene.f.hal);
    const later = new Date(scene.now.getTime() + 2 * HOUR);
    expect(ids(await read(scene.cur.id, { now: later }))).not.toContain(scene.f.di);
  });

  it("a division still in SETUP: time and court withheld, and the row sorts after every dated one", async () => {
    const p = await premise(scene.f.setup);
    expect(p.scheduled_at).not.toBeNull(); // the BASE row is dated; the view withholds it
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.setup)).toMatchObject({ scheduledAt: null, courtLabel: null, venue: null });
    expect(rows.at(-1)!.fixtureId).toBe(scene.f.setup);
    // Its base time (+12h) is EARLIER than Bo's (+48h): last place is NULLS LAST, not its time.
    expect(p.scheduled_at!.getTime()).toBeLessThan(Date.parse(byId(rows, scene.f.bo).scheduledAt!));
  });

  it("membership: a WITHDRAWN entrant's fixture is gone", async () => {
    expect(await premise(scene.f.withdrawn)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.withdrawn);
  });

  it("R1: another org's fixture never appears, even with Ada on its roster", async () => {
    expect(await premise(scene.f.foreign)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.foreign);
  });

  it("finished and archived places are not upcoming: an archived division, a completed division, a completed competition", async () => {
    const gone = [scene.f.archived, scene.f.doneDivision, scene.f.oldComp];
    for (const id of gone) expect(await premise(id), id).toMatchObject({ status: "scheduled", ada_side: true });
    const got = ids(await read(scene.cur.id));
    for (const id of gone) expect(got, id).not.toContain(id);
  });

  it("opponent: the masked entrant name, else the seat's public label, else the localised TBD", async () => {
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.bo).opponentLabel).toBe("Bo Birch");
    const [masked] = await maskPublicEntrantNames(
      [{ id: scene.pairOpponent.id, kind: "pair", display_name: scene.pairOpponent.raw }],
      { youth: true, player_name_display: "first_initial" },
    );
    expect(masked!.display_name, "premise: this division's policy changes the name").not.toBe(scene.pairOpponent.raw);
    expect(byId(rows, scene.f.pair).opponentLabel).toBe(masked!.display_name);
    expect(byId(rows, scene.f.seatNamed).opponentLabel).toBe(enUi["slot.winner_group"].replace("{g}", "A"));
    expect(byId(rows, scene.f.seatTbd).opponentLabel).toBe(enUi["schedule.tbd"]);
  });

  it("each row carries ITS division's venue zone", async () => {
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.bo).tz).toBe("America/New_York");
    expect(byId(rows, scene.f.ned).tz).toBe("Asia/Kolkata");
    const [ss] = await sql<{ tz: string }[]>`select tz from schedule_settings where division_id = ${scene.doublesDivisionId}`;
    expect(byId(rows, scene.f.pair).tz).toBe(resolveVenueTz(ss?.tz ?? null, "Europe/London"));
  });

  it("getPublicPlayerUpcoming reads for the CARD's org and competition", async () => {
    const org = { id: scene.orgId, slug: scene.orgSlug, default_locale: "en" } as PublicOrg;
    const onSib = await getPublicPlayerUpcoming({
      org,
      competition: { id: scene.sib.id } as PublicCompetition,
      personId: scene.ada,
      now: scene.now,
    });
    // From SIB's card, Ned is home and the CUR rows are the other events.
    expect(byId(onSib, scene.f.ned).isOtherCompetition).toBe(false);
    expect(byId(onSib, scene.f.bo).isOtherCompetition).toBe(true);
    expect(ids(onSib)).toEqual(ids(await read(scene.sib.id)));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label player-upcoming)" && OUT=${TMPDIR:-/tmp}/pu-t1.json && rm -f $OUT && cd apps/web && npx vitest run src/server/public-site/__tests__/public-player-upcoming.test.ts --reporter=json --outputFile=$OUT; echo "EXIT=$?"; jq '{passed:.numPassedTests,total:.numTotalTests,pending:.numPendingTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name],msg:[.testResults[].message][0:1]}' $OUT
```

Expected: the suite fails to COLLECT, with a message naming `readPlayerUpcoming` / `getPublicPlayerUpcoming` as not exported (`failedSuites: 1`). If `pending` is > 0 and `total` > 0, `DATABASE_URL` did not reach vitest. That is an environment fault, not a pass.

- [ ] **Step 3: Implement the reader**

In `apps/web/src/server/public-site/public-player-matches.ts`, add these to the imports (keep the existing ones):

```ts
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { publicRoundNamer, type NamedFixture } from "./feeder-slot-label";
```

Retype `maskedOpponentNames`. Replace its signature line:

```ts
async function maskedOpponentNames(sql: Sql, rows: readonly MatchRow[]): Promise<Map<string, string>> {
```

with:

```ts
/** The six fields the masking pass reads — a Matches seed row and an Upcoming
 *  row both carry them, so both go through the ONE masking decision. */
type OpponentPolicyRow = Pick<
  MatchRow,
  "my_entrant_id" | "home_entrant_id" | "away_entrant_id" | "division_id" | "youth" | "player_name_display"
>;

async function maskedOpponentNames(sql: Sql, rows: readonly OpponentPolicyRow[]): Promise<Map<string, string>> {
```

Append at the end of the file:

```ts
// ---------------------------------------------------------------------------
// UPCOMING — docs/superpowers/specs/2026-09-23-player-profile-upcoming-matches-design.md
//
// The person's next SCHEDULED fixtures across every public competition of the
// card's org, plus the card's own competition whatever its visibility (R2: an
// unlisted sibling on another card would publish its link; private is already
// gone from the views). The visibility gate is the JOIN, as in the reader
// above: `public_fixtures_v` AND `public_divisions_v` (the fixture view alone
// keeps an archived division). A finished place is not upcoming (plan D1): a
// completed/archived competition or a completed division contributes nothing,
// or its undated leftovers would read "Time TBD" forever.
//
// Membership is the ROSTER (`entrant_members` of a registered/confirmed
// entrant): a future fixture is nobody's by lineup yet. V412 moved the status
// filter out of `public_entrants_v`, so it is applied to `entrants` here.
//
// Plain JSON and folds nothing. The caller (`getPublicPlayerUpcoming`) holds no
// cache of it: see plan D3.
// ---------------------------------------------------------------------------

/** One scheduled fixture on the player card's Upcoming list. */
export interface PlayerUpcomingRow {
  fixtureId: string;
  /** The fixture's public match centre, under ITS OWN competition's slug. */
  href: string;
  /** ISO instant; null when undated or its division has not released its schedule. */
  scheduledAt: string | null;
  /** The VENUE zone (`resolveVenueTz`), for formatting `scheduledAt`. */
  tz: string;
  venue: string | null;
  courtLabel: string | null;
  /** The other side: its masked public name, else its seat's public label, else the localised TBD. */
  opponentLabel: string;
  competitionName: string;
  competitionSlug: string;
  divisionName: string;
  divisionSlug: string;
  /** True when the fixture belongs to a competition other than the card's. */
  isOtherCompetition: boolean;
}

export type UpcomingArgs = {
  orgId: string;
  orgSlug: string;
  personId: string;
  /** The competition whose card is being rendered (R2's exception). */
  currentCompetitionId: string;
  /** The ORG's locale — seat labels are rendered in it, like every word on the card. */
  locale: Locale;
  now: Date;
};

/** A scheduled fixture whose slot passed this long ago without being scored is not "upcoming". */
export const UPCOMING_STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** A safety cap on the read. The five-row cut is the component's. */
export const UPCOMING_SAFETY_CAP = 50;

interface UpcomingDbRow {
  id: string;
  stage_id: string;
  scheduled_at: unknown;
  venue: string | null;
  court_label: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  division_id: string;
  division_name: string;
  division_slug: string;
  youth: boolean;
  player_name_display: string | null;
  division_tz: string | null;
  org_tz: string | null;
  competition_id: string;
  competition_name: string;
  competition_slug: string;
  my_entrant_id: string;
}

/** Every scheduled fixture the person is rostered into across the org, soonest
 *  first, undated last. Empty → []. */
export async function readPlayerUpcoming(sql: Sql, args: UpcomingArgs): Promise<PlayerUpcomingRow[]> {
  const { orgId, orgSlug, personId, currentCompetitionId, locale, now } = args;
  const cutoff = new Date(now.getTime() - UPCOMING_STALE_AFTER_MS);
  const rows = await sql<UpcomingDbRow[]>`
    with mine as (
      select e.id
      from entrant_members em
      join entrants e on e.id = em.entrant_id
      where em.person_id = ${personId}
        and e.status in ('registered','confirmed')
    )
    select f.id, f.stage_id, f.scheduled_at, f.venue, f.court_label,
           f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           d.id as division_id, d.name as division_name, d.slug as division_slug,
           dv.youth, dv.player_name_display,
           ss.tz as division_tz, o.timezone as org_tz,
           c.id as competition_id, c.name as competition_name, c.slug as competition_slug,
           case when f.home_entrant_id in (select id from mine) then f.home_entrant_id
                else f.away_entrant_id end as my_entrant_id
    from public_fixtures_v f
    join public_divisions_v d    on d.id = f.division_id
    join divisions dv            on dv.id = d.id
    join public_competitions_v c on c.id = d.competition_id
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o      on o.id = c.org_id
    where (f.home_entrant_id in (select id from mine) or f.away_entrant_id in (select id from mine))
      and c.org_id = ${orgId}
      and (c.visibility = 'public' or c.id = ${currentCompetitionId})
      and c.status not in ('completed','archived')
      and d.status <> 'completed'
      and f.status = 'scheduled'
      and (f.scheduled_at is null or f.scheduled_at >= ${cutoff.toISOString()})
    order by f.scheduled_at asc nulls last, f.round_no, f.seq_in_round, f.id
    limit ${UPCOMING_SAFETY_CAP}`;
  if (rows.length === 0) return [];

  const names = await maskedOpponentNames(sql, rows);
  const seatOf = await opponentSeatNamer(sql, rows, locale);
  return rows.map((r) => {
    const mineHome = r.my_entrant_id === r.home_entrant_id;
    const opponentId = mineHome ? r.away_entrant_id : r.home_entrant_id;
    const named = opponentId !== null ? names.get(opponentId) : undefined;
    return {
      fixtureId: r.id,
      href: routes.sharedFixture(orgSlug, r.competition_slug, r.division_slug, r.id),
      scheduledAt: isoDateTime(r.scheduled_at),
      tz: resolveVenueTz(r.division_tz, r.org_tz),
      venue: r.venue,
      courtLabel: r.court_label,
      opponentLabel: named ?? seatOf(r, mineHome ? "away" : "home"),
      competitionName: r.competition_name,
      competitionSlug: r.competition_slug,
      divisionName: r.division_name,
      divisionSlug: r.division_slug,
      isOtherCompetition: r.competition_id !== currentCompetitionId,
    };
  });
}

/**
 * A waiting seat's PUBLIC text: the match centre's rule (`match-centre-load.ts`,
 * fix round N1), which is `publicRoundNamer(...).seat()` over the seat's own
 * stage rows. That gives "Winner of Semi-finals, match 2", never the organiser
 * board's "R1·2", with the `schedule.tbd` fallback. Stage rows are read only
 * for fixtures that actually have an empty seat.
 */
async function opponentSeatNamer(
  sql: Sql,
  rows: readonly UpcomingDbRow[],
  locale: Locale,
): Promise<(row: UpcomingDbRow, seat: "home" | "away") => string> {
  const ui: SlotLabelLookup = (key, vars) => msgFor(locale, key, vars);
  const stored = (r: UpcomingDbRow, seat: "home" | "away") => (seat === "home" ? r.home_slot_label : r.away_slot_label);
  const waiting = rows.filter((r) => r.home_entrant_id === null || r.away_entrant_id === null);
  if (waiting.length === 0) return (r, seat) => resolveSlotLabel(stored(r, seat), ui, "schedule.tbd");
  const stageIds = [...new Set(waiting.map((r) => r.stage_id))];
  const stageRows = await sql<NamedFixture[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.lane, f.is_final, f.third_place, f.conditional,
           x.ext_key, x.winner_to_fixture, x.winner_to_slot, x.loser_to_fixture, x.loser_to_slot
    from public_fixtures_v f
    join fixtures x on x.id = f.id
    where f.stage_id in ${sql(stageIds)}`;
  const kinds = await sql<{ id: string; kind: string }[]>`select id, kind from stages where id in ${sql(stageIds)}`;
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  const namer = publicRoundNamer({
    ui,
    dict: await getDictionary(locale, "public"),
    fixtures: stageRows,
    stageKind: (id) => kindOf.get(id),
  });
  return (r, seat) => namer.seat(r.id, seat, stored(r, seat));
}
```

- [ ] **Step 4: Implement the wrapper in `data.ts`**

Change line 34 from `import type { PlayerMatchLine } from "./public-player-matches";` to:

```ts
import type { PlayerMatchLine, PlayerUpcomingRow } from "./public-player-matches";
```

Directly after the closing brace of `getPublicPlayer`, add:

```ts
/**
 * Player profile — upcoming matches across the org (spec 2026-09-23). The page
 * calls this only AFTER `getPublicPlayer` passed the gate, so every refusal is
 * still `publicPlayerGate`'s. Only fixture data is read (already public on each
 * fixture's own page), never another competition's card, so no other
 * competition's entitlement is asked (spec §4).
 *
 * UNCACHED on purpose (plan D3): a schedule write in ANOTHER competition fires
 * that competition's tags, none of which this card carries, so a tagged entry
 * would serve a moved fixture until its TTL anyway. The page's own ISR
 * (`s-maxage=30`, measured — `publicPlayerGate`'s note) bounds the reads.
 *
 * Imported lazily for the same reason as the Matches reader in
 * `getPublicPlayer`: it takes `maskPublicEntrantNames` from THIS file.
 */
export async function getPublicPlayerUpcoming(args: {
  org: PublicOrg;
  competition: PublicCompetition;
  personId: string;
  now?: Date;
}): Promise<PlayerUpcomingRow[]> {
  const { readPlayerUpcoming } = await import("./public-player-matches");
  return readPlayerUpcoming(sql, {
    orgId: args.org.id,
    orgSlug: args.org.slug,
    personId: args.personId,
    currentCompetitionId: args.competition.id,
    locale: toLocale(args.org.default_locale),
    now: args.now ?? new Date(),
  });
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run the Step 2 command. Expected: `passed == total == 15`, `pending: 0`, `failedSuites: 0`, and `files` ends in `apps/web/src/server/public-site/__tests__/public-player-upcoming.test.ts` under **this worktree's** path. If a status premise fails (for example `ian` is not `decided`), repair the seed, not the assertion.

- [ ] **Step 6: Mutation sweep. Every guard needs a test that kills it.**

Back up first: `cd /Users/ashokhein/github/seazn.club-player-upcoming && mkdir -p ${TMPDIR:-/tmp}/pu && cp apps/web/src/server/public-site/public-player-matches.ts ${TMPDIR:-/tmp}/pu/ppm.orig`. Apply **one** mutant at a time with Edit. Run the Step 2 command and write down which test names fail. Then restore with `cp ${TMPDIR:-/tmp}/pu/ppm.orig apps/web/src/server/public-site/public-player-matches.ts` before the next mutant.

| # | Mutant | Must redden (at least) |
|---|--------|-------------------------|
| M1 | delete `and (c.visibility = 'public' or c.id = ${currentCompetitionId})` | "R2: an UNLISTED sibling never reaches…" |
| M2 | replace that predicate with `and c.visibility = 'public'` | "R2: …but its OWN card lists it…" |
| M3 | delete `and f.status = 'scheduled'` | "R3: in-play, decided and cancelled…" |
| M4 | `nulls last` → `nulls first` | "…ONE merged sort…", "a division still in SETUP…" |
| M5 | delete the `f.scheduled_at is null or … >= cutoff` clause | "staleness…" |
| M6 | delete `and e.status in ('registered','confirmed')` | "membership: a WITHDRAWN entrant's fixture is gone" |
| M7 | delete `and c.org_id = ${orgId}` | "R1: another org's fixture never appears…" |
| M8 | `join public_divisions_v d` → `join divisions d` | "finished and archived places…" |
| M9 | delete `and d.status <> 'completed'` | "finished and archived places…" |
| M10 | delete `and c.status not in ('completed','archived')` | "finished and archived places…" |
| M11 | `isOtherCompetition: false` | "flags ONLY the other competition's row…", "R2: …OWN card…" |
| M12 | `opponentLabel: seatOf(r, …)` (drop `named ??`) | "opponent: …" |
| M13 | in `opponentSeatNamer`, `return (r, seat) => resolveSlotLabel(stored(r, seat), ui, "schedule.tbd")` unconditionally | none expected. It is equivalent for a league stage, where the namer and the resolver agree. Record it as **surviving/equivalent**; the namer's own feeder wording is pinned by `feeder-slot-label` tests. |

After the last mutant, `diff ${TMPDIR:-/tmp}/pu/ppm.orig apps/web/src/server/public-site/public-player-matches.ts` must print nothing. Record the killer list (mutant → test names) in the commit body. A mutant that survives, other than M13, means a missing test. Add the test before committing.

- [ ] **Step 7: Typecheck and lint the touched files**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club-player-upcoming/apps/web && rtk proxy pnpm exec eslint src/server/public-site/public-player-matches.ts src/server/public-site/data.ts src/server/public-site/__tests__/public-player-upcoming.test.ts; echo "EXIT=$?"
```

Expected: `EXIT=0` for both. Read the output; do not trust a missing error line.

- [ ] **Step 8: Regression. The Matches reader shares `maskedOpponentNames`.**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label player-upcoming)" && OUT=${TMPDIR:-/tmp}/pu-t1-reg.json && rm -f $OUT && cd apps/web && npx vitest run src/server/public-site/__tests__/public-player-matches.test.ts --reporter=json --outputFile=$OUT; echo "EXIT=$?"; jq '{passed:.numPassedTests,total:.numTotalTests,pending:.numPendingTests,files:[.testResults[].name]}' $OUT
```

Expected: `passed == total`, `pending: 0`, one file under this worktree.

- [ ] **Step 9: Commit**

Write the message to `${TMPDIR:-/tmp}/pu/msg1.txt` with the Write tool:

```
feat(public-site): readPlayerUpcoming — a player's next scheduled matches across the org

Same-org, public competitions plus the card's own (R2), scheduled only (R3),
3h staleness, dated ascending then undated. Opponent through the shared
masking pass, else the match centre's public seat namer, else schedule.tbd.
Finished competitions/divisions and archived divisions contribute nothing.
getPublicPlayerUpcoming: uncached wrapper, called after the gate.

Mutation killers: <paste the M1–M13 table outcome>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && git add apps/web/src/server/public-site/public-player-matches.ts apps/web/src/server/public-site/data.ts apps/web/src/server/public-site/__tests__/public-player-upcoming.test.ts && git commit -F ${TMPDIR:-/tmp}/pu/msg1.txt && git show --stat HEAD | head -12
```

---

### Task 2: The `PlayerUpcoming` component, the shared date helper, and i18n

**Files:**
- Modify: `apps/web/src/lib/public-date-locale.ts` (append)
- Modify: `apps/web/src/lib/__tests__/public-date-locale.test.ts` (append)
- Modify: `apps/web/src/components/public-site/player-matches.tsx:26` (import) and `:50-64` (delete `formatIn`)
- Create: `apps/web/src/components/public-site/player-upcoming.tsx`
- Create: `apps/web/src/components/public-site/__tests__/player-upcoming.test.tsx`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (after the `"player.opponent"` line, ~`:471`)
- Regenerate: `apps/web/src/lib/i18n-keys.ts`

**Interfaces:**
- Consumes: `PlayerUpcomingRow` (Task 1, type-only import), `t`/`interpolate` (`@/lib/i18n-runtime`), `Dict`/`Locale` (`@/lib/i18n-constants`).
- Produces:
  - `export function formatPublicInstant(locale: string, tz: string, iso: string | null, opts: Intl.DateTimeFormatOptions): string | null`
  - `export const UPCOMING_VISIBLE = 5`
  - `export interface PlayerUpcomingProps { rows: readonly PlayerUpcomingRow[]; dict: Dict; locale: Locale }`
  - `export function PlayerUpcoming(props: PlayerUpcomingProps)` returns null when there are no rows
  - testids: `mh-player-upcoming-row-{fixtureId}`, `mh-player-upcoming-time`, `mh-player-upcoming-tbc`, `mh-player-upcoming-court`, `mh-player-upcoming-venue`, `mh-player-upcoming-other`, `mh-player-upcoming-where`, `mh-player-upcoming-rest` (the `<details>`), `mh-player-upcoming-more` (the `<summary>`)
  - dictionary keys: `player.upcoming`, `player.upcoming.timeTbd`, `player.upcoming.otherEvent`, `player.upcoming.showMore` (`{count}`)

- [ ] **Step 1: Write the failing helper tests**

Append to `apps/web/src/lib/__tests__/public-date-locale.test.ts`, and change its import line to `import { formatPublicInstant, intlLocaleFor } from "@/lib/public-date-locale";`:

```ts
describe("formatPublicInstant", () => {
  const ISO = "2030-07-01T10:00:00.000Z";
  const HM = { hour: "2-digit", minute: "2-digit" } as const;

  it("formats in the VENUE zone, never the runtime's", () => {
    expect(formatPublicInstant("en", "Asia/Kolkata", ISO, HM)).toBe("15:30");
    expect(formatPublicInstant("en", "UTC", ISO, HM)).toBe("10:00");
  });

  it("an unknown zone falls back to UTC instead of throwing into a render", () => {
    expect(formatPublicInstant("en", "Not/AZone", ISO, HM)).toBe("10:00");
  });

  it("null and unparseable instants format to null", () => {
    expect(formatPublicInstant("en", "UTC", null, { day: "numeric" })).toBeNull();
    expect(formatPublicInstant("en", "UTC", "not a date", { day: "numeric" })).toBeNull();
  });

  it("English is day-month through intlLocaleFor, not bare en's US order", () => {
    const opts = { day: "numeric", month: "short" } as const;
    const gb = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(Date.parse(ISO));
    const us = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(Date.parse(ISO));
    expect(gb, "premise: the two orders differ").not.toBe(us);
    expect(formatPublicInstant("en", "UTC", ISO, opts)).toBe(gb);
  });
});
```

- [ ] **Step 2: Write the failing component tests**

Create `apps/web/src/components/public-site/__tests__/player-upcoming.test.tsx`:

```tsx
// Player profile — the Upcoming list (spec 2026-09-23, plan Task 2). A server
// component, so static markup IS what a spectator gets; the "Show N more"
// reveal is a native <details> (plan D2). Expected copy is read from each
// locale's own dictionary, never typed. Assertions anchor on `="`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { interpolate } from "@/lib/i18n-runtime";
import type { PlayerUpcomingRow } from "@/server/public-site/public-player-matches";
import { PlayerUpcoming, UPCOMING_VISIBLE } from "../player-upcoming";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const row = (id: string, over: Partial<PlayerUpcomingRow> = {}): PlayerUpcomingRow => ({
  fixtureId: id,
  href: `/shared/riverside/autumn-cup/premier/fixtures/${id}`,
  scheduledAt: "2030-07-01T10:00:00.000Z",
  tz: "Asia/Kolkata",
  venue: null,
  courtLabel: null,
  opponentLabel: `Opponent ${id}`,
  competitionName: "Autumn Cup",
  competitionSlug: "autumn-cup",
  divisionName: "Premier",
  divisionSlug: "premier",
  isOtherCompetition: false,
  ...over,
});

const render = (rows: PlayerUpcomingRow[], dict: Dict = en as Dict, locale: Locale = "en") =>
  renderToStaticMarkup(<PlayerUpcoming rows={rows} dict={dict} locale={locale} />);

const rowIds = (html: string) => [...html.matchAll(/data-testid="mh-player-upcoming-row-([^"]+)"/g)].map((m) => m[1]);
const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id) => row(id));

describe("PlayerUpcoming", () => {
  it("EMPTY: renders nothing at all (the page shows no section)", () => {
    expect(render([])).toBe("");
  });

  it("R3: five are shown, the rest wait behind the reveal", () => {
    expect(UPCOMING_VISIBLE).toBe(5);
  });

  it("exactly five rows: all shown, and no reveal", () => {
    const html = render(seven.slice(0, 5));
    expect(rowIds(html)).toEqual(["a", "b", "c", "d", "e"]);
    expect(html).not.toContain('data-testid="mh-player-upcoming-more"');
  });

  it("seven rows: the first five before the reveal, in the reader's order; two inside it; the summary counts TWO", () => {
    const html = render(seven);
    expect(rowIds(html)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    const reveal = html.indexOf('data-testid="mh-player-upcoming-rest"');
    expect(reveal).toBeGreaterThan(html.indexOf('data-testid="mh-player-upcoming-row-e"'));
    expect(reveal).toBeLessThan(html.indexOf('data-testid="mh-player-upcoming-row-f"'));
    expect(html).toContain(`>${esc(interpolate(en["player.upcoming.showMore"], { count: 2 }))}<`);
  });

  it("a dated row shows the time in the VENUE zone; an undated row shows Time TBD instead", () => {
    const html = render([row("dated"), row("undated", { scheduledAt: null })]);
    const dated = html.slice(html.indexOf('mh-player-upcoming-row-dated"'), html.indexOf('mh-player-upcoming-row-undated"'));
    const undated = html.slice(html.indexOf('mh-player-upcoming-row-undated"'));
    expect(dated).toContain(">15:30<"); // 10:00Z in Asia/Kolkata — not the runtime's 10:00
    expect(dated).not.toContain('data-testid="mh-player-upcoming-tbc"');
    expect(undated).toContain('data-testid="mh-player-upcoming-tbc"');
    expect(undated).toContain(`>${esc(en["player.upcoming.timeTbd"])}<`);
    expect(undated).not.toContain('data-testid="mh-player-upcoming-time"');
  });

  it("the Other event chip rides ONLY the other competition's rows", () => {
    const html = render([row("home"), row("away", { isOtherCompetition: true, competitionName: "Spring Open" })]);
    expect(html.match(/data-testid="mh-player-upcoming-other"/g)).toHaveLength(1);
    const away = html.slice(html.indexOf('mh-player-upcoming-row-away"'));
    expect(away).toContain(`>${esc(en["player.upcoming.otherEvent"])}<`);
  });

  it("every row links to its fixture, names competition and division as SEPARATE elements, and the opponent with the Matches grammar", () => {
    const html = render([row("x", { courtLabel: "Court 3", venue: "Riverside Hall" })]);
    expect(html).toContain('href="/shared/riverside/autumn-cup/premier/fixtures/x"');
    expect(html).toContain(">Autumn Cup<");
    expect(html).toContain(">Premier<");
    expect(html).toContain(`>${esc(interpolate(en["player.opponent"], { opponent: "Opponent x" }))}<`);
    expect(html).toContain('data-testid="mh-player-upcoming-court"');
    expect(html).toContain(">Court 3<");
    expect(html).toContain(">Riverside Hall<");
  });

  it("the truncation chain: the link and the text column carry min-w-0, long text truncates", () => {
    const html = render([row("x")]);
    expect(html).toMatch(/data-testid="mh-player-upcoming-row-x" class="[^"]*\bmin-w-0\b/);
    expect(html).toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*>[^<]*Opponent x</);
  });

  it.each([
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["nl", nl],
  ] as const)("%s: every new word is that locale's own dictionary value, never a dotted key", (locale, dict) => {
    const html = render(
      [...seven.slice(0, 5), row("tbc", { scheduledAt: null }), row("other", { isOtherCompetition: true })],
      dict as Dict,
      locale,
    );
    expect(html).toContain(`>${esc(dict["player.upcoming.timeTbd"])}<`);
    expect(html).toContain(`>${esc(dict["player.upcoming.otherEvent"])}<`);
    expect(html).toContain(`>${esc(interpolate(dict["player.upcoming.showMore"], { count: 2 }))}<`);
    expect(html).not.toContain("player.upcoming.");
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && OUT=${TMPDIR:-/tmp}/pu-t2.json && rm -f $OUT && cd apps/web && npx vitest run src/lib/__tests__/public-date-locale.test.ts src/components/public-site/__tests__/player-upcoming.test.tsx --reporter=json --outputFile=$OUT; echo "EXIT=$?"; jq '{passed:.numPassedTests,total:.numTotalTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]}' $OUT
```

Expected: both suites fail (missing export / missing module).

- [ ] **Step 4: Add the shared helper and point Matches at it**

Append to `apps/web/src/lib/public-date-locale.ts`:

```ts
/**
 * An ISO instant in the org's locale and the VENUE's zone, never the runtime's.
 * An unknown zone falls back to UTC rather than throwing into a render (the
 * `lib/format.ts` rule). Null for a null or unparseable instant.
 *
 * Moved here from `components/public-site/player-matches.tsx` (plan P6): that
 * module is "use client", and a server component cannot call a function a
 * client module exports. Still import-free, so an island can use it too.
 */
export function formatPublicInstant(
  locale: string,
  tz: string,
  iso: string | null,
  opts: Intl.DateTimeFormatOptions,
): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(intlLocaleFor(locale), { timeZone: tz, ...opts }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(intlLocaleFor(locale), { timeZone: "UTC", ...opts }).format(ms);
  }
}
```

In `apps/web/src/components/public-site/player-matches.tsx`, replace line 26 `import { intlLocaleFor } from "@/lib/public-date-locale";` with:

```ts
import { formatPublicInstant as formatIn } from "@/lib/public-date-locale";
```

Then delete the local `formatIn` function (its doc comment and body, `:50-64`, from `/** \`Intl\` in the org's locale and the VENUE's zone` through the closing `}`). Call sites keep the name `formatIn` and the same argument order, so nothing else in the file changes.

- [ ] **Step 5: Add the dictionary keys (all 4 locales)**

`apps/web/src/dictionaries/en/public.json`: replace `  "player.opponent": "v {opponent}",` with:

```json
  "player.opponent": "v {opponent}",
  "player.upcoming": "Upcoming",
  "player.upcoming.timeTbd": "Time TBD",
  "player.upcoming.otherEvent": "Other event",
  "player.upcoming.showMore": "Show {count} more",
```

`es/public.json`: replace `  "player.opponent": "vs. {opponent}",` with:

```json
  "player.opponent": "vs. {opponent}",
  "player.upcoming": "Próximos",
  "player.upcoming.timeTbd": "Hora por confirmar",
  "player.upcoming.otherEvent": "Otro evento",
  "player.upcoming.showMore": "Mostrar {count} más",
```

`fr/public.json`: replace `  "player.opponent": "contre {opponent}",` with:

```json
  "player.opponent": "contre {opponent}",
  "player.upcoming": "À venir",
  "player.upcoming.timeTbd": "Horaire à confirmer",
  "player.upcoming.otherEvent": "Autre événement",
  "player.upcoming.showMore": "Afficher {count} de plus",
```

`nl/public.json`: replace `  "player.opponent": "tegen {opponent}",` with:

```json
  "player.opponent": "tegen {opponent}",
  "player.upcoming": "Binnenkort",
  "player.upcoming.timeTbd": "Tijd volgt",
  "player.upcoming.otherEvent": "Ander evenement",
  "player.upcoming.showMore": "Toon er nog {count}",
```

Then regenerate and check:

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && pnpm i18n:gen-keys && pnpm i18n:check; echo "EXIT=$?"; git diff --stat apps/web/src/lib/i18n-keys.ts
```

Expected: `EXIT=0`, and `i18n-keys.ts` shows exactly 4 added lines, one per new key. Never hand-edit that file.

- [ ] **Step 6: Implement the component**

Create `apps/web/src/components/public-site/player-upcoming.tsx`:

```tsx
// Player profile — the Upcoming list (spec 2026-09-23, R3/R4). A SERVER
// component: rendered once per ISR regeneration, no poll (spec: no live
// updates). One chronological list in the reader's order, which it never
// re-sorts. Each row names its competition › division; a row from another
// competition carries the Other event chip.
//
// "Show N more" is a native <details> (plan D2): no JS and no dictionary
// slice sent to the client. `player-matches-dict.ts` exists because an
// island's props are serialised; a server component's are not.
//
// Every subpart is a plain function called inline (the `player-matches.tsx`
// convention), so a static-markup test sees every word.
//
// No middle-dot meta (§3 copy rules): time, court and venue are separate
// elements; the "›" between competition and division is the spec's own
// separator, aria-hidden.
import Link from "next/link";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { formatPublicInstant } from "@/lib/public-date-locale";
import type { PlayerUpcomingRow } from "@/server/public-site/public-player-matches";

/** R3: shown before the reveal. */
export const UPCOMING_VISIBLE = 5;

export interface PlayerUpcomingProps {
  rows: readonly PlayerUpcomingRow[];
  /** The public dictionary, in the ORG's locale. */
  dict: Dict;
  /** The ORG's locale, the page's own (ISR: never the viewer's). */
  locale: Locale;
}

const LIST = "min-w-0 divide-y divide-zinc-100 rounded-xl border border-zinc-200/80 bg-surface";

function upcomingRow(row: PlayerUpcomingRow, dict: Dict, locale: Locale) {
  const day = formatPublicInstant(locale, row.tz, row.scheduledAt, { day: "numeric" });
  const month = formatPublicInstant(locale, row.tz, row.scheduledAt, { month: "short" });
  const time = formatPublicInstant(locale, row.tz, row.scheduledAt, { hour: "2-digit", minute: "2-digit" });
  return (
    <li key={row.fixtureId} className="min-w-0 first:rounded-t-xl last:rounded-b-xl">
      <Link
        href={row.href}
        data-testid={`mh-player-upcoming-row-${row.fixtureId}`}
        className="grid min-h-11 min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2.5 rounded-[inherit] px-3.5 py-2.5 transition-colors hover:bg-accent-soft/60"
      >
        <span className="flex min-w-0 flex-col items-start">
          {day !== null ? (
            <>
              <span className="font-display text-[18px] font-semibold leading-tight tabular-nums text-ink">{day}</span>
              <span className="text-xs text-ink-muted">{month}</span>
            </>
          ) : (
            <span aria-hidden className="font-display text-[18px] font-semibold leading-tight text-ink-muted">
              —
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-display text-[17px] font-semibold uppercase tracking-wide text-ink">
            {t(dict, "player.opponent", { opponent: row.opponentLabel })}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
            {time !== null ? (
              <span data-testid="mh-player-upcoming-time" className="shrink-0 font-semibold tabular-nums text-ink">
                {time}
              </span>
            ) : (
              <span data-testid="mh-player-upcoming-tbc" className="shrink-0 font-semibold uppercase tracking-wide">
                {t(dict, "player.upcoming.timeTbd")}
              </span>
            )}
            {row.courtLabel ? (
              <span data-testid="mh-player-upcoming-court" className="min-w-0 max-w-full truncate">
                {row.courtLabel}
              </span>
            ) : null}
            {row.venue ? (
              <span data-testid="mh-player-upcoming-venue" className="min-w-0 max-w-full truncate">
                {row.venue}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
            {row.isOtherCompetition ? (
              <span
                data-testid="mh-player-upcoming-other"
                className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-strong"
              >
                {t(dict, "player.upcoming.otherEvent")}
              </span>
            ) : null}
            <span data-testid="mh-player-upcoming-where" className="min-w-0 truncate">
              <span>{row.competitionName}</span>
              <span aria-hidden> › </span>
              <span>{row.divisionName}</span>
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

export function PlayerUpcoming({ rows, dict, locale }: PlayerUpcomingProps) {
  // The empty case first: no rows, nothing at all (the page renders no section).
  if (rows.length === 0) return null;
  const shown = rows.slice(0, UPCOMING_VISIBLE);
  const rest = rows.slice(UPCOMING_VISIBLE);
  return (
    <div className="min-w-0 space-y-2">
      <ul className={LIST}>{shown.map((r) => upcomingRow(r, dict, locale))}</ul>
      {rest.length > 0 ? (
        <details data-testid="mh-player-upcoming-rest" className="group min-w-0 space-y-2">
          <summary
            data-testid="mh-player-upcoming-more"
            className="flex min-h-11 cursor-pointer list-none items-center justify-center rounded-xl text-sm font-semibold text-accent-strong hover:underline group-open:hidden [&::-webkit-details-marker]:hidden"
          >
            {t(dict, "player.upcoming.showMore", { count: rest.length })}
          </summary>
          <ul className={LIST}>{rest.map((r) => upcomingRow(r, dict, locale))}</ul>
        </details>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 7: Run the new tests plus the Matches regression**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && OUT=${TMPDIR:-/tmp}/pu-t2.json && rm -f $OUT && cd apps/web && npx vitest run src/lib/__tests__/public-date-locale.test.ts src/components/public-site/__tests__/player-upcoming.test.tsx src/components/public-site/__tests__/player-matches.test.tsx src/lib/__tests__/player-matches-dict.test.tsx --reporter=json --outputFile=$OUT; echo "EXIT=$?"; jq '{passed:.numPassedTests,total:.numTotalTests,pending:.numPendingTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]}' $OUT
```

Expected: `passed == total`, `failedSuites: 0`, and exactly **4** files in `files`, all under this worktree. The `player-matches*` suites prove the `formatIn` move changed nothing in Matches.

- [ ] **Step 8: Mutation checks on the component**

Back up `player-upcoming.tsx`, then apply one mutant at a time. Run the Step 7 command and restore from the backup:
- `UPCOMING_VISIBLE = 6`: expect a red on "R3: five…" and "seven rows…".
- In `upcomingRow`, pass `"UTC"` instead of `row.tz`: expect a red on "a dated row shows the time in the VENUE zone…".
- Drop the `row.isOtherCompetition ?` guard (chip always shown): expect a red on "the Other event chip rides ONLY…".
- Delete `group-open:hidden`: this is **not** unit-visible (a CSS state). Record it as owed to the Task 4 e2e ("Show more" test asserts the summary is hidden once open).

- [ ] **Step 9: Typecheck, lint, commit**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club-player-upcoming/apps/web && rtk proxy pnpm exec eslint src/lib/public-date-locale.ts src/lib/__tests__/public-date-locale.test.ts src/components/public-site/player-matches.tsx src/components/public-site/player-upcoming.tsx src/components/public-site/__tests__/player-upcoming.test.tsx; echo "EXIT=$?"
```

Message file `${TMPDIR:-/tmp}/pu/msg2.txt`:

```
feat(public-site): PlayerUpcoming list + shared formatPublicInstant

Server component: five rows then a native <details> "Show N more"; time in
the venue zone or "Time TBD"; competition › division; Other event chip.
formatIn moved out of the player-matches client island into
lib/public-date-locale (a server component cannot call a client export).
4 keys × 4 locales; i18n-keys regenerated.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && git add apps/web/src/lib/public-date-locale.ts apps/web/src/lib/__tests__/public-date-locale.test.ts apps/web/src/components/public-site/player-matches.tsx apps/web/src/components/public-site/player-upcoming.tsx apps/web/src/components/public-site/__tests__/player-upcoming.test.tsx apps/web/src/dictionaries/en/public.json apps/web/src/dictionaries/es/public.json apps/web/src/dictionaries/fr/public.json apps/web/src/dictionaries/nl/public.json apps/web/src/lib/i18n-keys.ts && git commit -F ${TMPDIR:-/tmp}/pu/msg2.txt && git show --stat HEAD | head -16
```

---

### Task 3: Mount it on the player page

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx` (imports `:17-23`, the data read `:61-63`, the grid `:104-121`)
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/__tests__/page.test.tsx`

**Interfaces:**
- Consumes: `getPublicPlayerUpcoming` (Task 1), `PlayerUpcoming` (Task 2), `PlayerUpcomingRow`.
- Produces: `data-testid="mh-player-upcoming"` (the section) and `data-testid="player-main-column"` (the shared 7-column cell).

- [ ] **Step 1: Write the failing page tests**

In `page.test.tsx`:

Replace `const stub = vi.hoisted(() => ({ getPublicPlayer: vi.fn() }));` and the following `vi.mock("@/server/public-site/data", …)` line with:

```tsx
const stub = vi.hoisted(() => ({ getPublicPlayer: vi.fn(), getPublicPlayerUpcoming: vi.fn() }));
vi.mock("@/server/public-site/data", () => ({
  getPublicPlayer: stub.getPublicPlayer,
  getPublicPlayerUpcoming: stub.getPublicPlayerUpcoming,
}));
```

Add after the `PlayerMatchLineT` import:

```tsx
import type { PlayerUpcomingRow } from "@/server/public-site/public-player-matches";
```

In `interface DataOver`, add `upcoming?: PlayerUpcomingRow[];`. In `renderPage`, directly after `stub.getPublicPlayer.mockResolvedValue(data(over));`, add:

```tsx
  stub.getPublicPlayerUpcoming.mockResolvedValue(over.upcoming ?? []);
```

Replace the test `it("two columns from lg: Matches spans 7, the rest stacks in 5 — one DOM", …)` with:

```tsx
  it("two columns from lg: Upcoming and Matches share the 7-span column, the rest stacks in 5 — one DOM", async () => {
    const { html } = await renderPage({ matches: [line("f1")], upcoming: [upcomingRow("u1")] });
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(html).toMatch(/class="[^"]*\blg:grid-cols-12\b/);
    expect(html).toMatch(/data-testid="player-main-column" class="[^"]*\blg:col-span-7\b/);
    expect(at("player-main-column")).toBeLessThan(at("mh-player-upcoming"));
    expect(at("mh-player-upcoming")).toBeLessThan(at("mh-player-matches"));
    expect(html).toMatch(/class="[^"]*\blg:col-span-5\b/);
    expect(html.search(/class="[^"]*\blg:col-span-5\b/)).toBeGreaterThan(at("mh-player-matches"));
  });
```

Append at the end of the file:

```tsx
const upcomingRow = (fixtureId: string, over: Partial<PlayerUpcomingRow> = {}): PlayerUpcomingRow => ({
  fixtureId,
  href: `${HUB}/premier/fixtures/${fixtureId}`,
  scheduledAt: "2030-07-01T10:00:00.000Z",
  tz: "Europe/London",
  venue: null,
  courtLabel: null,
  opponentLabel: `Opponent ${fixtureId}`,
  competitionName: "Autumn Cup",
  competitionSlug: "autumn-cup",
  divisionName: "Premier",
  divisionSlug: "premier",
  isOtherCompetition: false,
  ...over,
});

describe("player page — Upcoming", () => {
  it("EMPTY: no rows, no section — and the read was for THIS card's org, competition and player", async () => {
    const { html } = await renderPage({ upcoming: [] });
    expect(html).not.toContain('data-testid="mh-player-upcoming"');
    expect(stub.getPublicPlayerUpcoming).toHaveBeenCalledWith(
      expect.objectContaining({
        org: expect.objectContaining({ id: "o1", slug: "riverside" }),
        competition: expect.objectContaining({ id: "c1" }),
        personId: PERSON,
      }),
    );
  });

  it("with rows: its own section, titled from the dictionary, ABOVE Matches", async () => {
    const { html } = await renderPage({ upcoming: [upcomingRow("u1")], matches: [line("f1")] });
    const upcoming = section(html, "mh-player-upcoming");
    expect(upcoming).toContain(`>${esc(en["player.upcoming"])}<`);
    expect(upcoming).toContain('data-testid="mh-player-upcoming-row-u1"');
    expect(html.indexOf('data-testid="mh-player-upcoming"')).toBeLessThan(html.indexOf('data-testid="mh-player-matches"'));
  });

  it("an es org's heading is the es dictionary's own word", async () => {
    expect(es["player.upcoming"], "premise: es differs from en").not.toBe(en["player.upcoming"]);
    const { html } = await renderPage({ locale: "es", upcoming: [upcomingRow("u1")] });
    expect(section(html, "mh-player-upcoming")).toContain(`>${esc(es["player.upcoming"])}<`);
  });

  it("a refused card reads nothing: notFound fires before the upcoming read", async () => {
    stub.getPublicPlayer.mockResolvedValue(null);
    await expect(Page({ params })).rejects.toThrow("CALLED_NOT_FOUND");
    expect(stub.getPublicPlayerUpcoming).not.toHaveBeenCalled();
  });

  it("Matches is unchanged beside it: same slab and rows with or without Upcoming (regression)", async () => {
    const lines = [line("f3"), line("f2", { result: "lost" }), line("f1", { result: "drawn" })];
    const without = (await renderPage({ matches: lines })).html;
    const withRows = (await renderPage({ matches: lines, upcoming: [upcomingRow("u1")] })).html;
    expect(section(withRows, "mh-player-matches")).toBe(section(without, "mh-player-matches"));
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && OUT=${TMPDIR:-/tmp}/pu-t3.json && rm -f $OUT && cd apps/web && npx vitest run "src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/__tests__/page.test.tsx" --reporter=json --outputFile=$OUT; echo "EXIT=$?"; jq '{passed:.numPassedTests,total:.numTotalTests,failed:.numFailedTests,files:[.testResults[].name]}' $OUT
```

Expected: the new "Upcoming" tests and the rewritten "two columns" test fail. Every other existing test still passes. Confirm that `files` names the page test under this worktree; the brackets in the path need the quotes.

- [ ] **Step 3: Implement the mount**

In `page.tsx`, change the data import and add the component import:

```tsx
import { getPublicPlayer, getPublicPlayerUpcoming } from "@/server/public-site/data";
```

```tsx
import { PlayerUpcoming } from "@/components/public-site/player-upcoming";
```

Directly after `const hub = routes.shared(org.slug, competition.slug);`, add:

```tsx
  // Spec 2026-09-23 — the player's next scheduled matches across the org. Read
  // only after the gate above has passed (`getPublicPlayer`'s notFound), and
  // uncached (plan D3): the page's own ISR bounds it.
  const upcoming = await getPublicPlayerUpcoming({ org, competition, personId: player.id });
```

Replace the Matches `<section …>` block (from `{/* W2 Task 14 — renders in every state, empty included (R9). */}` through its closing `</section>`) with:

```tsx
        {/* One 7-span cell from lg (plan D4): Upcoming, when there is any, then
            Matches. Upcoming renders no empty state (spec R3/§3); Matches
            renders in every state, empty included (R9). */}
        <div data-testid="player-main-column" className="min-w-0 space-y-6 lg:col-span-7">
          {upcoming.length > 0 ? (
            <section data-testid="mh-player-upcoming" className="min-w-0">
              <h2 className={SECTION_TITLE}>{t(dict, "player.upcoming")}</h2>
              <PlayerUpcoming rows={upcoming} dict={dict} locale={locale} />
            </section>
          ) : null}
          {/* W2 Task 14 — renders in every state, empty included (R9). */}
          <section data-testid="mh-player-matches" className="min-w-0">
            <h2 className={SECTION_TITLE}>{t(dict, "player.matches")}</h2>
            <PlayerMatches
              orgSlug={org.slug}
              competitionSlug={competition.slug}
              personId={player.id}
              // `generatedAt` is the instant of getPublicPlayer's CACHED read, not
              // this render's: a render inside a warm entry shows lines that old,
              // and the island's "Updated Ns ago" and its older-response guard
              // both count from it. Both sides of that guard are then server
              // clocks — this one and the poll document's.
              initial={{ matches, generatedAt }}
              dict={playerMatchesDict(dict)}
              locale={locale}
            />
          </section>
        </div>
```

Update the file-header comment's section list: change "Matches leads" to "Upcoming (when any) then Matches lead".

- [ ] **Step 4: Run and confirm it passes**

Run the Step 2 command. Expected: `failed: 0` and `passed == total`, with the total equal to the previous count plus 5.

- [ ] **Step 5: Mutation checks**

Back up `page.tsx`, apply one mutant at a time, and restore after each:
- Render the section even when `upcoming` is empty: expect a red on "EMPTY: no rows, no section…".
- Pass `personId: personId` from params instead of `player.id`: this is equivalent for a valid card (both are the same uuid). Record it as equivalent.
- Move the Upcoming `<section>` below Matches: expect a red on "with rows: … ABOVE Matches" and "two columns…".

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club-player-upcoming/apps/web && rtk proxy pnpm exec eslint "src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx" "src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/__tests__/page.test.tsx"; echo "EXIT=$?"
```

Message file `${TMPDIR:-/tmp}/pu/msg3.txt`:

```
feat(public-site): Upcoming section above Matches on the player card

Read after the gate, uncached (page ISR bounds it). Upcoming and Matches
share the 7-span cell from lg; no rows → no section. Matches markup is
byte-identical with or without Upcoming (regression test).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && git add "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx" "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/__tests__/page.test.tsx" && git commit -F ${TMPDIR:-/tmp}/pu/msg3.txt && git show --stat HEAD | head -10
```

---

### Task 4: Browser proof (e2e), smoke, screenshots, and the full gate

**Files:**
- Create: `apps/web/e2e/player-upcoming.spec.ts`
- Modify: `scripts/smoke.ts`, inside `passGrantsSuite`, directly after the check `"pass grants/profiles: the UNPASSED sibling stays dark (404) — V396 made profiles paid again"` (~`:2990`)

**Interfaces:**
- Consumes: the testids from Tasks 2-3; the kit helpers `mintSpectatorOrg`, `publicCompetition`, `division`, `person`, `entrants`, `leagueFixtures`, `scheduleFixture`, `eventStream`, `spectator`, `shootStates`, `expectDistinctShots`, `dictString` (`apps/web/e2e/spectator-w2-kit.ts`); `closeOpenContexts` (`apps/web/e2e/spectator-public-helpers.ts`); `apiJson`, `expectNoHorizontalScroll` (`apps/web/e2e/helpers.ts`).
- Produces: nothing downstream.

- [ ] **Step 1: Write the e2e spec**

Create `apps/web/e2e/player-upcoming.spec.ts`:

```ts
// Player profile — upcoming matches across the org, as a spectator sees it
// (spec docs/superpowers/specs/2026-09-23-player-profile-upcoming-matches-design.md,
//  plan …/plans/2026-09-23-player-profile-upcoming-matches.md Task 4).
//
// One Pro org (player pages are Pro-gated), one player, three competitions:
//   CUR (public)   — the card; 7 of Ada's fixtures: 1 PLAYED (Matches), 5 dated,
//                    1 left undated (Time TBD, behind the reveal)
//   SIB (public)   — 1 fixture, dated between CUR's first and second: the
//                    list is one sort, and this row carries the chip. Its
//                    competition and division names are deliberately long.
//   UNL (unlisted) — 1 fixture, dated EARLIEST: if R2 leaked it would lead.
// Every plan is set before the first public read (entitlements may be served
// stale for five minutes). Serial with the seed as test 1 (AGENTS.md #21: a
// red count is a floor).
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll } from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import {
  dictString,
  division,
  entrants,
  eventStream,
  expectDistinctShots,
  leagueFixtures,
  mintSpectatorOrg,
  person,
  publicCompetition,
  scheduleFixture,
  shootStates,
  spectator,
  type FixtureRow,
  type MintedOrg,
} from "./spectator-w2-kit";

test.describe.configure({ mode: "serial" });
test.afterEach(closeOpenContexts);

const GENERIC = { sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } };
const WIDTHS = [320, 768, 1280] as const;
/** A realistically long name — the length that exposed a missing min-w-0 before (AGENTS.md, phone composition). */
const LONG = "Bartholomew Fitzgerald-Montgomery";

let org: MintedOrg;
let cur = { id: "", slug: "" };
let sib = { id: "", slug: "" };
let unl = { id: "", slug: "" };
let sibDiv = { id: "", slug: "" };
let ada = "";
let played = "";
let sibFixture = "";
let unlFixture = "";
let undated = "";
/** CUR's card, soonest first: CUR day 1, SIB day 2, CUR days 3–6, then the undated one. */
let expected: string[] = [];

const card = (compSlug: string) => `/shared/${org.slug}/${compSlug}/players/${ada}`;
const adaRows = (rows: FixtureRow[], entrantId: string) =>
  rows.filter((f) => f.home_entrant_id === entrantId || f.away_entrant_id === entrantId);
const rowIds = (page: Page) =>
  page
    .getByTestId("mh-player-upcoming")
    .locator('[data-testid^="mh-player-upcoming-row-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("mh-player-upcoming-row-", "")));

test("setup: one player, three competitions, seven upcoming fixtures and one played", async ({ request }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  org = await mintSpectatorOrg(request, { name: `Upcoming ${tag}`, plan: "pro" });
  const adaName = `Ada ${tag}`;
  ada = await person(request, adaName, true);

  cur = await publicCompetition(request, { name: `Current Cup ${tag}`, orgId: org.id });
  sib = await publicCompetition(request, { name: `${LONG} Invitational ${tag}`, orgId: org.id });
  const created = await apiJson<{ id: string; slug: string; visibility: string }>(request, "/api/v1/competitions", "POST", {
    name: `Unlisted Open ${tag}`,
    visibility: "unlisted",
    ends_on: "2030-12-31",
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  expect(created.data!.visibility, "the unlisted competition degraded").toBe("unlisted");
  unl = { id: created.data!.id, slug: created.data!.slug };

  // ---- CUR: Ada v seven opponents, the first with a long name ------------------
  const curDiv = await division(request, cur.id, { name: "Singles", ...GENERIC });
  const opponents = await Promise.all(Array.from({ length: 7 }, (_, i) => person(request, `Opp${i} ${tag}`, true)));
  const curEntrants = await entrants(request, curDiv.id, [
    { kind: "individual", name: adaName, members: [ada] },
    ...opponents.map((id, i) => ({ kind: "individual" as const, name: i === 0 ? `${LONG} ${tag}` : `Opp${i} ${tag}`, members: [id] })),
  ]);
  const mine = adaRows(await leagueFixtures(request, curDiv.id), curEntrants[0]!);
  expect(mine, "Ada meets seven opponents once each").toHaveLength(7);
  played = mine[0]!.id;
  const stream = await eventStream(request, played);
  await stream.post("core.start", {});
  await stream.post("generic.result", { p1Score: 2, p2Score: 1 });
  const dated = mine.slice(1, 6).map((f) => f.id);
  undated = mine[6]!.id;
  const days = [1, 3, 4, 5, 6];
  for (const [i, id] of dated.entries()) await scheduleFixture(request, id, `2030-07-0${days[i]}T10:00:00Z`);
  // Premise: the one left alone really is undated.
  const listed = await apiJson<{ id: string; scheduled_at: string | null }[]>(request, `/api/v1/divisions/${curDiv.id}/fixtures`);
  expect(listed.data?.find((f) => f.id === undated)?.scheduled_at ?? null, "the undated fixture has a time").toBeNull();

  // ---- SIB: one fixture on day 2 -------------------------------------------------
  sibDiv = await division(request, sib.id, { name: `${LONG} Premier Division`, ...GENERIC });
  const sibOpp = await person(request, `Sib Opp ${tag}`, true);
  const sibEntrants = await entrants(request, sibDiv.id, [
    { kind: "individual", name: adaName, members: [ada] },
    { kind: "individual", name: `Sib Opp ${tag}`, members: [sibOpp] },
  ]);
  sibFixture = adaRows(await leagueFixtures(request, sibDiv.id), sibEntrants[0]!)[0]!.id;
  await scheduleFixture(request, sibFixture, "2030-07-02T10:00:00Z");

  // ---- UNL: one fixture, the EARLIEST of all --------------------------------------
  const unlDiv = await division(request, unl.id, { name: "Open", ...GENERIC });
  const unlOpp = await person(request, `Unl Opp ${tag}`, true);
  const unlEntrants = await entrants(request, unlDiv.id, [
    { kind: "individual", name: adaName, members: [ada] },
    { kind: "individual", name: `Unl Opp ${tag}`, members: [unlOpp] },
  ]);
  unlFixture = adaRows(await leagueFixtures(request, unlDiv.id), unlEntrants[0]!)[0]!.id;
  await scheduleFixture(request, unlFixture, "2030-06-30T10:00:00Z");

  expected = [dated[0]!, sibFixture, ...dated.slice(1), undated];
});

test("the card lists the next five across the org in time order, the sibling's row chipped, the unlisted one absent, the played one in Matches", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  const res = await page.goto(card(cur.slug), { waitUntil: "load" });
  expect(res?.status()).toBe(200);
  const section = page.getByTestId("mh-player-upcoming");
  await expect(section.getByRole("heading", { name: dictString("en", "player.upcoming") })).toBeVisible();
  expect(await rowIds(page)).toEqual(expected);
  await expect(section.locator('[data-testid^="mh-player-upcoming-row-"]:visible')).toHaveCount(5);
  await expect(section.getByTestId("mh-player-upcoming-more")).toHaveText(dictString("en", "player.upcoming.showMore", { count: 2 }));
  // The chip: on the sibling's row, and nowhere else.
  await expect(section.getByTestId("mh-player-upcoming-other")).toHaveCount(1);
  await expect(section.getByTestId(`mh-player-upcoming-row-${sibFixture}`).getByTestId("mh-player-upcoming-other")).toHaveText(
    dictString("en", "player.upcoming.otherEvent"),
  );
  // R2: the unlisted competition's fixture never reaches this card (positive pair: next test).
  await expect(page.locator(`[data-testid="mh-player-upcoming-row-${unlFixture}"]`)).toHaveCount(0);
  // Regression: the played fixture is Matches', not Upcoming's.
  await expect(section.locator(`[data-testid="mh-player-upcoming-row-${played}"]`)).toHaveCount(0);
  await expect(page.getByTestId("mh-player-matches").getByTestId(`mh-player-match-${played}`)).toBeVisible();
});

test("R2 positive pair: the unlisted competition's OWN card lists its fixture first, unchipped, and chips the public ones", async ({ browser }) => {
  const page = await spectator(browser, { width: 1280, height: 900 });
  expect((await page.goto(card(unl.slug), { waitUntil: "load" }))?.status()).toBe(200);
  const ids = await rowIds(page);
  expect(ids[0]).toBe(unlFixture);
  const section = page.getByTestId("mh-player-upcoming");
  await expect(section.getByTestId(`mh-player-upcoming-row-${unlFixture}`).getByTestId("mh-player-upcoming-other")).toHaveCount(0);
  await expect(section.getByTestId(`mh-player-upcoming-row-${sibFixture}`).getByTestId("mh-player-upcoming-other")).toHaveCount(1);
});

test("Show more reveals rows six and seven, the undated one reading Time TBD, and the summary goes away", async ({ browser }) => {
  const page = await spectator(browser, { width: 390, height: 844 });
  await page.goto(card(cur.slug), { waitUntil: "load" });
  const section = page.getByTestId("mh-player-upcoming");
  const last = section.getByTestId(`mh-player-upcoming-row-${undated}`);
  await expect(last).toBeHidden();
  await section.getByTestId("mh-player-upcoming-more").click();
  await expect(last).toBeVisible();
  await expect(last.getByTestId("mh-player-upcoming-tbc")).toHaveText(dictString("en", "player.upcoming.timeTbd"));
  await expect(section.locator('[data-testid^="mh-player-upcoming-row-"]:visible')).toHaveCount(7);
  await expect(section.getByTestId("mh-player-upcoming-more")).toBeHidden();
});

test("a row opens that fixture's match centre — the sibling's under the SIBLING's slug", async ({ browser }) => {
  const page = await spectator(browser, { width: 390, height: 844 });
  await page.goto(card(cur.slug), { waitUntil: "load" });
  const href = `/shared/${org.slug}/${sib.slug}/${sibDiv.slug}/fixtures/${sibFixture}`;
  const row = page.getByTestId(`mh-player-upcoming-row-${sibFixture}`);
  await expect(row).toHaveAttribute("href", href);
  await Promise.all([page.waitForURL(`**${href}`), row.click()]);
  expect((await page.request.get(href)).status()).toBe(200);
});

test("320 / 768 / 1280: collapsed and expanded, no horizontal scroll, and the pictures differ", async ({ browser }) => {
  test.setTimeout(120_000);
  const dir = test.info().outputPath("upcoming-shots");
  mkdirSync(dir, { recursive: true });
  await shootStates(
    browser,
    dir,
    [
      {
        name: "upcoming-collapsed",
        open: async (page) => {
          await page.goto(card(cur.slug), { waitUntil: "load" });
          await expect(page.getByTestId("mh-player-upcoming-more")).toBeVisible();
          await expectNoHorizontalScroll(page);
        },
      },
      {
        name: "upcoming-expanded",
        open: async (page) => {
          await page.goto(card(cur.slug), { waitUntil: "load" });
          await page.getByTestId("mh-player-upcoming-more").click();
          await expect(page.getByTestId(`mh-player-upcoming-row-${undated}`)).toBeVisible();
          await expectNoHorizontalScroll(page);
        },
      },
    ],
    WIDTHS,
  );
  expectDistinctShots(dir, ["upcoming-collapsed", "upcoming-expanded"], WIDTHS);
});
```

- [ ] **Step 2: Add the smoke checks**

In `scripts/smoke.ts` (`passGrantsSuite`), directly after:

```ts
  check(
    "pass grants/profiles: the UNPASSED sibling stays dark (404) — V396 made profiles paid again",
    plainCard.status === 404,
  );
```

insert:

```ts
  // Player profile — upcoming across the org (spec 2026-09-23). The passed
  // card's board fixture was generated and never started, so it is SCHEDULED
  // and upcoming. The plain competition is UNLISTED and is not this card's,
  // so its board fixture must never reach this card (R2). Positive and
  // negative read the same page body; both anchor on `="`.
  const passCardHtml = await passCard.text();
  check(
    "player upcoming: the passed card lists its own scheduled board fixture under Upcoming",
    passCardHtml.includes('data-testid="mh-player-upcoming"') &&
      passCardHtml.includes(`data-testid="mh-player-upcoming-row-${board.pass.fixtureId}"`),
  );
  check(
    "player upcoming: the sibling UNLISTED competition's fixture never reaches this card (R2)",
    !passCardHtml.includes(board.plain.fixtureId),
  );
```

- [ ] **Step 3: Bring up a prod server on this tree**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label player-upcoming --all
cd /Users/ashokhein/github/seazn.club-player-upcoming && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label player-upcoming
```

Read the `tree` line and the build-date line. The bundle must be newer than the last edit: `find apps/web/.next/standalone -name server.js -newer apps/web/src/components/public-site/player-upcoming.tsx` must print a path. If a build OOMs with exit 137 under load, rebuild with `SKIP_TYPECHECK=1`; tsc already ran separately.

- [ ] **Step 4: Run the WHOLE new spec file (never `-g`)**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label player-upcoming)" && cd apps/web && PLAYWRIGHT_BASE="${SMOKE_BASE/127.0.0.1/localhost}" npx playwright test e2e/player-upcoming.spec.ts --project=parallel --reporter=list; echo "EXIT=$?"
```

Expected: `6 passed` (setup + 5), `EXIT=0`. The base must be `localhost`, never `127.0.0.1`. The file is serial, so treat a red count as a floor. If a poll's own timeout was **not** exceeded but `test.setTimeout` was, the failure is the wall clock, not the data.

Then **look at** the six PNGs under `apps/web/test-results/**/upcoming-shots/`. Read each image and check: the chip reads "Other event", the long sibling names truncate with an ellipsis, the 320 row does not overflow, and the undated row reads "Time TBD". Write a one-line verdict per screen in the task report.

Mutation check owed from Task 2: delete `group-open:hidden` from `player-upcoming.tsx`, `rebuild`, and re-run this file. The "Show more … summary goes away" test must go red. Restore, `rebuild`, and re-run to green.

- [ ] **Step 5: Run the whole smoke suite**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label player-upcoming)" && pnpm test:smoke > ${TMPDIR:-/tmp}/pu/smoke.log 2>&1; echo "EXIT=$?" >> ${TMPDIR:-/tmp}/pu/smoke.log; tail -40 ${TMPDIR:-/tmp}/pu/smoke.log; grep -a "player upcoming" ${TMPDIR:-/tmp}/pu/smoke.log
```

Expected: both `player upcoming:` checks print as passing, and the log ends with `EXIT=0`. Smoke is long, so run it with `run_in_background`, keeping the `EXIT=$?` capture in the command itself, because a killed background run reports 0. If an unrelated check is red, re-run it on a clean detached worktree of `main` before calling it pre-existing (AGENTS.md #14).

- [ ] **Step 6: Full local gate**

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club-player-upcoming && rtk proxy pnpm lint; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club-player-upcoming && pnpm i18n:gen-keys && pnpm i18n:check && git status --porcelain apps/web/src/lib/i18n-keys.ts; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club-player-upcoming && pnpm openapi:gen && git status --porcelain openapi; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club-player-upcoming && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label player-upcoming)" && OUT=${TMPDIR:-/tmp}/pu-final.json && rm -f $OUT && cd apps/web && npx vitest run src/server/public-site/__tests__/public-player-upcoming.test.ts src/server/public-site/__tests__/public-player-matches.test.ts src/components/public-site/__tests__/player-upcoming.test.tsx src/components/public-site/__tests__/player-matches.test.tsx src/lib/__tests__/player-matches-dict.test.tsx src/lib/__tests__/public-date-locale.test.ts "src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/__tests__/page.test.tsx" --reporter=json --outputFile=$OUT; echo "EXIT=$?"; jq '{passed:.numPassedTests,total:.numTotalTests,pending:.numPendingTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]}' $OUT
```

Expected: lint prints `✖ 0 problems` (or no problem lines) with `EXIT=0`. `i18n-keys.ts` and `openapi` have no porcelain output. The vitest JSON shows `passed == total`, `pending: 0`, `failedSuites: 0`, and exactly **7** files, all under this worktree.

- [ ] **Step 7: Commit**

Message file `${TMPDIR:-/tmp}/pu/msg4.txt`:

```
test(player-upcoming): e2e across three competitions + smoke R2 pair

e2e: order across CUR/SIB, chip on the sibling row only, unlisted sibling
absent (and present on its own card), played fixture stays in Matches,
Show more reveals Time TBD, sibling row links under the sibling's slug,
320/768/1280 collapsed+expanded with no horizontal scroll.
smoke: the passed card lists its board fixture; the unlisted sibling's never.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
cd /Users/ashokhein/github/seazn.club-player-upcoming && git add apps/web/e2e/player-upcoming.spec.ts scripts/smoke.ts && git commit -F ${TMPDIR:-/tmp}/pu/msg4.txt && git show --stat HEAD | head -8
```

- [ ] **Step 8: CI coverage that local runs cannot give**

`e2e.yml` runs only on a push to `main`, never on a PR. After the PR is open, dispatch it against the branch: `gh workflow run e2e.yml -f pr=<PR number>`. This covers the seven-width `mobile.spec.ts` matrix, whose "spectator hub tabs and a player card" test now renders Upcoming whenever its seeded player has scheduled fixtures. A run that reports `cancelled` is **not** a pass; a push to `main` cancels dispatched runs. Smoke runs on the PR itself. Before merge, a reviewer gives a per-screen verdict on the six PNGs from Step 4. "CI green" is not sign-off.

---

## Self-review

**1. Spec coverage**

| Spec requirement | Covered in |
|---|---|
| §1 membership (entrant, registered/confirmed; singles + pair) | T1: order test (pair row), withdrawn test |
| §1 source `public_fixtures_v`, same org | T1: SQL, R1 test |
| §1 visibility R2 | T1: three R2 tests, M1/M2; T4: e2e pair, smoke |
| §1 status scheduled; in_play/decided/cancelled excluded | T1: R3 test, M3 |
| §1 staleness 3h, nulls kept | T1: staleness + setup tests, M5 |
| §1 order and cap | T1: order test, M4 (`nulls first`, P5) |
| §1 output fields | T1: `PlayerUpcomingRow` |
| §2 opponent label | T1: opponent test (masked / seat / TBD, P1) |
| §3 server-rendered, 5 + reveal, no rows means no section, date helper, `min-w-0`, 4 locales + gen-keys | T2, T3, T4 |
| §3 row link to the fixture page | T1 hrefs, T2 href, T4 click |
| §4 gates unchanged | T3: notFound-before-read test; smoke 404 pair untouched |
| Testing: integration, mutation, e2e, smoke, regression | T1 S5-S8; T2 S7-S8; T3 S4-S5; T4 S4-S5 |

**2. Placeholder scan:** none left. Each commit body has one `<paste the M1–M13 table outcome>`; that slot is filled from the run by design, and it is not code.

**3. Type consistency:** these names are the same everywhere they appear: `PlayerUpcomingRow`, `readPlayerUpcoming`, `getPublicPlayerUpcoming`, `UPCOMING_STALE_AFTER_MS`, `UPCOMING_VISIBLE`, `formatPublicInstant`, and all `mh-player-upcoming-*` testids.

**4. Review Focus:** RF1/RF2 → T1 "finished and archived…"; RF3 → T1 "opponent…"; RF4 → T4 widths test; RF5 → T1 hrefs + T4 row click.

## Open risks

- **Copy clash:** the owner ruled "Time TBD" (R3), but the public hub and match centre already say "Time TBD" (`matchesHub.timeTbd`, `matchCentre.status.timeTbd`). The plan follows the ruling. Flag the inconsistency to the owner.
- **D1 is a behaviour the spec did not state.** If the owner wants finished events' leftovers shown, delete the two status predicates and the matching test. M9/M10 in the sweep show exactly which lines those are.
- **`mobile.spec.ts`'s player-card test** renders Upcoming whenever its seeded player has scheduled fixtures. Local runs do not cover it, so CI dispatch (T4 S8) is the only proof.
- **`match-centre-load.ts`** keeps its own inline stage-rows query for the seat namer, and T1 adds a second copy. Merging them into one helper would touch the match centre, which is outside this plan's blast radius. Record it; do not fix it here.
