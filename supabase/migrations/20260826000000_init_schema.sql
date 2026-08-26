-- Referral platform: core schema
-- Draft 2 of the backend spec — Amazon Incentives for gift cards, email-only
-- dealer-to-customer sends via a per-tenant verified sending domain (no SMS).
--
-- Scope: tables, constraints, and indexes only. No RLS policies, functions,
-- or triggers yet — those land with the API layer, which this migration
-- intentionally does not touch.
--
-- Depends on Supabase's `auth` schema (auth.users) already existing, which
-- Supabase provisions itself — it is not created here. Running this against
-- a plain Postgres instance (outside Supabase) requires a stand-in
-- auth.users(id uuid primary key) table for the users.id foreign key below.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- tenants — one row per 50.-Platform customer running a referral program
-- ---------------------------------------------------------------------------
create table tenants (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique,
  name                      text not null,
  domain                    text unique,
  reward_amount_cents       integer not null default 5000,
  reward_currency           text not null default 'USD',
  branding                  jsonb not null default '{}'::jsonb,
  send_domain               text unique,
  send_from_name            text,
  send_from_address         text,
  send_domain_verified      boolean not null default false,
  send_domain_verified_at   timestamptz,
  created_at                timestamptz not null default now()
);

comment on table tenants is 'One row per 50.-Platform customer running a referral program: branding, reward amount, and the tenant''s own verified sending domain.';
comment on column tenants.send_domain is 'The tenant''s own domain for outbound mail, e.g. mail.acmesheds.com — never a shared 50.-Platform domain.';
comment on column tenants.send_domain_verified is 'DKIM/SPF verified with the email provider. Gates whether the API is allowed to send on this tenant''s behalf.';

-- ---------------------------------------------------------------------------
-- users — staff accounts: dealers and admins who log in
-- ---------------------------------------------------------------------------
create table users (
  id            uuid primary key references auth.users(id) on delete cascade,
  tenant_id     uuid not null references tenants(id),
  email         text not null unique,
  name          text not null,
  role          text not null check (role in ('admin', 'dealer')),
  created_at    timestamptz not null default now()
);

create index users_tenant_id_idx on users (tenant_id);

comment on table users is 'Staff accounts — dealers and admins. Mirrors auth.users(id) rather than storing its own credentials.';

-- ---------------------------------------------------------------------------
-- customers — anyone who can hold or generate a referral link
-- ---------------------------------------------------------------------------
create table customers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  name                  text not null,
  email                 text not null,
  phone                 text,
  created_by_user_id    uuid references users(id),
  created_at            timestamptz not null default now()
);

create index customers_tenant_id_idx on customers (tenant_id);

comment on table customers is 'The person a dealer originally invites, and any referred friend who goes on to order (auto-created at that point so they can refer their own friends).';
comment on column customers.email is 'Required — email is the only send channel (no SMS), and where an Amazon Incentives gift card is ultimately delivered.';
comment on column customers.phone is 'Optional. Kept for the dealer''s own reference only — nothing in the system sends to it.';
comment on column customers.created_by_user_id is 'Null when this customer was auto-created from a converted referral rather than entered by a dealer.';

-- ---------------------------------------------------------------------------
-- referral_links — both dealer "invite" links and customer "share" links
-- ---------------------------------------------------------------------------
create table referral_links (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  code            text not null unique,
  kind            text not null check (kind in ('invite', 'share')),
  customer_id     uuid not null references customers(id),
  parent_link_id  uuid references referral_links(id),
  status          text not null default 'active' check (status in ('active', 'used', 'expired')),
  expires_at      timestamptz,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index referral_links_tenant_id_status_idx on referral_links (tenant_id, status);
create index referral_links_customer_id_idx on referral_links (customer_id);
create index referral_links_parent_link_id_idx on referral_links (parent_link_id);

comment on table referral_links is 'Every shareable code, of either kind. One table for both link types, linked by parent_link_id so a referral chain is traceable in one join.';
comment on column referral_links.parent_link_id is 'A "share" link''s parent is the "invite" link that onboarded its owner.';

-- ---------------------------------------------------------------------------
-- referrals — one row per friend who lands on a share link and submits it
-- ---------------------------------------------------------------------------
create table referrals (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  referral_link_id    uuid not null unique references referral_links(id),
  name                text not null,
  email               text not null,
  phone               text,
  message             text,
  status              text not null default 'new'
                        check (status in ('new', 'contacted', 'ordered', 'rewarded', 'declined')),
  order_id            text,
  submitted_at        timestamptz not null default now(),
  ordered_at          timestamptz,
  rewarded_at         timestamptz
);

create index referrals_tenant_id_status_idx on referrals (tenant_id, status);

comment on table referrals is '1:1 with the referral_links row it came from — a link can only ever produce one referral (unique constraint), not a client-side "already used" check.';
comment on column referrals.email is 'Required — where the gift card and any follow-up go; no SMS channel exists.';
comment on column referrals.order_id is 'External CRM/order-system reference, set by the order webhook once the referral converts.';

-- ---------------------------------------------------------------------------
-- gift_card_transactions — the money ledger
-- ---------------------------------------------------------------------------
create table gift_card_transactions (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id),
  referral_id               uuid not null references referrals(id),
  recipient_customer_id     uuid not null references customers(id),
  recipient_role            text not null check (recipient_role in ('referrer', 'new_customer')),
  amount_cents              integer not null,
  currency                  text not null default 'USD',
  provider                  text not null default 'amazon_incentives',
  provider_transaction_id   text,
  status                    text not null default 'pending' check (status in ('pending', 'issued', 'failed')),
  idempotency_key           text not null unique,
  created_at                timestamptz not null default now(),
  issued_at                 timestamptz
);

create index gift_card_transactions_referral_id_idx on gift_card_transactions (referral_id);
create index gift_card_transactions_recipient_customer_id_idx on gift_card_transactions (recipient_customer_id);

comment on table gift_card_transactions is 'Two rows per completed referral — one for the referrer, one for the new customer — each an idempotent, auditable call to Amazon Incentives.';
comment on column gift_card_transactions.idempotency_key is 'referral_id + recipient_role — guarantees one card per side, ever, even under a retried payout job.';

-- ---------------------------------------------------------------------------
-- audit_log — append-only trail for status changes and payouts
-- ---------------------------------------------------------------------------
create table audit_log (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  actor_user_id     uuid references users(id),
  action            text not null,
  entity_type       text not null,
  entity_id         uuid not null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index audit_log_tenant_id_idx on audit_log (tenant_id);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);

comment on table audit_log is 'Append-only trail for anything that moves money or changes status. actor_user_id is null for system/webhook-triggered actions.';
