// A generated example, drawn from its committed golden: ONE table (and, once a post needs one, one diagram). Only the
// table and the fact tokens reach the page; the example's `text` lines carry scores the engine made up and are never
// rendered (blog/examples/types.ts).
//
// The table scrolls INSIDE its own box, never the page (AGENTS.md class 23): the box is a focusable, named region, so a
// keyboard user can scroll it and axe's scrollable-region-focusable is satisfied. Below `md` a one-line hint says it
// swipes. The first column stays in view while the rest scrolls.
import { BlogDiagram } from "@/components/blog/blog-diagram";
import type { ExampleResult } from "@/blog/examples/types";

export function BlogExample({ id, result, swipeHint }: { id: string; result: ExampleResult; swipeHint: string }) {
  const { table, diagram } = result;
  return (
    <>
      {table ? (
        <figure className="my-8" data-testid="blog-example" data-example={id}>
          <figcaption id={`blog-example-${id}-cap`} className="mb-2 text-sm text-slate-600">
            {table.caption}
          </figcaption>
          <div
            role="region"
            aria-labelledby={`blog-example-${id}-cap`}
            tabIndex={0}
            className="overflow-x-auto border-slate-200 bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500 rounded-xl border"
          >
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead>
                <tr>
                  {table.columns.map((c, i) => (
                    <th
                      key={c}
                      scope="col"
                      className={`border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 ${i === 0 ? "sticky left-0 z-10 bg-slate-50" : ""}`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r} className="odd:bg-white even:bg-slate-50">
                    {row.map((cell, i) =>
                      i === 0 ? (
                        <th key={i} scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-slate-100 bg-inherit px-3 py-2 font-semibold text-slate-900">
                          {cell}
                        </th>
                      ) : (
                        <td key={i} className="border-b border-slate-100 px-3 py-2 align-top text-slate-700">
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-xs text-slate-500 md:hidden max-md:px-4">{swipeHint}</p>
        </figure>
      ) : null}
      {diagram ? <BlogDiagram model={diagram} /> : null}
    </>
  );
}
