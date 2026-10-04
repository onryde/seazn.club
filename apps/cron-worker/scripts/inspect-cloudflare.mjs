#!/usr/bin/env node
/** One-shot: print cron Worker scripts, schedules, observability. No secrets logged. */
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required");
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { http: res.status, body };
}

const scripts = await get("/workers/scripts");
console.log("== scripts ==", "http", scripts.http, "ok", scripts.body.success);
for (const s of scripts.body.result ?? []) {
  console.log("-", s.id, s.modified_on);
}

for (const name of ["seazn-cron-stg", "seazn-cron-prod", "seazn-cron"]) {
  const settings = await get(`/workers/scripts/${name}/settings`);
  console.log(`== settings ${name} ==`, "http", settings.http, "ok", settings.body.success);
  if (!settings.body.success) console.log("err", settings.body.errors);
  else {
    const r = settings.body.result ?? {};
    console.log(
      JSON.stringify(
        { observability: r.observability, logpush: r.logpush, tags: r.tags },
        null,
        2,
      ),
    );
  }
  const schedules = await get(`/workers/scripts/${name}/schedules`);
  console.log(`== schedules ${name} ==`, "http", schedules.http, "ok", schedules.body.success);
  console.log(JSON.stringify({ err: schedules.body.errors, result: schedules.body.result }, null, 2));
}
