// Test-only file-system scans shared by the scrub suites: which app routes carry a credential, found from the app's own
// directories and builders rather than typed into a test. Not a test file (no `.test.` in the name), so vitest never
// collects it.
//
//  - `secretRoutes()` + `VERDICTS`: every `app/**` directory named like a secret (`[token]`, `[code]`, `[secret]`, `[ref]`),
//    the URLs and the route HANDLERS beneath it, and the verdict on each (a credential, or why it is knowingly public).
//  - `linkBuilders()` + `NOT_ONE_TIME`: every `<path>?…token=${…}` link the app builds, and the one that is knowingly reusable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const APP_DIR = path.join(SRC_DIR, "app");

/** A route directory name that is a secret: `[token]`, `[code]`, `[secret]` or `[ref]`. */
const SECRET_SEGMENT = /^\[(token|code|secret|ref)\]$/;
const hasEntry = (dir: string) => ["page.tsx", "route.ts", "route.tsx"].some((f) => fs.existsSync(path.join(dir, f)));
const hasHandler = (dir: string) => ["route.ts", "route.tsx"].some((f) => fs.existsSync(path.join(dir, f)));

export interface SecretRoute {
  /** The directory under app/, route groups kept: the key the verdicts below are written against. */
  key: string;
  /** Every URL under it that serves something, with the secret segment filled in by `secret`. */
  urls: (secret: string) => string[];
  /** The route HANDLERS (`route.ts`) under it, each with its own directory key, and its URL for a given secret. */
  handlers: { key: string; url: (secret: string) => string }[];
}

/** Every `app/**` directory named like a secret, with the URLs beneath it (its own, its children's, its image). */
export function secretRoutes(): SecretRoute[] {
  const found: SecretRoute[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (SECRET_SEGMENT.test(entry.name)) {
        const key = path.relative(APP_DIR, full);
        const suffixes: string[] = [];
        const handlerSuffixes: { key: string; suffix: string }[] = [];
        const below = (d: string, rel: string) => {
          if (hasEntry(d)) suffixes.push(rel);
          if (hasHandler(d)) handlerSuffixes.push({ key: path.relative(APP_DIR, d), suffix: rel });
          if (fs.existsSync(path.join(d, "opengraph-image.tsx"))) suffixes.push(`${rel}/opengraph-image`);
          for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) below(path.join(d, e.name), `${rel}/${e.name}`);
        };
        below(full, "");
        const toUrl = (secret: string, suffix: string) =>
          "/" +
          key
            .split("/")
            .filter((seg) => !/^\(.*\)$/.test(seg))
            .map((seg) => (SECRET_SEGMENT.test(seg) ? secret : /^\[.*\]$/.test(seg) ? "00000000-0000-4000-8000-000000000001" : seg))
            .join("/") +
          suffix;
        found.push({
          key,
          urls: (secret) => suffixes.map((s) => toUrl(secret, s)),
          handlers: handlerSuffixes.map((h) => ({ key: h.key, url: (secret) => toUrl(secret, h.suffix) })),
        });
      }
      walk(full);
    }
  };
  walk(APP_DIR);
  return found;
}

/** The verdict on each secret route: `true` = a credential, scrubbed; a string = why it is deliberately not scrubbed. */
export const VERDICTS: Record<string, true | string> = {
  "join/[token]": true,
  "checkin/[token]": true,
  "claim/[token]": true,
  "score/[token]": true,
  "api/invites/[token]": true,
  "api/checkin/[token]": true,
  "api/claims/[token]": true,
  "api/orgs/[id]/invites/[token]": true,
  "api/v1/capture/codes/[code]": true,
  "refer/[code]": "a referral link is shared in public on purpose; it only drops an attribution cookie",
  "(public)/r/[ref]": "a registration reference is a lookup, not auth; the emailed ?token= authorises a withdrawal",
  "api/v1/public/registrations/by-ref/[ref]": "the same reference; the withdrawal token rides the request body",
};

/** Every `<path>?…token=${…}` template the app builds: the route a link is built FOR, mapped to where it is built. */
let scanned: Map<string, string> | undefined;
export function linkBuilders(): Map<string, string> {
  if (scanned) return scanned;
  const found = new Map<string, string>();
  const builder = /(\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)\?(?:[^`\s]*&)?token=\$\{/g;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && entry.name !== "scrub-score-url.ts") {
        const text = fs.readFileSync(full, "utf8");
        if (!text.includes("token=${")) continue;
        for (const m of text.matchAll(builder)) if (!found.has(m[1]!)) found.set(m[1]!, path.relative(SRC_DIR, full));
      }
    }
  };
  walk(SRC_DIR);
  return (scanned = found);
}

/** Builders whose token is NOT a one-time credential, each with the reason; the scrubber must leave them alone. */
export const NOT_ONE_TIME: Record<string, string> = {
  "/register/status": "the cart's access token (RS006): reusable, the status page is re-opened to view and withdraw",
};
