// lib/open-in-app.ts — the three "Open in app" links (spec 2026-11-25 §5.1). Client-safe: no server imports, no `Buffer`.
// `origin` is siteOrigin(). The credential is only ever after `#`, which a browser never sends to a server.

/** The release switch for the BUTTONS (not the links or pages, which ship everywhere): only the literal "1" shows them.
 *  `NEXT_PUBLIC_*` is baked at build time; fly.stg.toml sets it, fly.toml does not until the phone release that handles
 *  /app/* is on Play (lib/__tests__/open-in-app-release.test.ts). */
export function openInAppEnabled(): boolean {
  return process.env.NEXT_PUBLIC_OPEN_IN_APP === "1";
}

/** The origin a button's link is built on: the page's own, as the pad URL beside it is. Null on the server. */
export function clientOrigin(): string | null {
  return typeof window === "undefined" ? null : (window.location?.origin ?? null);
}

/** `/app/stream#` + unpadded base64url of the UTF-8 bytes of the exact QR text (`captureQrV2Text`). */
export function streamAppLink(origin: string, qrText: string): string {
  const binary = Array.from(new TextEncoder().encode(qrText), (byte) => String.fromCharCode(byte)).join("");
  const fragment = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${origin}/app/stream#${fragment}`;
}

/** `/app/score#dl_…`: `secret` is the device-link token. */
export function scoreAppLink(origin: string, secret: string): string {
  return `${origin}/app/score#${secret}`;
}

/** The `md_` token of a Match Day code's URL, `<origin>/day/md_…`: the whole path segment, nothing trailing it. */
const DAY_URL_TOKEN = /\/day\/(md_[A-Za-z0-9_-]+)(?=$|[?#])/;

/** `/app/day#md_…` from `MatchDayCode.url`; null when it carries no `md_` token. */
export function dayAppLink(origin: string, dayUrl: string): string | null {
  const token = DAY_URL_TOKEN.exec(dayUrl)?.[1];
  return token === undefined ? null : `${origin}/app/day#${token}`;
}
