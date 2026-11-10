// Test helper for the Sponsors tab (sponsor deals PR 2, Task 14): walk the element tree an island returns, and step INTO the list's
// presentational children.
//
// `renderIsland` (components/__tests__/_hook-harness.tsx) renders one function component one level deep, so `OrgSponsors` comes back
// with `<SponsorList .../>` unexpanded - and every control a person clicks lives inside it. SponsorList, SponsorRowMore and DealChip
// are deliberately STATELESS (their only hooks are the copy and locale reads; every bit of state is OrgSponsors'), which is exactly
// the shape `expandWithHooks` exists for. A child that grows a `useState` makes that helper throw loudly, which is the signal to
// drive it with its own `renderIsland` instead.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expandWithHooks } from "@/components/__tests__/_hook-harness";
import { DealChip } from "@/components/sponsors/deal-chip";
import { SponsorList } from "@/components/sponsors/sponsor-list";
import { SponsorRowMore } from "@/components/sponsors/sponsor-row-more";

type AnyComponent = (props: never) => ReactNode;
const EXPANDED: readonly AnyComponent[] = [SponsorList, SponsorRowMore, DealChip] as unknown as AnyComponent[];

/** Every element in the tree, with SponsorList / SponsorRowMore / DealChip replaced by what they render. */
export function expandSponsorTree(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expandSponsorTree(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const type = node.type as AnyComponent;
  if (EXPANDED.includes(type)) {
    out.push(node);
    return expandSponsorTree(expandWithHooks(type as (p: unknown) => ReactNode, node.props), out);
  }
  out.push(node);
  return expandSponsorTree((node.props as { children?: ReactNode }).children, out);
}
