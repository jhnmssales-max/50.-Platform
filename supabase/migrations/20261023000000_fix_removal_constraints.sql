-- Removing a company or a rep broke on a check constraint. Both fixed here.
--
-- Wrapped in one explicit transaction like the rest: all of it or none.
--
-- WHAT WAS WRONG
-- The remove_company_and_reps migration cleared foreign keys by setting them
-- to null, without noticing that rep_leads has two check constraints which
-- forbid exactly that:
--
--   rep_leads_built_has_dealer  build_status = 'built' requires tenant_id
--   rep_leads_won_has_closer    status = 'won' requires closed_by_rep_id
--
-- So:
--   * Deleting a company that never traded ran
--     "update rep_leads set tenant_id = null", leaving a lead still marked
--     'built'. Every real company was built from a won lead, so this fired
--     every time. Deleting a never-traded company was impossible.
--   * Deleting a rep who never earned ran
--     "update rep_leads set closed_by_rep_id = null" on a lead still marked
--     'won'. Any rep who had ever closed anything hit it.
--   * The same removal then nulled closer_rep_id and onboarder_rep_id on
--     rep_assignments one after the other. One rep is usually both on the same
--     dealer, so the second statement left a row naming nobody, which
--     rep_assignments_has_a_rep forbids.
--
-- And one that was not a constraint at all: both functions ended their delete
-- path with RETURN QUERY and no RETURN. In PL/pgSQL that appends a row and
-- carries on, so deleting fell through into the closing path and answered
-- twice — 'deleted' and then 'closed'. It stayed hidden because the row was
-- already gone, so the second pass changed nothing and the route reads only
-- the first row.
--
-- Both surfaced as an unexplained failure, because routes/reps.js maps a
-- 23503/23514 to a generic message that names neither constraint.
--
-- Why the tests missed it: the e2e fixtures for both paths used leads that
-- were never won and companies that were never built from one, which is the
-- one shape the constraints permit. The checks added alongside this migration
-- use a lead in the state a real one is always in.
begin;

-- ---------------------------------------------------------------------------
-- remove_company: take the lead out of the build queue as well as off the
-- company, so the row it leaves behind is one the constraints allow.
-- ---------------------------------------------------------------------------
-- The lead itself stays, and stays WON: the rep closed it and that is their
-- record, whatever became of the dashboard afterwards. What changes is that it
-- is no longer 'built', because the thing it was built into is gone. It is
-- marked 'declined' rather than put back to 'awaiting_approval' so that
-- removing a company does not quietly add work to the build queue, and
-- declined_reason carries why. To be rid of the lead as well, delete it from
-- the Leads tab afterwards.
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
    -- THE FIX. build_status and built_at move in the same statement as
    -- tenant_id, because rep_leads_built_has_dealer is checked per row and a
    -- lead that is still 'built' with no tenant is exactly what it forbids.
    -- 'none' is the fallback for a lead that somehow is not won, which
    -- rep_leads_build_needs_win would otherwise reject.
    update rep_leads
       set tenant_id = null,
           build_status = case when status = 'won' then 'declined' else 'none' end,
           built_at = null,
           declined_reason = left('Company removed'
             || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), ''), 500)
     where tenant_id = p_tenant_id;
    delete from tenants where id = p_tenant_id;
    return query select 'deleted'::text, v_customers, v_referrals, v_logins;
    -- RETURN QUERY appends to the result and carries ON. Without this the
    -- function fell through into the "it traded" block below and appended a
    -- second row saying 'closed'. It was invisible because the tenant had just
    -- been deleted, so those updates touched nothing and the route reads only
    -- the first row — but the function was answering two different things at
    -- once, and the next caller to read them all would have believed it.
    return;
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

comment on function remove_company(uuid, text) is 'Removes a dealer. One that never traded — no billing events, no rep earnings — is deleted outright, row and all, and the lead it was built from goes back to being a won lead with a declined build. One that did trade is closed instead: name and payments kept so Finances still adds up, every customer and referral anonymised in place so the counts survive, logins revoked, card detached, nothing left to charge. Admin only; refuses the three in-house companies. Returns which of the two happened.';

-- ---------------------------------------------------------------------------
-- remove_rep: a rep with any lead history is closed, not deleted.
-- ---------------------------------------------------------------------------
-- The old test was "did they ever earn?". But a rep who closed a lead has a
-- record even if no money ever moved, and rep_leads_won_has_closer means that
-- record cannot be unpicked by nulling the column: a won lead must name who
-- closed it. So the test becomes "is there anything pointing at them at all",
-- which is the same rule remove_company already applies to a company that
-- traded — keep the row, revoke the login, release the dealers.
--
-- A rep with no earnings AND no leads is someone added by mistake who never
-- did anything, and is still deleted outright.
create or replace function remove_rep(p_rep_id uuid, p_reason text default null)
returns table (outcome text, owed_cents int, dealers_released int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rep reps%rowtype;
  v_owed int;
  v_has_history boolean;
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

  -- Money, or a lead with their name on it. Either is a record worth keeping.
  v_has_history := exists (select 1 from rep_earnings where rep_id = p_rep_id)
                or exists (select 1 from rep_payouts where rep_id = p_rep_id)
                or exists (select 1 from rep_leads
                            where brought_in_by_rep_id = p_rep_id
                               or closed_by_rep_id = p_rep_id
                               or onboarded_by_rep_id = p_rep_id);

  if not v_has_history then
    -- Added by mistake and never used: nothing anywhere points at them.
    --
    -- rep_assignments has its own check, rep_assignments_has_a_rep: a row must
    -- name a closer or an onboarder. One rep is usually BOTH on the same
    -- dealer, so nulling the two columns in turn left a row naming nobody and
    -- the whole removal was refused. Rows this rep is the only party on have
    -- nothing left to record, so they go; rows that still name somebody else
    -- just lose this rep.
    delete from rep_assignments
     where (closer_rep_id = p_rep_id or onboarder_rep_id = p_rep_id)
       and (closer_rep_id is null or closer_rep_id = p_rep_id)
       and (onboarder_rep_id is null or onboarder_rep_id = p_rep_id);
    update rep_assignments set closer_rep_id = null where closer_rep_id = p_rep_id;
    update rep_assignments set onboarder_rep_id = null where onboarder_rep_id = p_rep_id;
    delete from reps where id = p_rep_id;
    return query select 'deleted'::text, v_owed, v_released;
    return;  -- same reason as in remove_company above
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

comment on function remove_rep(uuid, text) is 'Removes a sales rep. Refuses while their balance is unsettled. One with no earnings, no payouts and no leads — added by mistake and never used — is deleted outright. One with any of those is closed instead: the row stays so every past charge still credits them and their leads still name who closed them, their login is deleted, their current dealers are released, and they stop appearing as active. Admin only. Returns which of the two happened.';

commit;
