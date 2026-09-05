-- Scopes referral visibility by role, now that dealer accounts are real
-- logins rather than one shared pasted token: a dealer sees only the
-- referrals that trace back to a customer *they* invited; an admin still
-- sees every referral in their tenant.
--
-- Replaces referrals_select_same_tenant from the rls_policies migration,
-- which granted every authenticated staff member (dealer or admin) full
-- tenant-wide visibility. Nothing else about that migration changes.
--
-- "Traces back to" means: this referral's own link (a share link, kind =
-- 'share') has a customer_id — the customer who shared it — and that
-- customer's created_by_user_id is the dealer who originally sent them
-- their invite. That covers today's one-level referral chain (a dealer
-- invites a customer, who shares once); a customer's friend-of-a-friend
-- referral is out of scope for this migration and would need its own
-- follow-up if/when multi-level sharing is built.

drop policy referrals_select_same_tenant on referrals;

create policy referrals_select_own_or_admin on referrals
  for select to authenticated
  using (
    tenant_id = current_tenant_id()
    and (
      is_admin()
      or exists (
        select 1
        from referral_links rl
        join customers c on c.id = rl.customer_id
        where rl.id = referrals.referral_link_id
          and c.created_by_user_id = auth.uid()
      )
    )
  );

comment on policy referrals_select_own_or_admin on referrals is
  'Dealers see only referrals from customers they personally invited; admins see every referral in their tenant.';
