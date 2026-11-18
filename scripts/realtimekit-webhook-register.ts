// One-off operator step (check-in capacity plan 1, T8): registers the RealtimeKit PRESENCE webhook with Cloudflare, once per
// environment, at the staging gate. The receiving route is apps/web's /api/webhooks/realtimekit.
//
//   npm run realtimekit:webhook-register -- --url https://<env host>/api/webhooks/realtimekit --dry-run   # prints the wanted body, calls nothing
//   npm run realtimekit:webhook-register -- --url https://<env host>/api/webhooks/realtimekit             # registers it
//   (optional) --name seazn-presence                                                                       # the webhook's name; default seazn-presence
//   (optional) --force                                                                                     # allow moving an existing webhook to ANOTHER host
//
// It needs that environment's CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_API_TOKEN and REALTIMEKIT_APP_ID (REALTIMEKIT_BASE_URL only for a
// fixture); a dry run needs none. Idempotent: it lists the app's webhooks, PATCHes the one of that name to the wanted
// url/events/enabled, or POSTs one when there is none, so a second run changes nothing.
//
// ONE APP, TWO ENVIRONMENTS. The webhook is matched by NAME, and staging and production may share one RealtimeKit app: the second
// environment's run would then re-point the first's webhook at itself, silently. A PATCH that changes the url's HOST is therefore
// refused (exit 1, both hosts named) unless --force; a path change on the same host is this environment's own and goes through.
// The OK line prints the vendor base's host, the account and app ids, and the ISO time the vendor answered: that time is T_reg
// (plan 1 Task 12 step 2), the shadow report's --since.
//
// Endpoints (confirmed against Cloudflare's OpenAPI, 2026-11-17): GET and POST /accounts/{account}/realtime/kit/{app}/webhooks,
// PATCH .../webhooks/{id}, Bearer auth, answers `{ success, data }`. The three events are members of the vendor's event enum.
//
// Exit codes: 0 done, 1 the vendor refused or could not be reached, or a cross-host PATCH without --force, 2 usage or configuration. Output carries statuses, paths
// and the webhook's id only: never the token, and never a vendor response body or a transport error (both can quote it).
//
// Self-contained on purpose: relative or bare imports only, never `@/` (a root script runs under nodenext and cannot resolve the
// alias; see scripts/stripe-connect-fixture.ts). The test (apps/web/src/server/__tests__/realtimekit-webhook-register.test.ts)
// imports `registrationPlan` and `run` by relative path with an injected fetch.
import { isMainModule } from "./lib/main-module.ts";

/** The events presence needs: a join, a leave, and the room ending (which closes every open row of the meeting). */
export const PRESENCE_WEBHOOK_EVENTS = ["meeting.participantJoined", "meeting.participantLeft", "meeting.ended"] as const;

export type VendorWebhook = { id: string; name: string; url: string; events: string[]; enabled: boolean };

const DEFAULT_NAME = "seazn-presence";
const CF_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
const VENDOR_ID = /^[\w-]{1,64}$/;

/** Pure: what to send. An existing webhook of the same name is PATCHed to the wanted url/events/enabled; none is POSTed.
 *  `path` is relative to the app's `/accounts/{account}/realtime/kit/{app}` prefix. */
export function registrationPlan(
  existing: readonly VendorWebhook[],
  want: { name: string; url: string },
): { method: "POST" | "PATCH"; path: string; body: { name: string; url: string; events: string[]; enabled: true }; currentUrl?: string } {
  const body = { name: want.name, url: want.url, events: [...PRESENCE_WEBHOOK_EVENTS], enabled: true as const };
  const found = existing.find((w) => w.name === want.name);
  return found
    ? { method: "PATCH", path: `/webhooks/${encodeURIComponent(found.id)}`, body, currentUrl: typeof found.url === "string" ? found.url : "" }
    : { method: "POST", path: "/webhooks", body };
}

