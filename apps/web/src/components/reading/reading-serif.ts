// The reading style's serif (owner pick "A", 2026-11-25; help articles too, "H1", 2026-11-26). The ONE place the face is
// declared: the blog post page and the help article page import it and put `.variable` on their own root, and globals.css
// `.reading-prose` asks for `--reading-serif`. Import it from those two route pages only: next/font adds the face's CSS to
// every route that imports this file.
//
// next/font downloads it at build and serves it from this site. NOT preloaded, on purpose: a preload hint travels with
// the route, so the blog index fetched the font as soon as it prefetched a post's link (help's home would do the same for
// an article's). Unpreloaded, the browser fetches it only where text is drawn in it; until then the text is next/font's
// metric-matched fallback.
//
// Blog and help are English only: ½, ×, the dashes and curly quotes are all in the Latin file, and one upright variable
// file covers regular and bold. No italic is loaded: help's only italics are the words "never expire" in two articles,
// which the browser slants from the upright file. The product's own symbols that help quotes (arrows, ticks) are not in the face and
// are drawn by the fallback (e2e/help.spec.ts "the reading style" names each one).
import { Source_Serif_4 } from "next/font/google";

export const readingSerif = Source_Serif_4({ subsets: ["latin"], variable: "--reading-serif", display: "swap", preload: false });
