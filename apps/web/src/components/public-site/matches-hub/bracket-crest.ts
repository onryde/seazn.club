// The crest chip a bracket draws in front of a side's name: 14px, so it fits
// the Knockout Draw's 22px row. ONE authority for both trees that draw it, the
// division page's bracket (`bracket.tsx`) and the hub's Draw
// (`knockout-tab.tsx`, owner ruling v1), and the suite asserts against this
// same import rather than parsing either file's source (review N2 m3).
//
// A leaf with no imports, and deliberately not an export of `bracket.tsx`.
// That file is a server component whose value imports reach
// `@seazn/engine/scheduling` and `@seazn/engine/competition`, and the Knockout
// tab is `"use client"`. Importing the bracket there would pull that graph into
// the hub's client bundle for the sake of one string.
export const BRACKET_CREST_CLASS = "h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover";
