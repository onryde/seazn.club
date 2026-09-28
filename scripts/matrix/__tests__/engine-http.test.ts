import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineErrorCode } from "@seazn/engine/core";
import { describe, expect, it } from "vitest";
import { stagesForRow } from "../lib/catalogue.ts";
import { ENGINE_HTTP_FALLBACK, ENGINE_HTTP_STATUS, engineHttpStatus } from "../lib/driver/engine-http.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { UnknownSport, resolveSportCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HTTP_TS = (): string => readFileSync(resolve(REPO, "apps/web/src/server/api-v1/http.ts"), "utf8");

/** ENGINE_HTTP's entries, read from the product's source (http.ts imports
 *  next/server, so it cannot be imported here). Comments are stripped first. */
function productTable(): Record<string, number> {
  const src = HTTP_TS();
  const at = src.indexOf("export const ENGINE_HTTP");
  const end = src.indexOf("\n};", at);
  if (at === -1 || end === -1) throw new Error("http.ts: ENGINE_HTTP literal not found");
  const body = src.slice(at, end).replace(/\/\/[^\n]*/g, "");
  return Object.fromEntries([...body.matchAll(/^\s*([A-Z_]+):\s*(\d{3}),?\s*$/gm)].map((m) => [m[1], Number(m[2])]));
}

/** The status http.ts gives an EngineError whose code its map lacks: the
 *  `?? <n>` of `ENGINE_HTTP[err.code] ?? <n>` (http.ts:158), read from the text. */
function productFallback(): number {
  const m = /ENGINE_HTTP\[err\.code\]\s*\?\?\s*(\d{3})/.exec(HTTP_TS());
  if (m === null) throw new Error("http.ts: `ENGINE_HTTP[err.code] ?? <status>` not found");
  return Number(m[1]);
}

describe("engine-http — the product's status map, text-pinned", () => {
  it("equals ENGINE_HTTP in api-v1/http.ts entry for entry, and covers every EngineErrorCode", () => {
    const product = productTable();
    const codes = EngineErrorCode.options;
    expect(Object.keys(product).length).toBeGreaterThan(0); // anti-vacuity: the parse found entries
    expect(Object.keys(product).length).toBe(codes.length);
    expect(new Set(Object.keys(product))).toEqual(new Set(codes));
    expect({ ...ENGINE_HTTP_STATUS }).toEqual(product);
  });

  it("an EngineError code maps to http.ts's own status; a code the map lacks gets http.ts's own `?? <n>` (text-pinned)", () => {
    const product = productTable();
    const fallback = productFallback();
    expect(ENGINE_HTTP_FALLBACK).toBe(fallback);
    expect(engineHttpStatus("NOT_AN_ENGINE_CODE")).toBe(fallback);
    // A prototype key is not a map entry (Object.hasOwn, not `in`).
    expect(engineHttpStatus("toString")).toBe(fallback);
    let checked = 0;
    for (const code of EngineErrorCode.options) { expect(engineHttpStatus(code), code).toBe(product[code]); checked++; }
    expect(checked).toBe(EngineErrorCode.options.length);
    expect(checked).toBeGreaterThan(0); // anti-vacuity
    // At least one code whose right answer differs from the fallback, both ways round.
    expect(Object.values(product).some((s) => s !== fallback)).toBe(true);
  });
});

describe("the fake's refusals — only an EngineError becomes a status", () => {
  // single-sport: the fake scores through the real engine; badminton's rally
  // stream is the one the fake's league path is exercised with in W1a, and the
  // catch under test does not depend on the sport.
  async function decidedBadmintonFixture() {
    const fake = new FakeLeagueDriver();
    await fake.createCompetition({ name: "c", slug: "c" });
    await fake.createDivision("c1", { name: "d", slug: "d", sportKey: "badminton", variantKey: "bwf" });
    await fake.postStages("d1", stagesForRow("league"));
    await fake.addEntrants("d1", [1, 2].map((n) => ({ displayName: `Matrix Player ${n}`, seed: n, kind: "individual" as const })));
    await fake.start();
    const [f] = await fake.listFixtures();
    const cfg = resolveSportCfg("badminton", "bwf");
    const win = generateStream({ sportKey: "badminton", cfg, stageKind: "league", home: f!.home_entrant_id!, away: f!.away_entrant_id!, outcome: { kind: "win", winner: "home" } });
    await fake.postStream(f!.id, win, "first");
    return { fake, id: f!.id, win };
  }

  it("the fake answers an engine refusal with the product's status, not a blanket 409 (W1a carry 3)", async () => {
    const { fake, id, win } = await decidedBadmintonFixture();
    const err: unknown = await fake.postStream(id, win, "second").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedCall);
    const r = err as RefusedCall;
    expect(EngineErrorCode.options).toContain(r.code);
    expect(r.status).toBe(productTable()[r.code!]);
    expect(r.status).not.toBe(409); // a re-posted decided stream is never a seq conflict
  });

  it("a harness crash inside the fold is rethrown as itself, never dressed as an engine refusal (the product 500s there, http.ts:244-247)", async () => {
    const { fake, id, win } = await decidedBadmintonFixture();
    fake.sport = "no-such-sport"; // sportModule() throws UnknownSport inside the fake's try: a harness fault, not an EngineError
    const err: unknown = await fake.postStream(id, win, "second").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RefusedCall);
    expect(err).toBeInstanceOf(UnknownSport);
    expect((err as UnknownSport).sportKey).toBe("no-such-sport");
  });
});
