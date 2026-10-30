// The names Seazn gives its pooled stream keys, as the disconnect recognises them on a channel (fix: YouTube Disconnect left stream keys on
// the channel while telling the organiser everything was deleted, stg 2026-10-30, PO ruling the same day). The disconnect deletes every
// stream on the channel whose title is one of these and NOTHING else, so both directions are pinned: every name Seazn has ever given a key
// matches, and a club's own key never does.
//
// Expected values come from where the names come from, never from the matcher:
//   - the CURRENT names are the dictionaries' `streaming.youtube.streamKeyTitle`, rendered by `msgFor` exactly as growPool calls it
//     (prepare.ts: `msgFor(locale, "streaming.youtube.streamKeyTitle", { n })`, n = the pool slot 1..10);
//   - the two FORMER names are typed from git history: "Seazn stream key" is the `STREAM_TITLE` literal 79a208d8b0 removed from
//     prepare.ts (every key pooled before 2026-10-29 carries it - existing keys are never renamed), and "Seazn Club · clé de diffusión {n}"
//     is the fr template 79a208d8b0 shipped until a614ecf4fa (#1088) corrected "diffusión" to "diffusion".
// Sport: not applicable - a stream key's name is sport-agnostic.
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { isPooledKeyTitle } from "../pooled-key-title";

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const BEFORE_SLOTS = "Seazn stream key";
const FR_BEFORE_1088 = (n: number) => `Seazn Club · clé de diffusión ${n}`;

describe("isPooledKeyTitle: the names Seazn gives a pooled stream key", () => {
  it("every name growPool gives a key today matches - each locale, each of the ten pool slots, rendered as prepare.ts renders it (anti-vacuity: 4 x 10)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const n of SLOTS) {
        const title = msgFor(locale, "streaming.youtube.streamKeyTitle", { n });
        expect(title, `${locale}/${n}: premise - the dictionary rendered a name, not its key`).not.toContain("streamKeyTitle");
        expect(isPooledKeyTitle(title), `${locale}/${n}: ${title}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * SLOTS.length);
  });

  it("the names keys were given BEFORE today's still match: the old single name, and the fr name with the accent #1088 removed - beside today's fr name (both spellings)", () => {
    expect(isPooledKeyTitle(BEFORE_SLOTS)).toBe(true);
    let checked = 0;
    for (const n of SLOTS) {
      expect(FR_BEFORE_1088(n), "premise: the former fr spelling").toContain("diffusión");
      expect(isPooledKeyTitle(FR_BEFORE_1088(n)), FR_BEFORE_1088(n)).toBe(true);
      expect(isPooledKeyTitle(msgFor("fr", "streaming.youtube.streamKeyTitle", { n })), `today's fr ${n}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(SLOTS.length);
    expect(msgFor("fr", "streaming.youtube.streamKeyTitle", { n: 1 }), "premise: today's fr is the corrected spelling").toContain("diffusion");
  });

  it("a club's OWN key never matches - the negative paired with the positive above: other names, a Seazn name with something added or missing, another case, a number that is not digits (anti-vacuity: every one judged)", () => {
    const en = (n: number | string) => msgFor("en", "streaming.youtube.streamKeyTitle", { n });
    const theirs = [
      "TestYouTube", "Default stream key", "", " ", "stream key", "Seazn", "My Seazn stream key", "Seazn stream key 2", "Seazn stream keys",
      "seazn stream key", "SEAZN STREAM KEY", " Seazn stream key", "Seazn stream key ", "Seazn stream key\n",
      en("").trimEnd(), en("x"), en("1 (copy)"), `${en(1)}0x`, `Court 1 ${en(1)}`, en("-1"), en("1.5"), en(" 1"),
      msgFor("es", "streaming.youtube.streamKeyTitle", { n: "uno" }),
      "Seazn Club · clé de diffusión", "Seazn Club · clé de diffusión x",
    ];
    let checked = 0;
    for (const title of theirs) {
      expect(isPooledKeyTitle(title), JSON.stringify(title)).toBe(false);
      checked++;
    }
    expect(checked).toBe(theirs.length);
    // the pair: the same shapes with a real slot DO match, so the refusals above are about the shape, not about the names
    expect([en(1), en(10), en(123)].map(isPooledKeyTitle)).toEqual([true, true, true]);
  });

  it("a title that is not a string is never a Seazn name (the listing is YouTube's data, not ours)", () => {
    for (const v of [null, undefined, 1, {}, ["Seazn stream key"]] as unknown[]) expect(isPooledKeyTitle(v as string), String(v)).toBe(false);
  });
});
