// Fix round 2b (controller ruling on flag 1): the check-in screen's privacy line, under the player's own camera
// preview, states what the room is CONFIGURED to do — never a guarantee. The player preset's max_video_streams = 0
// is a device limit, not a security boundary (camera-loader.ts), and the tampered-client probe (T17 part B) is still
// owed, so "never sees" / "only" is a claim a modified client could falsify. It also says who CAN watch — the
// organiser: arbiter.ts has no arbiter role, and `mayWatchBoards` admits the club's owner or admin — and that the
// video is not recorded (the RealtimeKit adapter starts no recording; the privacy policy says "We do not record").
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkin } from "../checkin";
import type { RoomSnapshot } from "../room-snapshot";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Locale = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>]),
) as Record<Locale, Record<string, string>>;

/** Typed from the ruling, not read from the dictionaries. */
const RULED = {
  en: "Ada's board is not set up to show your video. Your organiser can watch it live; it is not recorded.",
  es: "El tablero de Ada no está configurado para mostrar tu vídeo. Tu organizador puede verlo en directo; no se graba.",
  // "Côté {name}", not "L'échiquier de {name}": a template cannot elide "de" before a vowel ("de Ada").
  fr: "Côté Ada, l'échiquier n'est pas configuré pour afficher votre vidéo. Votre organisateur peut la regarder en direct ; elle n'est pas enregistrée.",
  nl: "Het bord van Ada is niet ingesteld om je video te tonen. Je organisator kan live meekijken; je video wordt niet opgenomen.",
} as const satisfies Record<Locale, string>;

/** The absolutes the old line made ("{name} never sees your video. Only your organiser can review it."), per locale. */
const ABSOLUTES = {
  en: ["never", "only", "cannot", "can't", "guarantee"],
  es: ["nunca", "solo", "sólo", "garantiza"],
  fr: ["jamais", "seul", "garanti"],
  nl: ["nooit", "alleen", "gegarandeerd"],
} as const satisfies Record<Locale, readonly string[]>;

const decode = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function paint(locale: Locale, cameraPolicy: RoomSnapshot["cameraPolicy"]): string {
  const dict = DICTS[locale];
  const t = (key: string, vars?: Record<string, string | number>) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (m, v: string) => (vars && v in vars ? String(vars[v]) : m));
  return renderToStaticMarkup(
    <Checkin
      snap={{
        you: { colour: "white", name: "Bo Lind", checkedIn: false },
        opponent: { colour: "black", name: "Ada Whitesworth-Longname", checkedIn: false },
        meta: { limitSeconds: 600, incrementSeconds: 5 } as RoomSnapshot["meta"],
        cameraPolicy,
      }}
      closesIn={null}
      closesAt={null}
      stream={null}
      cameraOn
      busy={false}
      onCheckIn={() => {}}
      t={t as never}
      plural={((k: string) => k) as never}
    />,
  );
}

/** The privacy line's own text: the element the screen marks as it, so no other sentence can satisfy it. */
function privacyLine(html: string): string | null {
  const m = /data-testid="room-checkin-privacy"[^>]*>([^<]*)</.exec(html);
  return m ? decode(m[1]!) : null;
}

describe("check-in privacy line — the configuration, never a guarantee (fix round 2b, flag 1)", () => {
  it("says, in each locale, what the opponent's board is set up to show, that the organiser can watch live, and that nothing is recorded — counted", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const policy of ["required", "optional"] as const) {
        expect(privacyLine(paint(locale, policy)), `${locale}/${policy}`).toBe(RULED[locale]);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * 2);
  });

  it("makes no absolute claim in any locale: no never, no only, no guarantee — counted", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const line = privacyLine(paint(locale, "required"))!.toLowerCase();
      for (const word of ABSOLUTES[locale]) {
        expect(line, `${locale}: "${word}"`).not.toMatch(new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u"));
        checked++;
      }
    }
    expect(checked).toBe(Object.values(ABSOLUTES).flat().length);
  });

  it("is not shown when the board runs without cameras (policy off): there is no video to describe", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const html = paint(locale, "off");
      expect(html, locale).toContain('data-testid="room-checkin"');
      expect(privacyLine(html), locale).toBeNull();
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});
