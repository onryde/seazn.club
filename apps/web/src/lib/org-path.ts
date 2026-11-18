/** The org slug in an `/o/{slug}/...` path, decoded (callers re-encode it); null for any other path. */
export function orgSlugFromPath(pathname: string | null | undefined): string | null {
  const m = /^\/o\/([^/?#]+)(?:[/?#]|$)/.exec(pathname ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}
