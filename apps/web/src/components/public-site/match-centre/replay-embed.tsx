"use client";
// YouTube Connect T16 (owner rulings O1, O4, O5) - the match's replay, inside the match card, directly under the scoreline.
//
// A CLICK-TO-PLAY FACADE. Until a person taps, the page loads nothing from YouTube but the video's thumbnail (i.ytimg.com): no
// iframe, no script, no cookie. The tap mounts the privacy-enhanced player (youtube-nocookie.com) with autoplay on - which is
// allowed because the person just asked to play - and nothing is drawn over the player or its controls.
//
//   - One part is the player alone (no "Part 1" anywhere). Two or more parts get a tab rail ABOVE the player, inside the card; a tab
//     switches the player to that part's facade and stops what was playing - still click-to-play, never autoplay.
//   - "Open on YouTube" is a plain 44px text link under the player, always there.
//   - The facade carries NO YouTube logo (the branding rule: the logo only ever sits inside a link to YouTube content). It is a
//     neutral play glyph and the words "Play on YouTube".
//   - Some videos cannot be embedded (the owner switched embedding off, error 101/150; no embedder identity, 153; removed or
//     private, 100). The embedded player says so by postMessage; the page hears it and puts the "Open on YouTube" link in place of
//     the player. The page has to ask first (the `listening` handshake on the iframe's load) - no script is loaded from YouTube.
//   - A part whose address is not provably a video (a channel, a playlist) is the link from the start, never an iframe.
//   - A part MADE FOR KIDS is a link out and never a player (owner ruling 2026-10-29; Google's YouTube API Services Developer Policies
//     III.E.4.j bar tracking on a page that embeds such a video, and this site runs consent-gated analytics). Its card is the replay
//     part's own frame (the same 16:9 box with the 200px floor) holding one line saying why and ONE "Watch on YouTube" link - no
//     iframe, no thumbnail (the facade's thumbnail is a request to i.ytimg.com), no second link. The rule fails closed
//     (`mayEmbedReplay` in lib/youtube.ts): only a part positively NOT made for kids may be embedded; true, unknown and a missing flag
//     are the link. It is decided per PART, so a match can hold a player for one part and the card for another.
//
// The sizing rule (Google's embedded-player policy): the player is at least 200x200, so the 16:9 box has a 200px floor - at a 320
// phone the card's inner width is 260, a pure 16:9 box would be 146px tall.
//
// The state machine, the message verdict and the stage are exported so a node-only test (apps/web has no DOM) can drive each of
// them; the wiring around them (taps, arrow keys, the live postMessage) is covered in a real browser by e2e/youtube-parts.shots.spec.ts.
import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import {
  YOUTUBE_EMBED_ORIGIN, isYoutubeUrl, mayEmbedReplay, youtubeEmbedUrl, youtubeThumbnailUrl, youtubeVideoId, type PublicReplayPart,
} from "@/lib/youtube";

/** `linkout`: the part may not be embedded (made for kids, or not known to be otherwise) - the card with one link. It is never entered
 *  from another mode: it is where a part STARTS, and no action leaves it. */
export type ReplayMode = "facade" | "playing" | "unavailable" | "linkout";
export interface ReplayState {
  /** Index (into the parts list) of the part showing. */
  active: number;
  /** One mode per part. At most one part is ever `playing`, and only the active one. */
  modes: ReplayMode[];
}
export type ReplayAction = { type: "play" } | { type: "unavailable" } | { type: "select"; index: number };

/** The player's `onError` codes that mean "this video cannot play HERE": 100 not found or private, 101 and 150 embedding disallowed
 *  by the owner, 153 the embed carried no identity. The others (2 bad parameter, 5 HTML5 error) are transient or ours, and are not
 *  a reason to give up the player. */
export const REPLAY_UNPLAYABLE_CODES: readonly number[] = [100, 101, 150, 153];

/** Every part starts as a facade - nothing plays until a tap - except a part that may not be embedded (made for kids: the link-out
 *  card) and a part with no provable video id (the link fallback). The made-for-kids rule comes first: a part that is both is the
 *  card, not the note that says it "can't be played here". */
