import type postgres from "postgres";
import { sql } from "@/lib/db";
import { requireOrgRole, invalidateUserOrgs } from "@/lib/auth";
import { isReservedSlug } from "@/lib/public-site";
import {
  recordSlugHistory,
  slugify,
  withUniqueSlug,
  SLUG_CONSTRAINT,
} from "@/server/usecases/slugs";
import { invalidateSlugCache } from "@/server/slug-resolve";
import { fireOrgRevalidate } from "@/server/public-site/revalidate";
import { dropPublicOrgRefs } from "@/server/public-site/public-ref-cache";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { mergeBrandColor } from "@/lib/org-branding";
import { isValidIana } from "@/lib/tz";
import { hasLocale } from "@/lib/i18n-constants";
import { isRegistrationCurrency } from "@/lib/currency";
import { EDITOR_ROLES, renameOrgSchema, type Organization } from "@/lib/types";
import { z } from "zod";

// Brand color ({ colors: { primary } }, same shape as competitions.branding).
// primary: null clears back to the platform default. Writes are accepted on
// any plan — reads are gated by dashboard.branding, like competitions.
const brandingSchema = z.object({
  colors: z.object({
    primary: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
  }).strict(),
}).strict();
// Org "about" (v3/06 §2): Markdown, rendered on the public org page.
const aboutSchema = z.string().max(20_000).nullable();

const orgPatchSchema = z.union([
  renameOrgSchema,
  z.object({ logo_storage_path: z.string().max(500).nullable() }).strict(),
  z.object({ payment_instructions: z.string().max(5000).nullable() }).strict(),
  // Default payment method for NEW division registration settings (spec §3).
  z.object({ default_payment_method: z.enum(["offline", "stripe"]) }).strict(),
  z.object({ about: aboutSchema }).strict(),
  // Scheduling timezone (V305) — the VENUE lane, inherited by every division
  // that has no stored tz. null clears it back to UTC. Validated against the
  // runtime's Intl, the same rule as users.timezone (lib/tz isValidIana).
  z.object({
    timezone: z
      .string()
      .max(64)
      .refine(isValidIana, { message: "Unknown timezone" })
      .nullable(),
  }).strict(),
  // Public default locale. Read by every ENTRANT-facing surface already — the
  // public org/competition pages, embeds, calendar.ics, OG images, slideshows,
  // and the locale frozen onto a new registration (lib/registrant-locale) —
  // and until now written by nothing but tests. This is its first writer.
  // Never null: `toLocale` would fall back to English anyway, so an explicit
  // code is the only state worth storing.
  z.object({ default_locale: z.string().refine(hasLocale, { message: "Unsupported locale" }) }).strict(),
  // Entry-fee currency (RS001b, V365). NOT the billing currency — that is the
  // subscription's and is resolved by preferredCurrency; this is what an
  // ENTRANT is quoted and charged. `isRegistrationCurrency` mirrors the
  // column's own allowlist CHECK; the DB constraint is the real gate, this
  // just turns a violation into a 400 instead of a 500.
  //
  // The same-currency rule (V365) locks this column to the Connect account's
  // settlement currency while one is attached, so the write is REFUSED rather
  // than silently reverted by the next syncConnectAccount.
  z.object({ currency: z.string().refine(isRegistrationCurrency, { message: "Unsupported currency" }) }).strict(),
  z.object({ branding: brandingSchema }).strict(),
  // The Organisation tab's ONE Save (settings C8, owner 2026-11-11): the name, the brand colour and About together, so a
  // save lands whole or not at all — three requests could rename the org and then fail the About behind it. Each key takes
  // the shape its own arm above takes; any subset is accepted, and an empty body is the "Nothing to update" 400 below.
  // LAST, so a single-key body still matches its own arm first.
  z.object({
    name: renameOrgSchema.shape.name.optional(),
    about: aboutSchema.optional(),
    branding: brandingSchema.optional(),
  }).strict(),
  // No `sponsors` arm (R4 fix batch 3): sponsors live in the `sponsors` table only (/api/v1/orgs/{id}/sponsors). The
  // arm wrote the legacy `branding.sponsors` blob, which V492 strips; a body naming it is refused like any unknown key.
]);

