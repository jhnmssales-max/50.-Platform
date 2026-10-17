const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, withServiceRole, assertRowsAffected, getCallerContext } = require('../db');
const supabaseAdmin = require('../lib/supabaseAdmin');
const storage = require('../lib/supabaseStorage');
const brandGuess = require('../lib/brandGuess');
const dealerBuildEmails = require('../lib/dealerBuildEmails');
const repInviteEmail = require('../lib/repInviteEmail');
const { sendEmail } = require('../lib/postmark');
const tenantCopy = require('../lib/tenantCopy');
const stripeLib = require('../lib/stripe');

// The sales-rep program (see the rep_program migration and workers/repEarnings.js).
//
// Who may call what — the database enforces all of this on its own through
// RLS (every query here runs as the signed-in user); the checks below only
// turn a refusal into a clear 403 instead of an empty result:
//   - Staff of the 50. tenant itself (slug 50-platform) manage reps, leads and
//     which rep is on which dealer. No other tenant's login gets past
//     requirePlatform, and RLS gives them no rows anyway.
//   - A REP signs in to the same tenant with role 'rep' and sees only what is
//     theirs: their own leads, the dealers they are on, and their own earnings
//     and payouts. Routes they may not touch at all refuse with 'staff_only';
//     the rest narrow themselves to current_rep_id(). RLS enforces the same
//     thing underneath, so a mistake here leaks nothing.
//   - Everything about money (what reps earned, what they are owed, payouts,
//     the pay rates) is for the 50. tenant's ADMIN only. The helper (a staff,
//     not admin, user) gets responses with no dollar amounts in them at all.
// Nothing here ever returns stripe ids, card details or a dealer's own
// billing fields.
const router = express.Router();
router.use(cors());

const BILLING_TIME_ZONE = 'America/New_York';

function httpError(status, message, publicCode) {
  const err = new Error(message);
  err.status = status;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

// Resolves who is calling and refuses early. `admin` is Joseph only; `rep`
// lets a sales rep through, in which case the returned ctx.rep_id is the only
// rep whose rows they may see and every handler below narrows to it.
async function requirePlatform(client, userId, { admin = false, rep = false } = {}) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw httpError(403, 'No account found for this user');
  const { rows: [t] } = await client.query('select slug from tenants where id = $1', [ctx.tenant_id]);
  if (!t || t.slug !== '50-platform') throw httpError(403, 'The reps area is only for 50. staff');

  const { rows: [u] } = await client.query('select role from users where id = $1', [userId]);
  const isRep = Boolean(u && u.role === 'rep');
  const { rows: [r] } = await client.query('select current_rep_id() as rep_id');
  const repId = (r && r.rep_id) || null;

  // A rep whose rep record was switched off: current_rep_id() goes null, so
  // they would otherwise see an empty page with no explanation.
  if (isRep && !repId) throw httpError(403, 'This rep account has been switched off. Ask Joseph to turn it back on.', 'rep_inactive');
  if (isRep && !rep) throw httpError(403, 'That part of the reps area is not for reps', 'staff_only');
  if (admin && !ctx.is_admin) throw httpError(403, 'Only the 50. admin can see or change rep money', 'admin_only');
  return { ...ctx, rep_id: repId, is_rep: isRep };
}

// Postgres errors raised by the migration's own functions carry a SQLSTATE
// that maps to a plain HTTP answer; anything else stays a 500.
function mapDbError(err) {
  if (err.status) return err;
  if (err.code === '42501') return httpError(403, err.message);
  if (err.code === 'P0002') return httpError(404, err.message);
  if (err.code === '22023') return httpError(409, err.message);
  if (err.code === '23503') return httpError(400, 'That rep or dealer does not exist');
  if (err.code === '23505') return httpError(409, 'That already exists');
  return err;
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      next(mapDbError(err));
    }
  };
}

const uuid = z.string().uuid();
const optText = (max = 200) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const money = z.number().int().min(0).max(100000000);

function parseOr400(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const err = httpError(400, 'Invalid request');
    err.details = parsed.error.flatten();
    throw err;
  }
  return parsed.data;
}

function monthParam(value, fallback) {
  const m = value || fallback;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw httpError(400, 'month must look like 2026-10');
  return m;
}

async function currentMonth(client) {
  const { rows: [r] } = await client.query(`select to_char(now() at time zone '${BILLING_TIME_ZONE}', 'YYYY-MM') as m`);
  return r.m;
}

// ---------------------------------------------------------------------------
// Reps
// ---------------------------------------------------------------------------
const repBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: optText(200),
  phone: optText(50),
  notes: optText(2000),
});

function repRow(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    active: r.active,
    notes: r.notes,
    created_at: r.created_at,
    // Sent so the page can say "already removed" instead of offering a Remove
    // that the database is going to refuse.
    closed_at: r.closed_at,
    leads_brought_in: r.leads_brought_in,
    companies_closed: r.companies_closed,
    companies_onboarded: r.companies_onboarded,
    // Whether this rep can sign in yet — drives the Invite / Resend button.
    // Never the login itself, and never anything about a password.
    has_login: r.user_id !== undefined ? Boolean(r.user_id) : undefined,
  };
}

// Joseph and the helper get every rep (money only for Joseph). A rep gets
// exactly one row — themselves — WITH their own money, because their own
// earnings are the one set of figures they are allowed to see.
router.get('/reps', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    const { rows } = await client.query(
      `select r.id, r.name, r.email, r.phone, r.active, r.notes, r.created_at, r.user_id, r.closed_at,
              (select count(*)::int from rep_leads l where l.brought_in_by_rep_id = r.id) as leads_brought_in,
              (select count(*)::int from rep_assignments a where a.closer_rep_id = r.id and a.effective_to is null) as companies_closed,
              (select count(*)::int from rep_assignments a where a.onboarder_rep_id = r.id and a.effective_to is null) as companies_onboarded
       from reps r
       order by r.active desc, lower(r.name)`
    );
    const reps = rows.map(repRow);
    if (!ctx.is_admin && !ctx.is_rep) return { reps };

    const month = await currentMonth(client);
    const { rows: money } = await client.query(
      `select r.id,
              -- The same three tests remove_rep() makes for v_has_history, in the
              -- same order. The page decides from this and never from the money
              -- or the dealer counts: those count CURRENT assignments, which go
              -- when a company is deleted, while the leads deliberately stay. A
              -- rep whose only dealer was deleted still has lead history, and a
              -- dialog guessing from dealer counts would promise to delete them
              -- while the database closed them instead.
              (exists (select 1 from rep_earnings e2 where e2.rep_id = r.id)
               or exists (select 1 from rep_payouts p2 where p2.rep_id = r.id)
               or exists (select 1 from rep_leads l where l.brought_in_by_rep_id = r.id
                           or l.closed_by_rep_id = r.id
                           or l.onboarded_by_rep_id = r.id)) as has_history,
              coalesce((select sum(amount_cents) from rep_earnings e where e.rep_id = r.id), 0)::int
                - coalesce((select sum(amount_cents) from rep_payouts p where p.rep_id = r.id), 0)::int as owed_cents,
              coalesce((select sum(amount_cents) from rep_earnings e where e.rep_id = r.id
                         and to_char(e.earned_at at time zone '${BILLING_TIME_ZONE}', 'YYYY-MM') = $1), 0)::int as earned_this_month_cents
       from reps r`,
      [month]
    );
    const byId = Object.fromEntries(money.map((m) => [m.id, m]));
    return {
      month,
      // RLS has already limited both queries to this rep's own row when a rep
      // is calling, so byId may simply not have a rep the list mentions.
      reps: reps
        .filter((r) => byId[r.id])
        .map((r) => ({ ...r, owed_cents: byId[r.id].owed_cents, earned_this_month_cents: byId[r.id].earned_this_month_cents, has_history: byId[r.id].has_history })),
    };
  });
  res.json(out);
}));

