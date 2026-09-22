"use client";

// Board action layer (v3/04 §2): every schedule write, optimistic overrides,
// debounced re-validation, realtime refresh, and the optimistic-concurrency
// resync (v3/11 gap 10). Views stay dumb — they call these.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { dayKey, PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED } from "@/lib/schedule-board";
import type { FeedLabelPair } from "@/lib/schedule-board";
import type { z } from "zod";
import type { ApplyScheduleRequest } from "@/server/api-v1/schemas";
import type {
  AutoScheduleRequest,
  ScheduleMetrics,
  ScheduleSolverInfo,
} from "@/server/api-v1/schemas";

/** Which solver a run is asking for. Off the request schema rather than
 *  re-declared, so a fourth mode cannot appear on the wire without every caller
 *  here being typechecked against it. */
export type AutoScheduleMode = AutoScheduleRequest["mode"];
import {
  CONFLICT_HELP,
  cardTitle,
  type BoardConflict,
  type BoardDivision,
  type BoardFixture,
  type PublishAllOutcome,
} from "./types";

// P9 pass 4a: court_id — the merge `{...f, ...o}` (below) has to overwrite
// the field board-grid/movableForRun/etc. actually key on, or an optimistic
// drag shows the card in its OLD column until the next server refresh.
type Override = { scheduled_at: string | null; court_id: string | null; schedule_locked: boolean };

/**
 * A publish/start refusal from the server-side validation gate, carried back to
 * the caller intact.
 *
 * `kind` is derived from the CODE, never from the conflict rows: the two are not
 * interchangeable. `conflict.start_window` is non-blocking and `warn.window` IS
 * blocking, so a client that recomputed "is anything blocking" from the list
 * would disagree with the server that produced it — and would offer a "publish
 * anyway" button that can only ever 422 again.
 */
export interface GateRefusal {
  kind: "blocking" | "warnings";
  conflicts: BoardConflict[];
}

