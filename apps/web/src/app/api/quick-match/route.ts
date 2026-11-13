// POST /api/quick-match: the guest's setup form (quick match plan 2, Task 3; spec docs/superpowers/specs/
// 2026-11-03-quick-match-design.md §5, §7.2-7.3, §7.9).
//
// The form posts `application/x-www-form-urlencoded` and every answer is a 303 (controller dispatch 2026-11-08, D3):
//   - a create lands on its home, `routes.quickMatch(token)` (A6): the home token rides the PATH, never a query string;
//     the visitor cookie is set on that answer when this request had no usable key, and so is the language switcher's
//     `seazn_locale` cookie, to the form's locale, when the visitor had made no pick of their own (branch review A M8): the
//     home reads the viewer's locale (D10), so a guest who set up on /fr/play lands on a French home;
//   - a create whose link mail a mail limit refused lands on its home all the same, with `?e=QUICK_MATCH_EMAIL_LIMITED` (branch
//     review B m3, controller ruling 2026-11-08): the mail is what a limit costs, never the match;
//   - a refusal lands back on the setup page, `/<locale>/play?e=<code>`, with a code from QUICK_MATCH_ERRORS, never on JSON.
//     The locale is the form's own (the page that posted), else the visitor's explicit pick, else English.
//
// In this order, each step answering before the next runs:
//   1. the per-IP limit (QUICK_MATCH_CREATE_LIMIT, D2), before any database work (B3); only the form body is read first,
//      for the locale a refusal returns to;
//   1b. the bot check (Cloudflare Turnstile, action `quickmatch`; owner 2026-11-12), straight after that limit as on every
//      guarded public POST (server/turnstile.ts `requireTurnstile`): the token rides the `cf-turnstile-response` header, which
//      only the enhanced (scripted) submit sends, so a post without the script is refused here, like #1136's forms. A refusal
//      is QUICK_MATCH_TURNSTILE_FAILED, before the schema, the visitor, any write or either mail bucket;
//   2. the form, through plan 1's `CreateQuickMatch` schema (strict: a stray field is refused, not dropped), the setup's one
//      Format radio (`shape`) mapped to its `format` + `qualifiers` first (plan 5 D1, `formInput`);
//   3. the visitor, from the REQUEST's cookie (B3a), minted when absent or malformed (`isVisitorKeyShaped`, B3b);
//   4. plan 1's `createQuickMatch`: the seal, the per-visitor alive cap, the offer, then, with an email only and only once
//      all of those have passed (branch review B m3), the mail limits through its `mailAllowed` hook: a separate per-IP
//      bucket for mail to an address a stranger typed (EMAIL_LIMIT, fail-closed as every mail-sending endpoint is; plan 3
//      Amend T1 [B4]), then a per-RECIPIENT one keyed on the address's hash (QUICK_MATCH_RECIPIENT_LIMIT, 3 a day: one inbox,
//      however the IP is spoofed). Either refusing, or the limiter being down, makes the match WITHOUT the email. Then the
//      tree, or nothing. With an email it queues the link mail in its last transaction (plan 3 Task 1), and this route makes
//      the mail's first attempt after the create returned, so after its post-commit work (`dispatchNow`, which never throws;
//      branch review B m7), as api/funnel/start does.
//
// Cross-site posts are refused before this runs, as for every public mutating /api route: proxy.ts answers 403 to a POST whose
// Origin names another host. The visitor cookie is SameSite=Lax, so a cross-site post never carries it either.
//
// Known gap (recorded, plan 2 T3 report): there is no server-side idempotency key. The setup form locks on its first submit
// (pre-flight B4f); a second submit that gets past it (two tabs, a resubmit) creates a second match, bounded by the visitor's
// alive cap and the per-IP limit.
import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { explicitLocale } from "@/lib/explicit-locale";
import { handler, HttpError, redirectLocal } from "@/lib/http";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n-constants";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { isSetupShape, shapeToFormat } from "@/lib/quick-match-shape";
import { baseUrl } from "@/lib/oauth";
import {
  EMAIL_LIMIT,
  isRateLimitOutage,
  QUICK_MATCH_CREATE_LIMIT,
  QUICK_MATCH_RECIPIENT_LIMIT,
  rateLimit,
} from "@/lib/rate-limit";
import { routes } from "@/lib/routes";
import { isTurnstileRefusal } from "@/lib/turnstile";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { dispatchNow } from "@/server/email-outbox";
import { log } from "@/server/logger";
import { requireTurnstile } from "@/server/turnstile";
import { createQuickMatch, type MailRefusal } from "@/server/usecases/quick-match-create";
import { QUICK_MATCH_VISITOR_COOKIE } from "@/server/usecases/quick-match-tokens";
import { readOrMintVisitor, visitorCookieOptions } from "@/server/usecases/quick-match-visitor";

