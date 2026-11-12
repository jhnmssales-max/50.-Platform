-- Wrapped in one explicit transaction, like the billing migrations: either
-- all of it lands or none of it does.
--
-- APPLY THIS BEFORE DEPLOYING THE API CODE THAT READS IT. Since
-- lib/schemaCheck.js, the API refuses to start rather than failing one route
-- at a time -- so deploying first takes the service down loudly instead of
-- quietly, which is the improvement, not a licence to skip this.
begin;

-- ---------------------------------------------------------------------------
-- Letting a dealer's CRM talk to 50. directly.
--
-- Everything on this platform authenticates with a Supabase access token: the
-- browser holds one, middleware/auth.js verifies it against Supabase's JWKS,
-- and every route hands the resulting user id to withUserTransaction() and
-- lets RLS answer what that person may see. A CRM cannot hold a Supabase
-- session -- there is nobody to sign in -- so a dealer who wants their CRM to
-- add a customer when an order is marked won has no way to ask.
--
-- The obvious shortcut is to let an API key query as the service role, which
-- bypasses RLS at the connection level (see db.js). That would create a
-- second, unguarded path into tenant data sitting beside the careful one, and
-- the first mistake in it would be a cross-tenant read. So a key does not get
-- its own privileges at all:
--
--   An api_keys row points at a users row. The key authenticates AS that
--   user. getCallerContext() takes a user id and knows nothing about how the
--   caller proved it, so every policy, the activation gate, and tenant
--   scoping apply to a CRM exactly as they apply to a person -- unchanged,
--   and not re-implemented anywhere.
--
-- The user it points at is a staff account made for the purpose ("Velocity
-- Integration"), not the admin who set it up. Two reasons: a key tied to a
-- person stops working the day that person is removed, and audit_log would
-- otherwise record every automated action as something they did by hand.
-- 'staff' rather than 'admin' because adding a customer needs no more than
-- that, and a leaked key should not be able to touch billing.
-- ---------------------------------------------------------------------------
-- Lets api_keys point at (user, tenant) as a pair, so a key row can never
-- name a user who belongs to a different company than the key does. Without
-- it, tenant_id and user_id are two independent foreign keys and nothing but
-- the route's own care stops them disagreeing -- and a key whose two halves
-- disagree would act with one tenant's privileges while being owned by
-- another. id is already the primary key, so this costs one small index and
-- rules the mismatch out by construction rather than by code being careful.
-- Same reasoning, and the same shape, as customers_id_tenant_key in
-- 20261028000000_invite_followups.sql.
alter table users add constraint users_id_tenant_key unique (id, tenant_id);

create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  -- The account this key acts as. No cascade: deleting the integration user
  -- out from under a live key should fail loudly, not silently leave a key
  -- authenticating as nobody.
  user_id       uuid not null,
  -- The pair, not two separate references: see users_id_tenant_key above.
  foreign key (user_id, tenant_id) references users (id, tenant_id),
  name          text not null,
  -- The first few characters, kept in clear so the management screen can
  -- show which key is which. Not a secret and not enough to authenticate.
  key_prefix    text not null,
  -- sha256 of the whole key, hex. The key itself is shown once, at creation,
  -- and never stored -- so a database copy does not hand anyone a working
  -- credential. Unique because a verify is a lookup BY this value: with an
  -- index on it, checking a key is one indexed read rather than a scan and a
  -- comparison per row.
  key_hash      text not null unique,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Listing a dealer's live keys, which is all the management screen asks for.
create index api_keys_tenant_live_idx on api_keys (tenant_id) where revoked_at is null;

comment on table api_keys is 'Credentials a dealer''s CRM uses to call this API. Each one authenticates as the users row it points at, so RLS and the activation gate apply to it exactly as to a person -- a key carries no privileges of its own.';
comment on column api_keys.user_id is 'The staff account this key acts as: one made for the integration, never a real person''s, so removing an employee does not break the CRM and audit_log does not credit automated work to them.';
comment on column api_keys.key_hash is 'sha256 of the full key. The key is shown once at creation and never stored, so a copy of this table contains no working credential.';
comment on column api_keys.key_prefix is 'The key''s first characters, in clear, so the screen can tell two keys apart. Not sufficient to authenticate.';
comment on column api_keys.revoked_at is 'Set instead of deleting the row, so a key that was used stays in the record. A revoked key fails to authenticate.';

alter table api_keys enable row level security;

-- RLS decides WHICH rows; this decides whether the role may touch the table
-- at all, and without it the policies below are never consulted -- every
-- query fails with "permission denied for table api_keys" instead. Every
-- other table in this schema is granted explicitly the same way (see
-- 20260826020000_rls_policies.sql); there is no default-privileges rule to
-- inherit from.
--
-- No insert: a key's row is created alongside a users row, and `authenticated`
-- has no insert on users either, so creation runs through withServiceRole
-- after the route has confirmed an admin is asking. Select and update are what
-- a signed-in admin does by hand -- list, and revoke.
grant select, update on api_keys to authenticated;

-- Only an admin of the same company, and never the hash: the API selects
-- key_hash through the pool's own role when verifying a key, never on behalf
-- of a signed-in person, so no policy here needs to expose it.
create policy api_keys_select_own_tenant_admin on api_keys
  for select to authenticated
  using (tenant_id = current_tenant_id() and is_admin());

-- Revoking is an update of revoked_at. No delete policy at all: a key that
-- has been used should stay in the table, revoked, rather than vanish.
create policy api_keys_update_own_tenant_admin on api_keys
  for update to authenticated
  using (tenant_id = current_tenant_id() and is_admin())
  with check (tenant_id = current_tenant_id() and is_admin());

-- ---------------------------------------------------------------------------
-- Not inviting the same customer twice.
--
-- POST /api/customers resends the invite when it is given an address it has
-- seen before. That is right for a person pressing Resend and wrong for a
-- machine: a CRM that fires on both "won" and "delivered", or retries a
-- request whose response was lost, would email the same customer again every
-- time. The customer sees a company that cannot keep track of them.
--
-- So an automated caller sends an Idempotency-Key -- the CRM's own order id
-- -- and the key is CLAIMED BEFORE the work starts, not checked after. Two
-- retries racing each other both try to insert the same key; one wins, the
-- other is told the first is in flight. Checking first and inserting later
-- would let both pass the check before either inserted.
--
-- The response is stored so a retry returns what the original returned,
-- rather than a bare "already done" the CRM has to interpret.
-- ---------------------------------------------------------------------------
create table integration_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  api_key_id      uuid references api_keys(id),
  idempotency_key text not null,
  -- Which call this key was used for. A CRM reusing an order id across two
  -- different endpoints is a mistake worth catching rather than silently
  -- replaying one endpoint's answer for the other.
  endpoint        text not null,
  status_code     smallint,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  -- The claim. Scoped per tenant so two dealers' CRMs cannot collide on
  -- order number 1041.
  unique (tenant_id, idempotency_key)
);

create index integration_requests_tenant_created_idx on integration_requests (tenant_id, created_at desc);

comment on table integration_requests is 'One row per idempotency key an automated caller has used. The row is inserted before the work runs, so a concurrent retry loses the insert instead of repeating the side effect; the stored response is replayed to any later retry of the same key.';
comment on column integration_requests.status_code is 'Null while the original request is still running. A retry arriving then is told to come back rather than being allowed through.';
comment on column integration_requests.response_body is 'Exactly what the original request answered, replayed to retries of the same key so the CRM sees one consistent result.';

alter table integration_requests enable row level security;

-- Nothing signed-in reads these; the API handles them through the pool's own
-- role while serving a key-authenticated request. RLS is on with no policy
-- for `authenticated` on purpose, so a route that reached for this table on
-- a person's behalf would fail rather than quietly succeed.

commit;
