// Quick match plan 1, Task 6 — the sport offer, proven by scoring every sport (spec docs/superpowers/specs/2026-11-03-
// quick-match-design.md §9 "Create-and-score sweep" and "Knockout offer", §13; pre-flight B6, C1, C23, D2, D3, D8, D10).
//
// `lib/quick-match-offer.generated.json` is written ONLY by the probe (`_quick-match-probe.ts`), through the writer
// describe below, which runs only under QUICK_MATCH_PROBE_WRITE=1 (`npm run quick-match:probe` from the repo root, the
// capture:ai-demo pattern). A normal run never writes, and a write run never compares itself against the stale import.
//
// Real Postgres required (the probe creates and scores real quick matches); skipped without DATABASE_URL.
import { randomBytes as kekBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import uiEn from "@/dictionaries/en/ui.json";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { isChessSport } from "@/lib/chess-individual-only";
import { sql } from "@/lib/db";
import { withSchemaDefaults } from "@/server/engine-db/fixture-cfg";
import { resolveModule } from "@/server/engine-db/registry";
import { listQuickMatchSports, offerFor, type QuickMatchOfferJson } from "../quick-match-sports";
import { isCoreEventType } from "@seazn/engine/core";
import { bracketMayEndLevel, stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { buildWalk, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { QUICK_MATCH_BAND_CAPPED_SPORTS, quickMatchBandCeiling } from "@/lib/quick-match-pad";
import {
  decidingPrefix,
  PROBE_REDRAWS,
  PROBE_SEEDS,
  probeVariantsOf,
  quickMatchWalkModule,
  runQuickMatchProbe,
  walkableVariants,
} from "./_quick-match-probe";
import { seedFootballCatalog } from "./_seed";

const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);   // A15: the probe seals a home token per create
// The probe's creates and scores fire organizer analytics; none leaves a test run.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const WRITING = process.env.QUICK_MATCH_PROBE_WRITE === "1";
const OFFER_JSON_PATH = resolve(import.meta.dirname, "../../../lib/quick-match-offer.generated.json");
const committed = offerJson as QuickMatchOfferJson;
const en = uiEn as Record<string, string>;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!WRITING)("write the quick match offer (QUICK_MATCH_PROBE_WRITE=1 only)", () => {
  it("writes the probe's offer", async () => {
    // A write asked for with no database must fail, never skip green: the JSON would silently stay as it was (review M3).
    if (!HAS_DB) throw new Error("QUICK_MATCH_PROBE_WRITE=1 needs DATABASE_URL: the probe creates and scores real quick matches");
    const run = await runQuickMatchProbe({ quiet: false });
    writeFileSync(OFFER_JSON_PATH, JSON.stringify(run.offer, null, 2) + "\n");
  }, 30 * 60_000);
});

describe.skipIf(!HAS_DB || WRITING)("quick match offer", () => {
  it("DRIFT PIN: the committed offer equals a fresh probe run on the pinned engine", async () => {
    // Its expected value is this probe's own earlier output, so it proves only that nothing moved. The spec's oracle is
    // the next test and the knockout one (B6g).
    const run = await runQuickMatchProbe({ quiet: true });
    console.info(`quick match probe checked ${run.checked} sport×variant cases, ${run.countCases} count cases, ${run.knockoutCases} knockouts`);
    expect(run.checked).toBeGreaterThan(0);   // zero checked is a failure
    expect(run.countCases).toBeGreaterThan(0);
    expect(run.knockoutCases).toBeGreaterThan(0);   // C23's bracket question was asked of at least one real knockout (M1)
    expect(run.offer.engine).toBe(committed.engine);   // M2: the engine the offer was proven on
    expect(run.offer.offered).toEqual(committed.offered);   // every offered variant's key AND its knockoutAllowed (M2)
    expect(run.offer.excluded).toEqual(committed.excluded);
  }, 30 * 60_000);   // hundreds of creates (D3: "cost: slower DB suite"); AGENTS.md class 20

  it("cricket, badminton, table tennis and tennis are offered (spec §9; C11 as amended, decision log 2026-11-13)", () => {
    // Cricket is scored at bands 0–1 (no named player), proven by the probe at those bands, and refused a knockout.
    expect(committed.excluded.filter((e) => e.sport_key === "cricket"), "no cricket variant excluded").toEqual([]);
    const cricketOffered = committed.offered.filter((o) => o.sport_key === "cricket");
    expect(cricketOffered.length, "anti-vacuity: cricket variants offered").toBeGreaterThan(0);
    for (const o of cricketOffered) expect(o.knockoutAllowed, `${o.variant_key}: League only`).toBe(false);
    for (const k of ["badminton", "tabletennis", "tennis"]) expect(committed.offered.some((o) => o.sport_key === k), k).toBe(true);
  });

  it("knockoutAllowed is the engine's answer to 'can a knockout match end level?' for every variant, and the list agrees (C23, owner ruling 2026-11-07)", async () => {
    // Every SYSTEM variant, offered or not. The expected value is composed here from the ENGINE's own pieces — the
    // variant's config under `stageDefaultsFor(module, "knockout", variant)`, the documented `{...division, ...rules}`
    // overlay — and asked of `bracketMayEndLevel`; `offerFor` composes through the app's create path
    // (`withStageDefaults`, `resolveFixtureCfg`), so a drift between the two reds here.
    let checked = 0;
    const seen = new Set<boolean>();
    const rows = await sql<{ sport_key: string; key: string; config: unknown; module_version: string }[]>`
      select v.sport_key, v.key, v.config, s.module_version
      from sport_variants v join sports s on s.key = v.sport_key
      where v.is_system and v.org_id is null order by v.sport_key, v.key`;
    const declared = new Map<string, boolean>();
    let capped = 0;
    for (const r of rows) {
      const mod = resolveModule(r.sport_key, r.module_version);
      // A band-capped quick match sport (cricket, bands 0–1) plays its knockout WITHOUT the stage's preset deciders: the
      // preset is the super over, every ball of which names a batter and a bowler (the engine's band 3), so the guest's
      // pad could never record it. The premise is asked of the engine's own declarations, not typed.
      const spec = QUICK_MATCH_BAND_CAPPED_SPORTS.has(r.sport_key) ? mod.padSpec?.(mod.configSchema.parse(r.config) as never) : undefined;
      const ceiling = spec ? quickMatchBandCeiling(r.sport_key, spec) : null;
      const preset = stageDefaultsFor(mod, "knockout", r.key);
      if (ceiling !== null) {
        capped++;
        if ((preset as { superOver?: unknown }).superOver === true) {
          expect(spec!.fidelity["cricket.superover.ball"], `premise: ${r.sport_key}/${r.key}'s super over is above the ceiling`).toBeGreaterThan(ceiling);
        }
      }
      const knockoutCfg = { ...(withSchemaDefaults(mod, r.config) as object), ...(ceiling === null ? preset : {}) };
      const expected = !bracketMayEndLevel(mod, "knockout", knockoutCfg);
      expect((await offerFor(r.sport_key, r.key)).knockoutAllowed, `${r.sport_key}/${r.key}`).toBe(expected);
      declared.set(`${r.sport_key}/${r.key}`, expected);
      seen.add(expected);
      checked++;
    }
    let listed = 0;
    const sports = await listQuickMatchSports();
    for (const s of sports) {
      for (const x of s.variants) {
        expect(x.knockoutAllowed, `${s.sport_key}/${x.variant_key}`).toBe(declared.get(`${s.sport_key}/${x.variant_key}`));
        listed++;
      }
    }
    console.info(`knockout offer checked ${checked} variants (${capped} band-capped), ${listed} of them listed`);
    expect(checked).toBeGreaterThan(0);
    expect(capped, "anti-vacuity: the capped composition was asked").toBeGreaterThan(0);
    expect(listed).toBe(committed.offered.length);   // every offered variant is listed, none dropped for want of a label (M4)
    // Both directions across the catalog (D8). The `false`s are cricket's (every variant: no super over at bands 0–1, and
    // a Test can end drawn anyway); among the OFFERED variants the count of refusals is the committed JSON's own.
    expect(seen).toEqual(new Set([true, false]));
    const offeredRefusals = committed.offered.filter((o) => !declared.get(`${o.sport_key}/${o.variant_key}`)).length;
    expect(offeredRefusals).toBe(committed.offered.filter((o) => !o.knockoutAllowed).length);
  });

  it("football/11-a-side is offered a knockout: its knockout preset (extra time, then penalties) decides a level match", async () => {
    // Owner ruling 2026-11-07. The variant alone CAN end level in a bracket; the stage's preset deciders are the reason.
    const [row] = await sql<{ config: unknown; module_version: string }[]>`
      select v.config, s.module_version from sport_variants v join sports s on s.key = v.sport_key
      where v.sport_key = 'football' and v.key = '11-a-side' and v.is_system and v.org_id is null`;
    const mod = resolveModule("football", row!.module_version);
    expect(bracketMayEndLevel(mod, "knockout", withSchemaDefaults(mod, row!.config))).toBe(true);   // without the preset
    expect((await offerFor("football", "11-a-side")).knockoutAllowed).toBe(true);
    expect(committed.offered).toContainEqual({ sport_key: "football", variant_key: "11-a-side", knockoutAllowed: true });
  });

  it("badminton is offered a knockout: every rally game ends with a winner (§9)", async () => {
    const sports = await listQuickMatchSports();
    const badminton = sports.find((s) => s.sport_key === "badminton")!;
    expect(badminton.variants.length).toBeGreaterThan(0);
    for (const x of badminton.variants) expect(x.knockoutAllowed, x.variant_key).toBe(true);
  });

  it("cricket/test is refused a knockout: a Test can end drawn even under its knockout preset (C23)", async () => {
    expect((await offerFor("cricket", "test")).knockoutAllowed).toBe(false);
  });

  it("every cricket variant is refused a knockout in a quick match, though its organiser knockout preset decides a tie", async () => {
    // Decision log 2026-11-13: League only. The organiser's knockout of a limited-overs variant ends with a winner (its
    // preset super over); the guest's pad stops at band 1, so a quick match knockout could end tied with nobody to settle.
    const [sport] = await sql<{ module_version: string }[]>`select module_version from sports where key = 'cricket'`;
    const mod = resolveModule("cricket", sport!.module_version);
    let checked = 0;
    let organiserDecides = 0;
    for (const v of Object.keys(mod.variants)) {
      const [row] = await sql<{ config: unknown }[]>`
        select config from sport_variants where sport_key = 'cricket' and key = ${v} and is_system and org_id is null`;
      expect((await offerFor("cricket", v)).knockoutAllowed, v).toBe(false);
      const organiserKnockout = { ...(withSchemaDefaults(mod, row!.config) as object), ...stageDefaultsFor(mod, "knockout", v) };
      if (!bracketMayEndLevel(mod, "knockout", organiserKnockout)) organiserDecides++;
      checked++;
    }
    expect(checked, "anti-vacuity: cricket variants").toBe(Object.keys(mod.variants).length);
    // The witness: without the cap, these would be offered (the cap, not the engine, refuses them).
    expect(organiserDecides, "premise: some organiser cricket knockout ends with a winner").toBeGreaterThan(0);
  });

  it("generic is excluded by the probe and never listed (B6e)", async () => {
    expect(committed.excluded.some((e) => e.sport_key === "generic" && e.code === "QUICK_MATCH_GENERIC")).toBe(true);
    expect((await listQuickMatchSports()).some((s) => s.sport_key === "generic")).toBe(false);
  });

  it("each sport offers its own kinds, and every name is a dictionary key (C1, D2)", async () => {
    let checked = 0;
    const sports = await listQuickMatchSports();
    for (const s of sports) {
      expect(en[s.labelKey], s.labelKey).toBeTruthy();
      if (isChessSport(s.sport_key)) expect(s.kinds).toEqual(["individual"]);   // owner ruling 2026-10-26
      for (const x of s.variants) {
        expect(en[x.labelKey], x.labelKey).toBeTruthy();
        expect((await offerFor(s.sport_key, x.variant_key)).kinds, `${s.sport_key}/${x.variant_key}`).toEqual(s.kinds);   // a per-sport axis (D2)
        checked++;
      }
    }
    console.info(`sport list checked ${checked} variants of ${sports.length} sports`);
    expect(checked).toBeGreaterThan(0);
    // The engine's declaration (badminton's entrantModel): Doubles exists, so the switch can offer it.
    expect(sports.find((s) => s.sport_key === "badminton")!.kinds).toEqual(expect.arrayContaining(["individual", "pair"]));
  });

  it("offerFor of an unknown sport or variant offers nothing (the empty case)", async () => {
    expect(await offerFor("badminton", "no-such-variant")).toEqual({ offered: false, kinds: [], knockoutAllowed: false });
    expect(await offerFor("no-such-sport", "x")).toEqual({ offered: false, kinds: [], knockoutAllowed: false });
  });

  it("the probe walks the engine's declared presets only, beside the system row other suites seed (CI run 42437980218)", async () => {
    // `seedFootballCatalog` (_seed.ts) is what a dozen suites in the same shared database run: it leaves a SYSTEM row
    // `football/default` (config {}) that no engine preset declares and `sync:sports` would prune. The drift pin walked
    // it and offered it. The expected keys come from the engine's own declaration, never from the probe.
    await seedFootballCatalog();
    const [sport] = await sql<{ module_version: string }[]>`select module_version from sports where key = 'football'`;
    const raw = await sql<{ key: string }[]>`
      select key from sport_variants where sport_key = 'football' and is_system and org_id is null`;
    expect(raw.map((r) => r.key), "premise: the seeded system row is in the catalog").toContain("default");
    const declared = Object.keys(resolveModule("football", sport!.module_version).variants);
    expect(declared, "premise: the engine declares no `default` preset").not.toContain("default");
    const walked = (await probeVariantsOf("football", sport!.module_version)).map((v) => v.key);
    expect(walked.length, "anti-vacuity: presets walked").toBeGreaterThan(0);
    expect([...walked].sort()).toEqual([...declared].sort());
    expect(walked).not.toContain("default");
  });
});

describe("walkableVariants: the probe's variants are the engine's declared presets, each with its catalog row", () => {
  // Pure: no database. The catalog rows are stand-ins; the keys are the engine's own (football's declared presets).
  const declared = Object.keys(builtinModules.find((m) => m.key === "football")!.variants);
  const row = (key: string) => ({ key, config: {} });

  it("drops a system row no preset declares and keeps the catalog's order", () => {
    expect(declared.length).toBeGreaterThan(1);
    const rows = [row("default"), ...declared.map(row), row("zz-seeded")];
    expect(walkableVariants("football", declared, rows).map((r) => r.key)).toEqual(declared);
    const reversed = [...declared].reverse().map(row);
    expect(walkableVariants("football", declared, reversed).map((r) => r.key), "the rows' order, not the declaration's").toEqual([...declared].reverse());
  });

  it("a declared preset with no catalog row throws, naming it (the catalog is not synced)", () => {
    const [first, ...rest] = declared;
    expect(() => walkableVariants("football", declared, rest.map(row))).toThrow(new RegExp(`football.*\\b${first}\\b.*sync:sports`));
  });

  it("the empty cases throw: no catalog rows at all, and a sport that declares no preset", () => {
    expect(() => walkableVariants("football", declared, [])).toThrow(/sync:sports/);
    expect(() => walkableVariants("football", [], [row("default")])).toThrow(/declares no variant/);
  });
});

describe("decidingPrefix keeps why the walk gave up (review M5)", () => {
  it("a walk that throws on every seed answers null and keeps each seed's message", () => {
    // Pure: no database. A module whose init throws stands in for cricket's "ran out of eligible players".
    const badminton = builtinModules.find((m) => m.key === "badminton")!;
    const broken = { ...badminton, init: () => { throw new Error("no eligible players for this walk"); } };
    const cfg = badminton.configSchema.parse({});
    const errors: string[] = [];
    const lineups = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };
    expect(decidingPrefix(broken as never, cfg, lineups, errors)).toBeNull();
    expect(errors.length).toBeGreaterThan(0);   // zero kept is the bare catch this replaces
    expect(errors.every((e) => e.includes("no eligible players for this walk"))).toBe(true);
    expect(errors[0]).toMatch(/^seed 1: /);
  });
});

