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
//    /SMask, placed by `w 0 0 -h x bottom cm /In Do` in top-down coordinates;
//  - a stroked segment is `x1 y1 m`, `x2 y2 l`, colour/width ops, `S` — one
//    op per line, also top-down;
//  - a link annotation is its own object with a `/Rect` (bottom-up) and an
//    `/A` action object holding the `/URI`, listed in its page's `/Annots`;
//  - vector drawing (pdfPageSvg) is re / m l c h, f / f*, S, q Q cm, the
//    DeviceRGB colour ops and image `Do`, all in pdfkit's flipped space.
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
  dict: string;
  width: number;
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
    const box = page.dict.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*\]/);
    const contents = objects.get(ref(page.dict, "Contents")!)!;
    const resources = objects.get(ref(page.dict, "Resources")!)!.dict;
    return {
      n: i + 1,
      dict: page.dict,
      width: Number(box![1]),
      height: Number(box![2]),
      content: inflate(contents).toString("latin1"),
      resources,
    };
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

export interface PdfLine {
  page: number;
  /** Top-down, like the renderer's own coordinates (pdfkit's page flip). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Every stroked single segment (`moveTo(…).lineTo(…).stroke()`), in drawing order. */
export function pdfLines(pdf: Buffer): PdfLine[] {
  const lines: PdfLine[] = [];
  for (const page of readPages(readObjects(pdf))) {
    // pdfkit writes the stroke colour and width between the path and its `S`.
    const segment = /([\d.-]+) ([\d.-]+) m\n([\d.-]+) ([\d.-]+) l\n(?:[^\n]* (?:CS|SCN|cs|scn|RG|rg|w)\n)*S\n/g;
    for (const m of page.content.matchAll(segment)) {
      lines.push({ page: page.n, x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) });
    }
  }
  return lines;
}

export interface PdfImage {
  page: number;
  /** The image XObject's object number: one embedded image drawn N times
   *  shows N draws with ONE id. */
  xobject: string;
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
      const xobject = names.get(m[5]!)!;
      const obj = objects.get(xobject)!;
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
        xobject,
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

export interface PdfLink {
  page: number;
  uri: string;
  /** The annotation's active area in points, top-down like pdfImages. */
  x: number;
  top: number;
  width: number;
  height: number;
}

/** Every link annotation with its page and area, in document order. */
export function pdfLinks(pdf: Buffer): PdfLink[] {
  const objects = readObjects(pdf);
  const links: PdfLink[] = [];
  for (const page of readPages(objects)) {
    const annots = page.dict.match(/\/Annots\s*\[([^\]]*)\]/)?.[1] ?? "";
    for (const a of annots.matchAll(/(\d+) 0 R/g)) {
      const dict = objects.get(a[1]!)!.dict;
      if (!/\/Subtype\s*\/Link/.test(dict)) continue;
      const action = ref(dict, "A");
      const uri = (action ? objects.get(action)!.dict : dict).match(/\/URI\s*\(((?:\\.|[^\\)])*)\)/);
      if (!uri) throw new Error("pdf-uris: link annotation without a /URI");
      const [x1, y1, x2, y2] = dict.match(/\/Rect\s*\[([^\]]*)\]/)![1]!.trim().split(/\s+/).map(Number) as [number, number, number, number];
      links.push({
        page: page.n,
        uri: uri[1]!.replace(/\\([()\\])/g, "$1"),
        x: x1,
        top: page.height - y2,
        width: x2 - x1,
        height: y2 - y1,
      });
    }
  }
  return links;
}

type Matrix = [number, number, number, number, number, number];
/** `m` applied first, then `n` — the PDF's `m cm` on a CTM of `n`. */
const compose = ([a, b, c, d, e, f]: Matrix, [A, B, C, D, E, F]: Matrix): Matrix => [
  a * A + b * C,
  a * B + b * D,
  c * A + d * C,
  c * B + d * D,
  e * A + f * C + E,
  e * B + f * D + F,
];

/**
 * One page's VECTOR drawing (paths and images; text is skipped) as an SVG,
 * so a real anti-aliasing rasteriser (librsvg, inside sharp) can produce the
 * pixels a printer or a phone camera would see — without poppler, which CI
 * does not have. `href` maps an image XObject id (PdfImage.xobject) to an
 * <image> href, e.g. a PNG data: URI built from that image's pixels.
 * It reads the operators pdfkit 0.19 writes for rect, roundedRect, circle,
 * line, fill (nonzero and even-odd), stroke and image; any other operator
 * throws rather than drawing a page that is silently missing something.
 */
