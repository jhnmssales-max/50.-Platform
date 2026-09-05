-- Per-tenant Tremendous credentials, so each dealer company funds its own
-- rewards from its own card — never one shared platform account paying out
-- for everyone.
--
-- The API key is encrypted at rest with pgcrypto's pgp_sym_encrypt, using a
-- passphrase the application holds (TENANT_CREDENTIALS_ENCRYPTION_KEY) and
-- that is never itself stored in this database. Treated like a password:
-- nothing in the API ever decrypts this and returns it over HTTP — it is
-- only ever decrypted server-side, immediately before the one Tremendous
-- API call that needs it (see PATCH /api/referrals/:id/status in
-- ../../api/README.md). Even a plain `select *` from `tenants` — which the
-- existing tenants_select_own policy already allows any staff member of
-- the tenant to run — only ever yields ciphertext, not the key.
--
-- pgcrypto is already enabled (init_schema.sql, for gen_random_uuid()).

-- The original schema defaulted gift_card_transactions.provider to
-- 'amazon_incentives', from when Amazon Incentives was the planned
-- vendor. That decision changed to Tremendous before any integration was
-- ever built — no row has ever been written to this table — so this only
-- corrects a default that was never actually used, not live data.
alter table gift_card_transactions
  alter column provider set default 'tremendous';

alter table tenants
  add column tremendous_api_key_encrypted  bytea,
  add column tremendous_funding_source_id  text,
  add column tremendous_connected_at       timestamptz;

comment on column tenants.tremendous_api_key_encrypted is 'This tenant''s own Tremendous API key, encrypted with pgp_sym_encrypt(plaintext, TENANT_CREDENTIALS_ENCRYPTION_KEY). Write-only in practice — the API never selects this back to a client.';
comment on column tenants.tremendous_funding_source_id is 'Which of this tenant''s own Tremendous funding sources (their connected card) an order should draw from. Not a secret on its own, but meaningless without the key above, so it lives alongside it.';
comment on column tenants.tremendous_connected_at is 'When this tenant''s Tremendous credentials were last set. Null means no credentials on file — PATCH /api/referrals/:id/status marks a referral rewarded either way, it just can''t issue an actual reward until this is set.';

-- ---------------------------------------------------------------------------
-- gift_card_transactions — until now, nothing ever wrote to this table (no
-- gift-card provider existed yet, per the original RLS migration's comment
-- that "all writes are the payout job's, under the service role"). Now
-- that PATCH /api/referrals/:id/status *is* the payout job — the same
-- admin-triggered request that changes status also, in the same
-- transaction, records the Tremendous order it made (or attempted) — it
-- needs its own narrow write policy, the same shape as the audit_log one.
-- ---------------------------------------------------------------------------
grant insert, update on gift_card_transactions to authenticated;

create policy gift_card_transactions_insert_admin on gift_card_transactions
  for insert to authenticated
  with check (tenant_id = current_tenant_id() and is_admin());

-- The insert above claims the idempotency slot with status = 'pending'
-- (see PATCH /api/referrals/:id/status) before the Tremendous API call is
-- even made; this update is what records the actual outcome afterward.
create policy gift_card_transactions_update_admin on gift_card_transactions
  for update to authenticated
  using (tenant_id = current_tenant_id() and is_admin())
  with check (tenant_id = current_tenant_id() and is_admin());

comment on policy gift_card_transactions_insert_admin on gift_card_transactions is 'An admin marking a referral rewarded is what triggers a Tremendous order attempt; this claims the idempotency slot (status = pending) before the external call is made, so two concurrent attempts can never both issue a reward.';
comment on policy gift_card_transactions_update_admin on gift_card_transactions is 'Flips a claimed (pending) row to issued or failed once the Tremendous call actually returns.';
