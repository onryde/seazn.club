// W4 app-A Task 7 — what an organiser can and cannot send about a knockout's draw (rulebook-W4-knockout.md):
//   RB4-D6 (X-SD-9): `config.byes` and `config.slotOrder` stay API-only, with no organiser control. Pre-flight ruling D4:
//     proved by BEHAVIOUR, not a text scan — every stage body the format picker builds (the builder's Format step and the
//     Format dialog both send `formatStagesFor`, lib/division-builder/format-choice.ts) for every template, over every
//     knob it takes, carries neither key. Counted; zero checked is a failure.
//   RB4-D9 (X-SD-10): country separation is not offered (Seazn holds no country for a player or a team), and a request for
//     it is refused by NAME — the stage-config schema's never-key, answered by the v1 envelope as 400
//     COUNTRY_SEPARATION_NOT_OFFERED, through the real route handlers (usecases and auth mocked: this file has no DB; what
//     it proves is the wire, and that nothing reaches a usecase).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { STAGE_TEMPLATES, type StandingsCarry } from "@/lib/format-templates";
import type { ThirdPlaceMode } from "@/lib/third-place";
import { formatStagesFor } from "@/lib/division-builder/format-choice";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { StageConfig } from "@/server/api-v1/schemas";
import type { createStages as CreateFn, replaceStages as ReplaceFn } from "@/server/usecases/stages";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const createMock = vi.hoisted(() => vi.fn<typeof CreateFn>());
const replaceMock = vi.hoisted(() => vi.fn<typeof ReplaceFn>());
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/stages", () => ({
  createStages: createMock,
  replaceStages: replaceMock,
  listStagesWithTableRules: vi.fn(),
  deleteStage: vi.fn(),
  getStageWithTableRules: vi.fn(),
}));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { POST as CREATE, PUT as REPLACE } from "@/app/api/v1/divisions/[id]/stages/route";

/** The plan's sentence (task-7-brief.md), typed here: the table row is the code under test, never the oracle. */
const NOT_OFFERED = "Country separation isn't offered: Seazn holds no country for players or teams.";

const DIV_ID = "22222222-2222-4222-8222-222222222222";
const divCtx = { params: Promise.resolve({ id: DIV_ID }) };
const stagesReq = (method: "POST" | "PUT", body: unknown): Request =>
  new Request(`http://localhost/api/v1/divisions/${DIV_ID}/stages`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; field?: string; issues?: unknown[] };
}

/** Every own key at any depth of a config, so a `byes` nested under some sub-object is caught too. */
function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) keysDeep(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    out.push(k);
    keysDeep(v, out);
  }
  return out;
}

beforeEach(() => {
  createMock.mockReset();
  replaceMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(AUTH);
  createMock.mockResolvedValue([{ id: "s1" }] as never);
  replaceMock.mockResolvedValue([{ id: "s1" }] as never);
});

