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

const APPROVED_PLAYER_NOTICE: Record<(typeof LOCALES)[number], string> = {
  en: "Your camera must stay on for the whole game. If it turns off, or you leave the frame, we record it for the organiser, who decides what happens. Nothing is decided automatically.",
  es: "Tu cámara debe permanecer encendida durante toda la partida. Si se apaga, o si te sales del encuadre, lo registramos para el organizador, que decide qué ocurre. Nada se decide automáticamente.",
  fr: "Votre caméra doit rester allumée pendant toute la partie. Si elle s'éteint, ou si vous sortez du cadre, nous l'enregistrons pour l'organisateur, qui décide de la suite. Rien n'est décidé automatiquement.",
  nl: "Je camera moet de hele partij aan blijven. Gaat hij uit, of ga je uit beeld, dan leggen we dat vast voor de organisator, die beslist wat er gebeurt. Er wordt niets automatisch beslist.",
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

  it("the time-control refusal names the catalogue through its {controls} slot in every locale", () => {
    for (const loc of LOCALES) {
      expect(DICTS[loc]["divset.err.timeControlUnsupported"], loc).toContain("{controls}");
    }
  });

  it("no camera sentence says the player is monitored, in any locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const camera = Object.entries(DICTS[loc]).filter(
        ([k]) => k.startsWith("divset.camera.") || k.startsWith("onlineChess.camera.") || k === "divset.err.cameraPolicyLocked",
      );
      for (const [k, text] of camera) {
        expect(text, `${loc} ${k}`).not.toMatch(MONITORED);
        checked += 1;
      }
    }
    // 4 locales × (label, help, playerNoticeLabel, save, saved, inherited,
    // needsOnlinePlay, 3 options, the lock error, the notice) = 4 × 12.
    expect(checked, "anti-vacuity: every camera sentence in every locale").toBe(48);
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
