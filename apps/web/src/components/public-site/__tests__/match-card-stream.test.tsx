// Seazn-hosted video T47 (owner 2026-11-24, option A): the camera on a hub match card.
//
// What is held here, each with its twin so a probe that cannot see the thing cannot pass:
//   - a card with NO `stream` is byte-for-byte what it was before the camera existed (the golden is the OLD card's own markup, generated
//     from the commit before T47, for every arm of the status slot and the forfeit chip; the new code is never compared with itself);
//   - `live`: a red camera WITH the pulsing dot; `replay`: a slate camera with NO dot; the two are told apart by `data-stream`, the colour
//     and the dot, and the dot is red, never the green of the score "Live" dot (a live-bucket card carries BOTH, distinct);
//   - the words ("Live stream" / "Replay available", the real dictionary) are the icon's `title` AND the card's description: the card's
//     `aria-describedby` names the hidden span that carries them, and still names the forfeit sentence when there is one (the two together);
//   - reduced motion: the dot's pulse class is the one globals.css switches off under `prefers-reduced-motion`;
//   - the camera is not a link (the card is one), never on an expunged card, and the words exist in all four dictionaries;
//   - the field crosses the cached document's schema (the producer -> cache -> card seam), and an older document without it parses.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { HubMatch, type HubMatchT } from "@/server/public-site/competition-hub-schema";
import { MatchCard } from "../matches-hub/match-card";
import { SCENES, SCENE_NOW, hubMatch } from "./_match-card-scenes";
import golden from "./__golden__/match-card-nostream.json";

const dict = en as unknown as Dict;
const card = (m: HubMatchT, d: Dict = dict) => renderToStaticMarkup(<MatchCard match={m} dict={d} locale="en" now={SCENE_NOW} showDivision />);
const LIVE_WORDS = t(dict, "matchesHub.stream.live");
const REPLAY_WORDS = t(dict, "matchesHub.stream.replay");
const cameraOf = (html: string) => /<span data-testid="mh-match-stream"[\s\S]*?<\/svg>(?:<span data-testid="mh-match-stream-dot"[^>]*><\/span>)?<span id="[^"]*" class="sr-only">[^<]*<\/span><\/span>/.exec(html)?.[0] ?? null;
const describedBy = (html: string) => /<a [^>]*aria-describedby="([^"]*)"/.exec(html)?.[1] ?? null;

