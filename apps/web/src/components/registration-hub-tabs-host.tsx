"use client";

// B7 T24 (spec 2026-11-13 §9.2) — the registration hub's tabs: the strip, the section on screen, and one division settings
// page per open division tab, with the dialogs that keep unsaved edits from being lost.
//
// The page renders this at one stable place in its tree on every tab, so a tab switch (a soft navigation: the same component
// type at the same position) keeps its state, and with it every mounted division page and the edits in it. Each division page
// is keyed by its id and hidden while another tab is on screen. The section on screen (Settings or Registrants, both server
// rendered) arrives as `children`; the server sends only that one, so one slot is all it needs.
//
// The address is the state (`parseHubTabs`, server side). Every change goes through a T22 transition and then the address:
// opening and switching PUSH a history entry, closing REPLACES one (§9.2). What this file adds is the unsaved-edit rules:
//   - opening a third division evicts the least recently used one; if THAT one is dirty, a dialog asks first (Save and open,
//     Discard and open, Cancel), and Save and open only swaps once the save succeeded;
//   - the close button on a dirty tab asks (Save and close, Discard, Keep editing);
//   - Back (or Forward) to an address without a dirty tab keeps that tab mounted, puts it back in the address and asks the
//     close question — unless the division is no longer openable (archived, or the viewer lost edit rights), when it goes;
//   - a reload or a tab close while anything is dirty gets the browser's own "leave site?" prompt.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Modal } from "@/components/modal";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import {
  RegistrationHubConfigPanel,
  type ConfigSaveHandle,
  type ConfigSaveResult,
} from "@/components/registration-hub-config-panel";
import { sectionName } from "@/components/registration-hub-config-section";
import type { ConfigDirty } from "@/components/use-config-dirty";
import type { RegistrationHubConfigDivisionLike } from "@/components/use-registration-hub-config";
import { REGISTRATION_HUB_TABS } from "@/components/registration-hub-tab";
import { RegistrationHubTabStrip, type HubStripTab } from "@/components/registration-hub-tab-strip";
import {
  activate,
  closeDivision,
  hubTabParam,
  openDivision,
  replaceHubTabs,
  type HubTab,
  type HubTabsState,
} from "@/components/registration-hub-tabs-state";
import { routes } from "@/lib/routes";
import type { Currency } from "@/lib/currency";

/** One open division's settings page, as the server loads it for the address's `open` list. */
export interface OpenDivisionConfig {
  division: RegistrationHubConfigDivisionLike;
  /** Registrations waiting for a place right now (the Money section's re-price warning). */
  waitlistedCount: number;
}

/** What every division settings page shares: the org's clock and money, resolved once by the page. */
export interface HubDivisionConfigContext {
  orgTz: string;
  orgSlug: string;
  currency: Currency;
  feePercentPct: number;
  cardUnsupportedCurrency: string | null;
}

/** A division the Settings tab offers "Open settings" on: every non-archived one when the viewer can edit, none otherwise. */
export interface OpenableDivision {
  id: string;
  name: string;
}

interface HubTabsApi {
  /** "Open settings" on a division row: the open, with the unsaved-edit check on the tab it would evict. */
  openDivision: (id: string) => void;
}

const HubTabsContext = createContext<HubTabsApi | null>(null);

/** The host's open, for a row inside it (the Settings list). Null outside a host. */
export function useHubTabs(): HubTabsApi | null {
  return useContext(HubTabsContext);
}

type Dialog =
  | { kind: "evict"; evicted: string; opening: string; next: HubTabsState; busy: boolean }
  | { kind: "close"; id: string; busy: boolean };

type Toast = { seq: number; text: string; reopen: string | null };

/** The division pages mounted right now, and the address they were reconciled against. */
interface Mounted {
  key: string;
  ids: string[];
  /** Each mounted page's config: from the server for the ids in the address, remembered for one held back after Back. */
  configs: Record<string, OpenDivisionConfig>;
  /** The org's clock and money, remembered the same way: an address with no division tab in it carries none. */
  shared: HubDivisionConfigContext | null;
}

const TOAST_MS = { saved: 4000, evicted: 10000 } as const;

