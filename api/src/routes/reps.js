const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, withServiceRole, assertRowsAffected, assertServiceRoleConnection, getCallerContext } = require('../db');
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
async function requirePlatform(client, userId, { admin = false, rep = false, money = false, build = false } = {}) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw httpError(403, 'No account found for this user');
  const { rows: [t] } = await client.query('select slug from tenants where id = $1', [ctx.tenant_id]);
  if (!t || t.slug !== '50-platform') throw httpError(403, 'The reps area is only for 50. staff');

  const { rows: [u] } = await client.query('select role from users where id = $1', [userId]);
  const isRep = Boolean(u && u.role === 'rep');
  const { rows: [r] } = await client.query(
    'select current_rep_id() as rep_id, current_agency_rep_id() as agency_rep_id');
  const repId = (r && r.rep_id) || null;
  // Angela and anyone else who sells 50. for an outside company. They work
  // the pipeline like any rep, earn nothing from 50., and build their own
  // dealers. See 20261125000000_agency_reps.
  const isAgency = Boolean(r && r.agency_rep_id);

  // A rep whose rep record was switched off: current_rep_id() goes null, so
  // they would otherwise see an empty page with no explanation.
  if (isRep && !repId) throw httpError(403, 'This rep account has been switched off. Ask Joseph to turn it back on.', 'rep_inactive');
  if (isRep && !rep) throw httpError(403, 'That part of the reps area is not for reps', 'staff_only');
  if (admin && !ctx.is_admin) throw httpError(403, 'Only the 50. admin can see or change rep money', 'admin_only');
  // Money here is 50.'s rep program. An agency rep is paid by their own
  // company on their own terms, so a statement from 50. is not an empty page
  // for them -- it is a wrong one. Refused rather than shown as zeros.
  if (money && isAgency) {
    throw httpError(403, 'You are paid by your own company, so 50. keeps no earnings for you', 'agency_no_money');
  }
  if (build && !ctx.is_admin && !isAgency) {
    throw httpError(403, 'Only the 50. admin or an agency rep can build a dashboard', 'build_not_allowed');
  }
  return { ...ctx, rep_id: repId, is_rep: isRep, is_agency: isAgency, agency_rep_id: (r && r.agency_rep_id) || null };
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
  // 'rep' is on 50.'s own program; 'agency' sells 50. for an outside company
  // on its own contract. The database refuses an agency rep with no company
  // named, so the two always travel together.
  kind: z.enum(['rep', 'agency']).optional(),
  company: optText(160),
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
    // What kind of rep, and who they sell for. The page reads these to decide
    // whether to show My Money (never, for an agency rep) and whether they
    // may build their own dashboards.
    kind: r.kind || 'rep',
    company: r.company || null,
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
      `select r.id, r.name, r.email, r.phone, r.active, r.notes, r.created_at, r.user_id, r.closed_at, r.kind, r.company,
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
      `insert into reps (name, email, phone, notes, kind, company) values ($1, $2, $3, $4, $5, $6)
       returning id, name, email, phone, active, notes, created_at, kind, company`,
      [body.name, body.email || null, body.phone || null, body.notes || null,
       body.kind || 'rep', body.company || null]
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
    for (const key of ['name', 'email', 'phone', 'notes', 'active', 'kind', 'company']) {
      if (body[key] !== undefined) {
        vals.push(body[key] === '' ? null : body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    if (!sets.length) throw httpError(400, 'Nothing to change');
    const { rows: [r] } = await client.query(
      `update reps set ${sets.join(', ')} where id = $1 returning id, name, email, phone, active, notes, created_at, kind, company`,
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
const LEAD_PAGE = 200;
const LEAD_PAGE_MAX = 500;

// Every word has to appear somewhere in the row, in any order, so "silver
// roof" finds Silver Run Home Improvements without the words being adjacent.
// Same rule the page used to apply in the browser -- it just could not see
// past the rows it had been sent.
function leadSearchClauses(q, params) {
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.map((w) => {
    params.push(`%${w}%`);
    return `(l.company_name || ' ' || coalesce(l.contact_name, '') || ' ' ||
             coalesce(l.email, '') || ' ' || coalesce(l.phone, '')) ilike $${params.length}`;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/rep-leads', requireAuth, wrap(async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && !['open', 'won', 'lost'].includes(status)) throw httpError(400, 'status must be open, won or lost');
  // Whose leads. 'none' is its own answer, not a missing one: a lead nobody
  // is credited with is exactly the pile worth finding, and it is what an
  // agency import leaves behind when the rep field is skipped.
  const rep = typeof req.query.rep === 'string' ? req.query.rep.trim() : '';
  if (rep && rep !== 'none' && !UUID_RE.test(rep)) throw httpError(400, 'rep must be a rep id or none');
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || LEAD_PAGE, 1), LEAD_PAGE_MAX);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const rows = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    // Paged, and searched in the database rather than in the browser.
    //
    // This used to send the newest 500 and nothing else, with no offset: the
    // 501st lead could not be reached from the page at all, and the search
    // box filtered only what had already arrived -- so the notice telling
    // people to "search to reach the rest" was advice that could not work.
    // Fine at a few hundred leads. An agency working a bought call list adds
    // 10,000+ a month.
    // Two sets of conditions. The rep tally has to be built WITHOUT the rep
    // filter, or picking a rep would leave the dropdown showing one name and
    // make it impossible to see where everyone else's leads went.
    const params = [];
    const base = [];
    if (status) { params.push(status); base.push(`l.status = $${params.length}`); }
    leadSearchClauses(q, params).forEach((c) => base.push(c));
    const baseSql = base.length ? `where ${base.join(' and ')}` : '';
    const baseParams = params.slice();

    const where = base.slice();
    if (rep === 'none') {
      where.push('l.brought_in_by_rep_id is null');
    } else if (rep) {
      params.push(rep);
      where.push(`l.brought_in_by_rep_id = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';

    // The counts are of everything MATCHING, not of everything there is, so
    // the page can say "81 of 10,412 match" and page through just those.
    const { rows: [counts] } = await client.query(
      `select count(*)::int as total,
              count(*) filter (where l.status = 'open')::int as open
         from rep_leads l ${whereSql}`,
      params
    );
    // How many each rep is carrying, for the "whose leads" dropdown. RLS
    // means a rep sees only their own row here, which is the right answer for
    // them and costs nothing; Joseph sees everyone.
    const { rows: byRep } = await client.query(
      `select l.brought_in_by_rep_id as rep_id, count(*)::int as n
         from rep_leads l ${baseSql}
        group by l.brought_in_by_rep_id`,
      baseParams
    );
    const { rows } = await client.query(
      `select ${LEAD_COLUMNS}, ${LEAD_CAN_DELETE} from rep_leads l ${whereSql}
        order by l.found_on desc, l.created_at desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { rows, counts, byRep };
  });
  res.json({
    leads: rows.rows,
    total: rows.counts.total,
    open_total: rows.counts.open,
    by_rep: rows.byRep.map((r) => ({ rep_id: r.rep_id, count: r.n })),
    limit,
    offset,
    q,
    status: status || '',
    rep,
  });
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
      `update rep_leads set status = 'won', closed_by_rep_id = $2, onboarded_by_rep_id = $3, closed_on = (now() at time zone 'America/New_York')::date, tenant_id = $4
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
// What a dealer pays, after they are already running. Joseph renegotiates,
// or fixes a price he set wrong on the build screen, without a database edit.
//
// Admin only, and checked twice for two different reasons: requirePlatform on
// the signed-in connection is the authorisation, and the service-role write
// below is how it reaches another tenant's row at all -- RLS hides every
// tenant but the caller's own, so this cannot be done as the signed-in user.
// The explicit admin check therefore has to happen before that write, not be
// assumed from it.
const pricingBody = z.object({
  activation_fee_cents: z.number().int().min(0).max(1000000).optional(),
  annual_fee_cents: z.number().int().min(0).max(1000000).optional(),
  reward_amount_cents: z.number().int().min(500).max(50000).optional(),
  // Two things are deliberately missing: charge_card_cost and
  // referral_fee_cents. Both are generated columns now, so neither is
  // accepted here and neither could be written if it were. Who sends the
  // cards sets the first; the gift card below sets the second.
  reward_fulfillment: z.enum(['dealer', 'platform']).optional(),
  // Not a price: how often an invited customer is sent their link again.
  // Nullable because null is "never", and turning it back off has to be
  // expressible rather than merely omitted.
  invite_followup_months: z.union([z.literal(3), z.literal(6), z.literal(9), z.literal(12), z.null()]).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

// ---------------------------------------------------------------------------
// Who holds a dealer's logins.
//
// These are the people who can sign in to that dealer's dashboard AND the
// people the platform emails when a referral is marked paid and the gift
// cards need to go out — routes/referrals.js picks its recipients with
// "where tenant_id = ... and role = 'admin'", read fresh at the time.
//
// Until this existed a dealer had exactly one, created at build time, and
// adding a second meant editing the database by hand. One person on holiday
// meant nobody at that business was told to send a card.
//
// Admin only, and the write runs as the service role because it reaches
// another tenant's rows, which is precisely what RLS forbids. The admin
// check therefore happens first and explicitly — it cannot be inferred from
// the write succeeding.
// ---------------------------------------------------------------------------

async function requireAdminThen(userId, fn) {
  await withUserTransaction(userId, async (client) => {
    await requirePlatform(client, userId, { admin: true });
  });
  return withServiceRole(fn);
}

// Whoever may act on a company that is not their own tenant: Joseph, or the
// rep who is on that company right now. Branding, wording and logins go
// through this; prices do NOT, and stay on requireAdminThen above.
//
// Ben signed companies and then could do nothing for them -- every "my logo
// is wrong" came back to Joseph, who is the bottleneck this platform exists
// to remove. A rep's pay depends on the companies they close, though, so a
// rep who could discount would be a rep who could discount their way to a
// close. Hence the split.
//
// The test itself is rep_manages_tenant() in the database rather than a join
// written out here, so everything asking the question gets one answer from
// one place. The work still runs as the service role, because a rep is not
// in the company's tenant and RLS would hide every row of it.
async function requireManagesThen(userId, tenantId, fn) {
  await withUserTransaction(userId, async (client) => {
    await requirePlatform(client, userId, { rep: true });
    const { rows: [row] } = await client.query('select rep_manages_tenant($1) as ok', [tenantId]);
    if (!row || row.ok !== true) {
      throw httpError(403, 'That company is not one of yours', 'not_your_company');
    }
  });
  return withServiceRole(fn);
}

router.get('/rep-dealers/:tenantId/admins', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const out = await requireManagesThen(req.userId, tenantId, async (client) => {
    const { rows: [t] } = await client.query(
      'select id, name, reward_fulfillment from tenants where id = $1',
      [tenantId]
    );
    if (!t) throw httpError(404, 'No such company');
    const { rows } = await client.query(
      `select id, email, name, gets_reward_alerts, created_at::text as created_at
         from users where tenant_id = $1 and role = 'admin' order by created_at asc, email asc`,
      [tenantId]
    );
    // reward_fulfillment goes with the list because it decides whether any
    // of these ticks mean anything: when 50. sends this dealer's cards, the
    // alert goes to 50. and the page says so rather than offering a choice
    // that would do nothing.
    return { tenant_id: t.id, name: t.name, reward_fulfillment: t.reward_fulfillment, admins: rows };
  });
  res.json(out);
}));

const dealerAdminBody = z.object({
  email: z.string().email().max(200),
  name: z.string().trim().min(1).max(120).optional(),
});

router.post('/rep-dealers/:tenantId/admins', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const body = parseOr400(dealerAdminBody, req.body || {});
  const email = body.email.trim().toLowerCase();

  if (!supabaseAdmin.isConfigured()) {
    throw httpError(503, 'This platform cannot create logins yet: SUPABASE_SERVICE_ROLE_KEY is not set on the API service.', 'logins_not_configured');
  }

  // The company has to exist, and this address must not already sign in
  // somewhere else, BEFORE a Supabase account is made for it. A login with no
  // tenant is harmless and reusable; a half-made one attached to the wrong
  // business is not.
  const tenant = await requireManagesThen(req.userId, tenantId, async (client) => {
    const { rows: [t] } = await client.query('select id, name from tenants where id = $1', [tenantId]);
    if (!t) throw httpError(404, 'No such company');
    const { rows: [clash] } = await client.query(
      'select tenant_id from users where lower(email) = $1', [email]);
    if (clash && clash.tenant_id !== tenantId) {
      throw httpError(409, `${email} already signs in to another account on this platform. Use a different address.`);
    }
    if (clash) throw httpError(409, `${email} already has a login on ${t.name}.`);
    return t;
  });

  let authUserId;
  try {
    ({ userId: authUserId } = await supabaseAdmin.createPasswordlessUser(email));
  } catch (err) {
    throw httpError(502, `Supabase would not create a login for ${email}: ${err.message}`);
  }

  const added = await withServiceRole(async (client) => {
    const { rows: [existing] } = await client.query('select id, tenant_id from users where id = $1', [authUserId]);
    if (existing && existing.tenant_id !== tenantId) {
      throw httpError(409, `${email} already signs in to another account on this platform.`);
    }
    if (existing) return existing;
    const { rows: [row] } = await client.query(
      `insert into users (id, tenant_id, email, name, role) values ($1, $2, $3, $4, 'admin')
       returning id, email, name`,
      [authUserId, tenantId, email, body.name || email.split('@')[0]]
    );
    return row;
  });

  // No password is ever emailed — they choose their own, same as at build.
  const emailed = { sent: false, problem: null };
  const frontend = String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) {
    emailed.problem = 'EMAIL_FROM_ADDRESS is not set, so no link could be sent.';
  } else {
    try {
      const link = await supabaseAdmin.setPasswordLink(email, `${frontend}/login`);
      const mail = dealerBuildEmails.forExtraAdmin({
        contactName: body.name,
        companyName: tenant.name,
        link,
        signInUrl: `${frontend}/login`,
        logoUrl: `${frontend}/assets/50-platform-logo.png`,
      });
      await sendEmail({ from: `Joseph at 50. <${from}>`, to: email, subject: mail.subject, htmlBody: mail.htmlBody, textBody: mail.textBody });
      emailed.sent = true;
    } catch (err) {
      // The login exists either way; saying so beats implying it failed.
      emailed.problem = `The login was created but could not be emailed: ${err.message}`;
    }
  }

  res.status(201).json({ ...added, emailed });
}));