describe("MatchCard camera (T47)", () => {
  it("PREMISE: the words are what the owner asked for, in the real dictionary", () => {
    expect(LIVE_WORDS).toBe("Live stream");
    expect(REPLAY_WORDS).toBe("Replay available");
  });

  it("EMPTY CASE FIRST: a card with no stream is the OLD card's markup, byte for byte, in every status arm", () => {
    const names = Object.keys(SCENES);
    expect(names.length, "anti-vacuity: the scenes checked").toBe(6);
    expect(Object.keys(golden).sort(), "the golden holds exactly the scenes").toEqual([...names].sort());
    for (const name of names) {
      const html = card(SCENES[name]!);
      expect(html, `scene ${name}`).toBe((golden as Record<string, string>)[name]);
      expect(html).not.toContain("mh-match-stream");
    }
  });

  it("live: a red camera with the pulsing red dot, titled and described 'Live stream'", () => {
    const m = hubMatch({ stream: "live" });
    const html = card(m);
    const cam = cameraOf(html);
    expect(cam, "the camera is in the markup").not.toBeNull();
    expect(cam).toContain('data-stream="live"');
    expect(cam).toContain(`title="${LIVE_WORDS}"`);
    expect(cam).toContain("text-red-600");
    expect(cam).toContain('data-testid="mh-match-stream-dot"');
    expect(cam).toContain("bg-red-600");
    expect(cam).toContain("animate-stream-pulse");
    expect(cam).toContain(`class="sr-only">${LIVE_WORDS}</span>`);
    expect(cam, "decorative glyph: the words carry the meaning").toContain('aria-hidden="true"');
    expect(describedBy(html)).toBe(`mh-stream-${m.fixtureId}`);
    expect(html).toContain(`id="mh-stream-${m.fixtureId}"`);
  });

  // CI run 45537372073: the e2e clipping scan read `span 18px content in 16px` at every width. The dot hung 2px past the camera's own
  // 16px box (`-right-0.5` on a 6px dot), and a box whose content overruns it is clipped content to the scan (e2e/helpers.ts
  // `overflowingIn`), whatever paints. The dot now sits inside the camera's box: the box carries the 2px the dot used to overhang as
  // right padding, and the dot is anchored to `right-0` of it, so it sits on the icon exactly where it did.
  it("live: the dot sits INSIDE the camera's own box on the x axis (no negative right offset; the 2px it used to hang out is padding)", () => {
    const html = card(hubMatch({ stream: "live" }));
    const cam = cameraOf(html)!;
    const box = /^<span data-testid="mh-match-stream"[^>]*class="([^"]*)"/.exec(cam)?.[1];
    const dot = /<span data-testid="mh-match-stream-dot"[^>]*class="([^"]*)"/.exec(cam)?.[1];
    expect(box, "the camera's own classes").toBeDefined();
    expect(dot, "the dot's own classes").toBeDefined();
    expect(dot!.split(/\s+/), "anchored to the box's right edge, never past it").toContain("right-0");
    expect(dot!, "no negative right or left offset").not.toMatch(/(^|\s)-(right|left)-/);
    expect(box!.split(/\s+/), "the box holds the 2px the dot's old overhang took").toContain("pr-0.5");
    // Twin: the replay camera has no dot, so its box is the bare 16px icon (no padding to hold nothing).
    const replay = cameraOf(card(hubMatch({ stream: "replay" })))!;
    expect(/^<span data-testid="mh-match-stream"[^>]*class="([^"]*)"/.exec(replay)?.[1]).not.toContain("pr-0.5");
  });

  it("replay: a slate camera with NO dot, titled and described 'Replay available'", () => {
    const m = hubMatch({ stream: "replay" });
    const html = card(m);
    const cam = cameraOf(html);
    expect(cam).not.toBeNull();
    expect(cam).toContain('data-stream="replay"');
    expect(cam).toContain(`title="${REPLAY_WORDS}"`);
    expect(cam).toContain("text-slate-500");
    expect(cam).not.toContain("text-red-600");
    expect(cam).not.toContain("mh-match-stream-dot");
    expect(cam).not.toContain("animate-stream-pulse");
    expect(cam).toContain(`class="sr-only">${REPLAY_WORDS}</span>`);
    expect(describedBy(html)).toBe(`mh-stream-${m.fixtureId}`);
  });

  it("the camera sits in the top-right status slot, BESIDE the time, and is not a link of its own", () => {
    const html = card(hubMatch({ stream: "replay" }));
    const slot = /<span class="ml-auto flex shrink-0 items-center gap-1\.5">([\s\S]*?)<\/span><\/div><div class="mt-2 space-y-1">/.exec(html)?.[1];
    expect(slot, "the slot is the flex row").toBeDefined();
    expect(slot).toContain("mh-match-stream");
    const timeAt = slot!.search(/\d{2}:\d{2}/);
    expect(timeAt, "the kick-off time is in the same slot").toBeGreaterThan(-1);
    expect(slot!.indexOf("mh-match-stream"), "the camera precedes the time").toBeLessThan(timeAt);
    expect(cameraOf(html)).not.toContain("<a ");
    expect((html.match(/<a /g) ?? []).length, "the whole card stays ONE link").toBe(1);
  });

  it("a live-bucket card with a live stream carries BOTH dots: the score's green one and the camera's red one, distinct", () => {
    const html = card(hubMatch({ ...SCENES.live, stream: "live" }));
    expect(html).toContain('data-testid="mh-match-live"');
    expect(html).toContain("bg-emerald-500");
    expect(cameraOf(html)).toContain("bg-red-600");
    expect(cameraOf(html), "the camera never borrows the score dot's colour").not.toContain("emerald");
    expect(/<span data-testid="mh-match-live"[\s\S]*?<\/span><\/span>/.exec(html)?.[0], "the score dot is not red").not.toContain("red");
  });

  it("with a credited result, the description names BOTH the forfeit sentence and the camera, in that order", () => {
    const m = hubMatch({ ...SCENES.forfeit!, stream: "replay" });
    const ids = describedBy(card(m))?.split(" ");
    expect(ids).toEqual([`mh-forfeit-${m.fixtureId}`, `mh-stream-${m.fixtureId}`]);
    // Twin: the forfeit alone is what it was (the golden's arm), the camera alone is the camera's id alone.
    expect(describedBy(card(SCENES.forfeit!))).toBe(`mh-forfeit-${SCENES.forfeit!.fixtureId}`);
    // Every id the card names exists in the markup (a description that points at nothing is silent).
    const html = card(m);
    for (const id of ids!) expect(html, id).toContain(`id="${id}"`);
  });

  it("an expunged card (a withdrawal removed the match) shows no camera even if the document carries one", () => {
    const html = card(hubMatch({ ...SCENES.expunged!, stream: "live" }));
    expect(html).not.toContain("mh-match-stream");
    expect(html).toBe((golden as Record<string, string>).expunged);
  });

  it("reduced motion: the pulse class is the one globals.css switches off under prefers-reduced-motion", () => {
    const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.animate-stream-pulse\s*\{[^}]*animation:\s*stream-pulse/);
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
    expect(blocks.length, "anti-vacuity: reduced-motion blocks scanned").toBeGreaterThan(0);
    const resets = blocks.filter((b) => b.includes(".animate-stream-pulse"));
    expect(resets.length, "exactly one reduced-motion block resets the camera's pulse").toBe(1);
    expect(resets[0]).toMatch(/animation:\s*none/);
  });

  it("all four dictionaries carry both words, translated (not the English copy)", () => {
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const [loc, d] of Object.entries(dicts)) {
      for (const key of ["matchesHub.stream.live", "matchesHub.stream.replay"]) {
        expect(typeof d[key], `${loc} ${key}`).toBe("string");
        expect(d[key]!.length, `${loc} ${key}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(8);
    for (const loc of ["es", "fr"]) {
      expect(dicts[loc]!["matchesHub.stream.live"], loc).not.toBe(en["matchesHub.stream.live"]);
      expect(dicts[loc]!["matchesHub.stream.replay"], loc).not.toBe(en["matchesHub.stream.replay"]);
    }
    // The card speaks the dictionary it is given: the Spanish card says it in Spanish.
    const html = card(hubMatch({ stream: "live" }), es as unknown as Dict);
    expect(html).toContain(`title="${es["matchesHub.stream.live"]}"`);
  });

  it("the field crosses the cached document's schema; an older document without it parses and reads as no camera", () => {
    for (const stream of ["live", "replay"] as const) expect(HubMatch.parse(hubMatch({ stream })).stream).toBe(stream);
    expect(HubMatch.parse(hubMatch()).stream).toBeUndefined();
    expect(HubMatch.safeParse(hubMatch({ stream: "https://cdn.example/x" as never })).success, "an address is not a value of the enum").toBe(false);
  });
});
