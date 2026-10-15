begin;

-- Show the three in-house companies in the Dealers tab.
--
-- Good Steward Structures, North Mountain Structures and 50.'s own tenant all
-- run live referral programs on this platform, but rep_dealer_list() filtered
-- on `billing_required is true` — which is exactly what makes them exempt from
-- the $500, the $100/year and the 30% — so they never appeared anywhere Joseph
-- could see them. The Dealers tab showed two companies when five were running,
-- and the only hint the other three existed was a count on the Company tab
-- ("3 in-house") with no names attached.
--
-- They are now returned to 50. staff, flagged, so the tab lists every company
-- on the platform. What does NOT change:
--   - a rep still sees only the billable dealers they are currently on, which
--     is both halves of the where clause below: an exempt tenant has no
--     rep_assignments row, and the new billing_required test keeps it that way
--     even if one were ever added by hand;
--   - no dollar amount is returned, same as before;
--   - the two other callers are unaffected — the rep-deactivation query filters
--     on closer/onboarder, and the earnings join matches on tenant_id, and an
--     exempt tenant has neither.
--
-- Dropped and recreated rather than replaced: create or replace cannot change
-- a function's return type, and this adds a column.
drop function if exists rep_dealer_list();

create function rep_dealer_list() returns table (
  tenant_id uuid,
  name text,
  slug text,
  activated boolean,
  activated_on date,
  closer_rep_id uuid,
  onboarder_rep_id uuid,
  assigned_from timestamptz,
  billing_exempt boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.name, t.slug,
         (t.activation_paid_at is not null and t.activation_livemode is true),
         case when t.activation_livemode is true then t.activation_paid_at::date end,
         a.closer_rep_id, a.onboarder_rep_id, a.effective_from,
         (t.billing_required is not true)
  from tenants t
  left join rep_assignments a on a.tenant_id = t.id and a.effective_to is null
  where
    -- Staff see every company on the platform, billable or in-house.
    is_platform_staff()
    -- A rep sees only the billable dealers they are currently on. An in-house
    -- company can never earn a rep anything, so it is never theirs to see.
    or (current_rep_id() is not null
        and t.billing_required is true
        and (a.closer_rep_id = current_rep_id() or a.onboarder_rep_id = current_rep_id()))
  -- Billable dealers first, newest first; the in-house ones after them.
  order by (t.billing_required is not true), t.created_at desc
$$;

revoke all on function rep_dealer_list() from public, anon;
grant execute on function rep_dealer_list() to authenticated;

comment on function rep_dealer_list() is 'Every company on the platform with its current closer/onboarder, and whether it is exempt from the $500/$100/30% (billing_exempt). Joseph and the helper see all of them, in-house ones included; a rep sees only the billable dealers they are currently on; anyone else gets an empty list. Never includes a dollar amount.';

commit;
