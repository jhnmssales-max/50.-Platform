-- Recruits: people Joseph is trying to hire as 50. sales reps, tracked on a
-- board from first application to signed-on rep.
--
-- Why this is not rows in reps. A rep is someone who works for 50.: they
-- earn, they can be given a login, and they appear in every rep list and
-- dropdown on the page. A recruit is an applicant from Wizehire, Handshake or
-- LinkedIn who may never answer. Mixing the two would put twenty strangers in
-- the "who closed this?" dropdown. A recruit becomes a rep at the moment
-- Joseph signs them on (rep_id is set then), and from there they are an
-- ordinary rep like any other.
--
-- Joseph's only. The helper and the reps themselves see nothing here: these
-- are other people's applications, phone numbers and notes about whether
-- they are a fit. RLS is admin-only, the same as rep money.

create table recruits (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  email         text,
  phone         text,
  location      text,
  source        text not null default 'other'
                  check (source in ('wizehire', 'handshake', 'linkedin', 'referral', 'other')),
  stage         text not null default 'applied'
                  check (stage in ('applied', 'contacted', 'replied', 'meeting', 'hired', 'not_a_fit')),
  -- The Zoom / Meet with Joseph. Shown on the week panel beside the board.
  meeting_at    timestamptz,
  -- One short line shown on the card, e.g. "Texted Tue", "Wants evenings".
  next_step     text,
  notes         text,
  -- When each stage was first reached. Kept so "this week: 9 applied,
  -- 6 contacted, 2 replied" stays true after a card moves on, and so moving a
  -- card back and forth does not recount it.
  contacted_at  timestamptz,
  replied_at    timestamptz,
  hired_at      timestamptz,
  stage_changed_at timestamptz not null default now(),
  -- Set when the recruit is signed on as a rep.
  rep_id        uuid references reps(id) on delete set null,
  created_at    timestamptz not null default now()
);

comment on table recruits is 'People Joseph is recruiting as 50. sales reps (Wizehire, Handshake, LinkedIn, referrals). Admin-only. Separate from reps on purpose: an applicant is not a rep until signed on, at which point rep_id is set.';

create index recruits_stage_idx on recruits (stage);
create index recruits_meeting_idx on recruits (meeting_at) where meeting_at is not null;

alter table recruits enable row level security;
revoke all on recruits from anon, authenticated;
grant select, insert, update, delete on recruits to authenticated;

create policy recruits_admin_all on recruits for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