export function initialReplayState(parts: readonly PublicReplayPart[]): ReplayState {
  return {
    active: 0,
    modes: parts.map((p): ReplayMode => (!mayEmbedReplay(p) ? "linkout" : youtubeVideoId(p.url) === null ? "unavailable" : "facade")),
  };
}

/** Where focus must go when the state changes, or null to leave it where the person put it. Two transitions of the ACTIVE part unmount
 *  the element that holds focus, and focus would drop to <body>: the tap turns the focused facade button into the player (focus goes
 *  to the player), and the player's own error turns the focused player into the fallback (focus goes to the "Open on YouTube" link -
 *  the one thing the person can do next; the note beside it is a status, announced as it appears). A CHANGE OF ACTIVE PART is neither:
 *  it is a tab choice, focus is on the tablist and stays there - even when the part chosen had already failed, so the stage's mode
 *  reads "playing > unavailable" without anything having failed just now. Anything else moves nothing. */
export function focusTarget(before: ReplayState, after: ReplayState): "player" | "open-link" | null {
  if (before.active !== after.active) return null;
  const was = before.modes[before.active];
  const now = after.modes[after.active];
  if (was === "facade" && now === "playing") return "player";
  if (was === "playing" && now === "unavailable") return "open-link";
  return null;
}

const withMode = (modes: ReplayMode[], at: number, mode: ReplayMode): ReplayMode[] => modes.map((m, i) => (i === at ? mode : m));

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "play":
      // Only a facade can start. An unavailable part cannot be revived by a tap, and a playing one is already playing.
      return state.modes[state.active] === "facade" ? { ...state, modes: withMode(state.modes, state.active, "playing") } : state;
    case "unavailable":
      // Only a PLAYING part can be told it failed: a stray message must not blank a facade.
      return state.modes[state.active] === "playing" ? { ...state, modes: withMode(state.modes, state.active, "unavailable") } : state;
    case "select": {
      const { index } = action;
      if (!Number.isInteger(index) || index < 0 || index >= state.modes.length) return state;
      // Choosing the part already showing must not stop it.
      if (index === state.active) return state;
      // Whatever played stops and becomes a facade again; a part that failed stays failed.
      return { active: index, modes: state.modes.map((m): ReplayMode => (m === "playing" ? "facade" : m)) };
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Does this `message` event say the player we mounted cannot play its video here? The origin must be the embed host and the sender
 *  (`source`, the event's own) must BE the iframe's window (`frameWindow`) - any other page can post to ours. A frame with no window
 *  (not mounted) has no sender, so two unknowns are never "the same window". The payload is the string the player posts
 *  (`{"event":"onError","info":150}`) or an already-parsed object; anything else is not an answer. */
export function playerReportsUnplayable(origin: string, source: unknown, frameWindow: unknown, data: unknown): boolean {
  if (origin !== YOUTUBE_EMBED_ORIGIN) return false;
  if (frameWindow === null || frameWindow === undefined || source !== frameWindow) return false;
  const msg = typeof data === "string" ? parseJson(data) : data;
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return false;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  return event === "onError" && typeof info === "number" && REPLAY_UNPLAYABLE_CODES.includes(info);
}

/** The line a stage ends with, in every mode: a plain text link to the part's own YouTube page. */
function OpenLink({ href, linkRef }: { href: string; linkRef?: RefObject<HTMLAnchorElement | null> }) {
  const t = useMsg();
  return (
    <a
      ref={linkRef}
      data-testid="replay-open"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center text-sm font-semibold text-court-ink underline decoration-white/50 underline-offset-4 hover:decoration-court-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink"
    >
      {t("streaming.youtube.replay.open")}
    </a>
  );
}

/** The made-for-kids replay: a card in the replay part's own frame - the same 16:9 box with the 200px floor, so choosing between a
 *  player part and a link part does not move the page - holding the reason in one line and ONE link to the video on YouTube. No iframe,
 *  no thumbnail, no second link, no YouTube artwork (the logo is only ever drawn by the two homes `youtube-icon.tsx` names). The link
 *  is the house pill (`public-stream-link`'s accent), 44px tall; its glyph says the link leaves the site and is decorative. */
function LinkOutCard({ part }: { part: PublicReplayPart }) {
  const t = useMsg();
  const whyId = useId();
  return (
    <div
      data-testid="replay-linkout"
      className="flex aspect-video min-h-[200px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-white/15 bg-white/5 p-4 text-center"
    >
      <p id={whyId} className="max-w-prose text-pretty text-sm text-court-ink">
        {t("streaming.youtube.replay.madeForKids")}
      </p>
      <a
        data-testid="replay-linkout-open"
        href={part.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={whyId}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink shadow-sm transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink"
      >
        {t("streaming.youtube.replay.watch")}
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3.5H3.5v9h9V10M9.5 3.5h3v3M12.5 3.5L7 9" />
        </svg>
      </a>
    </div>
  );
}

export interface ReplayStageProps {
  part: PublicReplayPart;
  mode: ReplayMode;
  /** Two or more parts: the player's title names the part. */
  multi: boolean;
  /** `window.location.origin`, passed to the player so it can post to us. Only read once the mode is `playing`. */
  pageOrigin: string;
  onPlay: () => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  onFrameLoad: () => void;
  /** The "Open on YouTube" link, so focus can be handed to it when the player gives up (`focusTarget`). */
  openRef?: RefObject<HTMLAnchorElement | null>;
}

/** Everything under the tab rail for one part: the 16:9 box (a facade, or the player) or the fallback note, then the link. */
export function ReplayStage({ part, mode, multi, pageOrigin, onPlay, iframeRef, onFrameLoad, openRef }: ReplayStageProps) {
  const t = useMsg();
  // A part that may not be embedded is the link-out card, whatever mode it was told it is in: the stage is what builds an iframe and a
  // thumbnail request, so it does not lean on the state having been right (the state's own rule is the same predicate).
  if (!mayEmbedReplay(part)) return <LinkOutCard part={part} />;
  const videoId = youtubeVideoId(part.url);
  // A part with no provable video id is never an iframe, whatever mode it was told it is in.
  const shown: ReplayMode = videoId === null ? "unavailable" : mode;
  return (
    <div>
      {shown === "unavailable" ? (
        <p
          data-testid="replay-unavailable"
          role="status"
          className="rounded-xl border border-white/15 bg-white/5 p-4 text-sm text-court-ink"
        >
          {t("streaming.youtube.replay.unavailable")}
        </p>
      ) : (
        <div data-testid="replay-box" className="relative aspect-video min-h-[200px] w-full overflow-hidden rounded-xl bg-black">
          {shown === "playing" ? (
            <iframe
              ref={iframeRef}
              src={youtubeEmbedUrl(videoId!, pageOrigin)}
              title={multi ? t("streaming.youtube.replay.playerTitlePart", { n: part.partNo }) : t("streaming.youtube.replay.playerTitle")}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={onFrameLoad}
              className="absolute inset-0 h-full w-full border-0"
            />
          ) : (
            <button
              type="button"
              data-testid="replay-facade"
              onClick={onPlay}
              className="group absolute inset-0 grid place-items-center focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
            >
              {/* The video's own picture, decorative: the button is named by its visible words. The 480x360 thumbnail is
                  letterboxed 16:9 - object-cover crops the bars. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- a remote thumbnail behind a click-to-play facade; the CSP names its host */}
              <img
                src={youtubeThumbnailUrl(videoId!)}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="absolute inset-0 h-full w-full object-cover"
              />
              <span className="relative flex flex-col items-center gap-2">
                <span aria-hidden className="grid h-16 w-16 place-items-center rounded-full bg-white/90 motion-safe:transition-transform motion-safe:group-hover:scale-105">
                  <svg viewBox="0 0 24 24" className="h-7 w-7 translate-x-0.5 fill-current text-court">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
                <span className="rounded-full bg-black/70 px-3 py-1 text-sm font-semibold text-white">{t("streaming.youtube.replay.play")}</span>
              </span>
            </button>
          )}
        </div>
      )}
      <OpenLink href={part.url} {...(openRef ? { linkRef: openRef } : {})} />
    </div>
  );
}

function ReplayPlayer({ parts }: { parts: readonly PublicReplayPart[] }) {
  const t = useMsg();
  const base = useId();
  const [state, dispatch] = useReducer(replayReducer, parts, initialReplayState);
  const [pageOrigin, setPageOrigin] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const openRef = useRef<HTMLAnchorElement | null>(null);
  const multi = parts.length > 1;
  const part = parts[state.active]!;
  const mode = state.modes[state.active]!;

  // Listen for the player's verdict only while a player is mounted.
  useEffect(() => {
    if (mode !== "playing") return;
    const onMessage = (e: MessageEvent) => {
      if (playerReportsUnplayable(e.origin, e.source, iframeRef.current?.contentWindow, e.data)) dispatch({ type: "unavailable" });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mode]);

  // Focus follows the stage. The tap that started the player unmounted the button that had focus: hand focus to the player the moment
  // it mounts - not only once its document has loaded, or focus sits on <body> for the whole load and a keyboard user is dropped to
  // the top of the page. The player's error unmounts the player the same way: focus goes to the "Open on YouTube" link. A tab choice moves
  // nothing (`focusTarget` looks at the ACTIVE part across the change, not at the mode on screen).
  const lastState = useRef<ReplayState>(state);
  useEffect(() => {
    const target = focusTarget(lastState.current, state);
    lastState.current = state;
    if (target === "player") iframeRef.current?.focus();
    else if (target === "open-link") openRef.current?.focus();
  }, [state]);

  const onPlay = () => {
    setPageOrigin(window.location.origin);
    dispatch({ type: "play" });
  };

  // The player speaks only to a page that has said it is listening. The handshake is the widget protocol the YouTube iframe API
  // itself uses, sent without loading that API's script.
  const onFrameLoad = () => {
    const frame = iframeRef.current;
    const win = frame?.contentWindow;
    if (!frame || !win) return;
    win.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), YOUTUBE_EMBED_ORIGIN);
    win.postMessage(JSON.stringify({ event: "command", func: "addEventListener", args: ["onError"], id: 1, channel: "widget" }), YOUTUBE_EMBED_ORIGIN);
    // And again once its document has loaded, in case the load reset what the mount set (the mount effect is the one that matters).
    frame.focus();
  };

  const tabId = (i: number) => `${base}-tab-${i}`;
  const panelId = `${base}-panel`;
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = parts.length - 1;
    const next =
      e.key === "ArrowRight" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    dispatch({ type: "select", index: next });
    document.getElementById(tabId(next))?.focus();
  };

  const stage = (
    <ReplayStage part={part} mode={mode} multi={multi} pageOrigin={pageOrigin} onPlay={onPlay} iframeRef={iframeRef} onFrameLoad={onFrameLoad} openRef={openRef} />
  );

  return (
    <section data-testid="replay-embed" aria-label={t("streaming.youtube.replay.region")} className="mt-4 border-t border-white/10 pt-4">
      {multi ? (
        <>
          <div role="tablist" aria-label={t("streaming.youtube.replay.tabs")} className="mb-3 flex flex-wrap gap-2">
            {parts.map((p, i) => {
              const selected = i === state.active;
              return (
                <button
                  key={p.partNo}
                  type="button"
                  role="tab"
                  id={tabId(i)}
                  aria-selected={selected}
                  aria-controls={selected ? panelId : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => dispatch({ type: "select", index: i })}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink ${
                    selected ? "bg-accent text-accent-ink" : "border border-white/25 text-court-ink hover:bg-white/10"
                  }`}
                >
                  {t("streaming.youtube.part", { n: p.partNo })}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(state.active)}>
            {stage}
          </div>
        </>
      ) : (
        stage
      )}
    </section>
  );
}

/** The replay inside the match card. Takes the parts the page decided to list (`replayPlan`) and re-checks each is a YouTube address:
 *  this component builds an iframe and a link from the address, so it does not lean on its caller having filtered. Nothing to show
 *  renders nothing. Keyed by the list, so a refreshed page with different parts starts clean rather than pointing at a stale index. */
export function ReplayEmbed({ parts }: { parts: readonly PublicReplayPart[] }) {
  const shown = parts.filter((p) => isYoutubeUrl(p.url));
  if (shown.length === 0) return null;
  return <ReplayPlayer key={shown.map((p) => p.url).join(" ")} parts={shown} />;
}
