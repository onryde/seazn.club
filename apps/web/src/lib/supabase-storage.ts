import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ASSETS_BUCKET, publicStorageUrl } from "@/lib/storage-url";

// Re-export for the many server-side callers; the implementation lives in the
// client-safe storage-url.ts (the badge resolver runs in client components).
export { publicStorageUrl };

/**
 * Generate a signed upload URL for direct browser → Supabase Storage upload.
 * The caller must PUT the file bytes directly to the returned `url`.
 * After upload, store `storagePath` in the DB.
 */
export async function getSignedUploadUrl(
  storagePath: string,
): Promise<{ url: string; token: string }> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage
    .from(ASSETS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: true });
  if (error || !data) throw new Error(`Storage upload URL failed: ${error?.message}`);
  return { url: data.signedUrl, token: data.token };
}

/**
 * Public CDN URL for a stored asset.
 * Use this to render images — served from Supabase CDN, not Vercel.
 */
/**
 * Delete an object from storage. Fire-and-forget — used when replacing or
 * removing an avatar/logo.
 */
export async function deleteStorageObject(storagePath: string): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.storage.from(ASSETS_BUCKET).remove([storagePath]);
  if (error) console.warn(`[storage] delete failed for ${storagePath}:`, error.message);
}

/**
 * R4 S9 (preflight R10): the PRIVATE bucket the compositor's proof-of-play frames live in — the one bucket here that is
 * not public. Ops creates it on stg and prod before the deploy (not Flyway); nothing ever builds a public URL into it, and
 * every read is a short-lived signed URL (`signedReadUrl`). The helpers below touch THIS bucket only, never `assets`.
 */
export const SPONSOR_FRAMES_BUCKET = "sponsor-frames";

/** The longest a signed read may live: an hour. A report page signs its frames as it renders. */
export const SIGNED_READ_MAX_TTL_SEC = 3600;

/** Writes `bytes` at `path` in the private bucket, replacing any object already there. Throws on a storage error with the
 *  provider's message only — never the bytes. */
export async function putStorageObject(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .storage.from(SPONSOR_FRAMES_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage put failed: ${error.message}`);
}

/** A signed URL that reads `path` from the private bucket for `ttlSec` seconds: a whole number from 1 to
 *  SIGNED_READ_MAX_TTL_SEC. `path` must be one of `orgId`'s objects — a frame's key leads with its org
 *  (`<orgId>/<sessionId>/<id>.jpg`, airingFramePath) — so a caller holding one org's report can never sign another org's
 *  frame. Any other TTL, an org that is empty or holds a `/`, or a path outside the org is refused before the provider is
 *  asked (thrown, never repaired). */
export async function signedReadUrl(orgId: string, path: string, ttlSec: number): Promise<string> {
  if (orgId === "" || orgId.includes("/") || !path.startsWith(`${orgId}/`)) {
    throw new RangeError("signedReadUrl: the path is not one of the organisation's frames");
  }
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > SIGNED_READ_MAX_TTL_SEC) {
    throw new RangeError(`signedReadUrl: ttlSec must be a whole number from 1 to ${SIGNED_READ_MAX_TTL_SEC}, got ${ttlSec}`);
  }
  const { data, error } = await supabaseAdmin().storage.from(SPONSOR_FRAMES_BUCKET).createSignedUrl(path, ttlSec);
  if (error || !data) throw new Error(`storage sign failed: ${error?.message ?? "no URL"}`);
  return data.signedUrl;
}

/** Whether the frames bucket is PUBLIC — the one thing it must never be (preflight R10: ops creates it private). The
 *  relay sweep asks once a day and raises an alarm on `true`. Throws when the provider cannot say (no such bucket). */
export async function framesBucketIsPublic(): Promise<boolean> {
  const { data, error } = await supabaseAdmin().storage.getBucket(SPONSOR_FRAMES_BUCKET);
  if (error || !data) throw new Error(`storage bucket read failed: ${error?.message ?? "no bucket"}`);
  return data.public === true;
}

/** Removes objects from the private bucket. An empty list asks the provider nothing. Throws on a storage error. */
export async function removeStorageObjects(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabaseAdmin().storage.from(SPONSOR_FRAMES_BUCKET).remove([...paths]);
  if (error) throw new Error(`storage remove failed: ${error.message}`);
}

/**
 * Player avatar storage path — scoped to org + tournament + player UUID.
 */
export function playerAvatarPath(
  orgId: string,
  tournamentId: string,
  playerId: string,
): string {
  return `orgs/${orgId}/tournaments/${tournamentId}/players/${playerId}.webp`;
}

/**
 * Org logo storage path — scoped to org.
 */
export function orgLogoPath(orgId: string): string {
  return `orgs/${orgId}/branding/logo.webp`;
}

/**
 * Division logo storage path (V274, v8) — the card-tile image.
 */
export function divisionLogoPath(orgId: string, divisionId: string): string {
  return `orgs/${orgId}/divisions/${divisionId}/logo.webp`;
}

/**
 * Resolve display URL for a player image:
 * - If image_storage_path set → CDN URL
 * - Else if image_url is an https URL → use directly
 * - Else (data URL or null) → null (Avatar component handles initials fallback)
 */
export function resolvePlayerImageUrl(
  imageStoragePath: string | null,
  imageUrl: string | null,
): string | null {
  if (imageStoragePath) return publicStorageUrl(imageStoragePath);
  if (imageUrl?.startsWith("https://")) return imageUrl;
  return null; // data URLs excluded — Avatar falls back to initials
}
