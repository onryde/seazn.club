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
import { bracketMayEndLevel, stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { decidingPrefix, runQuickMatchProbe } from "./_quick-match-probe";

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

  it("cricket is excluded and badminton, table tennis and tennis are offered (spec §9)", () => {
    // C11 with the controller's ruling (2026-11-07): cricket is a lineup sport, excluded by name with its reason code.
    expect(committed.excluded.some((e) => e.sport_key === "cricket" && e.code === "QUICK_MATCH_LINEUP_SPORT")).toBe(true);
    expect(committed.offered.filter((o) => o.sport_key === "cricket")).toEqual([]);
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
    for (const r of rows) {
      const mod = resolveModule(r.sport_key, r.module_version);
      const knockoutCfg = { ...(withSchemaDefaults(mod, r.config) as object), ...stageDefaultsFor(mod, "knockout", r.key) };
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
    console.info(`knockout offer checked ${checked} variants, ${listed} of them listed`);
    expect(checked).toBeGreaterThan(0);
    expect(listed).toBe(committed.offered.length);   // every offered variant is listed, none dropped for want of a label (M4)
    // Both directions across the catalog (D8). On engine 3.0.2 the only `false` is cricket/test (pinned below), which
    // C11 excludes; among the OFFERED variants the count of refusals is the committed JSON's own (0 on 3.0.2).
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

  it("cricket/test is refused a knockout: a Test can end drawn even under its knockout preset (C23; excluded anyway by C11)", async () => {
    expect((await offerFor("cricket", "test")).knockoutAllowed).toBe(false);
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
