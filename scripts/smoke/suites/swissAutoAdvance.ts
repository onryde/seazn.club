// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { check, newSession, signIn, tag, v1, v1data } from "../harness.ts";
import { resolveSettleMs } from "../../../apps/web/src/server/auto-advance/settle.ts";

/**
 * Swiss auto-advance (spec docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md; plan 2026-11-08-swiss-auto-advance.md)
 * — the smoke proof over real HTTP against a live server. One counted check per state it proves.
 *
 * T4 (§4.1, §4.6): a stage's two switches through `PUT /api/v1/stages/{id}/auto-advance`, and the division's read
 * `GET /api/v1/divisions/{id}/auto-advance`. A badminton Swiss of three rounds (seq 1) feeds a knockout of its top four
 * at setup (seq 2), four players. Expected values are the spec's, typed here: both switches are off until turned on and
 * the read lists nothing; `autoPair` turns on on the Swiss and is recorded once in the division's history, naming the
 * person, however often the same value is sent; on the knockout it is refused AUTO_PAIR_NOT_SWISS, and `autoConfirmHandoff`
 * is refused AUTO_CONFIRM_NO_HANDOFF on the Swiss and taken on the knockout; turning a switch off is never refused; a body
 * naming no switch is a 400.
 *
 * T5 (§4.2): arming from results. With the switch back on, Start and Pair round 1, then each board decided through the
 * scorer's events route: one board open leaves `pair_round` 2 waiting and naming it; the last one decided arms the same row
 * pending, due exactly one settle window after it was armed. The window is resolved from this process's environment by the
 * server's own rule (`resolveSettleMs`): the spec's 60 s, or CI's e2e-only override when its flag is also set.
 *
 * Every check is counted, and a run that checked nothing fails. SMOKE_ONLY=swissAutoAdvance runs it alone
 * (SELECTABLE_SUITES). Own fresh owner (Community plan: one competition, one division); keyless; no SQL.
 */
