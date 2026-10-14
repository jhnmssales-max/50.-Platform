-- Building a dealer from a won lead: the brand files a rep drags onto it, the
-- branding guessed from their website or logo, and the approval step that
-- turns all of it into a real 50. account.
--
-- One explicit transaction, like every other migration here. Safe to apply
-- before the API code that reads it: nothing existing reads any of it.
--
-- The shape of the thing: a lead a rep marks WON does not become a dealer.
-- It queues for Joseph (build_status 'awaiting_approval'), carrying a DRAFT
-- brand that was guessed, never trusted. He sees it, corrects it, and
-- approves — and only then does a tenant exist. Nothing a rep types or
-- uploads reaches a dealer's page without passing under his eye first.
begin;

-- ---------------------------------------------------------------------------
-- 1. Where a won lead sits while it waits for Joseph
-- ---------------------------------------------------------------------------
alter table rep_leads
  add column build_status text not null default 'none'
    check (build_status in ('none', 'awaiting_approval', 'built', 'declined')),
  -- The draft branding: the same keys tenants.branding uses (primaryColor,
  -- primaryDark, secondary, accentColor, accentDark, bg, logoUrl,
  -- contactEmail), so approving is a copy rather than a translation. Null
  -- until something has actually been guessed or typed.
  add column brand jsonb,
  -- Where that draft came from, for the approval screen to be honest about:
  -- 'website', 'logo', 'manual', or null. A guess is labelled as a guess.
  add column brand_source text check (brand_source in ('website', 'logo', 'manual')),
  -- This dealer's gift card, when it is not the standard $50. Null means the
  -- platform default. Joseph sets it on the approval screen; a rep cannot.
  add column reward_amount_cents integer check (reward_amount_cents > 0),
  add column approved_by uuid references users(id),
  add column built_at timestamptz,
  add column declined_reason text;

