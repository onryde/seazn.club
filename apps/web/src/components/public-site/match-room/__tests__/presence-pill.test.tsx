// T14 — the opponent presence pill (design §6, canvas "Ada · on camera"):
// compliance without a face. Players never see each other (D7).
// D16 (§5.6.3): a third state, `unknown` - no fresh report from the opponent's own browser. Neither the green of live nor
// the colour of off, because "off" would claim a fact we do not have.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PresencePill } from "../presence-pill";

// Vars rendered as key(name=value,…): no quotes, so React's text escaping
// cannot hide them.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const STATES = ["live", "off", "unknown"] as const;
const DOT = (html: string) => /<span aria-hidden="true" class="([^"]*)"/.exec(html)?.[1] ?? "";

describe("PresencePill", () => {
  it("live: carries the live key, the live state and the opponent's FIRST name (canvas: 'Ada · on camera')", () => {
    const html = renderToStaticMarkup(<PresencePill name="Ada Okonkwo" state="live" t={t} />);
    expect(html).toContain('data-testid="room-presence-pill"');
    expect(html).toContain('data-state="live"');
    expect(html).toContain('externalPlay.room.presence.live(name=Ada)');
    expect(html).not.toContain("externalPlay.room.presence.off");
    expect(html).not.toContain("externalPlay.room.presence.unknown");
  });

  it("off: carries the off key and the off state", () => {
    const html = renderToStaticMarkup(<PresencePill name="Bo Lind" state="off" t={t} />);
    expect(html).toContain('data-state="off"');
    expect(html).toContain('externalPlay.room.presence.off(name=Bo)');
    expect(html).not.toContain("externalPlay.room.presence.live");
    expect(html).not.toContain("externalPlay.room.presence.unknown");
  });

  it("unknown: its own key, its own state, and a dot that is neither live's nor off's", () => {
    const html = renderToStaticMarkup(<PresencePill name="Cy Ng" state="unknown" t={t} />);
    expect(html).toContain('data-state="unknown"');
    expect(html).toContain('externalPlay.room.presence.unknown(name=Cy)');
    expect(html).not.toContain("externalPlay.room.presence.live");
    expect(html).not.toContain("externalPlay.room.presence.off");
    const dots = new Set(STATES.map((s) => DOT(renderToStaticMarkup(<PresencePill name="Ada" state={s} t={t} />))));
    expect(dots.size, "three states, three different dots").toBe(3);
  });

  it("never renders a video element for the opponent (D7 — players do not see each other)", () => {
    let checked = 0;
    for (const state of STATES) {
      const html = renderToStaticMarkup(<PresencePill name="Ada" state={state} t={t} />);
      expect(html, state).not.toContain("<video");
      expect(html, state).not.toContain("srcObject");
      checked += 1;
    }
    expect(checked, "anti-vacuity: every state").toBe(STATES.length);
  });

  it("a name with no space is used whole; on a phone the words WRAP (the state is the point of the pill), from md a long one truncates, all on a min-w-0 chain", () => {
    const html = renderToStaticMarkup(<PresencePill name="Magnus" state="live" t={t} />);
    expect(html).toContain('(name=Magnus)');
    expect(html).toMatch(/min-w-0/);
    // Anchored on a space before it: `max-md:truncate` would also contain "md:truncate", and a phone truncating is the defect.
    expect(html, "from md, truncation").toMatch(/\smd:truncate\b/);
    expect(html, "never on a phone: the words wrap").not.toMatch(/max-md:truncate/);
    expect(html, "a bare truncate (every width) would cut the state off on a phone").not.toMatch(/\struncate\b/);
    expect(html, "a single long word still breaks inside the pill").toContain("[overflow-wrap:anywhere]");
  });
});
