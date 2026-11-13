// Reads the route tree under src/app/api and says, for EVERY exported write handler (POST, PUT, PATCH, DELETE), what stands in
// front of it. Used by turnstile-gate.test.ts to prove that a handler which anyone on the internet can call is either bot-checked
// or on a reviewed exempt list, and that everything else is held back by something this file can DETECT in the source.
//
// A handler is classified by what its own body (comments stripped) contains, first match wins:
//
//   gated      `requireTurnstile(req, "<action>")`                      the Cloudflare bot check
//   identity   a session / API key / device link / seat-token door       requireResourceAuth, requireOrgAuth, requireAuth,
//                                                                       requireFixtureActor, requireUser, requireOrgRole, matchRoomIdentity
//   staff      the staff console doors                                   requireStaff, requireSuperadmin
//   billing    the group payer's door                                    requireBillingOwner
//   cron       a shared-secret header                                    reads `x-cron-secret` against CRON_SECRET (cron, peer revalidate, funnel/remind)
//   webhook    a verified signature                                      constructEvent( / verifySignature(
//   harness    a fake-driver control route                               fakeControlEnabled( / youtubeFakeRoutesEnabled( (404 outside a harness)
//   bearer     a minted bearer credential read off the request           bearerOf( / captureBearer(  (both throw without one)
//   session401 `getCurrentUser()` or `getCurrentSession()` and an explicit 401 in the same body  (the legacy "Unauthorized"
//              shape; the session form is the one that can also read an impersonation, quick match /api/quick-match/<id>)
//   via-usecase  none of the above in the handler, but a usecase function it calls (imported from "@/server/...") contains a
//              billing / identity / staff door: one hop, no further
//   anonymous  nothing detectable: this is the class the gate test requires to be gated or on the exempt list
//
// Limits, stated so nobody over-reads a green: a guard call that sits inside a branch is still a guard call to this reader, and a
// guard reached through a helper two hops away is invisible (such a handler lands in `anonymous` and has to be argued for on the
// exempt list, which is the safe direction). It reads source; it proves a door EXISTS, not that the door is correct.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

export const WRITE_VERBS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type WriteVerb = (typeof WRITE_VERBS)[number];

export type RouteClass =
  | "gated"
  | "identity"
  | "staff"
  | "billing"
  | "cron"
  | "webhook"
  | "harness"
  | "bearer"
  | "session401"
  | "via-usecase"
  | "anonymous";