/** The codes a refusal may name. Anything else is shown as CREATE_FAILED, so `?e=` is a closed set the setup page maps. */
const CODES: ReadonlySet<string> = new Set(Object.values(QUICK_MATCH_ERRORS));

/** The form itself is refused: the body is not a form (another content type, a broken body), or the schema refuses it. The
 *  guest's refusal, not a server fault. A ZodError thrown from deeper in the create is NOT this: it is a fault. `code` is
 *  EMAIL_INVALID when the address is the form's ONLY fault (branch review A I2), so the setup page can say which field;
 *  otherwise none, read as CREATE_FAILED. */
class FormRefused extends Error {
  constructor(
    message: string,
    options?: ErrorOptions,
    readonly code?: string,
  ) {
    super(message, options);
  }
}

/**
 * The form's fields as the schema's input. `sides` is a list (one field per side, in entry order); every other field is one
 * value, and a repeated or file-valued one is passed on as a list for the schema to refuse. Three fields are mapped, as the
 * form cannot spell them: `plays` is a number (blank = the schema's default), a blank `email` is none (B4e), and the Format
 * list's one radio, `shape` (plan 5 D1: league | final | semis), is the create's `format` and `qualifiers`
 * (lib/quick-match-shape.ts). A shape is mapped only when it is one of the three AND the post names no format or count of its
 * own; otherwise it is passed on as the stray field it is, and the strict schema refuses the form, never a guess between two
 * answers.
 */
function formInput(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ownFormat = form.has("format") || form.has("qualifiers");
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    const [only] = values;
    if (key === "sides" || values.length !== 1 || typeof only !== "string") {
      out[key] = values;
      continue;
    }
    if (key === "plays") out.plays = only === "" ? undefined : Number(only);
    else if (key === "email") out.email = only.trim() === "" ? null : only;
    else if (key === "shape" && !ownFormat && isSetupShape(only)) {
      const { format, qualifiers } = shapeToFormat(only);
      out.format = format;
      if (qualifiers !== null) out.qualifiers = qualifiers;
    } else out[key] = only;
  }
  return out;
}

/** What `?e=` names for a refusal: the thrower's own code when it is a quick match code; the limiter's code-less 429 as
 *  RATE_LIMITED; anything else as CREATE_FAILED. A quick match code on a 5xx (BASE_URL_MISSING, a programmer error) is
 *  no refusal: it is a fault, reported, and shown as CREATE_FAILED. */
const isQuickMatchCode = (err: unknown): err is HttpError =>
  err instanceof HttpError && err.status < 500 && err.code !== undefined && CODES.has(err.code);
/** The per-IP limiter's 429 (lib/rate-limit.ts): it carries no code, only Retry-After. */
const isLimiter = (err: unknown): err is HttpError => err instanceof HttpError && err.status === 429 && err.code === undefined;

function refusalCode(err: unknown): string {
  if (err instanceof FormRefused && err.code !== undefined) return err.code;
  if (isQuickMatchCode(err)) return err.code!;
  if (isLimiter(err)) return QUICK_MATCH_ERRORS.RATE_LIMITED;
  if (isTurnstileRefusal(err)) return QUICK_MATCH_ERRORS.TURNSTILE_FAILED;
  return QUICK_MATCH_ERRORS.CREATE_FAILED;
}

/** Everything that is not one of the guest's refusals (the form, a quick match code, the limiter, the bot check) is a fault, a
 *  402 from a plan cap included: logged and reported as `handler` reports one, then shown as CREATE_FAILED. The bot check logs
 *  its own reason (server/turnstile.ts), so a refusal of it is not reported again here. */
const isServerFault = (err: unknown) =>
  !(err instanceof FormRefused || isQuickMatchCode(err) || isLimiter(err) || isTurnstileRefusal(err));

/** The per-recipient bucket's key: the sha256 of the lower-cased address, so the limiter's store never holds an address. */
const recipientKey = (email: string): string => createHash("sha256").update(email.toLowerCase()).digest("hex");

