-- Redundant: registrations_group_position_uq (group_id, cart_position) (V519) already serves every group_id lookup via its leading column.
drop index if exists registrations_group_idx;
