// The CSS Tailwind actually generates for a set of utility classes, compiled through the repo's own pipeline (`@tailwindcss/postcss`
// over the real globals.css, so its `@theme` is in force) — for a test that must see a COLOUR, not a class name. `apps/web` vitest is
// `environment: "node"`: no DOM and no cascade, so the only way to prove that `outline-accent` paints `--ps-accent` while
// `outline-violet-600` paints Tailwind's own violet (rgb 127 34 254, a different colour) is to read what the utilities compile to.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const GLOBALS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "globals.css");

/** Everything one class compiles to, as `property -> value` (nested rules such as `&:focus-visible` included). Empty when the class
 *  generates nothing — an unknown utility compiles to no rule at all, which the caller must treat as a failure. */
export type CompiledClass = Record<string, string>;

const escapeClass = (c: string): string => c.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

/** Compile `classes` (as if each appeared in the source) over the real globals.css and read each one's declarations back. */
export async function compileClasses(classes: readonly string[]): Promise<Map<string, CompiledClass>> {
  const input = `${readFileSync(GLOBALS, "utf8")}\n@source inline("${classes.join(" ")}");\n`;
  const out = await postcss([tailwind({ base: dirname(GLOBALS) })]).process(input, { from: GLOBALS });
  const root = postcss.parse(out.css);
  const found = new Map<string, CompiledClass>();
  for (const c of classes) {
    const decls: CompiledClass = {};
    root.walkRules((rule) => {
      if (rule.selector !== `.${escapeClass(c)}`) return;
      rule.walkDecls((d) => { decls[d.prop] = d.value; });
    });
    found.set(c, decls);
  }
  return found;
}
