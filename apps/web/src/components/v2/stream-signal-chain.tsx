"use client";
// The stream panel's Signal path — Phone ── Seazn ── {platform} (spec 2026-09-30 §3.2, D5; mockup option-a.html) — and
// the D3 warning box under it. A DRAWING of `chainFor` (lib/stream-chain.ts): every tone, word and link style comes from
// that one mapping, so this file decides nothing about a session. Lime is a ring or a line, never text (D5); the words
// use ink and muted colours. The walkthrough reads the chain by its data attributes, never by its colours.
import type { ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { platformName } from "@/components/v2/stream-platform-mark";
import type { Chain, ChainNode, ChainWord, LinkStyle, NodeTone } from "@/lib/stream-chain";
import type { MessageKey } from "@/lib/messages";
import type { StreamTargetKind } from "@/server/api-v1/schemas";

const TONE_RING: Record<NodeTone, string> = {
  slate: "bg-white text-slate-500 ring-1 ring-slate-300",
  amber: "bg-amber-50 text-amber-700 ring-2 ring-amber-400",
  lime: "bg-white text-[var(--mk-night)] ring-2 ring-[var(--mk-lime)]",
  red: "bg-red-50 text-red-600 ring-2 ring-red-500",
};
/** The D3 node's ring is one step stronger than a waiting amber (mockup state 4). */
const BANG_RING = "bg-amber-50 text-amber-700 ring-2 ring-amber-500";

/** The state word's ink: muted for slate, ink for lime (never lime itself), and each warm tone's AA-safe shade. */
const TONE_WORD: Record<NodeTone, string> = {
  slate: "text-slate-500",
  lime: "text-slate-700",
  amber: "text-amber-700",
  red: "text-red-600",
};

const WORD_KEYS: Record<ChainWord, MessageKey> = {
  notConnected: "stream.chain.word.notConnected",
  ready: "stream.chain.word.ready",
  notLive: "stream.chain.word.notLive",
  inUse: "stream.chain.word.inUse",
  waiting: "stream.chain.word.waiting",
  connected: "stream.chain.word.connected",
  receiving: "stream.chain.word.receiving",
  live: "stream.chain.word.live",
  connecting: "stream.chain.word.connecting",
  notReceiving: "stream.chain.word.notReceiving",
  noSignal: "stream.chain.word.noSignal",
  ending: "stream.chain.word.ending",
};

const ICON = "h-5 w-5";
const svgProps = {
  className: ICON,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const PhoneIcon = () => (
  <svg {...svgProps}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </svg>
);
const SeaznIcon = () => (
  <svg {...svgProps}>
    <path d="M16.2 7.6c-.8-1.3-2.3-2.1-4.1-2.1-2.4 0-4.1 1.2-4.1 3.1 0 4.4 8.4 2.5 8.4 7 0 1.9-1.8 3-4.4 3-1.9 0-3.6-.8-4.4-2.2" />
  </svg>
);
const PlayIcon = () => (
  <svg {...svgProps}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="3.5" />
    <path d="M10 9.3v5.4l4.6-2.7z" fill="currentColor" />
  </svg>
);

function Node({ node, icon, name, wide }: { node: ChainNode; icon: ReactNode; name: ReactNode; wide?: boolean }) {
  const msg = useMsg();
  return (
    // `min-w-0`, not the mockup's `shrink-0`: at 125% zoom on a 320-px phone (a 256-px layout, A11) three fixed 64-px nodes
    // pass the viewport. Each keeps its 64 px wherever it fits and gives way below; its ring never does.
    <div className={`flex w-16 min-w-0 flex-col items-center text-center ${wide ? "md:w-52" : "md:w-24"}`}>
      <span
        data-tone={node.tone}
        className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-full ${node.mark === "bang" ? BANG_RING : TONE_RING[node.tone]}`}
      >
        {icon}
        {node.mark === "dot" && (
          <span data-mark="dot" aria-hidden className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-white bg-red-500" />
        )}
        {node.mark === "bang" && (
          // An SVG "!", not a text glyph: white text on amber-500 would be a sub-AA text run; the word below says it.
          <span
            data-mark="bang"
            aria-hidden
            className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full border-2 border-white bg-amber-500"
          >
            <svg viewBox="0 0 8 8" className="h-2 w-2" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
              <path d="M4 1.2v3.3M4 6.6v.1" />
            </svg>
          </span>
        )}
      </span>
      {wide ? (
        // B5 review m-3: the destination's name is the one the panel cannot spare at ≥768 (in Live the picker is gone),
        // so it wraps there rather than truncating; below 768 it is the platform alone, and its label has its own line.
        <span
          data-testid="stream-chain-dest-name"
          className="mt-2 max-w-full truncate text-xs font-semibold text-slate-800 md:whitespace-normal md:text-sm md:[overflow-wrap:anywhere]"
        >
          {name}
        </span>
      ) : (
        <span className="mt-2 max-w-full truncate text-xs font-semibold text-slate-800 md:text-sm">{name}</span>
      )}
      <span className={`mt-0.5 text-[11px] leading-tight md:text-xs ${TONE_WORD[node.tone]}`}>
        {node.word === "live" && (
          <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 -translate-y-px rounded-full bg-red-500" />
        )}
        {msg(WORD_KEYS[node.word])}
      </span>
    </div>
  );
}

function Link({ style }: { style: LinkStyle }) {
  return (
    <div className="flex h-10 min-w-3 flex-1 items-center" aria-hidden>
      <div className={`w-full stream-link-${style}`} />
    </div>
  );
}

/** "To {label}" with the label in ink — split on a sentinel so the locale owns the word order around it. */
function toLabel(msg: ReturnType<typeof useMsg>, label: string): ReactNode {
  const SENTINEL = "\u0001";
  const [before = "", after = ""] = msg("stream.chain.to", { label: SENTINEL }).split(SENTINEL);
  return (
    <>
      {before}
      <span className="font-medium text-slate-700">{label}</span>
      {after}
    </>
  );
}

export function SignalChain({
  chain,
  destination,
  phoneStatus,
}: {
  chain: Chain;
  destination: { kind: StreamTargetKind; label: string };
  /** D9 (spec §3.4): the capture-v2 branch's one-line phone summary under the Phone node's word. */
  phoneStatus?: string;
}) {
  // D9: reserved for capture v2's heartbeat summary — this branch renders nothing here.
  void phoneStatus;
  const msg = useMsg();
  const platform = platformName(msg, destination.kind);
  const word = (n: ChainNode) => msg(WORD_KEYS[n.word]);
  return (
    <div
      data-testid="stream-chain"
      data-phone={chain.phone.word}
      data-seazn={chain.seazn.word}
      data-dest={chain.dest.word}
      data-link1={chain.link1}
      data-link2={chain.link2}
      className="mt-4 rounded-lg border-t-2 border-[var(--mk-lime)] bg-white px-1 py-4 ring-1 ring-purple-100 md:px-6"
    >
      <div
        role="group"
        aria-label={msg("stream.chain.aria", { phone: word(chain.phone), seazn: word(chain.seazn), platform, dest: word(chain.dest) })}
      >
        <div className="flex items-start">
          <Node node={chain.phone} icon={<PhoneIcon />} name={msg("stream.chain.phone")} />
          <Link style={chain.link1} />
          <Node node={chain.seazn} icon={<SeaznIcon />} name={msg("stream.chain.seazn")} />
          <Link style={chain.link2} />
          <Node
            node={chain.dest}
            icon={<PlayIcon />}
            wide
            name={
              <>
                <span className="md:hidden">{platform}</span>
                <span className="max-md:hidden">{`${platform} · ${destination.label}`}</span>
              </>
            }
          />
        </div>
        <p data-testid="stream-chain-dest-label" className="mt-2 text-center text-xs text-slate-500 [overflow-wrap:anywhere] md:hidden">
          {toLabel(msg, destination.label)}
        </p>
      </div>
    </div>
  );
}

/** D3 (spec §3.2): live from the phone, the destination not receiving for 30 s or more. A warning — the stream keeps
 *  running and Stop stays one tap away; only the server ends a session (`rejected`). */
export function DestinationWarning({ kind }: { kind: StreamTargetKind }) {
  const msg = useMsg();
  return (
    <div
      data-testid="stream-output-warning"
      role="status"
      className="mt-3 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3.5 2.5 20h19z" />
        <path d="M12 10v4.5M12 17.2v.1" />
      </svg>
      <p className="min-w-0">
        <span>{msg("stream.output.warning", { platform: platformName(msg, kind) })}</span>{" "}
        <a
          data-testid="stream-output-open-directory"
          href="/directory?tab=streaming"
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-11 items-center font-medium text-amber-900 underline decoration-amber-400 underline-offset-2 hover:decoration-amber-600 md:min-h-0"
        >
          {msg("stream.output.openDirectory")}
        </a>
      </p>
    </div>
  );
}