// Send someone who already has a login a fresh set-password link. The reason
// this exists: a dealer admin never received the first email, or the link in
// it expired, and they are locked out with no way back in -- adding them again
// is refused, because they already have a login.
//
// A fresh link also invalidates the earlier one, which is why the email says
// so. No password is ever sent; they choose their own, same as at build.
// Who, at this dealer, is told that gift cards need to go out. Ticking
// nobody is the ordinary state and means the original rule applies:
// addressed to whoever entered the customer, copying every other login.
// Only a 50. platform admin can set this -- requireAdminThen, same as every
// other route on this dialog.
const rewardAlertBody = z.object({ gets_reward_alerts: z.boolean() });

router.patch('/rep-dealers/:tenantId/admins/:userId', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const userId = parseOr400(uuid, req.params.userId);
  const body = parseOr400(rewardAlertBody, req.body || {});
  const out = await requireManagesThen(req.userId, tenantId, async (client) => {
    // Scoped to the tenant in the WHERE clause, not checked beforehand: a
    // login id from another company must miss rather than match.
    const { rows: [row] } = await client.query(
      `update users set gets_reward_alerts = $3
         where id = $1 and tenant_id = $2 and role = 'admin'
       returning id, email, name, gets_reward_alerts`,
      [userId, tenantId, body.gets_reward_alerts]
    );
    if (!row) throw httpError(404, 'No such login on this company');
    return row;
  });
  res.json(out);
}));

