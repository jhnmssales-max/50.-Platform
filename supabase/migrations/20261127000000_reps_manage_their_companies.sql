-- ---------------------------------------------------------------------------
-- A rep can look after the companies they signed.
--
-- Ben signed companies and then could do nothing for them. He could see them
-- on his Companies tab and that was the whole of it: the Brand and Logins
-- buttons were admin-only, so every "my logo is wrong" and "can you add my
-- son to the account" came back to Joseph, who is the bottleneck this
-- platform exists to remove.
--
-- So a rep now manages the companies they are ON -- the same companies
-- rep_dealer_list() already shows them, no wider.
--
--   branding, wording, the company's name   theirs to fix
--   logins (add, rename, resend, remove)    theirs to fix
--   what the company PAYS                   Joseph's alone
--
-- Prices stay out of it on purpose. A rep's pay depends on the companies
-- they close, so a rep who can discount is a rep who can discount their way
-- to a close. That is not a thing to find out about afterwards.
--
-- This is the one test, used by every route that lets somebody act on a
-- company that is not their own.
create or replace function rep_manages_tenant(p_tenant_id uuid) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select is_platform_admin()
      or exists (
           select 1
             from rep_assignments a
             join reps r
               on r.id = a.closer_rep_id or r.id = a.onboarder_rep_id
            where a.tenant_id = p_tenant_id
              -- The CURRENT assignment only. A company handed to another rep
              -- stops being the old one's the moment the handover is dated,
              -- which is what effective_to records.
              and a.effective_to is null
              and r.user_id = auth.uid()
              -- Switching a rep off takes this away with everything else.
              and r.active
         )
$$;

comment on function rep_manages_tenant(uuid) is 'True for Joseph, and for an ACTIVE rep who is the closer or onboarder on that company''s current assignment. The one test for whether somebody may act on a company that is not their own tenant: branding, wording and logins. Never prices — those are the admin''s alone, because a rep whose pay depends on closing should not be able to discount their way to one. See 20261127000000_reps_manage_their_companies.';

revoke all on function rep_manages_tenant(uuid) from public, anon;
grant execute on function rep_manages_tenant(uuid) to authenticated;
