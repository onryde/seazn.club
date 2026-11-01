// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, appendScoreEvent, newSession, check, signIn, smokeDb, tag, v1, v1data } from "../harness.ts";
import { swissDrawSeed, swissRoundOneOrder } from "../../../apps/web/src/lib/swiss-draw.ts";

/**
 * Format matrix W3 Swiss app-A (spec 2026-10-31-format-matrix-w3-swiss-design.md) — the app PR's smoke proof, over real
 * HTTP against a live server. One check per task that owes one, each beside the state it proves.
 *
 * T1 (X-RB-1, #840, FX-G13): Rebuild keeps every time and court at its (pool, round, seq) position, in one transaction,
 * and reports what it could not keep. T2 (X-RB-1, SW-L8): a pre-Start Swiss reshape deletes an unscheduled board before a
 * pinned one. T4 (X-SW-21, RB3-15 A): an ad-hoc match on a Swiss stage is refused 422 SWISS_ADHOC_REFUSED and writes
 * nothing. T3 (X-SW-5, X-SW-29; SW-M7, SW-M13): a bye's format is frozen when Pair awards it, so a later format save
 * leaves it, and a bye shell takes no court or time (422 SWISS_BYE_NOT_PLACEABLE). T5 (X-SW-28, #835): Undo of Pair next
 * puts the round back onto its shells — no round-1 row is left seated. T6 (X-SW-12, ruling 251): an entrant whose first
 * Swiss round is 2 is on no round-1 row and is seated from round 2. T7 (X-SW-15, RB3-2; rulebook P-A2): a double-walkover
 * pair has not met, so the next Pair may seat it again. T8 (X-SW-22, SW-L6, RB3-16): an unseeded round 1 is the stage's
 * seeded random draw, not registration order. Own fresh owner. Every read is a v1 route; the one
 * write that needs DATABASE_URL is T6's stamp of `entrants.swiss_first_round` (no route writes it until Task 9), and
 * without it that check fails rather than skips. Every check is counted, and a run that checked nothing fails.
 * SMOKE_ONLY=w3SwissA runs it alone (SELECTABLE_SUITES).
 */
