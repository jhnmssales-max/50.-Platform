begin;

-- Removing a company or a rep for good.
--
-- The hard part is not the deleting, it is that two things Joseph must keep
-- point straight at the rows being removed: billing_events, which IS his
-- revenue history and what the Finances tab adds up, and rep_earnings and
-- rep_payouts, which are what he has paid a rep and what he still owes them.
-- Deleting a tenant row outright would either break those foreign keys or,
-- with a cascade, silently delete a year of his own books — Silver Run's $500
-- would vanish from a year he has already reported on.
--
-- So a removal is: scrub the row down to a nameless stub, hard-delete
-- everything about the people, and stop the money. What is left is a line in
-- the books with no name, no address, no branding, no customers and no way to
-- sign in — which is what "no name attached" means in practice, and the only
-- version of this that leaves the accounts still adding up.

alter table tenants
  add column deleted_at     timestamptz,
  add column deleted_by     uuid references users(id),
  add column deleted_reason text;

create index tenants_deleted_at_idx on tenants (deleted_at) where deleted_at is not null;

comment on column tenants.deleted_at is 'Set when this company was removed. The row survives only so billing_events and rep_earnings still have something to point at; its name, address, branding and sending domain are scrubbed and every customer, referral, link and login belonging to it is deleted. A row with this set must never appear in a list, be charged, or be able to sign in.';

alter table reps
  add column deleted_at     timestamptz,
  add column deleted_by     uuid references users(id),
  add column deleted_reason text;

comment on column reps.deleted_at is 'Set when this rep was removed. The row survives only so rep_earnings and rep_payouts — what they were paid and what they earned — still have something to point at; name and contact details are scrubbed and their login is revoked. Refused while the platform still owes them money.';

-- Every list of companies hides a deleted one. rep_dealer_list() is the single
-- place that decides what anyone may see (see the in-house migration), so this
-- is the single place that has to change.
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
  where t.deleted_at is null
    and (
      is_platform_staff()
      or (current_rep_id() is not null
          and t.billing_required is true
          and (a.closer_rep_id = current_rep_id() or a.onboarder_rep_id = current_rep_id()))
    )
  order by (t.billing_required is not true), t.created_at desc
$$;

revoke all on function rep_dealer_list() from public, anon;
grant execute on function rep_dealer_list() to authenticated;

comment on function rep_dealer_list() is 'Every company on the platform that has not been deleted, with its current closer/onboarder and whether it is exempt from the $500/$100/30% (billing_exempt). Joseph and the helper see all of them, in-house ones included; a rep sees only the billable dealers they are currently on; anyone else gets an empty list. Never includes a dollar amount.';

