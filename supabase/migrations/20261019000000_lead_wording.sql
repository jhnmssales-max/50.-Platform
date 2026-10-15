begin;

-- The wording each new dealer wants their own customers to read.
--
-- Every public page and email a customer or referred friend sees already
-- reads its sentences from tenants.branding.copy (see tenant-branding.js's
-- DEFAULT_COPY and api/src/lib/inviteEmail.js). What was missing was any way
-- to COLLECT those sentences: the rep sitting with the business is the only
-- person who knows that a roofer says "hire us" where a shed dealer says
-- "buy a shed", and there was nowhere to write it down. It got typed, if at
-- all, after the dashboard was already built and the first invite had gone
-- out carrying shed wording to a roofing company's customers.
--
-- So the lead carries it from the start. rep_leads.copy holds exactly the
-- same keys as tenants.branding.copy, and approve_lead_build already writes
-- whatever jsonb it is handed straight into tenants.branding, so the API
-- merges this in at build time (api/src/routes/reps.js) rather than this
-- migration adding any new plumbing.
--
-- Shape (a jsonb object; every key optional, and a missing or blank key
-- means "use the generic wording" — api/src/lib/tenantCopy.js GENERIC_COPY,
-- which is deliberately trade-neutral, never the shed wording that is still
-- the default for the tenants that predate this):
--   offerHow        -- the main offer sentence, in the invite email and on the share page
--   shareTitle      -- the title on the phone's share sheet when a customer shares their link
--   shareText       -- the message that share sheet pre-fills
--   friendAction    -- what the referred friend has to do, on the lead page ("place your order")
--   afterPurchase   -- the same thing in the past tense, on the thank-you screen
--   eligibility     -- who may take part, on the terms page
--   qualifyingEvent -- what earns the reward, on the terms page
--   rewardCondition -- the condition the business confirms before a card is sent, on the terms page
--   inquiryNoun     -- what the friend's submission is called, on the privacy page
--
-- {reward} and {name} are filled in wherever they appear, and **bold** is
-- honored in the invite email. Lengths are not constrained here: the API
-- caps each field, and a CHECK per key would have to be rewritten every time
-- a key is added.
alter table rep_leads
  add column copy jsonb;

-- The same guard tenants.branding carries, for the same reason: a bad write
-- (an array, a bare string) should fail here rather than silently produce a
-- dealer whose pages render nothing.
alter table rep_leads
  add constraint rep_leads_copy_is_object
  check (copy is null or jsonb_typeof(copy) = 'object');

comment on column rep_leads.copy is 'The wording this business wants its own customers to read, collected by the rep: {offerHow, shareTitle, shareText, friendAction, afterPurchase, eligibility, qualifyingEvent, rewardCondition, inquiryNoun}, every key optional. Merged into tenants.branding.copy when the dashboard is built; a missing or blank key falls back to the trade-neutral wording in api/src/lib/tenantCopy.js, never to shed wording.';

commit;