export async function w3SwissASuite(): Promise<void> {
  // T1: 2 (a rebuild keeps 3 slots; a shrinking rebuild counts the slots it freed) + T2: 1 (a pre-Start reshape keeps
  // the pinned boards) + T4: 1 (no ad-hoc match on a Swiss stage; T4 runs before T3 by controller ruling C1) + T3: 2 (a
  // bye's format is frozen at award; a bye shell is never placed) + T5: 1 (Undo of Pair next clears the round's seats) +
  // T6: 1 (an entrant with a first Swiss round is on no round below it) + T7: 1 (a double-walkover pair meets again) +
  // T8: 1 (an unseeded round 1 seats the stage's draw, not registration order).
  const EXPECTED_CHECKS = 10;
  let checked = 0;
  const w3Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w3a_${tag}@resend.dev`);
  const orgId = who.org_id;
  const venueId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `W3a Venue ${tag}` }),
  )?.id;
  const courts: string[] = [];
  for (const name of ["Court 1", "Court 2"]) {
    const court = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/orgs/${orgId}/venues/${venueId}/courts`, "POST", { name }),
    );
    if (court) courts.push(court.id);
  }
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss A ${tag}`, visibility: "private" }),
  );

  type Fx = {
    id: string;
    stage_id: string;
    pool_id: string | null;
    round_no: number;
    seq_in_round: number;
    scheduled_at: string | null;
    court_id: string | null;
    ext_key?: string | null;
  };
  type Rebuilt = { removed: number; slots?: { kept: number; freed: number; unscheduled: number } };
  const position = (f: Fx) => `${f.pool_id ?? "-"}|${f.round_no}|${f.seq_in_round}`;

  /** A generic league of `names`, generated, with every fixture laid out on its own hour and alternating courts. Returns
   *  the slot this suite wrote per position — the expected values, never read back from the code under test. Each league
   *  takes its own day (13th, 14th; the Swiss check uses the 16th): the leagues share the venue's two courts, so a second
   *  league on the same hours is refused by the double-booking gate (`SCHEDULE_CONFLICT`) and lays out only half. */
  let leagues = 0;
  async function laidOutLeague(s: Session, label: string, names: string[]) {
    const day = `2030-06-${13 + leagues++}`;
    const divId = v1data<{ id: string } | undefined>(
      await v1(s, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
        name: label,
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    )?.id;
    const entrants =
      v1data<{ id: string }[] | undefined>(
        await v1(s, `/api/v1/divisions/${divId}/entrants`, "POST",
          names.map((n, i) => ({ kind: "individual", display_name: `${n} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(s, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: label }),
    )?.id;
    await v1(s, `/api/v1/stages/${stageId}/generate`, "POST");
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(s, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const laid = new Map<string, { scheduled_at: string; court_id: string }>();
    let placed = 0;
    const refused: string[] = [];
    for (const [i, f] of (await fixtures()).entries()) {
      const slot = { scheduled_at: `${day}T${String(8 + i).padStart(2, "0")}:00:00.000Z`, court_id: courts[i % 2] ?? "" };
      const res = await v1(s, `/api/v1/fixtures/${f.id}`, "PATCH", { ...slot, venue_id: venueId });
      if (res.status === 200) {
        placed++;
        laid.set(position(f), slot);
      } else refused.push(`${position(f)}: ${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
    }
    return { divId, entrants, stageId, fixtures, laid, placed, refused };
  }

  // Check 1 — a pre-Start withdrawal and a late registration: three entrants before and after, so every position
  // survives and every slot with it.
  {
    const league = await laidOutLeague(owner, "Keep", ["A", "B", "C"]);
    await v1(owner, `/api/v1/entrants/${league.entrants[0]?.id}/withdraw`, "POST");
    await v1(owner, `/api/v1/divisions/${league.divId}/entrants`, "POST", [{ kind: "individual", display_name: `D ${tag}`, seed: 4 }]);
    const res = await v1(owner, `/api/v1/stages/${league.stageId}/rebuild`, "POST");
    const out = v1data<Rebuilt | undefined>(res);
    const after = await league.fixtures();
    const kept = after.filter((f) => {
      const want = league.laid.get(position(f));
      return want !== undefined && f.scheduled_at === want.scheduled_at && f.court_id === want.court_id;
    }).length;
    const ok = league.placed === 3 && res.status === 200 && after.length === 3 && kept === 3 && out?.slots?.kept === 3 && out.slots.freed === 0;
    w3Check(
      "w3a X-RB-1: a Rebuild keeps all 3 laid-out slots at their positions, and says so (slots.kept 3, freed 0)" +
        (ok ? "" : ` — placed ${league.placed} (refused ${league.refused.join("; ")}), status ${res.status}, after ${after.length}, kept ${kept}, out ${JSON.stringify(out ?? res.json)}`),
      ok,
    );
  }

  // Check 2 — a withdrawal with no replacement: four entrants (6 fixtures) become three (3), so the positions that are
  // gone free their slots. The expected count is the set difference of the positions read before and after.
  {
    const league = await laidOutLeague(owner, "Shrink", ["A", "B", "C", "D"]);
    const before = new Set(league.laid.keys());
    await v1(owner, `/api/v1/entrants/${league.entrants[3]?.id}/withdraw`, "POST");
    const res = await v1(owner, `/api/v1/stages/${league.stageId}/rebuild`, "POST");
    const out = v1data<Rebuilt | undefined>(res);
    const afterPositions = new Set((await league.fixtures()).map(position));
    const gone = [...before].filter((p) => !afterPositions.has(p)).length;
    const fresh = [...afterPositions].filter((p) => !before.has(p)).length;
    const ok =
      league.placed === 6 && res.status === 200 && gone > 0 &&
      out?.slots?.freed === gone && out.slots.unscheduled === fresh && out.slots.kept === afterPositions.size - fresh;
    w3Check(
      `w3a X-RB-1: a shrinking Rebuild counts every slot whose position is gone in slots.freed (${gone} expected)` +
        (ok ? "" : ` — placed ${league.placed} (refused ${league.refused.join("; ")}), status ${res.status}, fresh ${fresh}, out ${JSON.stringify(out?.slots ?? res.json)}`),
      ok,
    );
  }

  // Check 3 (T2) — eight Swiss players, boards 1, 2 and 4 of round 2 laid out and board 3 bare; the highest seed leaves
  // before Start, and the next press reshapes every unseated round to seven (three boards and a bye). The bare board
  // goes; b4 keeps its slot at seq 3.
  {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
        name: "Reshape",
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    )?.id;
    const players =
      v1data<{ id: string; display_name: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `P${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } }),
    )?.id;
    await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST"); // mint: four boards a round
    const round2 = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [])
        .filter((f) => f.stage_id === stageId && f.round_no === 2)
        .sort((a, b) => a.seq_in_round - b.seq_in_round);
    const laid = new Map<string, { scheduled_at: string; court_id: string }>();
    let placed = 0;
    for (const [i, key] of ["sw-r2-b1", "sw-r2-b2", "sw-r2-b4"].entries()) {
      const f = (await round2()).find((r) => r.ext_key === key);
      const slot = { scheduled_at: `2030-06-16T${String(9 + i).padStart(2, "0")}:00:00.000Z`, court_id: courts[i % 2] ?? "" };
      if (f && (await v1(owner, `/api/v1/fixtures/${f.id}`, "PATCH", { ...slot, venue_id: venueId })).status === 200) placed++;
      laid.set(key, slot);
    }
    // The highest seed leaves: the pre-Start departure path (a delete, not a withdrawal).
    const leaving = players.find((p) => p.display_name === `P8 ${tag}`);
    const left = await v1(owner, `/api/v1/entrants/${leaving?.id}`, "DELETE");
    const paired = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const after = await round2();
    const shape = after.map((f) => `${f.seq_in_round}:${f.ext_key}`).join(",");
    const kept = [...laid].filter(([key, want]) => {
      const f = after.find((r) => r.ext_key === key);
      return f !== undefined && f.scheduled_at === want.scheduled_at && f.court_id === want.court_id;
    }).length;
    const ok =
      players.length === 8 && placed === 3 && left.status < 300 && paired.status === 200 &&
      shape === "1:sw-r2-b1,2:sw-r2-b2,3:sw-r2-b4,4:sw-r2-bye" && kept === 3;
    w3Check(
      "w3a X-RB-1 SW-L8: a pre-Start Swiss reshape deletes the unscheduled board 3, and the pinned boards 1, 2 and 4 keep their slots" +
        (ok ? "" : ` — players ${players.length}, placed ${placed}, delete ${left.status}, pair ${paired.status}, round 2 ${shape}, kept ${kept}`),
      ok,
    );
  }

  // Check 4 (T4, X-SW-21) — Swiss rounds are paired by the system: an ad-hoc match on a paired Swiss stage is refused by
  // name (422 SWISS_ADHOC_REFUSED) and the stage's fixtures are exactly what they were.
  {
    const divId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
        name: "No ad-hoc",
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    )?.id;
    const players =
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Q${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
    )?.id;
    const paired = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const count = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId).length;
    const before = await count();
    const res = await v1(owner, `/api/v1/stages/${stageId}/fixtures`, "POST", {
      home_entrant_id: players[0]?.id,
      away_entrant_id: players[1]?.id,
    });
    const after = await count();
    const ok =
      players.length === 4 && paired.status === 200 && before > 0 &&
      res.status === 422 && res.json.error?.code === "SWISS_ADHOC_REFUSED" && after === before;
    w3Check(
      "w3a X-SW-21: Add match on a Swiss stage is refused 422 SWISS_ADHOC_REFUSED and writes nothing" +
        (ok ? "" : ` — players ${players.length}, pair ${paired.status}, before ${before}, after ${after}, POST ${res.status} ${JSON.stringify(res.json).slice(0, 160)}`),
      ok,
    );
  }

  // Checks 5 and 6 (T3) — a badminton Swiss of five (odd: every round has a bye), round 1 paired. Its own competition: the
  // fresh owner's plan caps divisions per competition, and the one above already holds four.
  {
    const byeComp = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss A bye ${tag}`, visibility: "private" }),
    );
    const divRes = await v1(owner, `/api/v1/competitions/${byeComp?.id}/divisions`, "POST", { name: "Bye", sport_key: "badminton", variant_key: "bwf" });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const players =
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: 5 }, (_, i) => ({ kind: "individual", display_name: `B${i + 1} ${tag}`, seed: i + 1 }))),
      ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
    )?.id;
    const minted = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const paired = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const rows = async () =>
      (v1data<(Fx & { status: string })[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter(
        (f) => f.stage_id === stageId,
      );
    const byKey = async (key: string) => (await rows()).find((f) => f.ext_key === key);
    const bye1 = await byKey("sw-r1-bye");
    const board2 = await byKey("sw-r2-b1");
    const rulesOf = async (id: string | undefined) => v1data<{ cfg?: { bestOf?: number } } | undefined>(await v1(owner, `/api/v1/fixtures/${id}/rules`))?.cfg;
    const setup = `division ${divRes.status}${divId ? "" : ` ${JSON.stringify(divRes.json).slice(0, 160)}`}, players ${players.length}, mint ${minted.status}, pair ${paired.status}, bye ${bye1?.status ?? "missing"}, board ${board2 ? "found" : "missing"}`;

    // Check 5 (X-SW-5, SW-M7): the seated bye's format is the one it was awarded under. A stage format save moves what an
    // unplayed match plays (round 2's board: the witness the save landed) and leaves the bye's.
    {
      const byeBefore = await rulesOf(bye1?.id);
      const put = await v1(owner, `/api/v1/stages/${stageId}/rules`, "PUT", { rules: { bestOf: 1 } });
      const byeAfter = await rulesOf(bye1?.id);
      const boardAfter = await rulesOf(board2?.id);
      const ok =
        players.length === 5 && paired.status === 200 && bye1?.status === "forfeited" &&
        byeBefore !== undefined && byeBefore.bestOf !== 1 && put.status === 200 &&
        JSON.stringify(byeAfter) === JSON.stringify(byeBefore) && boardAfter?.bestOf === 1;
      w3Check(
        "w3a X-SW-5: a Swiss bye keeps the format it was awarded under after a stage format save (an unplayed board takes the new one)" +
          (ok ? "" : ` — ${setup}, bye bestOf ${byeBefore?.bestOf} -> ${byeAfter?.bestOf}, PUT ${put.status} ${JSON.stringify(put.json).slice(0, 160)}, board bestOf ${boardAfter?.bestOf}`),
        ok,
      );
    }

    // Check 6 (X-SW-29, SW-M13): round 2's bye shell is refused a court and a time by name, and stays slotless; the round's
    // board takes the same slot (the positive pair: the refusal is the bye's, not the slot's). Round 1's seated bye holds
    // no slot either.
    {
      const bye2 = await byKey("sw-r2-bye");
      const slot = { scheduled_at: "2030-06-17T09:00:00.000Z", court_id: courts[0] ?? "", venue_id: venueId };
      const refused = await v1(owner, `/api/v1/fixtures/${bye2?.id}`, "PATCH", slot);
      const placed = await v1(owner, `/api/v1/fixtures/${board2?.id}`, "PATCH", slot);
      const after = await rows();
      const slotless = (key: string) => {
        const f = after.find((r) => r.ext_key === key);
        return f !== undefined && f.scheduled_at === null && f.court_id === null;
      };
      const ok =
        bye2 !== undefined && refused.status === 422 && refused.json.error?.code === "SWISS_BYE_NOT_PLACEABLE" &&
        slotless("sw-r2-bye") && slotless("sw-r1-bye") && placed.status === 200 &&
        after.find((r) => r.ext_key === "sw-r2-b1")?.court_id === slot.court_id;
      w3Check(
        "w3a X-SW-29: a Swiss bye shell is refused a court and a time (422 SWISS_BYE_NOT_PLACEABLE) and holds none; the round's board takes the slot" +
          (ok ? "" : ` — ${setup}, PATCH bye ${refused.status} ${JSON.stringify(refused.json).slice(0, 160)}, PATCH board ${placed.status}, bye2 slotless ${slotless("sw-r2-bye")}, bye1 slotless ${slotless("sw-r1-bye")}`),
        ok,
      );
    }

    // Check 7 (T5, X-SW-28, #835): Undo of Pair next puts the round back onto its shells. A generic Swiss of five in the
    // same competition (it holds one division): mint, Pair round 1 — every round-1 row seated, the positive pair — then
    // Undo. No round-1 row is left seated, and every shell is still there.
    {
      const undoDiv = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/competitions/${byeComp?.id}/divisions`, "POST", {
          name: "Undo",
          sport_key: "generic",
          variant_key: "score",
          config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
        }),
      )?.id;
      const undoPlayers =
        v1data<{ id: string }[] | undefined>(
          await v1(owner, `/api/v1/divisions/${undoDiv}/entrants`, "POST",
            Array.from({ length: 5 }, (_, i) => ({ kind: "individual", display_name: `U${i + 1} ${tag}`, seed: i + 1 }))),
        ) ?? [];
      const undoStage = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/divisions/${undoDiv}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
      )?.id;
      const undoMint = await v1(owner, `/api/v1/stages/${undoStage}/generate`, "POST");
      const undoPair = await v1(owner, `/api/v1/stages/${undoStage}/generate`, "POST");
      type Seat = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };
      const round1 = async () =>
        (v1data<Seat[] | undefined>(await v1(owner, `/api/v1/divisions/${undoDiv}/fixtures`)) ?? []).filter(
          (f) => f.stage_id === undoStage && f.round_no === 1,
        );
      const seated = (rs: Seat[]) => rs.filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null).length;
      const before = await round1();
      const undone = await v1(owner, `/api/v1/divisions/${undoDiv}/undo`, "POST", {});
      const after = await round1();
      const sameShells =
        JSON.stringify(after.map((f) => f.id).sort()) === JSON.stringify(before.map((f) => f.id).sort());
      const ok =
        undoPlayers.length === 5 && undoMint.status === 200 && undoPair.status === 200 &&
        before.length === 3 && seated(before) === 3 && undone.status === 200 && seated(after) === 0 && sameShells;
      w3Check(
        "w3a X-SW-28: Undo of Pair next leaves 0 seated round-1 rows (3 before) and keeps every shell" +
          (ok ? "" : ` — players ${undoPlayers.length}, mint ${undoMint.status}, pair ${undoPair.status}, round 1 ${before.length} rows / ${seated(before)} seated, undo ${undone.status} ${JSON.stringify(undone.json).slice(0, 160)}, after ${after.length} rows / ${seated(after)} seated, same shells ${sameShells}`),
        ok,
      );
    }

    // Check 8 (T6, X-SW-12; spec §4, ruling 251): an entrant whose first Swiss round is 2 is on no round below it, and is
    // seated from it. A generic Swiss of five in the same competition; the fifth is given first round 2 — this suite's one
    // SQL write, because nothing writes the column over HTTP until Task 9's "Add late player" — then Start, Pair round 1
    // (four players: two boards, no bye), both boards decided by walkover, and Pair round 2 (all five).
    {
      const lateDiv = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/competitions/${byeComp?.id}/divisions`, "POST", {
          name: "Late",
          sport_key: "generic",
          variant_key: "score",
          config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
        }),
      )?.id;
      const latePlayers =
        v1data<{ id: string; display_name: string }[] | undefined>(
          await v1(owner, `/api/v1/divisions/${lateDiv}/entrants`, "POST",
            Array.from({ length: 5 }, (_, i) => ({ kind: "individual", display_name: `L${i + 1} ${tag}`, seed: i + 1 }))),
        ) ?? [];
      const fifth = latePlayers.find((p) => p.display_name === `L5 ${tag}`)?.id ?? "";
      const lateStage = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/divisions/${lateDiv}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } }),
      )?.id;
      // -1: no DATABASE_URL, so the stamp could not be written and the check cannot be judged (it fails, never skips).
      let stamped = -1;
      if (process.env.DATABASE_URL) {
        const db = smokeDb();
        try {
          stamped = (await db`update entrants set swiss_first_round = 2 where id = ${fifth}`).count;
        } finally {
          await db.end();
        }
      }
      const started = await v1(owner, `/api/v1/divisions/${lateDiv}/start`, "POST");
      const pair1 = await v1(owner, `/api/v1/stages/${lateStage}/generate`, "POST");
      type Seat = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };
      const roundRows = async (r: number) =>
        (v1data<Seat[] | undefined>(await v1(owner, `/api/v1/divisions/${lateDiv}/fixtures`)) ?? []).filter(
          (f) => f.stage_id === lateStage && f.round_no === r,
        );
      const on = (rs: Seat[], id: string) => rs.some((f) => f.home_entrant_id === id || f.away_entrant_id === id);
      const r1 = await roundRows(1);
      const r1Boards = r1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
      const othersOnR1 = latePlayers.filter((p) => p.id !== fifth && on(r1, p.id)).length;
      const walkovers: number[] = [];
      for (const b of r1Boards) {
        walkovers.push((await appendScoreEvent(owner, b.id, "core.forfeit", { by: b.away_entrant_id, reason: "walkover" })).status);
      }
      const pair2 = await v1(owner, `/api/v1/stages/${lateStage}/generate`, "POST");
      const r2 = await roundRows(2);
      const ok =
        stamped === 1 && latePlayers.length === 5 && started.status < 300 && pair1.status === 200 &&
        r1Boards.length === 2 && !on(r1, fifth) && othersOnR1 === 4 &&
        walkovers.length === 2 && walkovers.every((s) => s < 300) && pair2.status === 200 && on(r2, fifth);
      w3Check(
        "w3a X-SW-12: an entrant whose first Swiss round is 2 is on no round-1 row (4 others on 2 boards) and is seated in round 2" +
          (ok ? "" : ` — stamped ${stamped === -1 ? "no DATABASE_URL" : stamped}, players ${latePlayers.length}, start ${started.status}, pair 1 ${pair1.status} ${JSON.stringify(pair1.json).slice(0, 160)}, round 1 ${r1Boards.length} boards / fifth on it ${on(r1, fifth)} / others ${othersOnR1}, walkovers ${walkovers.join(",")}, pair 2 ${pair2.status} ${JSON.stringify(pair2.json).slice(0, 160)}, fifth on round 2 ${on(r2, fifth)}`),
        ok,
      );
    }

    // Check 9 (T7, X-SW-15; rulebook P-A2, RB3-2): a pair whose match was not played has not met. A generic Swiss of four
    // (3 rounds) in the same competition: Start, Pair round 1 — the fold, R1 v R3 and R2 v R4 — and BOTH boards recorded as
    // double walkovers through the Forfeit button's route. Nobody scored and nobody met, so round 2's fold over the same
    // seeds seats the same two pairs again. Before T7 every seated pair counted as met, and round 2 had to pair R1 v R2
    // and R3 v R4 (or R1 v R4 and R2 v R3) instead: the expected pairs are round 1's, read back, never the pairer's.
    {
      const reDiv = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/competitions/${byeComp?.id}/divisions`, "POST", {
          name: "Rematch",
          sport_key: "generic",
          variant_key: "score",
          config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
        }),
      )?.id;
      const rePlayers =
        v1data<{ id: string }[] | undefined>(
          await v1(owner, `/api/v1/divisions/${reDiv}/entrants`, "POST",
            Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `R${i + 1} ${tag}`, seed: i + 1 }))),
        ) ?? [];
      const reStage = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/divisions/${reDiv}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } }),
      )?.id;
      const reStarted = await v1(owner, `/api/v1/divisions/${reDiv}/start`, "POST");
      const rePair1 = await v1(owner, `/api/v1/stages/${reStage}/generate`, "POST");
      type Seat = Fx & { home_entrant_id: string | null; away_entrant_id: string | null; status?: string };
      const reBoards = async (r: number) =>
        (v1data<Seat[] | undefined>(await v1(owner, `/api/v1/divisions/${reDiv}/fixtures`)) ?? []).filter(
          (f) => f.stage_id === reStage && f.round_no === r && f.home_entrant_id !== null && f.away_entrant_id !== null,
        );
      const pairsOf = (rs: Seat[]) => rs.map((f) => [f.home_entrant_id, f.away_entrant_id].sort().join("|")).sort();
      const round1 = await reBoards(1);
      const forfeits: number[] = [];
      for (const b of round1) {
        forfeits.push((await appendScoreEvent(owner, b.id, "core.forfeit", { by: "both", reason: "walkover" })).status);
      }
      const decided = (await reBoards(1)).filter((f) => f.status === "forfeited").length;
      const rePair2 = await v1(owner, `/api/v1/stages/${reStage}/generate`, "POST");
      const round2 = await reBoards(2);
      const ok =
        rePlayers.length === 4 && reStarted.status < 300 && rePair1.status === 200 && round1.length === 2 &&
        forfeits.length === 2 && forfeits.every((st) => st < 300) && decided === 2 && rePair2.status === 200 &&
        round2.length === 2 && JSON.stringify(pairsOf(round2)) === JSON.stringify(pairsOf(round1));
      w3Check(
        "w3a X-SW-15: both round-1 double-walkover pairs are seated again in round 2 (2 boards, the same pairs)" +
          (ok ? "" : ` — players ${rePlayers.length}, start ${reStarted.status}, pair 1 ${rePair1.status}, round 1 ${round1.length} boards, forfeits ${forfeits.join(",")}, decided ${decided}, pair 2 ${rePair2.status} ${JSON.stringify(rePair2.json).slice(0, 160)}, round 2 ${JSON.stringify(pairsOf(round2))} vs round 1 ${JSON.stringify(pairsOf(round1))}`),
        ok,
      );
    }

    // Check 10 (T8, X-SW-22; SW-L6, REC RB3-16): an unseeded round 1 is the stage's seeded random draw, never registration
    // order. A generic Swiss of sixteen, nobody seeded, registered ONE POST each so registration order is the server's own
    // tie-break (`seed nulls last, created_at, id`) with no database read. Start, Pair round 1. Expected: the fold (position
    // k v k + 8, the upper at home — a generic Swiss has no colours) over `swissRoundOneOrder(swissDrawSeed(stage), field)`;
    // and the round is NOT the fold over registration order, which is what main seated (16! orders: equal by chance never).
    // Its own competition: `byeComp` already holds four divisions, the community plan's cap per competition.
    {
      const drawComp = v1data<{ id: string } | undefined>(
        await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W3 Swiss A draw ${tag}`, visibility: "private" }),
      );
      const drawDiv = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/competitions/${drawComp?.id}/divisions`, "POST", {
          name: "Drawn",
          sport_key: "generic",
          variant_key: "score",
          config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
        }),
      )?.id;
      const registered: string[] = [];
      for (let i = 0; i < 16; i++) {
        const one = v1data<{ id: string }[] | undefined>(
          await v1(owner, `/api/v1/divisions/${drawDiv}/entrants`, "POST", [
            { kind: "individual", display_name: `D${i + 1} ${tag}`, seed: null },
          ]),
        );
        if (one?.[0]) registered.push(one[0].id);
      }
      const drawStage = v1data<{ id: string } | undefined>(
        await v1(owner, `/api/v1/divisions/${drawDiv}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 4 } }),
      )?.id;
      const drawStarted = await v1(owner, `/api/v1/divisions/${drawDiv}/start`, "POST");
      const drawPair = await v1(owner, `/api/v1/stages/${drawStage}/generate`, "POST");
      type Seat = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };
      const seated = (v1data<Seat[] | undefined>(await v1(owner, `/api/v1/divisions/${drawDiv}/fixtures`)) ?? [])
        .filter((f) => f.stage_id === drawStage && f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)
        .sort((a, b) => a.seq_in_round - b.seq_in_round)
        .map((f) => `${f.home_entrant_id}|${f.away_entrant_id}`);
      const fold = (order: readonly string[]) =>
        Array.from({ length: order.length / 2 }, (_, k) => `${order[k]}|${order[k + order.length / 2]}`);
      const drawn = drawStage ? swissRoundOneOrder(swissDrawSeed(drawStage), registered.map((id) => ({ id, seed: null }))) : [];
      const unordered = (pairs: readonly string[]) => pairs.map((p) => p.split("|").sort().join("|")).sort();
      const ok =
        registered.length === 16 && drawStarted.status < 300 && drawPair.status === 200 && seated.length === 8 &&
        JSON.stringify(seated) === JSON.stringify(fold(drawn)) &&
        JSON.stringify(unordered(seated)) !== JSON.stringify(unordered(fold(registered)));
      w3Check(
        "w3a X-SW-22: an unseeded round 1 of 16 seats the stage's draw (8 boards), not the fold over registration order" +
          (ok ? "" : ` — competition ${drawComp?.id ?? "none"}, division ${drawDiv ?? "none"}, players ${registered.length}, start ${drawStarted.status}, pair ${drawPair.status} ${JSON.stringify(drawPair.json).slice(0, 160)}, round 1 ${JSON.stringify(seated)} vs draw ${JSON.stringify(fold(drawn))}, registration fold ${JSON.stringify(fold(registered))}`),
        ok,
      );
    }
  }

  check(`w3a: the W3 Swiss app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
