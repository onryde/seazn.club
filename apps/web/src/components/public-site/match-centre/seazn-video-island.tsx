"use client";
// Seazn-hosted video (Phase 1 Task 15; spec §5.1; recommendation 2026-11-21, G-B): the match page's Seazn player, in the `replay` slot of
// the court card where a YouTube replay would sit. The page is ISR (`revalidate = 30`), so a signed address minted in its server render
// would be served past its token's life; the island asks the video route itself, after hydration, and keeps asking:
//   - `live`: the live player, and no picker (recordings listed beside a live source do not play);
//   - no live, one or more parts: the parts in `partNo` order, ONE player at a time, with a picker ("Part {n}") only when there are two
//     or more. A part plays in its own kind: an `hls` part (the interim Cloudflare recording, signed from the moment the session's
//     recording is locked) in the <video> player, an `embed` part (the replay host's copy, Task 25) in the host's frame
//     (seazn-replay-frame.tsx). When a later read answers `embed` for the part on screen, that part turns to the host's frame (a
//     restart, accepted: it happens once per part). The island keeps looking every 30 s until the replay is final, so a second Go live
//     (after half-time, or a failed run) turns the page to the new live player without a reload;
//   - nothing to show (not yet live, ended with no recording signed yet): nothing renders, and the island keeps looking: every 30 s
//     near kick-off or while the match is active, else backing off to 60 s (review N1), and stopping once the fixture is settled
//     (review I2). So a page opened before kick-off turns to the live player without a reload. No read while the tab is hidden; one
//     when it is shown again.
//   - ...EXCEPT while a WAIT is on (re-capture R2: a Seazn session warming, or just stopped with its recording not locked yet): the
//     player's own box holds, dark, with one quiet line, through every empty answer, until a player arrives or the wait runs out; so
//     the player's arrival, a poll later, moves nothing. The wait is the page's (`holdUntil`) or starts when a player was on screen
//     and leaves (seazn-video-hold.ts has the rules). The box goes ONCE, when the wait runs out; it is never dropped and drawn again
//     between reads.
//   - the box also holds the picker's row, invisible, when the page knows the replay has two or more parts (`replayParts`, re-capture
//     R1), so the real picker takes its place with no shift.
//
// WHEN to ask again is the schedule's (seazn-video-schedule.ts), the loop's is seazn-video-poll.ts, and how an address reaches the
// element is seazn-playback.ts; this file is the wiring and the markup. `endpoint` picks the route: the public one (the match page) or
// the organiser's (Match Day's fixture panel, Task 17).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/lib/client";
import { interpolate } from "@/lib/i18n-runtime";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_PLAYER_FRAME, SeaznPlayer } from "./seazn-player";
import { SeaznReplayFrame } from "./seazn-replay-frame";
import { holdAfterAnswer, holdWait, parseHold, showsPlayer } from "./seazn-video-hold";
import type { SeaznVideoLabels } from "./seazn-video-labels";
import { startVideoPoll, type VideoPoll } from "./seazn-video-poll";

export type SeaznVideoEndpoint = "public" | "org";

