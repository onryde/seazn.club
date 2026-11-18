// pnpm-workspace.yaml's `patchedDependencies` (today: postgres.js, patches/postgres@3.4.9.patch; the yaml says why). Three
// pins, each a way a patch silently stops applying:
//   1. every manifest that declares a patched package declares EXACTLY the patched version. pnpm refuses a patch that no
//      dependency uses (ERR_PNPM_UNUSED_PATCH, measured 2026-11-18), but a manifest moved off the version while another
//      stays on it keeps the patch "used" and quietly gives the moved one an unpatched copy;
//   2. the Dockerfile copies each patch file in before its install: without it `pnpm install --frozen-lockfile` stops with
//      ENOENT on the patch and the image does not build (measured on the Docker build context, 2026-11-18);
//   3. every consumer resolves the copy built from the committed patch, and every entry point the package exports carries
//      the patched `execute` - apps/web/src/lib/__tests__/db-begin-pipeline.test.ts drives the ESM and CommonJS copies, and
//      nothing in node can run the workerd copy the Cloudflare cron worker bundles.
// Single-sport reason: no sport is involved; this is dependency wiring.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
type Manifest = Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

interface Patched {
  name: string;
  version: string;
  file: string;
}

/** The `patchedDependencies:` block of pnpm-workspace.yaml, read by lines (the repo root has no YAML dependency). */
function patchedDependencies(): Patched[] {
  const lines = read("pnpm-workspace.yaml").split("\n");
  const at = lines.findIndex((l) => l.trim() === "patchedDependencies:");
  if (at < 0) return [];
  const out: Patched[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    if (/^\S/.test(l)) break; // the next top-level key
    const m = /^\s+["']?((?:@[^/\s"']+\/)?[^@\s"']+)@([^:\s"']+)["']?:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(l);
    if (m === null) throw new Error(`pnpm-workspace.yaml patchedDependencies line ${JSON.stringify(l)} is not <name>@<version>: <path>`);
    out.push({ name: m[1]!, version: m[2]!, file: m[3]! });
  }
  return out;
}

/** The root and every workspace manifest dir, expanding the `packages:` globs as registry-install.test.ts does. */
function manifestDirs(): string[] {
  const lines = read("pnpm-workspace.yaml").split("\n");
  const at = lines.findIndex((l) => l.trim() === "packages:");
  if (at < 0) throw new Error("pnpm-workspace.yaml has no packages: key");
  const dirs = ["."];
  for (const l of lines.slice(at + 1)) {
    const g = /^\s+-\s+["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(l)?.[1];
    if (g === undefined) break;
    if (!/^[\w.-]+\/\*$/.test(g)) throw new Error(`workspace glob ${g} is not the <dir>/* shape this scan expands: extend the scan`);
    const d = g.slice(0, -2);
    for (const n of readdirSync(path.join(ROOT, d))) if (existsSync(path.join(ROOT, d, n, "package.json"))) dirs.push(`${d}/${n}`);
  }
  return dirs;
}

/** Where each manifest declares `name`: "<dir>: <field>" -> specifier. */
function declarations(name: string): Map<string, { dir: string; spec: string }> {
  const out = new Map<string, { dir: string; spec: string }>();
  for (const dir of manifestDirs()) {
    const m = JSON.parse(read(path.join(dir, "package.json"))) as Manifest;
    for (const f of FIELDS) {
      const spec = m[f]?.[name];
      if (spec !== undefined) out.set(`${dir}/package.json: ${f}`, { dir, spec });
    }
  }
  return out;
}

/** The Dockerfile's instructions: comment lines dropped, `\` continuations joined, as Docker parses them. */
function dockerInstructions(): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of read("Dockerfile").split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const continued = /\\\s*$/.test(raw);
    cur += `${raw.replace(/\\\s*$/, "")} `;
    if (continued) continue;
    if (cur.trim() !== "") out.push(cur.trim().replace(/\s+/g, " "));
    cur = "";
  }
  if (cur.trim() !== "") out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}

const PATCHED = patchedDependencies();

