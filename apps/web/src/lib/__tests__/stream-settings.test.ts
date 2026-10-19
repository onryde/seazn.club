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
import { OVERLAY_DELAY_MAX_MS, effectiveStreamMode, isPickableTemplate } from "@/lib/stream-settings";

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
