// A PATCH body leaves an omitted field omitted (fix/patch-schema-partial-defaults, 2026-11-01).
//
// zod 4's `.partial()` over a field that `.default()`s still FILLS that field when it is omitted: the optional
// wrapper hands `undefined` on to the default, which answers with its value. The patch usecases write
// `Object.keys(body)` as columns, so a patch schema built as `Create.partial()` rewrote every defaulted column on
// every PATCH that never named it: renaming a court wiped its tags (and with them the scheduler's
// `required_court_tags` matches) and reset its sort; saving a venue reset its sort; an API edit of an official's
// name rewrote its roles to ["referee"]; and an AI plan suggesting one constraint came back carrying five more,
// ticked, at their defaults.
//
// The sweep reads every PATCH body of the /api/v1 route registry (`ROUTES`, which openapi-coverage pins 1:1 to the
// route files under app/api/v1), plus every `Patch…Input` a usecase exports (what a route actually hands `parseBody`),
// plus the NAMED inputs below that are neither. A new /api/v1 PATCH route is swept with no edit here. NOT swept: the
// five PATCH routes outside /api/v1 (api/admin/size-packs/[key], api/admin/coupons/[promoId], api/admin/entitlements,
// api/orgs/[id], api/users/me) — no registry lists them; none carried a `.default()` or `.partial()` on 2026-11-01.
//
// The probe, per body: zod's object parse sets a key the input omitted exactly when that key's schema answers
// `undefined` with a value, so each field is parsed from `undefined` on its own. That is what `parse({})` returns,
// with the body's own refusals factored out — most patch bodies refuse `{}` as "empty patch", and that refusal is a
// check on the FILLED output, so a filled default would also have slipped past it. Where a body does accept `{}`,
// its parse must be exactly `{}` as well.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROUTES } from "../openapi";
import { CreateCourt } from "../schemas";
import { AiConstraintDelta } from "../../usecases/schedule-ai-prompt";
import { LockInput } from "../../usecases/history";

const USECASES = join(__dirname, "..", "..", "usecases");

interface Probe {
  /** Fields parsed from `undefined`, summed over a union's options. */
  fields: number;
  /** Each omitted field that came back with a value, and that value. */
  filled: Record<string, unknown>;
}

function omissionProbe(schema: z.ZodType, name: string): Probe {
  if (schema instanceof z.ZodObject) {
    const filled: Record<string, unknown> = {};
    let fields = 0;
    for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      fields += 1;
      const parsed = field.safeParse(undefined);
      if (parsed.success && parsed.data !== undefined) filled[key] = parsed.data;
    }
    return { fields, filled };
  }
  // A discriminated union (PATCH /suspensions/{id}) is a union whose options are objects: probe each option.
  if (schema instanceof z.ZodUnion) {
    const out: Probe = { fields: 0, filled: {} };
    (schema.options as z.ZodType[]).forEach((option, i) => {
      const one = omissionProbe(option, `${name} option ${i}`);
      out.fields += one.fields;
      for (const [key, value] of Object.entries(one.filled)) out.filled[`option ${i}.${key}`] = value;
    });
    return out;
  }
  // Never skipped silently: a body shape this probe cannot read is a red that names it.
  throw new Error(`${name}: a "${schema._zod.def.type}" body — teach omissionProbe to read it`);
}

interface Swept {
  name: string;
  schema: z.ZodType;
}

/** Every PATCH row of the route registry. A PATCH row with no `request` is a red below, not a skip. */
const patchRows = ROUTES.filter((r) => r.method === "patch");
const registry: Swept[] = patchRows.flatMap((r) =>
  r.request ? [{ name: `PATCH ${r.path}`, schema: r.request as z.ZodType }] : [],
);

/** Every `export const Patch…Input` in server/usecases/*.ts, found by reading the files and then imported. */
async function usecaseInputs(): Promise<Swept[]> {
  const out: Swept[] = [];
  for (const file of readdirSync(USECASES).filter((f) => f.endsWith(".ts")).sort()) {
    const names = [...readFileSync(join(USECASES, file), "utf8").matchAll(/^export const (Patch\w*Input)\b/gm)].map((m) => m[1]!);
    if (names.length === 0) continue;
    const mod = (await import(join(USECASES, file))) as Record<string, unknown>;
    for (const n of names) {
      if (!(mod[n] instanceof z.ZodType)) throw new Error(`usecases/${file}: ${n} is not a zod schema`);
      out.push({ name: `usecases/${file.replace(/\.ts$/, "")} ${n}`, schema: mod[n] as z.ZodType });
    }
  }
  return out;
}

