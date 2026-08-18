// #364 Task 3 — the capture harness, and the guard that keeps its output honest.
//
// TWO suites live here, and only one of them ever costs money:
//
//   capture (CAPTURE_AI_DEMO=1)  — seeds a template into a throwaway org, calls
//     the REAL `aiPlanForDivision` / `aiPlanForCompetition` over the real
//     network, and writes `<slug>.json`. No provider mock: a recorded run whose
//     model was a stub would be a simulation, which is the one thing the issue
//     says this demo must not be. Run it as
//
//       DATABASE_URL=<throwaway> DATABASE_SSL=disable npm run capture:ai-demo
//
//     and point it at a THROWAWAY database: the templates create real
//     organisations, competitions and draws, and the repo-root `.env.local`
//     that vitest loads names the developer's own dev database. Add
//     `-- -t 'captures <slug>'` to record one template at a time — a joint
//     115-fixture run is minutes of model time, and re-running a template that
//     already succeeded spends real money to no purpose.
//
//   check (always on, DB-gated)  — reseeds each template from the SAME builders
//     and asserts the pack it rebuilds is the pack the committed fixture
//     recorded, up to per-seed UUIDs. This is the issue's "re-runs and
//     reproduces" acceptance. The MODEL's answer is excluded by design — it is
//     not reproducible and never will be; what has to reproduce is the BOARD
//     the model was asked about.
//
// The check suite deliberately FAILS when a fixture file is missing rather than
// skipping: the committed JSONs are the artefact this file exists to protect,
// and a guard that quietly passes when its subject is absent is not a guard.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AiConsoleFixture } from "@/components/v2/board/ai-diff";
import { walletIdFor } from "@/lib/credits";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { OCCUPYING } from "@/server/usecases/schedule";
import { aiPlanForDivision, buildSchedulePack } from "@/server/usecases/schedule-ai";
import {
  aiPlanForCompetition,
  buildCompetitionPack,
} from "@/server/usecases/competition-schedule-ai";

import type { AiDemoFixture } from "../types";

import {
  normalizeIds,
  seedClubNight,
  seedFinalsDay,
  seedNorthsideOpen,
  type SeededTemplate,
} from "./seeds";

const HAS_DB = !!process.env.DATABASE_URL;
const CAPTURING = process.env.CAPTURE_AI_DEMO === "1";

/** The instant every pack in this programme is built at. Must equal
 *  `seeds.test.ts`'s ANCHOR_NOW — and cannot silently drift from it, because a
 *  pack built at a different anchor carries a different `clock` and the check
 *  below stops matching the committed fixture. */
const ANCHOR_NOW = new Date("2026-09-01T08:00:00.000Z").getTime();

/** `apps/web/src/demo/ai-templates` — where the committed fixtures live. */
const FIXTURE_DIR = path.resolve(__dirname, "..");

const TEMPLATES = [
  { slug: "club-night", seed: seedClubNight },
  { slug: "northside-open", seed: seedNorthsideOpen },
  { slug: "finals-day", seed: seedFinalsDay },
] as const;

function fixturePath(slug: string): string {
  return path.join(FIXTURE_DIR, `${slug}.json`);
}

/** Wall budget for ONE captured run. The architect is a multi-round
 *  conversation over a real network and a 115-fixture joint board is the
 *  largest thing this product asks a model to do; vitest's 30s default would
 *  abort a run mid-flight after it had already been paid for. */
const CAPTURE_TIMEOUT_MS = 20 * 60_000;

/** Comfortably above any quote this programme can produce (the 115-fixture
 *  joint board is the ceiling), because a 402 halfway through a capture wastes
 *  the tokens already spent. The wallet is thrown away with the org. */
const CAPTURE_CREDITS = 500;

/**
 * `apps/web/vitest.config.ts` DELETES `ANTHROPIC_API_KEY` from the loaded
 * `.env.local` — deliberately, so a stray unit test cannot bill us. This suite
 * is the exception the config's own comment names, so it puts the key back for
 * itself, exactly as `schedule-ai-effort-ab.live.test.ts` does.
 *
 * It matters for TWO things, not one: the ladder's middle rung
 * (`claude-sonnet-5`), and the stage-1 instruction compiler, whose model is a
 * bare Anthropic id. Without the key the compiler silently returns "no rules"
 * — and a demo whose whole story is "type a sentence, watch it become rules"
 * would have captured an empty compile.
 *
 * Never overwrites an exported value, and reads only this one name.
 */
