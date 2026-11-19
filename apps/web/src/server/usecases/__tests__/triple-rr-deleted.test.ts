// W5 app PR A, Task 16 (X-RR-6; owner ruling 287, 2026-11-16: "in prod, no triple_rr, so blindly cleanup, delete it").
//
// `triple_rr` was a STAGE_TEMPLATES entry (one league, legs 3) and a DETECTED answer (detectTemplate named any lone league
// with legs >= 3 that). No column stores a STAGE_TEMPLATES key and no API door takes one, so there is nothing stored to
// clean: the entry and its detection branch are deleted and a lone league reads back as `league` with its leg count.
// What is NOT deleted is the legs value: RB5-G1 (ruling 285) keeps legs 1-8 on the stage schema, so a league with legs 3
// is still accepted by the API and still builds three legs. That is the coordinator's reading of 287's scope, and the pin
// below guards the over-reach a "deletion" invites.
//
// This file is the ONLY place the deleted key is named (see the scan at the bottom); its literals are the allowlist.
// Expected values: the rulings above, the engine's own fixture count (`generateRoundRobin`), the builder's offer read
// through `templatesForSport` over the whole sport registry. Pure tests run anywhere; the DB pin needs Postgres.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { StageConfig } from "@/server/api-v1/schemas/stages";
import { buildTemplateStages, detectTemplate, STAGE_TEMPLATES, templatesForSport } from "@/lib/format-templates";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createFromTemplate, TEMPLATE_UNKNOWN_KEY_CODE } from "../templates";

const HAS_DB = !!process.env.DATABASE_URL;
const DELETED = "triple_rr";
const HERE = dirname(fileURLToPath(import.meta.url));
const KNOBS = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 };

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("X-RR-6 triple_rr is not a template and is not offered by the builder", () => {
  // differential: today a retired entry (STAGE_TEMPLATES carried it with `retired: true`)
  it("STAGE_TEMPLATES has no such key, and no template carries a `retired` flag any more (counts)", () => {
    const keys = STAGE_TEMPLATES.map((t) => t.key);
    expect(keys.length, "anti-vacuity: the catalogue was read").toBeGreaterThan(0);
    expect(keys).not.toContain(DELETED);
    expect(new Set(keys).size, "keys are unique").toBe(keys.length);
    // The field existed for this one entry; with it gone nothing may carry it (a leftover is dead code).
    expect(STAGE_TEMPLATES.filter((t) => "retired" in t).map((t) => t.key)).toEqual([]);
  });

  it("no registered sport's offer lists it, not even as the division's current structure (every sport swept, counts)", () => {
    let swept = 0;
    for (const m of builtinModules) {
      const kinds = effectiveEntrantModel(m.entrantModel ?? null, null).kinds;
      const offered = templatesForSport(m.key, kinds).map((t) => t.key);
      expect(offered.length, `${m.key}: something is offered`).toBeGreaterThan(0);
      expect(offered, m.key).not.toContain(DELETED);
      // A division "stored as it" cannot exist: asking for it as the current structure adds nothing.
      expect(templatesForSport(m.key, kinds, DELETED).map((t) => t.key), `${m.key} as current`).toEqual(offered);
      swept++;
    }
    expect(swept).toBe(builtinModules.length);
    expect(swept).toBeGreaterThanOrEqual(11);
  });

  it("an unknown key builds the FIRST template, never a three-leg league (the old key falls through like any unknown key)", () => {
    expect(buildTemplateStages(DELETED, KNOBS)).toEqual(buildTemplateStages(STAGE_TEMPLATES[0]!.key, KNOBS));
  });
});

describe("X-RR-6 a lone league with legs 1 to 8 reads back as league with its leg count", () => {
  // differential: today "triple_rr" for legs >= 3
  it("detectTemplate answers league for every leg count, and the stored count is what a rebuild at that count carries (8 counts)", () => {
    let checked = 0;
    for (let legs = 1; legs <= 8; legs++) {
      const stored = [{ kind: "league", config: { legs }, progression: null }];
      expect(detectTemplate(stored), `legs ${legs}`).toBe("league");
      const rebuilt = buildTemplateStages("league", { ...KNOBS, legs });
      expect((rebuilt[0]!.config as { legs?: number }).legs, `legs ${legs} survives a rebuild`).toBe(legs);
      expect(detectTemplate(rebuilt), `legs ${legs} rebuilt`).toBe("league");
      checked++;
    }
    expect(checked).toBe(8);
    // The empty case: a league with no config at all is one leg, still a league.
    expect(detectTemplate([{ kind: "league" }])).toBe("league");
    expect(detectTemplate([{ kind: "league", config: null }])).toBe("league");
  });
});

