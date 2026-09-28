import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineErrorCode } from "@seazn/engine/core";
import { describe, expect, it } from "vitest";
import { stagesForRow } from "../lib/catalogue.ts";
import { ENGINE_HTTP_STATUS, engineHttpStatus } from "../lib/driver/engine-http.ts";
import { RefusedCall, type OrganiserDriver } from "../lib/driver/types.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** ENGINE_HTTP's entries, read from the product's source (http.ts imports
 *  next/server, so it cannot be imported here). Comments are stripped first. */
function productTable(): Record<string, number> {
  const src = readFileSync(resolve(REPO, "apps/web/src/server/api-v1/http.ts"), "utf8");
  const at = src.indexOf("export const ENGINE_HTTP");
  const end = src.indexOf("\n};", at);
  if (at === -1 || end === -1) throw new Error("http.ts: ENGINE_HTTP literal not found");
  const body = src.slice(at, end).replace(/\/\/[^\n]*/g, "");
  return Object.fromEntries([...body.matchAll(/^\s*([A-Z_]+):\s*(\d{3}),?\s*$/gm)].map((m) => [m[1], Number(m[2])]));
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

  it("an unknown or missing code falls back to 422, as http.ts:158 does (`?? 422`)", () => {
    expect(engineHttpStatus(null)).toBe(422);
    expect(engineHttpStatus("NOT_AN_ENGINE_CODE")).toBe(422);
    expect(engineHttpStatus("SEQ_CONFLICT")).toBe(409);
    expect(engineHttpStatus("MODULE_DUPLICATE")).toBe(500);
  });

  it("the fake answers an engine refusal with the product's status, not a blanket 409 (W1a carry 3)", async () => {
    // single-sport: the fake scores through the real engine; badminton's rally
    // stream is the one the fake's league path is exercised with in W1a.
    const d: OrganiserDriver = new FakeLeagueDriver(); // driven through the contract HttpDriver shares
    await d.createCompetition({ name: "c", slug: "c" });
    await d.createDivision("c1", { name: "d", slug: "d", sportKey: "badminton", variantKey: "bwf" });
    await d.postStages("d1", stagesForRow("league"));
    await d.addEntrants("d1", [1, 2].map((n) => ({ displayName: `Matrix Player ${n}`, seed: n, kind: "individual" as const })));
    await d.start("d1");
    const [f] = await d.listFixtures("d1");
    const cfg = resolveSportCfg("badminton", "bwf");
    const win = generateStream({ sportKey: "badminton", cfg, stageKind: "league", home: f!.home_entrant_id!, away: f!.away_entrant_id!, outcome: { kind: "win", winner: "home" } });
    await d.postStream(f!.id, win, "first");
    const err: unknown = await d.postStream(f!.id, win, "second").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedCall);
    const r = err as RefusedCall;
    expect(EngineErrorCode.options).toContain(r.code);
    expect(r.status).toBe(ENGINE_HTTP_STATUS[r.code as keyof typeof ENGINE_HTTP_STATUS]);
    expect(r.status).not.toBe(409); // a re-posted decided stream is never a seq conflict
  });
});
