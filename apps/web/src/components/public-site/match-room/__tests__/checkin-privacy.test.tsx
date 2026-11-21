// Fix round 2b (controller ruling on flag 1): the check-in screen's privacy line, under the player's own camera
// preview, said what the room is CONFIGURED to do — never a guarantee. The player preset's max_video_streams = 0
// is a device limit, not a security boundary (camera-loader.ts), so "never sees" / "only" was a claim a modified
// client could falsify. D16 (design §5.6.7, "Copy") changed the ground under that ruling: each player is in a
// meeting of their OWN, so there is no opponent stream to subscribe to and the guarantee now holds on the vendor's
// side whatever the client does - once no shared meeting exists anywhere, which the deploy step
// (scripts/chess-end-shared-meetings.ts) and the V459 guard make true. The first sentence may therefore state it, and
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

// The division page's entry card (Fixtures tab) into Match Day. D16 review M2 once had to stop it promising BOTH cameras while the
// Arbiter panel showed one at a time; Match Day's board panel shows both players' cameras (receive-only, editors only), so the line says
// what the card leads to now, and must never again promise the one-at-a-time view that is gone. Ruled text, typed from the copy ruling
// (rounds, cameras, held boards), not read back from the dictionary.
const ENTRY_RULED = {
  en: "Open rounds, watch the cameras and decide held boards on Match Day.",
  es: "Abre rondas, mira las cámaras y resuelve los tableros retenidos en el Día de partidos.",
  fr: "Ouvrez les rondes, regardez les caméras et réglez les échiquiers en attente dans Jour de match.",
  nl: "Open rondes, bekijk de camera's en beslis over borden die wachten op een beslissing in de Wedstrijddag.",
} as const satisfies Record<Locale, string>;
/** The one-at-a-time promise the Arbiter panel's line made, per locale: gone with the panel, never to return on this card. */
const ONE_AT_A_TIME = { en: /one player's camera/i, es: /un jugador a la vez/i, fr: /un joueur à la fois/i, nl: /één speler tegelijk/i } as const;

describe("the division page's entry card says what Match Day does now (no one-camera-at-a-time promise)", () => {
  it("is the ruled line in every locale, and never promises the old one-at-a-time view - counted", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      expect(DICTS[locale]["arbiter.entry.body"], locale).toBe(ENTRY_RULED[locale]);
      expect(DICTS[locale]["arbiter.entry.body"], `${locale}: no one-at-a-time promise`).not.toMatch(ONE_AT_A_TIME[locale]);
      checked++;
    }
    expect(checked, "anti-vacuity: every locale").toBe(LOCALES.length);
    // The probe is not blind: the retired line trips it.
    expect("Watch one player's camera at a time and review each board's flags.").toMatch(ONE_AT_A_TIME.en);
  });

  // The line is drawn by `ArbiterEntryCard`; the division page only mounts that card. So the guard is two counted facts, in the two files
  // that carry it: the card draws the key exactly once, and the page mounts the card exactly once. Either one moving away reds this,
  // instead of the line vanishing silently.
  it("is the line the division page draws: the entry card draws the key once, and the page mounts the card once - counted from the sources", () => {
    const card = readFileSync(join(__dirname, "..", "..", "..", "v2", "arbiter-entry-card.tsx"), "utf8");
    expect(card.split('t(dict, "arbiter.entry.body")').length - 1, "the card draws the line").toBe(1);
    const page = readFileSync(join(__dirname, "..", "..", "..", "..", "app", "o", "[orgSlug]", "c", "[compSlug]", "d", "[divSlug]", "page.tsx"), "utf8");
    expect(page.split("<ArbiterEntryCard ").length - 1, "the division page mounts the card").toBe(1);
  });
});
