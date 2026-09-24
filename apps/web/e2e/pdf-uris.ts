// The ONE reader of a pdfkit PDF's links, pages, text and images, shared by the
// scorer-sheet vitest files (src/server/__tests__) and the scorer-sheet e2e.
// It reads what pdfkit 0.19 writes (probed 2026-09-24), not arbitrary PDFs:
//  - link annotations are uncompressed dictionaries, so their `/URI (…)`
//    literals are readable in the raw bytes (escapes `\(` `\)` `\\` undone);
//  - content streams are FlateDecode (plain zlib) and pdfkit writes each
//    text op as `BT 1 0 0 1 x y Tm /Fn size Tf [<hex> kern <hex>] TJ ET`;
//  - an EMBEDDED font (Inter, Barlow) encodes 2-byte glyph ids, and pdfkit
//    writes a ToUnicode CMap (`<start> <end> [<utf16> …]` bfranges) beside
//    it, so its text IS recoverable; a standard font (the Helvetica fallback)
//    encodes WinAnsi bytes directly;
//  - an image with alpha (every qrcode PNG) is inflated to raw pixels with an
//    /SMask, placed by `w 0 0 -h x bottom cm /In Do` in top-down coordinates.
// Anything outside that shape throws rather than reading as "no text".
import zlib from "node:zlib";

/** Every link annotation's URI, in document order. */
export function pdfLinkUris(pdf: Buffer): string[] {
  const text = pdf.toString("latin1");
  return [...text.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1]!.replace(/\\([()\\])/g, "$1"));
}

export function pdfPageCount(pdf: Buffer): number {
  const m = pdf.toString("latin1").match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

function readObjects(pdf: Buffer): Map<string, PdfObject> {
  const raw = pdf.toString("latin1");
  const objects = new Map<string, PdfObject>();
  for (const m of raw.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const body = m[2]!;
    const s = body.match(/^([\s\S]*?)\bstream\r?\n([\s\S]*)\r?\nendstream\s*$/);
    objects.set(m[1]!, s ? { dict: s[1]!, stream: Buffer.from(s[2]!, "latin1") } : { dict: body, stream: null });
  }
  return objects;
}

const ref = (dict: string, key: string): string | null => dict.match(new RegExp(`/${key}\\s+(\\d+) 0 R`))?.[1] ?? null;

function inflate(o: PdfObject): Buffer {
  if (!o.stream) throw new Error("pdf-uris: object has no stream");
  if (/\/DecodeParms/.test(o.dict)) throw new Error("pdf-uris: predictor-encoded stream — not a shape this reader knows");
  return /\/FlateDecode/.test(o.dict) ? zlib.inflateSync(o.stream) : o.stream;
}

interface Page {
  n: number;
  height: number;
  content: string;
  resources: string;
}

function readPages(objects: Map<string, PdfObject>): Page[] {
  const root = [...objects.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict) && /\/Kids/.test(o.dict));
  if (!root) throw new Error("pdf-uris: no /Pages root");
  const kids = [...root.dict.match(/\/Kids\s*\[([^\]]*)\]/)![1]!.matchAll(/(\d+) 0 R/g)].map((m) => m[1]!);
  return kids.map((id, i) => {
    const page = objects.get(id)!;
    const box = page.dict.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)\s*\]/);
    const contents = objects.get(ref(page.dict, "Contents")!)!;
    const resources = objects.get(ref(page.dict, "Resources")!)!.dict;
    return { n: i + 1, height: Number(box![1]), content: inflate(contents).toString("latin1"), resources };
  });
}

interface Font {
  name: string;
  decode: (hex: string) => string;
}

function readFont(objects: Map<string, PdfObject>, id: string): Font {
  const dict = objects.get(id)!.dict;
  const name = dict.match(/\/BaseFont\s*\/([^\s/<>[\]]+)/)?.[1] ?? "?";
  const toUnicode = ref(dict, "ToUnicode");
  if (toUnicode === null) {
    if (!/\/WinAnsiEncoding/.test(dict)) throw new Error(`pdf-uris: font ${name} has neither ToUnicode nor WinAnsi`);
    const win = new TextDecoder("windows-1252");
    return { name, decode: (hex) => win.decode(Buffer.from(hex, "hex")) };
  }
  const map = new Map<number, string>();
  const cmap = inflate(objects.get(toUnicode)!).toString("latin1");
  for (const r of cmap.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g)) {
    const start = parseInt(r[1]!, 16);
    [...r[3]!.matchAll(/<([0-9a-fA-F\s]*)>/g)].forEach((e, i) => {
      const units = e[1]!.replace(/\s+/g, "");
      const codes: number[] = [];
      for (let k = 0; k < units.length; k += 4) codes.push(parseInt(units.slice(k, k + 4), 16));
      map.set(start + i, String.fromCharCode(...codes));
    });
  }
  return {
    name,
    decode: (hex) => {
      let out = "";
      for (let k = 0; k < hex.length; k += 4) out += map.get(parseInt(hex.slice(k, k + 4), 16)) ?? "�";
      return out;
    },
  };
}