router.post('/rep-dealers/:tenantId/admins/:userId/resend', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const userId = parseOr400(uuid, req.params.userId);

  if (!supabaseAdmin.isConfigured()) {
    throw httpError(503, 'This platform cannot send login links yet: SUPABASE_SERVICE_ROLE_KEY is not set on the API service.', 'logins_not_configured');
  }

  const { tenant, person } = await requireManagesThen(req.userId, tenantId, async (client) => {
    const { rows: [t] } = await client.query('select id, name from tenants where id = $1', [tenantId]);
    if (!t) throw httpError(404, 'No such company');
    // Scoped to this company on purpose: a user id alone must not be enough
    // to aim a sign-in link at somebody on a different account.
    const { rows: [u] } = await client.query(
      `select id, email, name from users where id = $1 and tenant_id = $2 and role = 'admin'`,
      [userId, tenantId]
    );
    if (!u) throw httpError(404, 'That person does not have a login here');
    return { tenant: t, person: u };
  });

  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) throw httpError(500, 'EMAIL_FROM_ADDRESS is not set, so no link could be sent.');
  const frontend = String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');

  let link;
  try {
    // Same two steps as the rep invite: an auth account that already exists
    // is the normal case here, not a failure, and both paths end with
    // exactly one fresh link.
    await supabaseAdmin.createPasswordlessUser(person.email);
    link = await supabaseAdmin.setPasswordLink(person.email, `${frontend}/login`);
  } catch (err) {
    throw httpError(502, `Supabase would not mint a sign-in link for ${person.email}: ${err.message}`);
  }

  const mail = dealerBuildEmails.forExtraAdmin({
    contactName: person.name,
    companyName: tenant.name,
    link,
    signInUrl: `${frontend}/login`,
    logoUrl: `${frontend}/assets/50-platform-logo.png`,
    resend: true,
  });
  try {
    await sendEmail({
      from: `Joseph at 50. <${from}>`,
      to: person.email,
      replyTo: process.env.BILLING_SUPPORT_EMAIL || 'joseph@referwith50.com',
      subject: mail.subject,
      htmlBody: mail.htmlBody,
      textBody: mail.textBody,
    });
  } catch (err) {
    // The link was minted, so the OLD one is already dead. Saying "failed"
    // would be worse than useless: it would invite another try that kills
    // this link too, while the person still has nothing that works.
    throw httpError(502, `A fresh link was created but the email would not send: ${err.message}. Any earlier link has already stopped working, so try again or send them the link another way.`);
  }

  res.json({ ok: true, emailed_to: person.email, name: person.name });
}));

router.delete('/rep-dealers/:tenantId/admins/:userId', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const userId = parseOr400(uuid, req.params.userId);
  const out = await requireManagesThen(req.userId, tenantId, async (client) => {
    const { rows } = await client.query(
      `select id, email from users where tenant_id = $1 and role = 'admin'`, [tenantId]);
    if (!rows.some((r) => r.id === userId)) throw httpError(404, 'That person does not have a login here');
    // Never the last one. A dealer with no admin cannot sign in and nobody
    // is told to send their gift cards — the account would go quiet with
    // nothing on screen explaining why.
    if (rows.length <= 1) {
      throw httpError(409, 'That is the only login on this company. Add someone else first, or remove the company instead.');
    }
    const { rows: [gone] } = await client.query(
      `delete from users where id = $1 and tenant_id = $2 returning id, email`, [userId, tenantId]);
    return { removed: gone, left: rows.length - 1 };
  });
  res.json(out);
}));

// Reading one dealer's prices, for the dialog that edits them. Deliberately
// NOT added to rep_dealer_list(): that list is what reps and the helper see,
// and neither is allowed money. A separate admin-only read keeps the figures
// off every surface except Joseph's own.
router.get('/rep-dealers/:tenantId/pricing', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
  });
  const out = await withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `select id, name, billing_required, activation_fee_cents, annual_fee_cents,
              referral_fee_cents, reward_amount_cents, reward_fulfillment, charge_card_cost,
              invite_followup_months
         from tenants where id = $1`, [tenantId]);
    if (!row) throw httpError(404, 'No such company');
    return row;
  });
  res.json(out);
}));

router.patch('/rep-dealers/:tenantId/pricing', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const body = parseOr400(pricingBody, req.body || {});

  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
  });

  const out = await withServiceRole(async (client) => {
    // An in-house company pays nothing by design. Letting a price be set on
    // one would look like it had started being billed.
    const { rows: [t] } = await client.query(
      'select id, name, billing_required from tenants where id = $1', [tenantId]);
    if (!t) throw httpError(404, 'No such company');
    const PRICES = ['activation_fee_cents', 'annual_fee_cents',
                    'reward_amount_cents', 'reward_fulfillment'];

    const sets = [];
    const vals = [tenantId];
    for (const key of [...PRICES, 'invite_followup_months']) {
      if (body[key] !== undefined) {
        vals.push(body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    const { rows: [row] } = await client.query(
      `update tenants set ${sets.join(', ')} where id = $1
       returning id, name, activation_fee_cents, annual_fee_cents, referral_fee_cents,
                 reward_amount_cents, reward_fulfillment, charge_card_cost`,
      vals
    );
    return row;
  });

  res.json(out);
}));

// ---------------------------------------------------------------------------
// A company's own look: name, logo, colors, wording.
//
// Until now this was set once, when a lead was approved, and could never be
// changed again. There was no screen for it and no route behind one, so a
// dealer whose logo came through wrong -- or who rebranded, or who was built
// before brandGuess could read their site -- stayed wrong, and the only fix
// was a hand-written UPDATE in the SQL editor.
//
// That is what put a broken image on a live customer-facing page: a dealer
// with no logoUrl falls back to DEFAULT.logoUrl in tenant-branding.js, and
// nobody could see or correct the empty value.
//
// branding is already jsonb with a check that it is an object, so none of
// this needs a migration. Keys are merged, not replaced: a PATCH that sends
// only logoUrl must not wipe the colors and copy set at build time.
const BRAND_COLORS = ['primaryColor', 'primaryDark', 'secondary', 'accentColor', 'accentDark', 'bg', 'taglineColor'];
const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'Use a hex color like #C9974B');

// An https URL or a root-relative path. http is refused: email clients block
// or flag a mixed-content image, and every page that reads this is https.
const logoUrlSchema = z.union([
  z.string().trim().regex(/^https:\/\/[^\s"'<>]+$/i, 'A logo URL must start with https://'),
  z.string().trim().regex(/^\/[^\s"'<>]*$/, 'A relative logo path must start with /'),
  z.null(),
]);

const dealerBrandBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  logoUrl: logoUrlSchema.optional(),
  tagline: z.string().trim().max(80).nullable().optional(),
  contactEmail: z.string().trim().email().max(200).nullable().optional(),
  websiteUrl: z.string().trim().url().max(300).nullable().optional(),
  ...Object.fromEntries(BRAND_COLORS.map((k) => [k, hexColor.nullable().optional()])),
  copy: z.record(z.string().max(600)).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

router.get('/rep-dealers/:tenantId/brand', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows: [ok] } = await client.query('select rep_manages_tenant($1) as ok', [tenantId]);
    if (!ok || ok.ok !== true) throw httpError(403, 'That company is not one of yours', 'not_your_company');
  });
  const out = await withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      'select id, name, slug, branding from tenants where id = $1', [tenantId]);
    if (!row) throw httpError(404, 'No such company');

    // Logos already uploaded against the lead this company was built from.
    // Almost always where the right file already is -- it was uploaded during
    // onboarding and then never carried onto the tenant -- so offering it
    // saves finding and re-uploading the same image.
    const { rows: files } = await client.query(
      `select f.public_url, f.filename, f.created_at
         from rep_lead_files f
         join rep_leads l on l.id = f.lead_id
        where l.tenant_id = $1 and f.kind = 'logo'
        order by f.created_at desc
        limit 8`,
      [tenantId]
    );
    // The wording fields, with their labels and help text, so the dialog can
    // render whatever exists rather than carrying its own copy of the list
    // that drifts every time one is added.
    return { ...row, logo_files: files, copy_fields: tenantCopy.COPY_FIELDS };
  });
  res.json(out);
}));