comment on column rep_leads.build_status is '''none'' until the lead is won. Winning sets ''awaiting_approval'': it is in Joseph''s queue and no dealer exists yet. Approving creates the tenant and sets ''built''. ''declined'' is a won lead he decided not to build.';
comment on column rep_leads.brand is 'DRAFT branding for the dealer that has not been built yet — the same keys as tenants.branding. Guessed from their website or their logo, or typed by Joseph. Never used anywhere until he approves it.';
comment on column rep_leads.brand_source is 'Where the draft brand came from, so the approval screen can say whether it was guessed (website, logo) or typed (manual).';
comment on column rep_leads.reward_amount_cents is 'This dealer''s gift card, when it differs from the platform default. Set by the admin on the approval screen only — the $500 activation and the 30% fee never vary, this does.';

-- The queue, and the "waiting on payment" list that follows from it.
create index rep_leads_build_status_idx on rep_leads (build_status) where build_status <> 'none';

-- A won lead is in the queue; only a built one has a dealer. Written as two
-- narrow checks rather than one wide one so a failure names what went wrong.
alter table rep_leads add constraint rep_leads_build_needs_win
  check (build_status = 'none' or status = 'won');
alter table rep_leads add constraint rep_leads_built_has_dealer
  check (build_status <> 'built' or (tenant_id is not null and built_at is not null));

-- ---------------------------------------------------------------------------
-- 2. The files a rep drops on a lead
-- ---------------------------------------------------------------------------
-- The bytes live in Supabase Storage (Render wipes its disk on every deploy);
-- this table is the index of them. storage_path is what the API deletes by,
-- public_url is what a page would load.
create table rep_lead_files (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references rep_leads(id) on delete cascade,
  kind          text not null default 'other' check (kind in ('logo', 'other')),
  filename      text not null check (length(btrim(filename)) > 0),
  content_type  text not null,
  size_bytes    integer not null check (size_bytes > 0),
  storage_path  text not null unique,
  public_url    text not null,
  uploaded_by   uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

create index rep_lead_files_lead_idx on rep_lead_files (lead_id, created_at);

comment on table rep_lead_files is 'Brand files a rep dragged onto a lead — a logo, a colour sheet, a screenshot of their sign. The bytes are in Supabase Storage; this is the index. kind = ''logo'' is the one the build reads colours out of and puts on their pages.';

alter table rep_lead_files enable row level security;
revoke all on rep_lead_files from anon, authenticated;
grant select, insert, delete on rep_lead_files to authenticated;

-- Staff see every lead's files; a rep sees only their own lead's, and may
-- only attach to and remove from a lead that is already theirs. Written as
-- an EXISTS against rep_leads rather than repeating the ownership rule, so
-- there is one definition of "my lead" and these follow it.
create policy rep_lead_files_staff_all on rep_lead_files
  for select to authenticated using (is_platform_staff());
create policy rep_lead_files_staff_insert on rep_lead_files
  for insert to authenticated with check (is_platform_staff());
create policy rep_lead_files_staff_delete on rep_lead_files
  for delete to authenticated using (is_platform_staff());

create policy rep_lead_files_own_select on rep_lead_files
  for select to authenticated
  using (exists (
    select 1 from rep_leads l
    where l.id = rep_lead_files.lead_id
      and (l.brought_in_by_rep_id = current_rep_id() or l.closed_by_rep_id = current_rep_id())
  ));
create policy rep_lead_files_own_insert on rep_lead_files
  for insert to authenticated
  with check (exists (
    select 1 from rep_leads l
    where l.id = rep_lead_files.lead_id
      and (l.brought_in_by_rep_id = current_rep_id() or l.closed_by_rep_id = current_rep_id())
  ));
create policy rep_lead_files_own_delete on rep_lead_files
  for delete to authenticated
  using (exists (
    select 1 from rep_leads l
    where l.id = rep_lead_files.lead_id
      and (l.brought_in_by_rep_id = current_rep_id() or l.closed_by_rep_id = current_rep_id())
  ));

-- ---------------------------------------------------------------------------
-- 3. Winning a lead puts it in the queue
-- ---------------------------------------------------------------------------
-- A trigger rather than something the API remembers to do: the queue is what
-- Joseph works from, so a won lead that never reached it would be a rep's
-- deal quietly lost. The API cannot forget, and neither can a hand-written
-- UPDATE run in the SQL editor.
create or replace function rep_leads_queue_on_win() returns trigger
language plpgsql
as $$
begin
  if new.status = 'won' and (old.status is distinct from 'won') and new.build_status = 'none' then
    -- A lead won straight onto a dealer that already exists (the old path,
    -- where staff attach a tenant) is already built; there is nothing to
    -- approve. Everything else queues.
    new.build_status := case when new.tenant_id is not null then 'built' else 'awaiting_approval' end;
    if new.tenant_id is not null and new.built_at is null then new.built_at := now(); end if;
  end if;
  return new;
end;
$$;

create trigger rep_leads_queue_on_win_trg
  before update on rep_leads
  for each row execute function rep_leads_queue_on_win();

comment on function rep_leads_queue_on_win() is 'Winning a lead puts it in Joseph''s build queue, unless it was won straight onto a dealer that already exists, which is already built. A trigger so a won deal can never fail to reach the queue.';

-- ---------------------------------------------------------------------------
-- 4. Approving: the one step that creates a dealer
-- ---------------------------------------------------------------------------
-- Admin only, and it does the whole thing in one transaction: the tenant with
-- its branding and its gift card, the rep put on it, and the lead marked
-- built. The login for the dealer's own admin is NOT made here — that is
-- Supabase Auth's, and the API does it either side of this call.
--
-- Returns the new tenant's id.
create or replace function approve_lead_build(
  p_lead_id uuid,
  p_slug text,
  p_name text,
  p_brand jsonb,
  p_reward_amount_cents integer default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead rep_leads%rowtype;
  v_tenant_id uuid;
  v_slug text;
  v_n int;
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can build a dealer' using errcode = '42501';
  end if;

  select * into v_lead from rep_leads where id = p_lead_id for update;
  if not found then
    raise exception 'No such lead' using errcode = 'P0002';
  end if;
  if v_lead.status <> 'won' then
    raise exception 'That lead has not been won yet' using errcode = '22023';
  end if;
  if v_lead.build_status = 'built' then
    raise exception 'That lead already has a 50. account' using errcode = '22023';
  end if;
  if coalesce(btrim(p_slug), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'A dealer needs a name and a slug' using errcode = '22023';
  end if;

  -- Make the address unique HERE rather than in the API, because the API runs
  -- as the signed-in user and RLS hides every tenant but their own: a check
  -- for "is this slug taken" run up there would answer no for every dealer
  -- that exists, and then the insert would fail on the unique index. Two
  -- businesses with the same name is not far-fetched, so the second one gets
  -- a -2 and the third a -3.
  v_slug := btrim(p_slug);
  if exists (select 1 from tenants where slug = v_slug) then
    for v_n in 2..60 loop
      if not exists (select 1 from tenants where slug = v_slug || '-' || v_n) then
        v_slug := v_slug || '-' || v_n;
        exit;
      end if;
      if v_n = 60 then
        raise exception 'Too many dealers already use that name — give this one a slightly different name' using errcode = '22023';
      end if;
    end loop;
  end if;

  -- billing_required defaults to true, which is what gates them into paying
  -- the $500 at their first sign-in. Never set it here: the three exempt
  -- tenants are fixed in the schema and a built dealer is never one of them.
  insert into tenants (slug, name, branding, reward_amount_cents)
  values (
    v_slug,
    btrim(p_name),
    coalesce(p_brand, '{}'::jsonb),
    coalesce(p_reward_amount_cents, 5000)
  )
  returning id into v_tenant_id;

  update rep_leads
     set tenant_id = v_tenant_id,
         build_status = 'built',
         built_at = now(),
         approved_by = auth.uid(),
         brand = coalesce(p_brand, brand),
         reward_amount_cents = p_reward_amount_cents
   where id = p_lead_id;

  -- The rep who closed it goes on the dealer, which is what earns them the
  -- $50 once the activation clears. assign_rep() is not called here because
  -- it refuses anyone who is not staff and this already ran its own admin
  -- check; the insert is the same one it would make.
  if v_lead.closed_by_rep_id is not null or v_lead.onboarded_by_rep_id is not null then
    insert into rep_assignments (tenant_id, closer_rep_id, onboarder_rep_id, effective_from)
    values (v_tenant_id, v_lead.closed_by_rep_id, v_lead.onboarded_by_rep_id, now());
  end if;

  return v_tenant_id;
end;
$$;

-- The caller needs the address that was actually used, which may not be the
-- one it asked for. Kept as a separate lookup rather than a second return
-- value so the function's signature stays one id.
revoke all on function approve_lead_build(uuid, text, text, jsonb, integer) from public, anon;
grant execute on function approve_lead_build(uuid, text, text, jsonb, integer) to authenticated;

comment on function approve_lead_build(uuid, text, text, jsonb, integer) is 'Admin only. Turns a won lead into a real 50. dealer: creates the tenant with its branding and gift card, puts the closing rep on it, and marks the lead built — all in one transaction. The dealer''s own login is made by the API through Supabase Auth, not here. Returns the new tenant id.';

-- Declining a won lead: it stays won (the rep still closed it) but no dealer
-- is built. Separate from approving so the reason is recorded.
create or replace function decline_lead_build(p_lead_id uuid, p_reason text default null) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_platform_admin() then
    raise exception 'Only the 50. admin can decline a build' using errcode = '42501';
  end if;
  update rep_leads
     set build_status = 'declined', declined_reason = p_reason, approved_by = auth.uid()
   where id = p_lead_id and build_status = 'awaiting_approval';
  if not found then
    raise exception 'That lead is not waiting to be built' using errcode = '22023';
  end if;
end;
$$;

revoke all on function decline_lead_build(uuid, text) from public, anon;
grant execute on function decline_lead_build(uuid, text) to authenticated;

comment on function decline_lead_build(uuid, text) is 'Admin only. Takes a won lead out of the build queue without creating a dealer, recording why. The lead stays won: the rep still closed it.';

commit;
