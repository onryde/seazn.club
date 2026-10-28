import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, call, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W2d (spec 2026-10-20, tables and tie-breaks) — PR A's smoke proof, over real HTTP against a live server.
 * A stage is pinned when it is generated (V475 `table_rules_pinned_at`, read from the database: PR A ships no HTTP reader
 * of the pin), and a residual tie that only lots can split is drawn ONCE and stored (`stage_lots_draws`), so two reloads
 * of the table across a later recompute give the same order. A generic league of six under 3/1/0: A beats C and B beats
 * D, leaving A and B level on every step before lots (they have not met), and likewise C and D; E–F's later draw
 * recomputes the table without touching either class. Own fresh owner; needs DATABASE_URL (the pin read). Every check is
 * counted, and a run that checked nothing fails. SMOKE_ONLY=w2dTables runs it alone (SELECTABLE_SUITES). PR B Task 17
 * (PS-9e): the competition is public, and its PUBLIC standings carry what the public table prints — `level` on every row
 * before a result counts, and a lots-decided row's `tieBreak.drawnAt`, the stored draw's own instant.
 */
export async function w2dTablesSuite(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the W2d tables smoke (the pin is read from the database)");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  // 9 (W2b/W2d base) + 3 (Task 14, §13: a stage's own rules to the public table) + 1 (Task 17, PS-9e: drawnAt and level).
  const EXPECTED_CHECKS = 13;
  let checked = 0;
  const w2dCheck = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };
  try {
    const owner = newSession();
    const who = await signIn(owner, `delivered+w2d_${tag}@resend.dev`);
    // Public by default (V396/T15): the suite's one competition is within the free plan's public cap, so its tables are
    // served on the public standings route (Task 14's §13 read, and Task 17's drawnAt / level read). No explicit
    // visibility: Task 14's check reads the DEFAULT.
    const comp = v1data<{ id: string; slug: string; visibility: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2d Tables ${tag}` }),
    );
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "W2d Table",
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    )?.id;
    const names = ["A", "B", "C", "D", "E", "F"] as const;
    const entrants = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        names.map((n, i) => ({ kind: "individual", display_name: `${n} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const id = Object.fromEntries(names.map((n, i) => [n, entrants[i]?.id ?? `missing ${n}`])) as Record<(typeof names)[number], string>;
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: "Table" }),
    )?.id ?? "";
    const pinOf = async () =>
      (await sql<{ pinned_at: Date | null; sources: unknown }[]>`
        select table_rules_pinned_at as pinned_at, table_rules_pinned -> 'sources' as sources from stages where id = ${stageId}`)[0];

    const before = await pinOf();
    w2dCheck(
      "w2d: a stage is unpinned before it is generated" + (before?.pinned_at === null ? "" : ` — got ${JSON.stringify(before)}`),
      entrants.length === 6 && before !== undefined && before.pinned_at === null && before.sources === null,
    );
    // W2d Task 13 (spec §7, §10): the table rules over API v1 — refused by name, served with their source, kept by a pin.
    type TableRulesWire = { tiebreakers: { keys: string[]; source: string; pinnedAt: string | null; sportDefault: string[] } };
    const tableRules = async () =>
      v1data<{ tableRules: TableRulesWire | null } | undefined>(await v1(owner, `/api/v1/stages/${stageId}`))?.tableRules ?? null;
    // `nrr` is cricket's net run rate: generic records no such ledger, so the validator refuses it for the sport.
    const invalid = await v1(owner, `/api/v1/stages/${stageId}/rules`, "PUT", { tiebreakers: ["points", "nrr", "lots"] });
    const invalidErr = (invalid.json as { error?: { code?: string; refusals?: { index: number; key: string; reason: string }[] } } | null)?.error;
    const unsaved = await tableRules();
    w2dCheck(
      "w2d: an invalid order is refused by name — 422 TIEBREAK_KEY_INVALID naming nrr (index 1) for the sport, nothing stored" +
        (invalid.status === 422 ? "" : ` — got ${invalid.status} ${JSON.stringify(invalid.json)}`),
      invalid.status === 422 &&
        invalidErr?.code === "TIEBREAK_KEY_INVALID" &&
        invalidErr.refusals?.[0]?.index === 1 &&
        invalidErr.refusals[0].key === "nrr" &&
        invalidErr.refusals[0].reason === "sport" &&
        unsaved?.tiebreakers.source === "sport",
    );
    // A division default before the generate: the pending stage reads it, and says so.
    const DIV_ORDER = ["points", "diff", "for", "lots"];
    const divDefault = await v1(owner, `/api/v1/divisions/${divId}`, "PATCH", { tiebreakers: DIV_ORDER });
    const inherited = await tableRules();
    w2dCheck(
      "w2d: GET /stages/{id} tableRules says where the order came from — the division's default, unpinned, beside the sport's own" +
        (inherited?.tiebreakers.source === "division" ? "" : ` — PATCH ${divDefault.status}, got ${JSON.stringify(inherited)}`),
      divDefault.status === 200 &&
        JSON.stringify(inherited?.tiebreakers.keys) === JSON.stringify(DIV_ORDER) &&
        inherited?.tiebreakers.source === "division" &&
        inherited.tiebreakers.pinnedAt === null &&
        inherited.tiebreakers.sportDefault.length > 0 &&
        JSON.stringify(inherited.tiebreakers.sportDefault) !== JSON.stringify(DIV_ORDER),
    );
    const generated = v1data<{ fixtures: { id: string }[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST"))?.fixtures ?? [];
    const after = await pinOf();
    w2dCheck(
      "w2d: generating the stage pins its table rules (pinned_at set, sources recorded)" +
        (after?.pinned_at != null ? "" : ` — got ${generated.length} fixture(s), ${JSON.stringify(after)}`),
      generated.length === 15 && after?.pinned_at != null && after.sources != null,
    );
    // After activation a division order edit lands and lists the pinned stage as kept; the stage still ranks by its pin.
    const moved = await v1(owner, `/api/v1/divisions/${divId}`, "PATCH", { tiebreakers: ["points", "for", "diff", "lots"] });
    const kept = (moved.json as { data?: { stagesKeptPinned?: { stageId: string; name: string }[] } } | null)?.data?.stagesKeptPinned;
    const pinned = await tableRules();
    w2dCheck(
      "w2d: a division edit after activation lists the stage as kept (stagesKeptPinned), and the stage keeps its pinned order" +
        (moved.status === 200 ? "" : ` — got ${moved.status} ${JSON.stringify(moved.json)}`),
      moved.status === 200 &&
        JSON.stringify(kept) === JSON.stringify([{ stageId, name: "Table" }]) &&
        JSON.stringify(pinned?.tiebreakers.keys) === JSON.stringify(DIV_ORDER) &&
        pinned?.tiebreakers.source === "division" &&
        pinned.tiebreakers.pinnedAt !== null,
    );
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");

    type Fx = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
    const fixtures = v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [];
    // One result between x and y, x scoring xs: oriented to the fixture's seating (generic's p1 is home).
    const result = async (x: string, y: string, xs: number, ys: number) => {
      const f = fixtures.find((fx) => [fx.home_entrant_id, fx.away_entrant_id].sort().join() === [x, y].sort().join());
      if (f === undefined) return 0;
      const state = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${f.id}/state`));
      const [p1Score, p2Score] = f.home_entrant_id === x ? [xs, ys] : [ys, xs];
      return (await v1(owner, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: state.last_seq,
        type: "generic.result",
        payload: { p1Score, p2Score },
      })).status;
    };
    type Row = { entrantId: string; points: number; tieBreak?: { key: string; drawnAt?: string } };
    const table = async () => v1data<{ rows?: Row[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/standings`))?.rows ?? [];
    const pts = (rows: readonly Row[], e: string) => rows.find((r) => r.entrantId === e)?.points;
    // The table is a snapshot the append refreshes; a bounded poll, its reads counted, never a fixed sleep.
    const settled = async (ready: (rows: readonly Row[]) => boolean) => {
      let rows = await table();
      for (let reads = 1; reads < 20 && !ready(rows); reads++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        rows = await table();
      }
      return rows;
    };
    const classOrder = (rows: readonly Row[], members: readonly string[]) => rows.map((r) => r.entrantId).filter((e) => members.includes(e));
    const draws = (members: readonly string[]) =>
      sql<{ id: string; drawn_order: string[]; drawn_at: Date; superseded_at: Date | null }[]>`
        select id, drawn_order, drawn_at, superseded_at from stage_lots_draws
        where stage_id = ${stageId} and members_key = ${[...members].sort().join(",")}`;
    const ab = [id.A, id.B];
    const cd = [id.C, id.D];
    // W2d T17 (PS-9e): the public standings, anonymous. The public read is cached (its data window), so a bounded
    // poll, its reads counted.
    type PubRow = { entrantId: string; level?: boolean; tieBreak?: { key: string; drawnAt?: string } };
    const orgSlug = ((await call(owner, "/api/orgs")) as { slug: string }[])[0]?.slug ?? "";
    const divSlug = v1data<{ slug: string } | undefined>(await v1(owner, `/api/v1/divisions/${divId}`))?.slug ?? "";
    const publicRows = async () => {
      const r = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/divisions/${divSlug}/standings`);
      const data = (r.json as { data?: { standings?: { stage_id: string; rows: PubRow[] }[] } } | null)?.data;
      return { status: r.status, rows: data?.standings?.find((st) => st.stage_id === stageId)?.rows ?? [] };
    };
    const publicSettled = async (ready: (rows: readonly PubRow[]) => boolean) => {
      let read = await publicRows();
      let reads = 1;
      for (; reads < 45 && !ready(read.rows); reads++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        read = await publicRows();
      }
      return { ...read, reads };
    };
    const allLevel = (rows: readonly PubRow[]) => rows.length === 6 && rows.every((r) => r.level === true);
    // W2d concern 2 (spec §5.7): the generate wrote the stage's LEVEL table, so the visitor reads it with no organiser read
    // first — the public read BEFORE the organiser's (which would otherwise write it lazily, usecases/stages.ts
    // `getStandings`); then the organiser's, the same. Both level, nothing counted yet.
    const levelRead = await publicSettled(allLevel);
    const organiserLevel = allLevel(await table());

    const firstResults = [await result(id.A, id.C, 1, 0), await result(id.B, id.D, 1, 0)];
    const read1 = await settled((rows) => pts(rows, id.A) === 3 && pts(rows, id.B) === 3 && pts(rows, id.C) === 0 && pts(rows, id.D) === 0);
    const [abDraws1, cdDraws1] = [await draws(ab), await draws(cd)];
    const drawnAsStored = (rows: readonly Row[], members: readonly string[], stored: readonly { drawn_order: string[]; superseded_at: Date | null }[]) =>
      stored.length === 1 &&
      stored[0].superseded_at === null &&
      JSON.stringify(classOrder(rows, members)) === JSON.stringify(stored[0].drawn_order) &&
      members.every((e) => rows.find((r) => r.entrantId === e)?.tieBreak?.key === "lots");
    w2dCheck(
      "w2d: a residual tie only lots can split is drawn and stored — A and B (3 points each, never met) rank as the stored draw" +
        (drawnAsStored(read1, ab, abDraws1) ? "" : ` — start ${started.status}, results ${JSON.stringify(firstResults)}, rows ${JSON.stringify(read1.map((r) => [names[entrants.findIndex((e) => e.id === r.entrantId)], r.points, r.tieBreak?.key]))}, draws ${JSON.stringify(abDraws1)}`),
      started.status < 300 && firstResults.every((s) => s === 201) && drawnAsStored(read1, ab, abDraws1),
    );
    w2dCheck(
      "w2d: the losers' tie (C and D, 0 points, −1 each) is drawn and stored the same way" +
        (drawnAsStored(read1, cd, cdDraws1) ? "" : ` — draws ${JSON.stringify(cdDraws1)}`),
      drawnAsStored(read1, cd, cdDraws1),
    );
    // The lots rows' drawnAt is the stored draw's instant, for both classes; nobody is level once a result counts.
    const drawnAtOk = (rows: readonly PubRow[], members: readonly string[], stored: readonly { drawn_at: Date }[]) =>
      stored.length === 1 &&
      members.every((e) => {
        const at = rows.find((r) => r.entrantId === e)?.tieBreak?.drawnAt;
        return at !== undefined && new Date(at).getTime() === stored[0].drawn_at.getTime();
      });
    const drawnRead = await publicSettled((rows) => drawnAtOk(rows, ab, abDraws1) && drawnAtOk(rows, cd, cdDraws1));
    const levelOk = organiserLevel && allLevel(levelRead.rows);
    const drawnOk = drawnAtOk(drawnRead.rows, ab, abDraws1) && drawnAtOk(drawnRead.rows, cd, cdDraws1) && drawnRead.rows.every((r) => r.level !== true);
    w2dCheck(
      `w2d: public standings carry drawnAt and level — every row level before a result, with no organiser read first (read ${levelRead.reads}×), the lots rows' drawnAt the stored draws' after (read ${drawnRead.reads}×)` +
        (levelOk && drawnOk ? "" : ` — level ${levelRead.status} ${JSON.stringify(levelRead.rows)}; drawn ${drawnRead.status} ${JSON.stringify(drawnRead.rows)}`),
      levelRead.status === 200 && levelOk && drawnRead.status === 200 && drawnOk,
    );

    // Reload across a recompute: E–F drawn moves the table and leaves both classes as they were.
    const efResult = await result(id.E, id.F, 0, 0);
    const read2 = await settled((rows) => pts(rows, id.E) === 1 && pts(rows, id.F) === 1);
    const [abDraws2, cdDraws2] = [await draws(ab), await draws(cd)];
    const sameAs1 = (members: readonly string[], d1: readonly { id: string }[], d2: readonly { id: string }[]) =>
      JSON.stringify(classOrder(read2, members)) === JSON.stringify(classOrder(read1, members)) &&
      d1.length === 1 && d2.length === 1 && d1[0].id === d2[0].id;
    w2dCheck(
      "w2d: two reloads across a recompute give the same lots order — each class drawn once, its stored draw reused" +
        (sameAs1(ab, abDraws1, abDraws2) && sameAs1(cd, cdDraws1, cdDraws2) ? "" : ` — E–F ${efResult}, draws ${JSON.stringify([abDraws2, cdDraws2])}`),
      efResult === 201 && pts(read2, id.E) === 1 && sameAs1(ab, abDraws1, abDraws2) && sameAs1(cd, cdDraws1, cdDraws2),
    );
    const read3 = await table();
    w2dCheck(
      "w2d: a plain reload serves the same table order",
      read3.length > 0 && JSON.stringify(read3.map((r) => r.entrantId)) === JSON.stringify(read2.map((r) => r.entrantId)),
    );
    await w2dStageRulesToPublicChecks(owner, who.org_id, comp, w2dCheck);
    await w2dHockeyGoalTypeChecks(owner, comp);
  } finally {
    await sql.end();
  }
  check(`w2d: the tables suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}

/**
 * W2d Task 18 (HK-TB-2, B3; PS-7d) — over real HTTP: FIH ranks on field goals, so the write path refuses a hockey goal
 * that does not say what kind it is, BY NAME (422 GOAL_KIND_REQUIRED, not CONFIG_INVALID), and writes nothing; the same
 * goal with its type is taken. A third division (hockey, fih-outdoor, two rosterless teams) in the suite's competition.
 * Counted on its own (the tables suite's EXPECTED_CHECKS stays its own), and a run that checked nothing fails.
 */
async function w2dHockeyGoalTypeChecks(owner: Session, comp: { id: string }): Promise<void> {
  const EXPECTED = 2;
  let ran = 0;
  const hkCheck = (label: string, cond: boolean) => {
    ran++;
    check(label, cond);
  };
  const div = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "W2d Hockey", sport_key: "hockey", variant_key: "fih-outdoor" }),
  );
  const entrants = v1data<{ id: string }[] | undefined>(
    await v1(owner, `/api/v1/divisions/${div?.id}/entrants`, "POST",
      ["H", "A"].map((n, i) => ({ kind: "team", display_name: `${n} ${tag} hockey`, seed: i + 1 }))),
  ) ?? [];
  const stageId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", { seq: 1, kind: "league", name: "Hockey Table" }),
  )?.id ?? "";
  const fx = (v1data<{ fixtures: { id: string }[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST"))?.fixtures ?? [])[0]?.id ?? "";
  const divStart = await v1(owner, `/api/v1/divisions/${div?.id}/start`, "POST");
  const seqOf = async () => v1data<{ last_seq: number } | undefined>(await v1(owner, `/api/v1/fixtures/${fx}/state`))?.last_seq;
  const send = async (type: string, payload: unknown) =>
    v1(owner, `/api/v1/fixtures/${fx}/events`, "POST", { expected_seq: await seqOf(), type, payload });
  const started = await send("core.start", {});
  const home = entrants[0]?.id ?? "";
  const before = await seqOf();
  const untyped = await send("hockey.goal", { by: home });
  const after = await seqOf();
  const code = (untyped.json as { error?: { code?: string } } | null)?.error?.code;
  hkCheck(
    "w2d T18: an untyped hockey goal is refused by name — 422 GOAL_KIND_REQUIRED, and nothing is written" +
      (untyped.status === 422 && code === "GOAL_KIND_REQUIRED" ? "" : ` — got ${untyped.status} ${JSON.stringify(untyped.json)}`),
    entrants.length === 2 && divStart.status < 300 && started.status === 201 &&
      untyped.status === 422 && code === "GOAL_KIND_REQUIRED" && typeof before === "number" && after === before,
  );
  const typed = await send("hockey.goal", { by: home, kind: "pc" });
  hkCheck(
    "w2d T18: the same goal with its type (a penalty corner) is accepted" + (typed.status === 201 ? "" : ` — got ${typed.status} ${JSON.stringify(typed.json)}`),
    typed.status === 201 && (await seqOf()) === (before ?? -1) + 1,
  );
  check(`w2d T18: the hockey goal-type checks ran ${EXPECTED} (ran ${ran})`, ran === EXPECTED);
}

/**
 * W2d Task 14 (spec §13 Smoke) — a stage's OWN order and points, set through the API, reach the PUBLIC standings. A
 * second generic division in the suite's public competition, three entrants under the division's 3/1/0; its league stage
 * takes its own order `points, for, diff, lots` and its own points (a win 2, a draw 1, a loss 0) through
 * `PUT /stages/{id}/rules`; generate pins them; A beats B 3-2 through `POST /fixtures/{id}/events`; the anonymous public
 * standings route then serves A first on 2 points (the division's own table would pay 3), and B above C, the two level
 * on 0: B scored 2 goals to C's none, while generic's own order (difference before goals for) would put C (0) above B
 * (−1). `GET /stages/{id}` says where the order and points came from (`source`) and when they were pinned (`pinnedAt`)
 * — the public route carries neither. Three checks, counted by the suite's own counter.
 */
async function w2dStageRulesToPublicChecks(
  owner: Session,
  orgId: string,
  comp: { id: string; slug: string; visibility: string },
  w2dCheck: (label: string, cond: boolean) => void,
): Promise<void> {
  const OWN = ["points", "for", "diff", "lots"];
  const RULE = { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] };
  // The counterfactuals the checks must differ from: the division's own win (3) and the sport's order.
  const DIVISION_WIN = 3;
  const div = v1data<{ id: string; slug: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "W2d Stage Rules",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: DIVISION_WIN, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const names = ["A", "B", "C"] as const;
  const entrants = v1data<{ id: string }[] | undefined>(
    await v1(owner, `/api/v1/divisions/${div?.id}/entrants`, "POST",
      names.map((n, i) => ({ kind: "individual", display_name: `${n} ${tag} rules`, seed: i + 1 }))),
  ) ?? [];
  const [A, B, C] = names.map((_, i) => entrants[i]?.id ?? `missing ${names[i]}`);
  const stageId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", { seq: 1, kind: "league", name: "Rules Table" }),
  )?.id ?? "";
  type Rules = {
    tiebreakers: { keys: string[]; source: string; pinnedAt: string | null; sportDefault: string[] };
    points: { rule: { win?: { regulation?: number } }; source: string; pinnedAt: string | null };
  };
  const tableRules = async () => v1data<{ tableRules: Rules | null } | undefined>(await v1(owner, `/api/v1/stages/${stageId}`))?.tableRules ?? null;

  const put = await v1(owner, `/api/v1/stages/${stageId}/rules`, "PUT", { tiebreakers: OWN, points: RULE });
  const saved = await tableRules();
  const savedOk =
    put.status === 200 &&
    JSON.stringify(saved?.tiebreakers.keys) === JSON.stringify(OWN) &&
    saved?.tiebreakers.source === "stage" &&
    saved.tiebreakers.pinnedAt === null &&
    JSON.stringify(saved.tiebreakers.sportDefault) !== JSON.stringify(OWN) &&
    saved.points.source === "stage" &&
    saved.points.rule.win?.regulation === RULE.win.regulation &&
    saved.points.pinnedAt === null;
  w2dCheck(
    "w2d §13: a stage's own order and points saved through PUT /stages/{id}/rules are served back as the stage's (source 'stage'), not yet pinned" +
      (savedOk ? "" : ` — PUT ${put.status} ${JSON.stringify(put.json.error ?? null)}, got ${JSON.stringify(saved)}`),
    entrants.length === 3 && savedOk,
  );

  const generated = v1data<{ fixtures: { id: string }[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST"))?.fixtures ?? [];
  const pinned = await tableRules();
  const pinnedOk =
    generated.length === 3 &&
    JSON.stringify(pinned?.tiebreakers.keys) === JSON.stringify(OWN) &&
    pinned?.tiebreakers.source === "stage" &&
    pinned.points.source === "stage" &&
    typeof pinned.tiebreakers.pinnedAt === "string" &&
    pinned.points.pinnedAt === pinned.tiebreakers.pinnedAt;
  w2dCheck(
    "w2d §13: generating pins them — GET /stages/{id} names both sources 'stage' and one pinnedAt for the order and the points" +
      (pinnedOk ? "" : ` — ${generated.length} fixture(s), got ${JSON.stringify(pinned)}`),
    pinnedOk,
  );

  const started = await v1(owner, `/api/v1/divisions/${div?.id}/start`, "POST");
  type Fx = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
  const fixtures = v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${div?.id}/fixtures`)) ?? [];
  const ab = fixtures.find((f) => [f.home_entrant_id, f.away_entrant_id].sort().join() === [A, B].sort().join());
  let scored = 0;
  if (ab !== undefined) {
    const state = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${ab.id}/state`));
    // A 3-2 B, oriented to the fixture's seating (generic's p1 is home).
    const [p1Score, p2Score] = ab.home_entrant_id === A ? [3, 2] : [2, 3];
    scored = (await v1(owner, `/api/v1/fixtures/${ab.id}/events`, "POST", {
      expected_seq: state.last_seq,
      type: "generic.result",
      payload: { p1Score, p2Score },
    })).status;
  }

  // The public read, anonymous: the table the append refreshed, in the order the route serves it. A bounded poll, its reads
  // counted, never a fixed sleep.
  const anon = newSession();
  const orgSlug = ((await call(owner, "/api/orgs")) as { id: string; slug: string }[]).find((o) => o.id === orgId)?.slug ?? "";
  type PubRow = { entrantId: string; points: number; tieBreak?: { key: string } };
  const publicRows = async () =>
    v1data<{ standings?: { stage_id: string; rows: PubRow[] }[] } | undefined>(
      await v1(anon, `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/divisions/${div?.slug}/standings`),
    )?.standings?.find((t) => t.stage_id === stageId)?.rows ?? [];
  let rows = await publicRows();
  for (let reads = 1; reads < 20 && rows.find((r) => r.entrantId === A)?.points === undefined; reads++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    rows = await publicRows();
  }
  const order = rows.map((r) => names[[A, B, C].indexOf(r.entrantId)] ?? r.entrantId);
  const a = rows.find((r) => r.entrantId === A);
  const b = rows.find((r) => r.entrantId === B);
  const publicOk =
    comp.visibility === "public" &&
    started.status < 300 &&
    scored === 201 &&
    order.join() === "A,B,C" &&
    a?.points === RULE.win.regulation &&
    a.points !== DIVISION_WIN &&
    b?.points === 0 &&
    b.tieBreak?.key === "for";
  w2dCheck(
    "w2d §13: one fixture scored through POST /fixtures/{id}/events reaches the PUBLIC standings ranked and paid by the stage's own rules — A first on 2 (not the division's 3), B above C on goals for" +
      (publicOk ? "" : ` — visibility ${comp.visibility}, start ${started.status}, event ${scored}, order ${order.join()}, rows ${JSON.stringify(rows)}`),
    publicOk,
  );
}
