"use client";

// The gantry's account menu (owner picked Option A, 2026-11-11; mock of record: nav-account-menu-mocks section A, layout only -
// built in the house night/cream/lime). ONE trigger at the right end of the bar - the avatar, and from `lg` the display name -
// replaces the Settings icon, the name, Sign out and the Player home link. It opens who you are, every organisation (the current
// one ticked; choosing another switches to it), Organisation settings / Account / Player home, and Sign out last.
//
// One DOM, branched: below `md` the panel is a bottom sheet over a scrim with 48px rows (a phone can switch org for the first
// time - the org chip is hidden there); from `md` the same panel is a ~300px dropdown anchored under the trigger's right edge.
// It is PORTALLED to <body>: the gantry is `sticky z-20`, a stacking context, and page chrome above it (the settings strip,
// sticky z-30; the board tray, fixed z-30) would otherwise paint over the sheet and its scrim.
//
// Dismissal is the help menu's pattern: outside pointerdown, Escape, and after choosing. Because the panel is portalled to the
// end of <body>, focus moves INTO it on open (Tab from the trigger would otherwise skip it), arrow keys move between items,
// and Escape or Tab hands focus back to the trigger.
import Link from "next/link";
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, CircleUserRound, LogOut, Plus, Settings, UserRound } from "lucide-react";
import { resetOnBfcacheRestore, accountMenuModel, initialsOf, type AccountMenuModel, type AccountMenuOrgInput } from "@/lib/account-menu";
import { switchActiveOrg } from "@/lib/org-switch";
import { useSignOut } from "@/components/logout-button";
import type { OrgRole } from "@/lib/types";

/** Localized copy, resolved by the server parent (Nav) - client islands can't import the server-only t(). */
export interface AccountMenuLabels {
  /** The trigger's accessible name, and the menu's. */
  menu: string;
  organisation: string;
  newOrg: string;
  orgSettings: string;
  /** The personal Account settings tab. */
  profile: string;
  playerHome: string;
  signOut: string;
  switching: string;
  /** Inline error row: a switch or sign-out that could not complete. */
  error: string;
  /** The role hint for each role that cannot edit (a viewer). */
  roles: Partial<Record<OrgRole, string>>;
}

export interface AccountMenuProps {
  user: { displayName: string; email: string | null };
  orgs: AccountMenuOrgInput[];
  /** The org the chrome is showing (Nav's pickActiveOrg), or null without one. */
  activeOrgId: string | null;
  isPlayer: boolean;
  labels: AccountMenuLabels;
}

/** Where the md+ dropdown sits: just under the trigger, its right edge on the trigger's. Measured, not guessed - the bar is
 *  centred in a `max-w-6xl` row, so the trigger's distance from the viewport edge depends on the width. */
type Position = { top: number; right: number };

const ITEM = "flex w-full min-h-12 items-center gap-2.5 rounded-lg px-2.5 text-left text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream disabled:cursor-default md:min-h-10";
const ICON = "h-4 w-4 shrink-0 text-cream/55";

function Avatar({ initials, size }: { initials: string; size: "sm" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full bg-lime-400 font-bold text-night ${
        size === "lg" ? "h-10 w-10 text-sm" : "h-7 w-7 text-[11px]"
      }`}
    >
      {initials}
    </span>
  );
}

function OrgMark({ org }: { org: AccountMenuModel["orgs"][number] }) {
  if (org.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={org.logoUrl} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover ring-1 ring-cream/15" />;
  }
  return (
    <span
      aria-hidden="true"
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-bold ${
        org.current ? "bg-lime-400/15 text-lime-300" : "bg-cream/10 text-cream/70"
      }`}
    >
      {org.initials}
    </span>
  );
}