describe("X-RR-6 a league with legs 3 is still accepted by the API and builds three legs (RB5-G1; pin, no defect expected)", () => {
  it("the stage schema takes legs 1 to 8 and refuses 0 and 9 (the ceiling stays 8)", () => {
    let accepted = 0;
    for (let legs = 1; legs <= 8; legs++) {
      expect(StageConfig.safeParse({ legs }).success, `legs ${legs}`).toBe(true);
      accepted++;
    }
    expect(accepted).toBe(8);
    expect(StageConfig.safeParse({ legs: 0 }).success).toBe(false);
    expect(StageConfig.safeParse({ legs: 9 }).success).toBe(false);
  });

  it("the engine's own schedule at legs 3 is three times the legs-1 fixture count (premise of the DB pin below)", () => {
    const members = ["a", "b", "c", "d"];
    const seeds = new Map(members.map((m, i) => [m, i + 1]));
    const one = generateRoundRobin({ entrants: members, seeds, config: { legs: 1 } }).fixtures.length;
    const three = generateRoundRobin({ entrants: members, seeds, config: { legs: 3 } }).fixtures.length;
    expect(one).toBe(6);
    expect(three).toBe(18);
  });

  it.skipIf(!HAS_DB)("a league created over the API with legs 3 generates the engine's own count and reads back as league with legs 3", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"T16 " + suffix}, ${"t16-" + suffix}) returning id`;
    await invalidateOrgEntitlements(orgId);
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
      on conflict (key) do nothing`;
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('generic', 'score', 'Score', ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, true)
      on conflict do nothing`;
    const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T16 " + suffix, visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const names = ["A", "B", "C", "D"];
    await createEntrants(
      auth,
      division.id,
      names.map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: { legs: 3 } });
    const { created } = await generateStageFixtures(auth, stage!.id);
    const expected = generateRoundRobin({
      entrants: names,
      seeds: new Map(names.map((n, i) => [n, i + 1])),
      config: { legs: 3 },
    }).fixtures.length;
    expect(created).toBe(expected);
    expect(created).toBe(18);
    const [row] = await sql<{ kind: string; config: { legs?: number } }[]>`select kind, config from stages where id = ${stage!.id}`;
    expect(detectTemplate([{ kind: row!.kind, config: row!.config }])).toBe("league");
    expect(row!.config.legs).toBe(3);
  });
});

describe("X-RR-6 the key is refused by name at the one door that takes a template key", () => {
  it("POST from-template with the deleted key answers 404 TEMPLATE_UNKNOWN_KEY (pin, no defect expected)", async () => {
    const auth: AuthCtx = { orgId: randomUUID(), via: "session", userId: null, role: "owner", keyId: null };
    await expect(
      createFromTemplate(auth, { template_key: DELETED, name: "X", ends_on: "2030-12-31", visibility: "private" }),
    ).rejects.toMatchObject({ status: 404, code: TEMPLATE_UNKNOWN_KEY_CODE });
  });

  it("no schema accepts a STAGE_TEMPLATES key: exactly one input door names a template key, and it is the gallery's (counts)", () => {
    const dir = resolve(HERE, "../../api-v1/schemas");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length, "anti-vacuity: the schema folder was read").toBeGreaterThan(0);
    // An object-key declaration of a template/format key: `template_key: z...`, `templateKey: z...`.
    const FIELD = /^\s*(template_key|templateKey|format_key|formatKey)\s*:/;
    const OUTPUT_BY_NAME = "templateKey"; // FromTemplateResult.templateKey: the result's echo, not an input
    const doors: string[] = [];
    const outputs: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = FIELD.exec(line);
        if (!m) return;
        const where = `${f}:${i + 1} ${m[1]}`;
        // The output field is excluded by NAME and verified to sit in FromTemplateResult, never counted as a door.
        if (m[1] === OUTPUT_BY_NAME) outputs.push(where);
        else doors.push(where);
      });
    }
    expect(outputs, "the one excluded output field").toHaveLength(1);
    expect(doors.length, "input doors found").toBeGreaterThan(0);
    expect(doors, "the gallery's CreateFromTemplate is the one door").toHaveLength(1);
    expect(doors[0]).toMatch(/^stages\.ts:\d+ template_key$/);
    // And the one door sits inside CreateFromTemplate itself (not a neighbouring schema).
    const src = readFileSync(join(dir, "stages.ts"), "utf8");
    expect(src.slice(src.indexOf("export const CreateFromTemplate"), src.indexOf("export type CreateFromTemplate"))).toContain("template_key");
  });
});

describe("X-RR-6 no source names triple_rr", () => {
  const ROOT = resolve(HERE, "../../../../../..");
  // B4 fix wave (T16): every app (not only web's src and e2e) and the migrations (`db`), so a seed row or a second app naming the
  // key is seen.
  const SCOPE = ["apps", "db", "tools/matrix", "content", "scripts", "packages"];
  /** This file's own literals, and the matrix's W5 baseline test: it MEASURES the removal (the W4 run held triple_rr cases, the W5 run
   *  holds none, and the product's row list lacks it), so it has to name the row it proves gone. No door was found, so no refusal
   *  literal exists either. Found at the Task 26 gate: the baseline test (Task 25) landed after this scan and reddened it. */
  const ALLOWLIST = ["apps/web/src/server/usecases/__tests__/triple-rr-deleted.test.ts", "tools/matrix/__tests__/baseline-w5.test.ts"];
  // The key, its kebab and camel spellings, and the two display names it carried (label "Triple round robin", seed "Triple RR").
  const PATTERN = "triple_rr|triple-rr|triplerr|triple rr|triple round";

  function git(args: string[]): string[] {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
    } catch (e) {
      // `git grep` exits 1 for "no match": that is an answer, not a failure.
      if ((e as { status?: number }).status === 1) return [];
      throw e;
    }
  }

  it("every hit sits in the named allowlist, each allowlisted file is present, and files scanned > 0", () => {
    const scanned = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SCOPE]);
    expect(scanned.length, "files scanned").toBeGreaterThan(1000);
    for (const f of ALLOWLIST) expect(existsSync(resolve(ROOT, f)), `${f} is present`).toBe(true);
    // -I skips binaries, -l lists files; case-insensitive over every spelling.
    const hits = git(["grep", "--untracked", "-I", "-l", "-i", "-E", PATTERN, "--", ...SCOPE]);
    // The positive control: the scan CAN see a hit (this file names the key), so an empty list elsewhere is a real answer.
    expect(hits.map((h) => relative(ROOT, resolve(ROOT, h)))).toContain(ALLOWLIST[0]);
    expect(hits.filter((h) => !ALLOWLIST.includes(h)), "files naming the deleted template").toEqual([]);
  });
});
