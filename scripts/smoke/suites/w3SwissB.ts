import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { BASE, appendScoreEvent, call, check, newSession, signIn, smokeDb, tag, v1, v1data } from "../harness.ts";
import { SWISS_REFUSALS } from "../../../apps/web/src/lib/swiss-refusals.ts";

/**
 * Format matrix W3 Swiss app-B (plan 2026-10-31-w3-swiss-app-b.md) — the app PR's smoke proof, over real HTTP against a live
 * server. One counted check per task that owes one, each beside the state it proves.
 *
 * T1 (X-SW-3; rulebook-W3-swiss.md §3.1, P-A1/P-A6; engine 2.0.0 `pairRound`): a Swiss round with NO legal pairing is
 * refused by name, never answered "created 0, up to date". SIX players, five rounds declared, rounds 1-3 written onto the
 * minted shells by SQL as a round-robin quarter — R1 {p0-p1, p2-p3, p4-p5}, R2 {p0-p5, p1-p2, p3-p4}, R3 {p0-p3, p1-p4,
 * p2-p5}, each a home win — leave two unplayed triangles, so round 4 has no rematch-free perfect matching. `POST
 * /api/v1/stages/{id}/generate` answers SWISS_NO_LEGAL_PAIRING at the status the SWISS_REFUSALS row rules (read off the
 * table, never a typed literal), names the round, the reason and the field, and every round-4 seat stays empty.
 *
 * T2 (X-SW-6; boardgame FOLD_EPOCH 4 -> 5): a board game division that still stores the 1.x `byeScore` has it removed by the
 * V490 delta, and `GET /api/v1/divisions/{id}` reads the stored config back without it. The division is created through the API,
 * given the pre-deploy shape by SQL (`byeScore: 2` beside the rest, read back first to prove the GET returns the stored row and
 * not a parse that would strip it), and the delta's own DO block is run on it (found by glob, never by number) as the app's
 * tenant role for this organization, so RLS limits it to the rows this run made.
 *
 * T8 (X-SW-8; FIDE C.07 (2026) art. 16.2.3): the rounds an entrant was in the stage but unpaired reach the public table. A board
 * game Swiss of three (R = 3), a fourth player added after round 1 (case (c): joins round 2), every board played through the
 * scorer's own events, and the Buchholz cells the anonymous hub document prints equal the hand derivation in the check: the
 * latecomer's missed round 1 is a virtual-opponent round, not a round that never happened. The other input of the same task
 * (X-SW-7, the side(s) of a result lost without playing) has no smoke check: it is proved against the real forfeit and withdrawal
 * writers in `swiss-art16-producer.test.ts`.
 *
 * T3 (opp_diff labels, owner Q2): a football Swiss division's anonymous hub table carries the `opp_diff` column, with its short
 * header "Opp diff" and its sport-neutral long form "Opponents' score difference" (the org's locale is English; the words are the
 * owner's, typed here, not read back from the dictionary under test) - football's own Swiss chain (FB-TB-5) holds the key, so the
 * column is there with no tie-break configuration at all.
 *
 * T9 (ST-G21; rulebook-W3 §8 T9): the TV board shows the Swiss tie-break columns. The same football Swiss shape as T3 (round 1
 * paired, nothing played), read from the anonymous division board `/shared/{org}/{comp}/{div}/present` - the page that builds the
 * slides from the public read models and hands them to the client as RSC props (there is no HTTP slides document; this payload is
 * the wire a venue screen reads). The standings slide carries `tiebreakColumns` with exactly two keys, in the stage's cascade
 * order: football's Swiss chain (FB-TB-5) is points, diff, for, wins, buchholz, opp_diff, direct, lots, so the two are buchholz
 * then opp_diff. Their header words are not asserted here (T3 owns the words); the pairing of header to key is.
 * T4 (SW-H1 on the desk; X-SW-3, X-SW-26): the refusal of check 1 carries the recovery the desk offers inside its notice - exactly
 * `round`, `reason`, `field`, `finishAfter` (3: the round before the refused one, typed from the arithmetic) and `canFinish` (true:
 * three rounds are decided) beside `code` and `message`, nothing else - and the Finish that notice's button posts goes through
 * from that same refused state: `POST /api/v1/stages/{id}/swiss/finish` ends the Swiss after round 3 and the two shell rounds go.
 * It reuses check 1's stage (the Community plan caps active competitions at 3, and checks 1-3 already hold three).
 *
 * T5 (X-SW-19; SW-M11): the pairing score groups are the stage's own table points. An ice hockey Swiss (IIHF pays 3 / 2 / 1 / 0:
 * a regulation win 3, an overtime win 2) is paired, round 1 is played through the scorer's own events with one overtime win and two
 * regulation wins, and round 2 is paired: the two regulation winners (3 points each, a group of their own) are seated against
 * each other and the overtime winner (2 points) is not seated against either. The old +1 per win put all three winners in one
 * group, whose top two by seed are paired - and the overtime winner is seed 1, so it would have met a regulation winner.
 *
 * T7 (X-SW-10; rulebook-W3-swiss.md §3.3 "Prevention"): the one-round look-ahead reaches the wire. A chess Swiss of eight and six
 * rounds (above the safe maximum 4, so every non-final Pair, round 5 included, asks the engine to look ahead) whose first four rounds were found by brute force
 * (seed 8078287; the same history `swiss-look-ahead.test.ts` proves with its oracle: round 5 has legal pairings and every one of
 * them leaves round 6 with none, under the colour limits). The history is written onto the minted shells by SQL and every board
 * is then PLAYED through the scorer's own events, so the table points the pairing reads are real. Pair next seats round 5 and
 * the answer carries `swiss_next_round: "unpairable"` with `swiss_paired_round: 5`; the warning tells the truth: with round 5
 * decided, the next Pair is refused SWISS_NO_LEGAL_PAIRING for round 6. The empty case is its own check (9), read off the SAME
 * stage: round 1 is Paired for real first (it asks the engine to look ahead, and gets "pairable" back) and the answer carries
 * neither `swiss_next_round` nor `swiss_paired_round`; the brute-force history is then written over that round by SQL.
 *
 * T9b (X-SW-31; engine 2.0.0 `roundBarrier`): the auto-schedule proposal of a Swiss stage puts round 2 after round 1's last
 * board ENDS, not merely after it starts. Four players, four courts, two rounds, round 1 paired and round 2 still TBD v TBD, one
 * 30-minute board a slot: round 1's two boards fit the first slot on two courts and round 2's two shells, with no entrant for a
 * rest rule to hold back, would fit the same slot on the other two under the old start floor. So the proposal's earliest round-2
 * start is at least round 1's latest start plus one match (09:30), and the apply the organiser clicks next accepts it.
 * T10 (SW-L10; ruling 250): the API skeleton of the e2e's whole flow (`apps/web/e2e/w3-swiss-app-b.spec.ts`). A badminton
 * swiss_knockout (Top 4, three rounds) of seven seeded players: round 1 is paired with a bye; a late player added before any
 * board starts re-pairs round 1 (case (a)); one added once a round-2 board has started joins from round 3 (case (c)); one added
 * once a round-3 board has started takes round 3's bye (case (b)). Every board is played through the scorer's own events, the
 * Swiss completes, and the knockout's seed proposal is the final table's top four (three rounds leave the scores 1-3-4-2, so 4th
 * and 5th are never level on points and the four are fixed; a tie INSIDE them, flagged for the organiser, is picked in the order
 * the proposal lists it, as the desk's pick would send it) - and its confirm seats the four in round 1. On check 1's private
 * competition (the Community plan caps active competitions at 3 and a competition at 4 divisions: check 1's holds one).
 * Every check is counted, and a run that checked nothing fails. SMOKE_ONLY=w3SwissB runs it alone (SELECTABLE_SUITES).
 */
