// scripts/w2d/ddl-mutants.ts (W2d Task 7, review m6): the driver mutates a database's catalog, so its guard is the part
// that must never be wrong — it runs on a seazn-env LABEL database on this machine or not at all. The empty case first
// (no URL), then each refusal, then what it accepts; and the mutant table it builds from the delta's own text.
// Single-sport reason: no sport is involved — this is a URL and catalog-text check.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LINES_TEST, PIN_TEST, ddlMutants, deltaFunction, labelDataDirectory, labelDbOf } from "../w2d/ddl-mutants.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const DELTAS = join(REPO, "db/migration/deltas");
const delta = (() => {
  const files = readdirSync(DELTAS).filter((f) => /^V\d+__w2d_table_rules\.sql$/.test(f));
  if (files.length !== 1) throw new Error(`premise: one W2d delta, found ${files.length}`);
  return readFileSync(join(DELTAS, files[0]!), "utf8");
})();

describe("ddl-mutants: the label-database guard", () => {
  it("refuses no URL, an unparsable one, another protocol, a remote host, and a database that is no seazn-env label (counted)", () => {
    const refused: [string | undefined, RegExp][] = [
      [undefined, /DATABASE_URL is required/],
      ["", /DATABASE_URL is required/],
      ["not a url", /does not parse/],
      ["mysql://root@127.0.0.1:3306/seazn_x", /not a postgres URL/],
      ["postgresql://postgres:s3cret@db.staging.example.com:5432/seazn_w2d-t7", /refusing host db\.staging\.example\.com/],
      ["postgresql://postgres@10.0.0.5:5432/seazn_w2d-t7", /refusing host/],
      ["postgresql://postgres@127.0.0.1.example.com:5432/seazn_w2d-t7", /refusing host/],
      ["postgresql://postgres@127.0.0.1:54788/postgres", /seazn_<label>/],
      ["postgresql://postgres@127.0.0.1:54788/seazn", /seazn_<label>/],
      ["postgresql://postgres@127.0.0.1:54788/seazn_", /seazn_<label>/],
      ["postgresql://postgres@localhost:54788/seazn_W2D", /seazn_<label>/],
    ];
    let checked = 0;
    for (const [url, why] of refused) {
      expect(() => labelDbOf(url), String(url)).toThrow(why);
      checked++;
    }
    expect(checked).toBe(refused.length);
  });

  it("never echoes the URL it refuses (it may carry a password)", () => {
    for (const url of ["postgresql://u:s3cret@db.staging.example.com/seazn_x", "postgresql://u:s3cret@127.0.0.1/prod", "s3cret:://"]) {
      let message = "";
      try {
        labelDbOf(url);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, url).not.toBe("");
      expect(message).not.toContain("s3cret");
    }
  });

  it("accepts a label database on 127.0.0.1 or localhost, and names its label and data directory", () => {
    expect(labelDbOf("postgresql://postgres@127.0.0.1:54788/seazn_w2d-t7")).toEqual({ host: "127.0.0.1", database: "seazn_w2d-t7", label: "w2d-t7" });
    expect(labelDbOf("postgres://postgres@localhost/seazn_abc").label).toBe("abc");
    expect(labelDataDirectory("w2d-t7", "/tmp/seazn-env")).toBe("/tmp/seazn-env/w2d-t7/pg");
    expect(labelDataDirectory("w2d-t7", "/tmp/seazn-env/")).toBe("/tmp/seazn-env/w2d-t7/pg");
  });
});

describe("ddl-mutants: the mutant table", () => {
  it("builds every mutant against the delta's own text: unique ids, each apply differs from its restore, each names a killer", () => {
    const mutants = ddlMutants("seazn_club", delta);
    expect(new Set(mutants.map((m) => m.id)).size).toBe(mutants.length);
    let checked = 0;
    for (const m of mutants) {
      expect(m.apply, m.id).not.toBe(m.restore);
      expect([PIN_TEST, LINES_TEST], m.id).toContain(m.killer);
      checked++;
    }
    expect(checked).toBe(16);
    // the read-function mutants restore to the delta's own definition, placeholder filled
    const fn = mutants.filter((m) => m.id.startsWith("F"));
    expect(fn).toHaveLength(1);
    const srcCols = (text: string) => new Set([...text.matchAll(/\bsrc\.([a-z_]+)/g)].map((x) => x[1]));
    for (const m of fn) {
      expect(m.restore).toBe(deltaFunction(delta, "stage_qualification_meta", "seazn_club"));
      expect(m.restore).not.toContain("${flyway:defaultSchema}");
      expect(m.restore).toContain("set search_path = seazn_club, pg_temp");
      // A mutant reads only what the function's own `src` carries: one naming a column the delta has since dropped
      // (T9 r1 dropped `table_points`) fails to apply instead of testing anything.
      const own = srcCols(m.restore);
      expect(own.size, `${m.id}: premise, the function reads src`).toBeGreaterThan(0);
      for (const c of srcCols(m.apply)) expect(own, `${m.id}: src.${c}`).toContain(c);
    }
  });

  it("refuses a function the delta does not define once", () => {
    expect(() => deltaFunction(delta, "no_such_function", "seazn_club")).toThrow(/0 time\(s\)/);
    expect(() => deltaFunction(`${delta}\ncreate or replace function stage_qualification_meta(x int) returns int language sql as $$ select 1 $$;`, "stage_qualification_meta", "s")).toThrow(/2 time\(s\)/);
  });
});