router.post('/reps', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(repBody, req.body || {});
  const rep = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    const { rows: [r] } = await client.query(
      `insert into reps (name, email, phone, notes) values ($1, $2, $3, $4)
       returning id, name, email, phone, active, notes, created_at`,
      [body.name, body.email || null, body.phone || null, body.notes || null]
    );
    return { ...r, leads_brought_in: 0, companies_closed: 0, companies_onboarded: 0 };
  });
  res.status(201).json(repRow(rep));
}));

router.patch('/reps/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(repBody.partial().extend({ active: z.boolean().optional() }), req.body || {});
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    const sets = [];
    const vals = [id];
    for (const key of ['name', 'email', 'phone', 'notes', 'active']) {
      if (body[key] !== undefined) {
        vals.push(body[key] === '' ? null : body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    if (!sets.length) throw httpError(400, 'Nothing to change');
    const { rows: [r] } = await client.query(
      `update reps set ${sets.join(', ')} where id = $1 returning id, name, email, phone, active, notes, created_at`,
      vals
    );
    if (!r) throw httpError(404, 'No such rep');
    // Deactivating never moves a rep's dealers or stops their royalties: the
    // admin decides that dealer by dealer, so hand back who is affected.
    let dealers = [];
    if (r.active === false) {
      const { rows } = await client.query(
        `select d.tenant_id, d.name, d.closer_rep_id, d.onboarder_rep_id from rep_dealer_list() d
         where d.closer_rep_id = $1 or d.onboarder_rep_id = $1 order by d.name`,
        [id]
      );
      dealers = rows.map((d) => ({
        tenant_id: d.tenant_id,
        name: d.name,
        role: d.closer_rep_id === id && d.onboarder_rep_id === id ? 'closer and onboarder' : d.closer_rep_id === id ? 'closer' : 'onboarder',
      }));
    }
    return { rep: r, dealers_needing_a_decision: dealers };
  });
  res.json({ ...out.rep, dealers_needing_a_decision: out.dealers_needing_a_decision });
}));

// Giving a rep their own login. Admin only: creating a sign-in account is a
// different kind of act from typing someone's phone number in, so the helper
// cannot do it.
//
// No password is ever created, sent or shown. The account is made with none at
// all and the rep follows a one-time link to choose their own (see
// lib/supabaseAdmin.js). Re-running this on a rep who already has a login is a
// RESEND, not an error: the same route covers "they lost the email" and "the
// link expired".
router.post('/reps/:id/invite', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  if (!supabaseAdmin.isConfigured()) {
    throw httpError(
      503,
      'This platform cannot create logins yet: SUPABASE_SERVICE_ROLE_KEY is not set on the API service.',
      'logins_not_configured'
    );
  }

  // Everything the database needs to say first, in its own transaction, so a
  // slow Supabase or Postmark call is not holding a row lock open.
  const repRecord = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [r] } = await client.query('select id, name, email, active, user_id from reps where id = $1', [id]);
    if (!r) throw httpError(404, 'No such rep');
    if (!r.email) throw httpError(400, 'Add an email address for this rep first — that is where the link goes.');
    if (!r.active) throw httpError(409, 'This rep is switched off. Turn them back on before giving them a login.');
    return r;
  });

  const signInUrl = `${String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '')}/reps`;
  let authUserId;
  let link;
  try {
    // Creating the account and minting the link are two calls on purpose: an
    // account that already exists is a resend, not a failure, and this way
    // both paths end with exactly one fresh link.
    ({ userId: authUserId } = await supabaseAdmin.createPasswordlessUser(repRecord.email));
    link = await supabaseAdmin.setPasswordLink(repRecord.email, signInUrl);
  } catch (err) {
    throw httpError(502, `Supabase would not set up that login: ${err.message}`);
  }

  // Attach the login to the 50. tenant as a 'rep', and to this rep row. Done
  // after Supabase succeeds so a failed account never leaves a dangling users
  // row, and written so re-inviting the same person changes nothing.
  //
  // Service role, because this writes the users row that decides who someone
  // IS — exactly the row RLS consults — so no signed-in role may write it,
  // the admin's included. The admin check happened above, under RLS, before
  // anything was created.
  const resend = await withServiceRole(async (client) => {
    const { rows: [platform] } = await client.query(`select id from tenants where slug = '50-platform'`);
    if (!platform) throw httpError(500, 'The 50. tenant is missing');

    const { rows: [existing] } = await client.query('select id, tenant_id, role from users where id = $1', [authUserId]);
    if (existing && existing.tenant_id !== platform.id) {
      throw httpError(409, 'That email already signs in to a different account on this platform.');
    }
    if (existing && existing.role === 'admin') {
      throw httpError(409, 'That email is already the 50. admin — give the rep their own address.');
    }
    if (!existing) {
      await client.query(
        `insert into users (id, tenant_id, email, name, role) values ($1, $2, $3, $4, 'rep')`,
        [authUserId, platform.id, repRecord.email, repRecord.name]
      );
    }
    const { rows: [taken] } = await client.query('select id from reps where user_id = $1 and id <> $2', [authUserId, id]);
    if (taken) throw httpError(409, 'That login already belongs to another rep.');
    await assertRowsAffected(
      client,
      await client.query('update reps set user_id = $2 where id = $1', [id, authUserId]),
      { table: 'reps', id }
    );
    return Boolean(repRecord.user_id);
  });

  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) throw httpError(500, 'EMAIL_FROM_ADDRESS is not set, so the invite cannot be emailed.');
  const mail = repInviteEmail.build({
    repName: repRecord.name,
    link,
    signInUrl,
    logoUrl: `${String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '')}/assets/50-platform-logo.png`,
    resend,
  });
  try {
    await sendEmail({
      from: `Joseph at 50. <${from}>`,
      to: repRecord.email,
      replyTo: process.env.BILLING_SUPPORT_EMAIL || 'joseph@referwith50.com',
      subject: mail.subject,
      htmlBody: mail.htmlBody,
      textBody: mail.textBody,
    });
  } catch (err) {
    // The login exists and works; only the email failed. Say so plainly rather
    // than implying nothing happened — re-inviting is safe and is the fix.
    throw httpError(502, `The login is ready, but the email could not be sent: ${err.message}. Try Resend.`);
  }

  res.json({ ok: true, resent: resend, emailed_to: repRecord.email });
}));

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
// The wording a rep collects for this business. Every key optional, every
// key a string: cleanCopy drops blanks and anything that is not a key we
// know, so a form posting nine empty boxes stores null rather than nine
// empty strings. See api/src/lib/tenantCopy.js for what each one feeds.
// JSON.stringify(null) is the string "null", which Postgres casts to a jsonb
// null — a value, not an absent one, and jsonb_typeof says 'null' rather than
// 'object'. Storing that would both fail rep_leads_copy_is_object and make
// "no wording" indistinguishable from "wording that is literally null", so an
// empty result becomes a real SQL NULL here.
function copyParam(input) {
  const cleaned = tenantCopy.cleanCopy(input);
  return cleaned === null ? null : JSON.stringify(cleaned);
}

const copyBody = z.object(
  Object.fromEntries(tenantCopy.COPY_FIELDS.map((f) => [f.key, z.string().max(f.max).optional()]))
).strict();

const leadFields = {
  company_name: z.string().trim().min(1).max(200),
  contact_name: optText(120),
  phone: optText(50),
  email: optText(200),
  website: optText(300),
  notes: optText(2000),
  brought_in_by_rep_id: uuid.nullable().optional(),
  found_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // null clears it back to the generic wording; omitting it leaves it alone.
  copy: copyBody.nullable().optional(),
};
const leadCreate = z.object({ ...leadFields, confirm_duplicate: z.boolean().optional() });
// Won is deliberately absent: it goes through POST /rep-leads/:id/win, which
// is the one place that decides who gets the credit.
const leadPatch = z.object({ ...leadFields, status: z.enum(['open', 'lost']).optional() }).partial();