export async function w3SwissBSuite(): Promise<void> {
  // T1: 1 (Pair next on a history with no legal round is refused SWISS_NO_LEGAL_PAIRING and seats nobody).
  // T2: 1 (a boardgame division's stored byeScore is gone from the config GET answers, once the V490 delta has run).
  // T8: 1 (X-SW-8: a late entrant's missed round is a virtual-opponent round in the Buchholz the anonymous hub prints).
  // T3: 1 (a football Swiss's hub table carries an Opp diff column with its words, over the wire a visitor reads).
  // T9: 1 (ST-G21: the same stage's anonymous /present board payload carries two tie-break columns, buchholz then opp_diff).
  // T4: 1 (the refusal carries finishAfter 3 and canFinish, and the Finish its notice offers ends the Swiss after round 3).
  // T5: 1 (X-SW-19: an ice hockey Swiss's round 2 is paired in the table's own score groups - regulation winners together, the overtime winner outside).
  // T7: 2 (X-SW-10: a round whose every legal pairing kills the next is seated, and the Pair's answer says unpairable for round 5; Pair next is then refused for round 6.
  //        X-SW-10 empty case: a pairable round of the same shape is seated and the answer carries no next-round field).
  // T9b: 1 (X-SW-31: the auto-schedule proposal of a Swiss round 2 starts after round 1's last board ends).
  // T10: 1 (SW-L10: seven seeded and three late players - cases (a), (c), (b) - played out, completed, and the knockout seeded with its top four).
  const EXPECTED_CHECKS = 11;
  let checked = 0;
  const w3Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w3b_${tag}@resend.dev`);

  type Fx = {
    id: string;
    stage_id: string;
    round_no: number;
    seq_in_round: number;
    ext_key?: string | null;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  };

  /** Check 1's refused stage, kept for check 6 (the recovery runs from the state check 1 left). */
  let refused: { divId?: string; stageId?: string; status: number; error: Record<string, unknown> | undefined } | undefined;
  /** Check 1's private competition, kept for check 11 (it holds one division of the four a competition may have). */
  let firstComp: { id: string } | undefined;

  // Check 1 — T1 (X-SW-3). Rounds 1-3 of the S6 shape (the expected shape is typed here from the rulebook's arithmetic: nine
  // distinct pairs met leave two triangles, and a triangle has an odd number of vertices).
  {
    const HISTORY: readonly (readonly (readonly [number, number])[])[] = [
      [[0, 1], [2, 3], [4, 5]],
      [[0, 5], [1, 2], [3, 4]],
      [[0, 3], [1, 4], [2, 5]],
    ];
    const comp = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss B ${tag}`, visibility: "private" }),
    );
    firstComp = comp;
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Open", sport_key: "badminton", variant_key: "bwf", config: {} }),
    )?.id;
    const entrants =
      v1data<{ id: string; seed: number | null }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: `B${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    // p0..p5 are seeds 1..6, whatever order the POST answered them in.
    const ids = [...entrants].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((e) => e.id);
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 5 } }),
    )?.id;
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    // The history is SQL-seeded: no route writes a decided board onto a shell without scoring it. -1: no DATABASE_URL, so
    // the seed could not be written and the check cannot be judged (it fails, never skips).
    let seeded = -1;
    if (process.env.DATABASE_URL && stageId !== undefined && ids.length === 6) {
      const db = smokeDb();
      try {
        seeded = 0;
        for (const [i, round] of HISTORY.entries()) {
          for (const [b, [home, away]] of round.entries()) {
            const outcome = { kind: "win", winner: ids[home], loser: ids[away] };
            seeded += (
              await db`update fixtures set home_entrant_id = ${ids[home]}, away_entrant_id = ${ids[away]}, status = 'decided',
                         outcome = ${db.json(outcome)}
                       where stage_id = ${stageId} and ext_key = ${`sw-r${i + 1}-b${b + 1}`}`
            ).count;
          }
        }
      } finally {
        await db.end();
      }
    }
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const before = await fixtures();
    const res = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const after = await fixtures();
    const round4 = after.filter((f) => f.round_no === 4);
    // The refusal's details ride beside `code` on the v1 envelope (api-v1/http.ts merges HttpError `extra`). Finish is
    // available after three decided rounds, so the table's RESOLVABLE status (409) is the one that must come back.
    const err: { code?: string; round?: number; reason?: string; field?: number } | undefined = res.json.error;
    refused = { divId, stageId, status: res.status, error: res.json.error };
    const row = SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING;
    const ok =
      started.status < 300 && seeded === 9 && before.length === 15 &&
      res.status === row.resolvableStatus && err?.code === "SWISS_NO_LEGAL_PAIRING" &&
      err.round === 4 && err.reason === "rematch" && err.field === 6 &&
      round4.length === 3 && round4.every((f) => f.home_entrant_id === null && f.away_entrant_id === null) &&
      JSON.stringify(after) === JSON.stringify(before);
    w3Check(
      "w3b X-SW-3: Pair next on a Swiss whose round 4 has no legal pairing is refused 409 SWISS_NO_LEGAL_PAIRING (round 4, rematch, field 6), every round-4 seat stays empty and nothing else moves" +
        (ok ? "" : ` — division ${divId ?? "none"}, stage ${stageId ?? "none"}, players ${ids.length}, start ${started.status}, seeded ${seeded === -1 ? "no DATABASE_URL" : seeded}, rows before ${before.length}, generate ${res.status} (want ${row.resolvableStatus}) ${JSON.stringify(res.json).slice(0, 200)}, round 4 rows ${round4.length}, unchanged ${JSON.stringify(after) === JSON.stringify(before)}`),
      ok,
    );
  }

  // Check 2's private competition, kept for checks 7 and 10. The Community plan caps active competitions at 3 (checks 1-3 open
  // one each) and a competition at 4 divisions, and the public one holds four - checks 3, 4, 5 and 8, whose readers are public.
  let byeComp: { id: string } | undefined;

  // Check 2 — T2 (X-SW-6). The delta is found by glob, never by number (it is renumbered at merge).
  {
    // The repo root is read through a file that always exists: smoke-paths.test.ts resolves a literal `new URL(…, import.meta.url)`
    // to a FILE (only a template's static head may name a directory), so the deltas directory is joined onto it, not named.
    const deltas = `${dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)))}/db/migration/deltas/`;
    const found = readdirSync(deltas).filter((f) => /^V\d+__w3_bye_score_cleanup\.sql$/.test(f));
    const block =
      found.length === 1 ? /do \$\$[\s\S]*?end \$\$;/.exec(readFileSync(`${deltas}${found[0]}`, "utf8").replace(/--.*$/gm, ""))?.[0] : undefined;
    const canon = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
    const comp = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss B bye ${tag}`, visibility: "private" }),
    );
    byeComp = comp;
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Chess", sport_key: "boardgame", variant_key: "classical", config: {} }),
    )?.id;
    const config = async () =>
      v1data<{ config: Record<string, unknown> } | undefined>(await v1(owner, `/api/v1/divisions/${divId}`))?.config;
    let legacy: Record<string, unknown> | undefined;
    let migrated: Record<string, unknown> | undefined;
    let ran = "not run";
    if (process.env.DATABASE_URL && divId !== undefined && block !== undefined) {
      const db = smokeDb();
      try {
        // The pre-deploy shape: a 1.x server stored the default beside the rest of the config.
        const [row] = await db<{ org_id: string }[]>`
          update divisions set config = config || '{"byeScore": 2}'::jsonb where id = ${divId} returning org_id`;
        legacy = await config();
        await db.begin(async (tx) => {
          await tx`select set_config('app.current_org', ${row.org_id}, true)`;
          await tx`set local role app_user`;
          await tx`set local client_min_messages = warning`; // the block's NOTICEs (counts) are for a migration log, not this one
          await tx.unsafe(block);
        });
        migrated = await config();
        ran = "ran";
      } finally {
        await db.end();
      }
    }
    const siblings = legacy === undefined ? [] : Object.keys(legacy).filter((k) => k !== "byeScore");
    const ok =
      legacy !== undefined && migrated !== undefined && legacy.byeScore === 2 && !("byeScore" in migrated) && siblings.length > 0 &&
      canon(migrated) === canon(Object.fromEntries(siblings.map((k) => [k, legacy[k]])));
    w3Check(
      "w3b X-SW-6: a boardgame division that stored byeScore reads back without it after the V490 delta, every other config key as it was" +
        (ok ? "" : ` — division ${divId ?? "none"}, delta files ${found.length}, block ${block === undefined ? "missing" : "found"}, ${process.env.DATABASE_URL ? ran : "no DATABASE_URL"}, before ${JSON.stringify(legacy)}, after ${JSON.stringify(migrated)}`),
      ok,
    );
  }

  // Check 3 - T8 (X-SW-8). The engine's S4 (late entry), over HTTP, read from the anonymous hub document. A = seed 1,
  // B = seed 2, C = seed 3, L = the latecomer (Add after round 1, case (c): it joins round 2). Boardgame pays 2/1/0 half-points,
  // so D (the draw) = 1 half, the rounds R = 3, and a virtual opponent's cap D x R = 3 half. Every expected number below is
  // derived by hand from FIDE C.07 (2026) 16.2-16.4 and typed here; none is read back from the code under test.
  //   R1: A beats B, C has the bye (L is absent).   R2: A beats C, L beats B.   R3: L beats A, B draws C.
  //   Scores (half-points): A 2+2+0 = 4, B 0+0+1 = 1, C 2+0+1 = 3, L 0+2+2 = 4.
  //   L's missed round 1 is 16.2.3 `absent`, scored 0 against its own virtual opponent min(4, 3) = 3 (16.4.2); L's opponents read
  //   it at its real 4 (16.3.1).  Buchholz (half-points): L = 3 + B 1 + A 4 = 8 -> 4; B = A 4 + L 4 + C 3 = 11 -> 5.5;
  //   A = B 1 + C 3 + L 4 = 8 -> 4; C = its bye min(3, 3) = 3 + A 4 + B 1 = 8 -> 4.  The public table prints half-points as
  //   "n½", so the cells are "4", "5½", "4", "4".
  //   Differential: with the absent round left off L's card (the pre-task state: no producer for the field) L = B 1 + A 4 = 5 ->
  //   "2½", and B = 11 -> "5½" stays - the check tells the readings apart on L.
  // The org is on the Community plan (competitions.max_active = 3) and checks 1-3 each open one, so check 4 reuses this public one.
  let publicComp: { id: string; slug?: string } | undefined;
  {
    const comp = v1data<{ id: string; slug?: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss B art16 ${tag}`, visibility: "public" }),
    );
    publicComp = comp;
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Chess", sport_key: "boardgame", variant_key: "classical", config: {} }),
    )?.id;
    const made =
      v1data<{ id: string; seed: number | null }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          ["A", "B", "C"].map((n, i) => ({ kind: "individual", display_name: `${n} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const [A = "", B = "", C = ""] = [...made].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((e) => e.id);
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } }),
    )?.id;
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const rows = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const isBye = (f: Fx) => /-bye$/.test(f.ext_key ?? "");
    /** The round-`r` board between `x` and `y`, whichever seat each holds. */
    const board = (all: Fx[], r: number, x: string, y: string) =>
      all.find((f) => f.round_no === r && !isBye(f) && [f.home_entrant_id, f.away_entrant_id].sort().join() === [x, y].sort().join());
    const shape = (all: Fx[], r: number) =>
      all.filter((f) => f.round_no === r && !isBye(f) && f.home_entrant_id !== null && f.away_entrant_id !== null).length;
    // Five boards are played (R1 one, R2 two, R3 two), each a start and a result: ten events, each a 2xx.
    const statuses: number[] = [];
    /** Plays `f` through the scorer's own events: a decisive result for `winner`, or an agreed draw for null. */
    const play = async (f: Fx | undefined, winner: string | null) => {
      if (f === undefined) {
        statuses.push(0);
        return;
      }
      statuses.push((await appendScoreEvent(owner, f.id, "core.start", {})).status);
      statuses.push(
        (await appendScoreEvent(owner, f.id, "boardgame.result", winner === null ? { winner: null, method: "agreement" } : { winner, method: "resign" })).status,
      );
    };
    const pair = async () => (await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST")).status;

    const pairs: number[] = [await pair()];
    let all = await rows();
    const r1bye = all.find((f) => f.round_no === 1 && isBye(f));
    const r1ok = shape(all, 1) === 1 && r1bye?.home_entrant_id === C && board(all, 1, A, B) !== undefined;
    await play(board(all, 1, A, B), A);
    type Added = { id: string; late_entry?: { case?: string; round?: number } };
    const addedRes = await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", [{ kind: "individual", display_name: `L ${tag}` }]);
    const late = v1data<Added[] | undefined>(addedRes)?.[0];
    const L = late?.id ?? "";
    pairs.push(await pair());
    all = await rows();
    const r2ok = shape(all, 2) === 2 && board(all, 2, L, B) !== undefined && board(all, 2, A, C) !== undefined;
    await play(board(all, 2, A, C), A);
    await play(board(all, 2, L, B), L);
    pairs.push(await pair());
    all = await rows();
    const r3ok = shape(all, 3) === 2 && board(all, 3, L, A) !== undefined && board(all, 3, B, C) !== undefined;
    await play(board(all, 3, L, A), L);
    await play(board(all, 3, B, C), null);

    // The anonymous hub document: the same table a visitor reads.
    const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
    const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
    const hubRes = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp?.slug}/hub`);
    type HubTable = { divisionId: string; columns: { key: string }[]; rows: { entrantId: string; cells: string[] }[] };
    const table = (v1data<{ tables?: HubTable[] } | undefined>(hubRes)?.tables ?? []).filter((t) => t.divisionId === divId)[0];
    const col = table?.columns.findIndex((c) => c.key === "buchholz") ?? -1;
    const cell = (id: string) => (col < 0 ? undefined : table?.rows.find((r) => r.entrantId === id)?.cells[col]);
    const got = { A: cell(A), B: cell(B), C: cell(C), L: cell(L) };
    const want = { A: "4", B: "5½", C: "4", L: "4" };
    const ok =
      started.status < 300 && made.length === 3 && L !== "" && addedRes.status < 300 && late?.late_entry?.case === "c" && late.late_entry.round === 2 &&
      pairs.every((st) => st === 200) && r1ok && r2ok && r3ok && statuses.length === 10 && statuses.every((st) => st > 0 && st < 300) &&
      orgSlug !== "" && hubRes.status === 200 && table !== undefined && table.rows.length === 4 && col >= 0 &&
      JSON.stringify(got) === JSON.stringify(want);
    w3Check(
      "w3b X-SW-8: a late entrant's missed round is a virtual-opponent round - the anonymous hub table prints Buchholz 4 / 5\u00bd / 4 / 4 for A / B / C / L (boardgame, R = 3), not the 2\u00bd the unplayed round left off would give L" +
        (ok ? "" : ` - division ${divId ?? "none"}, start ${started.status}, pair ${pairs.join("/")}, late ${addedRes.status} ${JSON.stringify(late?.late_entry ?? null)}, boards ok ${r1ok}/${r2ok}/${r3ok}, event statuses ${statuses.join(",")}, hub ${hubRes.status} table ${table === undefined ? "missing" : `${table.rows.length} rows, buchholz column ${col}`}, got ${JSON.stringify(got)} want ${JSON.stringify(want)}`),
      ok,
    );
  }

  // Check 4 - T3 (opp_diff labels). A football Swiss, round 1 paired and nothing played: the columns come from the stage's order, not from results.
  // Football's default Swiss chain is ["points", "diff", "for", "wins", "buchholz", "opp_diff", "direct", "lots"] (FB-TB-5), so
  // the hub table must carry an `opp_diff` column worded "Opp diff" / "Opponents' score difference" (owner Q2, amendment A:
  // sport-neutral - a football table does not say "goal"), and its Buchholz beside it.
  {
    const comp = publicComp;
    const divRes = await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Football", sport_key: "football", variant_key: "11-a-side", config: {} });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const made =
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          ["A", "B", "C", "D"].map((n, i) => ({ kind: "team", display_name: `${n} FC ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
    )?.id;
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    // Round 1 paired: the hub publishes a Swiss stage's table once the stage has boards (the columns still come from its order).
    const paired = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
    const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
    const hubRes = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp?.slug}/hub`);
    type HubCol = { key: string; abbr: string; title: string };
    const table = (v1data<{ tables?: { divisionId: string; columns: HubCol[] }[] } | undefined>(hubRes)?.tables ?? []).filter((t) => t.divisionId === divId)[0];
    const oppDiff = table?.columns.find((c) => c.key === "opp_diff");
    const ok =
      made.length === 4 && stageId !== undefined && started.status < 300 && paired.status === 200 && orgSlug !== "" && hubRes.status === 200 && table !== undefined &&
      oppDiff !== undefined && oppDiff.abbr === "Opp diff" && oppDiff.title === "Opponents' score difference" &&
      table.columns.some((c) => c.key === "buchholz");
    w3Check(
      "w3b T3: a football Swiss's anonymous hub table carries an Opp diff column (\"Opp diff\" over \"Opponents' score difference\") beside its Buchholz" +
        (ok ? "" : ` - competition ${comp?.id ?? "none"}, division ${divRes.status} ${divId ?? "none"}, entrants ${made.length}, start ${started.status}, pair ${paired.status}, hub ${hubRes.status}, table ${table === undefined ? "missing" : "found"}, opp_diff ${JSON.stringify(oppDiff ?? null)}, columns ${JSON.stringify(table?.columns.map((c) => c.key) ?? [])}`),
      ok,
    );
  }

  // Check 5 - T9 (ST-G21). A football Swiss, round 1 paired, read from the anonymous division board's RSC payload. The football
  // chain (FB-TB-5, typed here from the rulebook as in check 4) is points, diff, for, wins, buchholz, opp_diff, direct, lots, so
  // the board's two tie-break columns are buchholz then opp_diff - in the cascade's order, not alphabetical (b < o would hide a
  // reversed order, so the order is asserted on the payload text itself).
  {
    const comp = publicComp;
    const divRes = await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Football board", sport_key: "football", variant_key: "11-a-side", config: {} });
    const div = v1data<{ id: string; slug?: string } | undefined>(divRes);
    const made =
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${div?.id}/entrants`, "POST",
          ["A", "B", "C", "D"].map((n, i) => ({ kind: "team", display_name: `${n} Board ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
    )?.id;
    const started = await v1(owner, `/api/v1/divisions/${div?.id}/start`, "POST");
    const paired = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
    const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
    const boardRes = await fetch(`${BASE}/shared/${orgSlug}/${comp?.slug}/${div?.slug}/present`);
    const html = boardRes.status === 200 ? await boardRes.text() : "";
    // The flight payload quotes its JSON inside a JS string, so the quotes arrive as \" (anchored on them, not on a bare word).
    const block = /\\"tiebreakColumns\\":\[((?:\{[^\]}]*\},?)+)\]/.exec(html)?.[1] ?? "";
    const keys = [...block.matchAll(/\\"key\\":\\"([a-z0-9_]+)\\"/g)].map((m) => m[1]);
    const ok =
      made.length === 4 && stageId !== undefined && started.status < 300 && paired.status === 200 && orgSlug !== "" && div?.slug !== undefined &&
      boardRes.status === 200 && keys.length === 2 && keys[0] === "buchholz" && keys[1] === "opp_diff";
    w3Check(
      "w3b T9: a football Swiss's anonymous /present board carries two tie-break columns on its standings slide, buchholz then opp_diff" +
        (ok ? "" : ` - competition ${comp?.id ?? "none"}, division ${divRes.status} ${div?.id ?? "none"} slug ${div?.slug ?? "none"}, entrants ${made.length}, start ${started.status}, pair ${paired.status}, board ${boardRes.status} (${html.length} bytes), tiebreakColumns keys ${JSON.stringify(keys)}`),
      ok,
    );
  }

  // Check 6 - T4 (SW-H1 on the desk; X-SW-3, X-SW-26). Check 1 left a six-player Swiss refused at round 4 with rounds 1-3 decided.
  // The refusal's body carries the five recovery fields and nothing else beside `code` and `message`; `finishAfter` is 3 (the
  // round before the refused one) and `canFinish` is true (three decided rounds). The desk's "Finish after round 3" posts the
  // stage's finish route: it ends the Swiss after round 3 (200, complete) and the two shell rounds go - 6 rows (two rounds of
  // three boards), leaving the 9 played boards. Expected numbers are typed from that arithmetic, never read from the code.
  {
    const body = refused?.error;
    const extraKeys = Object.keys(body ?? {}).filter((k) => k !== "code" && k !== "message").sort();
    const stageId = refused?.stageId;
    const divId = refused?.divId;
    const finish = await v1(owner, `/api/v1/stages/${stageId}/swiss/finish`, "POST");
    const done = v1data<{ finished_after: number; completed: boolean; shells_removed: number } | undefined>(finish);
    const left = (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const ok =
      refused !== undefined && stageId !== undefined && divId !== undefined && body?.code === "SWISS_NO_LEGAL_PAIRING" &&
      JSON.stringify(extraKeys) === JSON.stringify(["canFinish", "field", "finishAfter", "reason", "round"]) &&
      body.finishAfter === 3 && body.canFinish === true && body.round === 4 &&
      finish.status === 200 && done?.finished_after === 3 && done.completed === true && done.shells_removed === 6 &&
      left.length === 9 && left.every((f) => f.round_no <= 3);
    w3Check(
      "w3b X-SW-3/X-SW-26: the refusal carries finishAfter 3 and canFinish true beside round, reason and field and nothing more, and the Finish its notice offers ends the Swiss after round 3 (200, complete, rounds 4 and 5 removed)" +
        (ok ? "" : ` - stage ${stageId ?? "none"}, refusal ${JSON.stringify(body ?? null)}, extra keys ${JSON.stringify(extraKeys)}, finish ${finish.status} ${JSON.stringify(finish.json).slice(0, 200)}, rows left ${left.length}, rounds ${JSON.stringify([...new Set(left.map((f) => f.round_no))].sort())}`),
      ok,
    );
  }

  // Check 7 - T5 (X-SW-19; SW-M11). An ice hockey Swiss of six teams (seeds 1-6), fifteen scorer events (five a board) on the private competition check 2 opened (the
  // Community plan caps active competitions at 3, and a competition at 4 divisions: the public one is full). IIHF pays 3 / 2 / 1 / 0 (regulation win 3, overtime win 2, overtime loss 1,
  // regulation loss 0), typed here from the rulebook, never read from the code under test. Round 1 is played through the scorer's
  // own events: the board seed 1 sits on is won by seed 1 IN OVERTIME (level after three periods, then a goal), the other two
  // boards by their better seed in regulation (a goal, then the three periods to full time). Round 2 is then paired:
  //   the two regulation winners hold 3 points, a group of their own that has not met -> they are seated against each other;
  //   the overtime winner holds 2, so it is NOT seated against either of them.
  // Differential: under the old +1 a win all three winners hold 1 point in ONE group of three, whose lowest-ranked (by seed)
  // floats down and whose top two are paired - seed 1, the overtime winner, would have met the better regulation winner.
  {
    const comp = byeComp;
    const divRes = await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Ice hockey", sport_key: "icehockey", variant_key: "iihf", config: {} });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const made =
      v1data<{ id: string; seed: number | null }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 6 }, (_, i) => ({ kind: "team", display_name: `HC ${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const seedOf = new Map(made.map((e) => [e.id, e.seed ?? 0]));
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
    )?.id;
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const rows = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const boardsOf = (all: Fx[], r: number) =>
      all.filter((f) => f.round_no === r && !/-bye$/.test(f.ext_key ?? "") && f.home_entrant_id !== null && f.away_entrant_id !== null);
    const statuses: number[] = [];
    const refusedEvents: string[] = [];
    // The shared helper, since its idempotency key became unique per call (T5 review m6): a board's second and third
    // `period.advance` are applied, not taken for replays of the first. Check 7 is itself the live witness - on the old
    // (fixture, type) key those two events answer a success that applied nothing, and the next one is refused.
    const ev = async (fixtureId: string, type: string, payload: unknown) => {
      const res = await appendScoreEvent(owner, fixtureId, type, payload);
      statuses.push(res.status);
      if (res.status >= 300) refusedEvents.push(`${type} ${JSON.stringify(payload)} -> ${JSON.stringify(res.json).slice(0, 160)}`);
    };
    const paired1 = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const round1 = boardsOf(await rows(), 1);
    const better = (f: Fx) => (seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)! ? f.home_entrant_id! : f.away_entrant_id!);
    const seed1Id = [...seedOf].find(([, seed]) => seed === 1)?.[0];
    const otBoard = round1.find((f) => f.home_entrant_id === seed1Id || f.away_entrant_id === seed1Id);
    const regBoards = round1.filter((f) => f !== otBoard);
    for (const f of regBoards) {
      await ev(f.id, "core.start", {});
      await ev(f.id, "icehockey.goal", { by: better(f) });
      for (const to of ["P2", "P3", "FT"]) await ev(f.id, "icehockey.period.advance", { to });
    }
    if (otBoard !== undefined) {
      await ev(otBoard.id, "core.start", {});
      for (const to of ["P2", "P3", "FT"]) await ev(otBoard.id, "icehockey.period.advance", { to });
      await ev(otBoard.id, "icehockey.goal", { by: better(otBoard) });
    }
    const regWinners = regBoards.map(better);
    const paired2 = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const round2 = boardsOf(await rows(), 2);
    const meet = (a: string, b: string) => round2.some((f) => [f.home_entrant_id, f.away_entrant_id].sort().join() === [a, b].sort().join());
    const otMeetsRegulation = regWinners.some((w) => meet(seed1Id ?? "", w));
    const ok =
      made.length === 6 && stageId !== undefined && started.status < 300 && paired1.status === 200 && round1.length === 3 &&
      otBoard !== undefined && regBoards.length === 2 && regWinners.every((w) => w !== seed1Id) &&
      statuses.length === 15 && statuses.every((st) => st > 0 && st < 300) &&
      paired2.status === 200 && round2.length === 3 && meet(regWinners[0], regWinners[1]) && !otMeetsRegulation;
    w3Check(
      "w3b X-SW-19: an ice hockey Swiss's round 2 is paired in the table's own score groups - the two regulation winners (IIHF 3 points) meet each other, the overtime winner (2 points) meets neither" +
        (ok ? "" : ` - division ${divRes.status} ${divId ?? "none"}, entrants ${made.length}, start ${started.status}, pair ${paired1.status}/${paired2.status}, round 1 boards ${round1.length}, event statuses ${statuses.join(",")} ${refusedEvents.slice(0, 2).join(" ; ")}, round 2 boards ${JSON.stringify(round2.map((f) => [seedOf.get(f.home_entrant_id!), seedOf.get(f.away_entrant_id!)]))} (seeds), regulation winners ${JSON.stringify(regWinners.map((w) => seedOf.get(w)))}, OT winner seed 1 meets a regulation winner ${otMeetsRegulation}`),
      ok,
    );
  }

  // Check 8 - T7 (X-SW-10). A chess Swiss of eight players (seeds 1-8) and six rounds on the public competition check 3 opened (the
  // Community plan caps active competitions at 3). Rounds 1-4 are the brute-force history UNPAIRABLE_NEXT_N8 (seed 8078287) as
  // [home index, away index, result] with p0..p7 = seeds 1..8 and `h` / `a` the home / away side winning, `d` a draw; typed here,
  // proved by an oracle in swiss-look-ahead.test.ts (every legal round 5 leaves a round 6 with no legal pairing under the
  // colour limits - never a rematch-only history: none of 6-8 players has a non-last round like that). Round 5 of 6 is above the
  // safe maximum floor(8 / 2) = 4 and is not the last round, so the app asks the engine to look ahead; its verdict rides on the
  // answer. The differential (a pairable round's answer carries no `swiss_next_round` at all) is check 9, next: round 1 of THIS
  // stage is Paired for real just after Start (its answer is kept in `firstPair`) and the history is then written over it by SQL -
  // rounds 1-4 are otherwise never Paired, so no pairable answer would be read here. (A fresh division is not an option: the
  // Community plan caps a competition at 4 divisions, and checks 3, 4, 5 and 8 hold them on this one.)
  let firstPair: { status: number; json: Record<string, unknown>; divId?: string; stageId?: string; rowsAfter: number } | undefined;
  {
    const HISTORY: readonly (readonly (readonly [number, number, "h" | "a" | "d"])[])[] = [
      [[6, 3, "a"], [4, 1, "h"], [0, 5, "a"], [7, 2, "d"]],
      [[5, 3, "a"], [7, 4, "a"], [2, 1, "h"], [0, 6, "a"]],
      [[3, 4, "a"], [5, 2, "d"], [6, 7, "a"], [1, 0, "d"]],
      [[4, 2, "a"], [7, 5, "h"], [1, 6, "a"], [3, 0, "h"]],
    ];
    const comp = publicComp;
    const divRes = await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Chess look-ahead", sport_key: "boardgame", variant_key: "classical", config: {} });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const made =
      v1data<{ id: string; seed: number | null }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `L${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    // p0..p7 are seeds 1..8, whatever order the POST answered them in.
    const ids = [...made].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((e) => e.id);
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 6, chess: true } }),
    )?.id;
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const rows = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const seated = (all: Fx[], r: number) => all.filter((f) => f.round_no === r && f.home_entrant_id !== null && f.away_entrant_id !== null);
    // Round 1 is Paired for real first (check 9 reads the answer: a pairable round, with the look-ahead asked, carries no field)...
    const realFirst = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    firstPair = { status: realFirst.status, json: realFirst.json, divId, stageId, rowsAfter: seated(await rows(), 1).length };
    // ...then the history is SQL-seeded over it onto the shells (no route seats a board by hand); -1: no DATABASE_URL, so the seed could not be
    // written and the check cannot be judged (it fails, never skips).
    let seeded = -1;
    if (process.env.DATABASE_URL && stageId !== undefined && ids.length === 8) {
      const db = smokeDb();
      try {
        seeded = 0;
        for (const [i, round] of HISTORY.entries()) {
          for (const [b, [home, away]] of round.entries()) {
            seeded += (
              await db`update fixtures set home_entrant_id = ${ids[home]}, away_entrant_id = ${ids[away]}, status = 'scheduled', outcome = null
                       where stage_id = ${stageId} and ext_key = ${`sw-r${i + 1}-b${b + 1}`}`
            ).count;
          }
        }
      } finally {
        await db.end();
      }
    }
    // ...then every board is PLAYED through the scorer's own events: sixteen boards, a start and a result each.
    const statuses: number[] = [];
    const play = async (f: Fx | undefined, winner: string | null) => {
      if (f === undefined) {
        statuses.push(0);
        return;
      }
      statuses.push((await appendScoreEvent(owner, f.id, "core.start", {})).status);
      statuses.push(
        (await appendScoreEvent(owner, f.id, "boardgame.result", winner === null ? { winner: null, method: "agreement" } : { winner, method: "resign" })).status,
      );
    };
    const before = await rows();
    for (const [i, round] of HISTORY.entries()) {
      const boards = seated(before, i + 1).sort((x, y) => x.seq_in_round - y.seq_in_round);
      for (const [b, [home, away, res]] of round.entries()) await play(boards[b], res === "d" ? null : res === "h" ? ids[home] : ids[away]);
    }
    const paired = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const answer = v1data<{ created?: number; swiss_next_round?: string; swiss_paired_round?: number } | undefined>(paired);
    const afterPair = await rows();
    const round5 = seated(afterPair, 5);
    // The warning tells the truth: with round 5 decided, the next Pair is refused for round 6.
    for (const f of round5) await play(f, f.home_entrant_id);
    const sixth = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const refusal: { code?: string; round?: number } | undefined = sixth.json.error;
    const ok =
      divId !== undefined && stageId !== undefined && made.length === 8 && started.status < 300 && seeded === 16 &&
      before.length === 24 && statuses.length === 40 && statuses.slice(0, 32).every((st) => st > 0 && st < 300) &&
      paired.status === 200 && answer?.created === 4 && answer.swiss_next_round === "unpairable" && answer.swiss_paired_round === 5 &&
      round5.length === 4 && statuses.slice(32).every((st) => st > 0 && st < 300) &&
      sixth.status === SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING.resolvableStatus && refusal?.code === "SWISS_NO_LEGAL_PAIRING" && refusal.round === 6;
    w3Check(
      "w3b X-SW-10: a chess Swiss of eight and six rounds seats round 5 and the Pair's answer says swiss_next_round unpairable (paired round 5) - and round 6 is then refused SWISS_NO_LEGAL_PAIRING, as the warning said" +
        (ok ? "" : ` - division ${divRes.status} ${divId ?? "none"}, stage ${stageId ?? "none"}, players ${made.length}, start ${started.status}, seeded ${seeded === -1 ? "no DATABASE_URL" : seeded}, rows ${before.length}, event statuses ${statuses.join(",")}, pair ${paired.status} ${JSON.stringify(paired.json).slice(0, 240)}, round 5 boards ${round5.length}, round 6 ${sixth.status} ${JSON.stringify(sixth.json).slice(0, 200)}`),
      ok,
    );
  }

  // Check 9 - T7 (X-SW-10), the empty case, read off check 8's stage. Round 1 of that chess Swiss (eight players, six rounds: above
  // the safe maximum 4, and not the last round, so the Pair asked the engine to look ahead) was Paired for real before the
  // brute-force history was written over it, and its next round is pairable. The engine's "pairable" verdict is not sent: the
  // answer has neither `swiss_next_round` nor `swiss_paired_round` (absent - not false and not null: a pairable answer must not
  // leak a field the desk would have to read) - while check 8's round 5, on the same stage, carries both.
  {
    const answer = firstPair === undefined ? undefined : (firstPair.json.data as Record<string, unknown> | undefined);
    const ok =
      firstPair !== undefined && firstPair.divId !== undefined && firstPair.stageId !== undefined &&
      firstPair.status === 200 && answer?.created === 4 && firstPair.rowsAfter === 4 &&
      !("swiss_next_round" in answer) && !("swiss_paired_round" in answer);
    w3Check(
      "w3b X-SW-10 (empty case): round 1 of that chess Swiss is seated with the look-ahead asked and its next round pairable - the Pair's answer carries no swiss_next_round and no swiss_paired_round" +
        (ok ? "" : ` - division ${firstPair?.divId ?? "none"}, stage ${firstPair?.stageId ?? "none"}, pair ${firstPair?.status ?? "none"} ${JSON.stringify(firstPair?.json ?? null).slice(0, 300)}, round 1 boards ${firstPair?.rowsAfter ?? "none"}`),
      ok,
    );
  }

  // Check 10 - T9b (X-SW-31). The proposal, over the real route the organiser's Auto-schedule button posts to, and the apply
  // behind its Apply button. Every number is typed from the rulebook arithmetic, none read back from the code under test:
  // the match is 30 minutes (the settings below), so a round that starts 09:00 ends 09:30, and the end barrier puts the next
  // round at 09:30 or later where the start floor alone would have allowed 09:00. Reuses check 2's private competition (the org
  // is on the Community plan: checks 1-3 each opened one, and the public one already holds its 4 divisions).
  {
    const MATCH = 30 * 60_000;
    const comp = byeComp;
    const divRes = await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Barrier", sport_key: "badminton", variant_key: "bwf", config: {} });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const made =
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Q${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
    )?.id;
    const venue = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/orgs/${who.org_id}/venues`, "POST", { name: `Barrier Hall ${tag}` }));
    const courts: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const court = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/orgs/${who.org_id}/venues/${venue?.id}/courts`, "POST", { name: `Court ${i}` }));
      if (court !== undefined) courts.push(court.id);
    }
    const settings = await v1(owner, `/api/v1/divisions/${divId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: { startAt: "2030-08-01T09:00:00.000Z", matchMinutes: 30, gapMinutes: 0, courts, perEntrantMinRest: 0, sessionWindows: [] },
    });
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const paired = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST"); // round 1
    const rows =
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const roundOf = new Map(rows.map((f) => [f.id, f.round_no]));
    const proposal = await v1(owner, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false, mode: "build" });
    const out = v1data<{ assignments: { fixture_id: string; scheduled_at: string; court_id: string }[]; conflicts: { code: string }[] } | undefined>(proposal);
    const startsOf = (round: number) =>
      (out?.assignments ?? []).filter((a) => roundOf.get(a.fixture_id) === round).map((a) => Date.parse(a.scheduled_at));
    const r1 = startsOf(1);
    const r2 = startsOf(2);
    const r1LastEnd = Math.max(...r1) + MATCH;
    const applied = await v1(owner, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
      assignments: (out?.assignments ?? []).map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
      source: "auto",
    });
    const ok =
      divRes.status < 300 && made.length === 4 && stageId !== undefined && courts.length === 4 && settings.status < 300 &&
      started.status < 300 && paired.status === 200 && rows.length === 4 && proposal.status === 200 &&
      r1.length === 2 && r2.length === 2 && Math.min(...r2) >= r1LastEnd &&
      (out?.conflicts ?? []).every((c) => c.code !== "warn.order") && applied.status < 300;
    w3Check(
      "w3b X-SW-31: the auto-schedule proposal of a Swiss round 2 starts at or after round 1's last board ENDS (four courts, 30-minute boards: not 09:00 beside round 1), and the apply accepts it" +
        (ok ? "" : ` - division ${divId ?? "none"}, courts ${courts.length}, settings ${settings.status}, start ${started.status}, pair ${paired.status}, rows ${rows.length}, auto ${proposal.status}, round 1 starts ${JSON.stringify(r1.map((t) => new Date(t).toISOString()))}, round 2 starts ${JSON.stringify(r2.map((t) => new Date(t).toISOString()))}, apply ${applied.status} ${JSON.stringify(applied.json).slice(0, 200)}`),
      ok,
    );
  }

  // Check 11 - T10 (SW-L10). The e2e flow's skeleton over HTTP, on check 1's competition. Seven seeded players (seeds 1-7) and
  // three rounds; every board is a home win (two 21-10 games through the scorer's own events). The expected cases and rounds are
  // ruling 250's arithmetic: (a) round 1 (nothing started), (c) round 3 (added while round 2 runs, no bye in an even round), (b)
  // round 3 (added while round 3 runs, nine players leave a bye). The knockout's four come from the completed Swiss's own table.
  {
    const comp = firstComp;
    const divRes = await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Swiss KO", sport_key: "badminton", variant_key: "bwf", config: {} });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const made =
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 7 }, (_, i) => ({ kind: "individual", display_name: `K${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const staged = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [
      { seq: 1, kind: "swiss", name: "Swiss", config: { pairing: "rank_adjacent", rounds: 3 }, progression: null },
      { seq: 2, kind: "knockout", name: "Knockout", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" } },
    ]);
    const stages = v1data<{ id: string; seq: number }[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`)) ?? [];
    const swissId = stages.find((s) => s.seq === 1)?.id;
    const koId = stages.find((s) => s.seq === 2)?.id;
    const dayOne = await v1(owner, `/api/v1/stages/${koId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const rows = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === swissId);
    const isBye = (f: Fx) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
    const boardsOf = async (r: number) => (await rows()).filter((f) => f.round_no === r && !isBye(f) && f.home_entrant_id !== null && f.away_entrant_id !== null);
    const byesOf = async (r: number) => (await rows()).filter((f) => f.round_no === r && isBye(f) && f.home_entrant_id !== null);
    const statuses: number[] = [];
    const play = async (f: Fx, alreadyStarted: boolean) => {
      if (!alreadyStarted) statuses.push((await appendScoreEvent(owner, f.id, "core.start", {})).status);
      for (let g = 0; g < 2; g++) statuses.push((await appendScoreEvent(owner, f.id, "badminton.game.summary", { home: 21, away: 10 })).status);
    };
    type Late = { case?: string; round?: number; bye_holder_id?: string };
    const addLate = async (i: number) =>
      v1data<{ id: string; late_entry?: Late }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST", [{ kind: "individual", display_name: `KL${i} ${tag}` }]),
      )?.[0]?.late_entry;
    const pairs: number[] = [];
    const pair = async () => pairs.push((await v1(owner, `/api/v1/stages/${swissId}/generate`, "POST")).status);

    await pair();
    const round1Byes = (await byesOf(1)).length;
    const lateA = await addLate(1);
    const round1Boards = await boardsOf(1);
    for (const f of round1Boards) await play(f, false);
    await pair();
    const round2 = await boardsOf(2);
    if (round2[0]) statuses.push((await appendScoreEvent(owner, round2[0].id, "core.start", {})).status);
    const lateC = await addLate(2);
    for (const [i, f] of round2.entries()) await play(f, i === 0);
    await pair();
    const round3Before = await boardsOf(3);
    const holder = (await byesOf(3))[0]?.home_entrant_id ?? null;
    if (round3Before[0]) statuses.push((await appendScoreEvent(owner, round3Before[0].id, "core.start", {})).status);
    const lateB = await addLate(3);
    const round3 = await boardsOf(3);
    for (const f of round3) await play(f, f.id === round3Before[0]?.id);
    const standing = v1data<{ rows: { entrantId: string; rank: number }[] } | undefined>(await v1(owner, `/api/v1/stages/${swissId}/standings`))?.rows ?? [];
    const done = await v1(owner, `/api/v1/stages/${swissId}/complete`, "POST");
    const proposal = await v1(owner, `/api/v1/stages/${koId}/seed-proposal`, "POST");
    const computed = v1data<{ id: string; computed?: { qualifiers: { entrantId: string }[]; ties: { slots: string[]; entrantIds: string[] }[] } } | undefined>(proposal);
    const ties = computed?.computed?.ties ?? [];
    const confirmed = await v1(owner, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", {
      proposalId: computed?.id,
      ...(ties.length > 0 ? { tiePicks: ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
    });
    const koRound1 = (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === koId && f.round_no === 1);
    const qualifiers = (computed?.computed?.qualifiers ?? []).map((q) => q.entrantId);
    const topFour = [...standing].sort((a, b) => a.rank - b.rank).slice(0, 4).map((r) => r.entrantId);
    const seatedKo = koRound1.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((id): id is string => id !== null);
    const ok =
      divRes.status < 300 && made.length === 7 && staged.status < 300 && swissId !== undefined && koId !== undefined && dayOne.status === 200 &&
      started.status < 300 && pairs.length === 3 && pairs.every((st) => st === 200) && round1Byes === 1 &&
      lateA?.case === "a" && lateA.round === 1 && round1Boards.length === 4 &&
      round2.length === 4 && lateC?.case === "c" && lateC.round === 3 &&
      round3Before.length === 4 && holder !== null && lateB?.case === "b" && lateB.round === 3 && lateB.bye_holder_id === holder && round3.length === 5 &&
      statuses.length === (4 + 4 + 5) * 3 && statuses.every((st) => st > 0 && st < 300) &&
      standing.length === 10 && done.status === 200 && proposal.status < 300 &&
      computed?.computed !== undefined && qualifiers.length === 4 && [...qualifiers].sort().join() === [...topFour].sort().join() &&
      confirmed.status === 200 && koRound1.length === 2 && [...seatedKo].sort().join() === [...topFour].sort().join();
    w3Check(
      "w3b SW-L10: seven seeded and three late players - (a) re-pairs round 1, (c) joins from round 3, (b) takes round 3's bye - played out over three rounds, the Swiss completes, and the knockout's seed proposal is the table's top four and its confirm seats them in round 1" +
        (ok ? "" : ` - division ${divRes.status} ${divId ?? "none"}, entrants ${made.length}, stages ${staged.status}, day one ${dayOne.status}, start ${started.status}, pairs ${pairs.join(",")}, round 1 byes ${round1Byes} boards ${round1Boards.length}, late ${JSON.stringify([lateA, lateC, lateB])}, round 2 ${round2.length}, round 3 ${round3Before.length} -> ${round3.length} holder ${holder ?? "none"}, event statuses ${statuses.join(",")}, standings ${standing.length}, complete ${done.status} ${JSON.stringify(done.json).slice(0, 160)}, proposal ${proposal.status} ${JSON.stringify(proposal.json).slice(0, 240)}, ties ${ties.length}, confirm ${confirmed.status} ${JSON.stringify(confirmed.json).slice(0, 160)}, knockout round 1 ${JSON.stringify(koRound1.map((f) => [f.home_entrant_id, f.away_entrant_id]))}`),
      ok,
    );
  }

  check(`w3b: the W3 Swiss app-B suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
