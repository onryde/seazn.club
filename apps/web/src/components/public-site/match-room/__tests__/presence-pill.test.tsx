// T14 — the opponent presence pill (design §6, canvas "Ada · on camera"):
// compliance without a face. Players never see each other (D7).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PresencePill } from "../presence-pill";

// Vars rendered as key(name=value,…): no quotes, so React's text escaping
// cannot hide them.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

describe("PresencePill", () => {
  it("live: carries the live key, the live state and the opponent's FIRST name (canvas: 'Ada · on camera')", () => {
    const html = renderToStaticMarkup(<PresencePill name="Ada Okonkwo" cameraLive t={t} />);
    expect(html).toContain('data-testid="room-presence-pill"');
    expect(html).toContain('data-state="live"');
    expect(html).toContain('externalPlay.room.presence.live(name=Ada)');
    expect(html).not.toContain("externalPlay.room.presence.off");
  });

  it("off: carries the off key and the off state", () => {
    const html = renderToStaticMarkup(<PresencePill name="Bo Lind" cameraLive={false} t={t} />);
    expect(html).toContain('data-state="off"');
    expect(html).toContain('externalPlay.room.presence.off(name=Bo)');
    expect(html).not.toContain("externalPlay.room.presence.live");
  });

  it("never renders a video element for the opponent (D7 — players do not see each other)", () => {
    let checked = 0;
    for (const live of [true, false]) {
      const html = renderToStaticMarkup(<PresencePill name="Ada" cameraLive={live} t={t} />);
      expect(html, `live=${live}`).not.toContain("<video");
      expect(html, `live=${live}`).not.toContain("srcObject");
      checked += 1;
    }
    expect(checked, "anti-vacuity: both states").toBe(2);
  });

  it("a name with no space is used whole; a long one truncates on a min-w-0 chain", () => {
    const html = renderToStaticMarkup(<PresencePill name="Magnus" cameraLive t={t} />);
    expect(html).toContain('(name=Magnus)');
    expect(html).toMatch(/min-w-0/);
    expect(html).toMatch(/truncate/);
  });
});
