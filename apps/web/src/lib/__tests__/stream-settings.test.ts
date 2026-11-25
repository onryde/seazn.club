// R2006 (owner ruling 2026-10-19, "Option C"): the stored stream preferences as rules — lib/stream-settings.ts.
//
// Expected values come from the RULING and the registry's own declarations, never from the code under test:
//  - "Score is the DEFAULT … 'Camera only' is a small secondary link … When composed is unavailable, Go live streams
//    camera only … the organiser is never blocked." So only an explicit `passthrough` turns the score off, and an
//    unavailable compositor turns it off too.
//  - The template refusal is "an id the sport's picker does not offer" — the registry's own `retired` and `sports`.
import { describe, expect, it } from "vitest";
import { defaultTemplateFor, type OverlayTemplateDef, type TemplateRegistry } from "@/components/overlay/template-registry";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import { CreateStreamSession, PutStreamSettings, StreamMode } from "@/server/api-v1/schemas";
import { forEachSport } from "@seazn/engine/testkit";
import { COURT_PHONE_OVERLAY_DELAY_MS, RELAY_OVERLAY_DELAY_DEFAULT_MS, overlayDelayDefaultMs } from "@/server/relay/config";
import { PutOrgStreamDefaults } from "@/server/api-v1/schemas";
import {
  OVERLAY_DELAY_MAX_MS, effectiveDelayMs, effectiveStreamMode, effectiveTemplateId, isKnownTemplate, isPickableTemplate,
} from "@/lib/stream-settings";

describe("effectiveStreamMode — the score is the default; only Camera only or an unavailable compositor turns it off", () => {
  it("every stored value (each StreamMode option and never-chosen null) × composed available or not", () => {
    // The ruling, as a table keyed on the stored choice: what the organiser chose, and what the deployment can run.
    const ruling = (stored: string | null, available: boolean): string =>
      stored === "passthrough" ? "passthrough" : available ? "composed" : "passthrough";
    const storedValues: (StreamMode | null)[] = [null, ...StreamMode.options];
    let checked = 0;
    for (const stored of storedValues) {
      for (const available of [true, false]) {
        expect(effectiveStreamMode(stored, available), `stored ${stored} × available ${available}`).toBe(ruling(stored, available));
        checked++;
      }
    }
    console.log(`stream mode cells checked: ${checked}`);
    expect(checked).toBe(storedValues.length * 2);
    expect(checked).toBeGreaterThan(0);
  });

  it("the default differs from both constants: never-chosen streams the score when available and the camera when not", () => {
    // A case where the right answer differs from either wrong constant (AGENTS.md class 19).
    expect(effectiveStreamMode(null, true)).toBe("composed");
    expect(effectiveStreamMode(null, false)).toBe("passthrough");
  });
});