/** The open menu itself: hookless and props-only, so every state's item set can be rendered and read in a test. */
export function AccountMenuPanel({
  id,
  user,
  model,
  labels,
  busyOrgId,
  busy = false,
  error = null,
  position,
  onSwitch,
  onSignOut,
  onClose,
  onKeyDown,
  panelRef,
}: {
  id: string;
  user: AccountMenuProps["user"];
  model: AccountMenuModel;
  labels: AccountMenuLabels;
  busyOrgId: string | null;
  /** Any action in flight (a switch that navigated, or a sign-out): every row is held until the page unloads. */
  busy?: boolean;
  /** Inline error row copy, or null. */
  error?: string | null;
  position: Position | null;
  onSwitch: (orgId: string) => void;
  onSignOut: () => void;
  onClose: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  panelRef?: Ref<HTMLDivElement>;
}) {
  const style = position ? ({ "--am-top": `${position.top}px`, "--am-right": `${position.right}px` } as CSSProperties) : undefined;
  return (
    <div
      ref={panelRef}
      id={id}
      // One DOM: the phone sheet is a modal dialog over a scrim; the same container is the md+ dropdown.
      role="dialog"
      aria-modal="true"
      aria-label={labels.menu}
      data-testid="account-menu"
      style={style}
      onKeyDown={onKeyDown}
      // `app-account-menu` scopes the lime focus ring (globals.css): the platform's violet ring is 2.6:1 on night, and this panel
      // is portalled out of `.app-gantry`, whose rule would otherwise supply it.
      className="app-account-menu fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-cream/10 bg-night-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm text-cream shadow-2xl md:inset-x-auto md:bottom-auto md:top-[var(--am-top,3.5rem)] md:right-[var(--am-right,1rem)] md:max-h-[calc(100dvh-var(--am-top,3.5rem)-1rem)] md:w-[300px] md:rounded-xl md:border md:pb-0"
    >
      <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-cream/20 md:hidden" />
      <div className="flex min-w-0 items-center gap-3 border-b border-cream/10 px-4 py-3.5">
        <Avatar initials={initialsOf(user.displayName, user.email ?? "")} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-cream">{user.displayName}</p>
          {user.email ? <p className="truncate text-xs text-cream/60">{user.email}</p> : null}
        </div>
      </div>
      <div role="menu" aria-label={labels.menu}>
        <div role="group" aria-label={labels.organisation} className="min-w-0 p-1.5">
          <p aria-hidden="true" className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-cream/50">
            {labels.organisation}
          </p>
          {model.orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={o.current}
              data-testid={`account-menu-org-${o.slug}`}
              disabled={busy || busyOrgId !== null}
              onClick={() => onSwitch(o.id)}
              className={`${ITEM} ${o.current ? "font-semibold text-cream" : ""}`}
            >
              <OrgMark org={o} />
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              {o.roleHint && labels.roles[o.roleHint] ? (
                <span className="shrink-0 text-xs font-normal text-cream/50">{labels.roles[o.roleHint]}</span>
              ) : null}
              {busyOrgId === o.id ? <span className="shrink-0 text-xs font-normal text-cream/60">{labels.switching}</span> : null}
              {o.current ? <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-lime-400" strokeWidth={2.25} /> : null}
            </button>
          ))}
          <Link
            href={model.newOrgHref}
            role="menuitem"
            data-testid="account-menu-new-org"
            onClick={onClose}
            className={`${ITEM} text-lime-300 hover:text-lime-200`}
          >
            <Plus aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={2} />
            {labels.newOrg}
          </Link>
        </div>
        <div role="group" className="border-t border-cream/10 p-1.5">
          {model.settingsHref ? (
            <Link href={model.settingsHref} role="menuitem" data-testid="account-menu-settings" onClick={onClose} className={ITEM}>
              <Settings aria-hidden="true" className={ICON} strokeWidth={1.75} />
              {labels.orgSettings}
            </Link>
          ) : null}
          {model.profileHref ? (
            <Link href={model.profileHref} role="menuitem" data-testid="account-menu-profile" onClick={onClose} className={ITEM}>
              <UserRound aria-hidden="true" className={ICON} strokeWidth={1.75} />
              {labels.profile}
            </Link>
          ) : null}
          {model.playerHomeHref ? (
            <Link href={model.playerHomeHref} role="menuitem" data-testid="account-menu-player-home" onClick={onClose} className={ITEM}>
              <CircleUserRound aria-hidden="true" className={ICON} strokeWidth={1.75} />
              {labels.playerHome}
            </Link>
          ) : null}
        </div>
        <div role="group" className="border-t border-cream/10 p-1.5">
          {error ? (
            <p role="alert" data-testid="account-menu-error" className="px-2.5 py-2 text-xs text-red-300">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-testid="account-menu-signout"
            disabled={busy || busyOrgId !== null}
            onClick={onSignOut}
            className={`${ITEM} text-red-300 hover:bg-red-500/10 hover:text-red-200 disabled:opacity-60`}
          >
            <LogOut aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            {labels.signOut}
          </button>
        </div>
      </div>
    </div>
  );
}

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]:not([disabled])';

