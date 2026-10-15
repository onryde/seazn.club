// Fix round 2b (controller ruling on flag 1): the check-in screen's privacy line, under the player's own camera
// preview, said what the room is CONFIGURED to do — never a guarantee. The player preset's max_video_streams = 0
// is a device limit, not a security boundary (camera-loader.ts), so "never sees" / "only" was a claim a modified
// client could falsify. D16 (design §5.6.7, "Copy") changed the ground under that ruling: each player is in a
// meeting of their OWN, so there is no opponent stream to subscribe to and the guarantee now holds on the vendor's
// side whatever the client does - once no shared meeting exists anywhere, which the deploy step
// (scripts/chess-end-shared-meetings.ts) and the V448 guard make true. The first sentence may therefore state it, and
// it is the ONE sentence the absolutes check below excepts. It also says who CAN watch — the organiser:
// `mayWatchBoards` admits the club's owner or admin — and that the video is not recorded (the RealtimeKit adapter
// starts no recording; the privacy policy says "We do not record").
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

/** Typed from the ruling (design §5.6.7: "Your opponent can't see your camera." replaces the hedged first sentence;
 *  the second sentence stays), not read from the dictionaries. T17B fix 2 (D5): the line names nobody. */
const RULED = {
  en: "Your opponent can't see your camera. Your organiser can watch it live; it isn't recorded.",
  es: "Tu rival no puede ver tu cámara. Tu organizador puede verla en directo; no se graba.",
  fr: "Votre adversaire ne peut pas voir votre caméra. Votre organisateur peut la regarder en direct ; elle n'est pas enregistrée.",
  nl: "Je tegenstander kan je camera niet zien. Je organisator kan live meekijken; je beeld wordt niet opgenomen.",
} as const satisfies Record<Locale, string>;

/** The ONE sentence per locale that states the guarantee (§5.6.7). The absolutes check refuses every absolute in the
 *  rest of a line and cites this section for this sentence alone. */
const GUARANTEE = {
  en: "Your opponent can't see your camera.",
  es: "Tu rival no puede ver tu cámara.",
  fr: "Votre adversaire ne peut pas voir votre caméra.",
  nl: "Je tegenstander kan je camera niet zien.",
} as const satisfies Record<Locale, string>;
/** The arbiter's watch-only line says the same thing about the players (§5.6.7: "The arbiter's watch-only line and the
 *  privacy page say the same thing"): its second sentence is the guarantee. */
const ARBITER_GUARANTEE = {
  en: "Players can't see or hear you, and can't see each other.",
  es: "Los jugadores no pueden verte ni oírte, ni verse entre sí.",
  fr: "Les joueurs ne peuvent ni vous voir ni vous entendre, ni se voir entre eux.",
  nl: "Spelers kunnen je niet zien of horen, en elkaar niet zien.",
} as const satisfies Record<Locale, string>;
/** The line with its excepted sentence taken out - and the proof it was in there to take out. */
function withoutSentence(line: string, sentence: string): string {
  expect(line, "the excepted sentence is in the line").toContain(sentence);
  return line.replace(sentence, "");
}

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
  it("says, in each locale, that the opponent cannot see the camera, that the organiser can watch live, and that nothing is recorded — counted", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const policy of ["required", "optional"] as const) {
        const line = privacyLine(paint(locale, policy));
        expect(line, `${locale}/${policy}`).toBe(RULED[locale]);
        // It names nobody: neither of the opponent's names, nor the player's own.
        for (const name of ["Ada", "Whitesworth", "Bo", "Lind"]) expect(line, `${locale}: no "${name}"`).not.toMatch(new RegExp(`\\b${name}\\b`));
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * 2);
  });

  it("makes no absolute claim in any locale beyond the one ruled sentence (§5.6.7): no never, no only, no guarantee in the rest — counted", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const line = withoutSentence(privacyLine(paint(locale, "required"))!, GUARANTEE[locale]).toLowerCase();
      expect(line, `${locale}: the exception removed exactly the guarantee`).not.toContain(GUARANTEE[locale].toLowerCase());
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

// T17B fix 2 (controller ruling, folded into D4): the arbiter's watch-only line made the same kind of promise — "they
// never see each other" — that nothing proved, so it was hedged to what the rooms are SET UP to do. D16 (§5.6.7) makes
// it true: a meeting per player means no player is in a room with the other, and the arbiter publishes nothing. The line
// now says it, and says what the pane is (ONE player's camera at a time, with the switch).
const ARBITER_RULED = {
  en: "You're watching one player's camera at a time. Players can't see or hear you, and can't see each other.",
  es: "Estás viendo la cámara de un jugador a la vez. Los jugadores no pueden verte ni oírte, ni verse entre sí.",
  fr: "Vous regardez la caméra d'un joueur à la fois. Les joueurs ne peuvent ni vous voir ni vous entendre, ni se voir entre eux.",
  nl: "Je bekijkt de camera van één speler tegelijk. Spelers kunnen je niet zien of horen, en elkaar niet zien.",
} as const satisfies Record<Locale, string>;

describe("the arbiter's watch-only line — the same rule as the check-in's (T17B fix 2)", () => {
  it("says, in each locale, what the pane is and that the players cannot see or hear the arbiter or each other — and makes no other absolute claim: no never, no only, no guarantee — counted", () => {
    let lines = 0;
    let words = 0;
    for (const locale of LOCALES) {
      const line = DICTS[locale]["arbiter.watchOnly"];
      expect(line, locale).toBe(ARBITER_RULED[locale]);
      const rest = withoutSentence(line!, ARBITER_GUARANTEE[locale]);
      for (const word of ABSOLUTES[locale]) {
        expect(rest.toLowerCase(), `${locale}: "${word}"`).not.toMatch(new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u"));
        words++;
      }
      lines++;
    }
    expect(lines).toBe(LOCALES.length);
    expect(words).toBe(Object.values(ABSOLUTES).flat().length);
  });

  it("is the line the panel draws, in its header and in its body — counted from the panel's source", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "v2", "arbiter-panel.tsx"), "utf8");
    expect(src.split('f.t("arbiter.watchOnly")').length - 1, "header (desktop) and body (below lg)").toBe(2);
  });
});
