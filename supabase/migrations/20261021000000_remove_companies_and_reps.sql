begin;

-- Removing a company or a rep, which is two different jobs wearing one word.
--
-- A company that was entered, never paid, never had a customer and never got
-- going is a typo with a row. Nothing about it is worth keeping, and keeping a
-- husk of it just means scrolling past it forever. That one is deleted
-- outright — row gone.
--
-- A company that actually traded is different: billing_events IS the revenue
-- history the Finances tab adds up, and rep_earnings is what a rep earned from
-- them. Deleting those would quietly rewrite a year Joseph has already
-- reported on. So that one is CLOSED: the name and the income stay, every
-- customer's name and email is wiped while the rows stay so the counts and
-- their year still read, the logins go, the card comes off, and it drops out
-- of the Companies list behind a "show closed" toggle.
--
-- Which of the two happens is decided here, under the row lock, rather than by
-- the caller — so it cannot be decided from stale information.

alter table tenants
  add column closed_at     timestamptz,
  add column closed_by     uuid references users(id),
  add column closed_reason text;

create index tenants_closed_at_idx on tenants (closed_at) where closed_at is not null;

comment on column tenants.closed_at is 'Set when this company was closed: it traded, so its name and its payments stay and still count in Finances, but its customers are anonymised, its logins are gone, its card is off file and nothing more can be charged. Hidden from the Companies list unless closed ones are asked for. A company that never traded is deleted outright instead and has no row at all.';

alter table reps
  add column closed_at     timestamptz,
  add column closed_by     uuid references users(id),
  add column closed_reason text;

comment on column reps.closed_at is 'Set when a rep who had earnings was removed: what they earned and were paid stays so the money history adds up, but their name, contact details and login are gone. A rep who never earned anything is deleted outright instead.';

-- Every list of companies hides a closed one unless it is asked for.
drop function if exists rep_dealer_list();