router.patch('/rep-dealers/:tenantId/brand', requireAuth, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const body = parseOr400(dealerBrandBody, req.body || {});

  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows: [ok] } = await client.query('select rep_manages_tenant($1) as ok', [tenantId]);
    if (!ok || ok.ok !== true) throw httpError(403, 'That company is not one of yours', 'not_your_company');
  });

  const out = await withServiceRole(async (client) => {
    const { rows: [t] } = await client.query(
      'select id, name, branding from tenants where id = $1', [tenantId]);
    if (!t) throw httpError(404, 'No such company');

    // Merge rather than replace, and let an explicit null delete a key so a
    // wrong value can be cleared, not only overwritten. `copy` merges one
    // level down for the same reason: changing offerHow must not drop
    // shareTitle.
    const next = { ...(t.branding || {}) };
    for (const [key, value] of Object.entries(body)) {
      if (key === 'name') continue;
      if (key === 'copy') {
        if (value === null) delete next.copy;
        else next.copy = { ...(next.copy || {}), ...value };
        continue;
      }
      if (value === null) delete next[key];
      else next[key] = value;
    }

    const sets = ['branding = $2'];
    const vals = [tenantId, JSON.stringify(next)];
    if (body.name !== undefined) {
      vals.push(body.name);
      sets.push(`name = $${vals.length}`);
    }
    const { rows: [row] } = await client.query(
      `update tenants set ${sets.join(', ')} where id = $1 returning id, name, branding`,
      vals
    );
    return row;
  });

  console.log(`BRAND: ${out.name} (${tenantId}) updated — ${Object.keys(body).join(', ')}`);
  res.json(out);
}));

// The wording fields, for any rep. The build screen used to carry its own
// copy of this list, which is how it ended up offering ten of twenty-six --
// a rep could not set any of the invite email, the landing page voice or the
// gift-card notes, because the page did not know they existed.
//
// Served to reps as well as admins: it is the list of questions to ask a
// business, and it is a rep sitting across from that business.
router.get('/copy-fields', requireAuth, wrap(async (req, res) => {
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
  });
  // Each field carries the wording that runs when the box is left empty.
  // The build screen shows it as the box's placeholder, so a rep can see what
  // a business gets for free before deciding whether it needs changing.
  res.json({
    fields: tenantCopy.COPY_FIELDS.map((f) => ({
      ...f,
      generic: tenantCopy.GENERIC_COPY[f.key] || '',
    })),
  });
}));

router.get('/rep-dealers', requireAuth, wrap(async (req, res) => {
  // Closed companies are left out unless asked for, and the function itself
  // refuses to hand one to a rep however this is called.
  const includeClosed = req.query.closed === '1' || req.query.closed === 'true';
  const { rows, isAdmin } = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    const { rows } = await client.query('select * from rep_dealer_list($1)', [includeClosed]);
    return { rows, isAdmin: !!ctx.is_admin };
  });

  // Activity per company, for the one question the Companies tab could not
  // answer: is this dealer still working the program, or did it go quiet?
  // Everything here was already being collected and shown nowhere, so
  // answering it needed no new data -- only a read.
  //
  // Under the service role, because referrals and referral_links are scoped
  // to each dealer's own tenant: counting them as Joseph returns his own
  // rows and nothing else. Keyed to the tenant ids rep_dealer_list already
  // decided this caller may see, so this adds no new door -- a rep still
  // only gets their own dealers. The permission check above ran under RLS
  // first.
  const ids = rows.map((d) => d.tenant_id);
  const activity = ids.length ? await withServiceRole(async (sc) => {
    await assertServiceRoleConnection(sc);
    const { rows: a } = await sc.query(
      `select t.id as tenant_id,
              (select max(r.submitted_at) from referrals r where r.tenant_id = t.id) as last_referral_at,
              (select count(*)::int from referrals r where r.tenant_id = t.id) as referrals_total,
              (select count(*)::int from referral_links l
                where l.tenant_id = t.id and l.kind = 'invite') as invites_total,
              t.renewal_due_at,
              (t.stripe_payment_method_id is not null) as has_card,
              -- A company with no logo shows no logo at all on the page its
              -- customers are emailed a link to. The build screen warns about
              -- it, but a warning at the end of a long build is easy to pass,
              -- and after that nothing ever mentioned it again -- which is how
              -- a live dealer's owner came to be the one who noticed.
              coalesce(nullif(t.branding ->> 'logoUrl', ''), null) is not null as has_logo
         from tenants t
        where t.id = any($1::uuid[])`,
      [ids]
    );
    return new Map(a.map((r) => [r.tenant_id, r]));
  }) : new Map();

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
      // Activity: who is still being invited and still referring.
      last_referral_at: (activity.get(d.tenant_id) || {}).last_referral_at || null,
      referrals_total: (activity.get(d.tenant_id) || {}).referrals_total || 0,
      invites_total: (activity.get(d.tenant_id) || {}).invites_total || 0,
      // The renewal date and whether a card is on file decide whether the
      // automatic yearly charge will succeed or fail silently, so they are
      // the admin's alone -- the helper sees no billing state.
      ...(isAdmin ? {
        has_logo: (activity.get(d.tenant_id) || {}).has_logo !== false,
        renewal_due_at: (activity.get(d.tenant_id) || {}).renewal_due_at || null,
        has_card: (activity.get(d.tenant_id) || {}).has_card === true,
      } : {}),
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

// The logo file itself. Same raw-body approach as the lead upload above, and
// the same storage bucket; the difference is that this one writes the public
// URL straight onto the company, because a logo nobody points the branding at
// is a file in a bucket and nothing more.
router.post('/rep-dealers/:tenantId/logo', requireAuth, uploadBody, wrap(async (req, res) => {
  const tenantId = parseOr400(uuid, req.params.tenantId);
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();

  if (!storage.isConfigured()) {
    throw httpError(503, 'This platform cannot store files yet: SUPABASE_SERVICE_ROLE_KEY is not set on the API service.', 'uploads_not_configured');
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'There was nothing in that file');
  if (!storage.extensionFor(contentType)) throw httpError(400, 'Upload a PNG, JPG, WEBP, GIF or SVG');
  if (contentType === 'application/pdf') throw httpError(400, 'A logo has to be an image, not a PDF');

  // Permission and existence first: nothing is stored for a company that is
  // not there or not mine to touch.
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
  });
  await withServiceRole(async (client) => {
    const { rows: [t] } = await client.query('select id from tenants where id = $1', [tenantId]);
    if (!t) throw httpError(404, 'No such company');
  });

  const stored = await storage.upload({ tenantId, bytes: req.body, contentType });

  try {
    const out = await withServiceRole(async (client) => {
      const { rows: [row] } = await client.query(
        `update tenants
            set branding = coalesce(branding, '{}'::jsonb) || jsonb_build_object('logoUrl', $2::text)
          where id = $1
          returning id, name, branding`,
        [tenantId, stored.publicUrl]
      );
      return row;
    });
    res.status(201).json(out);
  } catch (err) {
    // A stored file the branding does not point at is litter nobody will find.
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
    await requirePlatform(client, req.userId, { admin: true, money: true });
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
    const ctx = await requirePlatform(client, req.userId, { rep: true, money: true });
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
    const ctx = await requirePlatform(client, req.userId, { rep: true, build: true });
    // An agency rep builds their own and sees only their own. RLS on
    // rep_leads already limits a rep to their own rows, so this WHERE is the
    // second of the two guards rather than the only one -- and
    // approve_lead_build makes the same check again when they go to build.
    const { rows } = await client.query(
      `select ${LEAD_COLUMNS},
              (select name from reps where id = l.closed_by_rep_id) as closed_by_name,
              (select count(*)::int from rep_lead_files f where f.lead_id = l.id) as file_count
       from rep_leads l
       where l.build_status = 'awaiting_approval'
         and ($1::uuid is null
              or l.closed_by_rep_id = $1 or l.brought_in_by_rep_id = $1)
       order by l.closed_on, l.created_at`,
      [ctx.is_admin ? null : ctx.agency_rep_id]
    );
    return rows;
  });
  res.json({ builds: out });
}));

