"use client";
// R4 sponsors on stream, S7 — the sponsor card's face and the scene carousel (spec 2026-10-27 §3.4, §3.5).
//
// THE CARD is one component for both looks. The stage places it in the slot its template declares for the look
// (`OverlayTemplateDef.sponsorSlots`) and the card fills that slot: a lower third (a minor break, 8 s) reads as one row —
// logo, then name over the short link; a banner (a major break, 15 s, and every carousel showing) stacks them. House
// theme: the scorebug's own board and ink, and its 8 px LED rail on the leading edge. What it prints is data, never copy
// — the sponsor's name and, when the card carries a short code, `seazn.club/s/<code>` (owner ruling R7) — so it owes the
// dictionaries nothing.
//
// THE CAROUSEL rotates the TICKED cards on the compositor's Starting soon and Reconnecting scenes (the console adds Break
// and Full time): title first, then gold, then the rest in resolve order, `SCENE_CAROUSEL_MS` each, in the banner slot.
// It yields to any moment on air — one card at a time — and at `host=compositor` logs each showing as a proof-of-play
// pair with `source: "scene"`. Like the moment queue, every rule is a pure function here (`carouselStep`,
// `carouselLines`) and the component is a reducer, ONE `setTimeout` to the next deadline, and the console.
import { useEffect, useReducer, useRef } from "react";
import { COMPOSITOR_HOST, sponsorLine, type SponsorEndBody, type SponsorStartBody } from "@/lib/overlay-compositor";
import { sponsorShortLinkText } from "@/lib/sponsor-clicks";
import { SCENE_CAROUSEL_MS, type SponsorCard, type SponsorStyle } from "@/lib/sponsor-plan";
import { SPONSOR_TIERS } from "@/lib/sponsor-tiers";
import type { Phase } from "./moment-queue";
import type { SceneId } from "./overlay-scenes";

/** Spec §3.4: the scenes whose layer carries the carousel. The operator console (C4) adds Break and Full time. */
export const SPONSOR_CAROUSEL_SCENES: readonly SceneId[] = ["starting", "reconnecting"];

/** The look every carousel showing uses: a scene is a full-screen layer, so the bigger card (spec §3.2's banner). */
export const CAROUSEL_STYLE: SponsorStyle = "banner";