export async function swissAutoAdvanceSuite(): Promise<void> {
  // T4: 6 (defaults off and an empty read; on, once in the history with a person; the same value again records nothing;
  //        the two refusals by name with the knockout's positive pair; off; the 400 on an empty body).
  // T5: 1 (a decided round arms pair_round 2: waiting on the open board, then pending one settle window out).
  const EXPECTED_CHECKS = 7;
  let checked = 0;
  const aaCheck = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  await signIn(owner, `delivered+saa_${tag}@resend.dev`);

  type Stage = { id: string; seq: number; config: Record<string, unknown> };
  type Out = { autoPair: boolean; autoConfirmHandoff: boolean; actions: unknown[] };
  const errorCode = (r: { json: { error?: unknown } }) => (r.json.error as { code?: string } | undefined)?.code;

  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Auto-advance ${tag}`, visibility: "private" }),
  );
  const divId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp?.id}/divisions`, "POST", { name: "Open", sport_key: "badminton", variant_key: "bwf", config: {} }),
  )?.id;
  const entrants =
    v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `AA${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
  const swissId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } }),
  )?.id;
  const koId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Cup",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
    }),
  )?.id;
  const rig = `division ${divId ?? "none"}, entrants ${entrants.length}, swiss ${swissId ?? "none"}, knockout ${koId ?? "none"}`;

  const configOf = async (stageId: string | undefined) =>
    (v1data<Stage[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`)) ?? []).find((s) => s.id === stageId)?.config;
  const switched = async () =>
    (v1data<{ events: { type: string; actor_id: string | null }[] } | undefined>(await v1(owner, `/api/v1/divisions/${divId}/history`))
      ?.events ?? []).filter((e) => e.type === "stage_auto_advance_switched");
  const put = (stageId: string | undefined, body: unknown) => v1(owner, `/api/v1/stages/${stageId}/auto-advance`, "PUT", body);

  // Check 1 — the empty case first: nothing stored on either stage, nothing in the history, and the read lists nothing.
  {
    const swissConfig = await configOf(swissId);
    const koConfig = await configOf(koId);
    const read = await v1(owner, `/api/v1/divisions/${divId}/auto-advance`);
    const actions = v1data<{ actions?: unknown[] } | undefined>(read)?.actions;
    const events = await switched();
    const ok =
      entrants.length === 4 && swissConfig !== undefined && koConfig !== undefined &&
      !("autoPair" in swissConfig) && !("autoConfirmHandoff" in koConfig) &&
      read.status === 200 && Array.isArray(actions) && actions.length === 0 && events.length === 0;
    aaCheck(
      "saa T4: a fresh Swiss and its knockout store neither switch, the history has no switch entry, and GET /divisions/{id}/auto-advance lists nothing" +
        (ok ? "" : ` - ${rig}, swiss config ${JSON.stringify(swissConfig)}, knockout config ${JSON.stringify(koConfig)}, read ${read.status} ${JSON.stringify(read.json).slice(0, 160)}, events ${events.length}`),
      ok,
    );
  }

  // Check 2 — on: stored, answered, and one history entry naming the person (a session's write).
  {
    const on = await put(swissId, { autoPair: true });
    const out = v1data<Out | undefined>(on);
    const stored = (await configOf(swissId))?.autoPair;
    const events = await switched();
    const ok =
      on.status === 200 && out?.autoPair === true && out.autoConfirmHandoff === false && Array.isArray(out.actions) &&
      stored === true && events.length === 1 && events[0].actor_id !== null;
    aaCheck(
      "saa T4: autoPair turns on on the Swiss - answered and stored on, one stage_auto_advance_switched entry naming the person" +
        (ok ? "" : ` - ${rig}, PUT ${on.status} ${JSON.stringify(on.json).slice(0, 200)}, stored ${String(stored)}, events ${JSON.stringify(events)}`),
      ok,
    );
  }

  // Check 3 — the second call: the same value again is answered and records nothing.
  {
    const again = await put(swissId, { autoPair: true });
    const events = await switched();
    const ok = again.status === 200 && v1data<Out | undefined>(again)?.autoPair === true && events.length === 1;
    aaCheck(
      "saa T4: the same value again is answered 200 and adds no history entry" +
        (ok ? "" : ` - PUT ${again.status} ${JSON.stringify(again.json).slice(0, 200)}, events ${events.length}`),
      ok,
    );
  }

  // Check 4 — refused by name where the switch can never act, with the knockout's positive pair.
  {
    const pairOnKo = await put(koId, { autoPair: true });
    const confirmOnSwiss = await put(swissId, { autoConfirmHandoff: true });
    const koBefore = await configOf(koId);
    const confirmOnKo = await put(koId, { autoConfirmHandoff: true });
    const koAfter = await configOf(koId);
    const swissAfter = await configOf(swissId);
    const ok =
      pairOnKo.status === 422 && errorCode(pairOnKo) === "AUTO_PAIR_NOT_SWISS" &&
      confirmOnSwiss.status === 422 && errorCode(confirmOnSwiss) === "AUTO_CONFIRM_NO_HANDOFF" &&
      koBefore !== undefined && !("autoPair" in koBefore) && !("autoConfirmHandoff" in koBefore) &&
      swissAfter !== undefined && !("autoConfirmHandoff" in swissAfter) &&
      confirmOnKo.status === 200 && koAfter?.autoConfirmHandoff === true;
    aaCheck(
      "saa T4: autoPair on the knockout is refused AUTO_PAIR_NOT_SWISS and autoConfirmHandoff on the Swiss AUTO_CONFIRM_NO_HANDOFF, writing nothing; autoConfirmHandoff on the knockout (fed at setup) is taken" +
        (ok ? "" : ` - pair on knockout ${pairOnKo.status} ${errorCode(pairOnKo) ?? "-"}, confirm on Swiss ${confirmOnSwiss.status} ${errorCode(confirmOnSwiss) ?? "-"}, knockout before ${JSON.stringify(koBefore)}, confirm on knockout ${confirmOnKo.status}, knockout after ${JSON.stringify(koAfter)}`),
      ok,
    );
  }

  // Check 5 — off is never refused: stored off, and its own history entry (three moves in all).
  {
    const off = await put(swissId, { autoPair: false });
    const stored = (await configOf(swissId))?.autoPair;
    const events = await switched();
    const ok = off.status === 200 && v1data<Out | undefined>(off)?.autoPair === false && stored === false && events.length === 3;
    aaCheck(
      "saa T4: autoPair turns off on the Swiss - stored off, and the history holds three switch entries (on, the knockout's confirm, off)" +
        (ok ? "" : ` - PUT ${off.status} ${JSON.stringify(off.json).slice(0, 200)}, stored ${String(stored)}, events ${events.length}`),
      ok,
    );
  }

  // Check 6 — a body naming no switch is a 400, and writes nothing.
  {
    const empty = await put(swissId, {});
    const events = await switched();
    const ok = empty.status === 400 && events.length === 3;
    aaCheck(
      "saa T4: a body naming no switch is refused 400 and records nothing" + (ok ? "" : ` - PUT {} ${empty.status}, events ${events.length}`),
      ok,
    );
  }

  // Check 7 — T5: results arm the next round's pair. Switched back on before anything is decided, so the arming seen here
  // is the results', not the switch's.
  {
    type Action = { id: string; stageId: string; kind: string; state: string; targetRound: number | null; dueAt: string | null; updatedAt: string; detail: unknown };
    type Board = { id: string; stage_id: string; round_no: number; seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null };
    const live = async () => v1data<{ actions?: Action[] } | undefined>(await v1(owner, `/api/v1/divisions/${divId}/auto-advance`))?.actions ?? [];
    const seqOf = async (id: string) => v1data<{ last_seq: number } | undefined>(await v1(owner, `/api/v1/fixtures/${id}/state`))?.last_seq;
    const post = async (id: string, type: string, payload: unknown = {}) =>
      (await v1(owner, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await seqOf(id), type, payload })).status;
    /** A played badminton win for home: two games to 21. Answers every event's status. */
    const win = async (id: string) => [
      await post(id, "core.start"),
      await post(id, "badminton.game.summary", { home: 21, away: 10 }),
      await post(id, "badminton.game.summary", { home: 21, away: 10 }),
    ];

    const on = await put(swissId, { autoPair: true });
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const paired = await v1(owner, `/api/v1/stages/${swissId}/generate`, "POST");
    const boards = (v1data<Board[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [])
      .filter((f) => f.stage_id === swissId && f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)
      .sort((a, b) => a.seq_in_round - b.seq_in_round);
    const [b1, b2] = boards;
    const first = b1 ? await win(b1.id) : [];
    const waiting = await live();
    const second = b2 ? await win(b2.id) : [];
    const armed = await live();
    const settle = resolveSettleMs(process.env);
    const w = waiting[0];
    const a = armed[0];
    const openBoards = (w?.detail as { openBoards?: { fixtureId: string }[] } | null)?.openBoards;
    const ok =
      on.status === 200 && started.status < 300 && paired.status === 200 && boards.length === 2 &&
      [...first, ...second].every((s) => s === 201) &&
      waiting.length === 1 && w?.kind === "pair_round" && w.state === "waiting" && w.targetRound === 2 && w.stageId === swissId &&
      openBoards?.length === 1 && openBoards[0]?.fixtureId === b2?.id &&
      armed.length === 1 && a?.id === w.id && a.state === "pending" && a.targetRound === 2 && a.dueAt !== null &&
      Date.parse(a.dueAt) - Date.parse(a.updatedAt) === settle;
    aaCheck(
      `saa T5: a decided round arms pair_round 2 - waiting on the one open board, then pending on the last result, due one settle window (${settle} ms) after it armed` +
        (ok ? "" : ` - ${rig}, on ${on.status}, start ${started.status}, pair ${paired.status}, boards ${boards.length}, events ${JSON.stringify([...first, ...second])}, waiting ${JSON.stringify(waiting).slice(0, 300)}, armed ${JSON.stringify(armed).slice(0, 300)}`),
      ok,
    );
  }

  check(`saa: the Swiss auto-advance suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS && checked > 0);
}