// ---------------------------------------------------------------------------
// The pipeline board: three columns, in the order the work actually moves
// ---------------------------------------------------------------------------
// A lead does not finish when it is won. It is won, then a dashboard gets
// built, then somebody at that company has to sign in and pay the $500 — and
// weeks can pass in that last gap with the lead sitting in the Won pile
// looking finished. Counting won as the finish line is how a pipeline
// flatters itself, so the board has three columns and the middle one is the
// wait:
//
//   working          open leads, still being sold to
//   not signed up    won, and either no dashboard yet or one nobody has
//                    paid for. From the seller's side this is one wait, so
//                    it is one column; each card says which half it is in.
//   signed on        paid, live, done
//
// Built in ONE query rather than assembled in the page from the leads list
// and the companies list: those are paged and filtered, and a board adding up
// whatever happened to be loaded is a board that quietly undercounts.
//
// Rep-scoped by RLS, like every other read here. Joseph gets everybody's,
// which makes this the whole company's board when he opens it.
// Enough to scroll through and see the shape of a column; past this the
// number in the heading is the useful thing, not the cards.
const CARDS_PER_COLUMN = 60;

router.get('/rep-pipeline', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    // Each lead with the one fact the leads table does not carry: whether the
    // company it became has actually paid. Read through rep_dealer_list so a
    // rep is shown the same companies the Companies tab shows them and no
    // others -- it is the function that already decides that question.
    //
    // CAPPED, and the cap is the point. SmartScale are making ten thousand
    // calls a month; at even a small conversion that is thousands of leads a
    // year, and a board that returns every one of them would send megabytes
    // to a phone to draw cards nobody scrolls to. Each column returns its
    // newest CARDS_PER_COLUMN and its REAL total, counted in the same pass --
    // so the heading says "1,284" while the column shows sixty, rather than
    // the page quietly reporting the number that happened to fit.
    const { rows } = await client.query(
      `with mine as (
         select l.id, l.company_name, l.contact_name, l.email, l.phone, l.website,
                l.found_on, l.closed_on, l.status, l.build_status, l.tenant_id
           from rep_leads l
          where l.status in ('open', 'won')
       ),
       staged as (
         select m.*,
                d.name as company_live_name,
                d.activated_on,
                -- Unknown is treated as not yet signed on rather than as
                -- signed on: the board must never claim money arrived that
                -- it cannot see. A rep may hold a lead whose company
                -- rep_dealer_list does not show them.
                case when m.status = 'open'                            then 'working'
                     when m.tenant_id is not null and d.activated is true then 'signed_on'
                     else 'not_signed_up' end as stage
           from mine m
           left join rep_dealer_list() d on d.tenant_id = m.tenant_id
       ),
       ranked as (
         select s.*,
                row_number() over (
                  partition by s.stage
                  order by coalesce(s.closed_on, s.found_on) desc, s.company_name) as rn,
                count(*) over (partition by s.stage)::int as stage_total
           from staged s
       )
       select * from ranked where rn <= $1 order by stage, rn`,
      [CARDS_PER_COLUMN]
    );

    const card = (r) => ({
      id: r.id,
      company_name: r.company_live_name || r.company_name,
      contact_name: r.contact_name,
      email: r.email,
      phone: r.phone,
      website: r.website,
      found_on: r.found_on,
      closed_on: r.closed_on,
      tenant_id: r.tenant_id,
      build_status: r.build_status,
      activated_on: r.activated_on || null,
    });

    const columns = { working: [], not_signed_up: [], signed_on: [] };
    const totals = { working: 0, not_signed_up: 0, signed_on: 0 };
    for (const r of rows) {
      if (!columns[r.stage]) continue;
      columns[r.stage].push(card(r));
      totals[r.stage] = r.stage_total;
    }

    return {
      // Which half of the middle column each card is in, said once here so
      // the page does not work it out from build_status itself.
      working: columns.working,
      not_signed_up: columns.not_signed_up.map((c) => ({
        ...c,
        waiting_on: c.tenant_id ? 'them' : 'a dashboard',
      })),
      signed_on: columns.signed_on,
      // The real counts, which are what the headings show. A column with
      // more than CARDS_PER_COLUMN in it shows the newest ones and says how
      // many there are -- the leads tab already works this way.
      totals,
      cards_per_column: CARDS_PER_COLUMN,
      is_admin: Boolean(ctx.is_admin),
      // Only someone who may build sees a Build button on the middle column.
      can_build: Boolean(ctx.is_admin || ctx.is_agency),
    };
  });
  res.json(out);
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
  // Every price is per dealer now -- Joseph sets them on the build screen.
  // All optional: anything left out takes the standard amount, so a build
  // where he changes nothing produces a dealer on the usual terms.
  // Ceilings are sanity rails against a slipped decimal point, not policy.
  reward_amount_cents: z.number().int().min(500).max(50000).optional(),
  activation_fee_cents: z.number().int().min(0).max(1000000).optional(),
  annual_fee_cents: z.number().int().min(0).max(1000000).optional(),
  // No "charge them for the cards" and no fee per referral: both are
  // generated. The first follows this column, the second follows the gift
  // card amount.
  reward_fulfillment: z.enum(['dealer', 'platform']).optional(),
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
    const ctx = await requirePlatform(client, req.userId, { rep: true, build: true });
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
      // Whether this build sets its own prices. An agency rep's does not --
      // approve_lead_build ignores them for her whatever is sent -- and the
      // answer says so, so the page is never left quoting a price she did
      // not get. is_admin rather than "not agency": the helper never reaches
      // here at all.
      setsOwnPrices: Boolean(ctx.is_admin),
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
    await requirePlatform(client, req.userId, { rep: true, build: true });
    const { rows: [r] } = await client.query(
      'select approve_lead_build($1, $2, $3, $4::jsonb, $5, $6, $7, $8) as tenant_id',
      [id, plan.slug, plan.name, JSON.stringify(plan.brand), plan.rewardCents,
       body.activation_fee_cents != null ? body.activation_fee_cents : null,
       body.annual_fee_cents != null ? body.annual_fee_cents : null,
       body.reward_fulfillment || null]
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

  // 4b. What this dealer was actually created with. Read back rather than
  //     restated from the request body: approve_lead_build applies its own
  //     fallbacks for anything Joseph left alone, and a second copy of those
  //     defaults here is exactly how the welcome email ends up quoting a
  //     price the dealer is not charged. It hardcoded $500 before this.
  const terms = await withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `select slug, activation_fee_cents, annual_fee_cents, referral_fee_cents,
              reward_amount_cents, reward_fulfillment, charge_card_cost,
              branding->'copy'->>'cardNoun' as card_noun
         from tenants where id = $1`, [tenantId]);
    return row;
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
        activationFeeCents: terms.activation_fee_cents,
        annualFeeCents: terms.annual_fee_cents,
        referralFeeCents: terms.referral_fee_cents,
        chargeCardCost: terms.charge_card_cost,
        rewardFulfillment: terms.reward_fulfillment,
        cardNoun: terms.card_noun,
        rewardAmountCents: terms.reward_amount_cents,
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
          // Read back from the created tenant, like the dealer email above.
          // The commit that fixed the dealer email warned about exactly this
          // and then left the rep's copy hardcoded ten lines below it.
          activationFeeCents: terms.activation_fee_cents,
          logoUrl,
        });
        await sendEmail({ from: `Joseph at 50. <${from}>`, to: plan.lead.closed_by_email, replyTo, subject: mail.subject, htmlBody: mail.htmlBody, textBody: mail.textBody });
        emailed.rep = true;
      } catch (err) {
        emailed.problems.push(`The rep could not be told it is live: ${err.message}`);
      }
    }
  }

  // Everything here is read back from the company that now exists, not
  // restated from the request. Two of these used to be the request's own
  // copy, and both could be wrong in a way nobody would notice:
  //
  //   slug   -- approve_lead_build appends -2 when the address is taken, so
  //             the second "Silver Run Home Improvements" was told its page
  //             was at an address belonging to the first one.
  //   prices -- an agency rep's build takes the standard terms whatever it
  //             sent, so quoting the request back would show her prices the
  //             company is not on.
  res.status(201).json({
    tenant_id: tenantId,
    slug: terms.slug,
    name: plan.name,
    admin_email: plan.adminEmail,
    reward_amount_cents: terms.reward_amount_cents,
    activation_fee_cents: terms.activation_fee_cents,
    annual_fee_cents: terms.annual_fee_cents,
    referral_fee_cents: terms.referral_fee_cents,
    reward_fulfillment: terms.reward_fulfillment,
    // False when the prices above were decided for them rather than by them.
    sets_own_prices: plan.setsOwnPrices,
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

/* ===========================================================================
   Call lists
   ===========================================================================

   A bought or built list of companies to cold-call, worked by an agency.

   Held apart from rep_leads on purpose. A rep_lead is a company somebody has
   decided is worth pursuing: it carries credit, it feeds the pipeline five
   reps work by hand, and winning one pays someone. Ten thousand unqualified
   names a month would bury that.

   The list is imported whole, before anyone picks up the phone, rather than
   typed in as each call is made. That is the difference between being able to
   see what an agency has worked and only being able to see what it happened
   to write down -- a company that is recorded only when someone rings it
   means the ones nobody reached do not exist to count.
   =========================================================================== */

const sheetImport = require('../lib/sheetImport');

// Big enough for a 100,000-row spreadsheet, which is well past what anyone
// should be sending, and small enough that it cannot be used to fill memory.
const SHEET_MAX_BYTES = 25 * 1024 * 1024;
const sheetBody = express.raw({ type: () => true, limit: SHEET_MAX_BYTES });

const columnsParam = z.record(z.string(), z.number().int().min(0).max(500)).optional();

function parseColumnsHeader(raw) {
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw) return undefined;
  try {
    const parsed = columnsParam.parse(JSON.parse(raw));
    return parsed && Object.keys(parsed).length ? parsed : undefined;
  } catch (e) {
    throw httpError(400, 'The column mapping sent with the file could not be read');
  }
}

// Everything about the upload that is not the bytes travels in the query
// string, not in headers. HTTP header values are effectively ASCII: a list
// called "Joseph's Texas list \u2014 November", or a file whose name carries
// an accent, makes the browser refuse to send the request at all. Query
// parameters are percent-encoded and carry any of it safely.
async function readSheetOr400(req) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'No file was uploaded');
  const filename = String(req.query.filename || 'upload.csv').slice(0, 260);
  const columns = parseColumnsHeader(req.query.columns);
  const headerRaw = req.query.has_header;
  const hasHeader = headerRaw === undefined || headerRaw === '' ? undefined : headerRaw === 'true';
  try {
    return { filename, ...(await sheetImport.readCallList(req.body, filename, { columns, hasHeader })) };
  } catch (err) {
    // A corrupt .xlsx, a PDF renamed to .csv, a password-protected workbook.
    // None of those should read as a server fault.
    throw httpError(400, `That file could not be read as a spreadsheet (${err.message})`);
  }
}

