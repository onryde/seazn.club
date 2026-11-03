import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { appendScoreEvent, call, check, newSession, signIn, smokeDb, tag, v1, v1data } from "../harness.ts";
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
 * T8 (X-SW-7, X-SW-8; FIDE C.07 (2026) art. 16): the two engine inputs the app owes a Swiss table - the side(s) of a result lost
 * WITHOUT playing and the rounds an entrant was in the stage but unpaired - reach the public table. A board game Swiss of three
 * (R = 3), a fourth player added after round 1 (case (c): joins round 2), every board played through the scorer's own events,
 * and the Buchholz cells the anonymous hub document prints equal the hand derivation in the check: the latecomer's missed
 * round 1 is a virtual-opponent round, not a round that never happened.
 * Every check is counted, and a run that checked nothing fails. SMOKE_ONLY=w3SwissB runs it alone (SELECTABLE_SUITES).
 */
export async function w3SwissBSuite(): Promise<void> {
  // T1: 1 (Pair next on a history with no legal round is refused SWISS_NO_LEGAL_PAIRING and seats nobody).
  // T2: 1 (a boardgame division's stored byeScore is gone from the config GET answers, once the V490 delta has run).
  // T8: 1 (a late entrant's missed round and a bye are virtual-opponent rounds in the Buchholz the anonymous hub prints).
  const EXPECTED_CHECKS = 3;
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

  // Check 2 — T2 (X-SW-6). The delta is found by glob, never by number (it is renumbered at merge).
  {
    const deltas = fileURLToPath(new URL("../../../db/migration/deltas/", import.meta.url));
    const found = readdirSync(deltas).filter((f) => /^V\d+__w3_bye_score_cleanup\.sql$/.test(f));
    const block =
      found.length === 1 ? /do \$\$[\s\S]*?end \$\$;/.exec(readFileSync(`${deltas}${found[0]}`, "utf8").replace(/--.*$/gm, ""))?.[0] : undefined;
    const canon = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
    const comp = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss B bye ${tag}`, visibility: "private" }),
    );
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

  // Check 3 - T8 (X-SW-7, X-SW-8). The engine's S4 (late entry), over HTTP, read from the anonymous hub document. A = seed 1,
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
  {
    const comp = v1data<{ id: string; slug?: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss B art16 ${tag}`, visibility: "public" }),
    );
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

  check(`w3b: the W3 Swiss app-B suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
