"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { routes } from "@/lib/routes";

interface TourStep {
  id: string;
  /** Route this step lives on — advancing across routes navigates there.
   *  Console routes are org-scoped (PROMPT-30), so paths build from the
   *  active org slug. */
  path: (org: string) => string;
  /** Matches an element's data-tour attribute; null renders a centered card. */
  target: string | null;
}

// Structure only — the step copy (title/body) is localized and comes from the
// `console` dict keyed `tour.<id>.title|body`, passed in by the server parent.
export const STEPS: TourStep[] = [
  { id: "welcome", path: (org: string) => routes.orgHome(org), target: null },
  { id: "org-chip", path: (org: string) => routes.orgHome(org), target: "org-chip" },
  { id: "org-rename", path: (org: string) => routes.orgSettings(org), target: "org-rename" },
  { id: "connect", path: (org: string) => routes.connect(org), target: "connect-stripe" },
  { id: "billing", path: (org: string) => routes.billing(org), target: "billing-plan" },
  { id: "new-competition", path: (org: string) => routes.orgHome(org), target: "new-competition" },
  { id: "wizard", path: (org: string) => routes.competitionNew(org), target: "competition-wizard" },
];

export const TOUR_STORAGE_KEY = "seazn.tour.step";
const PADDING = 8;
const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT = 220; // placement estimate; the card itself is auto-height

type Rect = { top: number; left: number; width: number; height: number };

/** Where the tooltip sits relative to the highlighted target: below when it
 *  fits, else above when it fits, else centered. A target taller than the
 *  viewport (a whole settings card on a phone) fits neither side, so it centers
 *  rather than render off-screen. A null rect (no/hidden target) also centers. */
export function placeTooltip(rect: Rect | null, vw: number, vh: number): React.CSSProperties {
  const centered: React.CSSProperties = {
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
  };
  if (!rect) return centered;
  const left = Math.min(Math.max(rect.left, 16), Math.max(vw - TOOLTIP_WIDTH - 16, 16));
  const gap = PADDING + 8;
  const belowTop = rect.top + rect.height + gap;
  if (belowTop + TOOLTIP_HEIGHT <= vh) return { top: belowTop, left };
  if (rect.top - gap - TOOLTIP_HEIGHT >= 0) return { bottom: vh - rect.top + gap, left };
  return centered;
}

function measure(target: string): Rect | null {
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * The tour's progress lives in `sessionStorage` (it has to survive the
 * cross-page navigations the tour itself triggers), so the step on screen is
 * READ from there through `useSyncExternalStore` rather than copied into state
 * by an effect. The server snapshot is "no tour", which is also what the
 * server and the hydration render show — the portal needs `document.body`, so
 * nothing may render before hydration anyway. Writes go through
 * `writeTourStep`, which notifies this tab's tour (a `storage` event only
 * reaches OTHER tabs). Storage that throws reads as "no tour".
 */
