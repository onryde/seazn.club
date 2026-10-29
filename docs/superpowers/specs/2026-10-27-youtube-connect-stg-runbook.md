# YouTube Connect — stg acceptance runbook

**Run after B7 (PR #1066) is merged and the stg deploy is green.** (stg deploys on every push to `main`:
`.github/workflows/stg.yml`.) Nothing in this runbook can be done earlier: stg runs `main`.

**Who does what.** You (the owner) do every click, on a real YouTube channel. The agent does the read-only SQL in §3
after the step that names it, and writes the numbers back to you. Spec: `2026-10-27-youtube-connect-design.md` §8
(prerequisites), §9.4 (this acceptance), §10 (the unknowns this run settles). Every line number cited here was
pinned on `4e3b165274`; re-pin one before relying on it.

**What this proves.** R-VRVN (2026-10-27) showed a pasted default key losing a restart that lands ~60 s after Stop:
the second Go live streamed into a key with no live broadcast bound and YouTube showed no video. With the API, Seazn
owns the broadcast. This run shows, on a real channel, that (1) two Go lives about 60 s apart are ONE video, (2) a gap
over 5 minutes is two videos, each titled by the spec format, (3) Seazn ends the video itself on the schedule the spec
promises, (4) the match page lists the replay, and (5) Disconnect revokes and deletes.

---

## 1. Prerequisites (owner, once — spec §8 items 1–4)

Do these before the run. None needs a code change.

1. **YouTube Data API v3 is enabled** on the Google Cloud project that owns Seazn's OAuth client. It is the SAME client
   Google sign-in uses (`lib/oauth.ts:55-58`), so no new client is created.
2. **The consent screen lists the one scope** `https://www.googleapis.com/auth/youtube` (`lib/youtube.ts:6`) and no other
   YouTube scope.
3. **Authorized redirect URIs** on that client include both:
   - `https://stg.seazn.club/api/youtube/connect/callback`
   - `https://seazn.club/api/youtube/connect/callback`

   The path is `lib/oauth.ts:60`; the hosts are the two `BASE_URL`s in `apps/cron-worker/wrangler.json`. Google must see
   the redirect URI byte for byte. Leave `YOUTUBE_REDIRECT_URI` blank on stg and prod (the app then derives it from the
   forwarded host); if you set it, set it to exactly the URI above.
