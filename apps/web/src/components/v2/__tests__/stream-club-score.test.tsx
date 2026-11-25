// The Streaming page's "Score on stream" section (Seazn-hosted video, Phase 4, Task 38): the club's default style and timing, set once.
//
// `apps/web` vitest is `environment: "node"` — NO DOM. Two layers, each where it can be proven (the seazn-destination-card.test.tsx recipe):
//   * the section as MARKUP (`renderToStaticMarkup` in the page's DictProvider): what a member who cannot edit reads, in every locale;
//   * the section DRIVEN (`renderIsland`) with only the transport doubled: which route and which body each control sends, the choice shown
//     at once, the rollback on a refusal (the real v1 envelope and the real `apiV1`), and the revision order a late answer is read by.
// What none of this can see — layout at 320/768/1280, tap area, the previews' real paint — is the screenshots and the e2e spec.
//
// Sport-agnostic: the section reads the club's sports from its props; the sport switch is driven with two real sports of the registry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { defaultTemplateFor, resolveTemplate, templatesForSport } from "@/components/overlay/template-registry";
import { ApiV1Error } from "@/lib/client-v1";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { messages, type MessageKey } from "@/lib/messages";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { v1 } from "@/server/api-v1/http";
import { COURT_PHONE_OVERLAY_DELAY_MS, RELAY_OVERLAY_DELAY_DEFAULT_MS } from "@/server/relay/config";
import { StreamClubScore } from "../stream-club-score";
import { ScoreTiming } from "../stream-score-settings";
import { StreamTemplatePicker } from "../stream-template-picker";

// ─── doubles: the transport only ───────────────────────────────────────────────────────────────────────────────────────
const transport = vi.hoisted(() => ({ impl: null as null | ((url: string, opts?: { method?: string; json?: unknown }) => Promise<unknown>) }));
const calls: { url: string; method: string; json: unknown }[] = [];
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, opts?: { method?: string; json?: unknown }) =>
      transport.impl ? transport.impl(url, opts) : actual.apiV1(url, opts as RequestInit & { json?: unknown }),
  };
});

const ORG = "o-1";
const PATH = `/api/v1/orgs/${ORG}/stream-defaults`;
type Stored = { overlayTemplate: string | null; overlayDelayMs: number | null; revision: number | null };
const NONE: Stored = { overlayTemplate: null, overlayDelayMs: null, revision: null };
/** The route's answer: the whole row after the write, at the revision the TEST names. */
let stored: Stored;
let rev: number;
beforeEach(() => {
  calls.length = 0;
  stored = { ...NONE };
  rev = 1;
  transport.impl = async (url, opts) => {
    calls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
    stored = { ...stored, ...(opts?.json as object), revision: rev++ };
    return { ...stored };
  };
});
afterEach(() => vi.restoreAllMocks());

const m = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), messages[k] as string);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const LOCALES = ["en", "es", "fr", "nl"] as const;
const dictOf = (locale: (typeof LOCALES)[number]): Dict =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Dict;

// Two real sports with different template lists would be ideal; the registry decides which differ, so the pair is DERIVED: the first two
// sports whose offered template ids differ (and the test fails by name if the registry has no such pair).
const SPORT_A = "football";
const SPORT_B = "cricket";
const LIVE = { status: "in_play", summary: null, outcome: null, lastSeq: null, venueTz: "UTC" } as const;
const SIDES: [{ id: string; name: string }, { id: string; name: string }] = [{ id: "home", name: "Home" }, { id: "away", name: "Away" }];
type Props = Parameters<typeof StreamClubScore>[0];
const props = (over: Partial<Props> = {}): Props => ({
  orgId: ORG, canEdit: true, stored: NONE, defaultMs: RELAY_OVERLAY_DELAY_DEFAULT_MS, courtDefaultMs: COURT_PHONE_OVERLAY_DELAY_MS,
  sports: [{ key: SPORT_A, name: "Football" }], snapshots: { [SPORT_A]: { ...LIVE }, [SPORT_B]: { ...LIVE, lastSeq: 7 } },
  sides: SIDES, overlayDict: {}, ...over,
});
function html(over: Partial<Props> = {}, dict: Dict = messages as unknown as Dict, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <StreamClubScore {...props(over)} />
    </DictProvider>,
  );
}

