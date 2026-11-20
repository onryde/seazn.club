---
title: The match audit trail
description: Every match keeps a tamper-evident ledger. On Pro or an Event Pass you can download it, signed.
order: 9
related: scoring/corrections, scoring/batch-import, api/keys
---

Every entry is an event in the match's ledger. Corrections are new events, never edits, and each event is linked to the one before it by a hash. The fixture console shows the result of checking that chain: **Ledger verified ✓**, or the exact entry where it breaks if someone has changed the database directly.

## Download it

**Download audit** on the fixture console gives you the full trail. The same file is available from the API as `GET /api/v1/fixtures/{id}/audit`, as JSON, or as a readable PDF with `?format=pdf`. A key with the read scope can fetch it.

The download needs a plan that includes it, or an **Event Pass** for that competition. Without either, the console shows **Signed audit — Pro** where the button would be, and its hover hint reads "The signed match audit trail download is a Pro feature." That hint does not mention the Event Pass, which unlocks the download too. See [plans](/help/billing/plans).

The file holds:

- the fixture, with its number, sides and status
- every event, with its type, what it recorded, who recorded it and when, the event it voids if it is a void, and its hashes
- `head_hash`, the hash of the last event, and `verified`, which is `true` when the chain is intact
- `signature`, described next

A match with no events yet downloads as an empty list, with no head hash and no signature. A match in play can be downloaded too.

## The signature

When the service has a signing key, the download is signed with Ed25519 over the fixture id, the head hash and the time of issue. A file you saved last week then proves what the ledger said last week, even if the database is rewritten later. A deployment that has no signing key returns `"signature": null` and an empty key list. The ledger and its hashes are still in the file.

## Check a download yourself

The public keys are at `/.well-known/seazn-audit-keys`. This is a short Node check:

```js
import { createPublicKey, verify } from "node:crypto";
const audit = /* the downloaded JSON's data */;
const keys = (await (await fetch("https://seazn.club/.well-known/seazn-audit-keys")).json()).keys;
const key = keys.find(k => k.key_id === audit.signature.key_id);
const msg = `${audit.fixture.id}|${audit.head_hash}|${audit.signature.issued_at}`;
verify(null, Buffer.from(msg), createPublicKey(key.public_key_pem),
       Buffer.from(audit.signature.signature, "base64")); // → true
```

> **Example**
> A player disputes a result a week later. You download the audit for that match. It shows the rally entries, the void and its replacement, and the finalize, each with who made it and when. The file's signature check returns `true`, so the record is the one the ledger held when you downloaded it.
