---
title: Timezones — venue time and your time
description: Set the venue timezone once for your organisation, see how it shows on a division's settings, and set your own timezone separately.
order: 6
related: scheduling/board, scheduling/constraints, scheduling/ai-dates
---

A match happens on the venue's clock. You set that clock once, for the whole organisation, and every schedule is shown in it. Your own timezone is a separate setting that only changes your own times.

![The Organisation defaults card on the organisation's Settings page, with the Scheduling timezone box open and a search for dubai showing Dubai under Middle East, with its country, current local time and GMT offset.](/help/scheduling/org-timezone.webp "Scheduling timezone: type a city and the list shows each zone's country, current local time and GMT offset.")

## Set the venue timezone

1. Open **Settings**, then **Organisation**.
2. In **Organisation defaults**, find **Scheduling timezone**. Its description reads: **The venue zone for this organisation. Every schedule — fixture times, day grouping, exports, public pages — is shown in it. Set it to where you play, not to where you are.**
3. Select the box that reads **Search a city or country** and type a city. The list narrows as you type.
4. Pick the zone and save.

Each row shows the country, the current local time there and the GMT offset. With the box empty, zones are grouped under regions such as **Europe** and **Middle East**, and the zones you are likely to want sit at the top under **Suggested**.

A London organiser running an event in Malaga sets **Madrid**. Their own timezone stays London.

Leave it unset and the box reads **Not set — schedules use UTC**.

> **Example**
> A division's **Start date & time** is stored as 08:00 UTC on 5 December. With the organisation's timezone set to Dubai, the division's **Settings** tab shows **Times shown in Asia/Dubai** and a start of 12:00. Change the organisation to Madrid and the same stored start reads 09:00. The stored instant never moves; only the clock it is shown on changes.

Changing the timezone re-labels existing times and does not move any match. Set it before you publish a timetable, so nobody sees the old clock.

### Searching

Type a city. **dubai** finds Dubai and **madrid** finds Madrid. A country does not always list its cities: **india** listed Indianapolis and Knox, and **UAE** found nothing. If you see **No timezone matches** followed by your search, try the city instead.

### Divisions that carry a zone of their own

Some older divisions still carry a timezone saved before this setting moved up to the organisation. It does not change the clock the Settings tab shows. A division with a saved Kolkata zone, in an organisation set to Madrid, shows **Times shown in Europe/Madrid**. The same division in an organisation with no timezone shows **Times shown in UTC**.

## Set your own timezone

Your own timezone is separate from the venue's. The screen says: **Schedules always show the venue’s time; this controls your own times (your schedule, activity, billing) and the local-time hint beside every venue time.**

1. Open **Settings**, then **Preferences**.
2. In **Timezone**, search for a city, or select **Detect** to use your device's zone. **Current time here** previews your choice.
3. The screen confirms with **Timezone saved.**

Leave it on **Use my browser’s timezone** and it follows whichever device you are on.

Your choice never moves a venue's schedule.
