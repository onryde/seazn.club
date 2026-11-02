// W3 Task 18 (RB3-7(c), signed 252; spec §12 X-SW-18) — requested half-point and zero-point byes are DEFERRED: no door
// accepts a per-entrant bye request, and the one door a client would reach for — a stage config naming `requestedByes`
// — refuses by name, with guidance (record a walkover on the player's board).
//
// Two halves:
//  1. The refusal, driven through the REAL consumers: the create/replace/patch route handlers parse the real schemas
//     (`CreateStages`, `PatchSwissStage`) and answer through the real `v1()` envelope. The usecases and the auth door are
//     mocked (this file has no DB); what it proves is the wire — status, the NAMED code, the guidance sentence, the
//     field — and that nothing reaches a usecase. A fixture on both ends would prove the fixture.
//  2. The deferral: the published request surface (`openapi/v1.json`) names no per-entrant bye request anywhere.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { isSwissRefusalCode, SWISS_REFUSALS, swissRefusalKey } from "@/lib/swiss-refusals";
import { swissRefusalText } from "@/lib/swiss-refusal-text";
import type { AuthCtx } from "@/server/api-v1/auth";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import type { createStages as CreateFn, replaceStages as ReplaceFn } from "@/server/usecases/stages";
import type { patchSwissStage as PatchFn } from "@/server/usecases/swiss-rounds-admin";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };

