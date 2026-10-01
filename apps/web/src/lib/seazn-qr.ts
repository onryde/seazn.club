// lib/seazn-qr.ts — every QR carries the Seazn logo (owner ruling D7, a standing rule; spec 2026-09-30 §7). Error
// correction H, the app icon centred over a knocked-out square — the knock-out geometry scorer-sheet-pdf.ts drawBrandQr
// prints (a 1-module white pad; the smallest odd square that holds the icon and its pad). The icon covers 0.22 of the
// symbol, §8a's `QR encoding` row: a SMALLER share than the print's, whose 12 mm icon is 0.26 of the ~132 pt symbol a
// real Remote scoring link prints (0.31 under the tallest header) — measured off a rendered sheet, B6 minor tail m-4.
// This branch: the stream capture QR, the Remote scoring QR, the check-in QR. The other six follow in their own PR.
// Exceptions: none yet. (If the real-phone scan of the stream QR fails — T10 Step 6 — it is recorded HERE.)
import QRCode from "qrcode";

export const SEAZN_QR_ERROR_CORRECTION = "H" as const;
export const SEAZN_QR_QUIET_MODULES = 4;
export const SEAZN_QR_ICON_FRACTION = 0.22;
export const SEAZN_QR_ICON_PAD_MODULES = 1;
/** The 192-px app icon — the same artwork as spec §7's 512-px `logo-square.png` (the printed sheets' file), downscaled,
 *  and pinned to it pixel for pixel in the test. Embedded in every QR's data URL, so its weight is each QR's: the
 *  512-px logo made a 258–291 kB data URL, this one 58–91 kB (B6 minor tail m-8, measured on the real payloads). The largest icon painted is ≈ 139
 *  CSS px (enlarged at 1280 on a 1× screen), so 192 holds it at 1×; on a 2× screen enlarged it upsamples ≈ 1.6×, which
 *  softens the dressing and touches no module. */
export const SEAZN_QR_LOGO_PATH = "/icons/icon-192.png";
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

/** A Seazn QR as the page paints it: the SVG data URL, and the symbol's edge in modules WITH its quiet zone — the
 *  number every painted size is snapped to (`snapQrSize`, B6 fix round 1 ruling I-2). */
export type SeaznQr = { src: string; modules: number };

const encode = (text: string) => QRCode.create(text, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION });

/** The symbol's edge in modules, quiet zone included — what `renderSeaznQr` reports as `modules`, without drawing. */
export function seaznQrModules(text: string): number {
  return seaznQrLayout(encode(text).modules.size).total;
}

function drawSvg(qr: QRCode.QRCode, opts: { logoHref: string | null; size?: number }): string {
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
  const size = opts.size ?? L.total;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.total} ${L.total}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${L.total}" height="${L.total}" fill="#fff"/><path d="${d}" fill="${INK}"/>${logo}</svg>`;
}

/** The symbol as an SVG string, pure. `logoHref: null` draws it with no icon and no knock-out (QRCode's own symbol).
 *  Its intrinsic size is one px per module (`size` overrides it — a test rasterises at the painted size); the page
 *  paints it at a snapped size, so the SVG scales and is never a raster to keep crisp. */
export function seaznQrSvg(text: string, opts: { logoHref: string | null; size?: number }): string {
  return drawSvg(encode(text), opts);
}

/** How long a QR waits for the icon before it paints without it (review m-8): the QR is the point, the logo dressing. */
export const SEAZN_QR_LOGO_TIMEOUT_MS = 2000;

let logoOnce: Promise<string | null> | null = null;
/** The icon as a data URL — an SVG shown through <img> may not fetch external images, so it is embedded. Fetched once
 *  per page; a failed fetch, or one that has not answered within the timeout (aborted then), renders the QR without the
 *  icon (it decodes the same) rather than no QR, and the next render tries the fetch again. */
function logoDataUrl(): Promise<string | null> {
  if (logoOnce) return logoOnce;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      abort.abort();
      rej(new Error("logo fetch timed out"));
    }, SEAZN_QR_LOGO_TIMEOUT_MS);
  });
  const load = fetch(SEAZN_QR_LOGO_PATH, { signal: abort.signal })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then(
      (b) =>
        new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(b);
        }),
    );
  load.catch(() => {}); // the race below reports it; a late rejection after the timeout must not go unhandled
  logoOnce = Promise.race([load, timedOut])
    .catch(() => {
      logoOnce = null;
      return null;
    })
    .finally(() => clearTimeout(timer));
  return logoOnce;
}

/** The Seazn QR for `text`: the SVG data URL and its module count. The page decides the painted size (`SeaznQrImage`
 *  snaps it to whole device px per module); the SVG scales to it. */
export async function renderSeaznQr(text: string): Promise<SeaznQr> {
  const qr = encode(text);
  const svg = drawSvg(qr, { logoHref: await logoDataUrl() });
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, modules: seaznQrLayout(qr.modules.size).total };
}
