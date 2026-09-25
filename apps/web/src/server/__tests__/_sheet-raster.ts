// The scorer sheet as a printer and a phone camera see it: each page's vector
// drawing (e2e/pdf-uris.ts pdfPageSvg) rasterised by a real anti-aliasing
// renderer (librsvg, inside sharp), then every card's QR cropped out and read
// by a real decoder (jsQR). pdftoppm would be the obvious rasteriser, but CI
// has no poppler; the local decode matrix cross-checks against it.
import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { pdfImages, pdfLinks, pdfPageSvg } from "../../../e2e/pdf-uris";

/** Screen-quality 90 dpi, a coarse 72 dpi, and a B&W laser copy at 90 dpi:
 *  grey, toner black lifted to 40 and paper white pulled down to 235. */
export const CONDITIONS = {
  dpi90: { dpi: 90, bw: false },
  dpi72: { dpi: 72, bw: false },
  bw90: { dpi: 90, bw: true },
} as const;
export type Condition = keyof typeof CONDITIONS;

export interface Raster {
  data: Buffer;
  width: number;
  height: number;
  dpi: number;
}

async function imageHrefs(pdf: Buffer): Promise<Map<string, string>> {
  const hrefs = new Map<string, string>();
  for (const img of pdfImages(pdf)) {
    if (hrefs.has(img.xobject)) continue;
    const png = await sharp(Buffer.from(img.rgba.buffer), { raw: { width: img.pxWidth, height: img.pxHeight, channels: 4 } })
      .png()
      .toBuffer();
    hrefs.set(img.xobject, `data:image/png;base64,${png.toString("base64")}`);
  }
  return hrefs;
}

async function rasterise(pdf: Buffer, page: number, condition: Condition, hrefs: Map<string, string>): Promise<Raster> {
  const { dpi, bw } = CONDITIONS[condition];
  let img = sharp(Buffer.from(pdfPageSvg(pdf, page, (id) => hrefs.get(id)!)), { density: dpi });
  if (bw) img = img.greyscale().linear((235 - 40) / 255, 40);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  // A4 is 595.28pt wide: a raster at any other scale would crop the wrong place.
  if (Math.abs(info.width - (595.28 * dpi) / 72) > 1) throw new Error(`raster is ${info.width}px wide at ${dpi} dpi`);
  // Grey comes back as ONE channel whatever toColourspace/ensureAlpha say;
  // jsQR reads RGBA, so spread it (alpha is ignored by the decoder).
  const rgba = Buffer.alloc(info.width * info.height * 4);
  const ch = info.channels;
  for (let p = 0; p < info.width * info.height; p++) {
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = data[p * ch + (ch < 3 ? 0 : c)]!;
    rgba[p * 4 + 3] = 255;
  }
  return { data: rgba, width: info.width, height: info.height, dpi };
}

/** One page as pixels, under one condition. */
export async function rasterPage(pdf: Buffer, page: number, condition: Condition): Promise<Raster> {
  return rasterise(pdf, page, condition, await imageHrefs(pdf));
}

/** Luma (0 black … 255 white) at a point given in the renderer's own
 *  top-down points. */
export function lumaAt(r: Raster, x: number, y: number): number {
  const p = (Math.round((y * r.dpi) / 72) * r.width + Math.round((x * r.dpi) / 72)) * 4;
  return 0.299 * r.data[p]! + 0.587 * r.data[p + 1]! + 0.114 * r.data[p + 2]!;
}

function crop(r: Raster, x: number, y: number, w: number, h: number): { rgba: Uint8ClampedArray; width: number; height: number } {
  const px = (v: number) => Math.round((v * r.dpi) / 72);
  const x0 = Math.max(0, px(x));
  const y0 = Math.max(0, px(y));
  const x1 = Math.min(r.width, px(x + w));
  const y1 = Math.min(r.height, px(y + h));
  const width = x1 - x0;
  const height = y1 - y0;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y0 + row) * r.width + x0) * 4;
    rgba.set(r.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { rgba, width, height };
}

/** Per card, in link order: what a decoder reads from that card's QR alone —
 *  the symbol plus four modules of its quiet zone, cut from the page raster. */
export async function decodeEveryCard(pdf: Buffer, condition: Condition): Promise<(string | null)[]> {
  const hrefs = await imageHrefs(pdf);
  const rasters = new Map<number, Raster>();
  const out: (string | null)[] = [];
  for (const link of pdfLinks(pdf)) {
    if (!rasters.has(link.page)) rasters.set(link.page, await rasterise(pdf, link.page, condition, hrefs));
    const n = QRCode.create(link.uri, { errorCorrectionLevel: "H" }).modules.size;
    const quiet = (link.width / n) * 4;
    const c = crop(rasters.get(link.page)!, link.x - quiet, link.top - quiet, link.width + 2 * quiet, link.height + 2 * quiet);
    out.push(jsQR(c.rgba, c.width, c.height)?.data ?? null);
  }
  return out;
}