const createMock = vi.hoisted(() => vi.fn<typeof CreateFn>());
const replaceMock = vi.hoisted(() => vi.fn<typeof ReplaceFn>());
const patchMock = vi.hoisted(() => vi.fn<typeof PatchFn>());
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/stages", () => ({
  createStages: createMock,
  replaceStages: replaceMock,
  listStagesWithTableRules: vi.fn(),
  deleteStage: vi.fn(),
  getStageWithTableRules: vi.fn(),
}));
vi.mock("@/server/usecases/swiss-rounds-admin", () => ({ patchSwissStage: patchMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { POST as CREATE, PUT as REPLACE } from "@/app/api/v1/divisions/[id]/stages/route";
import { PATCH } from "@/app/api/v1/stages/[id]/route";

/** The brief's sentence (task-18-brief.md), typed here: the table row is the code under test, never the oracle. */
const GUIDANCE =
  "Requested half-point or zero-point byes aren't offered yet. If a player must miss a round, record a walkover on their board.";

const DIV_ID = "22222222-2222-4222-8222-222222222222";
const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const divCtx = { params: Promise.resolve({ id: DIV_ID }) };
const stageCtx = { params: Promise.resolve({ id: STAGE_ID }) };

const json = (url: string, method: string, body: unknown): Request =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const stagesReq = (method: "POST" | "PUT", body: unknown) => json(`http://localhost/api/v1/divisions/${DIV_ID}/stages`, method, body);
const patchReq = (body: unknown) => json(`http://localhost/api/v1/stages/${STAGE_ID}`, "PATCH", body);

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; field?: string; issues?: unknown[]; [k: string]: unknown };
}

const swissStage = (config: Record<string, unknown>) => ({ seq: 1, kind: "swiss", name: "Swiss", config });

/** What a client might send as a bye request: a list of per-entrant requests, a flag, a map, a bare number, null. */
const REQUESTS: [string, unknown][] = [
  ["a list of per-entrant requests", [{ entrantId: "ent-1", round: 2, value: 0.5 }]],
  ["a flag", true],
  ["a map", { "ent-1": 0 }],
  ["a bare number", 0.5],
  ["null", null],
];

beforeEach(() => {
  createMock.mockReset();
  replaceMock.mockReset();
  patchMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(AUTH);
  createMock.mockResolvedValue([{ id: "s1" }] as never);
  replaceMock.mockResolvedValue([{ id: "s1" }] as never);
  patchMock.mockResolvedValue({ rounds: 3, chess: false, swiss_rounds: null, shells: { added: 0, removed: 0, slots_freed: 0 } } as never);
});

describe("X-SW-18 requested half/zero byes are refused by name, with guidance", () => {
  it("X-SW-18 a stage config naming requestedByes is refused with the guidance, on create and on PATCH", async () => {
    // Each door, with the field the refusal must name as the client sent it (a list is indexed).
    const doors: { label: string; field: string; send: (value: unknown) => Promise<Response> }[] = [
      { label: "POST one stage", field: "config.requestedByes", send: (v) => CREATE(stagesReq("POST", swissStage({ rounds: 3, requestedByes: v })), divCtx) },
      { label: "POST a list of stages", field: "[0].config.requestedByes", send: (v) => CREATE(stagesReq("POST", [swissStage({ requestedByes: v })]), divCtx) },
      { label: "PUT one stage", field: "config.requestedByes", send: (v) => REPLACE(stagesReq("PUT", swissStage({ requestedByes: v })), divCtx) },
      { label: "PUT a list of stages", field: "[0].config.requestedByes", send: (v) => REPLACE(stagesReq("PUT", [swissStage({ requestedByes: v })]), divCtx) },
      { label: "PATCH the key alone", field: "requestedByes", send: (v) => PATCH(patchReq({ requestedByes: v }), stageCtx) },
      { label: "PATCH beside a real edit", field: "requestedByes", send: (v) => PATCH(patchReq({ rounds: 3, requestedByes: v }), stageCtx) },
    ];
    let checked = 0;
    for (const door of doors) {
      for (const [what, value] of REQUESTS) {
        const where = `${door.label} with ${what}`;
        const res = await door.send(value);
        const body = (await res.json()) as ErrorEnvelope;
        expect(res.status, where).toBe(400);
        // The NAMED code: not the generic VALIDATION, not "Invalid input".
        expect(body.error.code, where).toBe("SWISS_REQUESTED_BYES_DEFERRED");
        expect(body.error.message, where).toBe(GUIDANCE);
        expect(body.error.field, where).toBe(door.field);
        // The issue itself rides on the envelope too (a client that reads `issues` sees the same path).
        expect(JSON.stringify(body.error.issues), where).toContain("requestedByes");
        checked++;
      }
    }
    // Nothing reached a usecase: a refused body is refused at the door, so nothing is written.
    expect(createMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(patchMock).not.toHaveBeenCalled();
    // Anti-vacuity: 6 doors x 5 request shapes.
    expect(checked).toBe(30);
    expect(checked).toBe(doors.length * REQUESTS.length);
  });

  it("X-SW-18 the guidance names the way out: a walkover on the player's board", () => {
    // The sentence is the product's whole answer to "my player must miss round 3": read what it tells the organiser.
    expect(GUIDANCE).toMatch(/walkover on their board/);
    expect(SWISS_REFUSALS.SWISS_REQUESTED_BYES_DEFERRED).toMatchObject({ status: 400, message: GUIDANCE });
  });

  // "If any desk UI calls with this key, the copy reaches users through the existing Swiss refusal mapping." No desk screen
  // sends the key, but the AI console builds stage configs from model output and every desk door that shows a refused
  // write branches on `isSwissRefusalCode(err.code)` -> `swissRefusalText`: the new code must take that road, in all four
  // locales, with the wire's `field` detail changing nothing.
  it("the existing Swiss refusal mapping says it in the reader's language, in all four locales", () => {
    const code = "SWISS_REQUESTED_BYES_DEFERRED";
    expect(isSwissRefusalCode(code)).toBe(true);
    const key = swissRefusalKey(code);
    expect(key).toBe("swiss.refusal.SWISS_REQUESTED_BYES_DEFERRED");
    let checked = 0;
    for (const [locale, dict] of Object.entries({ en, es, fr, nl }) as [string, Record<string, string>][]) {
      const say = (details?: Record<string, unknown>) =>
        swissRefusalText(code, details, (k) => dict[k]!, () => "");
      const text = say();
      expect(text, locale).toBe(dict[key]);
      expect(say({ field: "config.requestedByes" }), `${locale}: the wire's field detail adds nothing`).toBe(text);
      expect(text.trim(), locale).not.toBe("");
      if (locale !== "en") expect(text, `${locale} is translated`).not.toBe(en[key as keyof typeof en]);
      checked++;
    }
    expect(checked, "anti-vacuity: locales checked").toBe(4);
  });

  it("the same bodies without the key go through (the refusal is the key, not the stage or the door)", async () => {
    const created = await CREATE(stagesReq("POST", swissStage({ rounds: 3 })), divCtx);
    expect(created.status).toBe(201);
    const replaced = await REPLACE(stagesReq("PUT", [swissStage({ rounds: 3 })]), divCtx);
    expect(replaced.status).toBe(200);
    const patched = await PATCH(patchReq({ rounds: 3 }), stageCtx);
    expect(patched.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it("a typo of the key is the generic unknown-key 400, not the named refusal (the name is not a blanket)", async () => {
    for (const key of ["requestedByess", "requestedbyes", "requested_byes", "byeRequests"]) {
      const res = await PATCH(patchReq({ [key]: [] }), stageCtx);
      const body = (await res.json()) as ErrorEnvelope;
      expect(res.status, key).toBe(400);
      expect(body.error.code, key).toBe("VALIDATION");
      expect(body.error.message, key).toBe("Invalid input");
      expect(JSON.stringify(body.error.issues), key).toContain(key);
    }
    expect(patchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The deferral: no API operation accepts a per-entrant bye request.
// ---------------------------------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Doc {
  paths: Record<string, Record<string, Json>>;
  components?: { schemas?: Record<string, Json> };
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
/** Keys whose value is DATA (a sample, a default, an enum), never a schema: a property name in an example is no property. */
const DATA_KEYS = new Set(["example", "examples", "default", "const", "enum"]);

interface Match {
  op: string;
  path: string;
  name: string;
  schema: Json;
}

/**
 * Every property name matching /bye/i on the REQUEST side of every operation in `doc`: the body schemas
 * (`requestBody.content.*.schema`, `$ref`s resolved) and the parameters (query and path names, and their schemas).
 * Responses are not walked: a response may say `bye_holder_id`; a request may not ask for a bye.
 */
function requestByeNames(doc: Doc): { operations: number; withRequestSurface: number; refsResolved: number; matches: Match[] } {
  const matches: Match[] = [];
  let operations = 0;
  let withRequestSurface = 0;
  let refsResolved = 0;
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method) || typeof op !== "object" || op === null || Array.isArray(op)) continue;
      operations++;
      const label = `${method.toUpperCase()} ${path}`;
      const walk = (node: Json, trail: string, seen: readonly string[]): void => {
        if (Array.isArray(node)) {
          node.forEach((child, i) => walk(child, `${trail}[${i}]`, seen));
          return;
        }
        if (typeof node !== "object" || node === null) return;
        const ref = node["$ref"];
        if (typeof ref === "string") {
          const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
          const target = m ? doc.components?.schemas?.[m[1]!] : undefined;
          // An unresolvable $ref is a hole in the sweep, not a pass: fail loudly.
          if (target === undefined) throw new Error(`${label}: unresolvable $ref ${ref}`);
          if (seen.includes(ref)) return;
          refsResolved++;
          walk(target, `${trail}->${m![1]}`, [...seen, ref]);
          return;
        }
        for (const [key, child] of Object.entries(node)) {
          if (DATA_KEYS.has(key)) continue;
          if (key === "properties" && typeof child === "object" && child !== null && !Array.isArray(child)) {
            for (const [name, schema] of Object.entries(child)) {
              if (/bye/i.test(name)) matches.push({ op: label, path: `${trail}.${name}`, name, schema });
              walk(schema, `${trail}.${name}`, seen);
            }
          } else {
            walk(child, `${trail}/${key}`, seen);
          }
        }
      };
      let surface = false;
      const body = (op["requestBody"] as { content?: Record<string, { schema?: Json }> } | undefined)?.content;
      for (const [contentType, media] of Object.entries(body ?? {})) {
        if (media.schema === undefined) continue;
        surface = true;
        walk(media.schema, `body(${contentType})`, []);
      }
      for (const param of (op["parameters"] as { name?: string; schema?: Json }[] | undefined) ?? []) {
        surface = true;
        if (typeof param.name === "string" && /bye/i.test(param.name)) {
          matches.push({ op: label, path: `param(${param.name})`, name: param.name, schema: param.schema ?? null });
        }
        if (param.schema !== undefined) walk(param.schema, `param(${param.name})`, []);
      }
      if (surface) withRequestSurface++;
    }
  }
  return { operations, withRequestSurface, refsResolved, matches };
}

/** The only /bye/i request property names the API may carry (spec §12 RB3-7(c); the brief):
 *  `byes` — the knockout draw's seeded byes (entrant ids placed on a bracket, not a request for a bye);
 *  `byeScore` — until App B removes it (no request schema carries it today);
 *  `requestedByes` — W3 T18's own refusal slot (controller ruling C8): allowed ONLY as the never-schema `{"not":{}}`,
 *  i.e. a key that accepts no value at all, which `StageConfig` / `PatchSwissStage` emit so the spec documents it. */
const ALLOWED = new Set(["byes", "byeScore", "requestedByes"]);
const NEVER = JSON.stringify({ not: {} });

function offenders(matches: Match[]): Match[] {
  return matches.filter((m) => !ALLOWED.has(m.name) || (m.name === "requestedByes" && JSON.stringify(m.schema) !== NEVER));
}

const OPENAPI_PATH = join(__dirname, "..", "..", "..", "..", "..", "..", "openapi", "v1.json");
const published = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as Doc;
const print = (m: Match) => `${m.op} ${m.path} ${JSON.stringify(m.schema)}`;

describe("X-SW-18 the deferral: no API operation accepts a per-entrant bye request", () => {
  it("X-SW-18 no API operation accepts a per-entrant bye request", () => {
    const sweep = requestByeNames(published);
    // The sweep's whole output, so a reader sees what it matched (and a failure shows every match, not the first).
    console.info(
      `[X-SW-18] openapi/v1.json: ${sweep.operations} operations scanned, ${sweep.withRequestSurface} with a request surface, ${sweep.refsResolved} $refs resolved, ${sweep.matches.length} /bye/i request properties:\n${sweep.matches.map((m) => `  ${print(m)}`).join("\n")}`,
    );
    // Anti-vacuity: operations scanned > 0, and a scan that reached request schemas at all.
    expect(sweep.operations, "operations scanned").toBeGreaterThan(0);
    expect(sweep.withRequestSurface, "operations with a request surface").toBeGreaterThan(0);
    // Every property that matches /bye/i is on the allow-list, and requestedByes only as the never-schema.
    expect(offenders(sweep.matches).map(print), "a per-entrant bye request (or a widened refusal slot) in a request schema").toEqual([]);
    // The sweep is not blind: the allowed names it exists to tell apart from a request ARE reached. `byes` on the two
    // stage doors (single + list arm, POST + PUT) and the refusal slot on both create doors and the PATCH.
    const found = (name: string) => sweep.matches.filter((m) => m.name === name).map((m) => m.op);
    expect(found("byes").sort(), "byes (the knockout draw's seeded byes)").toEqual(
      ["POST /api/v1/divisions/{id}/stages", "POST /api/v1/divisions/{id}/stages", "PUT /api/v1/divisions/{id}/stages", "PUT /api/v1/divisions/{id}/stages"].sort(),
    );
    expect(found("requestedByes").sort(), "requestedByes (T18's refusal slot) on create, replace and PATCH").toEqual(
      [
        "PATCH /api/v1/stages/{id}",
        "POST /api/v1/divisions/{id}/stages",
        "POST /api/v1/divisions/{id}/stages",
        "PUT /api/v1/divisions/{id}/stages",
        "PUT /api/v1/divisions/{id}/stages",
      ].sort(),
    );
  });

  it("the committed openapi/v1.json is the generator's output for the request names (regenerate with `npm run openapi:gen`)", () => {
    const live = requestByeNames(buildOpenApiDocument() as unknown as Doc);
    const file = requestByeNames(published);
    expect(live.operations, "operations: the committed spec lags the code").toBe(file.operations);
    expect(live.matches.map(print).sort()).toEqual(file.matches.map(print).sort());
    expect(live.operations).toBeGreaterThan(0);
  });

  it("the sweep has teeth: it flags a per-entrant bye request in a body, behind a $ref, and as a parameter", () => {
    const bad = (schemaName: string): Doc => ({
      paths: {
        "/x/{id}": {
          post: {
            requestBody: { content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } } },
            parameters: [{ name: "byeRequest", in: "query", schema: { type: "string" } }],
          },
          get: { responses: {} },
        },
      },
      components: {
        schemas: {
          Outer: { type: "object", properties: { config: { $ref: "#/components/schemas/Inner" } } },
          Inner: { type: "object", properties: { byeRequest: { type: "array", items: { type: "string" } }, requestedByes: { type: "string" } } },
        },
      },
    });
    const sweep = requestByeNames(bad("Outer"));
    expect(sweep.operations).toBe(2);
    expect(sweep.refsResolved).toBe(2);
    // byeRequest through two $refs, requestedByes with a REAL schema (not the never-slot), and the query parameter.
    expect(sweep.matches.map((m) => m.name).sort()).toEqual(["byeRequest", "byeRequest", "requestedByes"]);
    expect(offenders(sweep.matches)).toHaveLength(3);
    // The allow-list names are not offences in their allowed shapes, and an unresolvable $ref is a failure, not a pass.
    expect(offenders([{ op: "x", path: "p", name: "byes", schema: { type: "array" } }])).toEqual([]);
    expect(offenders([{ op: "x", path: "p", name: "requestedByes", schema: { not: {} } }])).toEqual([]);
    expect(() => requestByeNames(bad("Missing"))).toThrow(/unresolvable \$ref/);
  });
});