const LEAD_COLUMNS = `l.id, l.company_name, l.contact_name, l.phone, l.email, l.website, l.notes,
  l.brought_in_by_rep_id, l.found_on, l.status,
  l.closed_by_rep_id, l.onboarded_by_rep_id, l.closed_on, l.tenant_id, l.created_at,
  l.build_status, l.brand, l.brand_source, l.reward_amount_cents, l.built_at, l.declined_reason,
  l.copy`;

// Whether the data allows a lead to be deleted, with the same test
// DELETE /rep-leads/:id makes. The page must not work this out for itself: it
// cannot see rep_earnings, and a page guessing from what it CAN see is exactly
// how the rep removal dialog came to promise one outcome while the database did
// another. The caller still applies the admin rule, which it knows reliably.
//
// Deliberately NOT part of LEAD_COLUMNS. Three callers reuse that list in a
// RETURNING clause by stripping the `l.` prefix with a regex, which turns the
// correlated `e.tenant_id = l.tenant_id` below into `e.tenant_id = tenant_id` —
// where the unqualified name binds to rep_earnings itself, so the test silently
// becomes "does any rep_earnings row exist at all". Adding it to the shared list
// broke creating and editing leads outright.
const LEAD_CAN_DELETE = `(l.status <> 'won'
   or l.tenant_id is null
   or not exists (select 1 from rep_earnings e where e.tenant_id = l.tenant_id)) as can_delete`;

// A rep calling this gets only their own leads — not because of anything
// here, but because RLS gives them no other rows.
router.get('/rep-leads', requireAuth, wrap(async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && !['open', 'won', 'lost'].includes(status)) throw httpError(400, 'status must be open, won or lost');
  const rows = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows } = await client.query(
      `select ${LEAD_COLUMNS}, ${LEAD_CAN_DELETE} from rep_leads l ${status ? 'where l.status = $1' : ''} order by l.found_on desc, l.created_at desc limit 500`,
      status ? [status] : []
    );
    return rows;
  });
  res.json({ leads: rows });
}));

// Leads that look like the same company: the same name (ignoring case and
// spacing), the same phone digits, or the same email — across EVERY rep's
// leads, which is the whole point, since two reps working one company is the
// thing worth catching.
//
// A rep may not read another rep's leads, so this goes through
// rep_lead_duplicates() (security definer, see the rep_pipeline migration),
// which decides per row how much the caller may see. A row that comes back
// with visible = false is somebody else's: the rep is told the company is
// already being worked and nothing more — not the contact, not whose it is.
async function findDuplicateLeads(client, { company_name, phone, email }, excludeId) {
  const { rows } = await client.query(
    'select * from rep_lead_duplicates($1, $2, $3, $4)',
    [company_name, phone || null, email || null, excludeId || null]
  );
  return rows.map((r) =>
    r.visible
      ? {
          id: r.id,
          company_name: r.company_name,
          contact_name: r.contact_name,
          phone: r.phone,
          email: r.email,
          found_on: r.found_on,
          status: r.status,
          brought_in_by_rep_id: r.brought_in_by_rep_id,
          mine: r.mine,
          visible: true,
        }
      : { id: r.id, company_name: r.company_name, mine: false, visible: false }
  );
}

router.post('/rep-leads', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(leadCreate, req.body || {});
  const out = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    // A rep's lead is always their own: whatever the form sent, it is filed
    // under them. (RLS would refuse anything else anyway — this just turns a
    // confusing refusal into the obvious behaviour.)
    const broughtIn = ctx.is_rep ? ctx.rep_id : body.brought_in_by_rep_id || null;

    // Checked even when the form says "add anyway": confirming past your own
    // near-duplicate is yours to decide, confirming past another rep's company
    // is not, so the second case is refused no matter what was sent.
    {
      const dupes = await findDuplicateLeads(client, body);
      const someoneElses = dupes.some((d) => !d.visible);
      if (dupes.length && (someoneElses || !body.confirm_duplicate)) {
        const message = someoneElses
          ? 'This company is already being worked. Check with Joseph before you spend time on it.'
          : 'This looks like a lead that is already in the list. Check it, then add it anyway if it is a different company.';
        const err = httpError(409, message, 'possible_duplicate');
        err.matches = dupes;
        err.can_add_anyway = !someoneElses;
        throw err;
      }
    }
    const { rows: [lead] } = await client.query(
      `insert into rep_leads (company_name, contact_name, phone, email, website, notes, brought_in_by_rep_id, found_on, copy)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date, current_date), $9::jsonb)
       returning ${LEAD_COLUMNS.replace(/l\./g, '')}`,
      [body.company_name, body.contact_name || null, body.phone || null, body.email || null,
       body.website || null, body.notes || null, broughtIn, body.found_on || null,
       // Blank boxes store nothing: the build fills them with the generic
       // wording, and a lead with no wording is the normal case, not an error.
       copyParam(body.copy)]
    );
    return lead;
  });
  res.status(201).json(out);
}));

router.patch('/rep-leads/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(leadPatch, req.body || {});
  const lead = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    // A rep cannot hand their lead to another rep, or take one.
    if (ctx.is_rep && body.brought_in_by_rep_id !== undefined && body.brought_in_by_rep_id !== ctx.rep_id) {
      throw httpError(403, 'A lead stays with the rep who brought it in.');
    }
    const sets = [];
    const vals = [id];
    for (const key of ['company_name', 'contact_name', 'phone', 'email', 'website', 'notes', 'brought_in_by_rep_id', 'found_on', 'status']) {
      if (body[key] !== undefined) {
        vals.push(body[key] === '' ? null : body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    // Wording is replaced wholesale rather than merged: the form always sends
    // every box, so a box someone emptied means "drop back to the generic
    // wording for that line", and a merge would make that impossible.
    if (body.copy !== undefined) {
      vals.push(copyParam(body.copy));
      sets.push(`copy = $${vals.length}::jsonb`);
    }
    if (!sets.length) throw httpError(400, 'Nothing to change');
    // A won lead stays won: winning is the one step that fixes who gets the
    // credit, and undoing it is a reassignment, not a status flip.
    const { rows: [cur] } = await client.query('select status from rep_leads where id = $1', [id]);
    if (!cur) throw httpError(404, 'No such lead');
    if (cur.status === 'won' && body.status !== undefined) throw httpError(409, 'This lead is already won');
    const { rows: [l] } = await client.query(`update rep_leads set ${sets.join(', ')} where id = $1 returning ${LEAD_COLUMNS.replace(/l\./g, '')}`, vals);
    return l;
  });
  res.json(lead);
}));

// Losing a lead deletes it outright — the company, the contact, the notes and
// any brand files the rep dropped on it. That is what "lost" is meant to do
// here: a dead prospect leaves no trace and stops cluttering the list.
//
// Two things this deliberately will NOT do:
//   - A WON lead can never be deleted this way. It is the record of who closed
//     a dealer, and the dealer itself points back at it.
//   - It does not quietly keep the company reserved. Once it is gone the
//     duplicate check no longer knows about it, so any rep is free to work
//     that company again — which is the right answer for a prospect nobody
//     managed to close.
//
// Who may delete: RLS decides, under the signed-in user, exactly as for every
// other read of this lead — a rep can only reach their own. The delete itself
// then runs as the service role, because rep_leads grants no DELETE to a
// signed-in role at all; the authorization already happened a line earlier.
// `tidy` means "this row should never have been here" rather than "they said
// no". Both remove the lead; only a loss counts against the rep's conversion
// rate. The Lost button sends nothing and still counts, exactly as before.
const leadDeleteBody = z.object({ tidy: z.boolean().optional() });

