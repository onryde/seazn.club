// What a visitor reads off the division page's standings table (`StandingsTable`, rendered to markup): the letters over its
// columns after `#` and Team, and each row's name and cell texts. A ratio cell that opens a breakdown is its button's text.
// Shared by the standings-export parity tests so both read the public table the same way.
export interface PublicTableRead {
  header: string[];
  rows: string[][];
}

export function readPublicTable(html: string): PublicTableRead {
  const head = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
  const body = html.includes("<tbody") ? html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>")) : "";
  return {
    header: [...head.matchAll(/<span aria-hidden="true">([^<]*)<\/span>/g)].map((x) => x[1]!),
    rows: [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((tr) => [
      tr[0].match(/<th scope="row"[\s\S]*?title="([^"]*)"/)![1]!,
      ...[...tr[0].matchAll(/<td class="px-2\.5[^>]*>([\s\S]*?)<\/td>/g)].map((td) => {
        const button = td[1]!.match(/<button[^>]*>([^<]*)<\/button>/);
        return button !== null ? button[1]! : td[1]!.replace(/<[^>]+>/g, "");
      }),
    ]),
  };
}