export interface BoardActions {
  board: BoardFixture[];
  conflicts: BoardConflict[];
  conflictsByFixture: Record<string, BoardConflict[]>;
  error: string | null;
  notice: string | null;
  paywall: string | null;
  busy: boolean;
  /** The LAST conflicts check failed (#230 item 5). The conflicts list is then
   *  whatever the last successful check returned — possibly nothing, which is
   *  byte-for-byte what a clean board looks like — so this is the only thing
   *  that distinguishes "no conflicts" from "nobody could ask". */
  checkFailed: boolean;
  /** A conflicts check is in flight; the manual retry is disabled while it is. */
  checking: boolean;
  /**
   * Board quality + solver telemetry from the LAST auto/re-flow run, for the
   * result strip. Null whenever the wire did not carry them — the strip stays
   * away rather than reporting zeros.
   *
   * CLEARED BY EVERY BOARD WRITE, not only by the next run. The strip describes
   * a board; the instant that board is edited, every number on it is about a
   * timetable that no longer exists — drag one card after an auto pass and
   * "Scheduled 6/6 · Total length 1h 30m" is a statement about the board before
   * the drag. It used to be set and cleared inside `autoRun` alone, so it
   * outlived `moveCard`, `togglePin`, `shiftDay`, `swapCourts` and `act`.
   *
   * `togglePin` clears it too, even though a pin moves no card and invalidates
   * no number the strip prints. "Which writes invalidate which cell" is a
   * judgement the next person would have to re-make, correctly, for every cell
   * added later; "every write clears it" cannot rot. Pinned by
   * `__tests__/result-strip-wiring.test.tsx`.
   */
  lastRun: { metrics: ScheduleMetrics; solver: ScheduleSolverInfo } | null;
  /** Re-run the check NOW, not on the 400ms debounce. A button whose effect
   *  starts half a second later is indistinguishable from a dead one. */
  revalidate: () => Promise<void>;
  setError: (e: string | null) => void;
  setNotice: (n: string | null) => void;
  moveCard: (fixtureId: string, atIso: string | null, court: string | null) => Promise<boolean>;
  togglePin: (f: BoardFixture) => Promise<void>;
  /**
   * Propose + apply for one stage.
   *
   * `divisionId` (#pins-ui, owner ruling 2026-08-12) keys `seqRef` exactly as
   * `togglePin`/`moveCard`/`shiftDay`/`swapCourts` already do via
   * `f.division_id` — `autoRun` has no fixture/division object to read one off,
   * only a bare `stageId`, so every caller threads it through explicitly. Get
   * it wrong (a stage id, or a sibling division's id) and the apply below
   * validates against the WRONG board's watermark — a stale-caught-early false
   * negative at best, a real cross-division race left open at worst.
   *
   * `mode` is OMITTED by the two original callers and that is the contract, not
   * an oversight: `AutoScheduleRequest` derives it from `only_unlocked` server
   * side (absent or true -> reflow, false -> build), and the derivation is pinned
   * there. Sending it from here as well would move the decision to the client
   * with nothing to notice when the two definitions drift.
   *
   * POLISH is the exception, because it is the one mode `only_unlocked` cannot
   * express: it re-flows the unlocked cards exactly as REFLOW does, and asks the
   * tier solver to improve the board rather than the repair solver to make it
   * legal.
   *
   * `ignoreLocks` (#pins-ui, owner ruling 2026-08-12) is OMITTED by every caller
   * except the infeasible escape hatch: it is the client half of the request
   * schema's `ignore_locks`, the only thing that can make a run move a
   * `schedule_locked` fixture. Defaulted to `false` and sent only when `true` —
   * see the request body below for why an explicit `false` still omits the key.
   *
   * THE APPLY CARRIES `expected_seq` (#pins-ui). A lock toggled while THIS
   * multi-second solve was running bumps the division watermark
   * (`moveFixture`'s `update divisions set seq = …`), so a 409 here means
   * exactly that race, not a generic failure. Per owner ruling the response is
   * to silently re-solve ONCE against the fresh board and apply that result —
   * never the stale proposal (the board changed, so it may no longer be legal)
   * and never a visible error for a race the organiser did nothing to cause. A
   * second 409 (the retry itself lost the same race again) is not retried a
   * second time — it surfaces through `fail`'s ordinary SEQ_CONFLICT path,
   * same as any other stale write on this board.
   */
  autoRun: (
    stageId: string,
    divisionId: string,
    onlyUnlocked: boolean,
    mode?: AutoScheduleMode,
    ignoreLocks?: boolean,
  ) => Promise<void>;
  /**
   * Publish / start. Resolves to `null` when the action landed, and to the
   * gate's refusal when the server would not put this board in front of players
   * (#230 item 2 follow-up) — the caller opens the confirm dialog on that and
   * calls back with `acknowledgeWarnings: true`.
   *
   * A refusal is deliberately a RETURN VALUE rather than a thrown error routed
   * through `fail`: `fail` renders one sentence and discards `extra.conflicts`,
   * and the whole point here is to show the organiser which conflicts and offer
   * the way through.
   */
  act: (path: string, done: string, acknowledgeWarnings?: boolean) => Promise<GateRefusal | null>;
  /**
   * Release EVERY still-in-setup division of a competition in one call.
   *
   * A SIBLING of `act`, not a caller of it, because the two endpoints answer in
   * structurally different ways and `act` cannot carry this one. `act` exists to
   * turn a 422 refusal into a return value and it discards the success BODY; the
   * competition-wide publish answers **200 with a per-division report** — some
   * published, some awaiting acknowledgement, some blocked — which is exactly the
   * payload the banner has to render. Routed through `act`, that report would be
   * thrown away and a call that published nothing would read as a clean publish.
   *
   * Everything else is `act`'s own behaviour, reused rather than re-invented: the
   * same `busy` flag every other board control reads, the same `fail` ladder
   * (paywall / SEQ_CONFLICT / cooldown / rate limit), the same "no body unless
   * acknowledging" request shape, and the same `router.refresh()` — fired here
   * only when something actually moved, since a call that published nothing has
   * left the RSC nothing new to read.
   *
   * Resolves to `null` only when `fail` handled a hard error.
   */
  publishAll: (
    competitionId: string,
    acknowledgeWarnings?: boolean,
  ) => Promise<PublishAllOutcome | null>;
  shiftDay: (day: string, minutes: number) => Promise<void>;
  swapCourts: (day: string, a: string, b: string) => Promise<void>;
  queueValidate: () => void;
}