router.delete('/rep-leads/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const opts = parseOr400(leadDeleteBody, req.body || {});

  const lead = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    // Admin only: a rep must not be able to delete their own lead in a way
    // that keeps it out of their lost column.
    if (opts.tidy && !ctx.is_admin) {
      throw httpError(403, 'Only the 50. admin can remove a lead without it counting as a lost lead.', 'tidy_admin_only');
    }
    const { rows: [l] } = await client.query(
      `select id, company_name, status, build_status, tenant_id,
              coalesce(brought_in_by_rep_id, closed_by_rep_id) as owner_rep_id,
              to_char(found_on, 'YYYY-MM') as found_month
       from rep_leads where id = $1`,
      [id]
    );
    // Not theirs, or not there: RLS has already made those the same thing.
    if (!l) throw httpError(404, 'No such lead');
    // A won lead is normally the record of who closed a dealer, and stays.
    // What makes it worth keeping is MONEY: once a rep has earned from that
    // company, the lead is part of how that came about.
    //
    // The first version of this tested "has no company attached" instead, as a
    // proxy for the same thing. That was wrong, and Joseph found it: the three
    // in-house companies (Good Steward, North Mountain, 50. itself) have
    // companies that can never be removed, and are billing-exempt so they can
    // never earn a rep anything either. Their leads would have been stuck for
    // good, refused with a message telling him to remove a company the system
    // refuses to remove.
    //
    // So the test is the real one. Note what is NOT at risk: rep_earnings and
    // rep_assignments reference the tenant and the rep, never the lead, so
    // deleting a lead cannot move a penny or un-credit anyone — a rep whose
    // dealer has not paid yet is still paid through their assignment. What
    // goes is the pipeline record of who found and closed them.
    //
    // Admin only, deliberately: a rep must not be able to erase the record of
    // what they closed, or anyone else's.
    if (l.status === 'won') {
      if (!ctx.is_admin) {
        throw httpError(403, 'That lead was won, so only the 50. admin can delete it — it is the record of who closed them.', 'won_admin_only');
      }
      if (l.tenant_id) {
        const { rows: [m] } = await client.query(
          'select exists (select 1 from rep_earnings where tenant_id = $1) as earned',
          [l.tenant_id]
        );
        if (m && m.earned) {
          throw httpError(409,
            `${l.company_name} has earned a rep money, so this lead is part of that record and cannot be deleted.`,
            'won_rep_earned');
        }
      }
    }
    const { rows: files } = await client.query('select storage_path from rep_lead_files where lead_id = $1', [id]);
    return { ...l, files };
  });

  await withServiceRole(async (client) => {
    // rep_lead_files cascades on the lead's delete, so the rows go with it.
    // The same condition again as a WHERE, so the one place that actually
    // removes the row cannot be reached by a path that skipped the checks.
    await assertRowsAffected(
      client,
      await client.query(
        `delete from rep_leads l
          where l.id = $1
            and (l.status <> 'won'
                 or l.tenant_id is null
                 or not exists (select 1 from rep_earnings e where e.tenant_id = l.tenant_id))`,
        [id]
      ),
      { table: 'rep_leads', id }
    );
    // A bare count survives, so "how many did they lose" still has an answer.
    // Nothing about WHO: a rep, a month, a number. Counted against the month
    // the lead came in, which is where the rest of that month's figures put it.
    //
    // Not counted for a WON lead: it was not lost, and inflating the lost
    // column would quietly ruin the conversion rate it exists to compute. Nor
    // for an admin tidy-up, for the same reason — a test row someone typed is
    // not a deal anybody failed to close.
    if (lead.owner_rep_id && lead.status !== 'won' && !opts.tidy) {
      await client.query(
        `insert into rep_lead_outcomes (rep_id, month, lost_count)
         values ($1, $2, 1)
         on conflict (rep_id, month) do update
           set lost_count = rep_lead_outcomes.lost_count + 1, updated_at = now()`,
        [lead.owner_rep_id, lead.found_month]
      );
    }
  });

  // The stored files afterwards, and best effort: the rows are the record, and
  // a leftover object in a bucket nobody has a link to is litter, not a leak.
  // It must never turn a delete that already happened into an error.
  for (const f of lead.files) await storage.remove(f.storage_path).catch(() => {});

  res.json({ ok: true, deleted: lead.company_name, files_removed: lead.files.length });
}));

const winBody = z.object({
  closed_by_rep_id: uuid.optional(),
  onboarded_by_rep_id: uuid.nullable().optional(),
  tenant_id: uuid.nullable().optional(),
  effective_from: z.string().datetime({ offset: true }).optional(),
});

// Winning a lead: the company said yes. Whoever closed it gets the credit, and
// that is fixed here.
//
// A REP marking their own lead won is the ordinary case and does exactly that
// and no more — no dealer is created and no money is assigned, because the
// build happens after Joseph has approved it. Staff may additionally point the
// lead at an existing 50. dealer (tenant_id), which puts the reps on it; that
// assignment is what actually earns.
router.post('/rep-leads/:id/win', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(winBody, req.body || {});
  const lead = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    const { rows: [cur] } = await client.query('select status from rep_leads where id = $1 for update', [id]);
    if (!cur) throw httpError(404, 'No such lead');
    if (cur.status === 'won') throw httpError(409, 'This lead is already won');

    // A rep wins it for themselves; only staff may name someone else, attach
    // a dealer, or backdate.
    const closer = ctx.is_rep ? ctx.rep_id : body.closed_by_rep_id;
    if (!closer) throw httpError(400, 'Say which rep closed it');
    if (ctx.is_rep && (body.tenant_id || body.onboarded_by_rep_id || body.effective_from)) {
      throw httpError(403, 'A rep marks the lead won; Joseph sets up the dealer.', 'staff_only');
    }
    if (body.tenant_id) {
      await client.query('select assign_rep($1, $2, $3, $4)', [
        body.tenant_id, closer, body.onboarded_by_rep_id || null, body.effective_from || null,
      ]);
    } else if (body.effective_from) {
      throw httpError(400, 'effective_from only applies together with a dealer (tenant_id)');
    }
    const { rows: [l] } = await client.query(
      `update rep_leads set status = 'won', closed_by_rep_id = $2, onboarded_by_rep_id = $3, closed_on = current_date, tenant_id = $4
       where id = $1 returning ${LEAD_COLUMNS.replace(/l\./g, '')}`,
      [id, closer, body.onboarded_by_rep_id || null, body.tenant_id || null]
    );
    if (!l) throw httpError(404, 'No such lead');
    return l;
  });
  res.json(lead);
}));

// ---------------------------------------------------------------------------
// Dealers and who is on them
// ---------------------------------------------------------------------------
// Joseph and the helper see every dealer; a rep sees only the ones they are
// on. rep_dealer_list() decides that, not this handler.
router.get('/rep-dealers', requireAuth, wrap(async (req, res) => {
  // Closed companies are left out unless asked for, and the function itself
  // refuses to hand one to a rep however this is called.
  const includeClosed = req.query.closed === '1' || req.query.closed === 'true';
  const rows = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows } = await client.query('select * from rep_dealer_list($1)', [includeClosed]);
    return rows;
  });
  res.json({
    dealers: rows.map((d) => ({
      tenant_id: d.tenant_id,
      name: d.name,
      slug: d.slug,
      activated: d.activated,
      activated_on: d.activated_on,
      closer_rep_id: d.closer_rep_id,
      onboarder_rep_id: d.onboarder_rep_id,
      assigned_from: d.assigned_from,
      // Good Steward, North Mountain and 50.'s own tenant: live programs that
      // pay no setup, renewal or 30% fee. Staff see them; a rep never does.
      billing_exempt: d.billing_exempt === true,
      closed_at: d.closed_at || null,
    })),
  });
}));

