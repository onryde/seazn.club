// T17B fix 2, D19: the speaker toggle in the room header — an icon button whose pressed state IS the switch
// (aria-pressed), named in the player's language, a 44px target, in every locale. The English is typed from the
// brief's intent ("move sounds"); the other three are checked to be translated, never copied.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { RoomHeader } from "../room-header";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8"))]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;
const KEY = "externalPlay.room.sound.label";
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const SNAP = {
  meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
  links: { fixture: "/fx", standings: "/st" },
} as Parameters<typeof RoomHeader>[0]["snap"];
const tOf = (l: (typeof LOCALES)[number]) => (key: string, vars?: Record<string, string | number>) =>
  (DICTS[l][key] ?? key).replace(/\{(\w+)\}/g, (m, v: string) => (vars && v in vars ? String(vars[v]) : m));
const paint = (l: (typeof LOCALES)[number], sound: { on: boolean; onToggle: () => void } | null) =>
  decode(renderToStaticMarkup(<RoomHeader snap={SNAP} t={tOf(l) as never} sound={sound} />));
const toggleTag = (html: string) => /<button[^>]*data-testid="room-sound"[^>]*>/.exec(html)?.[0] ?? null;

describe("the room header's sound toggle (D19)", () => {
  it("the empty case first: no switch handed in, no toggle drawn", () => {
    expect(toggleTag(paint("en", null))).toBeNull();
  });

  it("pressed = sounds on; not pressed = off; named in every locale, translated, a 44px target (counted)", () => {
    expect(DICTS.en[KEY]).toBe("Move sounds");
    let checked = 0;
    for (const l of LOCALES) {
      const label = DICTS[l][KEY];
      expect(typeof label === "string" && label.length > 0, l).toBe(true);
      if (l !== "en") expect(label, `${l}: translated`).not.toBe(DICTS.en[KEY]);
      for (const on of [true, false]) {
        const tag = toggleTag(paint(l, { on, onToggle: () => {} }));
        expect(tag, `${l} ${on}`).not.toBeNull();
        expect(tag, `${l} ${on}`).toContain(`aria-pressed="${on}"`);
        expect(tag, `${l} ${on}`).toContain(`aria-label="${label}"`);
        expect(tag, `${l} ${on}`).toContain('type="button"');
        expect(tag, `${l} ${on}: 44px`).toMatch(/\bh-11\b/);
        expect(tag, `${l} ${on}: 44px`).toMatch(/\bw-11\b/);
        checked += 1;
      }
    }
    expect(checked).toBe(LOCALES.length * 2);
  });

  it("the two states draw different icons in the same box — a slash for off, waves for on", () => {
    const on = paint("en", { on: true, onToggle: () => {} });
    const off = paint("en", { on: false, onToggle: () => {} });
    expect(on).toContain('data-sound-icon="on"');
    expect(off).toContain('data-sound-icon="off"');
    expect(toggleTag(on)!.replace('aria-pressed="true"', "")).toBe(toggleTag(off)!.replace('aria-pressed="false"', ""));
  });

  it("a press calls the switch", () => {
    const onToggle = vi.fn();
    const tree = RoomHeader({ snap: SNAP, t: tOf("en") as never, sound: { on: true, onToggle } });
    const buttons = [...new Set(walk(tree))].filter((el) => propsOf(el)["data-testid"] === "room-sound");
    expect(buttons).toHaveLength(1);
    (propsOf(buttons[0]!).onClick as () => void)();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