/** Patch-shaped inputs that are neither a route body nor a usecase `Patch…Input`. */
const NAMED: Swept[] = [
  // The AI plan's `constraint_suggestions`: the console ticks every key it carries and Apply overlays the ticked ones
  // on the division's saved constraints, so a key the model never sent must not appear.
  { name: "AiConstraintDelta", schema: AiConstraintDelta },
  // PATCH /divisions/{id}/locks parses with this usecase schema, not the registry's `S.DivisionLocks` (kept identical by
  // hand), and its name is not `Patch…Input`, so neither source above reaches it.
  { name: "usecases/history LockInput", schema: LockInput },
];

/** The usecase scan's own floor: the `Patch…Input` exports found on 2026-11-01 (officials 2, sponsors 1, venues 2).
 *  A scan that matches fewer has lost what routes actually parse with — lower this only by removing one on purpose. */
const USECASE_INPUTS_FLOOR = 5;

/** Fixed on ANOTHER branch, and so deliberately left alone here. Each entry must still fill: one that no longer does
 *  is a stale entry and reds, so it is deleted the moment the fix lands on this tree (whichever merges second does it);
 *  the last entry goes together with this map and the it() that reads it. */
const FIXED_ELSEWHERE: Readonly<Record<string, string>> = {
  "PATCH /orgs/{id}/sponsors/{sponsorId}":
    "feat/r4-sponsors 2cebfffccb splits SponsorWriteFields; the sponsor schemas are that branch's to change",
  "usecases/sponsors PatchSponsorInput": "feat/r4-sponsors 2cebfffccb, as above",
};

describe("PATCH bodies: an omitted field stays omitted", async () => {
  const usecase = await usecaseInputs();
  const swept = [...registry, ...usecase, ...NAMED];
  const probes = swept.map((s) => ({ ...s, ...omissionProbe(s.schema, s.name) }));
  const fields = probes.reduce((n, p) => n + p.fields, 0);
  const accepting = probes.filter((p) => p.schema.safeParse({}).success).length;

  it(`sweeps ${swept.length} patch schemas (${registry.length} registry, ${usecase.length} usecase, ${NAMED.length} named), ${fields} fields; ${accepting} accept {}`, () => {
    // Anti-vacuity, per source: an empty registry, a usecase scan below its floor, or a probe that read no field is a red.
    expect(registry.length).toBeGreaterThan(0);
    expect(usecase.length, "the usecase Patch…Input scan found fewer than its floor").toBeGreaterThanOrEqual(USECASE_INPUTS_FLOOR);
    expect(fields).toBeGreaterThan(swept.length);
    // Every PATCH route documents its body: one without would be a PATCH this sweep silently never reads.
    expect(patchRows.filter((r) => !r.request).map((r) => r.path)).toEqual([]);
    expect(new Set(swept.map((s) => s.name)).size).toBe(swept.length);
  });

  for (const p of probes.filter((x) => !(x.name in FIXED_ELSEWHERE))) {
    it(`${p.name}: no omitted field is filled`, () => {
      expect(p.filled).toEqual({});
      const whole = p.schema.safeParse({});
      if (whole.success) expect(whole.data).toEqual({});
    });
  }

  it(`the fixed-elsewhere entries are swept and still fill (${Object.keys(FIXED_ELSEWHERE).length} entries)`, () => {
    for (const name of Object.keys(FIXED_ELSEWHERE)) {
      const p = probes.find((x) => x.name === name);
      expect(p, `${name} is not swept: a stale or misspelt entry`).toBeDefined();
      expect(Object.keys(p!.filled), `${name} no longer fills: delete its FIXED_ELSEWHERE entry (the last one goes with the map and this whole it())`).not.toEqual([]);
    }
  });

  // The probe's positive pair: the exact form this file exists to catch is caught, field by field, with the values
  // CreateCourt itself declares (read from the create schema, never typed here).
  it("the probe catches the buggy form: CreateCourt.partial() fills sort and tags", () => {
    const declared = omissionProbe(CreateCourt, "CreateCourt").filled;
    expect(Object.keys(declared).sort()).toEqual(["sort", "tags"]);
    expect(omissionProbe(CreateCourt.partial(), "CreateCourt.partial()").filled).toEqual(declared);
    expect(CreateCourt.partial().parse({})).toEqual(declared);
  });

  it("the probe reads a union option by option, and refuses a body shape it cannot read", () => {
    const union = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a") }),
      z.object({ kind: z.literal("b"), n: z.number().default(3) }),
    ]);
    expect(omissionProbe(union, "union")).toEqual({ fields: 3, filled: { "option 1.n": 3 } });
    expect(() => omissionProbe(z.string(), "a string body")).toThrow(/teach omissionProbe/);
  });
});
