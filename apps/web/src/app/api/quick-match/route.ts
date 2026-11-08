// POST /api/quick-match: the guest's setup form (quick match plan 2, Task 3; spec docs/superpowers/specs/
// 2026-11-03-quick-match-design.md §5, §7.2-7.3, §7.9).
//
// The form posts `application/x-www-form-urlencoded` and every answer is a 303 (controller dispatch 2026-11-08, D3):
//   - a create lands on its home, `routes.quickMatch(token)` (A6): the home token rides the PATH, never a query string;
//     the visitor cookie is set on that answer when this request had no usable key;
//   - a refusal lands back on the setup page, `/<locale>/play?e=<code>`, with a code from QUICK_MATCH_ERRORS, never on JSON.
//     The locale is the form's own (the page that posted), else the visitor's explicit pick, else English.
//
// In this order, each step answering before the next runs:
//   1. the per-IP limit (QUICK_MATCH_CREATE_LIMIT, D2), before any read or write (B3);
//   2. the form, through plan 1's `CreateQuickMatch` schema (strict: a stray field is refused, not dropped);
//   3. the visitor, from the REQUEST's cookie (B3a), minted when absent or malformed (`isVisitorKeyShaped`, B3b);
//   4. plan 1's `createQuickMatch`: the seal, the per-visitor alive cap, the offer, the tree, or nothing.
//
// Cross-site posts are refused before this runs, as for every public mutating /api route: proxy.ts answers 403 to a POST whose
// Origin names another host. The visitor cookie is SameSite=Lax, so a cross-site post never carries it either.
//
// Known gap (recorded, plan 2 T3 report): there is no server-side idempotency key. The setup form locks on its first submit
// (pre-flight B4f); a second submit that gets past it (two tabs, a resubmit) creates a second match, bounded by the visitor's
// alive cap and the per-IP limit.
import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { ZodError } from "zod";
import { explicitLocale } from "@/lib/explicit-locale";
import { handler, HttpError, redirectLocal } from "@/lib/http";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n-constants";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { QUICK_MATCH_CREATE_LIMIT, rateLimit } from "@/lib/rate-limit";
import { routes } from "@/lib/routes";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { createQuickMatch } from "@/server/usecases/quick-match-create";
import { QUICK_MATCH_VISITOR_COOKIE } from "@/server/usecases/quick-match-tokens";
import { readOrMintVisitor, visitorCookieOptions } from "@/server/usecases/quick-match-visitor";

/** The codes a refusal may name. Anything else is shown as CREATE_FAILED, so `?e=` is a closed set the setup page maps. */
const CODES: ReadonlySet<string> = new Set(Object.values(QUICK_MATCH_ERRORS));

/** A body that is not a form (another content type, a broken body): the guest's refusal, not a server fault. */
class NotAForm extends Error {}

/**
 * The form's fields as the schema's input. `sides` is a list (one field per side, in entry order); every other field is one
 * value, and a repeated or file-valued one is passed on as a list for the schema to refuse. Two fields are mapped, as the
 * form cannot spell them: `plays` is a number (blank = the schema's default), and a blank `email` is none (B4e).
 */
function formInput(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    const [only] = values;
    if (key === "sides" || values.length !== 1 || typeof only !== "string") {
      out[key] = values;
      continue;
    }
    if (key === "plays") out.plays = only === "" ? undefined : Number(only);
    else if (key === "email") out.email = only.trim() === "" ? null : only;
    else out[key] = only;
  }
  return out;
}

/** What `?e=` names for a refusal: the thrower's own code when it is a quick match code; the limiter's code-less 429 as
 *  RATE_LIMITED; anything else as CREATE_FAILED. */
function refusalCode(err: unknown): string {
  if (err instanceof HttpError && err.code !== undefined && CODES.has(err.code)) return err.code;
  if (err instanceof HttpError && err.status === 429) return QUICK_MATCH_ERRORS.RATE_LIMITED;
  return QUICK_MATCH_ERRORS.CREATE_FAILED;
}

/** A fault the guest cannot fix (a 5xx, an unexpected throw) is reported as `handler` reports one; a refusal is not. */
const isServerFault = (err: unknown) =>
  !(err instanceof ZodError || err instanceof NotAForm || (err instanceof HttpError && err.status < 500));

export async function POST(req: NextRequest) {
  return handler(async () => {
    const form = await req.formData().catch(() => null);
    const posted = form?.get("locale");
    const locale: Locale = typeof posted === "string" && hasLocale(posted) ? posted : (explicitLocale(req) ?? DEFAULT_LOCALE);
    try {
      // The first X-Forwarded-For hop, the funnel's idiom (api/funnel/start/route.ts).
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      await rateLimit(`quick-match-create:${ip}`, QUICK_MATCH_CREATE_LIMIT);
      if (!form) throw new NotAForm("the quick match create takes a form");
      const input = CreateQuickMatch.parse(formInput(form));
      const visitor = readOrMintVisitor(req.cookies);
      const created = await createQuickMatch(input, { visitorHash: visitor.hash });
      const res = redirectLocal(routes.quickMatch(created.token), 303);
      if (visitor.minted) res.cookies.set(QUICK_MATCH_VISITOR_COOKIE, visitor.key, visitorCookieOptions());
      return res;
    } catch (err) {
      if (isServerFault(err)) {
        Sentry.captureException(err);
        log.error({ err }, "quick match create: failed");
      }
      return redirectLocal(`/${locale}/play?e=${refusalCode(err)}`, 303);
    }
  });
}
