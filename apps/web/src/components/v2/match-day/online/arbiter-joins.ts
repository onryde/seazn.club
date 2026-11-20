// The browser's side of Match Day's cameras: which meetings the board in focus asks for (`meetingKeysOf`), and the hook that keeps exactly
// those joined (`useArbiterJoins`), over the one per-meeting chain every join and leave is queued on (`browserSerial`, arbiter-watch.ts).
//
// Chess only: a "meeting" is one PLAYER's video room (D16), keyed `${fixtureId}:${side}`.
//
// The rules, each one a thing a poll could otherwise break:
//  - ONE live join per key. A key added opens, a key removed closes (the SDK leave, never a DELETE). Keys are compared by CONTENT, so a poll
//    that hands the shell a new board object for the same board re-joins nothing; leaving a board removes both keys, and coming back costs no
//    POST (the serial keeps the token a connect has proven).
//  - `keys` are only the focused board's WATCHABLE sides (`sideWatchable`: the meeting is open AND the loader marks it joinable), so a side whose
//    player has not arrived makes no POST at all and reads "not checked in".
//  - `pollKey` is the day's `lastOkAt`. When it moves, a key whose last answer was VIDEO_MEETING_NOT_STARTED (`rejoinAfterPoll`: the flag-flip case,
//    a side the loader calls joinable but the route refused) opens ONCE more, and so does a key held `busy`. No timer for NOT_STARTED: the poll
//    IS the cadence.
//  - VIDEO_BUSY is not an error. The tile reads `busy`, the join is asked again on `retryMs` (ARBITER_RETRY_MS: 500, 1000, 2000, 4000, 8000 ms),
//    and once the ladder is spent the key stays `busy` and is re-opened by the next poll only - one attempt per poll, the ladder does not restart,
//    so a busy vendor costs at most 5 + 3 POSTs a minute per side at LIVE_POLL_MS, inside ARBITER_JOIN_LIMIT's 12 per (fixture, side, user). The
//    pane's own "Try again" starts a fresh ladder.
//  - "Try again" (`retry`) is the pane's own press for an `error` or a `fault`: one POST per press, never one per poll.
import { useEffect, useMemo, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import type { Reader } from "@/lib/match-day/online";
import { mayPress } from "@/lib/match-day/online";
import { ARBITER_RETRY_MS, joinArbiter } from "./arbiter-camera";
import { makeArbiterSerial, type ArbiterJoinAnswer, type ArbiterOpen, type ArbiterSide } from "./arbiter-watch";
import { arbiterJoinStateFromError, nextOffSince, rejoinAfterPoll, shouldJoinVideo, sideWatchable, type ArbiterVideoView } from "./arbiter-video";

/** `${fixtureId}:${side}` - the meeting of one player of one board; the same spelling `makeArbiterSerial` chains on. */
export type MeetingKey = `${string}:${ArbiterSide}`;

export const meetingKey = (fixtureId: string, side: ArbiterSide): MeetingKey => `${fixtureId}:${side}`;

/** The one chain every pane's open and close is queued on (arbiter-watch.ts): module-level, so even a remount of the page hands the old
 *  participant back before the new one is joined, and a board visited twice reuses the token its first visit proved. The Arbiter Panel (until
 *  Task 10 deletes it) and Match Day's board panel share it: a page only ever runs one of them. */
export const browserSerial = makeArbiterSerial({
  join: (fixtureId, side) =>
    apiV1<ArbiterJoinAnswer>(`/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/arbiter`, { method: "POST", json: { side } }),
  connect: joinArbiter,
});

export type ArbiterSerial = ReturnType<typeof makeArbiterSerial>;

/** Whether the board's panel carries cameras at all: the reader may watch (`mayPress(reader, "cameras")`: an editor in a club offered online chess),
 *  the division REQUIRES them (`optional` and `off` show the chess board alone) and nobody let the board play without video. A board that is
 *  over is still offered - its tiles say so - but joins nothing (`meetingKeysOf`). */
export function camerasOffered(board: Pick<ArbiterBoard, "cameraPolicy" | "videoOverridden">, reader: Reader): boolean {
  return mayPress(reader, "cameras") && board.cameraPolicy === "required" && !board.videoOverridden;
}

/** What a board opens on where cameras and the chess board share the screen (below lg): the cameras while there is something to watch, the
 *  board otherwise (not offered, or the game is over). */
export function defaultCameraMode(board: Pick<ArbiterBoard, "cameraPolicy" | "videoOverridden" | "state">, reader: Reader): "cameras" | "board" {
  return camerasOffered(board, reader) && shouldJoinVideo(board) ? "cameras" : "board";
}

/** The meetings the board in focus asks for, White's side first: none unless cameras are offered (`camerasOffered`) and the board is still to be
 *  watched (`shouldJoinVideo`: not over); then each side that is `sideWatchable`. A pure rule, so the shell's keys and the tests read one spelling. */
export function meetingKeysOf(
  board: Pick<ArbiterBoard, "fixtureId" | "cameraPolicy" | "videoOverridden" | "state" | "whiteSide" | "sides">,
  reader: Reader,
): MeetingKey[] {
  if (!camerasOffered(board, reader) || !shouldJoinVideo(board)) return [];
  const white = board.whiteSide;
  const black: ArbiterSide = white === "home" ? "away" : "home";
  return ([white, black] as const).filter((side) => sideWatchable(board, side)).map((side) => meetingKey(board.fixtureId, side));
}

// ---- the engine (plain code: no React, so a test drives it with a fake serial and a fake clock) ------------------------------------------

type Slot = {
  key: MeetingKey;
  fixtureId: string;
  side: ArbiterSide;
  /** Retired: nothing it answers later is read. */
  dead: boolean;
  /** Which open of this key is current; an older open's answer is dropped. */
  gen: number;
  open: ArbiterOpen | null;
  /** The last view this key published; null until its first answer. */
  view: ArbiterVideoView | null;
  /** An open is out and has not answered. */
  inFlight: boolean;
  /** A busy retry is waiting on its timer. */
  timer: ReturnType<typeof setTimeout> | null;
  /** How many of `retryMs` this busy spell has used. */
  ladder: number;
};

export type JoinViews = ReadonlyMap<MeetingKey, ArbiterVideoView>;

function sameView(a: ArbiterVideoView | null, b: ArbiterVideoView): boolean {
  if (a === null || a.kind !== b.kind) return false;
  if (a.kind !== "watching" || b.kind !== "watching") return true;
  return a.tile.present === b.tile.present && a.tile.live === b.tile.live && a.tile.offSinceMs === b.tile.offSinceMs && a.tile.track === b.tile.track;
}

export function createJoinEngine(o: {
  serial: ArbiterSerial;
  retryMs: readonly number[];
  publish(views: JoinViews): void;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  const slots = new Map<MeetingKey, Slot>();
  const views = new Map<MeetingKey, ArbiterVideoView>();
  const emit = () => o.publish(new Map(views));

  function put(slot: Slot, view: ArbiterVideoView): void {
    if (slot.dead || sameView(slot.view, view)) return;
    slot.view = view;
    views.set(slot.key, view);
    emit();
  }

  function retire(slot: Slot): void {
    slot.dead = true;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    slot.open?.close();
    slot.open = null;
  }

  function scheduleRetry(slot: Slot): void {
    if (slot.ladder >= o.retryMs.length) return; // spent: held busy until the next poll
    const wait = o.retryMs[slot.ladder]!;
    slot.ladder += 1;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (!slot.dead) start(slot);
    }, wait);
  }

  function start(slot: Slot): void {
    slot.open?.close(); // the previous open of this key (already answered): its SDK leave is queued ahead of the new join
    const gen = (slot.gen += 1);
    const current = () => !slot.dead && slot.gen === gen;
    slot.inFlight = true;
    slot.open = o.serial.open(slot.fixtureId, slot.side, {
      onCameras: (c) => {
        if (!current()) return;
        slot.inFlight = false;
        const observe = () => {
          if (!current()) return;
          const prev = slot.view;
          // The guard left the meeting: the fault stands until a retry.
          if (prev !== null && prev.kind === "fault") return;
          const was = prev !== null && prev.kind === "watching" ? prev.tile : null;
          const tile = c.tile();
          put(slot, { kind: "watching", tile: { ...tile, offSinceMs: nextOffSince(was?.offSinceMs ?? null, tile, now()) } });
        };
        c.onChange(observe);
        c.onFault(() => {
          if (current()) put(slot, { kind: "fault" });
        });
        observe();
      },
      onError: (err) => {
        if (!current()) return;
        slot.inFlight = false;
        const view = arbiterJoinStateFromError(err);
        put(slot, view);
        if (view.kind === "busy") scheduleRetry(slot);
      },
    });
  }

  return {
    /** Make the live joins exactly `want`: a key not asked for is closed, a key not yet open is opened. Idempotent for the same keys. */
    reconcile(want: readonly MeetingKey[]): void {
      const wanted = new Set(want);
      let changed = false;
      for (const [key, slot] of slots) {
        if (wanted.has(key)) continue;
        retire(slot);
        slots.delete(key);
        changed = views.delete(key) || changed;
      }
      for (const key of want) {
        if (slots.has(key)) continue;
        const at = key.lastIndexOf(":");
        const slot: Slot = {
          key,
          fixtureId: key.slice(0, at),
          side: key.slice(at + 1) as ArbiterSide,
          dead: false,
          gen: 0,
          open: null,
          view: null,
          inFlight: false,
          timer: null,
          ladder: 0,
        };
        slots.set(key, slot);
        changed = views.delete(key) || changed;
        start(slot);
      }
      if (changed) emit();
    },
    /** A poll answered: re-open, ONCE, each key whose last answer says to (NOT_STARTED while watchable - every key here is -, or held busy). */
    poll(): void {
      for (const slot of slots.values()) {
        if (slot.inFlight || slot.timer !== null) continue;
        if (rejoinAfterPoll(slot.view, true) || slot.view?.kind === "busy") start(slot);
      }
    },
    /** The pane's "Try again": one more join for a key that errored or faulted. Nothing for a key mid-open or one that is not live. */
    retry(key: MeetingKey): void {
      const slot = slots.get(key);
      if (slot === undefined || slot.inFlight || slot.timer !== null) return;
      slot.ladder = 0;
      put(slot, { kind: "connecting" });
      start(slot);
    },
    /** Leave everything (the page goes away): the SDK leave of each open join, no DELETE. */
    closeAll(): void {
      for (const slot of slots.values()) retire(slot);
      slots.clear();
      views.clear();
      emit();
    },
  };
}

