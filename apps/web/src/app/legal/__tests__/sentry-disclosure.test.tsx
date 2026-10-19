import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Browser Sentry went on (owner decisions 2026-10-19: errors only, no session replay), so the privacy page and the sub-processors
// list name Sentry, say what is sent and on what basis, and LEGAL_VERSION moved with the text (owner ruling: 2026-10-20, distinct
// from the 2026-10-19 version PR #994 set for the password removal). The claims about what is NOT sent are pinned to the code
// that makes them true, so the page cannot go on promising what the init no longer does: sentry-client-init.test.ts (no replay,
// no tracing, no logs, the scrub hooks) and sentry-environment.test.ts.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";
import SubProcessorsPage from "../sub-processors/page";
import { LEGAL_VERSION } from "@/lib/legal";

const privacy = renderToStaticMarkup(<PrivacyPage />);
const subProcessors = renderToStaticMarkup(<SubProcessorsPage />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&rsquo;|&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

/** The `<li>` (or `<tr>`) holding a phrase, so a claim is checked where it is made and not anywhere on the page. */
function within(html: string, tag: "li" | "tr", needle: string): string {
  const parts = html.split(new RegExp(`(?=<${tag}[ >])`));
  const hit = parts.filter((p) => p.includes(needle));
  expect(hit, `exactly one <${tag}> holds ${JSON.stringify(needle)}`).toHaveLength(1);
  return text(hit[0]!.slice(0, hit[0]!.indexOf(`</${tag}>`)));
}

describe("the Sentry disclosure: privacy page", () => {
  it("names Sentry as the error-monitoring provider, in the EU, with its legal entity", () => {
    const item = within(privacy, "li", "<strong>Error reports:</strong>");
    expect(item).toContain("Sentry");
    expect(item).toContain("Functional Software, Inc.");
    expect(item).toContain("EU");
  });

  it("says what is sent: error details, stack traces, page addresses with secrets removed, recent in-app activity, browser and device", () => {
    const item = within(privacy, "li", "<strong>Error reports:</strong>");
    for (const phrase of ["error details", "stack trace", "page addresses", "secret", "recent activity", "browser and device"]) {
      expect(item.toLowerCase(), phrase).toContain(phrase);
    }
  });

  it("says what is not, and what a server report may carry: no session recording, no name or email, an internal ID at most", () => {
    const item = within(privacy, "li", "<strong>Error reports:</strong>");
    expect(item).toContain("We do not record your sessions");
    expect(item).toContain("A report from your browser carries no name, email address or account");
    expect(item).toContain("internal user or organisation ID, never a name or email");
  });

  it("gives the legal basis: legitimate interests, keeping the service working (not consent)", () => {
    const basis = within(privacy, "li", "Legitimate interests");
    expect(basis).toContain("error monitoring");
    expect(basis).toContain("keeping the service working");
    // The consent line is still only analytics: error reports are not gated by the cookie banner.
    expect(within(privacy, "li", "Consent</strong>")).not.toContain("Sentry");
  });

  it("points at the sub-processors list, and the cookie section says error monitoring sets no cookies", () => {
    expect(privacy).toContain('href="/legal/sub-processors"');
    expect(text(privacy)).toContain("Sentry error monitoring sets no cookies");
  });
});

describe("the Sentry disclosure: sub-processors list", () => {
  it("lists Sentry as error monitoring in the EU, with a link to its privacy policy", () => {
    const row = within(subProcessors, "tr", "Sentry");
    expect(row).toContain("Sentry (Functional Software, Inc.)");
    expect(row).toContain("Error monitoring");
    expect(row).toContain("EU");
    expect(subProcessors).toContain('href="https://sentry.io/privacy/"');
  });

  it("lists it once, beside the existing processors (nothing else was dropped)", () => {
    const names = [...subProcessors.matchAll(/<td class="font-semibold text-slate-800">([^<]+)<\/td>/g)].map((m) => m[1]);
    expect(names.filter((n) => n!.startsWith("Sentry"))).toHaveLength(1);
    for (const kept of ["Supabase", "Fly.io", "Upstash", "Stripe", "Resend", "Cloudflare", "Anthropic", "OpenRouter"]) expect(names, kept).toContain(kept);
    expect(names.length, "anti-vacuity: the table has rows").toBeGreaterThanOrEqual(11);
  });
});

describe("the version moved with the text", () => {
  it("LEGAL_VERSION is 2026-10-20 or later, so it differs from the 2026-10-19 version the password removal stamped", () => {
    // ISO dates compare as strings. A later bump keeps this true; reverting this change does not.
    expect(LEGAL_VERSION >= "2026-10-20").toBe(true);
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("both pages carry a Last updated line no earlier than the Sentry change", () => {
    for (const [name, html] of [["privacy", privacy], ["sub-processors", subProcessors]] as const) {
      const shown = /Last updated: (\d+) ([A-Za-z]+) (\d{4})/.exec(text(html));
      expect(shown, `${name}: a Last updated line`).not.toBeNull();
      const date = new Date(Date.UTC(Number(shown![3]), ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].indexOf(shown![2]!), Number(shown![1])));
      expect(date.getTime(), `${name}: ${shown![0]}`).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 20));
    }
  });
});

describe("what the page promises is what the code does", () => {
  const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the browser init records no session (so 'we do not record your sessions' is true)", () => {
    const init = stripComments(readFileSync(path.join(web, "src/instrumentation-client.ts"), "utf8"));
    expect(init).not.toMatch(/replayIntegration|replaysSessionSampleRate|replaysOnErrorSampleRate|getReplay/);
    // The control: the pattern sees a recorder, so the absence above is a finding.
    expect(/replayIntegration|replaysSessionSampleRate/.test("Sentry.replayIntegration()")).toBe(true);
  });

  // The page says a BROWSER report carries no account, and a SERVER report may carry an internal ID. Both halves are the code's:
  // exactly one source file calls setUser, it is server-only, and it sets nothing but the id.
  it("only one server-only helper attaches a user to a Sentry event, and only its internal ID (so the page's two sentences are true)", () => {
    const src = path.join(web, "src");
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/__tests__|\.test\.|\.spec\./.test(f))
      .map((f) => ({ file: f, code: stripComments(readFileSync(path.join(src, f), "utf8")) }));
    expect(files.length, "anti-vacuity: the app's source was scanned").toBeGreaterThan(500);
    // The control: the scan reads Sentry call sites (error boundaries report through captureException).
    expect(files.filter((f) => /Sentry\.captureException\(/.test(f.code)).length).toBeGreaterThanOrEqual(3);
    const callers = files.filter((f) => /\bsetUser\s*\(/.test(f.code));
    expect(callers.map((f) => f.file)).toEqual(["lib/sentry.ts"]);
    expect(callers[0]!.code, "server-only, so the browser bundle cannot contain it").toContain('import "server-only"');
    expect(callers[0]!.code.match(/setUser\(([^)]*)\)/)![1], "the id and nothing else").toMatch(/^\{ id: [\w.?]+ \}$/);
    for (const config of ["sentry.server.config.ts", "sentry.edge.config.ts"]) {
      expect(stripComments(readFileSync(path.join(web, config), "utf8")), config).not.toMatch(/sendDefaultPii\s*:\s*true/);
    }
  });
});