// Read the file and show what WOULD be imported. Writes nothing.
//
// The browser keeps the file and sends it again to import, which costs one
// extra upload and saves holding half-imported spreadsheets in the memory of
// a server that may be one of several.
router.post('/call-lists/preview', requireAuth, sheetBody, wrap(async (req, res) => {
  const parsed = await readSheetOr400(req);
  const sample = parsed.entries.slice(0, 20);
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    if (!parsed.entries.length) return { already_leads: 0, already_listed: 0 };
    const names = parsed.entries.map((e) => e.company_name);
    // Counted in one pass over the whole file rather than per row: at 10,000
    // companies a query each would be 10,000 round trips.
    const { rows: [counts] } = await client.query(
      `with incoming as (select unnest($1::text[]) as company_name)
       select count(*) filter (where exists (
                select 1 from rep_leads l
                 where fifty_norm_company(l.company_name) = fifty_norm_company(i.company_name)))::int as already_leads,
              count(*) filter (where exists (
                select 1 from call_list_entries e
                  join call_lists cl on cl.id = e.list_id
                 where cl.archived_at is null
                   and fifty_norm_company(e.company_name) = fifty_norm_company(i.company_name)))::int as already_listed
         from incoming i`,
      [names]
    );
    return counts;
  });
  res.json({
    filename: parsed.filename,
    columns: parsed.columns,
    header_row: parsed.headerRow,
    has_header: parsed.headerRow !== null,
    fields: Object.keys(sheetImport.FIELD_HEADERS),
    total_rows: parsed.totalRows,
    truncated: parsed.truncated,
    would_import: parsed.entries.length,
    skipped: parsed.skipped.slice(0, 50),
    skipped_total: parsed.skipped.length,
    already_leads: out.already_leads,
    already_listed: out.already_listed,
    sample,
  });
}));

router.post('/call-lists', requireAuth, sheetBody, wrap(async (req, res) => {
  const parsed = await readSheetOr400(req);
  if (!parsed.entries.length) throw httpError(400, 'That file has no companies in it');
  const name = String(req.query.name || parsed.filename).slice(0, 200).trim() || parsed.filename;
  const assignTo = req.query.assign_rep || null;

  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [list] } = await client.query(
      `insert into call_lists (name, source_file, assigned_rep_id) values ($1, $2, $3) returning id, name`,
      [name, parsed.filename, assignTo || null]
    );

    // One statement for the whole sheet. The alternative -- a round trip per
    // company -- is ten thousand of them, and a half-finished import if the
    // connection drops in the middle.
    const cols = ['company_name', 'contact_name', 'phone', 'email', 'website', 'city', 'state', 'notes'];
    const arrays = cols.map((c) => parsed.entries.map((e) => e[c]));
    const { rows: inserted } = await client.query(
      `with incoming as (
         select ord, company_name, contact_name, phone, email, website, city, state, notes
           from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
                with ordinality as t(company_name, contact_name, phone, email, website, city, state, notes, ord)
       ),
       keep as (
         select * from incoming i
          where not exists (
                  select 1 from rep_leads l
                   where fifty_norm_company(l.company_name) = fifty_norm_company(i.company_name))
            and not exists (
                  select 1 from call_list_entries e
                    join call_lists cl on cl.id = e.list_id
                   where cl.archived_at is null
                     and fifty_norm_company(e.company_name) = fifty_norm_company(i.company_name))
       )
       insert into call_list_entries
         (list_id, row_no, company_name, contact_name, phone, email, website, city, state, notes)
       select $1, row_number() over (order by k.ord), k.company_name, k.contact_name, k.phone,
              k.email, k.website, k.city, k.state, k.notes
         from keep k
       returning id`,
      [list.id, ...arrays]
    );

    return { list, imported: inserted.length };
  });

  res.status(201).json({
    list: out.list,
    imported: out.imported,
    // Everything the file held that did not become an entry, and why.
    rows_in_file: parsed.totalRows,
    unusable_rows: parsed.skipped.length,
    skipped_as_known: parsed.entries.length - out.imported,
    truncated: parsed.truncated,
  });
}));

