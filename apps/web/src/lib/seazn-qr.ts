// lib/seazn-qr.ts — every QR carries the Seazn logo (owner ruling D7, a standing rule; spec 2026-09-30 §7). Error
// correction H, the app icon centred over a knocked-out square — the geometry scorer-sheet-pdf.ts drawBrandQr prints
// (ICON 12 mm on a ~152 pt symbol ≈ 0.22 of the symbol; 1-module white pad; the smallest odd knock-out that holds both).
// This branch: the stream capture QR, the Remote scoring QR, the check-in QR. The other six follow in their own PR.
// Exceptions: none yet. (If the real-phone scan of the stream QR fails — T10 Step 6 — it is recorded HERE.)
import QRCode from "qrcode";

export const SEAZN_QR_ERROR_CORRECTION = "H" as const;
export const SEAZN_QR_QUIET_MODULES = 4;
export const SEAZN_QR_ICON_FRACTION = 0.22;
export const SEAZN_QR_ICON_PAD_MODULES = 1;
export const SEAZN_QR_LOGO_PATH = "/logo-square.png";
const INK = "#150b36"; // --mk-night: the sheets' navy, dark enough for every decoder

/** Where the logo goes on an n-module symbol: the icon's edge (`icon`, in modules), the knock-out square's edge (`k`,
 *  the smallest ODD number of modules holding the icon plus its pad on both sides, so it centres on a module) and its
 *  first row/column (`k0`); `total` is the symbol plus its quiet zone. */
export function seaznQrLayout(n: number): { n: number; total: number; icon: number; k: number; k0: number } {
  const icon = n * SEAZN_QR_ICON_FRACTION;
  let k = Math.ceil(icon + 2 * SEAZN_QR_ICON_PAD_MODULES);
  if (k % 2 === 0) k += 1;
  return { n, total: n + 2 * SEAZN_QR_QUIET_MODULES, icon, k, k0: (n - k) / 2 };
}

/** The symbol as an SVG string, pure. `logoHref: null` draws it with no icon and no knock-out (QRCode's own symbol). */
export function seaznQrSvg(text: string, opts: { size: number; logoHref: string | null }): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION });
  const n = qr.modules.size;
  const L = seaznQrLayout(n);
  const q = SEAZN_QR_QUIET_MODULES;
  const knocked = (r: number, c: number) =>
    opts.logoHref !== null && r >= L.k0 && r < L.k0 + L.k && c >= L.k0 && c < L.k0 + L.k;
  const dark = (r: number, c: number) => qr.modules.get(r, c) === 1 && !knocked(r, c);
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      const start = c;
      while (c < n && dark(r, c)) c++;
      d += `M${start + q} ${r + q}h${c - start}v1h-${c - start}z`;
    }
  }
  const at = q + (n - L.icon) / 2;
  const logo =
    opts.logoHref === null ? "" : `<image href="${opts.logoHref}" x="${at}" y="${at}" width="${L.icon}" height="${L.icon}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.total} ${L.total}" width="${opts.size}" height="${opts.size}" shape-rendering="crispEdges"><rect width="${L.total}" height="${L.total}" fill="#fff"/><path d="${d}" fill="${INK}"/>${logo}</svg>`;
}

let logoOnce: Promise<string | null> | null = null;
/** The icon as a data URL — an SVG shown through <img> may not fetch external images, so it is embedded. Fetched once
 *  per page; a failed fetch renders the QR without the icon (it decodes the same) rather than no QR, and the next
 *  render tries the fetch again. */
function logoDataUrl(): Promise<string | null> {
  logoOnce ??= fetch(SEAZN_QR_LOGO_PATH)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then(
      (b) =>
        new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(b);
        }),
    )
    .catch(() => {
      logoOnce = null;
      return null;
    });
  return logoOnce;
}

/** The Seazn QR for `text` as an SVG data URL, `size` CSS px square (it scales; pass the largest size it paints at). */
export async function renderSeaznQr(text: string, opts: { size: number }): Promise<string> {
  const svg = seaznQrSvg(text, { size: opts.size, logoHref: await logoDataUrl() });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
