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

/** Every non-test `.ts` under `dir` (recursive, `__tests__` skipped), as `/`-separated paths relative to `dir`, sorted. */
function tsFilesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (e.name === "__tests__") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...tsFilesUnder(dir, r));
    else if (e.name.endsWith(".ts")) out.push(r);
  }
  return out.sort();
}

interface UsecaseScan {
  inputs: Swept[];
  /** `.ts` files read. */
  files: number;
  /** Distinct sub-folders (a split use-case) that held at least one of them. */
  folders: number;
}

/** Every `export const Patch…Input` under server/usecases/, found by reading the files and then imported. RECURSIVE: a
 *  use-case split into a folder (`stages/`, `schedule/`, `registrations/`, …) is still the use-case, and a flat readdir
 *  stopped seeing it the day it became one. */
async function usecaseInputs(): Promise<UsecaseScan> {
  const inputs: Swept[] = [];
  const files = tsFilesUnder(USECASES);
  for (const file of files) {
    const names = [...readFileSync(join(USECASES, file), "utf8").matchAll(/^export const (Patch\w*Input)\b/gm)].map((m) => m[1]!);
    if (names.length === 0) continue;
    const mod = (await import(join(USECASES, file))) as Record<string, unknown>;
    for (const n of names) {
      if (!(mod[n] instanceof z.ZodType)) throw new Error(`usecases/${file}: ${n} is not a zod schema`);
      inputs.push({ name: `usecases/${file.replace(/\.ts$/, "")} ${n}`, schema: mod[n] as z.ZodType });
    }
  }
  return { inputs, files: files.length, folders: new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0])).size };
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

/** The scan's reach, which the match count above cannot see: no split folder holds a `Patch…Input` today, so a scan that
 *  quietly drops one still finds all 5. Counted 2026-11-10 over `usecases/` minus `__tests__`: 274 `.ts` files (152 loose
 *  + billing-events 14, competition-schedule-ai 10, external-play 33, registrations 20, schedule 15, schedule-ai 11,
 *  stages 19) in 7 split folders. Removing a module is legal and lowers the file number in the same change; adding one
 *  needs no edit. */
const USECASE_FILES_FLOOR = 274;
const USECASE_FOLDERS_FLOOR = 7;

describe("PATCH bodies: an omitted field stays omitted", async () => {
  const scan = await usecaseInputs();
  const usecase = scan.inputs;
  const swept = [...registry, ...usecase, ...NAMED];
  const probes = swept.map((s) => ({ ...s, ...omissionProbe(s.schema, s.name) }));
  const fields = probes.reduce((n, p) => n + p.fields, 0);
  const accepting = probes.filter((p) => p.schema.safeParse({}).success).length;

  it(`sweeps ${swept.length} patch schemas (${registry.length} registry, ${usecase.length} usecase, ${NAMED.length} named), ${fields} fields; ${accepting} accept {}; usecase scan read ${scan.files} files in ${scan.folders} split folders`, () => {
    // Anti-vacuity, per source: an empty registry, a usecase scan below its floor, or a probe that read no field is a red.
    expect(registry.length).toBeGreaterThan(0);
    expect(usecase.length, "the usecase Patch…Input scan found fewer than its floor").toBeGreaterThanOrEqual(USECASE_INPUTS_FLOOR);
    // …and the scan READ every split folder, not just the loose files (a flat readdir reads 152 of the 274).
    expect(scan.files, "usecases/ files read fell below the count taken on 2026-11-10").toBeGreaterThanOrEqual(USECASE_FILES_FLOOR);
    expect(scan.folders, "split use-case folders read fell below the count taken on 2026-11-10").toBeGreaterThanOrEqual(USECASE_FOLDERS_FLOOR);
    expect(fields).toBeGreaterThan(swept.length);
    // Every PATCH route documents its body: one without would be a PATCH this sweep silently never reads.
    expect(patchRows.filter((r) => !r.request).map((r) => r.path)).toEqual([]);
    expect(new Set(swept.map((s) => s.name)).size).toBe(swept.length);
  });

  for (const p of probes) {
    it(`${p.name}: no omitted field is filled`, () => {
      expect(p.filled).toEqual({});
      const whole = p.schema.safeParse({});
      if (whole.success) expect(whole.data).toEqual({});
    });
  }

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