export function SponsorCardView(p: { card: SponsorCard; style: SponsorStyle; phase: Phase }) {
  const link = sponsorShortLinkText(p.card.shortCode);
  // A logo-less sponsor gets its name's first letter on the LED plate — never a broken-image box on a broadcast.
  const initial = (Array.from(p.card.name.trim())[0] ?? "").toUpperCase();
  return (
    <div
      data-testid="ovl-sponsor-card"
      data-style={p.style}
      data-phase={p.phase}
      data-tier={p.card.tier}
      className={`ovl-sponsor-card ovl-sponsor-card--${p.phase}`}
    >
      {p.card.logoUrl ? (
        // A sponsor's logo URL is any https host the organiser uploaded to; `next/image` would need each one declared
        // in `remotePatterns`. Decorative: the name beside it says who it is.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ovl-sponsor-logo" src={p.card.logoUrl} alt="" />
      ) : (
        <span className="ovl-sponsor-mono" aria-hidden="true">
          {initial}
        </span>
      )}
      <div className="ovl-sponsor-text">
        <span className="ovl-sponsor-name">{p.card.name}</span>
        {link !== null ? (
          <span data-testid="ovl-sponsor-link" className="ovl-sponsor-link">
            {link}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Spec §3.4: title first, then gold — the first two of `SPONSOR_TIERS` — then every other card, each group in the
 *  order given (resolve order). The rest is NOT re-ranked by tier. Never mutates its input. */
export function carouselOrder(cards: readonly SponsorCard[]): SponsorCard[] {
  const [first, second] = SPONSOR_TIERS;
  const rank = (c: SponsorCard) => (c.tier === first ? 0 : c.tier === second ? 1 : 2);
  // `Array.prototype.sort` is stable (ES2019), so equal ranks keep their resolve order.
  return [...cards].sort((a, b) => rank(a) - rank(b));
}

/** P5: `scene:<sceneId>:<floor(startedAtMs/10000)>` — P5's 10 000 is `SCENE_CAROUSEL_MS`, the showing's own length, so
 *  two showings (which start at least one showing apart, `carouselStep`) never share an id. */
export function carouselMomentId(scene: string, startedAtMs: number): string {
  return `scene:${scene}:${Math.floor(startedAtMs / SCENE_CAROUSEL_MS)}`;
}

export interface CarouselShowing {
  cardId: string;
  momentId: string;
  startedAt: number;
}
export interface CarouselState {
  /** Index, into the carousel order, of the next card to show. */
  next: number;
  /** No showing starts before this: the last one's start + `SCENE_CAROUSEL_MS`. Null before the first. */
  notBefore: number | null;
  showing: CarouselShowing | null;
  /** The last showing that ended, and whether it ran short — the end line's `cutShort`. */
  ended: { momentId: string; cutShort: boolean } | null;
}
export const CAROUSEL_INITIAL: CarouselState = { next: 0, notBefore: null, showing: null, ended: null };
export interface CarouselInput {
  now: number;
  /** The ticked cards' ids, in `carouselOrder`. */
  order: readonly string[];
  /** A moment is on air: the carousel steps aside. */
  yielding: boolean;
  scene: string;
}

/**
 * The carousel's one rule set. A showing ends at its start + `SCENE_CAROUSEL_MS` (cutShort false), or early — the
 * carousel yields, or its card leaves the ticked set — cut short. With nothing showing, not yielding and a card to show,
 * the next card in order starts, but never before `notBefore`: so a moment that leaves 3 s into a showing does not start
 * a second showing inside the first one's 10-second id. Returns `state` itself when nothing changes.
 */
export function carouselStep(state: CarouselState, input: CarouselInput): CarouselState {
  let s = state;
  const showing = s.showing;
  if (showing !== null) {
    const due = showing.startedAt + SCENE_CAROUSEL_MS;
    const cut = input.yielding || !input.order.includes(showing.cardId);
    if (cut || input.now >= due) {
      s = { ...s, showing: null, notBefore: due, ended: { momentId: showing.momentId, cutShort: input.now < due } };
    }
  }
  const ready = s.notBefore === null || input.now >= s.notBefore;
  if (s.showing === null && !input.yielding && input.order.length > 0 && ready) {
    const i = s.next % input.order.length;
    s = {
      ...s,
      next: i + 1,
      showing: { cardId: input.order[i]!, momentId: carouselMomentId(input.scene, input.now), startedAt: input.now },
    };
  }
  return s;
}

/** When the carousel next has something to do: the showing's end, else the earliest next start; null when idle. */
export function carouselDeadline(state: CarouselState): number | null {
  if (state.showing !== null) return state.showing.startedAt + SCENE_CAROUSEL_MS;
  return state.notBefore;
}

/** The carousel's proof-of-play lines for one committed state — `sponsorQueueLines`' twin. `onAir` is the showing whose
 *  start has been logged and whose end has not. */
export function carouselLines(
  onAir: string | null,
  state: CarouselState,
  at: string,
): { onAir: string | null; lines: string[] } {
  const lines: string[] = [];
  const showing = state.showing;
  let tracked = onAir;
  if (tracked !== null && tracked !== (showing?.momentId ?? null)) {
    // A showing that left without the reducer saying how ran short.
    const cutShort = state.ended?.momentId === tracked ? state.ended.cutShort : true;
    const end: SponsorEndBody = { momentId: tracked, at, cutShort };
    lines.push(sponsorLine("end", end));
    tracked = null;
  }
  if (tracked === null && showing !== null) {
    const start: SponsorStartBody = {
      momentId: showing.momentId,
      cardId: showing.cardId,
      style: CAROUSEL_STYLE,
      source: "scene",
      breakKind: null,
      at,
    };
    lines.push(sponsorLine("start", start));
    tracked = showing.momentId;
  }
  return { onAir: tracked, lines };
}

const reduce = (state: CarouselState, input: CarouselInput) => carouselStep(state, input);

/** The carousel's reducer and its ONE timer, armed to `carouselDeadline` (as `useMomentQueue`'s). A fresh card array
 *  arrives with every poll, so the effects key on `key` (the ids), never the array. */
function useCarousel(order: readonly string[], key: string, yielding: boolean, scene: string): CarouselState {
  const [state, dispatch] = useReducer(reduce, CAROUSEL_INITIAL);
  useEffect(() => {
    const now = Date.now();
    dispatch({ now, order, yielding, scene });
    // `order` is read from the closure and deliberately not a dependency — `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, yielding, scene]);
  const deadline = carouselDeadline(state);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => dispatch({ now: Date.now(), order, yielding, scene }), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline, key, yielding, scene]);
  return state;
}

export function SponsorCarousel(p: {
  cards: readonly SponsorCard[];
  scene: string;
  host: typeof COMPOSITOR_HOST | null;
  yielding: boolean;
}) {
  const ordered = carouselOrder(p.cards);
  const order = ordered.map((c) => c.id);
  const state = useCarousel(order, order.join(","), p.yielding, p.scene);

  // Proof of play at the compositor only. A mutable box the effects own: read and written only inside them.
  const logging = p.host === COMPOSITOR_HOST;
  const live = useRef<{ onAir: string | null }>({ onAir: null });
  useEffect(() => {
    if (!logging) return;
    const box = live.current;
    const step = carouselLines(box.onAir, state, new Date().toISOString());
    box.onAir = step.onAir;
    for (const line of step.lines) console.info(line);
  }, [logging, state]);
  // The scene leaves mid-showing (the carousel unmounts): that showing ran short.
  useEffect(() => {
    const box = live.current;
    return () => {
      if (box.onAir === null) return;
      const end: SponsorEndBody = { momentId: box.onAir, at: new Date().toISOString(), cutShort: true };
      console.info(sponsorLine("end", end));
      box.onAir = null;
    };
  }, []);

  if (p.yielding || state.showing === null) return null;
  const card = ordered.find((c) => c.id === state.showing!.cardId);
  if (card === undefined) return null;
  // Keyed on the showing, so each card mounts afresh and its fold-in runs.
  return <SponsorCardView key={state.showing.momentId} card={card} style={CAROUSEL_STYLE} phase="in" />;
}