/** The two mail buckets, per IP then per recipient (the recipient's is not spent when the IP's refuses). A refusal from
 *  either, or the limiter's fail-closed outage (the same code-less 429), answers no: the create then makes the match without
 *  the email (branch review B m3). The no names its limit for the create's log (review m9): the bucket's own, or "outage"
 *  when the limiter could not count. Anything else the limiter throws is the create's failure. */
async function mailAllowed(ip: string, email: string): Promise<true | MailRefusal> {
  const buckets = [
    ["ip", `quick-match-email:${ip}`, EMAIL_LIMIT],
    ["inbox", `quick-match-recipient:${recipientKey(email)}`, QUICK_MATCH_RECIPIENT_LIMIT],
  ] as const;
  for (const [refusal, key, limit] of buckets) {
    try {
      await rateLimit(key, limit);
    } catch (err) {
      if (!isLimiter(err)) throw err;
      return isRateLimitOutage(err) ? "outage" : refusal;
    }
  }
  return true;
}

/** The visitor's explicit pick, or null: none, one naming no shipped locale, or a forged one that does not decode
 *  (`seazn_locale=%E0` makes `explicitLocale`'s decodeURIComponent throw), never a 500. */
function pickedLocale(req: Request): Locale | null {
  try {
    return explicitLocale(req);
  } catch {
    return null;
  }
}
/** The visitor's explicit pick, else English. */
const cookieLocale = (req: Request): Locale => pickedLocale(req) ?? DEFAULT_LOCALE;

/** The language switcher's own cookie, as it writes it (components/i18n/locale-switcher.tsx): the whole site, a year, Lax,
 *  and readable by the switcher's script (so not HttpOnly). */
const LOCALE_COOKIE = "seazn_locale";
const LOCALE_COOKIE_OPTIONS = { path: "/", maxAge: 31_536_000, sameSite: "lax" } as const;

export async function POST(req: NextRequest) {
  return handler(async () => {
    const form = await req.formData().catch(() => null);
    const posted = form?.get("locale");
    const postedLocale: Locale | null = typeof posted === "string" && hasLocale(posted) ? posted : null;
    const locale: Locale = postedLocale ?? cookieLocale(req);
    try {
      // The client's IP through the repo's one reader (lib/client-ip.ts), as api/funnel/start does: it keys this limit and
      // the mail's per-IP bucket below.
      const ip = clientIp(req.headers);
      await rateLimit(`quick-match-create:${ip}`, QUICK_MATCH_CREATE_LIMIT);
      await requireTurnstile(req, "quickmatch");
      if (!form) throw new FormRefused("the quick match create takes a form");
      const parsed = CreateQuickMatch.safeParse(formInput(form));
      if (!parsed.success) {
        // Not vacuous: a failed parse always has an issue, and an empty list must not name the email.
        const { issues } = parsed.error;
        const emailOnly = issues.length > 0 && issues.every((issue) => issue.path[0] === "email");
        throw new FormRefused(
          "the setup form failed the schema",
          { cause: parsed.error },
          emailOnly ? QUICK_MATCH_ERRORS.EMAIL_INVALID : undefined,
        );
      }
      const visitor = readOrMintVisitor(req.cookies);
      const created = await createQuickMatch(parsed.data, {
        visitorHash: visitor.hash,
        baseUrl: baseUrl(req),
        mailAllowed: (email) => mailAllowed(ip, email),
      });
      if (created.outboxRowId !== null) await dispatchNow([created.outboxRowId]);
      const home = routes.quickMatch(created.token);
      const res = redirectLocal(created.emailLimited ? `${home}?e=${QUICK_MATCH_ERRORS.EMAIL_LIMITED}` : home, 303);
      if (visitor.minted) res.cookies.set(QUICK_MATCH_VISITOR_COOKIE, visitor.key, visitorCookieOptions());
      if (postedLocale !== null && pickedLocale(req) === null) res.cookies.set(LOCALE_COOKIE, postedLocale, LOCALE_COOKIE_OPTIONS);
      return res;
    } catch (err) {
      if (isServerFault(err)) {
        Sentry.captureException(err);
        log.error({ err }, "quick match create: failed");
      }
      return redirectLocal(`${routes.quickMatchSetup(locale)}?e=${refusalCode(err)}`, 303);
    }
  });
}
