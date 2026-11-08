// One reader for the client's IP (client-IP hardening, 2026-11-07). `lib/client-ip.ts` decides which header names the client
// on this deployment - Fly's peer, Cloudflare's `CF-Connecting-IP` only from a Cloudflare edge carrying our zone's origin stamp,
// and the X-Forwarded-For / X-Real-IP fallback only where there is no Fly peer (local, CI). A limiter that reads one of those
// headers itself skips every one of those checks: behind Cloudflare the first X-Forwarded-For hop is whatever the client wrote,
// so a fresh value per request is a fresh bucket. Seventeen route and page files did exactly that until this sweep's change.
//
// So: no source file under apps/web/src except client-ip.ts may name any of the four headers in executable text. Comments are
// stripped first (with TypeScript's own printer - a regex stripper eats "http://..." strings), so prose that names a header is
// not a read. Tests (`__tests__/`, `*.test.*`, `*.spec.*`) write these headers as fixtures and are not scanned.
//
// Reads that are NOT about who the client is (a public URL built from `x-forwarded-host` / `x-forwarded-proto` in
// lib/base-url.ts, lib/oauth.ts and proxy.ts) name none of the four headers, so they need no exception here.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle (forfeit-vocabulary-scan).
const ts: typeof TS = createRequire(import.meta.url)("typescript");

/** Resolved from THIS file, never `process.cwd()`. */
const WEB = resolve(import.meta.dirname, "../../.."); // apps/web
const SRC = join(WEB, "src");

/** The headers that name a client's address on this deployment - the brief's list, typed here, not read from the module. */
const IP_HEADERS = ["x-forwarded-for", "x-real-ip", "fly-client-ip", "cf-connecting-ip"] as const;
/** A read: one of them as a whole string literal (quotes, apostrophes or backticks), any case - a `.get(...)` argument, a
 *  constant, an index. */
const READ = new RegExp(`["'\`](${IP_HEADERS.join("|")})["'\`]`, "gi");
/** The cheap pre-filter: a file whose raw text never names a header cannot read one, so only the rest are parsed. */
const MENTION = new RegExp(IP_HEADERS.join("|"), "i");

/** The files allowed to read them, each with its reason. An allowance that no longer reads is stale, and fails. */
const ALLOWED: Record<string, string> = {
  "src/lib/client-ip.ts": "the one reader: it decides which header to believe (Fly's peer, Cloudflare's ranges, the origin stamp)",
};

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Every non-test source file under `root`, relative to apps/web. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (entry.isFile() && SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(relative(WEB, path));
    }
  }
  return out;
}

/** Every source file under `root`, tests included (the import check), relative to apps/web. */
function everyFile(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...everyFile(path));
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      out.push(relative(WEB, path));
    }
  }
  return out;
}

const printer = ts.createPrinter({ removeComments: true });
/** The file's executable text: comments removed by the TypeScript printer. */
function code(path: string, text: string): string {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return printer.printFile(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind));
}

/** Each file that reads, with the headers it names (lower-cased, one entry per read). */
function census(files: string[]): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(join(WEB, file), "utf8");
    if (!MENTION.test(text)) continue;
    const found = [...code(file, text).matchAll(READ)].map((m) => m[1]!.toLowerCase());
    if (found.length > 0) reads.set(file, found);
  }
  return reads;
}

describe("the client's IP has one reader: lib/client-ip.ts", () => {
  const files = sourceFiles(SRC);
  const reads = census(files);
  const total = [...reads.values()].reduce((n, r) => n + r.length, 0);
  // The count this sweep owes: how much it scanned and how much it found.
  console.info(`client-ip sweep: scanned ${files.length} source files under apps/web/src, found ${total} reads in ${reads.size} files`);

  it("scans the source tree: a non-zero count that reaches the reader itself and a limiter beside it (zero scanned is a failure)", () => {
    expect(files.length, "files scanned").toBeGreaterThan(0);
    expect(files).toContain("src/lib/client-ip.ts");
    expect(files).toContain("src/app/s/[key]/route.ts");
    expect(files.some((f) => TEST_FILE.test(f) || f.includes("/__tests__/")), "tests are not scanned").toBe(false);
  });

  it("the reader reads every one of the four headers (the matcher's positive control), and no allowance is stale", () => {
    expect(new Set(reads.get("src/lib/client-ip.ts"))).toEqual(new Set(IP_HEADERS));
    for (const file of Object.keys(ALLOWED)) expect(reads.get(file)?.length ?? 0, `${file} no longer reads: drop its allowance`).toBeGreaterThan(0);
  });

  it("no other source file reads x-forwarded-for, x-real-ip, fly-client-ip or cf-connecting-ip - it calls clientIp(headers)", () => {
    const offenders = [...reads].filter(([file]) => !(file in ALLOWED)).map(([file, found]) => `${file}: ${[...new Set(found)].join(", ")}`);
    expect(offenders, `reads found outside lib/client-ip.ts (${offenders.length} files):\n  ${offenders.join("\n  ")}\n`).toEqual([]);
  });

  // The literal scan above has one way round it: a header NAME exported from the reader and read through elsewhere
  // (`h.get(XFF)`). So the reader exports no string constant at all (fix round 1, M5), and no file - tests included - imports
  // from it anything but its non-string exports.
  it("client-ip.ts exports no string constant, and no file imports one from it (import sites counted; zero is a failure)", () => {
    const reader = code("src/lib/client-ip.ts", readFileSync(join(WEB, "src/lib/client-ip.ts"), "utf8"));
    const exported = [...reader.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]!);
    const strings = [...reader.matchAll(/export\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*["'`]/g)].map((m) => m[1]!);
    expect(exported, "the reader's own exports are read (positive control)").toContain("clientIp");
    expect(strings, "string constants exported from lib/client-ip.ts").toEqual([]);
    const importable = new Set(exported.filter((name) => !strings.includes(name)));
    const sites: string[] = [];
    const bad: string[] = [];
    for (const file of everyFile(SRC)) {
      const text = readFileSync(join(WEB, file), "utf8");
      if (!text.includes("client-ip")) continue;
      for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*\/client-ip["']/g)) {
        sites.push(file);
        for (const spec of m[1]!.split(",")) {
          const name = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!;
          if (name && !importable.has(name)) bad.push(`${file}: ${name}`);
        }
      }
    }
    console.info(`client-ip sweep: ${sites.length} named imports of lib/client-ip; importable: ${[...importable].join(", ")}`);
    expect(sites.length, "import sites found").toBeGreaterThan(0);
    expect(bad, `names imported from lib/client-ip that it does not export as a function or a list:\n  ${bad.join("\n  ")}\n`).toEqual([]);
  });
});
