// The hero's Sport select as a store (start wizard T5 review m4: it was the art's, hero-vignette.tsx, and the hero's
// organiser door borrowed it from there). The select is the server's (the quick match form works with no script), so the
// art reads it rather than owning it: its value is the snapshot, its `change` events the subscription. The server
// snapshot is "nothing picked", so the server's markup (and the hydration that must match it) draws the page's sport; once
// hydrated, a value the browser restored into the select (back navigation) shows at once. No select on the page (the
// quick match offer is empty) reads as nothing picked, and subscribes to nothing. The hero's art (hero-vignette.tsx) and
// its organiser door (hero-event-link.tsx) both read it, through `useSyncExternalStore`.
import { HERO_SPORT_SELECT_ID } from "./hero-scenes";

function selectOnPage(): HTMLSelectElement | null {
  return document.getElementById(HERO_SPORT_SELECT_ID) as HTMLSelectElement | null;
}
export function subscribeToSelect(onChange: () => void): () => void {
  const select = selectOnPage();
  if (!select) return () => {};
  select.addEventListener("change", onChange);
  return () => select.removeEventListener("change", onChange);
}
export const readSelect = (): string | null => selectOnPage()?.value ?? null;
export const readNothingPicked = (): string | null => null;
