"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RungWeights } from "@/lib/ai-rung";
import type { Dict, Locale } from "@/lib/i18n-constants";

/**
 * The Scheduling page's recorded-runs section, loaded only when the visitor scrolls near it. The replay
 * (recorded-runs-replay.tsx) renders through the product's own board components and dictionary provider, which more
 * than double the page's script; nobody at the top of the page needs them. Until then the section is its heading and
 * sub-line, so the page reads complete with script off and the layout holds its place.
 *
 * Fails open: with no IntersectionObserver the replay loads straight after hydration.
 */
const Replay = dynamic(() => import("./recorded-runs-replay"), { ssr: false });

const noSubscribe = () => () => {};
const hasObserver = () => typeof IntersectionObserver !== "undefined";

export function RecordedRuns({ locale, weights, dict, title, subtitle }: { locale: Locale; weights: RungWeights; dict: Dict; title: string; subtitle: string }) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  const observer = useSyncExternalStore(noSubscribe, hasObserver, () => true);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  if (seen || !observer) return <Replay locale={locale} weights={weights} dict={dict} />;
  return (
    <section ref={ref} className="min-h-[60vh] bg-[var(--mk-night)] px-4 py-14 sm:py-16" data-runs="waiting">
      <div className="mx-auto max-w-4xl">
        <h2 className="mk-display text-3xl font-bold text-[var(--mk-cream)] sm:text-4xl">{title}</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[#b3a4dd]">{subtitle}</p>
      </div>
    </section>
  );
}
