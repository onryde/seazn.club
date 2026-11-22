// W5 follow-ups B3: the division page's Standings and Entrants tabs as ISR documents of their own. A spectator never types
// this path: the proxy rewrites `/live/{org}/{comp}/{division}?tab=standings|entrants` here (`divisionTabRewrite`), so the
// URL stays the one the hub links to, and the server renders only that tab's panel. The page itself is the division page's
// (`../../page.tsx`), which reads `tab` from its params.
import DivisionHomePage, { generateMetadata } from "../../page";

export const revalidate = 30;

// ISR on a dynamic segment in this Next version needs an empty `generateStaticParams` (see the division page).
export async function generateStaticParams() {
  return [];
}

export { generateMetadata };
export default DivisionHomePage;