const IDENTITY = /\b(?:requireResourceAuth|requireOrgAuth|requireAuth|requireFixtureActor|requireUser|requireOrgRole|matchRoomIdentity)\(/;
const STAFF = /\b(?:requireStaff|requireSuperadmin)\(/;
const BILLING = /\brequireBillingOwner\(/;
const ANY_DOOR = new RegExp(`${IDENTITY.source}|${STAFF.source}|${BILLING.source}`);
const GATE_CALL = /\brequireTurnstile\(\s*req\s*,\s*"([a-z]+)"\s*\)/g;

/** Drop block comments and line comments, so a guard NAMED in a comment is not a guard CALLED. A `//` right after a colon is a URL. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export interface Handler {
  /** Path under src/app/api, e.g. `v1/public/registrations/[id]/withdraw/route.ts`. */
  file: string;
  verb: WriteVerb;
  /** The handler's source, comments stripped: from its `export` to the next top-level `export`. */
  body: string;
  /** The whole file, comments stripped (for the imports a one-hop check follows). */
  source: string;
}

/** Every exported write handler in one route file: `export [async] function POST`, `export const POST =`, `export { x as POST }`. */
export function writeHandlers(file: string, rawSource: string): Handler[] {
  const source = stripComments(rawSource);
  const out: Handler[] = [];
  const verb = WRITE_VERBS.join("|");
  const exportStarts = [...source.matchAll(/^export\b/gm)].map((m) => m.index!);
  const declared = new RegExp(`export\\s+(?:async\\s+)?function\\s+(${verb})\\b|export\\s+(?:const|let|var)\\s+(${verb})\\b`, "g");
  for (const m of source.matchAll(declared)) {
    const next = exportStarts.find((s) => s > m.index!);
    out.push({ file, verb: (m[1] ?? m[2]) as WriteVerb, body: source.slice(m.index!, next ?? source.length), source });
  }
  // A re-export names no body to read: it is classified on that bare line, so it lands in `anonymous` and has to be argued for.
  for (const m of source.matchAll(/export\s*\{([^}]*)\}[^;\n]*/g)) {
    for (const spec of m[1]!.split(",")) {
      const exported = spec.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
      if ((WRITE_VERBS as readonly string[]).includes(exported)) out.push({ file, verb: exported as WriteVerb, body: m[0], source });
    }
  }
  return out;
}

/** The actions a body asks Cloudflare for. */
export function gatedActions(body: string): string[] {
  return [...body.matchAll(GATE_CALL)].map((m) => m[1]!);
}

/** The body of `export [async] function <name>` in a module, or "" when there is none. */
function functionBody(moduleSource: string, name: string): string {
  const src = stripComments(moduleSource);
  const m = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(src);
  if (!m) return "";
  const next = [...src.matchAll(/^export\b/gm)].map((x) => x.index!).find((s) => s > m.index);
  return src.slice(m.index, next ?? src.length);
}

/** `import { a, b as c } from "@/server/..."` -> [{ name: "a", from: "@/server/..." }, ...] (the imported name, not the alias). */
function serverImports(source: string): { name: string; local: string; from: string }[] {
  const out: { name: string; local: string; from: string }[] = [];
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](@\/server\/[^"']+)["']/g)) {
    for (const spec of m[1]!.split(",")) {
      const [name, local] = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/).map((x) => x.trim());
      if (name) out.push({ name, local: local ?? name, from: m[2]! });
    }
  }
  return out;
}

export interface ClassifyDeps {
  /** Source of a module named by an `@/server/...` import, or undefined when it does not resolve. */
  readModule: (specifier: string) => string | undefined;
}

export function classifyHandler(h: Handler, deps: ClassifyDeps): RouteClass {
  const b = h.body;
  if (gatedActions(b).length > 0) return "gated";
  if (IDENTITY.test(b)) return "identity";
  if (STAFF.test(b)) return "staff";
  if (BILLING.test(b)) return "billing";
  if (/x-cron-secret/i.test(b) && /\bCRON_SECRET\b/.test(h.source)) return "cron";
  if (/\b(?:constructEvent|verifySignature)\(/.test(b)) return "webhook";
  if (/\b(?:fakeControlEnabled|youtubeFakeRoutesEnabled)\(/.test(b)) return "harness";
  if (/\b(?:bearerOf|captureBearer)\(/.test(b)) return "bearer";
  if (/\bgetCurrent(?:User|Session)\(/.test(b) && /\b401\b/.test(b)) return "session401";
  for (const imp of serverImports(h.source)) {
    if (!new RegExp(`\\b${imp.local}\\(`).test(b)) continue;
    const mod = deps.readModule(imp.from);
    if (mod !== undefined && ANY_DOOR.test(functionBody(mod, imp.name))) return "via-usecase";
  }
  return "anonymous";
}

export function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === "route.ts" ? [p] : [];
  });
}

/** Read every route file under `apiDir` and classify each write handler. `srcDir` resolves the `@/` alias for the one-hop read. */
export function classifyTree(apiDir: string, srcDir: string): { handler: Handler; cls: RouteClass }[] {
  const readModule = (specifier: string): string | undefined => {
    const base = resolve(srcDir, specifier.replace(/^@\//, ""));
    for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    return undefined;
  };
  return routeFiles(apiDir)
    .flatMap((abs) => writeHandlers(relative(apiDir, abs), readFileSync(abs, "utf8")))
    .map((handler) => ({ handler, cls: classifyHandler(handler, { readModule }) }));
}