// ---------------------------------------------------------------------------
// Removing a company, and removing a rep
// ---------------------------------------------------------------------------
// Order matters more than anything else here: Stripe first, database second.
//
// The expensive failure is not a half-deleted row, it is a company that looks
// deleted on the page while its card is still on file and still gets charged
// $100 next year. So the saved card is detached before anything is removed,
// and if Stripe refuses, nothing is deleted at all and the answer says so —
// leaving a company that is still visible and still cancellable, which is the
// recoverable side of the failure.
const deleteBody = z.object({
  // Typed into the dialog and checked against the real name here as well as
  // in the page, so this cannot be driven by accident from anywhere else.
  confirm_name: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});

router.delete('/rep-dealers/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(deleteBody, req.body || {});

  // What it is, and whether it may be deleted at all — before Stripe is touched.
  const company = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [t] } = await client.query(
      'select tenant_id, name, billing_exempt, closed_at from rep_dealer_list(true) where tenant_id = $1',
      [id]
    );
    if (!t) throw httpError(404, 'No such company');
    if (t.billing_exempt) {
      throw httpError(403, `${t.name} is one of your own companies — it runs a live referral program and cannot be deleted here.`, 'in_house');
    }
    if (body.confirm_name !== t.name) {
      throw httpError(400, `Type the company name exactly to confirm. Expected "${t.name}".`, 'name_mismatch');
    }
    return t;
  });

  // The card, read with the service role because a tenant's billing columns
  // are its own and RLS gives 50. staff nothing of another tenant's row.
  const saved = await withServiceRole(async (sc) => {
    const { rows: [r] } = await sc.query(
      'select stripe_customer_id, stripe_payment_method_id from tenants where id = $1',
      [id]
    );
    return r || {};
  });

  let card = { detached: false, reason: 'no saved card' };
  if (saved.stripe_payment_method_id) {
    try {
      card = await stripeLib.detachPaymentMethod(saved.stripe_payment_method_id);
    } catch (err) {
      throw httpError(502,
        `${company.name} was NOT deleted: their saved card could not be removed at Stripe (${err.message}). ` +
        'Nothing has been changed — try again, or detach the card in Stripe first.',
        'card_still_attached');
    }
  }

  // Which of the two happens is decided in the database, under the row lock,
  // from what is actually in the books right now.
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [r] } = await client.query('select * from remove_company($1, $2)', [id, body.reason || null]);
    return r;
  });

  res.json({
    outcome: out.outcome,
    name: company.name,
    card_detached: card.detached,
    card_note: card.reason || null,
    customers_affected: out.customers_affected,
    referrals_affected: out.referrals_affected,
    logins_revoked: out.logins_revoked,
  });
}));

router.delete('/reps/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(deleteBody, req.body || {});

  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [rep] } = await client.query('select id, name, closed_at from reps where id = $1', [id]);
    if (!rep) throw httpError(404, 'No such rep');
    if (rep.closed_at) throw httpError(409, 'That rep has already been removed');
    if (body.confirm_name !== rep.name) {
      throw httpError(400, `Type the rep's name exactly to confirm. Expected "${rep.name}".`, 'name_mismatch');
    }

    // The balance is checked inside delete_rep() as well — that is the one
    // that counts. This is here only so the refusal reads like a sentence
    // rather than a database error.
    const { rows: [bal] } = await client.query(
      `select (coalesce((select sum(amount_cents) from rep_earnings where rep_id = $1), 0)
             - coalesce((select sum(amount_cents) from rep_payouts where rep_id = $1), 0))::int as owed_cents`,
      [id]
    );
    if (bal.owed_cents !== 0) {
      const owed = (bal.owed_cents / 100).toFixed(2);
      throw httpError(409,
        bal.owed_cents > 0
          ? `You still owe ${rep.name} $${owed}. Record the payment, or reverse the earnings, then remove them.`
          : `${rep.name} has been overpaid by $${Math.abs(bal.owed_cents / 100).toFixed(2)}. Settle that first, then remove them.`,
        'balance_not_settled');
    }

    const { rows: [r] } = await client.query('select * from remove_rep($1, $2)', [id, body.reason || null]);
    return { name: rep.name, ...r };
  });

  res.json({ outcome: out.outcome, name: out.name, dealers_released: out.dealers_released });
}));

const assignBody = z.object({
  closer_rep_id: uuid.nullable(),
  onboarder_rep_id: uuid.nullable(),
  effective_from: z.string().datetime({ offset: true }).optional(),
});

router.put('/rep-dealers/:tenantId/assignment', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const body = parseOr400(assignBody, req.body || {});
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    await client.query('select assign_rep($1, $2, $3, $4)', [tenantId, body.closer_rep_id, body.onboarder_rep_id, body.effective_from || null]);
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Brand files on a lead
// ---------------------------------------------------------------------------
// The bytes go to Supabase Storage, never to this service's disk, which Render
// wipes on every deploy (see lib/supabaseStorage.js). RLS decides whose lead
// may be written to; this only turns a refusal into a clear answer.
//
// Raw body rather than multipart or base64: no new dependency, no third
// re-encoding of an image that is about to be re-encoded by storage anyway.
// The name and kind ride along as query parameters.
const uploadBody = express.raw({ type: () => true, limit: storage.MAX_BYTES + 1024 });

async function leadIMayTouch(client, leadId) {
  const { rows: [lead] } = await client.query(
    `select id, company_name, website, status, build_status from rep_leads where id = $1`,
    [leadId]
  );
  // RLS has already filtered this: a lead that is not mine simply is not here.
  if (!lead) throw httpError(404, 'No such lead');
  return lead;
}

router.post('/rep-leads/:id/files', requireAuth, uploadBody, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const kind = req.query.kind === 'logo' ? 'logo' : 'other';
  const filename = String(req.query.filename || 'upload').slice(0, 200);
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();

  if (!storage.isConfigured()) {
    throw httpError(503, 'This platform cannot store files yet: SUPABASE_SERVICE_ROLE_KEY is not set on the API service.', 'uploads_not_configured');
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'There was nothing in that file');
  if (!storage.extensionFor(contentType)) throw httpError(400, 'Upload a PNG, JPG, WEBP, GIF, SVG or PDF');

  // Check the lead first, so nothing is stored for a lead this person cannot
  // touch — a refusal after the upload would leave an orphan in the bucket.
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    await leadIMayTouch(client, id);
  });

  const stored = await storage.upload({ leadId: id, bytes: req.body, contentType });

  try {
    const row = await withUserTransaction(req.userId, async (client) => {
      await requirePlatform(client, req.userId, { rep: true });
      const { rows: [f] } = await client.query(
        `insert into rep_lead_files (lead_id, kind, filename, content_type, size_bytes, storage_path, public_url)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, lead_id, kind, filename, content_type, size_bytes, public_url, created_at`,
        [id, kind, filename, contentType, stored.sizeBytes, stored.storagePath, stored.publicUrl]
      );
      if (!f) throw httpError(403, 'That lead is not yours');
      return f;
    });
    res.status(201).json(row);
  } catch (err) {
    // The row is the record. A file with no row is litter nobody will ever
    // find, so take it back out rather than leave it.
    await storage.remove(stored.storagePath);
    throw err;
  }
}));

router.get('/rep-leads/:id/files', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const files = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows } = await client.query(
      `select id, lead_id, kind, filename, content_type, size_bytes, public_url, created_at
       from rep_lead_files where lead_id = $1 order by created_at`,
      [id]
    );
    return rows;
  });
  res.json({ files });
}));