function loadAnthropicKeyIfAbsent(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const envFile = path.resolve(__dirname, "../../../../../../.env.local");
  let contents: string;
  try {
    contents = readFileSync(envFile, "utf8");
  } catch {
    return;
  }
  const m = contents.match(/^ANTHROPIC_API_KEY=(.*)$/m);
  if (!m) return;
  const raw = m[1]!.trim();
  const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : null;
  if (quote) {
    const end = raw.indexOf(quote, 1);
    process.env.ANTHROPIC_API_KEY = end === -1 ? raw.slice(1) : raw.slice(1, end);
    return;
  }
  const comment = raw.search(/\s#/);
  process.env.ANTHROPIC_API_KEY = (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

/**
 * Refuse to capture against anything but a database the caller NAMED.
 *
 * `npm run capture:ai-demo` from a clean shell inherits `DATABASE_URL` from the
 * repo-root `.env.local` that `vitest.config.ts` loads — the developer's own
 * dev database. A naive invocation would seed three real organisations, a
 * competition and a 115-fixture draw into it AND spend about a dollar, and
 * would look exactly like a successful capture while doing it.
 *
 * A comment cannot prevent that, and a `skipIf` would be worse than useless
 * here: skipping is silent, and the operator would read the green run as a
 * capture that happened. So this THROWS, before any seeding and before any
 * model call.
 *
 * The test is "did the caller override the env file", not a guess about the
 * URL's shape: the file's own value is read back and compared. That stays
 * correct if the dev database is ever renamed or moved off :5432, which a
 * hardcoded pattern would not. The `:5432/seazn` shape is kept as a second
 * belt for the case where the env file is absent or differs.
 *
 * `CAPTURE_DB_OK=1` is the deliberate override, for an operator who really
 * does mean the database they are pointed at.
 */
function assertCaptureDatabase(): void {
  if (process.env.CAPTURE_DB_OK === "1") return;
  const url = process.env.DATABASE_URL ?? "";
  const refuse = (why: string): never => {
    throw new Error(
      `refusing to capture against ${why}.\n` +
        "The capture seeds real organisations and spends real money, so it only " +
        "runs against a database you name explicitly:\n\n" +
        "  DATABASE_URL=postgresql://postgres@127.0.0.1:54339/<throwaway> \\\n" +
        "  DATABASE_SSL=disable npm run capture:ai-demo\n\n" +
        "Set CAPTURE_DB_OK=1 to override if you really mean this database.",
    );
  };

  let fromEnvFile: string | null = null;
  try {
    const contents = readFileSync(path.resolve(__dirname, "../../../../../../.env.local"), "utf8");
    fromEnvFile = contents.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
  } catch {
    // No env file (CI). The shape check below still applies.
  }
  if (fromEnvFile !== null && url === fromEnvFile) {
    refuse("the DATABASE_URL inherited from the repo-root .env.local — the dev database");
  }
  if (/:5432\/seazn\b/.test(url)) refuse("what looks like the local dev database");
}

/** The pack the run is anchored on: one division, or the joint competition. */
async function packFor(
  auth: AuthCtx,
  t: SeededTemplate,
): Promise<{ pack: unknown; movableIds: Set<string> }> {
  const opts = { mode: t.mode, instruction: t.instruction, now: ANCHOR_NOW } as const;
  return t.joint
    ? buildCompetitionPack(auth, t.competitionId, t.divisionIds, opts)
    : buildSchedulePack(auth, t.divisionIds[0]!, opts);
}

/** The two pack shapes, reduced to the three fields the board card needs.
 *  A joint pack owns the court UNION at the top level; a single-division pack
 *  keeps its courts on `settings`. */
interface PackFacade {
  window: { start: string; end: string };
  courts?: string[];
  settings?: { courts: string[] };
}

/**
 * The board as the product's own console would hold it — `consoleFixtures()`
 * in `components/v2/schedule-board.tsx` is the shape being mirrored, including
 * its `isJunior: false` (nothing in production ever sets it true) and its
 * per-division `isFinal` rule.
 *
 * ONE deliberate difference: `code` is `F{fixture_no}` rather than
 * `R{round}·{seq}`, because the demo lists a whole competition flat and a
 * round/seq code repeats across divisions.
 *
 * Rows are read per division in the template's own division order, so the
 * board's order is the draw's, never Postgres's.
 */
async function boardFor(t: SeededTemplate, pack: unknown): Promise<AiDemoFixture["board"]> {
  const fixtures: AiConsoleFixture[] = [];
  const entrants: { id: string; name: string }[] = [];

  for (const divisionId of t.divisionIds) {
    const names = await sql<{ id: string; display_name: string }[]>`
      select id, display_name from entrants
      where division_id = ${divisionId} order by seed, id`;
    for (const e of names) entrants.push({ id: e.id, name: e.display_name });
    const nameOf = new Map(names.map((e) => [e.id, e.display_name]));

    const rows = await sql<
      {
        id: string;
        stage_id: string;
        fixture_no: number;
        round_no: number;
        scheduled_at: Date | null;
        court_label: string | null;
        court_id: string | null;
        status: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
      }[]
    >`
      select id, stage_id, fixture_no, round_no, scheduled_at, court_label, court_id, status,
             home_entrant_id, away_entrant_id
        from fixtures
       where division_id = ${divisionId} and status in ${sql(OCCUPYING)}
       order by fixture_no`;

    // The FINAL is the lone fixture of the division's last round — the same
    // test `consoleFixtures` applies, so a pool division (many fixtures in its
    // last round) correctly has no final.
    const maxRound = rows.reduce((m, f) => Math.max(m, f.round_no), 0);
    const atMaxRound = rows.filter((f) => f.round_no === maxRound).length;

    for (const f of rows) {
      fixtures.push({
        id: f.id,
        stage_id: f.stage_id,
        division_id: divisionId,
        scheduled_at: f.scheduled_at ? new Date(f.scheduled_at).toISOString() : null,
        court_label: f.court_label,
        court_id: f.court_id,
        code: `F${f.fixture_no}`,
        matchup: `${nameOf.get(f.home_entrant_id ?? "") ?? "TBC"} vs ${
          nameOf.get(f.away_entrant_id ?? "") ?? "TBC"
        }`,
        isFinal: maxRound > 0 && f.round_no === maxRound && atMaxRound === 1,
        isJunior: false,
        status: f.status,
        home_entrant_id: f.home_entrant_id,
        away_entrant_id: f.away_entrant_id,
      });
    }
  }

  const facade = pack as PackFacade;
  return {
    fixtures,
    courts: facade.courts ?? facade.settings?.courts ?? [],
    entrants,
    window: facade.window,
  };
}

/**
 * Which model actually produced this plan.
 *
 * `served_model` never reaches the wire — the response carries usage but not
 * the winning rung — so it is read back off the run's OWN ledger row, where
 * `planForDivision` stamps the model the ladder settled on (schedule-ai.ts
 * :2829). That is the only surface that knows whether rung 1 served or the run
 * escalated, and reading it here means `meta.model` can never be a guess.
 */
async function servedModel(orgId: string, competitionId: string): Promise<string> {
  const [row] = await sql<{ model: string | null }[]>`
    select payload->>'model' as model from competition_events
     where org_id = ${orgId} and competition_id = ${competitionId}
       and type in ('schedule.ai_generated', 'schedule.ai_generated_multi')
     order by created_at desc limit 1`;
  return row?.model ?? process.env.SCHEDULING_AI_MODEL ?? "unknown";
}

/** Direct ledger grant — the shape `ai-credit-wallet-spend.test.ts` uses
 *  (:177-180) to control a wallet without going through checkout. */
async function grantCredits(walletId: string, n: number): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after)
    values (${walletId}, ${n}, 'admin_adjust', 'grant', ${n})`;
}

/**
 * Orgs the GUARD seeded on this run, for teardown.
 *
 * The guard is always on, so without this every `npm test` would leave three
 * more organisations — one of them a 115-fixture, 88-entrant competition — in
 * the shared test database, for ever. That is not a tidiness point: suites here
 * that sweep ALL orgs go red on accumulated volume rather than on any defect,
 * and the failure reads as a race or a timeout rather than as bloat.
 *
 * The CAPTURE's orgs are deliberately NOT tracked. That path already refuses to
 * run against anything but a database the operator named as disposable, and its
 * rows are what you inspect afterwards to see what the run actually cost.
 */
const guardOrgIds: string[] = [];
const guardUserIds: string[] = [];

afterAll(async () => {
  if (!HAS_DB) return;
  // Orgs first: `org_members` references `users`, so the owners cannot go until
  // their memberships have. Everything the templates create — competitions,
  // divisions, entrants, fixtures, schedule_settings — cascades with the org,
  // which is the same shape `scripts/smoke.ts`'s cleanup(tag) relies on.
  if (guardOrgIds.length > 0) {
    // P9: courts must go BEFORE venues, and both before the org. P8 made
    // `courts.venue_id` ON DELETE RESTRICT deliberately (a venue with courts
    // must not vanish through the API), and a RESTRICT sitting inside the
    // organizations cascade path blocks the whole delete:
    //   update or delete on table "venues" violates foreign key constraint
    //   "courts_venue_id_org_id_fkey" on table "courts"
    // Deferral does not help: a RESTRICT is checked immediately even when the
    // constraint is DEFERRABLE, and this is one statement's own cascade
    // fan-out, not a multi-statement ordering the deferral could rescue.
    // No product code deletes an organisation, so this is harness-only
    // ordering — same fix as `scripts/smoke.ts`'s cleanup and
    // `usecases/__tests__/venues.test.ts`.
    // `fixtures.court_id` is ON DELETE RESTRICT for the same reason, so the
    // cards have to let go of their courts first.
    await sql`update fixtures set court_id = null, venue_id = null
              where org_id in ${sql(guardOrgIds)}`;
    await sql`delete from court_exceptions where org_id in ${sql(guardOrgIds)}`;
    await sql`delete from court_hours where org_id in ${sql(guardOrgIds)}`;
    await sql`delete from courts where org_id in ${sql(guardOrgIds)}`;
    await sql`delete from venues where org_id in ${sql(guardOrgIds)}`;
    await sql`delete from organizations where id in ${sql(guardOrgIds)}`;
  }
  if (guardUserIds.length > 0) {
    // `seedOrg("pro")` mints a subscription, and it does NOT go with the org:
    // the FK runs the other way (`organizations.subscription_id → subscriptions`,
    // no cascade), while `subscriptions.owner_user_id → users` has no ON DELETE
    // at all. So the row outlives its organisation and then blocks its owner
    // with `subscriptions_owner_fk`. Orgs → subscriptions → users is the only
    // order that holds, and it is the same "money rows before their owner"
    // shape `scripts/smoke.ts` uses.
    await sql`delete from subscriptions where owner_user_id in ${sql(guardUserIds)}`;
    await sql`delete from users where id in ${sql(guardUserIds)}`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ---------------------------------------------------------------------------
// The capture — CAPTURE_AI_DEMO=1 only, real network, real money
// ---------------------------------------------------------------------------

describe.skipIf(!CAPTURING || !HAS_DB)("capture a real architect run", () => {
  for (const t of TEMPLATES) {
    it(
      `captures ${t.slug}`,
      async () => {
        assertCaptureDatabase();
        loadAnthropicKeyIfAbsent();

        // pro_plus is the only plan holding BOTH gates a template can need —
        // `scheduling.ai` and, for the joint template, `scheduling.multi_division`.
        // The wallet is resolved after the plan, because `setOrgPlan` may mint
        // the subscription that IS the wallet id.
        const { auth } = await seedOrg("community");
        await setOrgPlan(auth.orgId, "pro_plus");
        await invalidateOrgEntitlements(auth.orgId);
        await grantCredits(await walletIdFor(auth.orgId), CAPTURE_CREDITS);

        const seeded = await t.seed(auth);

        // Built BEFORE the run, and at the anchored instant: this is the
        // reproducible half of the fixture, and a pack that fails to build must
        // cost nothing. The run then builds its own pack internally off the
        // wall clock — the two agree on the board, and differ only in `clock`
        // and in the compiled rules the run's own stage-1 pass produced.
        const { pack, movableIds } = await packFor(auth, seeded);
        const board = await boardFor(seeded, pack);

        const capturedAt = new Date().toISOString();
        const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

        const response = seeded.joint
          ? await aiPlanForCompetition(auth, seeded.competitionId, {
              division_ids: seeded.divisionIds,
              instruction: seeded.instruction,
              mode: "generate",
            })
          : await aiPlanForDivision(auth, seeded.divisionIds[0]!, {
              instruction: seeded.instruction,
              mode: seeded.mode,
            });

        const fixture: AiDemoFixture = {
          meta: {
            slug: seeded.slug,
            capturedAt,
            model: await servedModel(auth.orgId, seeded.competitionId),
            commit,
            mode: seeded.mode,
            joint: seeded.joint,
            instruction: seeded.instruction,
          },
          board,
          pack,
          movableIds: [...movableIds],
          response,
        };

        // WRITE FIRST, assert after. The run is paid for by the time we get
        // here; an assertion that fires must not also throw the recording away.
        //
        // Insertion order, NOT sorted keys: `pack.participants` and
        // `pack.poolIds` are keyed by fixture UUID and built in domain order.
        // Sorting them would reorder by a per-seed random key, and since
        // `normalizeIds` numbers placeholders by first appearance, the guard
        // above could then never match a reseed. Every object written here is
        // built by deterministic code, so insertion order is already stable.
        writeFileSync(fixturePath(seeded.slug), `${JSON.stringify(fixture, null, 2)}\n`);

        const wire = response as {
          proposal: unknown[];
          unschedulable: unknown[];
          blocking: unknown[];
          divergent_courts?: unknown[];
        };
        expect(Array.isArray(wire.proposal)).toBe(true);
        // Every movable fixture is accounted for, placed or refused — the same
        // completeness the server's own structural check enforces.
        expect(wire.proposal.length + wire.unschedulable.length).toBeGreaterThanOrEqual(
          movableIds.size,
        );
        if (seeded.slug === "finals-day") {
          // The hero template is the honest one: the rain leaves less playable
          // time than the displaced matches need, so a plan that claims to have
          // placed everything is a plan that did not read the board.
          expect(wire.unschedulable.length).toBeGreaterThan(0);
        }
        if (seeded.joint) {
          // Court 5 exists for the juniors alone — the divergence warning
          // firing on real data is this template's whole reason to be joint.
          expect(wire.divergent_courts ?? []).not.toHaveLength(0);
        }
      },
      CAPTURE_TIMEOUT_MS,
    );
  }
});

// ---------------------------------------------------------------------------
// The guard — always on
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("committed demo fixtures reproduce their board", () => {
  for (const t of TEMPLATES) {
    it(`${t.slug} rebuilds the pack it recorded`, async () => {
      let raw: string;
      try {
        raw = readFileSync(fixturePath(t.slug), "utf8");
      } catch {
        throw new Error(
          `no committed fixture at ${fixturePath(t.slug)} — run \`npm run capture:ai-demo\``,
        );
      }
      const committed = JSON.parse(raw) as { pack: unknown; movableIds: string[] };

      const { auth } = await seedOrg("pro");
      guardOrgIds.push(auth.orgId);
      if (auth.userId) guardUserIds.push(auth.userId);
      const seeded = await t.seed(auth);
      const { pack, movableIds } = await packFor(auth, seeded);

      expect(JSON.stringify(normalizeIds(pack))).toBe(
        JSON.stringify(normalizeIds(committed.pack)),
      );
      // The pack equality above is UUID-blind by construction, so the movable
      // SET is pinned by size here — a build that lost or gained a movable
      // fixture without otherwise changing the board would slip past it.
      expect(committed.movableIds).toHaveLength(movableIds.size);
    });
  }
});