router.get('/call-lists', requireAuth, wrap(async (req, res) => {
  const includeArchived = req.query.archived === 'true';
  const rows = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows } = await client.query(
      `select * from call_list_progress
        ${includeArchived ? '' : 'where archived_at is null'}
        order by archived_at nulls first, created_at desc`
    );
    return rows;
  });
  res.json({ lists: rows });
}));

router.patch('/call-lists/:id', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(z.object({
    name: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    assigned_rep_id: z.string().uuid().nullable().optional(),
    archived: z.boolean().optional(),
  }), req.body || {});
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const sets = [];
    const params = [req.params.id];
    const set = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };
    if (body.name !== undefined) set('name', body.name);
    if (body.notes !== undefined) set('notes', body.notes);
    if (body.assigned_rep_id !== undefined) set('assigned_rep_id', body.assigned_rep_id);
    if (body.archived !== undefined) sets.push(`archived_at = ${body.archived ? 'now()' : 'null'}`);
    if (!sets.length) throw httpError(400, 'Nothing to change');
    const { rows } = await client.query(
      `update call_lists set ${sets.join(', ')} where id = $1 returning id`, params);
    if (!rows.length) throw httpError(404, 'That call list no longer exists');
    return rows[0];
  });
  res.json(out);
}));

// Deleting a list keeps any company that already graduated into a lead: the
// lead is the thing with value, and it stands on its own once it exists.
router.delete('/call-lists/:id', requireAuth, wrap(async (req, res) => {
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows } = await client.query('delete from call_lists where id = $1 returning id', [req.params.id]);
    if (!rows.length) throw httpError(404, 'That call list no longer exists');
  });
  res.json({ ok: true });
}));

const ENTRY_COLUMNS = `e.id, e.list_id, e.row_no, e.company_name, e.contact_name, e.phone, e.email,
  e.website, e.city, e.state, e.notes, e.status, e.outcome, e.attempts, e.last_called_at,
  e.next_call_after, e.last_note, e.called_by_rep_id, e.rep_lead_id, e.claimed_by_rep_id, e.claimed_at`;

router.get('/call-lists/:id/entries', requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const status = req.query.status;
  if (status !== undefined && !['waiting', 'done'].includes(status)) throw httpError(400, 'status must be waiting or done');
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';

  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const params = [req.params.id];
    const where = ['e.list_id = $1'];
    if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
    String(q).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6).forEach((w) => {
      params.push(`%${w}%`);
      where.push(`(e.company_name || ' ' || coalesce(e.contact_name, '') || ' ' ||
                   coalesce(e.email, '') || ' ' || coalesce(e.phone, '')) ilike $${params.length}`);
    });
    const whereSql = `where ${where.join(' and ')}`;
    const { rows: [counts] } = await client.query(
      `select count(*)::int as total from call_list_entries e ${whereSql}`, params);
    const { rows } = await client.query(
      `select ${ENTRY_COLUMNS} from call_list_entries e ${whereSql}
        order by e.row_no limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset]);
    return { rows, total: counts.total };
  });
  res.json({ entries: out.rows, total: out.total, limit, offset });
}));

// The next company to ring. Null when the list is worked through for now --
// which is not the same as finished, because callbacks come back round.
router.post('/call-lists/:id/next', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { rep: true });
    const { rows: [claimed] } = await client.query('select claim_next_call($1) as id', [req.params.id]);
    if (!claimed.id) {
      const { rows: [left] } = await client.query(
        `select count(*) filter (where status = 'waiting')::int as waiting,
                min(next_call_after) filter (where status = 'waiting' and next_call_after > now()) as next_due
           from call_list_entries where list_id = $1`, [req.params.id]);
      return { entry: null, waiting: left.waiting, next_due: left.next_due };
    }
    const { rows: [entry] } = await client.query(
      `select ${ENTRY_COLUMNS} from call_list_entries e where e.id = $1`, [claimed.id]);
    return { entry };
  });
  res.json(out);
}));

const OUTCOMES = ['no_answer', 'callback', 'not_interested', 'bad_number', 'interested', 'signed'];
// How long before an entry comes back round, per outcome. A callback carries
// its own time, so it is not in here.
const RETRY_DAYS = { no_answer: 2 };

router.post('/call-list-entries/:id/outcome', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(z.object({
    outcome: z.enum(OUTCOMES),
    note: z.string().trim().max(2000).optional(),
    call_back_at: z.string().datetime({ offset: true }).optional(),
    // Corrections the caller makes while on the phone -- a wrong number, a
    // name the sheet got wrong. Worth keeping: the sheet came from outside.
    contact_name: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    website: z.string().trim().max(300).nullable().optional(),
  }), req.body || {});
  if (body.outcome === 'callback' && !body.call_back_at) {
    throw httpError(400, 'A callback needs the time to call back');
  }

  const out = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    const { rows: [entry] } = await client.query(
      `select ${ENTRY_COLUMNS} from call_list_entries e where e.id = $1 for update`, [req.params.id]);
    if (!entry) throw httpError(404, 'That company is not on a list any more');
    if (entry.status === 'done') throw httpError(409, 'That call has already been recorded');

    const contact = body.contact_name !== undefined ? body.contact_name : entry.contact_name;
    const phone = body.phone !== undefined ? body.phone : entry.phone;
    const email = body.email !== undefined ? body.email : entry.email;
    const website = body.website !== undefined ? body.website : entry.website;

    // A call that went somewhere becomes an ordinary lead, and from then on
    // it lives in the pipeline like any other. Credit goes to whoever made
    // the call, the same rule the rest of the program uses.
    let leadId = null;
    if (body.outcome === 'interested' || body.outcome === 'signed') {
      const { rows: [lead] } = await client.query(
        `insert into rep_leads (company_name, contact_name, phone, email, website, notes, brought_in_by_rep_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [entry.company_name, contact, phone, email, website,
         [entry.notes, body.note].filter(Boolean).join('\n'), ctx.rep_id || null]
      );
      leadId = lead.id;
    }

    // Only 'no answer' and 'callback' leave a company on the list; the rest
    // are a decision, and a decision does not need ringing again.
    const done = body.outcome !== 'no_answer' && body.outcome !== 'callback';
    // Worked out here rather than branching inside the SQL. Building the
    // statement differently per outcome meant that for most outcomes the
    // text never mentioned $5, and Postgres rejects a bind carrying a
    // parameter the statement does not use -- so every outcome but a
    // callback answered 500.
    const nextCallAfter = body.outcome === 'callback'
      ? body.call_back_at
      : body.outcome === 'no_answer'
        ? new Date(Date.now() + RETRY_DAYS.no_answer * 24 * 60 * 60 * 1000).toISOString()
        : null;

    const { rows: [saved] } = await client.query(
      `update call_list_entries
          set status = $2,
              outcome = $3,
              attempts = attempts + 1,
              last_called_at = now(),
              last_note = coalesce($4, last_note),
              next_call_after = $5::timestamptz,
              called_by_rep_id = coalesce($6, called_by_rep_id),
              rep_lead_id = coalesce($7, rep_lead_id),
              contact_name = $8, phone = $9, email = $10, website = $11,
              claimed_by_rep_id = null,
              claimed_at = null
        where id = $1
       returning ${ENTRY_COLUMNS.replace(/e\./g, '')}`,
      [req.params.id, done ? 'done' : 'waiting', body.outcome, body.note || null,
       nextCallAfter, ctx.rep_id || null, leadId,
       contact, phone, email, website]
    );
    return { entry: saved, lead_id: leadId };
  });
  res.json(out);
}));

