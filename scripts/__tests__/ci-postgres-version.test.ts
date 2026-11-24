// Every Postgres service container CI starts runs the major version production runs.
//
// Production and staging run PostgreSQL 17.x (17.6 when this was written, owner
// 2026-11-23/24), and CI ran `postgres:16`: a migration or a query that behaves one
// way on 16 and another on 17 (planner, `MERGE`, `pg_stat_*` flush timing, the
// `COPY` and `JSON_TABLE` additions) went green here and met a different engine
// there. The tag is the floating major, `postgres:17`, not a pinned minor: the owner
// asked to follow the 17 line, and a pinned minor would be one more thing to bump.
//
// The count is the point of this file, as much as the tag. A guard that scans the
// workflow files and finds nothing passes on any tag, so the scan reports how many
// service images it judged and ZERO is a failure (TEST-STRATEGY: anti-vacuity). The
// expected tag is stated here, never read back from a workflow: reading it from the
// file under test would prove the file agrees with itself.
//
// Read as text, like the repo's other workflow guards (no YAML library is a declared
// root dependency, and toolchain.test.ts enforces that).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const WORKFLOWS = join(REPO, ".github/workflows");
const WANTED = "postgres:17";

/** Every `image:` line naming Postgres, as `file:line  <tag as written>`; comments dropped. */
const postgresImages = (): { where: string; image: string }[] => {
  const out: { where: string; image: string }[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    readFileSync(join(WORKFLOWS, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        const m = /^\s*image:\s*["']?(postgres(?:[:@][^\s"']*)?)["']?\s*(?:#.*)?$/.exec(line);
        if (m) out.push({ where: `${file}:${i + 1}`, image: m[1]! });
      });
  }
  return out;
};

describe("CI Postgres service images", () => {
  it(`every Postgres service container in .github/workflows is ${WANTED}, and at least one was judged`, () => {
    const found = postgresImages();
    // Anti-vacuity: the scan must have reached the workflows' service blocks.
    expect(found.length, "Postgres service images found in .github/workflows").toBeGreaterThan(0);
    expect(
      found.filter((f) => f.image !== WANTED).map((f) => `${f.where} ${f.image}`),
      `${found.length} service image(s) judged`,
    ).toEqual([]);
  });

  it("no workflow names another Postgres major anywhere else (a client install, a docker run, a version pin)", () => {
    let judged = 0;
    const stray: string[] = [];
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      readFileSync(join(WORKFLOWS, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          judged++;
          // `postgres:16`, `postgresql@16`, `postgresql-client-16`, `postgres-16`, `PG_MAJOR=16`, `pg_dump-16`.
          if (/postgres(?:ql)?[:@\-_ ]?(?:client-)?1[0-9]\b|PG_MAJOR|pg_(?:dump|restore)[-_ ]?1[0-9]\b/i.test(line) && !line.includes(WANTED)) {
            stray.push(`${file}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(judged, "workflow lines scanned").toBeGreaterThan(1000);
    expect(stray).toEqual([]);
  });

  it("scripts/ci-pg-fast.sh finds the service container by the SAME tag the workflows start", () => {
    // It looks the container up with `docker ps --filter ancestor=<tag>`: a tag that
    // drifted from the workflows' would find no container and fail every DB job at its
    // tuning step, a red nobody reads as "the Postgres version".
    const script = readFileSync(join(REPO, "scripts/ci-pg-fast.sh"), "utf8");
    const filters = [...script.matchAll(/ancestor=(postgres:[^\s"']+)/g)].map((m) => m[1]);
    expect(filters, "ancestor= filters in ci-pg-fast.sh").toHaveLength(1);
    expect(filters[0]).toBe(WANTED);
    // The error message names the tag too: it is what a person reads when the lookup fails.
    expect(script).toContain(`no ${WANTED} service container found`);
  });
});
