import type { Metadata } from "next";
import { CodeBlock, ScopeChip } from "@/components/dev-code-block";
import { routes } from "@/lib/routes";

export const metadata: Metadata = { title: "Read standings into a sheet or site" };

export default function ReadStandingsGuide() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Read standings into a sheet or site
      </h1>
      <p className="mt-2 text-slate-600">
        Two doors. If the division is on a public dashboard, you don’t need a key
        at all. For private data, a <ScopeChip scope="read" /> key does it.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">
        No key: the public read API
      </h2>
      <p className="mt-2 text-slate-600">
        Everything a public dashboard shows is also JSON — slugs are in the
        dashboard URL (<code className="font-mono text-sm">{routes.publicHub("<org>", "<competition>", "<division>")}</code>):
      </p>
      <CodeBlock title="public standings">{`
curl https://seazn.club/api/v1/public/orgs/riverside/competitions/summer-league/divisions/mens-a/standings
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">
        With a read key: any division
      </h2>
      <CodeBlock title="private standings">{`
# stages of a division
curl https://seazn.club/api/v1/divisions/$DIVISION_ID/stages \\
  -H "Authorization: Bearer sc_your_key"

# standings snapshot of a stage
curl https://seazn.club/api/v1/stages/$STAGE_ID/standings \\
  -H "Authorization: Bearer sc_your_key"
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">Pools, names and who left</h2>
      <p className="mt-2 text-slate-600">
        Every row names its entrant (<code className="font-mono text-sm">name</code>)
        and says whether they are still in (<code className="font-mono text-sm">status</code>:{" "}
        <code className="font-mono text-sm">active</code>,{" "}
        <code className="font-mono text-sm">withdrawn</code> or{" "}
        <code className="font-mono text-sm">disqualified</code>) — a withdrawn
        entrant’s row stays while the table counts their results, and the
        public standings name them too. A stage with several pools answers
        every pool when you send no <code className="font-mono text-sm">pool_id</code>:
        each row’s <code className="font-mono text-sm">pool</code> is the pool’s key
        (<code className="font-mono text-sm">A</code>,{" "}
        <code className="font-mono text-sm">B</code>, …) and{" "}
        <code className="font-mono text-sm">rank</code> is the place{" "}
        <em>within that pool</em>, so a rank repeats from pool to pool. List the
        pools, then read one:
      </p>
      <CodeBlock title="pools of a stage">{`
# the pools (empty for a league, a knockout or a group of one pool)
curl https://seazn.club/api/v1/stages/$STAGE_ID/pools \\
  -H "Authorization: Bearer sc_your_key"

# one pool's table, by the id /pools gave you
curl "https://seazn.club/api/v1/stages/$STAGE_ID/standings?pool_id=$POOL_ID" \\
  -H "Authorization: Bearer sc_your_key"
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">Google Sheets</h2>
      <p className="mt-2 text-slate-600">
        Apps Script’s <code className="font-mono text-sm">UrlFetchApp</code> +
        a time-driven trigger keeps a sheet current:
      </p>
      <CodeBlock title="Code.gs">{`
function pullStandings() {
  const res = UrlFetchApp.fetch(
    "https://seazn.club/api/v1/stages/" + STAGE_ID + "/standings",
    { headers: { Authorization: "Bearer " + KEY } });
  const rows = JSON.parse(res.getContentText()).data.rows;
  const sheet = SpreadsheetApp.getActiveSheet();
  sheet.clearContents();
  sheet.appendRow(["Pool", "Rank", "Entrant", "Status", "P", "Pts"]);
  rows.forEach(r => sheet.appendRow([r.pool, r.rank, r.name, r.status, r.played, r.points]));
}
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">TypeScript</h2>
      <CodeBlock title="standings.ts">{`
const res = await fetch(
  \`https://seazn.club/api/v1/stages/\${stageId}/standings\`,
  { headers: { Authorization: \`Bearer \${process.env.SEAZN_KEY}\` } },
);
const body = await res.json();
if (!body.ok) throw new Error(body.error.message);
console.table(body.data.rows);
`}</CodeBlock>

      <p className="mt-6 rounded-xl bg-purple-50/60 p-4 text-sm text-slate-600">
        Prefer an iframe? Pro orgs can embed live standings directly — see the
        sharing panel on any division, no code beyond a copy-paste snippet.
      </p>
    </article>
  );
}
