// Pictures in help articles. An author writes
//
//     ![Alt text](/help/<section>/<file>.webp "Caption")
//
// and the page gets
//
//     <figure><img src alt width height loading="lazy"><figcaption>Caption</figcaption></figure>
//
// with width and height READ FROM THE FILE (so the page does not jump when the picture
// loads). This is a rehype step that runs AFTER the sanitiser, like the heading ids: the
// sanitiser (HELP_SCHEMA) lets an author's image through with `src`, `alt` and `title`
// only and allows no figure, no dimensions and no loading attribute, so nothing an author
// types can name any of them. The sanitiser also strips every `src` that carries a
// protocol (http, https, javascript, data, mailto), so an external picture arrives here
// WITHOUT a src and fails below; a protocol-relative `//host/x.webp` has no protocol, and
// is refused by the path rule.
//
// Every refusal THROWS, naming the picture: a help page that renders with a missing
// picture, an empty alt or a 4 MB screenshot is worse than a failed render, and the
// help-tree sweep renders every article, so the failure arrives in CI, not in front of a
// reader. Dimensions come from sharp (already a dependency, used for poster images); no
// image reader of our own.
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import type { Element, ElementContent, Root } from "hast";

/** Where `/help/...` picture paths resolve: `public/`, as Next serves it. */
export const HELP_PUBLIC_ROOT = join(process.cwd(), "public");

/** The project's picture size budget (owner rule): no help picture over 150 KB. */
export const HELP_PICTURE_MAX_BYTES = 150 * 1024;

/** `/help/<section>/<file>.webp`, lower-case, no dots but the extension, no `..`. */
const PICTURE_SRC = /^\/help\/[a-z0-9-]+\/[a-z0-9][a-z0-9_-]*\.webp$/;

export interface HelpFigureOptions {
  /** Directory that holds `help/...`; defaults to `public/`. A seam for tests. */
  publicRoot?: string;
}

function fail(src: string | undefined, reason: string): never {
  throw new Error(`help picture ${src === undefined ? "(no src)" : `'${src}'`}: ${reason}`);
}

const isElement = (n: ElementContent | Root): n is Element => n.type === "element";
const isBlankText = (n: ElementContent): boolean => n.type === "text" && n.value.trim() === "";

/** Checks one picture and returns its dimensions; throws on any refusal. */
async function inspectPicture(img: Element, publicRoot: string): Promise<{ width: number; height: number }> {
  const src = typeof img.properties.src === "string" ? img.properties.src : undefined;
  if (src === undefined) {
    return fail(src, "the src must be a same-site /help/<section>/<file>.webp path (an external, javascript: or data: address is removed before it gets here)");
  }
  if (!/\.webp$/i.test(src)) fail(src, "only .webp pictures are accepted");
  if (!PICTURE_SRC.test(src)) fail(src, "the src must be a same-site /help/<section>/<file>.webp path");
  const alt = typeof img.properties.alt === "string" ? img.properties.alt.trim() : "";
  if (alt === "") fail(src, "alt text is required and must not be empty");

  const file = resolve(publicRoot, `.${src}`);
  // The path rule already excludes `..`; this is the guard that says so out loud.
  if (!file.startsWith(resolve(publicRoot) + sep)) fail(src, "the path leaves the public folder");
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) fail(src, `file not found (expected public${src})`);
  if (info.size > HELP_PICTURE_MAX_BYTES) {
    fail(src, `${Math.ceil(info.size / 1024)} KB is over the ${HELP_PICTURE_MAX_BYTES / 1024} KB budget`);
  }
  const meta = await sharp(file).metadata().catch(() => null);
  if (!meta || meta.format !== "webp") fail(src, "the file is not a webp image");
  if (!meta.width || !meta.height) fail(src, "the file reports no dimensions");
  return { width: meta.width, height: meta.height };
}

interface Slot {
  parent: Root | Element;
  paragraph: Element;
  img: Element;
}

/** rehype plugin: a picture alone in its paragraph becomes a figure; any other picture is refused. */
export function rehypeHelpFigures(options: HelpFigureOptions = {}) {
  const publicRoot = options.publicRoot ?? HELP_PUBLIC_ROOT;
  return async (tree: Root): Promise<void> => {
    const slots: Slot[] = [];
    const placed = new Set<Element>();
    const strays: Element[] = [];
    const collect = (node: Root | Element): void => {
      for (const child of node.children as (ElementContent | Root)[]) {
        if (!isElement(child)) continue;
        if (child.tagName === "p") {
          const content = child.children.filter((c) => !isBlankText(c));
          const only = content.length === 1 ? content[0] : undefined;
          if (only && isElement(only) && only.tagName === "img") {
            slots.push({ parent: node, paragraph: child, img: only });
            placed.add(only);
            continue;
          }
        }
        if (child.tagName === "img" && !placed.has(child)) strays.push(child);
        collect(child);
      }
    };
    collect(tree);

    if (strays.length > 0) {
      const src = strays[0]!.properties.src;
      fail(typeof src === "string" ? src : undefined, "a picture must stand alone in its own paragraph (not inline, not inside a link, not two on adjacent lines)");
    }

    const dims = await Promise.all(slots.map((s) => inspectPicture(s.img, publicRoot)));
    slots.forEach((slot, i) => {
      const { width, height } = dims[i]!;
      const caption = typeof slot.img.properties.title === "string" ? slot.img.properties.title.trim() : "";
      const { title: _title, ...kept } = slot.img.properties;
      void _title;
      const img: Element = { ...slot.img, properties: { ...kept, width, height, loading: "lazy" } };
      const figcaption: Element[] = caption
        ? [{ type: "element", tagName: "figcaption", properties: {}, children: [{ type: "text", value: caption }] }]
        : [];
      const figure: Element = { type: "element", tagName: "figure", properties: {}, children: [img, ...figcaption] };
      const siblings = slot.parent.children as ElementContent[];
      siblings[siblings.indexOf(slot.paragraph)] = figure;
    });
  };
}