router.delete('/rep-lead-files/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const removed = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows: [f] } = await client.query(
      'delete from rep_lead_files where id = $1 returning storage_path',
      [id]
    );
    if (!f) throw httpError(404, 'No such file');
    return f;
  });
  await storage.remove(removed.storage_path);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Guessing the brand
// ---------------------------------------------------------------------------
// Always a guess, and said so: the answer carries where each part came from so
// the approval screen can show it as something to check rather than a fact.
// Staff and admin only — it is the approval step that uses it, and it reaches
// out to somebody else's website.
router.post('/rep-leads/:id/brand-guess', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const prefer = req.query.from === 'logo' ? 'logo' : req.query.from === 'website' ? 'website' : 'auto';

  const { lead, logo } = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    const l = await leadIMayTouch(client, id);
    const { rows: [f] } = await client.query(
      `select public_url, content_type from rep_lead_files
       where lead_id = $1 and kind = 'logo' order by created_at desc limit 1`,
      [id]
    );
    return { lead: l, logo: f || null };
  });

  const attempts = [];

  // The logo the rep uploaded first when there is one: they chose it, and a
  // homepage is a noisier place to look than the mark itself.
  if (logo && prefer !== 'website') {
    try {
      const fetched = await fetch(logo.public_url);
      if (!fetched.ok) throw new Error(`the stored file answered ${fetched.status}`);
      const bytes = Buffer.from(await fetched.arrayBuffer());
      const out = brandGuess.fromLogo(bytes, logo.content_type, logo.public_url);
      attempts.push({ from: 'logo', ...out });
      if (out.ok) return res.json({ ...out, attempts });
    } catch (err) {
      attempts.push({ from: 'logo', ok: false, reason: `Could not read the uploaded logo: ${err.message}` });
    }
  }

  if (lead.website && prefer !== 'logo') {
    const out = await brandGuess.fromWebsite(lead.website);
    attempts.push({ from: 'website', ...out });
    // A logo the rep uploaded beats one scraped off a page, when we have both.
    if (out.ok) {
      const brand = { ...out.brand, ...(logo ? { logoUrl: logo.public_url } : {}) };
      return res.json({ ...out, brand, attempts });
    }
  }

  // Nothing to go on: 50.'s own palette, plainly labelled, for Joseph to type
  // over. Not an error — plenty of small builders have no website at all.
  res.json({
    ok: false,
    source: null,
    brand: { ...brandGuess.DEFAULTS, ...(logo ? { logoUrl: logo.public_url } : {}) },
    reason: lead.website
      ? (attempts.find((a) => a.reason) || {}).reason || 'Nothing could be read from that website.'
      : 'No website on this lead, and no logo uploaded — these are 50.\u2019s own colours, to change.',
    attempts,
  });
}));

// ---------------------------------------------------------------------------
// Money — the 50. admin only
// ---------------------------------------------------------------------------
router.get('/rep-money/overview', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const month = monthParam(req.query.month, await currentMonth(client));
    const { rows } = await client.query(
      `with mo as (
         select ($1 || '-01')::date as first_day,
                (($1 || '-01')::date::timestamp at time zone '${BILLING_TIME_ZONE}') as start_ts,
                ((($1 || '-01')::date + interval '1 month')::timestamp at time zone '${BILLING_TIME_ZONE}') as end_ts)
       select r.id, r.name, r.active,
              coalesce((select sum(e.amount_cents) from rep_earnings e where e.rep_id = r.id), 0)::int
                - coalesce((select sum(p.amount_cents) from rep_payouts p where p.rep_id = r.id), 0)::int as owed_cents,
              coalesce((select sum(e.amount_cents) from rep_earnings e, mo w where e.rep_id = r.id and e.kind = 'activation' and e.earned_at >= w.start_ts and e.earned_at < w.end_ts), 0)::int as activation_cents,
              coalesce((select sum(e.amount_cents) from rep_earnings e, mo w where e.rep_id = r.id and e.kind = 'referral' and e.earned_at >= w.start_ts and e.earned_at < w.end_ts), 0)::int as royalty_cents,
              coalesce((select sum(e.amount_cents) from rep_earnings e, mo w where e.rep_id = r.id and e.kind = 'reversal' and e.earned_at >= w.start_ts and e.earned_at < w.end_ts), 0)::int as reversal_cents,
              coalesce((select sum(p.amount_cents) from rep_payouts p, mo w where p.rep_id = r.id and p.paid_on >= w.first_day and p.paid_on < (w.first_day + interval '1 month')), 0)::int as paid_cents
       from reps r
       order by r.active desc, lower(r.name)`,
      [month]
    );
    const reps = rows.map((r) => ({ ...r, earned_cents: r.activation_cents + r.royalty_cents + r.reversal_cents }));
    const total = (key) => reps.reduce((s, r) => s + r[key], 0);
    return {
      month,
      reps,
      totals: { owed_cents: total('owed_cents'), earned_cents: total('earned_cents'), paid_cents: total('paid_cents') },
    };
  });
  res.json(out);
}));

// Joseph can open any rep's statement; a rep can open their own and no other.
router.get('/reps/:id/statement', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const out = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    if (!ctx.is_admin && ctx.rep_id !== id) {
      throw httpError(403, 'You can only open your own statement', 'own_statement_only');
    }
    const month = monthParam(req.query.month, await currentMonth(client));
    const { rows: [rep] } = await client.query('select id, name, email, phone from reps where id = $1', [id]);
    if (!rep) throw httpError(404, 'No such rep');
    const win = `($2 || '-01')::date`;
    const { rows: [bal] } = await client.query(
      `select
         (coalesce((select sum(amount_cents) from rep_earnings where rep_id = $1 and earned_at < (${win}::timestamp at time zone '${BILLING_TIME_ZONE}')), 0)
          - coalesce((select sum(amount_cents) from rep_payouts where rep_id = $1 and paid_on < ${win}), 0))::int as opening_cents,
         (coalesce((select sum(amount_cents) from rep_earnings where rep_id = $1 and earned_at < ((${win} + interval '1 month')::timestamp at time zone '${BILLING_TIME_ZONE}')), 0)
          - coalesce((select sum(amount_cents) from rep_payouts where rep_id = $1 and paid_on < (${win} + interval '1 month')), 0))::int as closing_cents`,
      [id, month]
    );
    const { rows: lines } = await client.query(
      `select e.id, e.earned_at, e.role, e.kind, e.amount_cents, e.detail, e.reverses_earning_id, d.name as dealer_name
       from rep_earnings e
       left join rep_dealer_list(true) d on d.tenant_id = e.tenant_id
       where e.rep_id = $1
         and e.earned_at >= (${win}::timestamp at time zone '${BILLING_TIME_ZONE}')
         and e.earned_at < ((${win} + interval '1 month')::timestamp at time zone '${BILLING_TIME_ZONE}')
       order by e.earned_at, e.id`,
      [id, month]
    );
    const { rows: payouts } = await client.query(
      `select id, amount_cents, paid_on, method, note from rep_payouts
       where rep_id = $1 and paid_on >= ${win} and paid_on < (${win} + interval '1 month') order by paid_on, created_at`,
      [id, month]
    );
    const sum = (kind) => lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amount_cents, 0);
    return {
      month,
      rep,
      opening_cents: bal.opening_cents,
      activation_cents: sum('activation'),
      royalty_cents: sum('referral'),
      reversal_cents: sum('reversal'),
      earned_cents: lines.reduce((s, l) => s + l.amount_cents, 0),
      paid_cents: payouts.reduce((s, p) => s + p.amount_cents, 0),
      closing_cents: bal.closing_cents,
      lines: lines.map((l) => ({
        id: l.id, at: l.earned_at, dealer: l.dealer_name, role: l.role, kind: l.kind, amount_cents: l.amount_cents,
        reversal_of: l.reverses_earning_id, detail: l.detail,
      })),
      payouts,
    };
  });
  res.json(out);
}));

