// T14 — the clocks strip (canvas: opponent left on lavender, You right; the
// side to move is the dark card; game over mutes both).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClocksStrip } from "../clocks-strip";

// Vars rendered as key(name=value,…): no quotes, so React's text escaping
// cannot hide them.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;
const you = { name: "Bo Lind", colour: "white" as const, ms: 497_000 };
const opponent = { name: "Ada Okonkwo", colour: "black" as const, ms: 582_000 };

describe("ClocksStrip", () => {
  it("renders the opponent by NAME and you as You, both clocks (canvas 9:42 / 8:17), and whose move", () => {
    const html = renderToStaticMarkup(<ClocksStrip you={you} opponent={opponent} turn="white" over={false} t={t} />);
    expect(html).toContain("Ada Okonkwo");
    expect(html).toContain("externalPlay.room.you");
    expect(html).toContain("9:42");
    expect(html).toContain("8:17");
    expect(html).toContain('data-turn="white"');
    expect(html).toMatch(/data-testid="room-clock-you"[^>]*data-active="true"/);
    expect(html).toMatch(/data-testid="room-clock-opponent"[^>]*data-active="false"/);
    expect(html).toContain("externalPlay.room.yourMove");
  });

  it("the opponent to move: their card is the active one and yours just names your colour", () => {
    const html = renderToStaticMarkup(<ClocksStrip you={you} opponent={opponent} turn="black" over={false} t={t} />);
    expect(html).toMatch(/data-testid="room-clock-opponent"[^>]*data-active="true"/);
    expect(html).toMatch(/data-testid="room-clock-you"[^>]*data-active="false"/);
    expect(html).not.toContain("externalPlay.room.yourMove");
    expect(html).toContain("externalPlay.room.colour.white");
  });

  it("game over: neither card is active, and BOTH faces are muted (canvas GameOver); live faces are not", () => {
    const html = renderToStaticMarkup(<ClocksStrip you={you} opponent={opponent} turn="white" over t={t} />);
    expect(html).not.toContain('data-active="true"');
    const mutedFaces = (h: string) => [...h.matchAll(/<span class="font-display[^"]*text-\[#6b5b8a\]/g)].length;
    expect(mutedFaces(html)).toBe(2);
    const live = renderToStaticMarkup(<ClocksStrip you={you} opponent={opponent} turn="white" over={false} t={t} />);
    expect(mutedFaces(live)).toBe(0);
  });

  it("time trouble shows tenths, and zero is 0:00.0 (clock-math's face)", () => {
    const html = renderToStaticMarkup(
      <ClocksStrip you={{ ...you, ms: 7_400 }} opponent={{ ...opponent, ms: 0 }} turn="white" over={false} t={t} />,
    );
    expect(html).toContain("0:07.4");
    expect(html).toContain("0:00.0");
  });

  it("renders the NAME it is given and never re-derives one; a long name truncates on a min-w-0 chain", () => {
    const html = renderToStaticMarkup(
      <ClocksStrip you={you} opponent={{ ...opponent, name: "Entry 4" }} turn="white" over={false} t={t} />,
    );
    expect(html).toContain("Entry 4");
    expect(html).toMatch(/min-w-0/);
    expect(html).toMatch(/truncate/);
  });
});
