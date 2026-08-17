"use client";

// A horizontally-scrolling tab strip hides its own active tab once the tabs
// stop fitting. P8 added a fourth Directory tab, which pushed "Venues" past the
// right edge at 320px: you land on that tab and cannot see which one is
// selected. The strip is *meant* to scroll, so a no-horizontal-scroll gate
// cannot catch this — only looking at the rendered page at 320 does.
//
// Scrolling the marked child into view on mount fixes it for every tab count,
// rather than tuning padding until four happens to fit. `block: "nearest"`
// keeps the page from jumping vertically; `inline: "center"` is what actually
// brings an off-screen tab in.
import { useEffect, useRef } from "react";

export function ScrollActiveTabIntoView({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = ref.current?.querySelector('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "center" });
  }, []);

  return <div ref={ref}>{children}</div>;
}
