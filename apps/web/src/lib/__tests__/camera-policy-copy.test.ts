// T6 — the camera copy is a consent statement, so its wording is a contract,
// not decoration. Three claims, all checked against the four shipped
// dictionaries:
//  - the player notice is the controller-approved sentence VERBATIM in each
//    locale (ruling Q3, 2026-10-09). The expected text is typed here from that
//    ruling — it is the authority — never read back from the dictionary.
//  - every camera key exists in every locale, and every declared policy has an
//    option label (swept from CAMERA_POLICIES, so a fourth policy reds here).
//  - none of it says the player is being monitored (spec §5.4: there is no
//    mandatory observer, D8 — "monitored" would be false inside a consent flow).
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { LOCALES } from "@/lib/i18n-constants";

const DICTS: Record<(typeof LOCALES)[number], Record<string, string>> = { en, es, fr, nl };

// Superseded 2026-10-11: the owner-approved match-room canvas (T14 design of
// record) words the notice "Keep your camera on for the whole game. If your
// video drops, we note when for your organiser, who decides what happens." —
// it also drops "or you leave the frame", which nothing detects (the server
// sees only whether a video publisher is live). en is typed from the canvas;
// es/fr/nl are T14's translations of it, pending the controller's sign-off.
const APPROVED_PLAYER_NOTICE: Record<(typeof LOCALES)[number], string> = {
  en: "Keep your camera on for the whole game. If your video drops, we note when for your organiser, who decides what happens.",
  es: "Mantén la cámara encendida toda la partida. Si tu vídeo se corta, anotamos cuándo para tu organizador, que decide qué pasa.",
  fr: "Gardez votre caméra allumée pendant toute la partie. Si votre vidéo se coupe, nous notons quand pour votre organisateur, qui décide de la suite.",
  nl: "Houd je camera de hele partij aan. Valt je video weg, dan noteren we wanneer voor je organisator, die beslist wat er gebeurt.",
};

// Fix round (controller, 2026-10-09): the option labels are SHORT — at 320px
// the long "Required — the camera must be live…" form clipped inside the
// select — and the explanation lives only in the help text under it. Typed
// from that ruling (en) and each locale's existing translation of the label
// before its " — " (es/fr/nl), never read back from the dictionary.
const SHORT_OPTION_LABEL: Record<(typeof LOCALES)[number], Record<(typeof CAMERA_POLICIES)[number], string>> = {
  en: { off: "Off", optional: "Optional", required: "Required" },
  es: { off: "Desactivada", optional: "Opcional", required: "Obligatoria" },
  fr: { off: "Désactivée", optional: "Facultative", required: "Obligatoire" },
  nl: { off: "Uit", optional: "Optioneel", required: "Verplicht" },
};

// "monitor" in each shipped language, plus the surveillance synonyms a
// translator would reach for.
const MONITORED = /monitor|surveil|vigil|bewaak|toezicht|observ/i;

