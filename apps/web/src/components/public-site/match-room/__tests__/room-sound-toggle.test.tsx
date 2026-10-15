// T17B fix 2, D19 (moved by D24): the speaker toggle — an icon button whose pressed state IS the switch (aria-pressed),
// named in the player's language, a 44px target, in every locale. D24 moved it out of the room header into the PLAYER'S
// OWN clock bar, beside their time (the opponent's bar never has one; neither does the result state's pair). The English
// is typed from the brief's intent ("move sounds"); the other three are checked to be translated, never copied.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { ClockBar, ClocksStrip } from "../clocks-strip";
import { RoomHeader } from "../room-header";
import { SoundToggle } from "../sound-toggle";

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
const WHO = { name: "Ada Okonkwo", colour: "black" as const, ms: 61_000 };
const ME = { name: "Bo Lind", colour: "white" as const, ms: 59_000 };
const switchOf = (on: boolean, onToggle: () => void = () => {}) => ({ on, onToggle });
/** The player's own bar as the room draws it: the toggle beside the time (null: no switch handed in). */
const paint = (l: (typeof LOCALES)[number], sound: { on: boolean; onToggle: () => void } | null) =>
  decode(
    renderToStaticMarkup(
      <ClockBar side="you" who={ME} turn="white" over={false} sound={sound ? <SoundToggle sound={sound} t={tOf(l) as never} /> : null} t={tOf(l) as never} />,
    ),
  );
const toggleTag = (html: string) => /<button[^>]*data-testid="room-sound"[^>]*>/.exec(html)?.[0] ?? null;

describe("the sound toggle in the player's own clock bar (D19, placed by D24)", () => {
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
        const tag = toggleTag(paint(l, switchOf(on)));
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
    const on = paint("en", switchOf(true));
    const off = paint("en", switchOf(false));
    expect(on).toContain('data-sound-icon="on"');
    expect(off).toContain('data-sound-icon="off"');
    expect(toggleTag(on)!.replace('aria-pressed="true"', "")).toBe(toggleTag(off)!.replace('aria-pressed="false"', ""));
  });

  it("a press calls the switch", () => {
    const onToggle = vi.fn();
    const tree = SoundToggle({ sound: switchOf(true, onToggle), t: tOf("en") as never });
    const buttons = [...new Set(walk(tree))].filter((el) => propsOf(el)["data-testid"] === "room-sound");
    expect(buttons).toHaveLength(1);
    (propsOf(buttons[0]!).onClick as () => void)();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("where the toggle is NOT (D24)", () => {
  const html = (node: React.ReactElement) => decode(renderToStaticMarkup(node));
  const t = tOf("en") as never;

  it("the room header no longer carries it, whatever else is on the page", () => {
    expect(toggleTag(html(<RoomHeader snap={SNAP} t={t} />))).toBeNull();
    expect(html(<RoomHeader snap={SNAP} t={t} />)).not.toContain("room-sound");
  });

  it("the OPPONENT's bar never has one — even handed the node, the bar draws it only on the player's own side", () => {
    const node = <SoundToggle sound={switchOf(true)} t={t} />;
    const opp = html(<ClockBar side="opponent" who={WHO} turn="white" over={false} sound={node} t={t} />);
    expect(toggleTag(opp), "the opponent's bar").toBeNull();
    // The pair: the same node on the player's bar is drawn.
    expect(toggleTag(html(<ClockBar side="you" who={ME} turn="white" over={false} sound={node} t={t} />))).not.toBeNull();
  });

  it("the result state's pair has none (D24 keeps that layout exactly as it was)", () => {
    expect(toggleTag(html(<ClocksStrip you={ME} opponent={WHO} turn="white" over t={t} />))).toBeNull();
  });

  it("in the player's bar the toggle sits BESIDE the time, before it, inside the bar", () => {
    const bar = paint("en", switchOf(true));
    const at = bar.indexOf('data-testid="room-sound"');
    const time = bar.indexOf("0:59");
    expect(at, "the toggle is in the bar").toBeGreaterThan(0);
    expect(time, "the time is in the bar").toBeGreaterThan(at);
    expect(bar.slice(0, at), "inside the player's bar, not before it").toContain('data-testid="room-clock-you"');
  });
});