const payoutBody = z.object({
  amount_cents: z.number().int().min(1).max(100000000),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  method: optText(60),
  note: optText(500),
});

router.post('/reps/:id/payouts', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(payoutBody, req.body || {});
  const payout = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [p] } = await client.query(
      `insert into rep_payouts (rep_id, amount_cents, paid_on, period, method, note)
       values ($1, $2, coalesce($3::date, current_date), $4, $5, $6)
       returning id, rep_id, amount_cents, paid_on, period, method, note`,
      [id, body.amount_cents, body.paid_on || null, body.period || null, body.method || null, body.note || null]
    );
    return p;
  });
  res.status(201).json(payout);
}));

router.delete('/rep-payouts/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const result = await client.query('delete from rep_payouts where id = $1', [id]);
    if (!result.rowCount) throw httpError(404, 'No such payout');
  });
  res.json({ ok: true });
}));

router.post('/rep-earnings/:id/reverse', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(z.object({ note: optText(500) }), req.body || {});
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    await client.query('select reverse_rep_earning($1, $2)', [id, body.note || null]);
  });
  res.json({ ok: true });
}));

// The closer's rates and the onboarder's, side by side. The onboarder's are 0
// out of the box (the closer earns everything); setting them above 0 starts
// paying an onboarder again, with no code change.
const settingsBody = z.object({
  activation_cents: money,
  referral_cents: money,
  referral_cents_after_threshold: money,
  onboarder_activation_cents: money,
  onboarder_referral_cents: money,
  onboarder_referral_cents_after_threshold: money,
  threshold_companies: z.number().int().min(1).max(10000000),
  full_rate_card_cents: z.number().int().min(1).max(100000000),
}).partial();

const SETTINGS_COLUMNS = `activation_cents, referral_cents, referral_cents_after_threshold,
  onboarder_activation_cents, onboarder_referral_cents, onboarder_referral_cents_after_threshold,
  threshold_companies, full_rate_card_cents`;

router.get('/rep-settings', requireAuth, wrap(async (req, res) => {
  const row = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [s] } = await client.query(`select ${SETTINGS_COLUMNS} from rep_settings`);
    return s;
  });
  res.json(row);
}));

router.put('/rep-settings', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(settingsBody, req.body || {});
  const row = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const keys = Object.keys(body);
    if (!keys.length) throw httpError(400, 'Nothing to change');
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const { rows: [s] } = await client.query(
      `update rep_settings set ${sets.join(', ')}, updated_at = now() returning ${SETTINGS_COLUMNS}`,
      keys.map((k) => body[k])
    );
    return s;
  });
  res.json(row);
}));

// ---------------------------------------------------------------------------
// The build queue — the 50. admin only
// ---------------------------------------------------------------------------
// Every won lead that does not have a dealer yet. This is the list Joseph
// works from, and the one thing standing between what a rep typed and what a
// dealer's customers see.
router.get('/rep-builds', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows } = await client.query(
      `select ${LEAD_COLUMNS},
              (select name from reps where id = l.closed_by_rep_id) as closed_by_name,
              (select count(*)::int from rep_lead_files f where f.lead_id = l.id) as file_count
       from rep_leads l
       where l.build_status = 'awaiting_approval'
       order by l.closed_on, l.created_at`
    );
    return rows;
  });
  res.json({ builds: out });
}));

// A slug is the dealer's address on the platform, so it has to be unique and
// URL-safe. Derived from the company name, then made unique by the database
// rather than by guessing — two "Smith Construction"s are not far-fetched.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'dealer';
}

// The slug the DATABASE will uniquify (see approve_lead_build): this only
// turns a company name into a legal base. It is not checked for collisions
// here on purpose — this runs as the signed-in user, and RLS hides every
// tenant but their own, so the answer would always be "free".

const brandBody = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  primaryDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().max(600).optional(),
  contactEmail: z.string().email().max(200).optional(),
  builderUrl: z.string().url().max(600).optional(),
}).strict();

const buildBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,48}$/).optional(),
  brand: brandBody.optional(),
  // Last chance to fix the wording before their first customer reads it. What
  // the build screen sends is what the rep collected, with whatever Joseph
  // changed; anything still blank is filled from the generic wording below.
  copy: copyBody.optional(),
  // The one price that varies per dealer: the gift card. $500 and 30% never do.
  reward_amount_cents: z.number().int().min(500).max(50000).optional(),
  admin_name: z.string().trim().min(1).max(120).optional(),
  admin_email: z.string().email().max(200).optional(),
});

// Approving. Creates the dealer, gives their admin a login with no password,
// and emails them a link to choose one — plus a note to the rep that it is
// live. The database work is one transaction; the emails are best effort
// afterwards, and a failed email is reported rather than hidden, because the
// account exists either way and resending is the fix.
router.post('/rep-leads/:id/build', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(buildBody, req.body || {});
  if (!supabaseAdmin.isConfigured()) {
    throw httpError(503, 'This platform cannot create logins yet: SUPABASE_SERVICE_ROLE_KEY is not set on the API service.', 'logins_not_configured');
  }

  // 1. Everything the database can check, before anything is created anywhere.
  const plan = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [lead] } = await client.query(
      `select ${LEAD_COLUMNS}, (select name from reps where id = l.closed_by_rep_id) as closed_by_name,
              (select email from reps where id = l.closed_by_rep_id) as closed_by_email
       from rep_leads l where l.id = $1`,
      [id]
    );
    if (!lead) throw httpError(404, 'No such lead');
    if (lead.status !== 'won') throw httpError(409, 'Mark the lead won first');
    if (lead.build_status === 'built') throw httpError(409, 'That lead already has a 50. account');

    const adminEmail = (body.admin_email || lead.email || '').trim().toLowerCase();
    if (!adminEmail) throw httpError(400, 'This lead has no email address, so there is nobody to give the account to. Add one first.');

    const name = (body.name || lead.company_name).trim();
    const slug = body.slug || slugify(name);
    return {
      lead,
      name,
      slug,
      adminEmail,
      adminName: (body.admin_name || lead.contact_name || name).trim(),
      // branding.copy is where every public page and the invite email read
      // their sentences from, so the wording rides along inside brand rather
      // than needing its own argument through approve_lead_build. Every key is
      // always set: a new dealer must never fall through to the shed wording
      // that tenant-branding.js still defaults to for the older tenants.
      brand: {
        ...(body.brand || lead.brand || {}),
        copy: tenantCopy.copyForNewTenant(body.copy !== undefined ? body.copy : lead.copy),
      },
      rewardCents: body.reward_amount_cents != null ? body.reward_amount_cents : lead.reward_amount_cents,
    };
  });

  // 2. The dealer's login, before the tenant: a Supabase failure here must
  //    leave nothing behind, and an account with no tenant is harmless and
  //    reusable, where a tenant with no way in is not.
  let authUserId;
  try {
    ({ userId: authUserId } = await supabaseAdmin.createPasswordlessUser(plan.adminEmail));
  } catch (err) {
    throw httpError(502, `Supabase would not create a login for ${plan.adminEmail}: ${err.message}`);
  }

  // 3. The dealer itself, in one transaction (see approve_lead_build).
  const tenantId = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [r] } = await client.query(
      'select approve_lead_build($1, $2, $3, $4::jsonb, $5) as tenant_id',
      [id, plan.slug, plan.name, JSON.stringify(plan.brand), plan.rewardCents]
    );
    return r.tenant_id;
  });

  // 4. Attach the login to it as that dealer's own admin. Service role: this
  //    writes the row RLS itself consults, so no signed-in role may write it.
  await withServiceRole(async (client) => {
    const { rows: [existing] } = await client.query('select id, tenant_id from users where id = $1', [authUserId]);
    if (existing && existing.tenant_id !== tenantId) {
      throw httpError(409, `${plan.adminEmail} already signs in to another account on this platform. Use a different address for this dealer.`);
    }
    if (!existing) {
      await client.query(
        `insert into users (id, tenant_id, email, name, role) values ($1, $2, $3, $4, 'admin')`,
        [authUserId, tenantId, plan.adminEmail, plan.adminName]
      );
    }
  });

  // 5. Tell them. Best effort, and honest about which part failed.
  const frontend = String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
  const from = process.env.EMAIL_FROM_ADDRESS;
  const replyTo = process.env.BILLING_SUPPORT_EMAIL || 'joseph@referwith50.com';
  const logoUrl = `${frontend}/assets/50-platform-logo.png`;
  const emailed = { dealer: false, rep: false, problems: [] };

  if (!from) {
    emailed.problems.push('EMAIL_FROM_ADDRESS is not set, so nothing could be emailed.');
  } else {
    try {
      const link = await supabaseAdmin.setPasswordLink(plan.adminEmail, `${frontend}/login`);
      const mail = dealerBuildEmails.forDealer({
        contactName: plan.adminName,
        companyName: plan.name,
        link,
        signInUrl: `${frontend}/login`,
        activationFeeCents: 50000,
        rewardAmountCents: plan.rewardCents || 5000,
        repName: plan.lead.closed_by_name,
        logoUrl,
      });
      await sendEmail({ from: `Joseph at 50. <${from}>`, to: plan.adminEmail, replyTo, subject: mail.subject, htmlBody: mail.htmlBody, textBody: mail.textBody });
      emailed.dealer = true;
    } catch (err) {
      emailed.problems.push(`The dealer could not be emailed their link: ${err.message}`);
    }

    if (plan.lead.closed_by_email) {
      try {
        const mail = dealerBuildEmails.forRep({
          repName: plan.lead.closed_by_name,
          companyName: plan.name,
          contactName: plan.adminName,
          contactEmail: plan.adminEmail,
          signInUrl: `${frontend}/reps`,
          activationFeeCents: 50000,
          logoUrl,
        });
        await sendEmail({ from: `Joseph at 50. <${from}>`, to: plan.lead.closed_by_email, replyTo, subject: mail.subject, htmlBody: mail.htmlBody, textBody: mail.textBody });
        emailed.rep = true;
      } catch (err) {
        emailed.problems.push(`The rep could not be told it is live: ${err.message}`);
      }
    }
  }

  res.status(201).json({
    tenant_id: tenantId,
    slug: plan.slug,
    name: plan.name,
    admin_email: plan.adminEmail,
    reward_amount_cents: plan.rewardCents || 5000,
    emailed,
  });
}));