export function seaznVideoUrl(fixtureId: string, endpoint: SeaznVideoEndpoint): string {
  const id = encodeURIComponent(fixtureId);
  return endpoint === "public" ? `/api/v1/public/fixtures/${id}/video` : `/api/v1/fixtures/${id}/video`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSigned = (v: unknown): v is Record<string, unknown> & { src: string; expiresAt: string } =>
  isObject(v) && typeof v.src === "string" && v.src !== "" && typeof v.expiresAt === "string" && v.expiresAt !== "";

const isPart = (v: unknown): boolean =>
  isSigned(v) && Number.isInteger(v.partNo) && (v.partNo as number) >= 1 && (v.player === "hls" || v.player === "embed");

/** The route's answer, checked before the page trusts it (`PublicFixtureVideo` is the contract; the zod schema is server-side and not
 *  worth a client bundle, so this is its hand-written twin, held to it by the island's test). Throws on anything else, so the loop
 *  keeps what it had. */
export function asPublicFixtureVideo(raw: unknown): PublicFixtureVideo {
  if (!isObject(raw)) throw new Error("seazn video: the answer is not an object");
  const { live, replay } = raw;
  if (live !== null && !isSigned(live)) throw new Error("seazn video: bad live source");
  if (!Array.isArray(replay) || !replay.every(isPart)) throw new Error("seazn video: bad replay parts");
  return raw as unknown as PublicFixtureVideo;
}

/** One read of the route. Never from the browser's cache (the route says `no-store`, and a stale answer is a lapsed token). */
export async function fetchSeaznVideo(fixtureId: string, endpoint: SeaznVideoEndpoint, signal: AbortSignal): Promise<PublicFixtureVideo> {
  return asPublicFixtureVideo(await api<unknown>(seaznVideoUrl(fixtureId, endpoint), { cache: "no-store", signal }));
}

/** The tablist's arrow keys: where focus goes from `from` among `count` tabs, or null for a key that moves nothing. */
export function nextPartIndex(key: string, from: number, count: number): number | null {
  const last = count - 1;
  if (key === "ArrowRight") return from === last ? 0 : from + 1;
  if (key === "ArrowLeft") return from === 0 ? last : from - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  return null;
}

const REGION = "ph-no-capture mt-4 border-t border-white/10 pt-4";
/** The picker's row, and a part's pill by whether it is the selected one: one authority for their geometry, so the row the box holds
 *  (re-capture R1) is the real one's size, to the pixel, however many parts wrap. */
const PICKER_ROW = "mb-3 flex flex-wrap gap-2";
const partPillClass = (selected: boolean): string =>
  `inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink ${
    selected ? "bg-accent text-accent-ink" : "border border-white/25 text-court-ink hover:bg-white/10"
  }`;

/** A player's identity. A different part is a different recording; a different `epoch` is a player that gave up and is rebuilt by the
 *  next answer (the poll's `rebuild`), so it gets a fresh element and a fresh hls.js instance even when the address is unchanged. A
 *  token refresh changes neither, which is what keeps the picture running through one. The replay host's frame for a part has a key
 *  of its own (`embed:`), so a part turning from the interim to the host's copy mounts the frame in place of the player. */
export const playerKey = (part: number | "live", epoch: number): string => `${part}:${epoch}`;
const frameKey = (part: number, epoch: number): string => `embed:${playerKey(part, epoch)}`;

interface StageProps {
  video: PublicFixtureVideo | null;
  /** How many times the players have been rebuilt after giving up. */
  epoch: number;
  labels: SeaznVideoLabels;
  /** A player gave up on its address: ask the route for a fresh one, and rebuild the player with it. */
  onFatal: () => void;
  /** The replay host's frame holds an address whose token has passed: ask the route for a fresh one (no rebuild). */
  onStale: () => void;
}

/** The player's box with no player in it (D1, re-capture R2 and R1): the same region and the same frame the player has, so the
 *  player's arrival moves nothing. With a wait on it carries the one quiet line, and is not hidden from assistive tech (the line is a
 *  status); without one it is empty and hidden, as D1 drew it. `picker` is the part numbers the page expects the picker to list (two
 *  or more draw its row, invisible). */
function HeldBox({ starting, labels, picker }: { starting: boolean; labels: SeaznVideoLabels; picker: readonly number[] }) {
  const row =
    picker.length >= 2 ? (
      <div data-testid="seazn-video-picker-reserved" aria-hidden="true" className={`invisible ${PICKER_ROW}`}>
        {picker.map((n, i) => (
          <span key={n} className={partPillClass(i === 0)}>
            {interpolate(labels.part, { n })}
          </span>
        ))}
      </div>
    ) : null;
  return starting ? (
    <section data-testid="seazn-video-starting" className={REGION}>
      {row}
      <div data-testid="seazn-video-frame" className={SEAZN_PLAYER_FRAME}>
        <p role="status" className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-court-ink/70">
          {labels.starting}
        </p>
      </div>
    </section>
  ) : (
    <section data-testid="seazn-video-reserved" aria-hidden="true" className={REGION}>
      {row}
      <div data-testid="seazn-video-frame" className={SEAZN_PLAYER_FRAME} />
    </section>
  );
}

/** Everything the island draws for one answer. Exported for its test (the wiring of its callbacks). */
export function SeaznVideoStage({ video, epoch, labels, onFatal, onStale, reserve, held, picker }: StageProps & { reserve: boolean; held: boolean; picker: readonly number[] }) {
  if (video !== null && showsPlayer(video)) {
    if (video.live !== null) {
      return (
        <section data-testid="seazn-video" aria-label={labels.live} className={REGION}>
          <SeaznPlayer key={playerKey("live", epoch)} src={video.live.src} title={labels.live} liveLabel={labels.live} unavailable={labels.unavailable} onFatal={onFatal} />
        </section>
      );
    }
    const parts = [...video.replay].sort((a, b) => a.partNo - b.partNo);
    return <ReplayParts parts={parts} epoch={epoch} labels={labels} onFatal={onFatal} onStale={onStale} />;
  }
  // Nothing to play. A wait on (warming, or just stopped): the box holds. Before the first answer, where a player is expected (D1):
  // the box, empty. Otherwise it is nothing, and the island keeps looking. The picker's row is held only before the answer: an answer
  // with no player has told us the page's hint is stale.
  if (held || (video === null && reserve)) return <HeldBox starting={held} labels={labels} picker={video === null ? picker : []} />;
  return null;
}

/** The replay: its picker and the picked part's player. Exported for its test (the wiring of its callbacks). */
export function ReplayParts({ parts, epoch, labels, onFatal, onStale }: { parts: PublicFixtureVideo["replay"]; epoch: number; labels: SeaznVideoLabels; onFatal: () => void; onStale: () => void }) {
  const base = useId();
  // The viewer's pick is a part NUMBER, which a later read keeps stable; a part that is gone from the list falls back to the first.
  const [picked, setPicked] = useState<number | null>(null);
  const active = parts.find((p) => p.partNo === picked) ?? parts[0]!;
  const multi = parts.length > 1;
  const tabId = (partNo: number) => `${base}-tab-${partNo}`;
  const panelId = `${base}-panel`;
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = nextPartIndex(e.key, i, parts.length);
    if (next === null) return;
    e.preventDefault();
    const to = parts[next]!;
    setPicked(to.partNo);
    document.getElementById(tabId(to.partNo))?.focus();
  };
  // Keyed by the part: a different part is a different recording, so it gets its own player, which starts at its own beginning. The
  // part's own kind picks the player: the replay host's frame for its copy, the <video> for the interim recording.
  const title = multi ? interpolate(labels.part, { n: active.partNo }) : labels.replay;
  const player =
    active.player === "embed" ? (
      <SeaznReplayFrame key={frameKey(active.partNo, epoch)} src={active.src} expiresAt={active.expiresAt} title={title} onStale={onStale} />
    ) : (
      <SeaznPlayer key={playerKey(active.partNo, epoch)} src={active.src} title={title} unavailable={labels.unavailable} onFatal={onFatal} />
    );
  return (
    <section data-testid="seazn-video" aria-label={labels.replay} className={REGION}>
      {multi ? (
        <>
          <div role="tablist" aria-label={labels.replay} className={PICKER_ROW}>
            {parts.map((p, i) => {
              const selected = p.partNo === active.partNo;
              return (
                <button
                  key={p.partNo}
                  type="button"
                  role="tab"
                  id={tabId(p.partNo)}
                  aria-selected={selected}
                  aria-controls={selected ? panelId : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setPicked(p.partNo)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={partPillClass(selected)}
                >
                  {interpolate(labels.part, { n: p.partNo })}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(active.partNo)}>
            {player}
          </div>
        </>
      ) : (
        player
      )}
    </section>
  );
}

export interface SeaznVideoIslandProps {
  fixtureId: string;
  /** `public` (default): the match page's route. `org`: the organiser's (Match Day, Task 17). */
  endpoint?: SeaznVideoEndpoint;
  labels: SeaznVideoLabels;
  /** An answer to show before the first read (the server markup of a test); the page passes none. */
  initial?: PublicFixtureVideo;
  /** When the fixture is settled (ISO; the page's plan, seazn-video-plan.ts): an empty answer from then on stops the reads (Phase 1
   *  review I2). Absent or null: the reads only back off. */
  settledAt?: string | null;
  /** Review N1, from the page's plan (ISO): the fixture's kick-off, and until when it counts as active (in play, or a Seazn session
   *  warming or live, when the page was drawn). Either one holds the 30 s floor through empty answers. Absent or null: cold. */
  kickoffAt?: string | null;
  activeUntil?: string | null;
  /** A player is expected (Phase 1 visual D1): until the first answer, hold the player's box. An answer with nothing to show
   *  collapses it, unless a wait is on. Absent: nothing is drawn before an answer (a fixture with no Seazn session yet). */
  reserve?: boolean;
  /** A wait is on until this instant (ISO; the page's plan, seazn-video-plan.ts; re-capture R2): a Seazn session warming, or just
   *  stopped with its recording not locked yet, as the page was drawn. The box holds, with its line, through empty answers until
   *  then (and implies the box without `reserve`). Absent, null or not a date: no wait. */
  holdUntil?: string | null;
  /** The part numbers the page expects the route to list as replay parts (re-capture R1; the plan's, empty while a live is on air, which
   *  has no picker). Two or more: the box holds the picker's row, invisible, until the first answer. Absent, or fewer: no row. */
  replayParts?: readonly number[];
}

export function SeaznVideoIsland({
  fixtureId, endpoint = "public", labels, initial, settledAt = null, kickoffAt = null, activeUntil = null, reserve = false, holdUntil: holdFromPlan = null, replayParts = [],
}: SeaznVideoIslandProps) {
  const [video, setVideo] = useState<PublicFixtureVideo | null>(initial ?? null);
  // The wait, as an instant (ms), or null: from the page's plan at first, then from the answers (`holdAfterAnswer`). Taken from the PROPS
  // alone for the first render, never from the clock, so the server markup and the hydrated one agree.
  const [holdUntil, setHoldUntil] = useState<number | null>(() => parseHold(holdFromPlan));
  const [epoch, setEpoch] = useState(0);
  const pollRef = useRef<VideoPoll | null>(null);
  // Not a date: never settled (a NaN settle time compares false, so the loop only backs off).
  const settledAtMs = settledAt === null ? null : Date.parse(settledAt);
  // Not a date: no window (the schedule reads a NaN hint as cold).
  const kickoffAtMs = kickoffAt === null ? null : Date.parse(kickoffAt);
  const activeUntilMs = activeUntil === null ? null : Date.parse(activeUntil);

  useEffect(() => {
    // The page's visibility is the document's (the loop's default): no read while the tab is hidden.
    const poll = startVideoPoll({
      fetchVideo: (signal) => fetchSeaznVideo(fixtureId, endpoint, signal),
      onVideo: (next, { rebuild }) => {
        setVideo(next);
        setHoldUntil((until) => holdAfterAnswer(until, next, Date.now()));
        if (rebuild) setEpoch((e) => e + 1);
      },
      settledAtMs,
      kickoffAtMs,
      activeUntilMs,
    });
    pollRef.current = poll;
    return () => {
      poll.stop();
      pollRef.current = null;
    };
  }, [fixtureId, endpoint, settledAtMs, kickoffAtMs, activeUntilMs]);

  // The wait ends by itself: the box lets go ONCE, when it runs out, whatever the loop is doing (it may have stopped, settled). One the
  // page drew that has already run out (an old cached page) lets go at once: the line goes, the reserved box stays for the first answer.
  useEffect(() => {
    if (holdUntil === null) return;
    const timer = setTimeout(() => setHoldUntil(null), holdWait(holdUntil, Date.now()));
    return () => clearTimeout(timer);
  }, [holdUntil]);

  const refresh = useCallback(() => pollRef.current?.refreshSoon(), []);
  const readSoon = useCallback(() => pollRef.current?.readSoon(), []);
  return <SeaznVideoStage video={video} epoch={epoch} labels={labels} onFatal={refresh} onStale={readSoon} reserve={reserve} held={holdUntil !== null} picker={replayParts} />;
}