function resourceMap(resources: string, kind: "Font" | "XObject"): Map<string, string> {
  const block = resources.match(new RegExp(`/${kind}\\s*<<([^>]*)>>`))?.[1] ?? "";
  return new Map([...block.matchAll(/\/(\w+)\s+(\d+) 0 R/g)].map((m) => [m[1]!, m[2]!]));
}

export interface PdfTextRun {
  page: number;
  /** BaseFont, subset tag included ("ABCDEF+Inter-Medium"). */
  font: string;
  size: number;
  x: number;
  /** Baseline, measured DOWN from the top of the page (the renderer's own y). */
  y: number;
  text: string;
}

/** Every text op, decoded, in drawing order. One pdfkit `text()` line = one run. */
export function pdfTextRuns(pdf: Buffer): PdfTextRun[] {
  const objects = readObjects(pdf);
  const fonts = new Map<string, Font>();
  const runs: PdfTextRun[] = [];
  for (const page of readPages(objects)) {
    const names = resourceMap(page.resources, "Font");
    let font: Font | null = null;
    let size = 0;
    let x = 0;
    let y = 0;
    const ops = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm|\/(\w+) ([\d.]+) Tf|\[((?:<[0-9a-fA-F]*>|[\s\d.-])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g;
    for (const m of page.content.matchAll(ops)) {
      if (m[1] !== undefined) {
        x = Number(m[1]);
        y = page.height - Number(m[2]);
      } else if (m[3] !== undefined) {
        const id = names.get(m[3]);
        if (!id) throw new Error(`pdf-uris: font /${m[3]} not in page ${page.n}'s resources`);
        if (!fonts.has(id)) fonts.set(id, readFont(objects, id));
        font = fonts.get(id)!;
        size = Number(m[4]);
      } else {
        if (!font) throw new Error("pdf-uris: text drawn before any Tf");
        const hex = m[5] !== undefined ? [...m[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]!).join("") : m[6]!;
        runs.push({ page: page.n, font: font.name, size, x, y, text: font.decode(hex) });
      }
    }
  }
  return runs;
}

export interface PdfImage {
  page: number;
  /** Placement in points, top-down like the renderer's own coordinates. */
  x: number;
  top: number;
  width: number;
  height: number;
  /** Pixel size and RGBA pixels (alpha from the /SMask), ready for a decoder. */
  pxWidth: number;
  pxHeight: number;
  rgba: Uint8ClampedArray;
}

/** Every image drawn, in drawing order, with its pixels. */
export function pdfImages(pdf: Buffer): PdfImage[] {
  const objects = readObjects(pdf);
  const images: PdfImage[] = [];
  for (const page of readPages(objects)) {
    const names = resourceMap(page.resources, "XObject");
    const draws = /([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\s*\/(\w+) Do/g;
    for (const m of page.content.matchAll(draws)) {
      const obj = objects.get(names.get(m[5]!)!)!;
      const num = (k: string) => Number(obj.dict.match(new RegExp(`/${k}\\s+(\\d+)`))![1]);
      const pxWidth = num("Width");
      const pxHeight = num("Height");
      const pixels = inflate(obj);
      const channels = /\/DeviceGray/.test(obj.dict) ? 1 : 3;
      const smask = ref(obj.dict, "SMask");
      const alpha = smask ? inflate(objects.get(smask)!) : null;
      const rgba = new Uint8ClampedArray(pxWidth * pxHeight * 4);
      for (let p = 0; p < pxWidth * pxHeight; p++) {
        for (let c = 0; c < 3; c++) rgba[p * 4 + c] = pixels[p * channels + (channels === 1 ? 0 : c)]!;
        rgba[p * 4 + 3] = alpha ? alpha[p]! : 255;
      }
      const h = Number(m[2]);
      images.push({
        page: page.n,
        x: Number(m[3]),
        top: Number(m[4]) + h,
        width: Number(m[1]),
        height: -h,
        pxWidth,
        pxHeight,
        rgba,
      });
    }
  }
  return images;
}
