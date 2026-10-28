"use client";
// The fixture stream panel's destination picker (YouTube Connect T12, owner's Option B, 2026-10-27): a custom list, not a native
// <select>, because a native option is plain text and the club needs to see — before it taps Go live — what each destination IS
// (a YouTube channel it connected, or a pasted stream key) and how it is (a channel that needs reconnecting, one not enabled for
// live yet). Each row: the platform's mark, the destination's name, a second line saying what kind it is, and — for a connected
// channel whose health is anything but "ready" — a badge on a line of its own UNDER them, so the name keeps the whole text column
// (channels of one club share a long prefix: a badge beside the name cut it to "Alph…" and "Bravo Riv…", even at 768). The selected
// row says so with a check.
//
// Layout only is from the mock (`youtube-ui-options.html`, Option B); everything else is the house theme. The open list is drawn IN
// FLOW under the trigger, never floated: on a 320 px phone a floating list is clipped by whatever `overflow-hidden` card holds the
// panel, and an in-flow list simply moves the controls below it down while it is open.
//
// Semantics: the W3C "select-only combobox" — the trigger is a <button role="combobox"> that keeps focus, the list is a
// role="listbox" of role="option"s, and the arrow keys move `aria-activedescendant`. Typing the first letters of a destination's name
// jumps to it (a buffered prefix match, reset after a pause), as a native <select> did. A visible <label htmlFor={id}> names it (a
// button is a labelable element). One DOM at every width; the rows are at least 56 px, past the 44 px tap floor.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronRight } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { PlatformMark, STREAM_KIND_BRAND, platformName } from "./stream-platform-mark";
import { PRIVACY_KEY, TONE, channelStatus, youtubeTargetLabel, type Tone } from "./youtube-connect-panel";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** A pause this long in typing starts the typeahead over (a native <select>'s own is about the same). */
export const TYPEAHEAD_RESET_MS = 500;

/** What one destination reads as in the list. Pure, so the node harness can prove every kind and every health without a DOM. */
export interface DestinationRow {
  id: string;
  name: string;
  /** "YouTube channel · Unlisted" for a connected channel, "{Platform} stream key" for a pasted one. */
  kind: string;
  /** A connected channel's health when it is NOT plain ready (fail-closed through `channelStatus`); null for a ready channel and for
   *  every pasted key (nothing is known about a key's health, so none is claimed). */
  health: { tone: Exclude<Tone, "ok">; text: string } | null;
}

/** The row's second line: a connected channel names the platform and who can watch; a pasted key names the platform's key. */
function kindLine(msg: Msg, t: StreamTarget): string {
  if (t.youtube) return `${msg("stream.dest.kind.channel", { platform: STREAM_KIND_BRAND.youtube })} · ${msg(PRIVACY_KEY[t.youtube.privacy])}`;
  if (t.kind === "custom_rtmp") return msg("stream.dest.kind.keyOther");
  return msg("stream.dest.kind.key", { platform: platformName(msg, t.kind) });
}

export function destinationRow(msg: Msg, t: StreamTarget): DestinationRow {
  const status = t.youtube ? channelStatus(t.youtube) : null;
  return {
    id: t.id,
    name: youtubeTargetLabel(msg, t.label),
    kind: kindLine(msg, t),
    health: status && status.tone !== "ok" ? { tone: status.tone, text: msg(status.pill) } : null,
  };
}

function HealthBadge({ health }: { health: NonNullable<DestinationRow["health"]> }) {
  const tone = TONE[health.tone];
  return (
    <span data-testid="stream-target-health" data-tone={health.tone} className={`badge inline-flex min-w-0 items-center gap-1.5 normal-case ring-1 ${tone.pill}`}>
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <span className="min-w-0">{health.text}</span>
    </span>
  );
}

/** The mark, the name, the kind line and — when the channel is not plain ready — the badge on its own line under them: the trigger and
 *  every row read the same, so a row IS what the trigger will say once picked. */
function Identity({ t, row }: { t: StreamTarget; row: DestinationRow }) {
  return (
    <>
      <PlatformMark kind={t.kind} size="md" />
      <span className="min-w-0 flex-1 text-left">
        <span data-testid="stream-target-name" title={row.name} className="block truncate text-sm font-semibold text-slate-900">{row.name}</span>
        <span data-testid="stream-target-kind" className="block truncate text-xs text-slate-600">{row.kind}</span>
        {row.health && (
          <span className="mt-1 flex">
            <HealthBadge health={row.health} />
          </span>
        )}
      </span>
    </>
  );
}

export interface FixtureDestinationPickerProps {
  /** The trigger's DOM id — the panel's visible <label htmlFor> points here. */
  id: string;
  targets: StreamTarget[];
  /** The picked destination; null (or an id the list no longer holds) shows the placeholder. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The red field: a refusal about THIS destination is showing under it. */
  invalid?: boolean;
  describedBy?: string;
  /** "Use another destination" (the refusal block) asks the picker to open: each increase opens the list and puts focus on the
   *  trigger. The first value is the baseline — mounting with a non-zero signal opens nothing. */
  openSignal?: number;
}

export function FixtureDestinationPicker({ id, targets, selectedId, onSelect, invalid, describedBy, openSignal = 0 }: FixtureDestinationPickerProps) {
  const msg = useMsg();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = targets.findIndex((t) => t.id === selectedId);
  const [active, setActive] = useState(0);
  // Typeahead: the letters typed so far and when the last one landed. A ref, not state: it never draws anything.
  const typed = useRef({ text: "", at: 0 });
  // The panel's "Use another destination" bumps `openSignal`: open the list on that change (state adjusted while rendering, the
  // sanctioned pattern for a prop that changed), and focus the trigger once it has committed.
  const [seenSignal, setSeenSignal] = useState(openSignal);
  if (openSignal !== seenSignal) {
    setSeenSignal(openSignal);
    if (openSignal > seenSignal) {
      setActive(selectedIndex >= 0 ? selectedIndex : 0);
      setOpen(true);
    }
  }
  const baseline = useRef(openSignal);
  useEffect(() => {
    if (openSignal > baseline.current) trigger.current?.focus();
  }, [openSignal]);
  const rows = targets.map((t) => destinationRow(msg, t));
  // The list may shrink while it is open (a poll drops a destination): `active` is read clamped, so aria-activedescendant never names
  // a row that is gone.
  const activeIndex = Math.min(active, Math.max(0, targets.length - 1));
  const selected = selectedIndex >= 0 ? targets[selectedIndex]! : null;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex]! : null;
  const optionId = (i: number) => `${listId}-o${i}`;

  // A press anywhere outside the picker closes the list. Registered only while open.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const show = () => {
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };
  const pick = (i: number) => {
    const t = targets[i];
    // The row already picked closes the list and saves nothing: a re-pick would PUT the same choice again, mark it "picked here"
    // and clear a hold the organiser has not resolved.
    if (t && t.id !== selectedId) onSelect(t.id);
    setOpen(false);
  };
  // A printable key: extend the buffer (or start it over after a pause) and move to the first row whose NAME starts with it, opening
  // the list if it was closed. A key that matches nothing moves nothing. (A space reaches here only mid-word; see the Enter/Space case.)
  const typeahead = (key: string): boolean => {
    const now = Date.now();
    const cur = typed.current;
    const fresh = now - cur.at > TYPEAHEAD_RESET_MS;
    const text = (fresh ? "" : cur.text) + key.toLocaleLowerCase();
    typed.current = { text, at: now };
    const hit = rows.findIndex((r) => r.name.toLocaleLowerCase().startsWith(text));
    if (hit < 0) return false;
    setActive(hit);
    setOpen(true);
    return true;
  };
  const last = targets.length - 1;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!open) return show();
        const step = e.key === "ArrowDown" ? 1 : -1;
        return setActive((a) => Math.min(last, Math.max(0, a + step)));
      }
      case "Home":
      case "End":
        if (!open) return;
        e.preventDefault();
        return setActive(e.key === "Home" ? 0 : last);
      case "Enter":
      case " ":
        e.preventDefault();
        // Mid-word, a space belongs to the typeahead ("Court 1"): it extends the buffer and never picks or opens.
        if (e.key === " " && typed.current.text !== "" && Date.now() - typed.current.at <= TYPEAHEAD_RESET_MS) {
          typeahead(" ");
          return;
        }
        return open ? pick(activeIndex) : show();
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        return;
      case "Tab":
        // Leaving the control closes the list; nothing is picked by walking past it.
        return setOpen(false);
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && typeahead(e.key)) e.preventDefault();
    }
  };

  return (
    <div ref={root} data-testid="stream-target-picker" data-open={open ? "true" : "false"} className="min-w-0">
      <button
        ref={trigger}
        type="button"
        id={id}
        role="combobox"
        data-testid="stream-target"
        data-value={selected ? selected.id : ""}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={`flex min-h-14 w-full min-w-0 items-center gap-3 rounded-md border bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200 ${
          invalid ? "border-red-300 ring-1 ring-red-200" : "border-slate-200"
        }`}
      >
        {selected && selectedRow ? (
          <Identity t={selected} row={selectedRow} />
        ) : (
          // Nothing picked (the choice was removed on the Streaming page): a prompt, never a destination chosen for them.
          <span data-testid="stream-target-placeholder" className="min-w-0 flex-1 truncate text-left text-slate-600">
            {msg("stream.dest.pick")}
          </span>
        )}
        <ChevronRight aria-hidden className={`h-4 w-4 shrink-0 text-slate-600 transition-transform motion-reduce:transition-none ${open ? "-rotate-90" : "rotate-90"}`} strokeWidth={1.8} />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          data-testid="stream-target-list"
          aria-label={msg("stream.dest.label")}
          // A press on a row must not move focus off the trigger (the trigger owns the keyboard), so it never blurs mid-pick.
          onMouseDown={(e) => e.preventDefault()}
          className="mt-1.5 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white"
        >
          {targets.map((t, i) => {
            const row = rows[i]!;
            const isSelected = i === selectedIndex;
            return (
              <li
                key={t.id}
                id={optionId(i)}
                role="option"
                aria-selected={isSelected}
                data-testid="stream-target-option"
                data-target-id={t.id}
                data-active={i === activeIndex ? "true" : undefined}
                onClick={() => pick(i)}
                onMouseEnter={() => setActive(i)}
                className={`flex min-h-14 min-w-0 cursor-pointer items-center gap-3 px-3 py-2 ${isSelected ? "bg-purple-50" : i === activeIndex ? "bg-slate-50" : "bg-white"}`}
              >
                <Identity t={t} row={row} />
                {isSelected && <Check aria-hidden className="h-4 w-4 shrink-0 text-purple-700" strokeWidth={2} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
