"use client";
import { useEffect, useState } from "react";
import { EVENTS, track } from "@/lib/analytics";

/**
 * Pure helper (regression-tested in node env — no window/DOM needed): builds
 * the absolute share URL and the WhatsApp deep-link from an explicit origin.
 */
export function shareLinks(
  origin: string,
  path: string,
  title: string,
): { url: string; wa: string } {
  const url = `${origin}${path}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`${title} — ${url}`)}`;
  return { url, wa };
}

/**
 * Every word this row can say.
 *
 * ALL FIVE OR NONE, deliberately — not a `Partial`. A caller that can supply
 * four of these can supply the fifth, and a partial override is how one control
 * in a translated row stays in English with nothing red to say so: the `share`
 * label in particular renders only after mount on a device with
 * `navigator.share`, so a missed one is invisible to every server-rendered
 * test AND to a desktop reviewer.
 */
export interface ShareBarLabels {
  /** The native share-sheet button. Mobile only — see `canShare` below. */
  share: string;
  /** The WhatsApp link's visible text. */
  whatsapp: string;
  /** Its accessible name, which REPLACES that text for a screen reader — so it
   *  is a separate string, not a copy of it (a link list otherwise reads the
   *  same two words on every share row on the site). */
  whatsappAria: string;
  /** The copy button, before and after the click. */
  copy: string;
  copied: string;
}

/** The English this component shipped with, unchanged, so the callers that
 *  pass no labels (the org news post page) render exactly what they did
 *  before. New public-surface callers pass the four locales' own copy from
 *  `public.json`'s `share.*` family. */
const DEFAULT_LABELS: ShareBarLabels = {
  share: "Share",
  whatsapp: "WhatsApp",
  whatsappAria: "Share on WhatsApp",
  copy: "Copy link",
  copied: "Copied ✓",
};

/** Fan-facing share row (PLG L3): native share on mobile, WhatsApp + copy
 *  everywhere. Grassroots sport runs on WhatsApp. An optional `postShare` adds
 *  news-post context (SPEC-2): each share ALSO fires POST_SHARED{kind,channel}
 *  alongside the generic SHARE_FIRED — the component is reused, not forked. */
export function ShareBar({
  path,
  title,
  postShare,
  labels,
}: {
  path: string;
  title: string;
  postShare?: { kind: string };
  labels?: ShareBarLabels;
}) {
  const L = labels ?? DEFAULT_LABELS;
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator !== "undefined" && "share" in navigator);
  }, []);
  const { url, wa } = shareLinks(origin, path, title);

  function fire(channel: string) {
    track(EVENTS.SHARE_FIRED, { channel });
    if (postShare) track(EVENTS.POST_SHARED, { channel, kind: postShare.kind });
  }

  async function native() {
    fire("native");
    try {
      await navigator.share?.({ title, url });
    } catch {
      /* dismissed */
    }
  }
  async function copy() {
    fire("copy");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* blocked */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {canShare && (
        <button
          type="button"
          onClick={native}
          className="btn btn-ghost min-h-11"
          data-testid="native-share"
        >
          {L.share}
        </button>
      )}
      <a
        href={wa}
        target="_blank"
        rel="noreferrer"
        onClick={() => fire("whatsapp")}
        className="btn btn-ghost min-h-11"
        aria-label={L.whatsappAria}
      >
        {L.whatsapp}
      </a>
      <button type="button" onClick={copy} className="btn btn-ghost min-h-11">
        {copied ? L.copied : L.copy}
      </button>
    </div>
  );
}