describe("pnpm patchedDependencies: the patch applies everywhere the package is used", () => {
  it("premise: the workspace patches at least one dependency, and every patch file is committed", () => {
    expect(PATCHED.map((p) => `${p.name}@${p.version}`), "patched dependencies read").toContain("postgres@3.4.9");
    for (const p of PATCHED) expect(existsSync(path.join(ROOT, p.file)), `${p.file} exists`).toBe(true);
  });

  it("1. every manifest that declares a patched package pins exactly the patched version", () => {
    let checked = 0;
    const problems: string[] = [];
    for (const p of PATCHED) {
      const decl = declarations(p.name);
      expect(decl.size, `${p.name}: anti-vacuity, declared somewhere`).toBeGreaterThan(0);
      for (const [where, { spec }] of decl) {
        if (spec !== p.version) problems.push(`${where} declares ${p.name} ${JSON.stringify(spec)}, not exactly the patched ${p.version}`);
        checked++;
      }
    }
    expect(problems).toEqual([]);
    console.info(`[patched-dependencies] ${checked} declarations of ${PATCHED.length} patched package(s) checked`);
  });

  it("2. the Dockerfile copies every patch file in before its first pnpm install", () => {
    const instructions = dockerInstructions();
    const install = instructions.findIndex((i) => /^RUN\s/i.test(i) && /\bpnpm\s+install\b/.test(i));
    expect(install, "premise: the Dockerfile runs pnpm install").toBeGreaterThan(0);
    const sources = instructions
      .slice(0, install)
      .filter((i) => /^COPY\s/i.test(i) && !/--from/.test(i))
      .flatMap((i) => i.split(" ").slice(1).filter((t) => !t.startsWith("--")).slice(0, -1));
    expect(sources.length, "premise: COPY sources before the install were read").toBeGreaterThan(0);
    const covers = (src: string, file: string) => src === file || src === "." || file.startsWith(src.endsWith("/") ? src : `${src}/`);
    for (const p of PATCHED) expect(sources.some((s) => covers(s, p.file)), `${p.file} is in the image before the install`).toBe(true);
  });

  it("3. every consumer resolves the copy built from the committed patch, and every exported entry point carries it", () => {
    const pg = PATCHED.find((p) => p.name === "postgres");
    expect(pg, "premise: postgres is patched").toBeDefined();
    const hash = createHash("sha256").update(readFileSync(path.join(ROOT, pg!.file))).digest("hex");
    const consumers = [...new Set([...declarations("postgres").values()].map((d) => d.dir))];
    expect(consumers.length, "anti-vacuity: consumers of postgres").toBeGreaterThan(1);
    const roots = new Set<string>();
    for (const dir of consumers) {
      const entry = realpathSync(createRequire(path.join(ROOT, dir, "package.json")).resolve("postgres"));
      const pkgRoot = /^(.*\/node_modules\/postgres)\//.exec(entry)?.[1];
      expect(pkgRoot, `${dir}: resolves postgres inside a node_modules/postgres`).toBeDefined();
      expect(pkgRoot, `${dir}: resolves the copy built from the committed patch`).toContain(`/postgres@${pg!.version}_patch_hash=${hash}/`);
      roots.add(pkgRoot!);
    }
    expect(roots.size, "every consumer resolves one and the same copy").toBe(1);

    // the entry points the package itself exports (bun, workerd, import, default), each beside its own connection.js
    const [pkgRoot] = [...roots];
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot!, "package.json"), "utf8")) as { version: string; exports: { ".": Record<string, string> } | Record<string, string> };
    expect(pkg.version, "premise: the installed version is the patched one").toBe(pg!.version);
    const map = ("." in pkg.exports ? pkg.exports["."] : pkg.exports) as Record<string, string>;
    const dirs = [...new Set(Object.entries(map).filter(([k]) => k !== "types").map(([, v]) => path.dirname(path.join(pkgRoot!, v))))];
    expect(dirs.map((d) => path.relative(pkgRoot!, d)).sort(), "the copies the package ships: ESM, CommonJS and workerd").toEqual(["cf/src", "cjs/src", "src"]);
    for (const d of dirs) {
      const src = readFileSync(path.join(d, "connection.js"), "utf8");
      const where = path.relative(pkgRoot!, path.join(d, "connection.js"));
      expect(src, `${where}: the hook is no longer the last term of execute's && chain`).not.toContain("&& (!q.options.onexecute || q.options.onexecute(connection))");
      expect(src, `${where}: the hook runs as a statement of its own`).toMatch(/\n\s*const claimed = !q\.options\.onexecute \|\| q\.options\.onexecute\(connection\)\n\s*return room && claimed\n/);
    }
  });
});