describe("quickMatchWalkModule: the probe walks a band-capped sport as the guest's pad drives it (decision log 2026-11-13)", () => {
  // Pure: no database. Bands come from the engine's own map (`padSpec().fidelity`), the ceiling from the pad's own rule.
  const NAMELESS = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };
  const cricket = builtinModules.find((m) => m.key === "cricket")!;
  const cfgOf = (mod: AnySportModule, variant: string) =>
    mod.configSchema.parse((mod.variants as Record<string, unknown>)[variant]);

  it("an uncapped sport, and a capped sport with no generator, walk as the module itself", () => {
    let checked = 0;
    for (const mod of builtinModules as readonly AnySportModule[]) {
      if (QUICK_MATCH_BAND_CAPPED_SPORTS.has(mod.key)) continue;
      for (const v of Object.keys(mod.variants)) {
        expect(quickMatchWalkModule(mod, cfgOf(mod, v)), `${mod.key}/${v}`).toBe(mod);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: uncapped sport×variants").toBeGreaterThan(0);
    const noGenerator = { ...cricket, arbitraryEvent: undefined } as AnySportModule;
    expect(quickMatchWalkModule(noGenerator, cfgOf(cricket, "t20"))).toBe(noGenerator);
  });

  it("cricket decides on every variant through events at or below its quick match ceiling only", () => {
    let variants = 0;
    let sportEvents = 0;
    for (const v of Object.keys(cricket.variants)) {
      const cfg = cfgOf(cricket, v);
      const spec = cricket.padSpec!(cfg as never);
      const ceiling = quickMatchBandCeiling("cricket", spec)!;
      expect(ceiling, `premise: ${v} is capped`).not.toBeNull();
      const walk = quickMatchWalkModule(cricket, cfg);
      expect(walk, `${v}: wrapped`).not.toBe(cricket);
      const prefix = decidingPrefix(walk, cfg, NAMELESS);
      expect(prefix, `${v}: a seed decides`).not.toBeNull();
      for (const e of prefix!) {
        if (isCoreEventType(e.type)) continue;
        expect(spec.fidelity[e.type], `${v}: ${e.type} is in the engine's band map`).toBeDefined();
        expect(spec.fidelity[e.type]!, `${v}: ${e.type}`).toBeLessThanOrEqual(ceiling);
        sportEvents++;
      }
      // The play event the sweeps score after a Start is within the ceiling too (firstRallyFor's own draw).
      const play = onePlayEvent(walk, cfg, NAMELESS, [makeEnvelope(0, { type: "core.start", payload: {} })]);
      expect(play, `${v}: a play event after the Start`).not.toBeNull();
      expect(spec.fidelity[play!.type]!, `${v}: ${play!.type}`).toBeLessThanOrEqual(ceiling);
      variants++;
    }
    expect(variants, "anti-vacuity: cricket variants walked").toBe(Object.keys(cricket.variants).length);
    expect(sportEvents, "anti-vacuity: sport events checked").toBeGreaterThan(0);
  });

  it("witness: the unwrapped generator draws above the ceiling (a ball or a player line) or throws, so the wrapper is load-bearing", () => {
    const cfg = cfgOf(cricket, "t20");
    const spec = cricket.padSpec!(cfg as never);
    const ceiling = quickMatchBandCeiling("cricket", spec)!;
    let above = 0;
    let thrown = 0;
    for (let seed = 1; seed <= PROBE_SEEDS; seed++) {
      try {
        const walk = buildWalk(cricket as never, cfg as never, NAMELESS, seed, 200);
        above += walk.events.filter((e) => !isCoreEventType(e.type) && (spec.fidelity[e.type] ?? 0) > ceiling).length;
      } catch {
        thrown++;
      }
    }
    expect(above + thrown).toBeGreaterThan(0);
  });

  it("the redraw budget: a generator that only draws above the ceiling, or only throws, answers null after PROBE_REDRAWS tries", () => {
    const cfg = cfgOf(cricket, "t20");
    for (const draw of [() => ({ type: "cricket.ball", payload: {} }), () => { throw new Error("ran out of eligible players"); }]) {
      let calls = 0;
      const stub = { ...cricket, arbitraryEvent: () => { calls++; return draw(); } } as unknown as AnySportModule;
      expect(quickMatchWalkModule(stub, cfg).arbitraryEvent!(cricket.init(cfg as never, NAMELESS) as never, () => 0.5)).toBeNull();
      expect(calls).toBe(PROBE_REDRAWS);
    }
  });
});
