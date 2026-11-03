// W3 Task 3 (SW-M13; X-SW-29, RB3-23) — the W3 delta that takes the slot off every Swiss bye shell placed before the
// deploy. The delta is read by GLOB, never by number (it is renumbered at merge), and its OWN statement runs here, inside
// a rolled-back transaction on a dedicated client: it acts on the whole shared test DB, and a committed run would
// rewrite sibling suites' rows. Every assertion reads this test's own stage, so a sibling suite's rows cannot answer it.
//
// "Holds a slot" is the branch's ONE predicate (`holdsSlot`, lib/rebuild-slots.ts): time, court, venue or pin.
//
// single-sport: badminton — the delta reads `ext_key` and the slot columns, no sport field.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { connectionOptions, sql } from "@/lib/db";
import { holdsSlot } from "@/lib/rebuild-slots";
import { createCompetition } from "@/server/usecases/competitions";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createDivision, patchDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createCourt, createVenue } from "@/server/usecases/venues";
import { seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__w3_bye_shells_off_court\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a check meant for the SQL. */
const code = text.replace(/--.*$/gm, "").trim();

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Tx = postgres.TransactionSql;
const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back. */
async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema } });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return value as T;
}

interface Slot {
  id: string;
  ext_key: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

describe("W3 delta: the file", () => {
  it("exactly one delta carries the name, it is LOUD, and it is one UPDATE of fixtures", () => {
    expect(files, "one delta named *__w3_bye_shells_off_court.sql").toHaveLength(1);
    expect(text, "the header announces the data change").toMatch(/DATA CHANGE \(LOUD\)/);
    expect(code.split(";").filter((s) => s.trim() !== "").length, "one statement").toBe(1);
    expect(code).toMatch(/^update fixtures\b/);
  });
});

describe.runIf(HAS_DB)("W3 delta: bye shells come off the court", () => {
  it("two placed bye shells lose every slot field; a placed board is untouched; a second run changes nothing", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W3 delta " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 5 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null });
    await generateStageFixtures(auth, stage!.id); // mint the shells
    const venue = await createVenue(auth, { name: "Hall", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const rows = await sql<Slot[]>`
      select id, ext_key, scheduled_at, court_id, venue_id, schedule_locked from fixtures
      where stage_id = ${stage!.id} order by round_no, seq_in_round`;
    const byes = rows.filter((r) => r.ext_key !== null && /^sw-r\d+-bye$/.test(r.ext_key));
    const board = rows.find((r) => r.ext_key === "sw-r1-b1");
    expect(byes.length, "rig: an odd field mints two bye shells").toBe(2);
    expect(board, "rig: and round 1's first board").toBeDefined();
    const mine = [...byes.map((b) => b.id), board!.id];

    const verdict = await rolledBack(async (tx) => {
      // The pre-deploy state: both byes placed the two ways a writer did it (a full auto placement, and a pin alone),
      // and the board placed like the byes.
      await tx`
        update fixtures set scheduled_at = '2030-08-01T09:00:00Z', court_id = ${court.id}, venue_id = ${venue.id}, schedule_locked = true
        where id in ${tx([byes[0]!.id, board!.id])}`;
      await tx`update fixtures set schedule_locked = true where id = ${byes[1]!.id}`;
      const read = () =>
        tx<Slot[]>`select id, ext_key, scheduled_at, court_id, venue_id, schedule_locked from fixtures where id in ${tx(mine)}`;
      const before = await read();
      const first = await tx.unsafe<{ id: string }[]>(code);
      const after = await read();
      const second = await tx.unsafe(code);
      const again = await read();
      return { before, firstCount: first.count, after, secondCount: second.count, again };
    });
    const by = (list: Slot[], id: string) => list.find((r) => r.id === id)!;

    expect(byes.map((b) => holdsSlot(by(verdict.before, b.id))), "premise: both byes hold a slot before").toEqual([true, true]);
    expect(holdsSlot(by(verdict.before, board!.id)), "premise: the board holds one too").toBe(true);
    expect(verdict.firstCount, "the first run changed at least this test's two byes").toBeGreaterThanOrEqual(2);
    for (const b of byes) {
      const r = by(verdict.after, b.id);
      expect({ at: r.scheduled_at, court: r.court_id, venue: r.venue_id, pin: r.schedule_locked }, `bye ${b.ext_key} is slotless`).toEqual({
        at: null,
        court: null,
        venue: null,
        pin: false,
      });
    }
    expect(by(verdict.after, board!.id), "the board is untouched").toEqual(by(verdict.before, board!.id));
    expect(verdict.secondCount, "a second run changes 0 rows").toBe(0);
    expect(verdict.again, "… and moves nothing").toEqual(verdict.after);
  }, 120_000);
});

// W3 Task 6 (spec §4, ruling 251; X-SW-8, X-SW-12) — the delta that gives each entrant a first Swiss round. A schema change
// only: Task 0's count 4 was 0 on stg and on prod, so it backfills nothing (its LOUD comment block says what is
// owed if prod's count 4 is > 0). Read by glob like the delta above; its statement re-run inside a rolled-back transaction.
// single-sport: badminton — the delta is a column on entrants and reads no sport field.
const FIRST_ROUND_NAME = /^V\d+__w3_swiss_first_round\.sql$/;
const firstRoundFiles = readdirSync(DELTAS).filter((f) => FIRST_ROUND_NAME.test(f));
const firstRoundText = firstRoundFiles.length === 1 ? readFileSync(resolve(DELTAS, firstRoundFiles[0]!), "utf8") : "";
const firstRoundCode = firstRoundText.replace(/--.*$/gm, "").trim();

describe("W3 delta: swiss_first_round, the file", () => {
  it("exactly one delta carries the name, and it is one idempotent ADD COLUMN on entrants — no data move", () => {
    expect(firstRoundFiles, "one delta named *__w3_swiss_first_round.sql").toHaveLength(1);
    expect(firstRoundCode.split(";").filter((s) => s.trim() !== "").length, "one statement").toBe(1);
    expect(firstRoundCode).toMatch(/^alter table entrants add column if not exists swiss_first_round int\b/);
    expect(firstRoundCode, "the column carries its check").toMatch(/check \(swiss_first_round >= 1\)/);
    // A backfill would be a DATA CHANGE and must say so; this delta moves no stored value.
    expect(firstRoundCode, "no update statement").not.toMatch(/\bupdate\b/i);
  });
});

describe.runIf(HAS_DB)("W3 delta: swiss_first_round on entrants", () => {
  it("the column exists, nullable; the check rejects 0 and accepts 1; a second run is a no-op", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W3 first round " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    const [entrant] = await createEntrants(auth, division.id, [{ kind: "individual" as const, display_name: "P1", seed: 1, members: [] }]);
    const id = entrant!.id;

    const verdict = await rolledBack(async (tx) => {
      const column = () =>
        tx<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
          select data_type, is_nullable, column_default from information_schema.columns
          where table_schema = current_schema() and table_name = 'entrants' and column_name = 'swiss_first_round'`;
      const checks = () =>
        tx<{ def: string }[]>`
          select pg_get_constraintdef(c.oid) as def from pg_constraint c
          where c.conrelid = 'entrants'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%swiss_first_round%'`;
      const stored = async () => (await tx<{ v: number | null }[]>`select swiss_first_round as v from entrants where id = ${id}`)[0]!.v;
      /** The update's SQLSTATE, or "ok" — under a savepoint, so a refusal leaves the transaction usable. */
      const set = async (v: number) => {
        try {
          await tx.savepoint((sp) => sp`update entrants set swiss_first_round = ${v} where id = ${id}`);
          return "ok";
        } catch (e) {
          return (e as { code?: string }).code ?? "error";
        }
      };
      const columnBefore = await column();
      const checksBefore = await checks();
      const fresh = await stored();
      const zero = await set(0);
      const one = await set(1);
      const three = await set(3);
      await tx.unsafe(firstRoundCode);
      return { columnBefore, checksBefore, fresh, zero, one, three, columnAfter: await column(), checksAfter: await checks(), kept: await stored() };
    });

    expect(verdict.columnBefore, "the applied schema has the column: an integer, nullable, no default").toEqual([
      { data_type: "integer", is_nullable: "YES", column_default: null },
    ]);
    expect(verdict.checksBefore.map((c) => c.def), "one check on it").toEqual(["CHECK ((swiss_first_round >= 1))"]);
    expect(verdict.fresh, "an entrant enrolled the ordinary way plays from round 1 (null)").toBeNull();
    expect(verdict.zero, "the check rejects 0 (23514 check_violation)").toBe("23514");
    expect([verdict.one, verdict.three], "and accepts 1 and 3").toEqual(["ok", "ok"]);
    expect(verdict.columnAfter, "a second run leaves the column as it was").toEqual(verdict.columnBefore);
    expect(verdict.checksAfter, "… adds no second check").toEqual(verdict.checksBefore);
    expect(verdict.kept, "… and moves no stored value").toBe(3);
  }, 120_000);
});

// W3 Task 9 (ruling 250; T6 carry 2) — the delta that scopes an entrant's first Swiss round to the stage that stamped it
// (`swiss_first_round_stage_id`). A schema change only: no writer of `swiss_first_round` has shipped, so no stored stamp
// is left without its stage. Read by glob like the deltas above; its statement re-run inside a rolled-back transaction.
// single-sport: badminton — the delta is a column on entrants and reads no sport field.
const STAGE_SCOPE_NAME = /^V\d+__w3_swiss_first_round_stage\.sql$/;
const stageScopeFiles = readdirSync(DELTAS).filter((f) => STAGE_SCOPE_NAME.test(f));
const stageScopeText = stageScopeFiles.length === 1 ? readFileSync(resolve(DELTAS, stageScopeFiles[0]!), "utf8") : "";
const stageScopeCode = stageScopeText.replace(/--.*$/gm, "").trim();

describe("W3 delta: swiss_first_round_stage_id, the file", () => {
  it("exactly one delta carries the name: an idempotent ADD COLUMN on entrants referencing stages, and its index — no data move", () => {
    expect(stageScopeFiles, "one delta named *__w3_swiss_first_round_stage.sql").toHaveLength(1);
    expect(stageScopeCode.split(";").filter((s) => s.trim() !== "").length, "two statements").toBe(2);
    expect(stageScopeCode).toMatch(
      /^alter table entrants add column if not exists swiss_first_round_stage_id uuid\s+references stages\(id\) on delete set null;\s*create index if not exists entrants_swiss_first_round_stage_idx on entrants \(swiss_first_round_stage_id\)\s+where swiss_first_round_stage_id is not null;$/,
    );
    expect(stageScopeCode, "no update statement").not.toMatch(/\bupdate\b/i);
  });
});

describe.runIf(HAS_DB)("W3 delta: swiss_first_round_stage_id on entrants", () => {
  it("the column exists, nullable; deleting the stage clears the stamp's stage; a second run is a no-op", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W3 stage scope " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    const [entrant] = await createEntrants(auth, division.id, [{ kind: "individual" as const, display_name: "P1", seed: 1, members: [] }]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null });
    const id = entrant!.id;

    const verdict = await rolledBack(async (tx) => {
      const column = () =>
        tx<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
          select data_type, is_nullable, column_default from information_schema.columns
          where table_schema = current_schema() and table_name = 'entrants' and column_name = 'swiss_first_round_stage_id'`;
      const fks = () =>
        tx<{ def: string }[]>`
          select pg_get_constraintdef(c.oid) as def from pg_constraint c
          where c.conrelid = 'entrants'::regclass and c.contype = 'f' and pg_get_constraintdef(c.oid) like '%swiss_first_round_stage_id%'`;
      const stored = async () =>
        (await tx<{ r: number | null; s: string | null }[]>`
          select swiss_first_round as r, swiss_first_round_stage_id as s from entrants where id = ${id}`)[0]!;
      const indexes = () =>
        tx<{ def: string }[]>`
          select indexdef as def from pg_indexes
          where schemaname = current_schema() and tablename = 'entrants' and indexdef like '%swiss_first_round_stage_id%'`;
      const columnBefore = await column();
      const fksBefore = await fks();
      const indexesBefore = await indexes();
      const fresh = await stored();
      await tx`update entrants set swiss_first_round = 2, swiss_first_round_stage_id = ${stage!.id} where id = ${id}`;
      await tx.unsafe(stageScopeCode);
      const kept = await stored();
      const indexesAfter = await indexes();
      await tx`delete from stages where id = ${stage!.id}`;
      return { columnBefore, fksBefore, indexesBefore, indexesAfter, fresh, kept, columnAfter: await column(), fksAfter: await fks(), orphaned: await stored() };
    });

    expect(verdict.columnBefore, "the applied schema has the column: a uuid, nullable, no default").toEqual([
      { data_type: "uuid", is_nullable: "YES", column_default: null },
    ]);
    expect(verdict.fksBefore.map((c) => c.def), "one foreign key, to stages, set null on delete").toEqual([
      "FOREIGN KEY (swiss_first_round_stage_id) REFERENCES stages(id) ON DELETE SET NULL",
    ]);
    // T9 review m8: the foreign key's referencing column is indexed (a stage delete's set-null finds its rows without a scan).
    expect(verdict.indexesBefore.map((i) => i.def.replace(/\b\w+\.entrants\b/, "entrants")), "one partial index on the stage column").toEqual([
      "CREATE INDEX entrants_swiss_first_round_stage_idx ON entrants USING btree (swiss_first_round_stage_id) WHERE (swiss_first_round_stage_id IS NOT NULL)",
    ]);
    expect(verdict.indexesAfter, "a second run adds no second index").toEqual(verdict.indexesBefore);
    expect(verdict.fresh, "an entrant enrolled the ordinary way has no stamp and no stage").toEqual({ r: null, s: null });
    expect(verdict.columnAfter, "a second run leaves the column as it was").toEqual(verdict.columnBefore);
    expect(verdict.fksAfter, "… adds no second key").toEqual(verdict.fksBefore);
    expect(verdict.kept, "… and moves no stored value").toEqual({ r: 2, s: stage!.id });
    expect(verdict.orphaned, "the stage deleted: the stamp's stage is null, so the stamp counts nowhere").toEqual({ r: 2, s: null });
  }, 120_000);
});

// W3 App B Task 2 (X-SW-6, ruling 251; boardgame FOLD_EPOCH 4 → 5) — the delta that removes the stored `byeScore` from a
// board game's config in all five places a sport config is stored, before the deploy. DATA CHANGE (LOUD). Read by glob like
// the deltas above. The block runs here inside a transaction that is always rolled back, scoped to the seeded organization as
// the app's tenant role (`app_user` + `app.current_org`, as w2e-migration.test.ts does): RLS shows the run that org's rows
// alone, so every count is the seed's and the empty case is deterministic on the shared test DB. One test (the started-division
// save) COMMITS an org-scoped run, because the save it proves goes through the app's own pool.
//
// Expected values: the scope (which sports ever stored the key) is boardgame's alone, read from the engine 1.1.0 package the
// app ran on until this branch (dist/sports/boardgame/boardgame.js is the one sport file declaring `byeScore`); the sibling
// keys are the seeded values minus the key, never read back from the SQL under test.
const BYE_SCORE_NAME = /^V\d+__w3_bye_score_cleanup\.sql$/;
const byeScoreFiles = readdirSync(DELTAS).filter((f) => BYE_SCORE_NAME.test(f));
const byeScoreText = byeScoreFiles.length === 1 ? readFileSync(resolve(DELTAS, byeScoreFiles[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a check meant for the SQL. */
const byeScoreCode = byeScoreText.replace(/--.*$/gm, "");
const BYE_SCORE_BLOCK = /do \$\$[\s\S]*?end \$\$;/.exec(byeScoreCode)?.[0];
const byeScoreUpdates = (BYE_SCORE_BLOCK ?? "")
  .split(";")
  .map((x) => x.trim().replace(/^begin\s+/i, ""))
  .filter((x) => /^update\s/i.test(x));

/** V481's names for the five places a sport config is stored; the notices name them the same way. */
const PLACES = ["divisions.config", "stages.config.rules", "fixtures.rules_override", "fixtures.config_snapshot", "match_states.state.cfg"] as const;
type Place = (typeof PLACES)[number];
const BOARDGAME = "boardgame";

describe("W3 delta: byeScore cleanup, the file", () => {
  it("X-SW-6 exactly one delta carries the name; it is LOUD, names the five places and stg's count, and is five updates scoped to boardgame, each guarded by the key", () => {
    expect(byeScoreFiles, "one delta named *__w3_bye_score_cleanup.sql").toHaveLength(1);
    expect(byeScoreText, "the header announces the data change").toMatch(/DATA CHANGE \(LOUD\)/);
    for (const place of ["divisions.config", "stages.config->'rules'", "fixtures.rules_override", "fixtures.config_snapshot", "match_states.state->'cfg'"]) {
      expect(byeScoreText, `the header names ${place}`).toContain(place);
    }
    expect(byeScoreText, "the header quotes stg's count (13 / 0 / 0 / 23 / 28, read 2026-11-02)").toContain("13 / 0 / 0 / 23 / 28");
    expect(BYE_SCORE_BLOCK, "one DO block").toBeDefined();
    expect(byeScoreCode.replace(BYE_SCORE_BLOCK ?? "", "").trim(), "and nothing outside it").toBe("");
    expect(byeScoreUpdates, "one update per place").toHaveLength(PLACES.length);
    for (const u of byeScoreUpdates) {
      expect(u, "scoped by the division's sport").toMatch(/\bsport_key = 'boardgame'/);
      expect(u, "guarded by the key, so a second run matches nothing").toMatch(/\? 'byeScore'/);
    }
    expect([...new Set([...byeScoreCode.matchAll(/sport_key\s*(?:=|in)\s*\(?\s*'([a-z]+)'/g)].map((m) => m[1]))], "boardgame is the only sport named").toEqual([BOARDGAME]);
    expect(builtinModules.some((m) => m.key === BOARDGAME), "premise: boardgame is a builtin sport").toBe(true);
  });
});

type Json = Record<string, unknown>;

/** `body` on its own one-connection client inside a transaction that is always rolled back; the notices it raised. */
async function rolledBackWithNotices<T>(body: (tx: Tx, notices: string[]) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, {
    max: 1,
    ssl: connectionOptions(url).ssl,
    connection: { search_path: connectionOptions(url).schema },
    onnotice: (n) => notices.push(String(n.message)),
  });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx, notices);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return value as T;
}

/** The rest of `tx` as the app's tenant role for `orgId` (`withTenant`): RLS shows that org's rows alone. */
async function asTenant(tx: Tx, orgId: string): Promise<void> {
  await tx`select set_config('app.current_org', ${orgId}, true)`;
  await tx`set local role app_user`;
}

/** One division + stage + fixture (+ state) as a pre-deploy server stored them, written raw. */
interface ByeSeed {
  sport: string;
  variant: string;
  division: Json;
  /** The whole `stages.config`: `rules` is the overlay, its other keys are not sport config. */
  stageConfig: Json;
  override: Json | null;
  snapshot: Json | null;
  /** The whole `match_states.state`: `cfg` is the sport config, the rest is the fold the delta must leave alone. */
  state: Json | null;
}
interface Stored {
  division: Json;
  stage: Json;
  override: Json | null;
  snapshot: Json | null;
  state: Json | null;
}

async function seedByeRows(tx: Tx, seeds: readonly ByeSeed[]): Promise<{ orgId: string; ids: { division: string; stage: string; fixture: string }[] }> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await tx<{ id: string }[]>`insert into organizations (name, slug) values (${"W3 bye " + suffix}, ${"w3-bye-" + suffix}) returning id`;
  const [comp] = await tx<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${org!.id}, ${"W3 bye " + suffix}, ${"w3-bye-" + suffix}) returning id`;
  const j = (v: Json | null) => (v === null ? null : tx.json(v as never));
  const ids: { division: string; stage: string; fixture: string }[] = [];
  for (const [i, s] of seeds.entries()) {
    const [d] = await tx<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
      values (${comp!.id}, ${org!.id}, ${s.sport + " " + i}, ${"d-" + i}, ${s.sport}, ${s.variant}, ${tx.json(s.division as never)},
              (select module_version from sports where key = ${s.sport}))
      returning id`;
    const [st] = await tx<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, config)
      values (${d!.id}, ${org!.id}, 1, 'league', 'S1', ${tx.json(s.stageConfig as never)}) returning id`;
    const [f] = await tx<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, rules_override, config_snapshot)
      values (${st!.id}, ${d!.id}, ${org!.id}, 1, 1, ${j(s.override)}, ${j(s.snapshot)}) returning id`;
    if (s.state !== null) {
      await tx`insert into match_states (fixture_id, org_id, last_seq, state, summary)
               values (${f!.id}, ${org!.id}, 0, ${tx.json(s.state as never)}, ${tx.json({ marker: "summary " + i } as never)})`;
    }
    ids.push({ division: d!.id, stage: st!.id, fixture: f!.id });
  }
  return { orgId: org!.id, ids };
}

async function readByeRow(tx: Tx, id: { division: string; stage: string; fixture: string }): Promise<Stored> {
  const [r] = await tx<{ division: Json; stage: Json; override: Json | null; snapshot: Json | null; state: Json | null }[]>`
    select d.config as division, s.config as stage, f.rules_override as override, f.config_snapshot as snapshot, m.state as state
      from divisions d
      join stages s on s.id = ${id.stage}
      join fixtures f on f.id = ${id.fixture}
      left join match_states m on m.fixture_id = f.id
     where d.id = ${id.division}`;
  return r!;
}

/** The object each place keeps the sport config in, so "carries byeScore" is asked of the same thing in every place. */
const configIn = (place: Place, row: Stored | ByeSeed): Json | null => {
  const r = row as unknown as Json;
  switch (place) {
    case "divisions.config":
      return (r.division as Json | undefined) ?? null;
    case "stages.config.rules":
      return (((r.stage ?? r.stageConfig) as Json | undefined)?.rules as Json | undefined) ?? null;
    case "fixtures.rules_override":
      return (r.override as Json | null | undefined) ?? null;
    case "fixtures.config_snapshot":
      return (r.snapshot as Json | null | undefined) ?? null;
    case "match_states.state.cfg":
      return ((r.state as Json | null | undefined)?.cfg as Json | undefined) ?? null;
  }
};
const carries = (place: Place, row: Stored | ByeSeed): boolean => {
  const cfg = configIn(place, row);
  return cfg !== null && Object.hasOwn(cfg, "byeScore");
};
const without = (cfg: Json): Json => Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== "byeScore"));
/** What the delta must leave: the seed with `byeScore` out of the one object each place keeps its config in. */
const expectedAfter = (s: ByeSeed): Stored => ({
  division: without(s.division),
  stage: { ...s.stageConfig, ...(s.stageConfig.rules ? { rules: without(s.stageConfig.rules as Json) } : {}) },
  override: s.override === null ? null : without(s.override),
  snapshot: s.snapshot === null ? null : without(s.snapshot),
  state: s.state === null ? null : { ...s.state, cfg: without(s.state.cfg as Json) },
});
const asSeeded = (s: ByeSeed): Stored => ({ division: s.division, stage: s.stageConfig, override: s.override, snapshot: s.snapshot, state: s.state });

/** A seed that carries `byeScore: 2` in all five places beside siblings, for a sport. */
function carrying(sport: string, variant: string, base: Json): ByeSeed {
  const withKey = { ...base, byeScore: 2 };
  return {
    sport,
    variant,
    division: withKey,
    stageConfig: { rounds: 5, rules: { colors: false, byeScore: 2 } },
    override: { colors: false, byeScore: 2 },
    snapshot: withKey,
    state: { cfg: withKey, marker: "fold " + sport },
  };
}
/** The same shape without the key: the control the delta must not touch. */
const clean = (s: ByeSeed): ByeSeed => ({
  ...s,
  division: without(s.division),
  stageConfig: { ...s.stageConfig, rules: { colors: false } },
  override: { colors: false },
  snapshot: without(s.snapshot!),
  state: { ...s.state!, cfg: without((s.state as Json).cfg as Json) },
});

/** A boardgame chain carrying the key in exactly `places` (the rest of its places are clean), for staggered tallies. */
function carryingIn(places: readonly Place[], base: Json): ByeSeed {
  const s = clean(carrying(BOARDGAME, "classical", base));
  const withKey = (cfg: Json): Json => ({ ...cfg, byeScore: 2 });
  return {
    ...s,
    division: places.includes("divisions.config") ? withKey(s.division) : s.division,
    stageConfig: places.includes("stages.config.rules") ? { ...s.stageConfig, rules: withKey(s.stageConfig.rules as Json) } : s.stageConfig,
    override: places.includes("fixtures.rules_override") ? withKey(s.override!) : s.override,
    snapshot: places.includes("fixtures.config_snapshot") ? withKey(s.snapshot!) : s.snapshot,
    state: places.includes("match_states.state.cfg") ? { ...s.state!, cfg: withKey((s.state as Json).cfg as Json) } : s.state,
  };
}

interface Verdict {
  counted: Record<Place, number>;
  changed: Record<Place, number>;
}
/** Runs the block; the counts it reported before writing and the rows each update changed. Throws on any other notice. */
async function runByeScoreDelta(tx: Tx, notices: string[]): Promise<Verdict> {
  const from = notices.length;
  expect(BYE_SCORE_BLOCK, "the delta's DO block was found").toBeDefined();
  await tx.unsafe(BYE_SCORE_BLOCK!);
  const counted = {} as Record<Place, number>;
  const changed = {} as Record<Place, number>;
  for (const n of notices.slice(from)) {
    const before = /^W3 bye score cleanup: counted before writing (.+)$/.exec(n);
    const wrote = /^W3 bye score cleanup: (\S+) byeScore=(\d+)$/.exec(n);
    if (before) {
      for (const m of before[1]!.matchAll(/(\S+)=(\d+)/g)) counted[m[1] as Place] = Number(m[2]);
    } else if (wrote) {
      changed[wrote[1] as Place] = Number(wrote[2]);
    } else {
      throw new Error(`a notice that is not the delta's: ${n}`);
    }
  }
  expect(Object.keys(counted).sort(), "a count per place, before writing").toEqual([...PLACES].sort());
  expect(Object.keys(changed).sort(), "a change count per place").toEqual([...PLACES].sort());
  expect(Object.keys(changed).length, "… and one update per place").toBe(byeScoreUpdates.length);
  return { counted, changed };
}

const ALL_ZERO: Record<Place, number> = Object.fromEntries(PLACES.map((p) => [p, 0])) as Record<Place, number>;
const ALL_ONE: Record<Place, number> = Object.fromEntries(PLACES.map((p) => [p, 1])) as Record<Place, number>;

/** boardgame's own declared defaults (the engine parse of {}) — the sibling keys a real stored config holds. */
const boardgameDefaults = (): Json => {
  const m = builtinModules.find((x) => x.key === BOARDGAME)!;
  return m.configSchema.parse({}) as Json;
};

describe.runIf(HAS_DB)("W3 delta: byeScore cleanup", () => {
  it("X-SW-6 the cleanup removes byeScore from a boardgame division, a stage rules overlay, a rules_override, a config_snapshot and a match_states cfg (5 places, counted)", async () => {
    // Staggered chains, so the five per-place counts are five DIFFERENT numbers and a count or a label put on the wrong place
    // cannot read as right: A carries all five places, B everything but the stage rules, C the division, snapshot and state,
    // D the division and state, E the division alone; a control carries none.
    const [A, B, C, D, E] = [
      ["divisions.config", "stages.config.rules", "fixtures.rules_override", "fixtures.config_snapshot", "match_states.state.cfg"],
      ["divisions.config", "fixtures.rules_override", "fixtures.config_snapshot", "match_states.state.cfg"],
      ["divisions.config", "fixtures.config_snapshot", "match_states.state.cfg"],
      ["divisions.config", "match_states.state.cfg"],
      ["divisions.config"],
    ] satisfies Place[][];
    const base = boardgameDefaults();
    const dirty = [A, B, C, D, E].map((places) => carryingIn(places, base));
    const control = clean(carrying(BOARDGAME, "classical", base));
    // What each place holds, tallied from the seeds themselves with the same `carries` that reads the result back.
    const tally = Object.fromEntries(PLACES.map((p) => [p, dirty.filter((d) => carries(p, d)).length])) as Record<Place, number>;
    expect(new Set(Object.values(tally)).size, "premise: five distinct per-place counts").toBe(PLACES.length);
    expect(Math.min(...Object.values(tally)), "premise: every place holds at least one").toBeGreaterThan(0);
    expect(PLACES.map((p) => carries(p, control)), "premise: the control carries it in none").toEqual([false, false, false, false, false]);
    for (const d of dirty) {
      for (const p of PLACES) if (carries(p, d)) expect(Object.keys(without(configIn(p, d)!)).length, `${p}: a sibling key to keep`).toBeGreaterThan(0);
    }

    const out = await rolledBackWithNotices(async (tx, notices) => {
      const { orgId, ids } = await seedByeRows(tx, [...dirty, control]);
      await asTenant(tx, orgId);
      const verdict = await runByeScoreDelta(tx, notices);
      const rows: Stored[] = [];
      for (const id of ids) rows.push(await readByeRow(tx, id));
      return { verdict, rows };
    });

    expect(out.verdict.counted, "counted before writing, place by place, is what the seeds hold").toEqual(tally);
    expect(out.verdict.changed, "and the rows written, place by place, are the rows counted").toEqual(out.verdict.counted);
    let checked = 0;
    for (const [i, seed] of dirty.entries()) {
      const row = out.rows[i]!;
      for (const place of PLACES) {
        if (!carries(place, seed)) continue;
        expect(carries(place, row), `chain ${"ABCDE"[i]} ${place}: byeScore is gone`).toBe(false);
        checked++;
      }
      expect(row, `chain ${"ABCDE"[i]}: every sibling key, in every place, is what was seeded (the stage's own keys and the state's fold included)`).toEqual(expectedAfter(seed));
      expect(row.state?.marker, "the state's fold marker is not the delta's to touch").toBe("fold boardgame");
    }
    expect(checked, "anti-vacuity: every (chain, place) that carried the key was checked").toBe(Object.values(tally).reduce((a, b) => a + b, 0));
    expect(checked).toBeGreaterThan(0);
    expect(out.rows[dirty.length], "a boardgame row without the key is untouched").toEqual(asSeeded(control));
  }, 120_000);

  it("X-SW-6 the cleanup never touches a non-boardgame row that happens to carry the key", async () => {
    // Every other sport the engine registers, each carrying the key in all five places, beside one boardgame row that proves
    // the run was not a no-op (the positive pair: the scope is what spares the others, not the delta doing nothing).
    const others = builtinModules.filter((m) => m.key !== BOARDGAME);
    const seeds = others.map((m) => carrying(m.key, Object.keys(m.variants)[0]!, m.variants[Object.keys(m.variants)[0]!] as Json));
    const bg = carrying(BOARDGAME, "classical", boardgameDefaults());

    const out = await rolledBackWithNotices(async (tx, notices) => {
      const { orgId, ids } = await seedByeRows(tx, [bg, ...seeds]);
      await asTenant(tx, orgId);
      const verdict = await runByeScoreDelta(tx, notices);
      const rows: Stored[] = [];
      for (const id of ids) rows.push(await readByeRow(tx, id));
      return { verdict, rows };
    });

    expect(out.verdict.counted, "only the boardgame row was counted").toEqual(ALL_ONE);
    expect(out.verdict.changed, "and only it was written").toEqual(ALL_ONE);
    expect(PLACES.some((p) => carries(p, out.rows[0]!)), "the boardgame row lost the key everywhere").toBe(false);
    let spared = 0;
    for (const [i, s] of seeds.entries()) {
      expect(out.rows[i + 1], `${s.sport}: untouched, byeScore and all`).toEqual(asSeeded(s));
      for (const place of PLACES) {
        expect(carries(place, out.rows[i + 1]!), `${s.sport} ${place}: still carries it`).toBe(true);
        spared++;
      }
    }
    expect(others.length, "the sweep covers the engine's registry less boardgame").toBe(builtinModules.length - 1);
    expect(spared, "anti-vacuity: every other sport, five places each").toBe(others.length * PLACES.length);
    expect(spared).toBeGreaterThan(0);
  }, 120_000);

  it("X-SW-6 a second run changes 0 rows, and a run over an organization with no boardgame row changes 0", async () => {
    const dirty = carrying(BOARDGAME, "classical", boardgameDefaults());
    const out = await rolledBackWithNotices(async (tx, notices) => {
      // The empty case first: a fresh organization holding no row at all.
      const empty = await seedByeRows(tx, []);
      await asTenant(tx, empty.orgId);
      const none = await runByeScoreDelta(tx, notices);
      // Back to the connecting role to seed the dirty row, then the tenant again.
      await tx`reset role`;
      const { orgId, ids } = await seedByeRows(tx, [dirty]);
      await asTenant(tx, orgId);
      const first = await runByeScoreDelta(tx, notices);
      const afterFirst = await readByeRow(tx, ids[0]!);
      const second = await runByeScoreDelta(tx, notices);
      const afterSecond = await readByeRow(tx, ids[0]!);
      return { none, first, afterFirst, second, afterSecond };
    });
    expect(out.none.counted, "nothing to count in an empty organization").toEqual(ALL_ZERO);
    expect(out.none.changed, "and nothing written").toEqual(ALL_ZERO);
    expect(out.first.changed, "premise: the first run wrote one row in each place").toEqual(ALL_ONE);
    expect(out.second.counted, "a second run counts 0 …").toEqual(ALL_ZERO);
    expect(out.second.changed, "… changes 0 rows in every place").toEqual(ALL_ZERO);
    expect(out.afterSecond, "… and moves nothing").toEqual(out.afterFirst);
  }, 120_000);
});

describe.runIf(HAS_DB)("W3 delta: a started boardgame division that still stores byeScore", () => {
  it("X-SW-6 a started boardgame division whose stored config still carries byeScore refuses its next save by name, and saves after the delta strips the key", async () => {
    const s = await seedBracket({ sport: BOARDGAME, variant: "classical", stageKind: "swiss", stageConfig: { rounds: 3 }, entrants: 4 });
    await post(s.auth, s.fixtureIds[0]!, "core.start");
    // The pre-deploy stored shape: a 1.x server wrote the default beside the rest of the config.
    await sql`update divisions set config = config || '{"byeScore": 2}'::jsonb where id = ${s.divisionId}`;
    const stored = async () => (await sql<{ config: Json }[]>`select config from divisions where id = ${s.divisionId}`)[0]!.config;
    const legacy = await stored();
    expect(legacy.byeScore, "rig: the stored config carries the key").toBe(2);
    // The Settings page re-sends the stored config on every save; the engine's parse strips the key, so it reads as a change.
    await expect(patchDivision(s.auth, s.divisionId, { config: legacy } as never)).rejects.toMatchObject({
      status: 409,
      code: "DIVISION_FORMAT_LOCKED",
      extra: { refused: [expect.objectContaining({ field: "byeScore", code: "DIVISION_FORMAT_LOCKED" })] },
    });
    // The delta, committed, scoped by RLS to this fresh organization.
    const url = process.env.DATABASE_URL!;
    const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema }, onnotice: () => {} });
    try {
      await client.begin(async (tx) => {
        await asTenant(tx, s.auth.orgId);
        expect(BYE_SCORE_BLOCK, "the delta's DO block was found").toBeDefined();
        await tx.unsafe(BYE_SCORE_BLOCK!);
      });
    } finally {
      await client.end();
    }
    const migrated = await stored();
    expect("byeScore" in migrated, "the delta removed it").toBe(false);
    expect(migrated, "and every sibling key is what was stored").toEqual(without(legacy));
    const saved = await patchDivision(s.auth, s.divisionId, { name: "Renamed", config: migrated } as never);
    expect(saved.refused, "the same save, nothing refused").toEqual([]);
    expect(saved.name, "and the unrelated field landed").toBe("Renamed");
  }, 120_000);
});
