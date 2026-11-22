---
title: API keys
description: Create a key for your own software, choose what it can do, limit it to one competition and revoke it when you are done.
order: 1
related: billing/plans, getting-started/create-your-organisation
---

An API key lets your own software talk to Seazn Club: pull standings into your website, or push live scores from a scoreboard system. You make keys under **Settings**, then **Platform API**. Keys are a Pro feature. On Community the page reads **Platform API keys require an upgrade** and links to **Plan & Billing**.

![The Platform API page on a Pro plan: the key name box, the Read, Score and Manage choices with Score and Manage showing On request — talk to us, the Limit to one competition menu, and one Read key listed with its last-used date.](/help/api/api-keys-panel.webp "Settings, then Platform API, on a Pro plan with one Read key made and used")

## Who can see this page

Owners and admins get the key form. A viewer who opens **Platform API** sees "Only owners and admins can manage API keys."

## Create a key

1. Type a name in the box, such as "Club website". The **Create key** button stays off until you do.
2. Under **What can this key do?**, choose **Read**, **Score** or **Manage**. Pick the smallest that does the job.
3. Once your organisation has a competition, **Limit to one competition** appears. Choose a competition there if the key should only work in it. The default is **All competitions (no limit)**.
4. Press **Create key**.

| Scope | What it does |
|---|---|
| **Read** | Fetch competitions, fixtures, standings and registrations. Can't change anything. |
| **Score** | Everything Read does, plus push live scores and start divisions — for scoreboard integrations. |
| **Manage** | Full access: create competitions, generate fixtures, moderate registrations. Treat like a password. |

On Pro, **Read** is the choice you can use. **Score** and **Manage** are greyed out with **On request — talk to us**. On Enterprise, all three are open to you.

A key limited to one competition lists as "Spring Open only". The page says "A limited key only works inside the chosen competition — hand it to a vendor without exposing the rest."

## Copy the secret now

A panel reads "Key “Club website” created — copy the secret now" and shows a secret that starts `sc_`. It says "This is the only time it will be shown. Store it somewhere safe." Press **Copy**, store the secret, then press **I've stored it — dismiss**. The list afterwards shows the key's name, its scope and "created … · last used never". The secret is not shown again.

## Use it

Send the secret in an `Authorization: Bearer sc_…` header. The panel says the same under the list when you have no keys yet.

> **Example**
> You make a **Read** key called "Club website". It lists as "created 22 Nov 2026 · last used never". You call the list of competitions with it, and the call is answered. The list now says "last used 22 Nov 2026". A call that tries to create a competition is refused: "This key is limited to 'read' — this endpoint needs the 'manage' scope. Create a key with the right scope in org settings."

## What a key cannot do

- **Keep working without Pro.** If your plan drops to Community, the same key is refused: "API keys are a Pro feature."
- **Call without limit.** Each key has its own limit per minute: 300 calls on Pro and 60 on Enterprise. The next call is refused with "Rate limit exceeded for this API key — retry after the window resets." A call that gets past the key, plan, route and scope checks carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`.
- **Reach every endpoint.** A key calls only the endpoints the API lists for its scope. It cannot make or revoke keys: that call is refused with "API keys cannot access this endpoint — use a session login."

A **Manage** key can create and change clubs, teams, competitions, divisions, entrants, fixtures, schedules and registrations, so keep it like a password.

## Revoke a key

Press **Revoke** beside the key. A box asks "Revoke this API key?" and says integrations using it stop working immediately and this cannot be undone. Press **Revoke key** to go ahead. The key moves under **Revoked keys**, and a call with its secret is refused with "Invalid API key". A revoked key cannot be turned back on: make a new one.
