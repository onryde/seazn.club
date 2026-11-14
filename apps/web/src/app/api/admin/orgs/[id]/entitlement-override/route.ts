import { sql } from "@/lib/db";
import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { handler, HttpError } from "@/lib/http";
import { fireOrgRevalidate } from "@/server/public-site/revalidate";
import { z } from "zod";

const schema = z.object({
  feature_key: z.string().min(1).max(80),
  bool_value: z.boolean().nullable().optional(),
  int_value: z.number().int().nullable().optional(),
  /** Optional lapse date (v3/08 §1) — resolution ignores expired overrides. */
  expires_at: z.iso.date().nullable().optional(),
  reason: z.string().min(1).max(500),
}).strict();

/** Upsert or delete an entitlement override. Superadmin only.
 *
 *  Final review m3: an override is the one write that can flip what the org's public pages say - `registration.paid` decides whether
 *  a card division takes entries (`cardPaymentsBroken`), and every plan grants it, so no plan change can. Those pages are cached under
 *  the org's public tag, which a Fly suspend freezes, so each write and each real removal expires it (`fireOrgRevalidate`, as the
 *  Connect sync does). Any key, not only that one: an override is a rare staff act, and other keys gate public things too. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { feature_key, bool_value, reason, int_value, expires_at } = schema.parse(
      await req.json(),
    );

    const [org] = await sql<{ id: string; slug: string }[]>`select id, slug from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");
    if (expires_at && new Date(expires_at).getTime() <= Date.now()) {
      throw new HttpError(400, "The expiry must be in the future.");
    }

    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value, expires_at, reason)
      values (${id}, ${feature_key}, ${bool_value ?? null}, ${int_value ?? null},
              ${expires_at ?? null}, ${reason})
      on conflict (org_id, feature_key) do update set
        bool_value = excluded.bool_value,
        int_value  = excluded.int_value,
        expires_at = excluded.expires_at,
        reason     = excluded.reason`;

    await invalidateOrgEntitlements(id);
    fireOrgRevalidate(org.slug);
    await logStaffAction(staff.id, "entitlement_override", "entitlement", id, {
      feature_key, bool_value, int_value, expires_at, reason,
    });
    return { ok: true };
  });
}

/** Remove an entitlement override. Superadmin only. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { feature_key } = z.object({ feature_key: z.string().min(1) }).strict().parse(await req.json());

    // The org's slug comes back only when a row was removed: removing nothing changes nothing public, so nothing is expired.
    const removed = await sql<{ slug: string }[]>`
      delete from org_entitlement_overrides o
      using organizations org
      where o.org_id = ${id} and o.feature_key = ${feature_key} and org.id = o.org_id
      returning org.slug`;

    await invalidateOrgEntitlements(id);
    if (removed.length > 0) fireOrgRevalidate(removed[0]!.slug);
    await logStaffAction(staff.id, "entitlement_override_removed", "entitlement", id, { feature_key });
    return { ok: true };
  });
}