export function useBoardActions(
  divisions: BoardDivision[],
  fixtures: BoardFixture[],
  entrantNames: Record<string, string>,
  feedLabels: Record<string, FeedLabelPair>,
  canEdit: boolean,
): BoardActions {
  const msg = useMsg();
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [conflicts, setConflicts] = useState<BoardConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastRun, setLastRun] = useState<BoardActions["lastRun"]>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Monotonic ticket per conflicts check — see `runValidate`. */
  const validateSeq = useRef(0);

  // Optimistic-concurrency tokens (v3/11 gap 10): the seq each division was
  // rendered at, bumped locally per landed write (every schedule write appends
  // exactly one division event). A wrong count self-heals: the server 409s,
  // we refetch. Resynced from props after every server refresh.
  const propsSeq = useMemo(
    () => Object.fromEntries(divisions.map((d) => [d.id, d.seq])),
    [divisions],
  );
  const seqRef = useRef<Record<string, number>>({ ...propsSeq });
  useEffect(() => {
    seqRef.current = { ...propsSeq };
  }, [propsSeq]);

  // Server props are the source of truth; optimistic overrides melt away on
  // each refresh (last-write-wins per fixture, doc 12 §6). Render-time state
  // adjustment (the React "derive from props" pattern) — no effect cascade.
  const [seenFixtures, setSeenFixtures] = useState(fixtures);
  if (seenFixtures !== fixtures) {
    setSeenFixtures(fixtures);
    setOverrides({});
  }

  const board: BoardFixture[] = useMemo(
    () =>
      fixtures.map((f) => {
        const o = overrides[f.id];
        return o ? { ...f, ...o } : f;
      }),
    [fixtures, overrides],
  );

  const conflictsByFixture = useMemo(() => {
    const map: Record<string, BoardConflict[]> = {};
    for (const c of conflicts) (map[c.fixture_id] ??= []).push(c);
    return map;
  }, [conflicts]);

  const runValidate = useCallback(async () => {
    // LAST STARTED WINS, not last resolved.
    //
    // Two validates overlap routinely: the 400ms debounce fires while the
    // organiser is pressing "check again", or a refresh queues one on top of a
    // manual retry — and they settle in whatever order the network returns
    // them. Without this counter a FAILING check that started first and
    // answered last flips the notice back on over a SUCCEEDING one, telling an
    // organiser the list is stale when it had just been refreshed. The calls
    // are idempotent, so the only thing that needs ordering is which answer is
    // allowed to land.
    const seq = ++validateSeq.current;
    // Any queued debounce is now redundant — this call supersedes it. (A
    // clearTimeout on the timer that just fired is a no-op, so this is safe on
    // the debounced path too.)
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setChecking(true);
    try {
      const results = await Promise.all(
        divisions.map((d) =>
          apiV1<{ conflicts: BoardConflict[] }>(`/api/v1/divisions/${d.id}/schedule/validate`, {
            method: "POST",
          }),
        ),
      );
      if (seq !== validateSeq.current) return;
      setConflicts(results.flatMap((r) => r.conflicts));
      setCheckFailed(false);
    } catch {
      // Validation stays ADVISORY — the board must never break because the
      // check did. But #230 item 5: swallowing it silently left an organiser
      // reading an empty conflicts list that was not an answer. Keep the last
      // known conflicts (they are still the best information available) and
      // record that they are no longer current, so the toolbar can say so.
      if (seq !== validateSeq.current) return;
      setCheckFailed(true);
    } finally {
      if (seq === validateSeq.current) setChecking(false);
    }
  }, [divisions]);

  const queueValidate = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runValidate(), 400);
  }, [runValidate]);

  // Full report on load and after every server refresh (doc 12 §4).
  useEffect(() => {
    queueValidate();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [queueValidate, fixtures]);

  const fail = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? ""));
      } else if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
        // Another organiser edited the board since this client loaded it
        // (v3/11 gap 10): resync and say so — no scary error styling.
        setNotice(msg("board.stale"));
        router.refresh();
        return true;
      } else if (err instanceof ApiV1Error && err.code === "RATE_LIMITED") {
        // The per-org solver cooldown (AUTO_SCHEDULE_COOLDOWN, usecases/
        // schedule.ts). A NOTICE, not an error, and the register is deliberate:
        // this is the same class of outcome as `solver_busy` — ordinary,
        // transient, entirely outside the organiser's hands, and the same click
        // a few minutes later works. Red styling would suggest their board is
        // wrong, and nothing about it is.
        //
        // Keyed on the CODE, not on the message: /api/v1 maps every 429 to
        // RATE_LIMITED (server/api-v1/http.ts), and the limiter's own message is
        // hardcoded English. The board is the only surface that calls a limited
        // endpoint, so the code is unambiguous here.
        setNotice(msg("board.action.cooldown"));
      } else if (err instanceof ApiV1Error && err.code === "SCHEDULE_CONFLICT") {
        const list = (err.extra.conflicts as BoardConflict[] | undefined) ?? [];
        const titleOf = (id: string) => {
          const f = board.find((x) => x.id === id);
          // Fix round 3 (Important 3): `lookup` was left off — an unfilled
          // slot's label fell through to cardTitle's client-safe English
          // default instead of `msg` (useMsg(), line 159), regardless of
          // this org's locale.
          return f ? cardTitle(f, entrantNames, feedLabels, msg) : msg("board.action.anotherMatch");
        };
        const helpOf = (code: string) => {
          const k = `board.conflictHelp.${code}` as MessageKey;
          const l = msg(k);
          return l === k ? (CONFLICT_HELP[code] ?? msg("board.action.slotFail")) : l;
        };
        const reasons = [
          ...new Set(
            list.map((c) => {
              let m = helpOf(c.code);
              // Structured `details.other_fixture_id` (C3, 2026-08-13 design
              // amendment) — never a regex scrape of the deprecated prose.
              // The old regex took the FIRST UUID-shaped substring in
              // `c.detail`, which for `entrant_overlap`/`person_overlap` is
              // the ENTRANT/PERSON id, not the counterparty fixture — so
              // `board.find` missed it and this silently degraded to
              // "another match" instead of naming the real one.
              const otherId = c.details?.other_fixture_id;
              if (otherId) m += msg("board.action.withMatch", { title: titleOf(otherId) });
              return m;
            }),
          ),
        ];
        setError(
          reasons.length > 0
            ? msg("board.action.cantSchedule", { reasons: reasons.join(" ") })
            : msg("board.action.cantScheduleClash"),
        );
      } else {
        // Never surface raw codes/stack text; fall back to a friendly line.
        const raw = err instanceof Error ? err.message : "";
        const friendly = raw && !/[{}<>]|error:|\bundefined\b|[0-9a-f]{8}-[0-9a-f]{4}/i.test(raw);
        setError(friendly ? raw : msg("boardset.error"));
      }
      return false;
    },
    [board, entrantNames, feedLabels, router],
  );

  const moveCard = useCallback(
    async (fixtureId: string, atIso: string | null, court: string | null): Promise<boolean> => {
      if (!canEdit) return false;
      setError(null);
      const prev = board.find((f) => f.id === fixtureId);
      if (!prev || prev.status !== "scheduled") return false;
      // After the two guards, so a refused drag does not throw the report away.
      setLastRun(null);
      setOverrides((o) => ({
        ...o,
        [fixtureId]: {
          scheduled_at: atIso,
          court_id: court,
          schedule_locked: prev.schedule_locked,
        },
      }));
      try {
        await apiV1(`/api/v1/fixtures/${fixtureId}`, {
          method: "PATCH",
          json: {
            scheduled_at: atIso,
            // P9 pass 4a: PatchFixture (schemas.ts) is `.strict()` and dropped
            // court_label from its shape when the cutover landed — sending the
            // old key 400s every drag instead of moving the fixture.
            court_id: court,
            expected_seq: seqRef.current[prev.division_id],
          },
        });
        seqRef.current[prev.division_id] = (seqRef.current[prev.division_id] ?? 0) + 1;
        queueValidate();
        router.refresh();
        return true;
      } catch (err) {
        setOverrides((o) => {
          const rest = { ...o };
          delete rest[fixtureId];
          return rest;
        });
        fail(err);
        return false;
      }
    },
    [board, canEdit, fail, queueValidate, router],
  );

  const togglePin = useCallback(
    async (f: BoardFixture) => {
      if (!canEdit) return;
      setError(null);
      setLastRun(null);
      try {
        await apiV1(`/api/v1/fixtures/${f.id}`, {
          method: "PATCH",
          json: { schedule_locked: !f.schedule_locked, expected_seq: seqRef.current[f.division_id] },
        });
        seqRef.current[f.division_id] = (seqRef.current[f.division_id] ?? 0) + 1;
        router.refresh();
      } catch (err) {
        fail(err);
      }
    },
    [canEdit, fail, router],
  );

  const autoRun = useCallback(
    async (
      stageId: string,
      divisionId: string,
      onlyUnlocked: boolean,
      mode?: AutoScheduleMode,
      ignoreLocks = false,
    ) => {
      setError(null);
      setNotice(null);
      setLastRun(null);
      setBusy(true);
      try {
        type Proposal = {
          // P9: DERIVED from the schema the server validates against, never
          // hand-declared. `apiV1<T>` is an unchecked cast, so a hand-written
          // wire type is an assertion the compiler cannot check — this one
          // claimed `court_label` after the server moved to `court_id`, so
          // every Auto-schedule apply POSTed `court_id: undefined`, got a
          // "Invalid input" 400, and persisted nothing while the strip
          // reported the run's own in-memory result. Inferring from
          // ApplyScheduleRequest makes that class of drift a type error.
          assignments: z.infer<typeof ApplyScheduleRequest>["assignments"];
          conflicts: BoardConflict[];
          metrics?: ScheduleMetrics;
          solver?: ScheduleSolverInfo;
        };
        // Closes over stageId/onlyUnlocked/mode/ignoreLocks — the #pins-ui
        // retry below calls this a SECOND time to re-solve against the fresh
        // board, and it must send the IDENTICAL request the original call did.
        // In particular `ignoreLocks` must not leak into a retry that never set
        // it: reusing this closure rather than re-deriving the body is what
        // guarantees that, instead of relying on a second call site to agree.
        const solve = () =>
          apiV1<Proposal>(`/api/v1/stages/${stageId}/schedule/auto`, {
            method: "POST",
            // Spread, not `mode: mode` / `ignore_locks: ignoreLocks` — an explicit
            // `undefined`/`false` serialises as a present key on some paths, and
            // the request schema keeps BOTH fields `.optional()` rather than
            // defaulted so a caller who never heard of them parses identically to
            // one that explicitly declined. `ignoreLocks` in particular must never
            // appear as `false`: this is the ONLY thing that can move a
            // `schedule_locked` fixture (owner ruling, 2026-08-12), and every
            // caller but the infeasible escape hatch below relies on its absence.
            json: {
              only_unlocked: onlyUnlocked,
              ...(mode !== undefined ? { mode } : {}),
              ...(ignoreLocks ? { ignore_locks: true } : {}),
            },
          });

        const applyOnce = (assignments: Proposal["assignments"], expectedSeq: number | undefined) =>
          apiV1<{ applied: number; conflicts: BoardConflict[] }>(
            `/api/v1/stages/${stageId}/schedule/apply`,
            {
              method: "POST",
              json: {
                assignments: assignments.map((a) => ({
                  fixture_id: a.fixture_id,
                  scheduled_at: a.scheduled_at,
                  court_id: a.court_id,
                })),
                source: "auto",
                expected_seq: expectedSeq,
              },
            },
          );

        // Reports telemetry and returns the proposal, or `null` and the
        // "nothing to schedule" notice for an empty one. BEFORE the
        // empty-proposal check, not after: an `infeasible` run can place
        // nothing at all, and that is exactly the run whose report the
        // organiser most needs — capturing it only on a non-empty proposal
        // would hide the strip on the one run that has to explain itself.
        const propose = async (): Promise<Proposal | null> => {
          const out = await solve();
          if (out.metrics && out.solver) setLastRun({ metrics: out.metrics, solver: out.solver });
          if (out.assignments.length === 0) {
            setNotice(msg("board.action.nothingStage"));
            return null;
          }
          return out;
        };

        const out = await propose();
        if (!out) return;

        let expectedSeq = seqRef.current[divisionId];
        let applied: { applied: number; conflicts: BoardConflict[] };
        try {
          applied = await applyOnce(out.assignments, expectedSeq);
        } catch (err) {
          if (!(err instanceof ApiV1Error) || err.code !== "SEQ_CONFLICT") throw err;
          // #pins-ui, owner ruling 2026-08-12: a lock toggled WHILE the solve
          // above was running (`moveFixture` bumps the division watermark on
          // every lock toggle) — the proposal just computed may now pin a
          // fixture that's no longer pinned, or vice-versa, so re-applying IT
          // would be wrong even with a corrected seq. Silently re-solve ONCE
          // against the fresh board and apply THAT.
          //
          // `current_seq` rides on the 409 itself — server/api-v1/http.ts's
          // SEQ_CONFLICT branch reads EngineError's `actualSeq` (schedule.ts's
          // `assertFreshSeq`, which always sets it) off `err.data` and forwards
          // it as `current_seq`, verified via http.test.ts's "SEQ_CONFLICT
          // carries current_seq" spec. Waiting on `router.refresh()` to
          // repopulate `seqRef` from fresh props instead would be async and
          // racy — the fallback below is defensive only, for a malformed 409
          // that should be unreachable from this throw site.
          expectedSeq =
            typeof err.extra.current_seq === "number" ? err.extra.current_seq : expectedSeq;
          const retryOut = await propose();
          if (!retryOut) return;
          // A SECOND SEQ_CONFLICT here is NOT caught — it propagates to the
          // outer catch and surfaces through `fail`'s ordinary path. Exactly
          // one automatic retry, per owner ruling.
          applied = await applyOnce(retryOut.assignments, expectedSeq);
        }
        seqRef.current[divisionId] = (expectedSeq ?? 0) + 1;
        setConflicts(applied.conflicts);
        setNotice(
          applied.conflicts.length > 0
            ? msg("board.action.placedWarn", { n: applied.applied, w: applied.conflicts.length })
            : msg("board.action.placed", { n: applied.applied }),
        );
        router.refresh();
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [fail, router],
  );

  const act = useCallback(
    async (path: string, done: string, acknowledgeWarnings = false): Promise<GateRefusal | null> => {
      setError(null);
      setNotice(null);
      setLastRun(null);
      setBusy(true);
      try {
        // No body unless the organiser is acknowledging: publish and start both
        // parse an ABSENT body as `{}`, and every existing API-key client POSTs
        // them with none. Sending `{}` unconditionally would work but would make
        // "the console always sends a body" a fact the server then has to keep
        // true; sending nothing keeps the two paths identical to today's.
        await apiV1(path, {
          method: "POST",
          json: acknowledgeWarnings ? { acknowledge_warnings: true } : undefined,
        });
        setNotice(done);
        router.refresh();
        return null;
      } catch (err) {
        // The gate's two refusals are NOT errors to render as a red toast —
        // they are a question with an answer, or a report. `fail` would flatten
        // both into a sentence and throw the conflict list away, which is
        // exactly the dead end this follow-up exists to remove.
        if (
          err instanceof ApiV1Error &&
          (err.code === PUBLISH_BLOCKED || err.code === PUBLISH_UNACKNOWLEDGED)
        ) {
          return {
            kind: err.code === PUBLISH_BLOCKED ? "blocking" : "warnings",
            conflicts: (err.extra.conflicts as BoardConflict[] | undefined) ?? [],
          };
        }
        fail(err);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [fail, router],
  );

  const publishAll = useCallback(
    async (competitionId: string, acknowledgeWarnings = false): Promise<PublishAllOutcome | null> => {
      setError(null);
      setNotice(null);
      setLastRun(null);
      setBusy(true);
      try {
        const out = await apiV1<PublishAllOutcome>(
          `/api/v1/competitions/${competitionId}/schedule/publish`,
          {
            method: "POST",
            // Same reasoning as `act` above: an absent body parses as `{}` and
            // every existing key client sends none, so the console must not
            // start making "there is always a body" a fact the server has to
            // keep true.
            json: acknowledgeWarnings ? { acknowledge_warnings: true } : undefined,
          },
        );
        // Only when the board actually changed. A call that published nothing
        // (every division blocked, or awaiting acknowledgement) has left the
        // server-rendered props exactly as they were, and refetching them would
        // melt the optimistic overrides a drag is holding for no reason.
        if (out.published > 0) router.refresh();
        return out;
      } catch (err) {
        fail(err);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [fail, router],
  );

  // Bulk tools (doc 12 §2): shift a day ±N minutes / swap two courts. These
  // run as sequential single moves; the seq token rides along and self-heals.
  const shiftDay = useCallback(
    async (day: string, minutes: number) => {
      setBusy(true);
      setError(null);
      setLastRun(null);
      try {
        for (const f of board) {
          if (f.scheduled_at === null || f.status !== "scheduled") continue;
          if (dayKey(f.scheduled_at as string) !== day) continue;
          await apiV1(`/api/v1/fixtures/${f.id}`, {
            method: "PATCH",
            json: {
              scheduled_at: new Date(
                new Date(f.scheduled_at as string).getTime() + minutes * 60_000,
              ).toISOString(),
              expected_seq: seqRef.current[f.division_id],
            },
          });
          seqRef.current[f.division_id] = (seqRef.current[f.division_id] ?? 0) + 1;
        }
        router.refresh();
        queueValidate();
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [board, fail, queueValidate, router],
  );

  const swapCourts = useCallback(
    async (day: string, a: string, b: string) => {
      setBusy(true);
      setError(null);
      setLastRun(null);
      try {
        for (const f of board) {
          if (f.scheduled_at === null || f.status !== "scheduled") continue;
          if (dayKey(f.scheduled_at as string) !== day) continue;
          // P9 pass 4a: court_id — court_label is frozen legacy and null for
          // anything scheduled since the cutover, so this could no longer
          // match either side; `a`/`b` are court ids (BoardConfig.courts).
          const target = f.court_id === a ? b : f.court_id === b ? a : null;
          if (!target) continue;
          await apiV1(`/api/v1/fixtures/${f.id}`, {
            method: "PATCH",
            // PatchFixture (schemas.ts) is `.strict()` — court_label 400s.
            json: { court_id: target, expected_seq: seqRef.current[f.division_id] },
          });
          seqRef.current[f.division_id] = (seqRef.current[f.division_id] ?? 0) + 1;
        }
        router.refresh();
        queueValidate();
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [board, fail, queueValidate, router],
  );

  // Realtime board refresh on division:{id} (doc 12 §6 — two organisers).
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels: any[] = [];
    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        const sb = supabaseBrowser();
        for (const d of divisions) {
          if (cancelled) return;
          channels.push(
            sb
              .channel(`division:${d.id}`)
              .on("broadcast", { event: "schedule_changed" }, () => router.refresh())
              .subscribe(),
          );
        }
      } catch {
        /* realtime is best-effort; the board still works without it */
      }
    })();
    return () => {
      cancelled = true;
      for (const ch of channels) ch?.unsubscribe();
    };
  }, [divisions, router]);

  return {
    board,
    conflicts,
    conflictsByFixture,
    error,
    notice,
    paywall,
    busy,
    checkFailed,
    checking,
    lastRun,
    revalidate: runValidate,
    setError,
    setNotice,
    moveCard,
    togglePin,
    autoRun,
    act,
    publishAll,
    shiftDay,
    swapCourts,
    queueValidate,
  };
}