4. **`YOUTUBE_TOKEN_KEK` is set on stg and on prod**: 64 hex characters, its OWN key (`openssl rand -hex 32`), never a
   copy of `RELAY_KEK`. `RELAY_KEK` must be set too: Connect refuses before sending anyone to Google if either cannot
   seal (`server/youtube/connect-flow.ts:21-25`, landing `not_configured`, "Connecting YouTube isn't available on this
   server right now."). Check the secret NAMES are present; never print a value.
5. **`YOUTUBE_DRIVER` is blank (or `live`) on stg and prod.** Never `fake`: that would make Connect talk to the in-memory
   fake instead of Google (`server/youtube/driver.ts:20-27`, `:56-59`).
6. **Testing-mode note.** Until Google verifies the app (spec §8.3) it is in Testing: only Google accounts listed as
   Test users on the consent screen can connect (a Google console rule, not in this repo), you will see Google's
   "unverified app" screen, and **every refresh token dies after 7 days**. A channel connected on stg therefore flips
   to "Reconnect needed" about a week later (found by the 04:17 UTC daily pass, `schedule.ts:86-94`), and Seazn purges
   its stored data 7 days after that (§5 item 4). This run ends with a Disconnect, so nothing is left to expire.
7. **The test setup.**
   - A Google account that owns a YouTube channel **enabled for live streaming** (a new channel can take up to 24 hours
     to unlock), listed as a Test user. The channel must not already be connected to another Seazn organisation (one
     live organisation per channel; landing `other_org`).
   - A Seazn organisation on stg where you are owner or admin, with the Streaming page offered (the relay entitlement)
     and a match credit for each Go live (Go live keeps today's credit checks; "You need a match credit to go live." is
     the refusal).
   - One fixture, in a public or unlisted competition, in a division that is not in setup, **with no stream link set**
     and **not finished**. Do NOT enter its result during the run: a finished match ends 2 minutes after Stop, a
     different window (`end-rule.ts:35`), and the timings below assume it is not finished.
   - Your usual stg camera setup, the one R-VRVN used.

---

## 2. The run

Each step says what to do, what to expect, and what to record. Record clock times to the second wherever asked; the
agent's SQL gives the exact ones, but yours are the cross-check.

**Order matters: the agent's reads for steps 2–7 (§3, S0–S4) must run BEFORE step 8.** Disconnect deletes the broadcast
rows, and the timing evidence goes with them.

### Step 1 — Baseline *(agent runs S0)*

The agent confirms the fixture: not finished (`finished_at` empty), `stream_url` empty, division not in setup,
competition public or unlisted, and notes the organisation id and its default locale.

*Before you connect*, open your Google account's third-party access page
(`https://security.google.com/settings/security/permissions`, which Google redirects to `myaccount.google.com/permissions`).
**Record** what it lists for Seazn today (sign-in uses the same client, so an entry may already exist).

### Step 2 — Connect a real channel *(agent runs S1 afterwards)*

1. Seazn → **Streaming** (top nav, `/streaming`) → **Connect YouTube**.
2. The consent step: leave **Who can watch = Unlisted** (preselected; keep it: Private hides replays from the match
   page, step 7), **Made for kids = No**, tick the required box, **Continue to Google**.
3. On Google: choose the account, pass the "unverified app" screen (Testing mode), and allow the YouTube access.
   If the account has several channels, pick yours under **Choose a channel** → **Connect channel**.

**Expect.** You land on Streaming with "YouTube channel connected." and a row for your channel (channel name,
visibility Unlisted, "Not made for kids"). Straight after connecting the badge may read **Not checked yet** ("Seazn checks this
the next time you go live."): that is correct until a Go live succeeds or the 04:17 UTC daily check
runs (`connections.ts:221-229`, `prepare.ts:399-407`). **Record** the badge text, whether Google showed the unverified
screen, and what the permissions page lists for Seazn now.

### Step 3 — Run A: two Go lives about 60 s apart *(R-VRVN replay)*

1. On the fixture's stream panel pick the YouTube destination (it shows your channel's name) and **Go live**. Wait until
   YouTube Studio shows the stream receiving video and the broadcast live.
2. **Stop stream** → confirm. Note the time, **T1**.
3. About **60 s** later (R-VRVN's gap was 66 s: stopped 10:02:41, live again 10:03:47) **Go live** again. Wait for video
   in Studio, let it run a minute, then **Stop stream** → confirm. Note **T2**.

**Expect.** Studio (Content → Live) shows **one** video for this match, not two. The second Go live continues it; it
does not sit on "connecting" with no video. **Record:** how many videos Studio shows, and whether the second Go live took
longer to show video than the first.

If a Go live is refused, Seazn says why and charges nothing. The six refusals are a closed set
(`lib/youtube.ts:19-26`: reconnect needed, not enabled for live yet, live blocked, YouTube's limit reached, channel
busy, YouTube unavailable). **Record the sentence verbatim**; only a repeated "YouTube didn't answer" is suspect.

### Step 4 — Wait for Seazn to end the video

Do nothing. Seazn ends the video **5 minutes after the last Stop** (the grace window, D4), on the next tick. stg's tick
fires every 5 minutes (`*/5`, D9), so the end lands **5 to 10 minutes after T2**, on a UTC :00 / :05 / … clock mark
plus a few seconds. (Prod's tick is every minute: 5 to 6.) Watch Studio until the video shows as completed. **Record**
the time you first see it. Do not Go live again until it has ended.

*Agent runs S2 and S3 now* for Run A.

### Step 5 — Run B: a gap over 5 minutes is a second video

Same match: **Go live** (the first broadcast is complete, so this makes a **new** one), wait for video, run a minute,
**Stop stream** → confirm (**T3**). Wait again for Seazn to end it (5 to 10 minutes) and for Studio to show it completed.

**Expect.** Studio now shows **two** videos for this match. **Record** both start times.

*Agent runs S2, S3 and S4 now* (all of A and B).

### Step 6 — Titles, descriptions, visibility

For **each** of the two videos in Studio:

- **Title** is `<Home> vs <Away> · <Division> · <Competition>`, in the organisation's default locale (the word comes
  from `schedule.vs`; in English it is `vs`; the spec writes `v`, the shipped text is `vs`). A missing entrant reads
  `TBD`. At most 100 characters; an over-long title gives up the competition first, then the division
  (`server/youtube/title.ts:13-14`, `prepare.ts:279-285`).
- **Description** is two paragraphs: "Live score and results:" followed by the public match page URL, then a blank line and
  "Powered by Seazn Club · <this environment's site origin>/" (stg links stg, prod links prod; the words are in the
  organisation's default locale; owner request 2026-10-29).
- **Visibility.** This is the spec §10 unknown: whether YouTube forces an unverified project's videos to Private even
  when the API asks for Unlisted. Seazn asked for Unlisted; **record what Studio's Visibility column says**, and open
  each video's watch link in a window that is NOT signed in to Google (an Unlisted video plays by link; Private says the
  video is unavailable). The database only knows what Seazn asked for, so this comparison is yours.

### Step 7 — Replay links on the match page

Open the public match page (the URL in the video description).

**Expect.** A replay player with **Part 1** and **Part 2** tabs, a click-to-play facade, and
**Play on YouTube** / **Open on YouTube**. Part 1 is the broadcast Go live created first (parts are numbered in the
order the broadcasts were created, `V480`). Each tab's link opens the matching video. The organiser's fixture panel
shows the replay too. The match's own stream link (`fixtures.stream_url`) holds Part 1's watch URL only (it is written
only while empty, `usecases/fixtures.ts:521-535`; a later part never replaces it). If a part is missing, reload once
and then record it.

*Agent runs S4.*

### Step 8 — Disconnect

Only after the agent has finished S0–S4. Disconnect is refused while a match is live or inside its 5-minute hold
(`A match is live on this channel or about to be…`); by now both broadcasts are complete, so it should go through.

1. Streaming → your channel's row → **Disconnect** → **Disconnect channel**.
2. **Expect** "`<channel>` is disconnected. Seazn deleted what it stored from YouTube for this channel." Two other
   sentences are possible and are findings to record: the one that says Seazn's access to the Google account **stays**
   (another connected channel uses the same Google account), and the one that says Seazn **couldn't confirm** Google
   removed its access.
3. Verify at Google: reload the third-party access page. **Record** what it lists for Seazn now (gone entirely, or only
   its YouTube access gone, or still listed), against the two snapshots from steps 1 and 2.
4. Verify in YouTube Studio: the stream keys Seazn created (named **Seazn Club · stream key 1**, **… 2**, … by pool slot, in the
   organisation's default locale) are gone from the stream-key
   list. **The two videos stay** ("Videos already on YouTube stay there.", says the Disconnect dialog).
5. Verify on the match page: the replay player and the stream link are gone.

*Agent runs S5.*

---

## 3. Read-only stg SQL (the agent runs it)

**SELECT only**, inside a read-only transaction, against stg, schema `seazn_club`. The agent never prints the database
URL, writes it into a file, or puts it in argv, a log or chat.

**Why not `psql`.** `psql "$REMOTE_DATABASE_URL"` puts the URL in argv, where `ps` shows it, so it is not used (nor are
`source .env.local` or `echo`). The agent runs the script below instead. It takes the URL **inside its own process**, from
`REMOTE_DATABASE_URL` in the environment or, if that is unset, from the line in the shared `.env.local` (the file keeps it
commented out, near the top), so the URL is never an argument. It does **not** fall back to `DATABASE_URL`,
which is a local database. It runs the SQL of one block below (S0–S5) in a `begin read only` transaction, refuses a
statement that is not a `select`, binds the ids as parameters (the `:'name'` placeholders in the blocks are the ones
psql would have filled), prints the rows as JSON, and on a failure prints the error's class and code, or the database's own
message for an error the SERVER raised, never the message of a client error (a malformed URL can quote itself in one).

Save it as `stg-read.mjs` in the agent's scratchpad (not in the repo) and run it **from `apps/web`**, so that `postgres`
resolves from that checkout's `node_modules`:

```js
// node <scratchpad>/stg-read.mjs <path to this runbook> <S0..S5> name=value ...
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const [doc, label, ...pairs] = process.argv.slice(2);
const vals = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const stop = (m) => { console.error(m); process.exit(2); };

// 1. The URL: the environment, else the (commented-out) line of the shared .env.local. Never DATABASE_URL.
let url = process.env.REMOTE_DATABASE_URL;
if (!url) {
  try { url = readFileSync("../../.env.local", "utf8").match(/^#?\s*REMOTE_DATABASE_URL=(.+)$/m)?.[1]; } catch { /* no file */ }
}
url = url?.trim().replace(/^["']|["']$/g, "");
if (!url) stop("REMOTE_DATABASE_URL is not set and not in .env.local - stopping (there is no fallback to DATABASE_URL)");

// 2. The block: the first sql fence after the label's heading. SELECT statements only.
const FENCE = "`".repeat(3);
const md = readFileSync(doc, "utf8");
const head = md.indexOf(`\n**${label} `);
if (head < 0) stop(`no block ${label} in the runbook`);
const open = md.indexOf(FENCE + "sql", head);
const close = md.indexOf(FENCE, open + 6);
const statements = md.slice(open + 6, close).split(";").map((t) => t.trim()).filter(Boolean);
if (statements.length === 0) stop(`block ${label} holds no statement`);
if (!statements.every((t) => /^select\b/i.test(t))) stop(`block ${label} holds a statement that is not a SELECT`);
for (const t of statements) for (const [, n] of t.matchAll(/:'([a-z]+)'/g)) if (!(n in vals)) stop(`block ${label} needs ${n}=<value>`);

// 3. Run them read-only, ids bound as parameters. EVERYTHING that touches the URL is inside the try: an uncaught
//    "Invalid URL" error prints its input, which is the secret.
let sql;
try {
  const postgres = createRequire(`${process.cwd()}/package.json`)("postgres");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  sql = postgres(url, {
    ssl: local ? false : "require", prepare: !url.includes(":6543"), max: 1, idle_timeout: 5, connect_timeout: 15,
    debug: false, onnotice: () => {}, connection: { search_path: "seazn_club" },
  });
  await sql.begin("read only", async (tx) => {
    console.log(JSON.stringify((await tx`select current_setting('transaction_read_only') as read_only, current_schema() as schema`)[0]));
    for (const text of statements) {
      const names = [];
      const query = text.replace(/:'([a-z]+)'/g, (_, n) => {
        names.push(n);
        return `$${names.length}`;
      });
      console.log(`\n-- ${query.replace(/\s+/g, " ").slice(0, 70)}...`);
      console.log(JSON.stringify(await tx.unsafe(query, names.map((n) => vals[n])), null, 1));
    }
  });
} catch (err) {
  console.error(err?.severity ? `server: ${err.message}` : `${err?.name ?? "Error"} ${err?.code ?? ""}`);
  process.exitCode = 1;
} finally {
  await sql?.end({ timeout: 5 });
}
```

Each block says which ids it needs: S0, S2, S3 and S4 take `fixture=<uuid, or its first 8 characters>`; S1 takes
`org=<organisation uuid>`; S5 takes `conn=<connection uuid, from S1>` and `fixture=`. For example, S2:
`node stg-read.mjs <path to this file> S2 fixture=1a2b3c4d`. The first line it prints must read
`{"read_only":"on","schema":"seazn_club"}`; anything else, stop.

**S0 — baseline (step 1).** Expect: `status` not in decided/finalized/forfeited/abandoned/cancelled, `finished_at` and
`stream_url` null, `division_status` not `setup`, `visibility` public or unlisted.

```sql
select f.id, f.status, f.finished_at, f.stream_url,
       d.name as division, d.status as division_status,
       c.name as competition, c.visibility, o.id as org_id, o.default_locale
  from fixtures f
  join divisions d on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  join organizations o on o.id = c.org_id
 where starts_with(f.id::text, :'fixture');
```

**S1 — the connection (after step 2).** Expect one row: `status = connected`, `default_privacy = unlisted`,
`made_for_kids = false`, `consent_version = 1`, `last_error_code` null; and its destination row `kind = youtube`,
`archived_at` null.

```sql
select c.id, c.status, c.default_privacy, c.made_for_kids, c.consent_version, c.consent_at,
       c.status_since, c.last_health_at, c.last_error_code, c.channel_title, c.created_at
  from org_youtube_connections c
 where c.org_id = :'org'
 order by c.created_at desc;

select t.id, t.kind, t.label, t.archived_at, t.watch_url
  from org_stream_targets t
 where t.youtube_connection_id in (select id from org_youtube_connections where org_id = :'org');
```

**S2 — the broadcasts against Stop (after steps 4 and 5).** One row per broadcast, oldest first. It reads V480's
`actual_start_at` / `actual_end_at`.

```sql
select b.id, b.state, b.privacy, b.title, b.yt_broadcast_id, b.created_at,
       s.sessions, s.first_start, s.last_stop,
       b.actual_start_at, b.actual_end_at, b.completed_at,
       b.completed_at  - s.last_stop as completed_after_stop,
       b.actual_end_at - s.last_stop as youtube_end_after_stop,
       b.attempts, b.last_error_code
  from youtube_broadcasts b
  left join lateral (
       select count(*) as sessions, min(x.started_at) as first_start, max(x.ended_at) as last_stop
         from fixture_stream_sessions x where x.youtube_broadcast_id = b.id) s on true
 where starts_with(b.fixture_id::text, :'fixture')
 order by b.created_at;
```

Expect:

| Column | Run A's broadcast | Run B's broadcast |
|---|---|---|
| rows | one broadcast for Run A (not two) | a **different** id |
| `sessions` | **2** (both Go lives joined it) | 1 |
| `state` | `complete` | `complete` |
| `completed_after_stop` | **[5, 10) minutes** on stg | [5, 10) |
| `youtube_end_after_stop` | [5, 10), within seconds of `completed_at` | [5, 10) |
| `last_error_code`, `attempts` | null, 0 | null, 0 |

`last_stop` is the latest `ended_at` among that broadcast's sessions, which is the clock the end rule counts from
(`end-rule.ts:59-75`). A landing a few seconds past 10:00 is tick latency (a cold stg machine). A gap of 10 minutes or
more over means a firing was missed: read the stg cron Worker (`seazn-cron-stg`) `stream-tick` run, whose answer carries
`youtube.ended` and `youtube.failed`. **Prod would read [5, 6).**

**S3 — the sessions behind them (after steps 4 and 5).** Expect Run A's two sessions to carry the SAME
`youtube_broadcast_id`, Run B's one a different id; every row `api_backed = true`, `ended_at` set, `state = completed`.

```sql
select s.created_at, s.state, s.mode, s.api_backed, s.started_at, s.stop_requested_at,
       s.ended_at, s.end_reason, s.fail_reason, s.youtube_broadcast_id
  from fixture_stream_sessions s
 where starts_with(s.fixture_id::text, :'fixture')
 order by s.created_at;
```

**S4 — the replay facts (after step 7).** Expect two rows in the view (Part 1, Part 2) when the broadcasts are
Unlisted or Public, in the order the broadcasts were created, and `stream_url` = Part 1's watch URL
(`https://www.youtube.com/watch?v=<id>`).

```sql
select p.part_no, p.video_id, p.completed_at
  from public_fixture_youtube_parts_v p
 where starts_with(p.fixture_id::text, :'fixture')
 order by p.part_no;

select f.stream_url from fixtures f where starts_with(f.id::text, :'fixture');
```

**S5 — after Disconnect (step 8).** Expect: connection `status = revoked`, `revoked_at` set, `channel_scrubbed`,
`title_scrubbed` and `sub_scrubbed` all true; `broadcasts_left`, `keys_left`, `pending_left` all 0; the destination row
`label = 'YouTube channel (disconnected)'`, `archived_at` set, `watch_url` null; the fixture's `stream_url` null (it
pointed at Part 1); the sessions kept (history) with `youtube_broadcast_id` now null. `last_error_code` is
`revoke_skipped_shared_grant` only on the shared-account case.

```sql
select c.status, c.revoked_at, c.last_error_code,
       c.channel_id is null as channel_scrubbed, c.channel_title is null as title_scrubbed,
       c.google_sub is null as sub_scrubbed
  from org_youtube_connections c where c.id = :'conn';

select (select count(*) from youtube_broadcasts      where connection_id = :'conn') as broadcasts_left,
       (select count(*) from youtube_stream_keys     where connection_id = :'conn') as keys_left,
       (select count(*) from youtube_connect_pending where connection_id = :'conn') as pending_left;

select t.label, t.archived_at, t.watch_url
  from org_stream_targets t where t.youtube_connection_id = :'conn';

select f.stream_url from fixtures f where starts_with(f.id::text, :'fixture');

select s.id, s.youtube_broadcast_id
  from fixture_stream_sessions s where starts_with(s.fixture_id::text, :'fixture');
```

---

## 4. Pass / fail

| # | Check | Pass when |
|---|---|---|
| 1 | Connect | Landing "YouTube channel connected."; S1 shows one `connected` Unlisted connection with its `youtube` destination row |
| 2 | Join (R-VRVN) | Studio shows **one** video for Run A; S2/S3: one broadcast, `sessions = 2`, one `youtube_broadcast_id` |
| 3 | End timing | S2 `completed_after_stop` and `youtube_end_after_stop` both in [5, 10) minutes on stg, for both broadcasts |
| 4 | Gap | Run B is a **different** broadcast id; Studio shows **two** videos |
| 5 | Titles | Both videos (Studio and S2) titled `<Home> vs <Away> · <Division> · <Competition>`, description has the match URL and, below it, the "Powered by Seazn Club" line linking the site |
| 6 | Replay | S4: Part 1 and Part 2, `stream_url` = Part 1; the match page shows both tabs and each opens its own video |
| 7 | Visibility | **Recorded, not graded** (spec §10): Studio's value and the signed-out behaviour for each video |
| 8 | Disconnect | S5 as above; Seazn's keys gone from Studio; videos remain; match page shows no player and no link; Google page recorded |

A fail on 2, 3 or 4 is a defect in B7's subject. 5, 6 and 8 are defects when the data is wrong. 7 is information.
Anything in §5 is not a failure.

---

## 5. Known behaviour (not defects)

Each was re-read against the tree on `4e3b165274`; the citations are where.

1. **A mass grant death defers the dead-grant purge instead of purging.** When many connections die at once (a Google
   consent-screen or client-secret change), the daily pass purges a dead grant only while its **Google-revoke
   allowance** has time (`YOUTUBE_DAILY_REVOKE_BUDGET_MS` = 5 s, counted from the first purge that needs a revoke:
   `daily.ts:107`, `:755-761`). A purge that starts after it commits nothing and is counted `deferred` (`:681`,
   `:686-689`): the connection stays `reconnect_needed`, whole, with its token, and the next daily pass takes it (oldest
   dead first, `:820`). The data the ceiling covers keeps its own legs and is not held back: complete replay videos past
   30 days (`:783-791`), retired and idle keys (`:794-810`), failed rows (`:842-850`). What a deferral leaves for one
   more pass per overflow is what only the purge removes: the channel id and title, the Google account id, the
   destination's watch link, any pending grant and any open broadcast row (`:257-273`, `token-store.ts:128-144`).
2. **An open broadcast row on a `reconnect_needed` connection can outlive the 30-day ceiling.** The end step keeps
   retrying such a row with backoff (`end-step.ts:169-171`, "never skipped"), but none of the legs that bound a row's age
   reaches it: the refresh and the lapsed-video delete read `complete` rows only (`daily.ts:416-423`, `:783-788`) and
   the stuck-row settle reads `connected` connections only (`:620`). Only the dead-grant purge removes it, 7 days after
   the connection flipped (`:815-823`), at the next daily pass. A row that was already old when its grant died can
   therefore sit past 30 days by a day or two. Accepted as rare (owner rule: skip rare cases).
3. **Deleting a fixture cascades its `youtube_broadcasts` rows without ending the broadcast at YouTube.** The FK is
   `on delete cascade` (`db/migration/deltas/V479__youtube_connect.sql:176`) and none of the bare
   `delete from fixtures` paths calls YouTube (`usecases/history.ts:578`, `usecases/stages.ts:823`, `:1781`, `:3482`).
   After that Seazn no longer knows the broadcast and never ends it (the end step reads the table); the club ends it in
   Studio. The sessions survive (`fixture_stream_sessions.fixture_id` is `on delete set null`, `V410:113`, and their
   `youtube_broadcast_id` goes null). Pre-existing since V479 (B1), not introduced by B7.
4. **The actual purge windows.**
   - **In-app Disconnect: immediate**, in the same request: the revoke statement, then the purge of the connection's
     broadcast rows, stream links, pooled keys, destination watch link, Google account id and pending grants
     (`disconnect.ts:6-23`, `daily.ts:257-273`). The Google revoke and the Studio clean-up follow, best effort.
   - **A grant that died** (Google-side revoke found as `invalid_grant`, or a Testing-mode expiry): the connection flips
     to `reconnect_needed`, and **7 days later** the daily pass purges it and then revokes at Google
     (`YOUTUBE_DEAD_GRANT_PURGE_DAYS` = 7, `lib/youtube.ts:206`; `daily.ts:668-693`). The Streaming page tells the club
     the same number.
   - **The 30-day ceiling** (Google policy III.E.4): a complete video is re-confirmed once it is 25 days unconfirmed
     (`YOUTUBE_REFRESH_AFTER_DAYS`, `daily.ts:86`) and deleted at 30 (`YOUTUBE_DATA_CEILING_DAYS`, `:89`, leg `:783`);
     a pooled key idle 30 days is deleted (`:802-810`); a `failed` broadcast row is deleted 30 days after it failed
     (`:94`, `:842-850`).

Also by design, seen during this run:

- **stg ends a video 5 to 10 minutes after Stop, prod 5 to 6** (D9: stg keeps its 5-minute fast trigger so it can
  sleep: `schedule.ts:48`, `:53`, `:59-62`, the stream-tick row `:135-143`).
- **A Private channel gets no public replay**: a Private broadcast is not a part the public sees, and the end step does
  not write its link (`V480`, `end-step.ts:328`). That is why step 2 keeps Unlisted.
- **The first part owns `fixtures.stream_url`**: written only while empty (`usecases/fixtures.ts:521-535`).
- **Studio's own Go live page shows a yellow "Error: Stream key is currently assigned …"** while a match streams
  (stg run, 2026-10-29). That page opens on Studio's own stream event and picks the most recent key, which is the one
  Seazn bound to the match's broadcast; Studio refuses to share it and says so. The match broadcast is unaffected (it
  was live and playable signed-out the whole time). Watch the match from **Content → Live → <the match's video>** or
  **Change dashboard**, not from Studio's Go live page.

---

## 6. Owed before prod (owner)

None of these is B7 code, and none is for the agent.

1. **Org and account deletion do not revoke or purge YouTube connections.** The only deletion in the app is the
   account soft-delete (`app/api/users/me/route.ts:189`): it drops the person's org memberships (`:170`), anonymises
   the user, and mentions YouTube nowhere. A connection belongs to the organisation, so it stays, with its sealed token,
   and nothing revokes the grant at Google or purges the stored YouTube data. There is no in-app organisation delete;
   a hard delete of an organisation row cascades the YouTube rows (V479 header) but still does not revoke the grant at
   Google. Decide: revoke and purge on deletion, or state the retention in the privacy policy.
2. **The 14-day email notice of privacy and terms changes.** Both pages promise "at least 14 days" before a material
   change (`app/legal/privacy/page.tsx:118`, `app/legal/terms/page.tsx:103`). The YouTube wording is a material change
   (`LEGAL_VERSION` is `2026-10-29`, `lib/legal.ts:17`). Send the notice before the prod release; the 14 days run from
   it. The legal text and the consent-checkbox wording are also yours to finalise (spec §8.2).
3. **Google's review of the app's use of YouTube data.** Verification of the consent screen includes Google checking
   the app against its API Services User Data Policy, "Limited Use" requirement included. That is your Google task:
   the demo video of the connect flow and the scope justification (spec §8.3, about 3–5 business days).
4. **Testing-mode 7-day token expiry until the app is verified.** With no feature switch (D11), every organisation that
   connects before verification sees "Reconnect needed" weekly, and Seazn purges its stored data 7 days after the
   connection stops working (§5 item 4). Time the prod release against the verification result.
5. **The public replay embed did not honour "Made for kids" (Google Developer Policies III.E.4.j). DECIDED 2026-10-29 and built
   (below).** Not a stg blocker, but it had to be fixed before prod and before Google verifies the app. The policy (read on the policy page,
   2026-10-29, section III.E.4.j under "Handling YouTube Data and Content") requires an app that embeds YouTube videos to
   look up the Made For Kids status of each embedded video and, for a video designated Made For Kids, to turn off
   tracking and make sure all data collection for that player complies with the applicable law. As first found, Seazn did neither:
   - The public match page embeds the replay (`ReplayEmbed`, the shared fixture page, `app/(public)/shared/…/fixtures/[fixtureId]/page.tsx:464`;
     `components/public-site/match-centre/replay-embed.tsx`). There is
     no status lookup: `youtube_broadcasts` has no made-for-kids column (`V479__youtube_connect.sql:172-195`), only the
     CONNECTION carries the organisation's current choice (`:64`), and the one place Seazn sends it is when it creates a
     broadcast (`selfDeclaredMadeForKids`, `server/youtube/google.ts:315`). A video the club later flips in Studio is
     never read back.
   - The page keeps the site's analytics: the root layout mounts the consent-gated PostHog (`AnalyticsBootstrap`
     and `CookieConsent`, `app/layout.tsx:77`, `:79`) on every route, the public match page included.
   - The obvious case is a youth club that connects with **Made for kids = Yes**. This run uses No, so it will not
     show the problem. (Line numbers in this item were pinned on `32b79e5aab`.)

   **Decision (owner, 2026-10-29): option (a), link out.** A replay part of a broadcast that is made for kids is shown on
   the public match page as a "Watch on YouTube" link and never as a player: no embed, so the tracking rule has nothing
   to apply to. Built on branch `feat/youtube-mfk-replay` (the follow-up PR raised from it; migration V482):
   - the flag is kept per broadcast (`youtube_broadcasts.made_for_kids`), stamped when Go live creates the broadcast from
     the same value it sends YouTube, so a later change of the connection's choice moves no existing replay;
   - YouTube's own `status.madeForKids` is OR-ed into that flag (it only ever goes false to true), and it is read twice, with
     no new API call: at the end step, from the `liveBroadcasts.list` it already makes, and at the 25-day re-confirm, from
     the same `videos.list` call widened from `part=id` to `part=id,status` (same call count; the quota cost of the extra
     part is not verified against Google's page). A video YouTube designates made for kids AFTER its end step is therefore
     caught by the next re-confirm, so it can stay embedded for up to 25 days; the page it flips on is expired at once;
   - a part whose flag is true, or unknown, links out; it is decided part by part, so a match with a made-for-kids part
     and an ordinary one shows one link and one player;
   - the privacy (section 7) and cookie ("YouTube replays") pages each say it in one sentence.

   Before prod: V482 backfills every existing broadcast from its connection's current flag and prints the counts in the
   migration log (`V482: youtube_broadcasts.made_for_kids backfilled ...`); read that line. Prod holds no complete part yet, so
   expect 0 rows backfilled there (only stg rows exist). On stg, connect with
   **Made for kids = Yes**, stream and end a match, and open its public page: a link card, no player, no thumbnail.

---

## 7. Constants this runbook relies on

Read from the tree on `4e3b165274`.

| Value | Source |
|---|---|
| Scope `https://www.googleapis.com/auth/youtube`; consent version 1 | `lib/youtube.ts:6`, `:10` |
| Callback path `/api/youtube/connect/callback`; `YOUTUBE_REDIRECT_URI` overrides | `lib/oauth.ts:59-61` |
| stg / prod hosts `stg.seazn.club` / `seazn.club`; stg crons `17 * * * *`, `*/5 * * * *`; prod `17 * * * *`, `* * * * *` | `apps/cron-worker/wrangler.json` |
| Grace after Stop: 5 min | `YOUTUBE_GRACE_MINUTES`, `lib/youtube.ts:214` |
| Finished-match end: 2 min | `YOUTUBE_FINISHED_END_MINUTES`, `server/youtube/end-rule.ts:35` |
| End rule: due = last Stop + 5 min (not finished) | `end-rule.ts:59-75` |
| stream-tick runs on every firing of the env's fast trigger (stg `*/5`, prod every minute) | `apps/cron-worker/src/schedule.ts:48`, `:53`, `:62`, `:135-143` |
| Daily YouTube pass rides relay-sweep, 04:17 UTC | `schedule.ts:42`, `:86-94` |
| Dead-grant purge: 7 days | `YOUTUBE_DEAD_GRANT_PURGE_DAYS`, `lib/youtube.ts:206` |
| Refresh at 25 days, ceiling 30, failed-row retention 30, revoke allowance 5 s | `server/youtube/daily.ts:86`, `:89`, `:94`, `:107` |
| 10 live keys per channel | `lib/youtube.ts:33` |
| Pooled key's name in Studio: "Seazn Club · stream key {n}", n = its pool slot 1–10 (never the match; es/fr/nl words in `dictionaries/*/ui.json` `streaming.youtube.streamKeyTitle`); read just before the stream is made, so two Go lives racing may share a number | `growPool` in `server/youtube/prepare.ts` |
| Title shape, 100-character limit, `vs` word from `schedule.vs` | `server/youtube/title.ts:13-14`, `prepare.ts:279-285`, `dictionaries/en/ui.json` |
| Streaming page `/streaming` | `STREAMING_PAGE_HREF`, `lib/youtube.ts:221` |
| Google permissions page the policy names | `GOOGLE_THIRD_PARTY_ACCESS_URL`, `lib/youtube.ts:195` |
| Tables and columns in §3 | `db/migration/deltas/V479__youtube_connect.sql`, `V480__youtube_broadcast_actual_times.sql`, `V410__stream_sessions.sql` |