const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined => tree.find((el) => propsOf(el)["data-testid"] === id);
const picker = (tree: ReactElement[]) => {
  const el = tree.find((e) => e.type === StreamTemplatePicker);
  if (!el) throw new Error("no template picker in the tree — every probe on it would pass vacuously");
  return propsOf(el) as unknown as Parameters<typeof StreamTemplatePicker>[0];
};
const timing = (tree: ReactElement[]) => {
  const el = tree.find((e) => e.type === ScoreTiming);
  if (!el) throw new Error("no Score timing in the tree");
  return propsOf(el) as unknown as Parameters<typeof ScoreTiming>[0];
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
/** A refusal exactly as the page receives it: the server's own error, through the real v1 envelope and the real `apiV1`. */
async function wire(err: unknown): Promise<ApiV1Error> {
  const res = await v1(async () => { throw err; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
  const saved = transport.impl;
  transport.impl = null;
  try {
    const { apiV1 } = await import("@/lib/client-v1");
    await apiV1(PATH, { method: "PUT", json: { overlayDelayMs: 1000 } });
  } catch (caught) {
    expect(caught).toBeInstanceOf(ApiV1Error);
    return caught as ApiV1Error;
  } finally {
    transport.impl = saved;
    fetchSpy.mockRestore();
  }
  throw new Error("apiV1 resolved on an error response");
}
const OTHER = (sport: string) => templatesForSport(sport).find((t) => t.id !== defaultTemplateFor(sport))!;

// ═══ markup ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("what a member who cannot edit sees: the facts in words, no controls", () => {
  it("nothing set: each sport's own default and the server's default timing marked as such — no button, no input", () => {
    const h = html({ canEdit: false });
    expect(h).toContain('data-testid="club-score"');
    expect(h).toContain('data-testid="club-score-readonly"');
    expect(h, "nothing to press").not.toContain("<button");
    expect(h).not.toContain("<input");
    expect(h).toContain(esc(m("streaming.club.style.none.short")));
    expect(h).toContain(esc(m("stream.timing.value", { seconds: (RELAY_OVERLAY_DELAY_DEFAULT_MS / 1000).toFixed(1) })));
    expect(h).toContain(esc(m("stream.timing.default")));
    expect(h, "the scope line").toContain(esc(m("streaming.club.scope.new")));
  });

  it("a club style and timing: the style's own label and the seconds, not the 'default' marker", () => {
    const t = OTHER(SPORT_A);
    const h = html({ canEdit: false, stored: { overlayTemplate: t.id, overlayDelayMs: 4500, revision: 3 } });
    expect(h).toContain(esc(m(resolveTemplate(t.id, SPORT_A).labelKey as MessageKey)));
    expect(h).toContain(esc(m("stream.timing.value", { seconds: "4.5" })));
    expect(h).not.toContain(esc(m("stream.timing.default")));
    expect(h).not.toContain(esc(m("streaming.club.style.none.short")));
  });

  it("the scope line names the court default from the prop (never a typed 0 s): 0 reads 0.0, another value moves it; the 403 line is not the destinations one", () => {
    const zero = html({ canEdit: false, courtDefaultMs: 0 });
    expect(zero).toContain(esc(m("streaming.club.scope.rest", { seconds: "0.0" })));
    const other = html({ canEdit: false, courtDefaultMs: 2500 });
    expect(other, "the prop is what the line says").toContain(esc(m("streaming.club.scope.rest", { seconds: "2.5" })));
    expect(other).not.toContain("{seconds}");
    expect(m("streaming.club.error.forbidden"), "a club-specific 403").not.toBe(m("streamDest.error.forbidden"));
  });

  // The retired-id clause (a retired id with a replacement is not "unavailable") is NOT covered here: the component reads the real registry, which has
  // no retired entry, so no input reaches it.
  it("a stored style this sport cannot show (an unknown id): said in words, naming the stored id and the sport; a style it can show, or none stored, says nothing", () => {
    const h = html({ stored: { overlayTemplate: "legacy-gone", overlayDelayMs: null, revision: 2 } });
    expect(h).toContain('data-testid="club-score-style-unavailable"');
    expect(h).toContain(esc(m("streaming.club.style.unavailable", { style: "legacy-gone", sport: "Football" })));
    const known = html({ stored: { overlayTemplate: OTHER(SPORT_A).id, overlayDelayMs: null, revision: 2 } });
    expect(known, "a style the sport offers").not.toContain("club-score-style-unavailable");
    expect(html(), "nothing stored").not.toContain("club-score-style-unavailable");
  });

  it("every locale: its own copy for every new key of the section, the same placeholders as English, and no raw key leaks", () => {
    const KEYS = ["streaming.club.heading", "streaming.club.sub", "streaming.club.scope.new", "streaming.club.scope.rest"] as const;
    const en = dictOf("en");
    const holes = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    const newKeys = Object.keys(en).filter((k) => /^streaming\.club\.|^stream\.club\.|^stream\.timing\.(clubDefault|helpClub)$/.test(k));
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = dictOf(locale);
      const h = html({ canEdit: false, stored: { overlayTemplate: OTHER(SPORT_A).id, overlayDelayMs: 4500, revision: 1 } }, dict, locale);
      // scope.rest carries the court default ({seconds}); the render has the prop's 0 s as the timing field shows it.
      for (const k of KEYS) expect(h, `${locale}: ${k}`).toContain(esc((dict[k] as string).replace("{seconds}", new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(0))));
      expect(h, `${locale}: no raw key`).not.toMatch(/streaming\.club\./);
      for (const k of newKeys) {
        expect(typeof dict[k] === "string" && dict[k] !== "", `${locale}: ${k}`).toBe(true);
        expect(holes(dict[k] as string), `${locale}: ${k} placeholders`).toEqual(holes(en[k] as string));
        if (locale !== "en") expect(dict[k], `${locale}: ${k} is translated, not English`).not.toBe(en[k]);
        checked++;
      }
    }
    expect(newKeys.length, "anti-vacuity: the sweep found the section's keys").toBeGreaterThanOrEqual(20);
    expect(checked).toBe(newKeys.length * LOCALES.length);
  });
});