// Put a company back without recording a call -- the caller got pulled away,
// or opened it by accident. Without this the entry waits out its fifteen
// minutes before anyone else can have it.
router.post('/call-list-entries/:id/release', requireAuth, wrap(async (req, res) => {
  await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    await client.query(
      `update call_list_entries set claimed_by_rep_id = null, claimed_at = null
        where id = $1 and (claimed_by_rep_id = $2 or $3)`,
      [req.params.id, ctx.rep_id || null, !ctx.is_rep]
    );
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Recruits — Joseph's own board of people he is hiring as reps
// (see the recruits migration). Admin only, end to end: RLS gives nobody else
// a row, and these routes refuse the helper and reps with a plain 403.
// ---------------------------------------------------------------------------
const RECRUIT_STAGES = ['applied', 'contacted', 'replied', 'meeting', 'hired', 'not_a_fit'];
const RECRUIT_SOURCES = ['wizehire', 'handshake', 'linkedin', 'referral', 'other'];
const RECRUIT_COLS = `id, name, email, phone, location, source, stage, meeting_at, next_step, notes,
  contacted_at, replied_at, hired_at, stage_changed_at, rep_id, created_at`;

const recruitBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: optText(200),
  phone: optText(50),
  location: optText(120),
  source: z.enum(RECRUIT_SOURCES).optional(),
  stage: z.enum(RECRUIT_STAGES).optional(),
  meeting_at: z.string().datetime({ offset: true }).nullable().optional().or(z.literal('').transform(() => null)),
  next_step: optText(80),
  notes: optText(4000),
});

async function requireRecruitAdmin(client, userId) {
  const ctx = await requirePlatform(client, userId);
  if (!ctx.is_admin) throw httpError(403, 'Recruits are only visible to the 50. admin', 'admin_only');
  return ctx;
}

// The table arrives by a hand-run migration. Until it has been run, say so in
// words instead of a bare 500 — and, unlike the columns in schemaCheck, this
// must not stop the whole API from booting, since nothing else depends on it.
function recruitsMissing(err) {
  if (err && err.code === '42P01') return httpError(503, 'The recruits table has not been added to the database yet (migration 20261118000000_recruits.sql).');
  return err;
}

// First time a card reaches a stage, stamp it. Moving it back never clears a
// stamp, so a week's counts do not shrink when a card is dragged around.
function stageStamps(stage) {
  const order = ['applied', 'contacted', 'replied', 'meeting', 'hired'];
  const at = order.indexOf(stage);
  const sets = [];
  if (at >= 1) sets.push('contacted_at = coalesce(contacted_at, now())');
  if (at >= 2) sets.push('replied_at = coalesce(replied_at, now())');
  if (at >= 4) sets.push('hired_at = coalesce(hired_at, now())');
  return sets;
}

router.get('/recruits', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    await requireRecruitAdmin(client, req.userId);
    try {
      const { rows } = await client.query(`select ${RECRUIT_COLS} from recruits order by stage_changed_at desc`);
      // "This week" is Monday 00:00 Eastern onward, the same week the rep
      // meeting and the daily emails run on.
      const { rows: [w] } = await client.query(
        `with wk as (select (date_trunc('week', now() at time zone '${BILLING_TIME_ZONE}') at time zone '${BILLING_TIME_ZONE}') as start)
         select wk.start as week_start,
                (select count(*)::int from recruits, wk w2 where created_at >= w2.start) as applied,
                (select count(*)::int from recruits, wk w2 where contacted_at >= w2.start) as contacted,
                (select count(*)::int from recruits, wk w2 where replied_at >= w2.start) as replied,
                (select count(*)::int from recruits, wk w2 where meeting_at >= w2.start and meeting_at < w2.start + interval '7 days') as meetings,
                (select count(*)::int from recruits, wk w2 where hired_at >= w2.start) as hired
           from wk`
      );
      return { recruits: rows, week: w };
    } catch (err) { throw recruitsMissing(err); }
  });
  res.json(out);
}));

router.post('/recruits', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(recruitBody, req.body || {});
  const r = await withUserTransaction(req.userId, async (client) => {
    await requireRecruitAdmin(client, req.userId);
    const stage = body.stage || (body.meeting_at ? 'meeting' : 'applied');
    try {
      const { rows: [row] } = await client.query(
        `insert into recruits (name, email, phone, location, source, stage, meeting_at, next_step, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [body.name, body.email || null, body.phone || null, body.location || null, body.source || 'other',
          stage, body.meeting_at || null, body.next_step || null, body.notes || null]
      );
      const stamps = stageStamps(stage);
      if (stamps.length) await client.query(`update recruits set ${stamps.join(', ')} where id = $1`, [row.id]);
      const { rows: [full] } = await client.query(`select ${RECRUIT_COLS} from recruits where id = $1`, [row.id]);
      return full;
    } catch (err) { throw recruitsMissing(err); }
  });
  res.status(201).json(r);
}));

router.patch('/recruits/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(recruitBody.partial(), req.body || {});
  const r = await withUserTransaction(req.userId, async (client) => {
    await requireRecruitAdmin(client, req.userId);
    const sets = [];
    const vals = [id];
    for (const key of ['name', 'email', 'phone', 'location', 'source', 'meeting_at', 'next_step', 'notes']) {
      if (body[key] !== undefined) {
        vals.push(body[key] === '' ? null : body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    if (body.stage) {
      vals.push(body.stage);
      sets.push(`stage = $${vals.length}`);
      sets.push(`stage_changed_at = case when stage is distinct from $${vals.length} then now() else stage_changed_at end`);
      sets.push(...stageStamps(body.stage));
    }
    if (!sets.length) throw httpError(400, 'Nothing to change');
    try {
      const { rows: [row] } = await client.query(
        `update recruits set ${sets.join(', ')} where id = $1 returning ${RECRUIT_COLS}`, vals
      );
      if (!row) throw httpError(404, 'No such recruit');
      return row;
    } catch (err) { throw recruitsMissing(err); }
  });
  res.json(r);
}));

router.delete('/recruits/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  await withUserTransaction(req.userId, async (client) => {
    await requireRecruitAdmin(client, req.userId);
    try {
      const { rowCount } = await client.query('delete from recruits where id = $1', [id]);
      if (!rowCount) throw httpError(404, 'No such recruit');
    } catch (err) { throw recruitsMissing(err); }
  });
  res.json({ ok: true });
}));

// Signing a recruit on: makes them an ordinary rep (no login yet — that is
// still the Invite button on the Reps tab, where it always was) and moves the
// card to Hired. Running it twice hands back the same rep, never a second one.
router.post('/recruits/:id/make-rep', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const out = await withUserTransaction(req.userId, async (client) => {
    await requireRecruitAdmin(client, req.userId);
    try {
      const { rows: [rc] } = await client.query(`select ${RECRUIT_COLS} from recruits where id = $1 for update`, [id]);
      if (!rc) throw httpError(404, 'No such recruit');
      let repId = rc.rep_id;
      if (!repId) {
        const { rows: [rep] } = await client.query(
          `insert into reps (name, email, phone, notes) values ($1, $2, $3, $4) returning id`,
          [rc.name, rc.email, rc.phone, rc.source !== 'other' ? `Recruited via ${rc.source}` : null]
        );
        repId = rep.id;
      }
      const { rows: [row] } = await client.query(
        `update recruits set rep_id = $2, stage = 'hired',
                stage_changed_at = case when stage <> 'hired' then now() else stage_changed_at end,
                ${stageStamps('hired').join(', ')}
          where id = $1 returning ${RECRUIT_COLS}`,
        [id, repId]
      );
      return row;
    } catch (err) { throw recruitsMissing(err); }
  });
  res.json(out);
}));

module.exports = router;
