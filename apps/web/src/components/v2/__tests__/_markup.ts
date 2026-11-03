// Static-markup helpers for the panel's tests (apps/web vitest is node-only: these tests read MARKUP, never layout - layout is the e2e's).

/** The whole element carrying `testid`, tags and all (the same tag nested is counted, so a wrapper div closes on ITS </div>); null when absent. */
export function subtreeOf(html: string, testid: string): string | null {
  const open = new RegExp(`<([a-z]+)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1]!;
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, "g");
  re.lastIndex = open.index;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index, re.lastIndex);
  }
  throw new Error(`unbalanced <${tag}> under ${testid}`);
}

/** The element's opening tag only (its attributes), null when absent. */
export function openTagOf(html: string, testid: string): string | null {
  return new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? null;
}

/** The markup strictly inside the element carrying `testid` (its opening and closing tags removed), null when absent. */
export function innerOf(html: string, testid: string): string | null {
  const whole = subtreeOf(html, testid);
  const open = openTagOf(html, testid);
  if (whole === null || open === null) return null;
  return whole.slice(open.length, whole.lastIndexOf("</"));
}

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr", "col", "area", "base", "embed", "track"]);

/** The nearest element that encloses the one carrying `testid`, whole (tags and all); null when `testid` is absent or has no parent. */
export function parentOf(html: string, testid: string): string | null {
  const target = new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!target) return null;
  const stack: Array<{ tag: string; index: number }> = [];
  const re = /<(\/?)([a-z][a-z0-9]*)(?=[\s>/])[^>]*>/g;
  for (let m = re.exec(html); m && m.index < target.index; m = re.exec(html)) {
    const tag = m[2]!;
    if (VOID_TAGS.has(tag) || m[0].endsWith("/>")) continue;
    if (m[1]) {
      const at = stack.map((x) => x.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
    } else stack.push({ tag, index: m.index });
  }
  const parent = stack[stack.length - 1];
  if (!parent) return null;
  const close = new RegExp(`<(/?)${parent.tag}(?=[\\s>/])[^>]*>`, "g");
  close.lastIndex = parent.index;
  let depth = 0;
  for (let m = close.exec(html); m; m = close.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(parent.index, close.lastIndex);
  }
  throw new Error(`unbalanced <${parent.tag}> above ${testid}`);
}
