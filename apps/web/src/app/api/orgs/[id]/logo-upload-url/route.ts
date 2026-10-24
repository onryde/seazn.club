import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { requireOrgRole } from "@/lib/auth";
import { hasFeature } from "@/lib/entitlements";
import { getSignedUploadUrl, orgLogoPath } from "@/lib/supabase-storage";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, ["owner", "admin"]);

    const ok = await hasFeature(id, "branding");
    // `branding` is granted on every plan (V310): only a staff override refuses it.
    if (!ok) throw new HttpError(402, "Your own logo is switched off for this organisation");

    const path = orgLogoPath(id);
    const { url, token } = await getSignedUploadUrl(path);

    return { upload_url: url, token, storage_path: path };
  });
}