function stateKeyOf(state: HubTabsState, divisions: readonly OpenDivisionConfig[]): string {
  return `${hubTabParam(state.active)}|${state.open.join(",")}|${divisions.map((d) => d.division.division_id).join(",")}`;
}

function byId(divisions: readonly OpenDivisionConfig[]): Record<string, OpenDivisionConfig> {
  return Object.fromEntries(divisions.map((d) => [d.division.division_id, d]));
}

const isDivisionTab = (active: HubTab, id: string) => typeof active !== "string" && active.division === id;

export function RegistrationHubTabsHost({
  state,
  divisions,
  openable,
  config,
  orgSlug,
  compSlug,
  stripEnd,
  children,
}: {
  state: HubTabsState;
  /** The config of every division in `state.open`. */
  divisions: OpenDivisionConfig[];
  openable: OpenableDivision[];
  /** What every division page shares. Null only when `divisions` is empty (the page reads it only for an open tab). */
  config: HubDivisionConfigContext | null;
  orgSlug: string;
  compSlug: string;
  /** The strip's trailing slot (Export CSV). */
  stripEnd?: ReactNode;
  /** The section on screen: the Settings or Registrants panel, or nothing while a division tab is. */
  children?: ReactNode;
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openableIds = new Set(openable.map((d) => d.id));

  const [dirty, setDirty] = useState<Record<string, ConfigDirty>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const isDirty = (id: string) => dirty[id]?.dirty === true;

  // Which division pages are mounted. Reconciled against the address DURING render, on the change only — the sanctioned
  // "adjust state when a prop changes" shape — because the unmount it prevents would happen in this very render: an effect
  // would run after the dirty page had already lost its edits.
  const stateKey = stateKeyOf(state, divisions);
  const [mounted, setMounted] = useState<Mounted>(() => ({
    key: stateKey,
    ids: [...state.open],
    configs: byId(divisions),
    shared: config,
  }));
  let current = mounted;
  if (mounted.key !== stateKey) {
    // A dirty page the address dropped without this host closing it (every deliberate close clears its dirty entry first):
    // Back or Forward did it. Held back — mounted, edits intact — unless its division is no longer openable, which would
    // only be dropped again by the next parse: a loop, and a tab for a division that cannot be edited.
    const held = mounted.ids.filter((id) => !state.open.includes(id) && isDirty(id) && openableIds.has(id));
    const ids = [...state.open, ...held];
    const configs: Record<string, OpenDivisionConfig> = byId(divisions);
    for (const id of held) configs[id] = mounted.configs[id]!;
    current = { key: stateKey, ids, configs, shared: config ?? mounted.shared };
    setMounted(current);
    // A page that is no longer mounted reports nothing again (its onDirtyChange never fires on unmount): its entry goes here.
    const gone = mounted.ids.filter((id) => !ids.includes(id) && id in dirty);
    if (gone.length > 0) {
      setDirty((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !gone.includes(id))));
    }
    // Ask the close question about the first one held back; the effect below puts it back in the address.
    if (held.length > 0) setDialog({ kind: "close", id: held[0]!, busy: false });
  }
  const held = current.ids.filter((id) => !state.open.includes(id));
  // The server's latest for a tab in the address (a refresh after a save brings one), else what this host remembered.
  const liveConfigs = byId(divisions);
  const shared = config ?? current.shared;
  if (current.ids.length > 0 && shared === null) {
    throw new Error("RegistrationHubTabsHost: a division tab is open but the page sent no config context for its settings page");
  }

  function hrefFor(next: HubTabsState): string {
    return routes.competitionRegistration(orgSlug, compSlug, hubTabParam(next.active), undefined, next.open);
  }

  /** The address for `next`, keeping every other param (a Registrants filter) as it is. */
  function navigate(mode: "push" | "replace", next: HubTabsState, opts?: { scroll?: boolean }) {
    const params = replaceHubTabs(new URLSearchParams(searchParams?.toString() ?? ""), next);
    const href = `${pathname}?${params.toString()}`;
    if (mode === "push") router.push(href, opts);
    else router.replace(href, opts);
  }

  // Put a held-back tab back in the address (spec §9.2: "router.replaces the tab back in and shows the × dialog"). Through
  // openDivision, so the cap of two holds and the least recently used one makes room; that one is never the other dirty page
  // (it would lose its edits in turn), so if it would be, the address keeps the dirty pages instead.
  const heldKey = held.length > 0 ? `${held.join(",")}@${stateKey}` : "";
  useEffect(() => {
    if (!heldKey) return;
    let next = state;
    for (const id of held) {
      const result = openDivision(next, id);
      if (result.evicted !== null && isDirty(result.evicted)) {
        const keep = current.ids.filter((other) => other !== id && isDirty(other)).slice(-1);
        next = { active: { division: id }, open: [...keep, id] };
      } else {
        next = result.state;
      }
    }
    navigate("replace", next, { scroll: false });
    // Keyed on the held set and the address only: a re-render while the replace is in flight must not send it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey]);

  // Reload or close with anything unsaved: the browser's own prompt (§9.2). Only while dirty, so a clean hub never asks.
  const anyDirty = Object.values(dirty).some((d) => d.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older Chromium and Safari show the prompt only when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  // Closing the tab on screen lands on Settings where it was left (§9.2), not at the top of the list.
  const settingsScrollY = useRef<number | null>(null);
  const restoreSettingsScroll = useRef(false);
  function rememberSettingsScroll() {
    if (state.active === "settings" && typeof window !== "undefined") settingsScrollY.current = window.scrollY;
  }
  useLayoutEffect(() => {
    if (state.active !== "settings" || !restoreSettingsScroll.current) return;
    restoreSettingsScroll.current = false;
    window.scrollTo(0, settingsScrollY.current ?? 0);
  }, [stateKey, state.active]);

  // The toast leaves on its own; a new one replaces it.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((now) => (now?.seq === toast.seq ? null : now)), toast.reopen ? TOAST_MS.evicted : TOAST_MS.saved);
    return () => clearTimeout(timer);
  }, [toast]);
  const toastSeq = useRef(0);
  function showToast(text: string, reopen: string | null) {
    toastSeq.current += 1;
    setToast({ seq: toastSeq.current, text, reopen });
  }

  // Every mounted page's save handle, registered by the page itself.
  const handles = useRef(new Map<string, RefObject<ConfigSaveHandle | null>>());
  const [register] = useState(() => (id: string, handle: RefObject<ConfigSaveHandle | null>) => {
    handles.current.set(id, handle);
    return () => {
      if (handles.current.get(id) === handle) handles.current.delete(id);
    };
  });
  async function saveTab(id: string): Promise<ConfigSaveResult> {
    const save = handles.current.get(id)?.current?.save;
    return save ? save() : "refused";
  }

  function forget(id: string) {
    setDirty((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  const nameOf = (id: string) =>
    current.configs[id]?.division.name ?? openable.find((d) => d.id === id)?.name ?? "";

  function requestOpen(id: string) {
    // The rows that call this are the openable divisions themselves; anything else is a wiring fault, said loudly.
    if (!openableIds.has(id)) throw new Error(`RegistrationHubTabsHost: division ${id} is not one the Settings tab can open`);
    const { state: next, evicted } = openDivision(state, id);
    if (evicted !== null && isDirty(evicted)) {
      setDialog({ kind: "evict", evicted, opening: id, next, busy: false });
      return;
    }
    rememberSettingsScroll();
    navigate("push", next);
    if (evicted !== null) showToast(msg("reg.hub.evicted", { name: nameOf(evicted) }), evicted);
  }

  /** The close itself, once nothing unsaved stands in its way (replace: §9.2). */
  function closeNow(id: string) {
    forget(id);
    const next = closeDivision(state, id);
    const toSettings = isDivisionTab(state.active, id) && next.active === "settings";
    if (toSettings) restoreSettingsScroll.current = true;
    navigate("replace", next, toSettings ? { scroll: false } : undefined);
  }

  function requestClose(id: string) {
    if (isDirty(id)) setDialog({ kind: "close", id, busy: false });
    else closeNow(id);
  }

  /** After a save that did not go through: the page that refused it, on screen, its own reveal pointing at why. */
  function showFailedTab(id: string) {
    setDialog(null);
    if (!isDivisionTab(state.active, id)) navigate("push", activate(state, { division: id }));
  }

  async function evictSaveAndOpen(d: Extract<Dialog, { kind: "evict" }>) {
    setDialog({ ...d, busy: true });
    const result = await saveTab(d.evicted);
    if (result !== "success") return showFailedTab(d.evicted);
    forget(d.evicted);
    setDialog(null);
    navigate("push", d.next);
  }

  async function closeSaveAndClose(d: Extract<Dialog, { kind: "close" }>) {
    setDialog({ ...d, busy: true });
    const result = await saveTab(d.id);
    if (result !== "success") return showFailedTab(d.id);
    setDialog(null);
    closeNow(d.id);
  }

  const tabs: HubStripTab[] = [
    ...REGISTRATION_HUB_TABS.map((key) => ({
      key,
      label: msg(`reg.hub.tab.${key}`),
      href: hrefFor(activate(state, key)),
      active: state.active === key,
    })),
    ...state.open.map((id) => ({
      key: id,
      label: nameOf(id),
      href: hrefFor(activate(state, { division: id })),
      active: isDivisionTab(state.active, id),
      division: {
        id,
        dirty: isDirty(id),
        closeLabel: msg("reg.hub.tabs.close", { name: nameOf(id) }),
        onClose: () => requestClose(id),
      },
    })),
  ];

  const sectionsText = (id: string) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
      (dirty[id]?.sections ?? []).map((section) => sectionName(section, msg)),
    );

  return (
    <HubTabsContext.Provider value={{ openDivision: requestOpen }}>
      <RegistrationHubTabStrip
        label={msg("reg.hub.tabs.label")}
        unsavedLabel={msg("reg.hub.tabs.unsaved")}
        tabs={tabs}
        end={stripEnd}
        onFollow={(key) => {
          if (key !== "settings") rememberSettingsScroll();
        }}
      />

      {children}

      {current.ids.map((id) => (
        <RegistrationHubDivisionTab
          key={id}
          id={id}
          active={isDivisionTab(state.active, id)}
          config={liveConfigs[id] ?? current.configs[id]!}
          shared={shared!}
          register={register}
          onDirtyChange={(d) =>
            setDirty((prev) => (prev[id]?.count === d.count && prev[id]?.sections.join() === d.sections.join() ? prev : { ...prev, [id]: d }))
          }
          onSaved={() => {
            showToast(msg("reg.hub.saved"), null);
            // The Settings rows are the server's (capacity, fee, window): fetch them again so the list says what was saved.
            router.refresh();
          }}
        />
      ))}

      {dialog?.kind === "evict" && (
        <HubDialog
          title={msg("reg.hub.evict.title", { name: nameOf(dialog.evicted) })}
          body={msg("reg.hub.evict.body", { name: nameOf(dialog.evicted), next: nameOf(dialog.opening) })}
          busy={dialog.busy}
          busyLabel={msg("reg.hub.config.saving")}
          primary={{ label: msg("reg.hub.evict.save"), action: "save", onClick: () => void evictSaveAndOpen(dialog) }}
          discard={{
            label: msg("reg.hub.evict.discard"),
            onClick: () => {
              forget(dialog.evicted);
              setDialog(null);
              navigate("push", dialog.next);
            },
          }}
          dismiss={{ label: msg("reg.hub.evict.cancel"), onClick: () => setDialog(null) }}
          closeLabel={msg("reg.hub.evict.cancel")}
        />
      )}
      {dialog?.kind === "close" && (
        <HubDialog
          title={msg("reg.hub.close.title", { name: nameOf(dialog.id) })}
          body={msgPlural("reg.hub.close.body", dirty[dialog.id]?.count ?? 0, { sections: sectionsText(dialog.id) })}
          busy={dialog.busy}
          busyLabel={msg("reg.hub.config.saving")}
          primary={{ label: msg("reg.hub.close.save"), action: "save", onClick: () => void closeSaveAndClose(dialog) }}
          discard={{ label: msg("reg.hub.close.discard"), onClick: () => { setDialog(null); closeNow(dialog.id); } }}
          dismiss={{ label: msg("reg.hub.close.keep"), onClick: () => setDialog(null) }}
          closeLabel={msg("reg.hub.close.keep")}
        />
      )}

      {toast && (
        <div
          role="status"
          data-reg-hub-toast
          className="fixed inset-x-4 top-[calc(var(--app-header-h)+0.75rem)] z-40 mx-auto flex max-w-md items-center gap-3 rounded-xl bg-slate-900 py-2 pl-4 pr-1 text-sm text-white shadow-lg"
        >
          <span className="min-w-0 flex-1">{toast.text}</span>
          {toast.reopen !== null && (
            <button
              type="button"
              data-reg-hub-reopen
              className="min-h-11 shrink-0 rounded-lg px-3 font-semibold text-purple-200 underline-offset-2 hover:underline"
              onClick={() => {
                const id = toast.reopen!;
                setToast(null);
                requestOpen(id);
              }}
            >
              {msg("reg.hub.reopen")}
            </button>
          )}
          <button
            type="button"
            aria-label={msg("reg.hub.toast.dismiss")}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 hover:text-white"
            onClick={() => setToast(null)}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}
    </HubTabsContext.Provider>
  );
}

/** One division's settings page as a tab: mounted while its tab is open, hidden while another tab is on screen. */
function RegistrationHubDivisionTab({
  id,
  active,
  config,
  shared,
  register,
  onDirtyChange,
  onSaved,
}: {
  id: string;
  active: boolean;
  config: OpenDivisionConfig;
  shared: HubDivisionConfigContext;
  register: (id: string, handle: RefObject<ConfigSaveHandle | null>) => () => void;
  onDirtyChange: (dirty: ConfigDirty) => void;
  onSaved: () => void;
}) {
  const handle = useRef<ConfigSaveHandle | null>(null);
  useEffect(() => register(id, handle), [id, register]);
  return (
    // Below md the page's Save bar is pinned to the viewport bottom; `-mb-8` takes back the page's bottom padding under the
    // tab on screen, so at the end of the scroll the bar sits on the screen's edge rather than 32px above it (T23 note).
    <div data-reg-hub-division-tab={id} hidden={!active} className="max-md:-mb-8">
      <RegistrationHubConfigPanel
        division={config.division}
        waitlistedCount={config.waitlistedCount}
        orgTz={shared.orgTz}
        orgSlug={shared.orgSlug}
        currency={shared.currency}
        feePercentPct={shared.feePercentPct}
        cardUnsupportedCurrency={shared.cardUnsupportedCurrency}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
        saveHandleRef={handle}
      />
    </div>
  );
}

/** The two unsaved-edit questions (evict, close): the save first, then the discard, then the way back out. Below sm the
 *  buttons stack with the save on top (§9.2: "At 320 the buttons stack with the primary first"). */
function HubDialog({
  title,
  body,
  busy,
  busyLabel,
  primary,
  discard,
  dismiss,
  closeLabel,
}: {
  title: string;
  body: string;
  busy: boolean;
  busyLabel: string;
  primary: { label: string; action: string; onClick: () => void };
  discard: { label: string; onClick: () => void };
  dismiss: { label: string; onClick: () => void };
  closeLabel: string;
}) {
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) dismiss.onClick();
      }}
      closeLabel={closeLabel}
      footer={
        <div data-reg-hub-dialog-actions className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row-reverse">
          <button
            type="button"
            data-reg-hub-dialog-action={primary.action}
            disabled={busy}
            className="btn btn-primary min-h-11"
            onClick={primary.onClick}
          >
            {busy ? busyLabel : primary.label}
          </button>
          <button
            type="button"
            data-reg-hub-dialog-action="discard"
            disabled={busy}
            className="btn btn-ghost min-h-11 text-red-700 hover:bg-red-50"
            onClick={discard.onClick}
          >
            {discard.label}
          </button>
          <button
            type="button"
            data-reg-hub-dialog-action="dismiss"
            disabled={busy}
            className="btn btn-ghost min-h-11"
            onClick={dismiss.onClick}
          >
            {dismiss.label}
          </button>
        </div>
      }
    >
      <p data-reg-hub-dialog-body>{body}</p>
    </Modal>
  );
}