describe("X-SD-9 byes and slotOrder stay API-only", () => {
  it("X-SD-9 byes and slotOrder stay API-only: no stage body the format picker builds carries either key, for any template or knob", () => {
    // The knob domain: each number knob at its bounds and one value inside (FORMAT_BOUNDS, the one declaration both
    // pickers read), legs both ways, and every standings carry.
    const span = (b: { min: number; max: number }) => [...new Set([b.min, Math.round((b.min + b.max) / 2), b.max])];
    const CARRIES: StandingsCarry[] = ["none", "points", "full"];
    const combos: { qualified: number; swissRounds: number; poolCount: number; legs: number; standingsCarry: StandingsCarry; thirdPlace: ThirdPlaceMode }[] = [];
    for (const qualified of span(FORMAT_BOUNDS.qualify))
      for (const swissRounds of span(FORMAT_BOUNDS.swissRounds))
        for (const poolCount of span(FORMAT_BOUNDS.pools))
          for (const legs of span(FORMAT_BOUNDS.legs))
            for (const standingsCarry of CARRIES) for (const thirdPlace of ["shared", "playoff"] as const) combos.push({ qualified, swissRounds, poolCount, legs, standingsCarry, thirdPlace });

    let bodies = 0;
    let stages = 0;
    let knockoutFamily = 0;
    const leaks: string[] = [];
    // Every template the product declares, retired ones included (a division stored with one re-applies it).
    for (const t of STAGE_TEMPLATES) {
      for (const knobs of combos) {
        const drafts = formatStagesFor(t.key, knobs);
        bodies++;
        for (const d of drafts) {
          stages++;
          if (["knockout", "double_elim", "stepladder", "page_playoff"].includes(d.kind)) knockoutFamily++;
          const keys = keysDeep(d.config);
          if (keys.includes("byes") || keys.includes("slotOrder")) leaks.push(`${t.key} ${d.kind} ${JSON.stringify(knobs)}`);
        }
      }
    }
    console.info(`X-SD-9: ${STAGE_TEMPLATES.length} templates × ${combos.length} knob sets = ${bodies} bodies, ${stages} stage configs (${knockoutFamily} bracket-family) checked`);
    expect(leaks, "RB4-D6: a builder-built stage carries byes or slotOrder").toEqual([]);
    // Anti-vacuity: every template × every knob set built, and the bracket family was actually among them.
    expect(STAGE_TEMPLATES.length).toBeGreaterThan(0);
    expect(combos.length).toBe(3 * 3 * 3 * 2 * 3 * 2);
    expect(bodies).toBe(STAGE_TEMPLATES.length * combos.length);
    expect(stages).toBeGreaterThanOrEqual(bodies);
    expect(knockoutFamily, "the sweep reached knockout stages").toBeGreaterThan(0);
  });

  it("the sweep can see a leak: a body carrying either key is reported (positive control on keysDeep)", () => {
    expect(keysDeep({ thirdPlace: true, slotOrder: [1, null] })).toContain("slotOrder");
    expect(keysDeep({ nested: { byes: ["e1"] } })).toContain("byes");
    expect(keysDeep({ thirdPlace: true })).not.toContain("slotOrder");
  });

  it("the API still takes both keys (they are API-only, not refused)", () => {
    expect(StageConfig.safeParse({ byes: ["e1"] }).success).toBe(true);
    expect(StageConfig.safeParse({ slotOrder: [1, null, 2, null] }).success).toBe(true);
  });
});

describe("X-SD-10 a country-separation request is refused by name", () => {
  it("X-SD-10 a country-separation request is refused by name: the schema's never-key carries the sentence", () => {
    let checked = 0;
    for (const value of [true, false, "on", { round: 1 }, null]) {
      const parsed = StageConfig.safeParse({ countrySeparation: value });
      expect(parsed.success, JSON.stringify(value)).toBe(false);
      const issue = parsed.error!.issues.find((i) => i.path.join(".") === "countrySeparation");
      expect(issue?.message, JSON.stringify(value)).toBe(NOT_OFFERED);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(5);
    expect(KNOCKOUT_REFUSALS.COUNTRY_SEPARATION_NOT_OFFERED).toEqual({
      status: 400,
      en: NOT_OFFERED,
      key: "knockout.refusal.COUNTRY_SEPARATION_NOT_OFFERED",
    });
  });

  it("X-SD-10 the v1 envelope answers 400 COUNTRY_SEPARATION_NOT_OFFERED on create and replace, naming the field, and writes nothing", async () => {
    const ko = (config: Record<string, unknown>) => ({ seq: 1, kind: "knockout", name: "KO", config });
    const doors: { label: string; field: string; send: () => Promise<Response> }[] = [
      { label: "POST one stage", field: "config.countrySeparation", send: () => CREATE(stagesReq("POST", ko({ countrySeparation: true })), divCtx) },
      { label: "POST a list", field: "[0].config.countrySeparation", send: () => CREATE(stagesReq("POST", [ko({ countrySeparation: true })]), divCtx) },
      { label: "PUT one stage", field: "config.countrySeparation", send: () => REPLACE(stagesReq("PUT", ko({ countrySeparation: true })), divCtx) },
      { label: "PUT a list", field: "[0].config.countrySeparation", send: () => REPLACE(stagesReq("PUT", [ko({ thirdPlace: true, countrySeparation: true })]), divCtx) },
    ];
    let checked = 0;
    for (const door of doors) {
      const res = await door.send();
      const body = (await res.json()) as ErrorEnvelope;
      expect(res.status, door.label).toBe(400);
      expect(body.error.code, door.label).toBe("COUNTRY_SEPARATION_NOT_OFFERED");
      expect(body.error.message, door.label).toBe(NOT_OFFERED);
      expect(body.error.field, door.label).toBe(door.field);
      checked++;
    }
    expect(checked, "anti-vacuity: every door").toBe(doors.length);
    expect(createMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("the same body without the key goes through (the refusal is the key, not the knockout)", async () => {
    const res = await CREATE(stagesReq("POST", { seq: 1, kind: "knockout", name: "KO", config: { thirdPlace: true } }), divCtx);
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