export function pdfPageSvg(pdf: Buffer, pageNo: number, href: (xobject: string) => string): string {
  const objects = readObjects(pdf);
  const page = readPages(objects)[pageNo - 1];
  if (!page) throw new Error(`pdf-uris: no page ${pageNo}`);
  const xobjects = resourceMap(page.resources, "XObject");
  // Text objects carry hex strings and arrays; none of it is vector drawing.
  const ops = page.content.replace(/\bBT\b[\s\S]*?\bET\b/g, " ");
  const tokens = ops.match(/\[[^\]]*\]|\/[^\s/[\]()<>]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*]+/g) ?? [];

  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  const rgb = (cs: number[]) =>
    `rgb(${cs.map((c) => Math.round(c * 255)).join(",")})`;
  let ctm: Matrix = [1, 0, 0, -1, 0, page.height]; // PDF user space (y up) → SVG (y down)
  let fill = [0, 0, 0];
  let stroke = [0, 0, 0];
  let lineWidth = 1;
  let dash: number[] = [];
  const stack: { ctm: Matrix; fill: number[]; stroke: number[]; lineWidth: number; dash: number[] }[] = [];
  let path = "";
  const out: string[] = [];
  const pt = (x: number, y: number) => {
    const [a, b, c, d, e, f] = ctm;
    return `${fmt(a * x + c * y + e)},${fmt(b * x + d * y + f)}`;
  };
  const scale = () => Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
  let operands: string[] = [];
  const nums = (k: number) => {
    if (operands.length < k) throw new Error(`pdf-uris: operator needs ${k} operands, got ${operands.length}`);
    return operands.slice(-k).map(Number);
  };

  for (const t of tokens) {
    if (/^[-+.\d]/.test(t) || t.startsWith("/") || t.startsWith("[")) {
      operands.push(t);
      continue;
    }
    switch (t) {
      case "q":
        stack.push({ ctm, fill, stroke, lineWidth, dash });
        break;
      case "Q": {
        const s = stack.pop();
        if (!s) throw new Error("pdf-uris: Q without q");
        ({ ctm, fill, stroke, lineWidth, dash } = s);
        break;
      }
      case "cm":
        ctm = compose(nums(6) as Matrix, ctm);
        break;
      case "re": {
        const [x, y, w, h] = nums(4) as [number, number, number, number];
        path += `M${pt(x, y)}L${pt(x + w, y)}L${pt(x + w, y + h)}L${pt(x, y + h)}Z`;
        break;
      }
      case "m": {
        const [x, y] = nums(2) as [number, number];
        path += `M${pt(x, y)}`;
        break;
      }
      case "l": {
        const [x, y] = nums(2) as [number, number];
        path += `L${pt(x, y)}`;
        break;
      }
      case "c": {
        const [x1, y1, x2, y2, x3, y3] = nums(6) as Matrix;
        path += `C${pt(x1, y1)} ${pt(x2, y2)} ${pt(x3, y3)}`;
        break;
      }
      case "h":
        path += "Z";
        break;
      case "f":
      case "F":
      case "f*":
        out.push(`<path d="${path}" fill="${rgb(fill)}" fill-rule="${t === "f*" ? "evenodd" : "nonzero"}"/>`);
        path = "";
        break;
      case "S": {
        const dashes = dash.length ? ` stroke-dasharray="${dash.map((d) => fmt(d * scale())).join(" ")}"` : "";
        out.push(`<path d="${path}" fill="none" stroke="${rgb(stroke)}" stroke-width="${fmt(lineWidth * scale())}"${dashes}/>`);
        path = "";
        break;
      }
      case "n":
        path = "";
        break;
      case "w":
        lineWidth = nums(1)[0]!;
        break;
      case "d":
        dash = (operands[operands.length - 2] ?? "[]").slice(1, -1).trim().split(/\s+/).filter(Boolean).map(Number);
        break;
      case "cs":
      case "CS":
      case "gs":
        break; // DeviceRGB is the only colour space pdfkit writes; opacity is ignored
      case "scn":
      case "sc":
      case "rg":
        fill = nums(3);
        break;
      case "SCN":
      case "SC":
      case "RG":
        stroke = nums(3);
        break;
      case "g":
        fill = [nums(1)[0]!, nums(1)[0]!, nums(1)[0]!];
        break;
      case "Do": {
        const id = xobjects.get(operands[operands.length - 1]!.slice(1));
        if (!id || !/\/Subtype\s*\/Image/.test(objects.get(id)!.dict)) throw new Error("pdf-uris: Do of something that is not an image");
        // Image space: the unit square, first pixel row at the TOP (y = 1).
        const [a, b, c, d, e, f] = compose([1, 0, 0, -1, 0, 1], ctm);
        out.push(
          `<image href="${href(id)}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="matrix(${[a, b, c, d, e, f].map((v) => String(v)).join(" ")})"/>`,
        );
        break;
      }
      default:
        throw new Error(`pdf-uris: operator ${t} is not one this reader draws`);
    }
    operands = [];
  }
  const w = fmt(page.width);
  const h = fmt(page.height);
  // Unitless size, one user unit per point: sharp's `density` then scales it
  // by dpi/72 once (a "pt" size would be scaled by librsvg AND by sharp).
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${out.join("")}</svg>`;
}