/** A url's host (with any port, lower-cased by URL), or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

type Parsed = { url: string; name: string; dryRun: boolean; force: boolean } | { error: string };

function parseArgs(argv: readonly string[]): Parsed {
  let url: string | undefined;
  let name = DEFAULT_NAME;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--url" || a === "--name") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value.` };
      if (a === "--url") url = v;
      else name = v;
    } else return { error: `Unknown argument ${a}.` };
  }
  if (!url) return { error: "--url <https://…/api/webhooks/realtimekit> is required." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "--url is not a URL." };
  }
  if (parsed.protocol !== "https:") return { error: "--url must be https: the vendor delivers to a public https endpoint." };
  if (name.trim() === "") return { error: "--name must not be empty." };
  return { url, name, dryRun, force };
}

function isWebhook(x: unknown): x is VendorWebhook {
  if (typeof x !== "object" || x === null) return false;
  const w = x as Record<string, unknown>;
  return typeof w.id === "string" && typeof w.name === "string";
}

/** The CLI body, exported for the test. Returns the exit code. */
export async function run(
  argv: readonly string[],
  deps: { fetch: typeof fetch; env: NodeJS.ProcessEnv; out?: (line: string) => void; now?: () => Date },
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const args = parseArgs(argv);
  if ("error" in args) {
    out(`${args.error} Usage: --url <https://…/api/webhooks/realtimekit> [--name ${DEFAULT_NAME}] [--dry-run] [--force]`);
    return 2;
  }
  const want = { name: args.name, url: args.url };

  if (args.dryRun) {
    out("DRY RUN: nothing is sent.");
    out(`Would list the app's webhooks, then PATCH the one named "${want.name}" or POST a new one, with:`);
    out(JSON.stringify(registrationPlan([], want).body));
    return 0;
  }

  const { env } = deps;
  const missing = ["CLOUDFLARE_ACCOUNT_ID", "REALTIMEKIT_API_TOKEN", "REALTIMEKIT_APP_ID"].filter((k) => !env[k]);
  if (missing.length > 0) {
    out(`RealtimeKit is not configured: ${missing.join(", ")} must be set.`);
    return 2;
  }
  // `||`, not `??`: a blank `REALTIMEKIT_BASE_URL=` line in an env file is the empty string, which means "unset", never "call a relative URL".
  const base = (env.REALTIMEKIT_BASE_URL || CF_BASE).replace(/\/$/, "");
  const prefix = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;

  // One vendor call. A transport error can quote the URL and a vendor body can quote the token: neither is printed.
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; json: unknown } | null> => {
    let res: Response;
    try {
      res = await deps.fetch(`${base}${prefix}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      out(`FAILED: ${method} ${path} did not complete.`);
      return null;
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      out(`FAILED: ${method} ${path} answered ${res.status}.`);
      return null;
    }
    return { status: res.status, ok: true, json };
  };

  const listed = await call("GET", "/webhooks");
  if (!listed) return 1;
  const data = (listed.json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    out("FAILED: GET /webhooks answered without a webhook list; nothing was changed.");
    return 1;
  }
  const plan = registrationPlan(data.filter(isWebhook), want);
  if (plan.method === "PATCH" && !args.force) {
    const wantHost = hostOf(want.url);
    const currentHost = hostOf(plan.currentUrl ?? "");
    if (currentHost !== wantHost) {
      out(
        `REFUSED: the existing webhook "${want.name}" delivers to ${currentHost ?? "(an unparseable url)"}, not ${wantHost}. ` +
          "Another environment may share this RealtimeKit app; nothing was changed. Re-run with --force to move it.",
      );
      return 1;
    }
  }
  out(`${plan.method} ${plan.path}: ${JSON.stringify(plan.body)}`);
  const done = await call(plan.method, plan.path, plan.body);
  if (!done) return 1;
  const w = (done.json as { data?: unknown } | null)?.data;
  // Printed only when it looks like an id: a vendor body can quote anything (the token, a line break), and an id is all this line is for.
  const id = isWebhook(w) && VENDOR_ID.test(w.id) ? w.id : "(not returned)";
  const answeredAt = (deps.now ?? (() => new Date()))().toISOString();
  out(
    `OK: ${plan.method} ${plan.path} answered ${done.status}. Webhook "${want.name}" id=${id} ` +
      `host=${hostOf(base) ?? "(unparseable base)"} account=${env.CLOUDFLARE_ACCOUNT_ID} app=${env.REALTIMEKIT_APP_ID} T_reg=${answeredAt}.`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), { fetch, env: process.env });
}