export function AccountMenu({ user, orgs, activeOrgId, isPlayer, labels }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous twin of the busy state: two taps in one tick both see the same stale render, so the guard reads this.
  const busyRef = useRef(false);
  const [position, setPosition] = useState<Position | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const signOut = useSignOut();
  const menuId = useId();
  const model = accountMenuModel({ orgs, activeOrgId, isPlayer });

  const measure = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setPosition({ top: Math.round(r.bottom + 6), right: Math.max(8, Math.round(document.documentElement.clientWidth - r.right)) });
  };
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // The scrim closes on its own CLICK: closing on its pointerdown would unmount it mid-tap and hand the click to whatever
      // link sits under it.
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t) || scrimRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onResize = () => measure();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    // Focus moves into the portalled panel (the first item), or keyboard users could not reach it.
    const raf = window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus());
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.cancelAnimationFrame(raf);
    };
  }, [open]);

  // Back/forward can restore this page from the bfcache with its state intact: a switch or sign-out that was in flight would leave
  // the menu disabled for good. Reset the hold (ref AND state, so the double-submit guard re-arms) and close.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) =>
      resetOnBfcacheRestore(e, () => {
        busyRef.current = false;
        setBusy(false);
        setBusyOrgId(null);
        setOpen(false);
      });
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // A navigation (a link item, a soft sign-out) ends the menu's moment: close it when the path changes.
  // (State adjusted during render, React's documented pattern, rather than a set-state-in-effect.)
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : e.key === "ArrowDown" ? (at + 1) % items.length
      : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  async function onSwitch(orgId: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusyOrgId(orgId);
    let hold = false;
    try {
      const result = await switchActiveOrg({ orgs, fromId: model.current?.id ?? null, toId: orgId, pathname });
      // A "navigated" switch stays busy until the page unloads: re-enabling the rows would let a second tap POST again.
      if (result === "navigated") hold = true;
      else setOpen(false);
    } catch {
      setError(labels.error);
    } finally {
      if (!hold) {
        busyRef.current = false;
        setBusyOrgId(null);
      }
    }
  }

  async function onSignOut() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      await signOut();
      // Success keeps the hold: the soft navigation to "/" unmounts the gantry.
    } catch {
      setError(labels.error);
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="relative flex min-w-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="account-menu-trigger"
        aria-label={labels.menu}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) measure();
          setOpen((v) => !v);
        }}
        // One 32px box like every gantry control (`min-h-8`). Below `lg` the avatar alone; from `lg` a pill with the name.
        className={`flex min-h-8 min-w-0 items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-cream/10 lg:border lg:pr-2.5 ${
          open ? "bg-cream/10 lg:border-lime-400/60" : "lg:border-cream/15 lg:bg-cream/[0.07]"
        }`}
      >
        <Avatar initials={initialsOf(user.displayName, user.email ?? "")} size="sm" />
        <span className="hidden min-w-0 max-w-[12rem] truncate text-sm font-medium text-cream/85 lg:block">{user.displayName}</span>
        <ChevronDown
          aria-hidden="true"
          className={`hidden h-3.5 w-3.5 shrink-0 text-cream/60 transition-transform lg:block ${open ? "rotate-180" : ""}`}
          strokeWidth={2}
        />
      </button>
      {open
        ? createPortal(
            <>
              <div
                ref={scrimRef}
                aria-hidden="true"
                data-testid="account-menu-scrim"
                onClick={() => close()}
                className="fixed inset-0 z-50 bg-night/60 md:hidden"
              />
              <AccountMenuPanel
                id={menuId}
                user={user}
                model={model}
                labels={labels}
                busyOrgId={busyOrgId}
                busy={busy}
                error={error}
                position={position}
                onSwitch={(id) => void onSwitch(id)}
                onSignOut={() => void onSignOut()}
                onClose={() => close()}
                onKeyDown={onPanelKeyDown}
                panelRef={panelRef}
              />
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