// Taking a won lead out of the queue without building anything. The lead
// stays won: the rep still closed it.
router.post('/rep-leads/:id/decline-build', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const reason = parseOr400(z.object({ reason: optText(500) }), req.body || {}).reason;
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    await client.query('select decline_lead_build($1, $2)', [id, reason || null]);
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Calendar: follow-ups someone set for themselves, plus what already happened
// ---------------------------------------------------------------------------
// A follow-up belongs to a LOGIN, not to a rep row, because current_rep_id()
// is null for Joseph (he is the admin, not a rep) and he asked for a calendar
// of his own. user_id is always taken from the signed-in token here and never
// from the body, so one person cannot file a follow-up on another's calendar
// — the RLS with-check on rep_followups refuses it anyway, this just fails
// earlier and more clearly.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must look like 2026-10-20');
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must look like 09:30');

const followupCreate = z.object({
  due_on: isoDate,
  due_time: clockTime.nullable().optional(),
  title: z.string().trim().min(1).max(200),
  note: optText(2000),
  lead_id: uuid.nullable().optional(),
  tenant_id: uuid.nullable().optional(),
});

// Every field optional: the page uses this one endpoint to reschedule, retitle
// and tick off. `done` is a boolean rather than a timestamp so the caller
// never has to agree with the server about what time it is.
const followupPatch = z.object({
  due_on: isoDate.optional(),
  due_time: clockTime.nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  note: optText(2000),
  done: z.boolean().optional(),
});

// The window the page asks for. Capped at roughly a year so a stray request
// cannot ask the database to assemble every milestone ever recorded.
router.get('/rep-calendar', requireAuth, wrap(async (req, res) => {
  const { from, to } = parseOr400(z.object({ from: isoDate, to: isoDate }), {
    from: req.query.from, to: req.query.to,
  });
  if (to < from) throw httpError(400, 'to must not be before from');
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (span > 400) throw httpError(400, 'Ask for at most about a year at a time');

  const items = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    // ::text on the way out, not because SQL needs it but because JSON does:
    // node-postgres turns a Postgres `date` into a JS Date, which serializes
    // as "2026-10-12T04:00:00.000Z". The page keys its month grid on plain
    // YYYY-MM-DD, so an unconverted date silently matches no day at all.
    const { rows } = await client.query(
      `select kind, on_date::text as on_date, at_time::text as at_time,
              title, detail, followup_id, lead_id, tenant_id, done
         from rep_calendar($1::date, $2::date)`,
      [from, to]
    );
    return rows;
  });
  res.json({ items });
}));

router.post('/rep-followups', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(followupCreate, req.body || {});
  const row = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows: [r] } = await client.query(
      `insert into rep_followups (user_id, due_on, due_time, title, note, lead_id, tenant_id)
       values ($1, $2::date, $3::time, $4, $5, $6, $7)
       returning id, due_on::text as due_on, due_time::text as due_time,
                 title, note, lead_id, tenant_id, done_at`,
      [req.userId, body.due_on, body.due_time || null, body.title,
       body.note || null, body.lead_id || null, body.tenant_id || null]
    );
    return r;
  });
  res.status(201).json({ followup: row });
}));

router.patch('/rep-followups/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(followupPatch, req.body || {});
  if (Object.keys(body).length === 0) throw httpError(400, 'Nothing to change');

  const row = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const sets = [];
    const params = [];
    const set = (frag, value) => { params.push(value); sets.push(`${frag} = $${params.length}`); };
    if (body.due_on !== undefined) set('due_on', body.due_on);
    if (body.due_time !== undefined) set('due_time', body.due_time || null);
    if (body.title !== undefined) set('title', body.title);
    if (body.note !== undefined) set('note', body.note || null);
    // Ticking it off stamps the time here rather than taking one from the
    // browser, whose clock is not ours to trust.
    if (body.done !== undefined) sets.push(`done_at = ${body.done ? 'now()' : 'null'}`);
    params.push(id);

    const { rows, rowCount } = await client.query(
      `update rep_followups set ${sets.join(', ')} where id = $${params.length}
       returning id, due_on::text as due_on, due_time::text as due_time,
                 title, note, lead_id, tenant_id, done_at`,
      params
    );
    // RLS, not a WHERE clause, is what stops someone editing another person's
    // follow-up: it simply is not there to update. A 404 is the honest answer
    // and tells the caller nothing about whether it exists on someone else's
    // calendar. (assertRowsAffected is deliberately not used here — it is for
    // service-role writes, where 0 rows means something is broken.)
    if (rowCount !== 1) throw httpError(404, 'That follow-up does not exist');
    return rows[0];
  });
  res.json({ followup: row });
}));

router.delete('/rep-followups/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rowCount } = await client.query('delete from rep_followups where id = $1', [id]);
    if (rowCount !== 1) throw httpError(404, 'That follow-up does not exist');
  });
  res.json({ ok: true });
}));

module.exports = router;