// ---- the hook --------------------------------------------------------------------------------------------------------------------------

const NO_VIEWS: JoinViews = new Map();

/** Keep `keys` joined (see the header) and say how each is doing. `keys` is compared by content; `pollKey` is the day's `lastOkAt`. `deps` is a
 *  test seam: a fake serial, a short ladder. Returns the views by key and the pane's `retry`. */
export function useArbiterJoins(
  keys: readonly MeetingKey[],
  pollKey: number | null,
  deps: { serial?: ArbiterSerial; retryMs?: readonly number[] } = {},
): { views: JoinViews; retry(key: MeetingKey): void } {
  const serial = deps.serial ?? browserSerial;
  const ladder = (deps.retryMs ?? ARBITER_RETRY_MS).join(",");
  const [views, setViews] = useState<JoinViews>(NO_VIEWS);
  const engine = useMemo(
    () => createJoinEngine({ serial, retryMs: ladder === "" ? [] : ladder.split(",").map(Number), publish: setViews }),
    [serial, ladder],
  );
  const sig = keys.join("|");
  const want = useMemo(() => (sig === "" ? [] : (sig.split("|") as MeetingKey[])), [sig]);
  // Order matters: a key opened in this commit is in flight when the poll's turn comes, so one render never POSTs a key twice.
  useEffect(() => {
    engine.reconcile(want);
  }, [engine, want]);
  useEffect(() => {
    engine.poll();
  }, [engine, pollKey]);
  useEffect(() => () => engine.closeAll(), [engine]);
  return { views, retry: engine.retry };
}