describe("isPickableTemplate — the write's refusal rule, over an injected registry", () => {
  const stub = (id: string, extra: Partial<OverlayTemplateDef<string>> = {}): OverlayTemplateDef<string> =>
    ({ id, labelKey: `stream.tab.${id}`, sports: "all", component: () => null, slabPlacement: "bar",
       sceneCardSafeArea: { x: 0, y: 0, width: 1, height: 1 }, ...extra }) as unknown as OverlayTemplateDef<string>;
  const registry: TemplateRegistry<string> = {
    open: stub("open"),
    old: stub("old", { retired: { replacedBy: "open" } }),
    shuttle: stub("shuttle", { sports: ["badminton"] }),
  };

  it("a retired id is refused; a sport-restricted id is offered to its sport alone; an unknown id is refused", () => {
    expect(isPickableTemplate("old", "badminton", registry), "retired").toBe(false);
    expect(isPickableTemplate("shuttle", "cricket", registry), "restricted, another sport").toBe(false);
    expect(isPickableTemplate("shuttle", "badminton", registry), "restricted, its own sport").toBe(true);
    expect(isPickableTemplate("open", "cricket", registry), "open to all").toBe(true);
    expect(isPickableTemplate("nope", "badminton", registry), "unknown").toBe(false);
  });

  it("every overlay sport's own default is pickable on the shipped registry", () => {
    let checked = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      expect(isPickableTemplate(defaultTemplateFor(sport), sport), sport).toBe(true);
      checked++;
    }
    console.log(`sports checked: ${checked}`);
    expect(checked).toBe(OVERLAY_SPORT_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("OVERLAY_DELAY_MAX_MS — the panel's bound is the write schema's bound (V462's check)", () => {
  it("0 and the max parse; one past either end is refused", () => {
    expect(PutStreamSettings.safeParse({ overlayDelayMs: 0 }).success).toBe(true);
    expect(PutStreamSettings.safeParse({ overlayDelayMs: OVERLAY_DELAY_MAX_MS }).success).toBe(true);
    expect(PutStreamSettings.safeParse({ overlayDelayMs: OVERLAY_DELAY_MAX_MS + 1 }).success).toBe(false);
    expect(PutStreamSettings.safeParse({ overlayDelayMs: -1 }).success).toBe(false);
    expect(PutStreamSettings.safeParse({ overlayDelayMs: 2500.5 }).success, "whole milliseconds only").toBe(false);
  });

  it("PR #989 review m2: Go live's own overlayDelayMs takes the SAME bound — 0, the max and null (the default) parse, absent too; one past either end and a fraction are refused", () => {
    const create = (over: Record<string, unknown>) =>
      CreateStreamSession.safeParse({ mode: "composed", targetId: "00000000-0000-4000-8000-000000000001", ...over }).success;
    const rows: [unknown, boolean][] = [
      [0, true], [OVERLAY_DELAY_MAX_MS, true], [null, true], [undefined, true],
      [OVERLAY_DELAY_MAX_MS + 1, false], [-1, false], [2500.5, false], ["2500", false],
    ];
    let checked = 0;
    for (const [overlayDelayMs, ok] of rows) {
      expect(create(overlayDelayMs === undefined ? {} : { overlayDelayMs }), String(overlayDelayMs)).toBe(ok);
      expect(PutStreamSettings.safeParse({ overlayDelayMs }).success, `the write agrees: ${String(overlayDelayMs)}`).toBe(overlayDelayMs === undefined ? false : ok);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 38: the club's default style and timing. The expectations are the OWNER's chain (ledger 454, 504): the match's own
// choice, then the club's, then the default; and the court rule — the club's STYLE reaches courts, its TIMING does not.
// ---------------------------------------------------------------------------------------------------------------------
describe("effectiveTemplateId — match ?? club ?? the sport's default, for EVERY sport", () => {
  it("each link of the chain on every engine sport, and the sport default differs from the club's choice (not a constant)", () => {
    let sports = 0;
    let cells = 0;
    forEachSport(({ module: m }) => {
      const own = defaultTemplateFor(m.key);
      // A club style that is NOT this sport's own default, so the right answer differs from the fall-through.
      const other = own === "bar" ? "bug" : "bar";
      expect(effectiveTemplateId({ match: null, club: null, sportKey: m.key }), `${m.key}: neither set`).toBe(own);
      expect(effectiveTemplateId({ match: null, club: other, sportKey: m.key }), `${m.key}: the club's`).toBe(other);
      expect(effectiveTemplateId({ match: own, club: other, sportKey: m.key }), `${m.key}: the match's own wins over the club's`).toBe(own);
      expect(effectiveTemplateId({ match: other, club: own, sportKey: m.key }), `${m.key}: the match's own, the other way round`).toBe(other);
      expect(effectiveTemplateId({ match: null, club: "retired-or-unknown", sportKey: m.key }), `${m.key}: an id the registry lost reads as the sport's default`).toBe(own);
      sports++;
      cells += 5;
    });
    console.log(`club style: sports ${sports}, cells ${cells}`);
    expect(sports, "anti-vacuity: the engine's sports").toBeGreaterThan(0);
    expect(cells).toBe(sports * 5);
  });
});

describe("effectiveDelayMs — match ?? club ?? default, and a COURT ignores the club's timing (owner, 2026-11-24)", () => {
  const defaults = { matchDefaultMs: overlayDelayDefaultMs(false), courtDefaultMs: overlayDelayDefaultMs(true) };
  it("premise: the two defaults differ, and the court's is 0 (a court's own, never derived from the match's)", () => {
    expect(defaults.matchDefaultMs).toBe(RELAY_OVERLAY_DELAY_DEFAULT_MS);
    expect(defaults.courtDefaultMs).toBe(COURT_PHONE_OVERLAY_DELAY_MS);
    expect(defaults.matchDefaultMs).not.toBe(defaults.courtDefaultMs);
  });
  it("the whole table: match-set × club-set × match-or-court — 0 is a real value at every link", () => {
    const rows: { name: string; match: number | null; club: number | null; court: boolean; want: number }[] = [];
    for (const court of [false, true]) {
      const dflt = court ? defaults.courtDefaultMs : defaults.matchDefaultMs;
      rows.push({ name: "neither set", match: null, club: null, court, want: dflt });
      rows.push({ name: "the match's own", match: 2500, club: null, court, want: 2500 });
      rows.push({ name: "the match's own beats the club's", match: 2500, club: 4500, court, want: 2500 });
      rows.push({ name: "the match's own 0 is real", match: 0, club: 4500, court, want: 0 });
    }
    rows.push({ name: "the club's timing reaches a MATCH stream", match: null, club: 4500, court: false, want: 4500 });
    rows.push({ name: "the club's 0 is real for a match stream (not 'unset')", match: null, club: 0, court: false, want: 0 });
    rows.push({ name: "the club's timing does NOT reach a COURT stream: it keeps its own default", match: null, club: 4500, court: true, want: defaults.courtDefaultMs });
    rows.push({ name: "the club's 0 on a court is the court's default, not a club value", match: null, club: 0, court: true, want: defaults.courtDefaultMs });
    let checked = 0;
    for (const r of rows) {
      expect(effectiveDelayMs({ match: r.match, club: r.club, court: r.court, ...defaults }), `${r.name} (court ${r.court})`).toBe(r.want);
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("isKnownTemplate — the club write's refusal rule, over an injected registry", () => {
  const stub = (id: string, extra: Partial<OverlayTemplateDef<string>> = {}): OverlayTemplateDef<string> =>
    ({ id, labelKey: `stream.tab.${id}`, sports: "all", component: () => null, slabPlacement: "bar",
       sceneCardSafeArea: { x: 0, y: 0, width: 1, height: 1 }, ...extra }) as unknown as OverlayTemplateDef<string>;
  const registry: TemplateRegistry<string> = {
    open: stub("open"),
    old: stub("old", { retired: { replacedBy: "open" } }),
    shuttle: stub("shuttle", { sports: ["badminton"] }),
  };
  it("a live id is known (a sport-restricted one too: the club holds no sport); a retired, an unknown and a prototype member are not", () => {
    expect(isKnownTemplate("open", registry)).toBe(true);
    expect(isKnownTemplate("shuttle", registry), "restricted to a sport: still a template the club may set").toBe(true);
    expect(isKnownTemplate("old", registry), "retired").toBe(false);
    expect(isKnownTemplate("nope", registry), "unknown").toBe(false);
    expect(isKnownTemplate("toString", registry), "a prototype member is not a template").toBe(false);
  });
  it("the shipped registry: every template the picker offers any sport is known", () => {
    let checked = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      expect(isKnownTemplate(defaultTemplateFor(sport)), sport).toBe(true);
      checked++;
    }
    expect(checked).toBe(OVERLAY_SPORT_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("PutOrgStreamDefaults — the club write's schema takes V462's bound, and names at least one field", () => {
  it("0, the max and null parse; one past either end, a fraction and an empty body are refused", () => {
    const rows: [Record<string, unknown>, boolean][] = [
      [{ overlayDelayMs: 0 }, true], [{ overlayDelayMs: OVERLAY_DELAY_MAX_MS }, true], [{ overlayDelayMs: null }, true],
      [{ overlayTemplate: "bar" }, true], [{ overlayTemplate: null }, true], [{ overlayTemplate: null, overlayDelayMs: null }, true],
      [{ overlayDelayMs: OVERLAY_DELAY_MAX_MS + 1 }, false], [{ overlayDelayMs: -1 }, false], [{ overlayDelayMs: 2500.5 }, false],
      [{ overlayTemplate: "" }, false], [{}, false], [{ streamMode: "composed" }, false],
    ];
    let checked = 0;
    for (const [body, ok] of rows) {
      expect(PutOrgStreamDefaults.safeParse(body).success, JSON.stringify(body)).toBe(ok);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });
});
