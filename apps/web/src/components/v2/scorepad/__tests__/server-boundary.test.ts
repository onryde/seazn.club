import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// S12/#421 W10 — the gate for a class of defect that shipped, reached
// production-shaped code, and was caught by NOTHING cheap.
//
// `eventOutToEnvelope` was defined in `scorepad/registry.tsx` (`"use client"`)
// and called from both server page loaders as
// `events.map((e) => eventOutToEnvelope(fixture.id, e))`. React refuses that
// at runtime — "Attempted to call eventOutToEnvelope() from the server but
// eventOutToEnvelope is on the client" — and the whole fixture page renders
// its error boundary.
//
// It survived `tsc --noEmit` (EXIT=0), 3251 unit tests, a green `next build`
// at 237/237 static pages, and `apps/web` lint at 0 errors. It survived
// because `[].map(fn)` NEVER INVOKES `fn`: a fixture with no events yet
// renders perfectly, so the violation only appears once the ledger has its
// first row — one tap past every state those gates exercise.
//
// A type checker cannot see this (the signature is identical either side of
// the boundary) and a bundler will not (the import resolves fine). The only
// other instrument is a prod server with real data. This test is the cheap
// one, so it exists.
//
// THE RULE: a server component may import from a `"use client"` module only
// TYPES, or COMPONENTS it renders as JSX. A plain function value crossing
// that boundary is the defect. Components are identified the way React itself
// identifies them — by an initial capital.

const SCOREPAD_DIR = join(process.cwd(), "src/components/v2/scorepad");
const APP_DIR = join(process.cwd(), "src/app");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function isClientModule(file: string): boolean {
  const head = readFileSync(file, "utf8").slice(0, 200);
  return /^\s*["']use client["']/m.test(head);
}

/** Every `import … from "@/components/v2/scorepad/<mod>"` in a file, with the
 *  raw binding list and whether the whole statement was `import type`. */
function scorepadImports(
  source: string,
): { module: string; bindings: string[]; typeOnly: boolean }[] {
  const out: { module: string; bindings: string[]; typeOnly: boolean }[] = [];
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@\/components\/v2\/scorepad\/([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const bindings = m[2]
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    out.push({ module: m[3], bindings, typeOnly: Boolean(m[1]) });
  }
  return out;
}

describe("scorepad server/client boundary", () => {
  it("wire.ts is server-safe — it carries no 'use client' directive", () => {
    // The whole reason the module exists. If a later edit adds the directive,
    // both page loaders silently break again at the first event.
    expect(isClientModule(join(SCOREPAD_DIR, "wire.ts"))).toBe(false);
  });

  it("no server component imports a plain FUNCTION from a 'use client' scorepad module", () => {
    const clientModules = new Set(
      walk(SCOREPAD_DIR)
        .filter(isClientModule)
        .map((f) => f.slice(SCOREPAD_DIR.length + 1).replace(/\.tsx?$/, "")),
    );
    // Sanity: the sweep must actually be looking at something. A refactor that
    // renamed the directory would otherwise make this test vacuously green —
    // the exact shape of failure this file exists to prevent.
    expect(clientModules.size).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of walk(APP_DIR)) {
      const source = readFileSync(file, "utf8");
      if (/^\s*["']use client["']/m.test(source.slice(0, 200))) continue; // client page, fine
      for (const imp of scorepadImports(source)) {
        if (imp.typeOnly) continue;
        if (!clientModules.has(imp.module)) continue;
        for (const binding of imp.bindings) {
          if (binding.startsWith("type ")) continue;
          const name = binding.split(/\s+as\s+/)[0].trim();
          // A capitalised binding is a component the server renders as JSX,
          // which IS allowed across the boundary. Anything else is a value
          // the server would have to CALL.
          if (/^[A-Z]/.test(name)) continue;
          violations.push(`${file.slice(APP_DIR.length + 1)} imports ${name} from client module ${imp.module}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
