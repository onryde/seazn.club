// Seazn-hosted video Task 25: the organiser's list of a fixture's Seazn replays, in the fixture stream panel's ended card. Each part
// the replay move made, in part order, with its state in the organiser's words: "Getting the replay ready" (processing), "Ready on
// the match page" with its length (playable), or the failure sentence (failed). A part is labelled "Part {n}" only when there are two
// or more (the panel's YouTube replay rule: one part is just the replay). Nothing at all when there is none.
//
// The words are the dictionaries' (the first three are Task 26's keys, added here in all four locales); the states and the order are
// the read's (server/video/organiser-replays.ts). Static markup: the card is a pure function of its props.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { LOCALES } from "@/lib/i18n-constants";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";
import { SeaznReplaysCard, replayLength } from "../seazn-replays-card";

type Replay = StreamSessionCurrent["seaznReplays"][number];
const DICT_DIR = join(__dirname, "../../../dictionaries");
const uiDict = (locale: string): Record<string, string> => JSON.parse(readFileSync(join(DICT_DIR, locale, "ui.json"), "utf8"));
const en = uiDict("en");
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const r = (partNo: number, state: Replay["state"], lengthSeconds: number | null = null): Replay => ({ id: id(partNo), partNo, state, lengthSeconds });
const html = (replays: Replay[], locale = "en") =>
  renderToStaticMarkup(
    <DictProvider dict={uiDict(locale)} locale={locale as "en"}>
      <SeaznReplaysCard replays={replays} />
    </DictProvider>,
  );
/** Each row: [its state attribute, its text]. */
const rows = (out: string): [string, string][] =>
  [...out.matchAll(/<li data-testid="stream-seazn-replay" data-state="([^"]+)"[^>]*>(.*?)<\/li>/g)].map((m) => [m[1]!, m[2]!.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/^\||\|$/g, "")]);

describe("SeaznReplaysCard", () => {
  it("EMPTY CASE FIRST: no replay, no card at all; nor for a view from a server older than the field (no list)", () => {
    expect(html([])).toBe("");
    expect(renderToStaticMarkup(<SeaznReplaysCard replays={undefined} />)).toBe("");
  });

  it("one part: the title, no part label, its state in words (a playable one with its length)", () => {
    expect(rows(html([r(1, "playable", 125)]))).toEqual([["playable", `${en["stream.replay.seazn.ready"]}|2:05`]]);
    expect(rows(html([r(1, "processing")]))).toEqual([["processing", en["stream.replay.seazn.processing"]!]]);
    expect(rows(html([r(1, "failed")]))).toEqual([["failed", en["stream.replay.seazn.failed"]!]]);
    expect(html([r(1, "processing")])).toContain(`>${en["stream.replay.seazn.title"]}<`);
  });

  it("three parts, each labelled by its OWN number (a gap stays a gap) in part order, each in its own state", () => {
    const out = html([r(4, "failed"), r(1, "playable", 3_725), r(2, "processing")]);
    expect(rows(out)).toEqual([
      ["playable", `Part 1|${en["stream.replay.seazn.ready"]}|1:02:05`],
      ["processing", `Part 2|${en["stream.replay.seazn.processing"]}`],
      ["failed", `Part 4|${en["stream.replay.seazn.failed"]}`],
    ]);
  });

  it("a playable part with no length shows no length; a processing or failed part never shows one", () => {
    expect(rows(html([r(1, "playable")]))).toEqual([["playable", en["stream.replay.seazn.ready"]!]]);
    expect(rows(html([r(1, "processing", 90), r(2, "failed", 90)])).map(([, t]) => t)).toEqual([
      `Part 1|${en["stream.replay.seazn.processing"]}`, `Part 2|${en["stream.replay.seazn.failed"]}`,
    ]);
  });

  it("every locale has its own words: no raw key, and each locale's title and states are its dictionary's", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = uiDict(locale);
      const out = html([r(1, "playable", 60), r(2, "processing"), r(3, "failed")], locale);
      expect(out, locale).not.toContain("stream.replay.seazn");
      for (const key of ["title", "ready", "processing", "failed"]) {
        const want = d[`stream.replay.seazn.${key}`];
        expect(want, `${locale}: stream.replay.seazn.${key}`).toBeTruthy();
        expect(out, `${locale}: ${key}`).toContain(want!.replace(/'/g, "&#x27;"));
      }
      expect(out).toContain(d["stream.replay.seazn.part"]!.replace("{n}", "3"));
      checked++;
    }
    expect(checked, "anti-vacuity: every locale").toBe(LOCALES.length);
  });

  it("replayLength: m:ss under an hour, h:mm:ss from an hour, nothing for a length that is not one", () => {
    expect([replayLength(0), replayLength(59), replayLength(60), replayLength(125), replayLength(3_599), replayLength(3_600), replayLength(36_061)])
      .toEqual(["0:00", "0:59", "1:00", "2:05", "59:59", "1:00:00", "10:01:01"]);
    expect([replayLength(null), replayLength(-1), replayLength(Number.NaN), replayLength(1.5)]).toEqual([null, null, null, null]);
  });
});