create function rep_dealer_list(p_include_closed boolean default false) returns table (
  tenant_id uuid,
  name text,
  slug text,
  activated boolean,
  activated_on date,
  closer_rep_id uuid,
  onboarder_rep_id uuid,
  assigned_from timestamptz,
  billing_exempt boolean,
  closed_at timestamptz
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
         (t.billing_required is not true),
         t.closed_at
  from tenants t
  left join rep_assignments a on a.tenant_id = t.id and a.effective_to is null
  where (t.closed_at is null or (p_include_closed and is_platform_staff()))
    and (
      is_platform_staff()
      -- A closed company can never pay again, so it can never earn a rep
      -- anything and is never theirs to see.
      or (current_rep_id() is not null
          and t.closed_at is null
          and t.billing_required is true
          and (a.closer_rep_id = current_rep_id() or a.onboarder_rep_id = current_rep_id()))
    )
  order by (t.closed_at is not null), (t.billing_required is not true), t.created_at desc
$$;

revoke all on function rep_dealer_list(boolean) from public, anon;
grant execute on function rep_dealer_list(boolean) to authenticated;

comment on function rep_dealer_list(boolean) is 'Every company on the platform, with its current closer/onboarder, whether it is exempt from the $500/$100/30% (billing_exempt), and whether it has been closed. Closed ones are left out unless p_include_closed is true, and then only for 50. staff — a rep never sees one. Open companies first, in-house ones after the payers. Never includes a dollar amount.';

-- ---------------------------------------------------------------------------
-- remove_company — deletes a company that never traded, closes one that did
-- ---------------------------------------------------------------------------
create or replace function remove_company(p_tenant_id uuid, p_reason text default null)
returns table (outcome text, customers_affected int, referrals_affected int, logins_revoked int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant tenants%rowtype;
  v_traded boolean;
  v_customers int := 0;
  v_referrals int := 0;
  v_logins int := 0;
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can remove a company' using errcode = '42501';
  end if;

  select * into v_tenant from tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'No such company' using errcode = 'P0002';
  end if;
  if v_tenant.closed_at is not null then
    raise exception 'That company has already been closed' using errcode = '22023';
  end if;
  if v_tenant.billing_required is not true then
    raise exception 'That is one of your own companies (%) — it runs a live referral program and cannot be removed here', v_tenant.name
      using errcode = '42501';
  end if;

  -- "Traded" means there is something in the books that must not move: a
  -- billing event of any kind, or a rep who earned from them. Not whether they
  -- had customers — a dealer who signed up, never paid and collected a few
  -- referrals is still a false start.
  v_traded := exists (select 1 from billing_events where tenant_id = p_tenant_id)
           or exists (select 1 from rep_earnings where tenant_id = p_tenant_id);

  -- Common to both: nobody can sign in, nobody is on it, nothing can be
  -- charged to it. This is the half that costs real money if it is skipped.
  delete from users where tenant_id = p_tenant_id;
  get diagnostics v_logins = row_count;
  delete from rep_assignments where tenant_id = p_tenant_id;
  delete from billing_emails where tenant_id = p_tenant_id;

  if not v_traded then
    -- A false start: nothing here is worth a row.
    delete from gift_card_transactions where tenant_id = p_tenant_id;
    delete from referrals where tenant_id = p_tenant_id;
    get diagnostics v_referrals = row_count;
    delete from referral_links where tenant_id = p_tenant_id;
    delete from customers where tenant_id = p_tenant_id;
    get diagnostics v_customers = row_count;
    delete from audit_log where tenant_id = p_tenant_id;
    update rep_leads set tenant_id = null where tenant_id = p_tenant_id;
    delete from tenants where id = p_tenant_id;
    return query select 'deleted'::text, v_customers, v_referrals, v_logins;
  end if;

  -- It traded. The rows stay so the counts and their year still read; what is
  -- removed is every way to identify a person in them. Emails are made unique
  -- per row and pointed at .invalid, which can never be delivered to.
  update customers
     set name = 'Removed',
         email = 'removed+' || replace(id::text, '-', '') || '@removed.invalid',
         phone = null
   where tenant_id = p_tenant_id;
  get diagnostics v_customers = row_count;

  update referrals
     set name = 'Removed',
         email = 'removed+' || replace(id::text, '-', '') || '@removed.invalid',
         phone = null,
         message = null
   where tenant_id = p_tenant_id;
  get diagnostics v_referrals = row_count;

  update tenants
     set closed_at = now(),
         closed_by = auth.uid(),
         closed_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         -- The name stays: a line in the books reading "Deleted company" is
         -- worth less than one reading what it actually was.
         domain = null,
         send_domain = null,
         send_from_name = null,
         send_from_address = null,
         send_domain_verified = false,
         send_domain_verified_at = null,
         stripe_customer_id = null,
         stripe_payment_method_id = null,
         billing_status = 'suspended',
         annual_fee_cents = 0,
         renewal_due_at = null,
         renewal_notice_sent_for = null
   where id = p_tenant_id;

  return query select 'closed'::text, v_customers, v_referrals, v_logins;
end;
$$;

revoke all on function remove_company(uuid, text) from public, anon;
grant execute on function remove_company(uuid, text) to authenticated;

comment on function remove_company(uuid, text) is 'Removes a dealer. One that never traded — no billing events, no rep earnings — is deleted outright, row and all. One that did is closed instead: name and payments kept so Finances still adds up, every customer and referral anonymised in place so the counts survive, logins revoked, card detached, nothing left to charge. Admin only; refuses the three in-house companies. Returns which of the two happened.';

-- ---------------------------------------------------------------------------
-- remove_rep — same two outcomes, same reason
-- ---------------------------------------------------------------------------
create or replace function remove_rep(p_rep_id uuid, p_reason text default null)
returns table (outcome text, owed_cents int, dealers_released int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rep reps%rowtype;
  v_owed int;
  v_earned boolean;
  v_released int := 0;
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can remove a rep' using errcode = '42501';
  end if;

  select * into v_rep from reps where id = p_rep_id for update;
  if not found then
    raise exception 'No such rep' using errcode = 'P0002';
  end if;
  if v_rep.closed_at is not null then
    raise exception 'That rep has already been removed' using errcode = '22023';
  end if;

  select (coalesce((select sum(amount_cents) from rep_earnings where rep_id = p_rep_id), 0)
        - coalesce((select sum(amount_cents) from rep_payouts where rep_id = p_rep_id), 0))::int
    into v_owed;
  if v_owed <> 0 then
    raise exception 'This rep''s balance is not settled (% cents). Pay or reverse it first, then remove them.', v_owed
      using errcode = '22023';
  end if;

  update rep_assignments
     set effective_to = now()
   where effective_to is null and (closer_rep_id = p_rep_id or onboarder_rep_id = p_rep_id);
  get diagnostics v_released = row_count;

  delete from users where id = v_rep.user_id;

  v_earned := exists (select 1 from rep_earnings where rep_id = p_rep_id)
           or exists (select 1 from rep_payouts where rep_id = p_rep_id);

  if not v_earned then
    -- Never earned a cent: nothing in the money history points at them, so
    -- there is nothing to keep them for.
    update rep_leads set brought_in_by_rep_id = null where brought_in_by_rep_id = p_rep_id;
    update rep_leads set closed_by_rep_id = null where closed_by_rep_id = p_rep_id;
    update rep_leads set onboarded_by_rep_id = null where onboarded_by_rep_id = p_rep_id;
    update rep_assignments set closer_rep_id = null where closer_rep_id = p_rep_id;
    update rep_assignments set onboarder_rep_id = null where onboarder_rep_id = p_rep_id;
    delete from reps where id = p_rep_id;
    return query select 'deleted'::text, v_owed, v_released;
  end if;

  update reps
     set closed_at = now(),
         closed_by = auth.uid(),
         closed_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         active = false,
         email = null,
         phone = null,
         notes = null,
         user_id = null
   where id = p_rep_id;

  return query select 'closed'::text, v_owed, v_released;
end;
$$;

revoke all on function remove_rep(uuid, text) from public, anon;
grant execute on function remove_rep(uuid, text) to authenticated;

comment on function remove_rep(uuid, text) is 'Removes a rep. One who never earned anything is deleted outright. One who did is closed instead: what they earned and were paid stays so the statements still add up, while their contact details and login go. Admin only; refused while their balance is anything other than zero. Returns which of the two happened.';

commit;