const tourListeners = new Set<() => void>();
function subscribeToTourStep(onChange: () => void): () => void {
  tourListeners.add(onChange);
  return () => {
    tourListeners.delete(onChange);
  };
}
function readTourStep(): string | null {
  try {
    return sessionStorage.getItem(TOUR_STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeTourStep(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(TOUR_STORAGE_KEY);
    else sessionStorage.setItem(TOUR_STORAGE_KEY, value);
  } catch {
    // A tour that cannot be remembered still has to be closable.
  }
  for (const notify of [...tourListeners]) notify();
}
const noTourOnServer = () => null;

/** The stored step as an index into STEPS, or null when absent or junk. */
function storedIndex(stored: string | null): number | null {
  if (stored === null) return null;
  const i = Number(stored);
  return Number.isInteger(i) && STEPS[i] ? i : null;
}

/** `dict` is the localized `console` tour slice (keys `tour.*`), resolved by the
 *  server parent (Nav) and passed in — client islands can't import the
 *  server-only t(). */
export function ProductTour({
  autoStart,
  orgSlug,
  dict,
}: {
  autoStart: boolean;
  orgSlug: string;
  dict: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // The step on screen: the stored one, but only on ITS page. A stored step
  // for another path is a navigation the tour triggered that is still in
  // flight — hidden here, resumed by the destination page's tour.
  const storedStep = storedIndex(useSyncExternalStore(subscribeToTourStep, readTourStep, noTourOnServer));
  const step = storedStep !== null && STEPS[storedStep].path(orgSlug) === pathname ? storedStep : null;
  const target = step === null ? null : STEPS[step].target;
  // A measurement belongs to the target it measured: a targetless step, or a
  // step whose target has not been measured yet, shows the centred card rather
  // than a spotlight left over from another step.
  const [measured, setMeasured] = useState<{ target: string; rect: Rect | null } | null>(null);
  const rect = target !== null && measured?.target === target ? measured.rect : null;

  // Writes only, never a state copy: drop a junk key, or auto-start on the
  // dashboard for users who haven't completed the tour. Keyed on the page, not
  // on the stored value — re-running after `finish()` cleared the key would
  // restart the tour the user just closed (`autoStart` stays true until the
  // server re-renders).
  useEffect(() => {
    const stored = readTourStep();
    if (stored !== null) {
      if (storedIndex(stored) === null) writeTourStep(null);
      return;
    }
    if (autoStart && pathname === routes.orgHome(orgSlug)) writeTourStep("0");
  }, [autoStart, pathname, orgSlug]);

  const finish = useCallback((markDone: boolean) => {
    writeTourStep(null);
    if (markDone) fetch("/api/tour", { method: "POST" }).catch(() => {});
  }, []);

  const goTo = useCallback(
    (i: number) => {
      if (i >= STEPS.length) {
        finish(true);
        return;
      }
      if (i < 0) return;
      // On another page this hides the tour until the destination resumes it.
      writeTourStep(String(i));
      if (STEPS[i].path(orgSlug) !== pathname) router.push(STEPS[i].path(orgSlug));
    },
    [pathname, router, finish, orgSlug],
  );

  // Track the highlighted element's position; poll briefly in case it renders
  // after navigation, then follow resize/scroll.
  useEffect(() => {
    if (target === null) return;
    const setRect = (r: Rect | null) => setMeasured({ target, rect: r });
    let cancelled = false;
    let attempts = 0;
    let scrolled = false;

    const update = () => {
      if (cancelled) return;
      const r = measure(target);
      if (r) {
        if (!scrolled) {
          scrolled = true;
          document
            .querySelector(`[data-tour="${target}"]`)
            ?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
          setRect(measure(target));
        } else {
          setRect(r);
        }
      } else if (attempts++ < 20) {
        setTimeout(update, 50);
      } else {
        setRect(null); // target missing (e.g. hidden on mobile) — centered card
      }
    };
    update();

    const follow = () => {
      if (!cancelled && scrolled) setRect(measure(target));
    };
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [target]);

  // Escape skips the tour.
  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, finish]);

  // `step` is null on the server and through hydration (server snapshot), so
  // the portal below only ever renders on the client.
  if (step === null) return null;
  const s = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const title = dict[`tour.${s.id}.title`] ?? "";
  const body = dict[`tour.${s.id}.body`] ?? "";

  // Tooltip placement: below the target when it fits, else above, else centered
  // (a target taller than the viewport would push the tooltip off-screen).
  const tooltipStyle = placeTooltip(rect, window.innerWidth, window.innerHeight);

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={dict["tour.dialogLabel"]}>
      {/* Dim layer — spotlight cut-out around the target via box-shadow */}
      {rect ? (
        <div
          className="pointer-events-none fixed rounded-xl ring-2 ring-purple-400 transition-all duration-300"
          style={{
            top: rect.top - PADDING,
            left: rect.left - PADDING,
            width: rect.width + PADDING * 2,
            height: rect.height + PADDING * 2,
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)",
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-slate-900/55" />
      )}

      {/* Tooltip */}
      <div
        className="fixed rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
        style={{ width: TOOLTIP_WIDTH, ...tooltipStyle }}
      >
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{body}</p>

        <div className="mt-4 flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-4 bg-purple-500" : "w-1.5 bg-slate-200"
              }`}
            />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => finish(true)}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            {dict["tour.skip"]}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button type="button" onClick={() => goTo(step - 1)} className="btn btn-ghost text-xs">
                {dict["tour.back"]}
              </button>
            )}
            <button type="button" onClick={() => goTo(step + 1)} className="btn btn-primary text-xs">
              {isLast ? dict["tour.finish"] : dict["tour.next"]}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