-- ---------------------------------------------------------------------------
-- delete_company
-- ---------------------------------------------------------------------------
-- Admin only. Refuses the three in-house companies outright: Good Steward,
-- North Mountain and 50. itself are the platform, and removing one by accident
-- would take a live referral program down with it.
create or replace function delete_company(p_tenant_id uuid, p_reason text default null)
returns table (deleted_customers int, deleted_referrals int, deleted_logins int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant tenants%rowtype;
  v_customers int := 0;
  v_referrals int := 0;
  v_logins int := 0;
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can delete a company' using errcode = '42501';
  end if;

  select * into v_tenant from tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'No such company' using errcode = 'P0002';
  end if;
  if v_tenant.deleted_at is not null then
    raise exception 'That company has already been deleted' using errcode = '22023';
  end if;
  if v_tenant.billing_required is not true then
    raise exception 'That is one of your own companies (%) — it runs a live referral program and cannot be deleted here', v_tenant.name
      using errcode = '42501';
  end if;

  -- The people first. These are real customers' names, email addresses and
  -- referral history; they are what actually has to be gone.
  delete from gift_card_transactions where tenant_id = p_tenant_id;
  delete from referrals where tenant_id = p_tenant_id;
  get diagnostics v_referrals = row_count;
  delete from referral_links where tenant_id = p_tenant_id;
  delete from customers where tenant_id = p_tenant_id;
  get diagnostics v_customers = row_count;
  delete from billing_emails where tenant_id = p_tenant_id;
  delete from audit_log where tenant_id = p_tenant_id;
  -- Nobody is on this dealer any more, so nothing about it can earn a rep
  -- anything from here on. What they already earned is untouched.
  delete from rep_assignments where tenant_id = p_tenant_id;
  delete from users where tenant_id = p_tenant_id;
  get diagnostics v_logins = row_count;

  -- The lead that brought them in is Joseph's own record of his rep's work, so
  -- it stays and keeps its credit — only its link to the dead account is cut.
  update rep_leads set tenant_id = null where tenant_id = p_tenant_id;

  -- Then the row itself: scrubbed, silenced, and billed nothing ever again.
  update tenants
     set deleted_at = now(),
         deleted_by = auth.uid(),
         deleted_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         name = 'Deleted company',
         slug = 'deleted-' || replace(p_tenant_id::text, '-', ''),
         domain = null,
         branding = '{}'::jsonb,
         send_domain = null,
         send_from_name = null,
         send_from_address = null,
         send_domain_verified = false,
         send_domain_verified_at = null,
         -- Stopping the money, which is the half that costs real money if it
         -- is wrong: no saved card, nothing due, nothing active to charge.
         stripe_customer_id = null,
         stripe_payment_method_id = null,
         billing_status = 'suspended',
         annual_fee_cents = 0,
         renewal_due_at = null,
         renewal_notice_sent_for = null
   where id = p_tenant_id;

  return query select v_customers, v_referrals, v_logins;
end;
$$;

revoke all on function delete_company(uuid, text) from public, anon;
grant execute on function delete_company(uuid, text) to authenticated;

comment on function delete_company(uuid, text) is 'Removes a dealer for good: deletes their customers, referrals, links, gift-card rows, billing emails, audit rows, rep assignments and logins, cuts the lead loose, and scrubs the tenant row to a nameless stub with no saved card, no renewal date and billing suspended. The stub survives only so billing_events and rep_earnings still resolve. Admin only; refuses the three in-house companies.';

-- ---------------------------------------------------------------------------
-- delete_rep
-- ---------------------------------------------------------------------------
-- Refused while a balance is outstanding: deleting someone you owe money to
-- should take a deliberate act of paying them or writing it off, not a click.
create or replace function delete_rep(p_rep_id uuid, p_reason text default null)
returns table (owed_cents int, released_dealers int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rep reps%rowtype;
  v_owed int;
  v_released int := 0;
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can delete a rep' using errcode = '42501';
  end if;

  select * into v_rep from reps where id = p_rep_id for update;
  if not found then
    raise exception 'No such rep' using errcode = 'P0002';
  end if;
  if v_rep.deleted_at is not null then
    raise exception 'That rep has already been deleted' using errcode = '22023';
  end if;

  select (coalesce((select sum(amount_cents) from rep_earnings where rep_id = p_rep_id), 0)
        - coalesce((select sum(amount_cents) from rep_payouts where rep_id = p_rep_id), 0))::int
    into v_owed;
  if v_owed <> 0 then
    raise exception 'This rep''s balance is not settled (% cents). Pay or reverse it first, then delete them.', v_owed
      using errcode = '22023';
  end if;

  -- Taken off every dealer, so nothing from here on can earn them anything.
  update rep_assignments
     set effective_to = now()
   where effective_to is null and (closer_rep_id = p_rep_id or onboarder_rep_id = p_rep_id);
  get diagnostics v_released = row_count;

  -- Their login goes; what they earned and were paid stays.
  delete from users where id = v_rep.user_id;

  update reps
     set deleted_at = now(),
         deleted_by = auth.uid(),
         deleted_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         active = false,
         name = 'Deleted rep',
         email = null,
         phone = null,
         notes = null,
         user_id = null
   where id = p_rep_id;

  return query select v_owed, v_released;
end;
$$;

revoke all on function delete_rep(uuid, text) from public, anon;
grant execute on function delete_rep(uuid, text) to authenticated;

comment on function delete_rep(uuid, text) is 'Removes a rep for good: revokes their login, ends every dealer assignment, and scrubs the rep row to a nameless stub. What they earned and were paid stays, so the money history still adds up. Admin only; refuses while their balance is anything other than zero.';

commit;
