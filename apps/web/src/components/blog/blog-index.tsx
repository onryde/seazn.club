"use client";

// The blog index (owner pick, 2026-11-19: Index A): posts grouped by topic, a sport chip rail that filters them, and from
// 1000px a sticky topic list on the left. Server-rendered with every post visible (so the page works, and indexes, with
// no JavaScript); the island only narrows the list. A post written for every sport shows under every chip, as the
// design says. The chip rail scrolls sideways below `md` and wraps from there; its buttons are the focusable content
// of that scrolling box (AGENTS.md class 23).
import Link from "next/link";
import { useState } from "react";
import { blogPostShowsFor, blogUrl, type BlogIndexGroup, type BlogIndexLabels, type BlogIndexPost, type BlogSportChip } from "@/lib/blog";

const ALL = "all";

const shows = (p: BlogIndexPost, sport: string) => sport === ALL || blogPostShowsFor(p, sport);

export function BlogIndex({ groups, chips, total, labels }: { groups: BlogIndexGroup[]; chips: BlogSportChip[]; total: number; labels: BlogIndexLabels }) {
  const [sport, setSport] = useState<string>(ALL);
  const visible = groups.map((g) => ({ ...g, posts: g.posts.filter((p) => shows(p, sport)) })).filter((g) => g.posts.length > 0);
  const count = (n: number) => (n === 1 ? labels.postOne : labels.postMany).replace("{n}", String(n));

  return (
    <div data-testid="blog-index">
      {chips.length > 0 ? (
        <div className="mt-6">
          <p id="blog-sport-filter" className="mb-2 text-sm font-semibold text-slate-900">
            {labels.filterLabel}
          </p>
          <div
            role="group"
            aria-labelledby="blog-sport-filter"
            tabIndex={0}
            className="flex gap-2 overflow-x-auto pb-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500 [scrollbar-width:none] md:flex-wrap md:overflow-visible md:pb-0 [&::-webkit-scrollbar]:hidden"
          >
            {[{ key: ALL, label: labels.allSports, count: total }, ...chips].map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={sport === c.key}
                onClick={() => setSport(c.key)}
                className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500 ${
                  sport === c.key ? "border-purple-300 bg-purple-100 font-semibold text-purple-800" : "border-slate-200 bg-white text-slate-700 hover:border-purple-200"
                }`}
              >
                {c.label}
                <span className={`text-xs font-medium ${sport === c.key ? "text-purple-600" : "text-slate-500"}`}>{c.count}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-6 min-[1000px]:grid min-[1000px]:grid-cols-[12.5rem_minmax(0,1fr)] min-[1000px]:gap-14">
        <nav aria-label={labels.topics} className="hidden min-[1000px]:sticky min-[1000px]:top-24 min-[1000px]:block min-[1000px]:self-start min-[1000px]:pt-5">
          <p className="mb-2 text-sm font-semibold text-slate-900">{labels.topics}</p>
          <ul>
            {visible.map((g) => (
              <li key={g.topic}>
                <a href={`#topic-${g.topic}`} className="flex justify-between border-l-2 border-slate-200 py-1.5 pl-3 text-sm text-slate-600 transition-colors hover:border-purple-400 hover:text-purple-800">
                  {g.label}
                  <small className="text-slate-500">{g.posts.length}</small>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          {visible.map((g) => (
            <section key={g.topic} id={`topic-${g.topic}`} aria-labelledby={`topic-${g.topic}-h`} className="mt-1.5 scroll-mt-24 border-t border-slate-200 pt-5 first:border-t-0 first:pt-0">
              <h2 id={`topic-${g.topic}-h`} className="mk-display flex items-baseline gap-2.5 text-[22px] font-bold leading-none tracking-wide text-slate-900">
                {g.label}
                <small className="font-sans text-[13px] font-medium normal-case tracking-normal text-slate-500">{count(g.posts.length)}</small>
              </h2>
              <ul className="mt-2">
                {g.posts.map((p) => (
                  <li key={p.slug} className="border-b border-slate-100 last:border-b-0">
                    <Link href={blogUrl(p.slug)} className="group block py-3 min-[1000px]:grid min-[1000px]:grid-cols-[minmax(0,1fr)_auto] min-[1000px]:items-baseline min-[1000px]:gap-4">
                      <span className="block text-base font-semibold leading-snug text-slate-900 group-hover:text-purple-800">{p.title}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-slate-500 min-[1000px]:mt-0 min-[1000px]:justify-end">
                        <time dateTime={p.date} className="mr-1">
                          {p.dateLabel}
                        </time>
                        {p.sports === "all" ? (
                          <span>{labels.everySport}</span>
                        ) : (
                          p.tags.map((t) => (
                            <span key={t} className="rounded-full bg-slate-100 px-2 py-1 text-xs leading-none text-slate-600">
                              {t}
                            </span>
                          ))
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {visible.length === 0 ? <p className="mt-2 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">{total === 0 ? labels.none : labels.empty}</p> : null}
        </div>
      </div>
    </div>
  );
}