describe("camera policy copy", () => {
  it("premise: the four shipped locales, and nothing else", () => {
    expect([...LOCALES].sort()).toEqual(["en", "es", "fr", "nl"]);
  });

  it("the player notice is the approved sentence, verbatim, in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      expect(DICTS[loc]["onlineChess.camera.playerNotice"], loc).toBe(APPROVED_PLAYER_NOTICE[loc]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every locale").toBe(4);
  });

  it("every camera key exists in every locale, with an option label for each declared policy", () => {
    const keys = [
      "divset.camera.label",
      "divset.camera.help",
      "divset.camera.playerNoticeLabel",
      "divset.camera.save",
      "divset.camera.saved",
      "divset.camera.inherited",
      "divset.camera.inheritOption",
      "divset.camera.inheritSummary",
      "divset.camera.inheritPending",
      "divset.camera.needsOnlinePlay",
      "divset.err.cameraPolicyLocked",
      "divset.err.timeControlUnsupported",
      "onlineChess.camera.playerNotice",
      ...CAMERA_POLICIES.map((p) => `divset.camera.${p}`),
    ];
    let checked = 0;
    for (const loc of LOCALES) {
      for (const key of keys) {
        const text = DICTS[loc][key];
        expect(typeof text === "string" && text.trim().length > 0, `${loc} ${key}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales × every key").toBe(4 * keys.length);
  });

  it("every option label is the SHORT one, in every locale — no explanation inside the select", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const p of CAMERA_POLICIES) {
        expect(DICTS[loc][`divset.camera.${p}`], `${loc} ${p}`).toBe(SHORT_OPTION_LABEL[loc][p]);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales × every declared policy").toBe(4 * CAMERA_POLICIES.length);
    expect(CAMERA_POLICIES.length, "premise: a policy vocabulary exists").toBeGreaterThan(0);
  });

  it("the explanation moved to the help text: it names every policy's short label, in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const p of CAMERA_POLICIES) {
        expect(DICTS[loc]["divset.camera.help"], `${loc} help explains ${p}`).toContain(SHORT_OPTION_LABEL[loc][p]);
        checked += 1;
      }
    }
    expect(checked).toBe(4 * CAMERA_POLICIES.length);
  });

  // Controller ruling (r3, 2026-10-09): the return-to-inherit OPTION is short
  // and carries no value — a select cannot wrap, and at 320px the value was
  // the part it hid. The value lives in the hint line under the select (which
  // can wrap), shown only while inherit is selected, and in the collapsed
  // summary. A select is never the only place a value is visible.
  it("the return-to-inherit option is short and carries NO value, in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      expect(DICTS[loc]["divset.camera.inheritOption"], loc).not.toMatch(/\{\w+\}/);
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(DICTS.en["divset.camera.inheritOption"]).toBe("Competition setting");
  });

  it("the hint under the select and the collapsed summary name the competition's value through one {policy} slot", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const key of ["divset.camera.inherited", "divset.camera.inheritSummary", "divset.camera.inheritPending"]) {
        expect(DICTS[loc][key]!.split("{policy}").length - 1, `${loc} ${key}: exactly one slot`).toBe(1);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
    // Review Minor 3: an UNSAVED "Competition setting" choice on a pinned
    // division is not "not set" yet — it gets its own sentence (controller
    // wording, en typed).
    expect(DICTS.en["divset.camera.inheritPending"]).toBe(
      "After saving, this division will use the competition's setting: {policy}.",
    );
    expect(DICTS.en["divset.camera.inherited"]).toBe(
      "Not set for this division — the competition's setting applies: {policy}. Saving a choice above sets it for this division.",
    );
  });

  it("the time-control refusal names the catalogue through its {controls} slot in every locale", () => {
    for (const loc of LOCALES) {
      expect(DICTS[loc]["divset.err.timeControlUnsupported"], loc).toContain("{controls}");
    }
  });

  it("no camera sentence says the player is monitored, in any locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const camera = Object.entries(DICTS[loc]).filter(
        ([k]) =>
          k.startsWith("divset.camera.") ||
          k.startsWith("onlineChess.camera.") ||
          k === "divset.err.cameraPolicyLocked" ||
          // T16: what registration states before signup.
          k.startsWith("register.camera.") ||
          k === "register.online.lichess",
      );
      for (const [k, text] of camera) {
        expect(text, `${loc} ${k}`).not.toMatch(MONITORED);
        checked += 1;
      }
    }
    // 4 locales × (label, help, playerNoticeLabel, save, saved, inherited,
    // inheritOption, inheritSummary, inheritPending, needsOnlinePlay,
    // 3 options, the lock error, the notice) = 4 × 15; plus registration's online line and its two camera
    // sentences (T16) = 4 × 18.
    expect(checked, "anti-vacuity: every camera sentence in every locale").toBe(72);
  });

  it("the online-play help no longer promises games played on Lichess (D3 deleted that mode)", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      expect(DICTS[loc]["divset.onlinePlay.help"], loc).not.toMatch(/run on Lichess|se juegan en Lichess|se jouent sur Lichess|op Lichess gespeeld/i);
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

// T14 fix round 5, ruling 1: job 5's camera_connection_problems flag is
// NEUTRAL — our safeguard's re-joins, told to the organiser, never an
// accusation. T16 renders it in the Flagged list; the en label is typed from
// the controller's ruling (2026-10-12), never read back from the dictionary.
describe("the camera_connection_problems flag's organiser label (fix round 5)", () => {
  const KEY = "externalPlay.flag.cameraConnectionProblems";
  it("en is the ruled label verbatim; every locale has its own, with ONE {duration} slot", () => {
    expect(DICTS.en[KEY]).toBe("Camera connection problems (our side) — {duration}");
    let checked = 0;
    for (const loc of LOCALES) {
      const v = DICTS[loc][KEY];
      expect(v, loc).toBeTruthy();
      expect(v!.match(/\{duration\}/g), `${loc}: one slot`).toHaveLength(1);
      if (loc !== "en") expect(v, `${loc} is not the English`).not.toBe(DICTS.en[KEY]);
      expect(v, `${loc}: neutral — never the camera-off wording`).not.toMatch(MONITORED);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every locale").toBe(4);
  });
});