// ═══ driven ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the section, driven", () => {
  it("nothing set: no style is selected (each sport uses its own), the line says so, there is no Clear; timing is the server's default", () => {
    const island = renderIsland(StreamClubScore, props());
    const t = island.tree();
    expect(picker(t).selected).toBeNull();
    expect(byTestId(t, "club-score-style-none")).toBeDefined();
    expect(byTestId(t, "club-score-style-reset")).toBeUndefined();
    expect(timing(t).storedMs).toBeNull();
    expect(timing(t).defaultMs).toBe(RELAY_OVERLAY_DELAY_DEFAULT_MS);
    expect(timing(t).clubDefault, "the club's own timing is not 'the club default'").toBeFalsy();
  });

  it("picking a style PUTs { overlayTemplate } alone to the org's route, shows it at once, then Clear PUTs null", async () => {
    const island = renderIsland(StreamClubScore, props());
    const pick = OTHER(SPORT_A).id;
    picker(island.tree()).onPick(pick);
    expect(calls).toEqual([{ url: PATH, method: "PUT", json: { overlayTemplate: pick } }]);
    expect(picker(island.tree()).selected, "shown before the server answers").toBe(pick);
    await settle();
    expect(picker(island.tree()).selected).toBe(pick);
    expect(byTestId(island.tree(), "club-score-style-none")).toBeUndefined();
    (propsOf(byTestId(island.tree(), "club-score-style-reset")!).onClick as () => void)();
    expect(calls[1]).toEqual({ url: PATH, method: "PUT", json: { overlayTemplate: null } });
    expect(picker(island.tree()).selected).toBeNull();
    await settle();
    expect(picker(island.tree()).selected).toBeNull();
    expect(byTestId(island.tree(), "club-score-style-none"), "the none line is back").toBeDefined();
  });

  it("Score timing PUTs { overlayDelayMs } alone — a number, then null to go back to the default", async () => {
    const island = renderIsland(StreamClubScore, props());
    timing(island.tree()).onSave(4500);
    expect(calls[0]).toEqual({ url: PATH, method: "PUT", json: { overlayDelayMs: 4500 } });
    expect(timing(island.tree()).storedMs).toBe(4500);
    await settle();
    timing(island.tree()).onSave(0);
    expect(calls[1]!.json, "0 is a real value").toEqual({ overlayDelayMs: 0 });
    await settle();
    expect(timing(island.tree()).storedMs).toBe(0);
    timing(island.tree()).onSave(null);
    expect(calls[2]!.json).toEqual({ overlayDelayMs: null });
    await settle();
    expect(timing(island.tree()).storedMs).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("the stored club style is what the picker opens on, as the previewed sport resolves it", () => {
    const t = OTHER(SPORT_A);
    const island = renderIsland(StreamClubScore, props({ stored: { overlayTemplate: t.id, overlayDelayMs: 2500, revision: 4 } }));
    expect(picker(island.tree()).selected).toBe(resolveTemplate(t.id, SPORT_A).id);
    expect(timing(island.tree()).storedMs).toBe(2500);
  });

  it("the sport switch: one sport draws none; two draw a radio per sport, and choosing one re-draws the picker's options and its preview snapshot for THAT sport", () => {
    const one = renderIsland(StreamClubScore, props());
    expect(byTestId(one.tree(), "club-score-sports"), "a single sport has nothing to switch").toBeUndefined();
    const two = renderIsland(StreamClubScore, props({ sports: [{ key: SPORT_A, name: "Football" }, { key: SPORT_B, name: "Cricket" }] }));
    expect(byTestId(two.tree(), `club-score-sport-${SPORT_A}`)).toBeDefined();
    expect(propsOf(byTestId(two.tree(), `club-score-sport-${SPORT_A}`)!)["aria-checked"]).toBe(true);
    expect(propsOf(byTestId(two.tree(), `club-score-sport-${SPORT_B}`)!)["aria-checked"]).toBe(false);
    expect(picker(two.tree()).templates.map((x) => x.id)).toEqual(templatesForSport(SPORT_A).map((x) => x.id));
    expect(picker(two.tree()).preview.sportKey).toBe(SPORT_A);
    expect(picker(two.tree()).preview.snapshot.lastSeq, "A's snapshot").toBeNull();
    (propsOf(byTestId(two.tree(), `club-score-sport-${SPORT_B}`)!).onClick as () => void)();
    expect(picker(two.tree()).templates.map((x) => x.id)).toEqual(templatesForSport(SPORT_B).map((x) => x.id));
    expect(picker(two.tree()).preview.sportKey).toBe(SPORT_B);
    expect(picker(two.tree()).preview.snapshot.lastSeq, "B's own snapshot").toBe(7);
    expect(propsOf(byTestId(two.tree(), `club-score-sport-${SPORT_B}`)!)["aria-checked"]).toBe(true);
    expect(calls, "switching a preview saves nothing").toHaveLength(0);
  });

  it("a refused save rolls the choice back to what the server holds and says why: a frozen admin seat (402 members.max) in its own words, a 403, anything else the retry line", async () => {
    const rows: [string, () => Promise<unknown>, MessageKey][] = [
      ["402 a frozen admin seat", () => wire(new PaymentRequiredError("members.max")), "streamDest.error.seatFrozen"],
      ["402 any other feature", () => wire(new PaymentRequiredError("formats.double_elim")), "streamDest.error.generic"],
      ["401 signed out", () => wire(new AuthError()), "streamDest.error.signedOut"],
      // The shared reader's 403 line says "change streaming destinations": wrong for a style save, so this section words its own.
      ["403 not an owner or admin", () => wire(new HttpError(403, "forbidden")), "streaming.club.error.forbidden"],
    ];
    let checked = 0;
    for (const [name, mk, key] of rows) {
      const refusal = await mk();
      const island = renderIsland(StreamClubScore, props({ stored: { overlayTemplate: null, overlayDelayMs: 2500, revision: 1 } }));
      transport.impl = async () => { throw refusal; };
      timing(island.tree()).onSave(9000);
      expect(timing(island.tree()).storedMs, `${name}: shown at once`).toBe(9000);
      await settle();
      expect(timing(island.tree()).storedMs, `${name}: the server's value again`).toBe(2500);
      expect(textOf(byTestId(island.tree(), "club-score-error")!).trim(), name).toBe(m(key));
      expect(propsOf(byTestId(island.tree(), "club-score-error")!).role, name).toBe("alert");
      checked++;
    }
    expect(checked).toBe(rows.length);
    // The positive pair: a save that lands shows no error.
    const ok = renderIsland(StreamClubScore, props());
    transport.impl = async (_url, opts) => ({ overlayTemplate: null, overlayDelayMs: (opts?.json as { overlayDelayMs: number }).overlayDelayMs, revision: 20 });
    timing(ok.tree()).onSave(1000);
    await settle();
    expect(byTestId(ok.tree(), "club-score-error")).toBeUndefined();
  });

  it("a new save clears the old refusal before it is sent", async () => {
    const refusal = await wire(new PaymentRequiredError("members.max"));
    const island = renderIsland(StreamClubScore, props());
    transport.impl = async () => { throw refusal; };
    timing(island.tree()).onSave(9000);
    await settle();
    expect(byTestId(island.tree(), "club-score-error")).toBeDefined();
    transport.impl = async (url, opts) => ({ overlayTemplate: null, overlayDelayMs: (opts?.json as { overlayDelayMs: number }).overlayDelayMs, revision: 9 });
    timing(island.tree()).onSave(3000);
    await settle();
    expect(byTestId(island.tree(), "club-score-error")).toBeUndefined();
    expect(timing(island.tree()).storedMs).toBe(3000);
  });

  it("REVISION order: an older answer arriving after a newer one never puts its value back (two saves of one field, answers crossed)", async () => {
    const island = renderIsland(StreamClubScore, props());
    const resolvers: (() => void)[] = [];
    transport.impl = (_url, opts) => new Promise((resolve) => {
      const v = (opts?.json as { overlayDelayMs: number }).overlayDelayMs;
      resolvers.push(() => resolve({ overlayTemplate: null, overlayDelayMs: v, revision: v === 2000 ? 5 : 6 }));
    });
    timing(island.tree()).onSave(2000);
    timing(island.tree()).onSave(3000);
    expect(timing(island.tree()).storedMs, "the newest choice shows at once").toBe(3000);
    resolvers[1]!(); // the newer save lands first (rev 6)
    await settle();
    resolvers[0]!(); // the older one (rev 5) arrives late
    await settle();
    expect(timing(island.tree()).storedMs, "the older answer is NOT folded over the newer").toBe(3000);
  });

  it("an OVERTAKEN save that fails says nothing: the newer choice is on screen and in flight, so no refusal line and no rollback to the old value", async () => {
    const refusal = await wire(new PaymentRequiredError("members.max"));
    const island = renderIsland(StreamClubScore, props());
    const settlers: (() => void)[] = [];
    transport.impl = (_url, opts) => new Promise((resolve, reject) => {
      const v = (opts?.json as { overlayDelayMs: number }).overlayDelayMs;
      settlers.push(v === 2000 ? () => reject(refusal) : () => resolve({ overlayTemplate: null, overlayDelayMs: v, revision: 8 }));
    });
    timing(island.tree()).onSave(2000); // the older save — it will be refused, late
    timing(island.tree()).onSave(3000); // the newer one
    settlers[1]!();
    await settle();
    expect(timing(island.tree()).storedMs).toBe(3000);
    settlers[0]!(); // the older refusal arrives after the newer save settled
    await settle();
    expect(byTestId(island.tree(), "club-score-error"), "the refusal belongs to a choice already replaced").toBeUndefined();
    expect(timing(island.tree()).storedMs, "and the newer value stays").toBe(3000);
  });
});