/** Update an organization — rename or set branding logo (owners and admins). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    const body = orgPatchSchema.parse(await req.json());

    const updates: Record<string, unknown> = {};
    let previousSlug: string | null = null;
    let renameFrom: { slug: string; to: string } | null = null;
    if ("name" in body && body.name !== undefined) {
      updates.name = body.name;
      // Rename regenerates the slug (v3/01 §2, PROMPT-30); the old slug keeps
      // redirecting via slug_history so shared /o and /live links survive.
      const [current] = await sql<{ name: string; slug: string }[]>`
        select name, slug from organizations where id = ${id}`;
      if (!current) throw new HttpError(404, "Organization not found");
      // The slug itself is settled inside the transaction below, against the
      // unique index — a rename picked here and written later can lose the
      // slug to a concurrent rename in the gap.
      if (body.name !== current.name) renameFrom = { slug: current.slug, to: body.name };
    }
    if ("logo_storage_path" in body) updates.logo_storage_path = body.logo_storage_path;
    if ("payment_instructions" in body) updates.payment_instructions = body.payment_instructions;
    if ("default_payment_method" in body) {
      // `stripe` is only a legitimate default once the account can take a
      // charge. The connect settings page already disables the radio on
      // `stripe_charges_enabled` — this is the same rule where it belongs, so
      // a client that never rendered that screen cannot default every new
      // division to a method the org cannot collect on. Same targeted-select
      // shape as the currency lock below, not a whole-row precondition read.
      if (body.default_payment_method === "stripe") {
        const [conn] = await sql<{ stripe_charges_enabled: boolean }[]>`
          select stripe_charges_enabled from organizations where id = ${id}`;
        if (!conn) throw new HttpError(404, "Organization not found");
        if (!conn.stripe_charges_enabled) {
          throw new HttpError(409, "Stripe is not ready to accept charges yet");
        }
      }
      updates.default_payment_method = body.default_payment_method;
    }
    if ("about" in body && body.about !== undefined) updates.about = body.about;
    if ("timezone" in body) updates.timezone = body.timezone;
    if ("default_locale" in body) updates.default_locale = body.default_locale;
    if ("currency" in body) {
      // Refuse rather than write-then-lose. syncConnectAccount mirrors the
      // account's settlement currency onto this column on EVERY sync, so a
      // change accepted here would be reverted on the next webhook — the org
      // would see it save, then silently change back.
      const [conn] = await sql<{ stripe_account_id: string | null }[]>`
        select stripe_account_id from organizations where id = ${id}`;
      if (!conn) throw new HttpError(404, "Organization not found");
      if (conn.stripe_account_id !== null) {
        throw new HttpError(
          409,
          "Currency is locked to the connected Stripe account's settlement currency",
        );
      }
      updates.currency = body.currency;
    }
    // Branding writes MERGE into the blob (lib/org-branding): the colour must
    // not clobber any other key the column holds.
    if ("branding" in body && body.branding) {
      const [current] = await sql<{ branding: unknown }[]>`
        select branding from organizations where id = ${id}`;
      if (!current) throw new HttpError(404, "Organization not found");
      updates.branding = sql.json(mergeBrandColor(current.branding, body.branding.colors.primary) as never);
    }

    if (Object.keys(updates).length === 0) throw new HttpError(400, "Nothing to update");

    const org = await sql.begin(async (tx) => {
      const update = async (
        next: Record<string, unknown>,
        q: postgres.TransactionSql,
      ): Promise<Organization> => {
        const [row] = await q<Organization[]>`
          update organizations set ${q(next)}
          where id = ${id}
          returning id, name, slug, created_by, created_at, logo_url, logo_storage_path, payment_instructions, default_payment_method, branding, timezone`;
        if (!row) throw new HttpError(404, "Organization not found");
        if (previousSlug) await recordSlugHistory(q, "org", null, previousSlug, id);
        return row;
      };
      if (!renameFrom) return update(updates, tx as postgres.TransactionSql);
      const from = renameFrom;
      return withUniqueSlug(
        tx as postgres.TransactionSql,
        {
          base: slugify(from.to),
          constraint: SLUG_CONSTRAINT.organizations,
          // Read on `tx`, not the pooled `sql` proxy: we are already holding a
          // connection here, and a second checkout inside it is the pool
          // self-deadlock lib/db.ts's nesting guard exists for.
          taken: async (s) => {
            if (isReservedSlug(s)) return true;
            const rows = await tx`
              select 1 from organizations where slug = ${s} and id <> ${id}`;
            return rows.length > 0;
          },
        },
        (slug, q) => {
          // Reset per attempt. A retry can land BACK on the org's current slug
          // — current "acme-2", renamed to "Acme", "acme" lost to a rival, next
          // candidate "acme-2" — and a `previousSlug` left set by the failed
          // attempt would then write a slug_history row redirecting the org to
          // itself, for a rename that did not happen.
          previousSlug = slug === from.slug ? null : from.slug;
          return update(slug === from.slug ? updates : { ...updates, slug }, q);
        },
      );
    });

    // The polled public readers' cached slug lookups (public hub perf T2): the
    // org's own, and every one of its competitions', under the old slug and
    // the new. This route is the only writer of an org slug. FIRST, straight
    // after the commit: every bust below can throw, and a throw there must not
    // leave the old slug resolving for the lookups' TTL. Never throws itself.
    if (previousSlug) await dropPublicOrgRefs(org.id, previousSlug, org.slug);

    // name/logo/payment appear in every member's cached org list — bust each.
    const members = await sql<{ user_id: string }[]>`
      select user_id from org_members where org_id = ${id}`;
    await Promise.all(members.map((m) => invalidateUserOrgs(m.user_id)));
    // …and on the public masthead (name, logo, brand color) — bust the tree.
    // A rename busts the OLD slug's tree too (its pages now redirect).
    fireOrgRevalidate(org.slug);
    if (previousSlug) fireOrgRevalidate(previousSlug);
    if (previousSlug) await invalidateSlugCache("org", null, previousSlug, org.slug);

    return org;
  });
}
