-- V485 -- Remote scoring (device links) is free on EVERY plan (owner ruling 2026-11-02, "Q2 OK make it free";
-- in line with the standing rule "all scoring is free").
--
-- `scoring.device_links` was false on `community` since V117 (and its V240 re-seed) and true on pro, enterprise and both
-- pass rungs (V393). It gated the scoring QR a volunteer scans: the console's Remote scoring panel, a printed scorer sheet,
-- and the capture phone's scoring link. After this migration no plan is refused.
--
-- DATA MOVE, LOUD: this changes one live `plan_entitlements` cell, community / scoring.device_links, false -> true. Every
-- other plan already held true; the statement re-asserts it so no plan can be left behind.
--
-- WRITTEN AGAINST THE LIVE CATALOGUE, NOT A PLAN LIST. The plan set a database holds is not what the migrations read
-- (`business` and `pro_plus` exist in some histories and not in others), and the resolver treats an ABSENT row as a refusal
-- (lib/entitlements.ts `hasFeature`: a bool key requires `bool_value = true` exactly). So the row is UPSERTED for every plan
-- in `plans`, the V471 shape, rather than UPDATEd on whichever rows an earlier delta happened to insert.
--
-- UNLIKE V471 the gate CALLS are gone from the code (usecases/device-links.ts no longer asks for the key, and the console
-- panel, the scorer-sheets print control and the capture phone no longer render or map a paywall for it), so the rows are
-- no longer what lets a device link through. They stay for two readers only: the /pricing comparison row, which now ticks
-- on every plan, and a bench/smoke probe that reads the catalogue. An `org_entitlement_overrides` row for this key is
-- therefore inert; none existed on the migrated catalogue this was written against.
--
-- Re-runnable, like every statement in this tree.

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p.key, 'scoring.device_links', true, null
  from plans p
on conflict (plan_key, feature_key) do update set bool_value = true;
