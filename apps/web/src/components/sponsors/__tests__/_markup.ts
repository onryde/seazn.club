// Reading `renderToStaticMarkup` output without a DOM (the workspace has no jsdom): just enough to pick out an element by its
// data-testid, its attributes and its text. Used by the Sponsors list tests, where what is asserted is the MARKUP a person's
// browser is handed (classes that fold a control at md, the ids a button points at, the words in a row).

/** The attribute value on an opening tag, or undefined (a bare boolean attribute reads as ""). */
export function attrOf(openTag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s/>])`).exec(openTag);
  if (!m) return undefined;
  return m[1] === undefined ? "" : m[1].replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
}

/** The class tokens on an opening tag, whole (`max-md:hidden` is one token and `md:hidden` is another). */
export function classTokens(openTag: string): string[] {
  return (attrOf(openTag, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** The opening tag of an element, its balanced outer HTML and its inner HTML. */
export interface Found {
  open: string;
  outer: string;
  inner: string;
}

/** Every element carrying `data-testid="<testid>"`, as balanced outer HTML (nested same-name tags are matched, so a chip with
 *  an inner `<span>` still ends at its own `</span>`). `within` narrows the search to one parent's markup. */
export function findAll(markup: string, testid: string): Found[] {
  const out: Found[] = [];
  const needle = `data-testid="${testid}"`;
  let from = 0;
  for (;;) {
    const at = markup.indexOf(needle, from);
    if (at < 0) return out;
    const start = markup.lastIndexOf("<", at);
    const tag = /^<([a-zA-Z0-9]+)/.exec(markup.slice(start))![1]!;
    const openEnd = markup.indexOf(">", at) + 1;
    const open = markup.slice(start, openEnd);
    let depth = 1;
    let i = openEnd;
    const re = new RegExp(`<(/?)${tag}(?=[\\s/>])[^>]*>`, "g");
    re.lastIndex = openEnd;
    let end = openEnd;
    for (let m = re.exec(markup); m; m = re.exec(markup)) {
      if (m[1] === "/") depth -= 1;
      else if (!m[0].endsWith("/>")) depth += 1;
      i = re.lastIndex;
      if (depth === 0) {
        end = m.index;
        break;
      }
    }
    out.push({ open, outer: markup.slice(start, i), inner: markup.slice(openEnd, end) });
    from = openEnd;
  }
}

export function findOne(markup: string, testid: string): Found {
  const all = findAll(markup, testid);
  if (all.length !== 1) throw new Error(`expected exactly one data-testid="${testid}", found ${all.length}`);
  return all[0]!;
}

/** The words in a piece of markup: tags dropped, entities decoded, whitespace collapsed. */
export function textOfMarkup(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}
