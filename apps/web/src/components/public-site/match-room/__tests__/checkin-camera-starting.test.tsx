// T17B fix 2 (D2): while the seat answers `camera_starting` the room re-asks, and the check-in's button waits and
// says why — in every locale — rather than offering a press that would only ask the same question again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkin } from "../checkin";
import type { RoomSnapshot } from "../room-snapshot";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const dict = (l: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function cta(locale: string, checkingCamera: boolean): { disabled: boolean; label: string } {
  const d = dict(locale);
  const t = (key: string, vars?: Record<string, string | number>) =>
    (d[key] ?? key).replace(/\{(\w+)\}/g, (m, v: string) => (vars && v in vars ? String(vars[v]) : m));
  const html = decode(
    renderToStaticMarkup(
      <Checkin
        snap={{
          you: { colour: "white", name: "Bo Lind", checkedIn: false },
          opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
          meta: { limitSeconds: 600, incrementSeconds: 5 } as RoomSnapshot["meta"],
          cameraPolicy: "required",
        }}
        closesIn="18:42"
        closesAt="19:20"
        stream={null}
        cameraOn
        busy={false}
        checkingCamera={checkingCamera}
        onCheckIn={() => {}}
        t={t as never}
        plural={((k: string) => k) as never}
      />,
    ),
  );
  const m = /<button[^>]*data-testid="room-checkin-cta"[^>]*>([^<]*)<\/button>/.exec(html);
  expect(m, "premise: the check-in button was painted").not.toBeNull();
  return { disabled: /<button[^>]*\sdisabled=""[^>]*data-testid="room-checkin-cta"/.test(html) || /data-testid="room-checkin-cta"[^>]*\sdisabled=""/.test(html), label: m![1]! };
}

describe("the check-in while the camera is starting (D2)", () => {
  it("waits, and says it is checking the camera — every locale, its own words; otherwise the ordinary Check in", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const d = dict(l);
      const starting = cta(l, true);
      expect(starting.disabled, `${l}: waits`).toBe(true);
      expect(starting.label, `${l}: says why`).toBe(d["externalPlay.room.checkin.cameraStarting"]);
      expect(starting.label.length, `${l}: translated`).toBeGreaterThan(0);
      const idle = cta(l, false);
      expect(idle.disabled, `${l}: idle is pressable`).toBe(false);
      expect(idle.label).toBe(d["externalPlay.room.checkin.cta"]);
      expect(idle.label, `${l}: two different labels`).not.toBe(starting.label);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});
