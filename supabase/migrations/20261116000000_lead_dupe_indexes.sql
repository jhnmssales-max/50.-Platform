-- Make the duplicate check survive a big list.
--
-- rep_lead_duplicates() is run once for every lead anyone adds, and it
-- compares three normalised expressions:
--
--   regexp_replace(lower(btrim(company_name)), '\s+', '', 'g')
--   regexp_replace(phone, '\D', '', 'g')
--   lower(email)
--
-- None of them could use an index. The only one that existed was on
-- lower(btrim(company_name)) -- without the whitespace strip, so a different
-- expression and useless here -- and phone and email had none at all. Every
-- insert therefore read the whole of rep_leads.
--
-- That was free at a few hundred leads. An agency working a bought call list
-- puts 10,000+ a month through this, against a table growing by the same
-- amount, so the cost per insert climbs every month: the hundred-thousandth
-- lead of the year pays for reading the ninety-nine thousand before it.
--
-- Normalising through named IMMUTABLE functions rather than repeating the
-- regexps inline is the point: an expression index only applies when the
-- query spells the expression exactly the same way, and that is precisely
-- how the old company index came to be dead weight.

create or replace function fifty_norm_company(p text)
returns text language sql immutable parallel safe
as $$ select regexp_replace(lower(btrim(coalesce(p, ''))), '\s+', '', 'g') $$;

comment on function fifty_norm_company(text) is
  'A company name reduced to what makes two of them the same one: lowercased, trimmed, all whitespace removed, so "North Mountain Structures", "north mountain structures" and "NorthMountainStructures" collide. IMMUTABLE because rep_leads is indexed on it -- never change what it returns without reindexing, or duplicate detection silently starts missing matches.';

create or replace function fifty_norm_digits(p text)
returns text language sql immutable parallel safe
as $$ select regexp_replace(coalesce(p, ''), '\D', '', 'g') $$;

comment on function fifty_norm_digits(text) is
  'A phone number reduced to its digits, so formatting never decides whether two numbers match. IMMUTABLE because rep_leads is indexed on it.';

create index if not exists rep_leads_norm_company_idx
  on rep_leads (fifty_norm_company(company_name));
create index if not exists rep_leads_norm_phone_idx
  on rep_leads (fifty_norm_digits(phone)) where phone is not null;
create index if not exists rep_leads_norm_email_idx
  on rep_leads (lower(btrim(email))) where email is not null;

-- Superseded: same column, without the whitespace strip, so nothing queries it.
drop index if exists rep_leads_company_name_lower_idx;

-- Three index lookups instead of one scan with a three-way OR.
--
-- Written as a UNION rather than an OR because each branch then stands on
-- its own index. The `p_phone is not null` style guards are constant for the
-- whole call, so Postgres settles them once and skips that branch entirely
-- rather than testing every row -- which is what the OR form could not do.
--
-- Everything below the CTE is unchanged: who may see which row is still
-- decided per row, and a rep still learns only that somebody else's company
-- is already being worked.
create or replace function rep_lead_duplicates(
  p_company text,
  p_phone text default null,
  p_email text default null,
  p_exclude uuid default null
) returns table (
  id uuid,
  company_name text,
  contact_name text,
  phone text,
  email text,
  found_on date,
  status text,
  brought_in_by_rep_id uuid,
  mine boolean,
  visible boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select current_rep_id() as rep_id, is_platform_staff() as staff),
  matched as (
    select l.id
      from rep_leads l
     where fifty_norm_company(l.company_name) = fifty_norm_company(p_company)
    union
    select l.id
      from rep_leads l
     where p_phone is not null
       and length(fifty_norm_digits(p_phone)) >= 7
       and l.phone is not null
       and fifty_norm_digits(l.phone) = fifty_norm_digits(p_phone)
    union
    select l.id
      from rep_leads l
     where p_email is not null
       and btrim(p_email) <> ''
       and l.email is not null
       and lower(btrim(l.email)) = lower(btrim(p_email))
  ),
  hit as (
    select l.*
      from rep_leads l
      join matched m on m.id = l.id, me
     where (me.staff or me.rep_id is not null)
       and (p_exclude is null or l.id <> p_exclude)
  )
  select h.id,
         h.company_name,
         case when v.show then h.contact_name end,
         case when v.show then h.phone end,
         case when v.show then h.email end,
         case when v.show then h.found_on end,
         case when v.show then h.status end,
         case when v.show then h.brought_in_by_rep_id end,
         (me.rep_id is not null and h.brought_in_by_rep_id = me.rep_id),
         v.show
  from hit h, me,
       lateral (select (me.staff or h.brought_in_by_rep_id = me.rep_id or h.closed_by_rep_id = me.rep_id) as show) v
  order by h.created_at
  limit 10
$$;

-- The leads list orders by (found_on desc, created_at desc) on every page
-- load, and is about to start paging through six figures of them.
create index if not exists rep_leads_found_on_created_idx
  on rep_leads (found_on desc, created_at desc);

-- Searching the list, which is the only way to reach a lead once there are
-- more of them than any page can show.
--
-- The search box on the reps page filters rows already on screen, so it could
-- only ever find what the 500-row fetch happened to include. It moves to the
-- server in this change, which means a substring match across four columns
-- over the whole table on every keystroke.
--
-- Trigrams make that an index lookup. If the extension is not available the
-- index is skipped and the search still works -- Postgres falls back to
-- reading the table, which is slower but never wrong. Worth having either
-- way, so this must not fail the migration.
do $$
begin
  begin
    create extension if not exists pg_trgm;
  exception when others then
    raise notice 'pg_trgm unavailable (%), lead search will scan instead of using an index', sqlerrm;
  end;

  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute $ix$
      create index if not exists rep_leads_search_idx on rep_leads using gin (
        (company_name || ' ' || coalesce(contact_name, '') || ' ' ||
         coalesce(email, '') || ' ' || coalesce(phone, '')) gin_trgm_ops)
    $ix$;
  end if;
end $$;
