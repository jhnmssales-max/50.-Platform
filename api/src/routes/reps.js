const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');

// The sales-rep program (see the rep_program migration and workers/repEarnings.js).
//
// Who may call what — the database enforces all of this on its own through
// RLS (every query here runs as the signed-in user); the checks below only
// turn a refusal into a clear 403 instead of an empty result:
//   - Staff of the 50. tenant itself (slug 50-platform) manage reps, leads and
//     which rep is on which dealer. No other tenant's login gets past
//     requirePlatformStaff, and RLS gives them no rows anyway.
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

async function requirePlatform(client, userId, { admin = false } = {}) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw httpError(403, 'No staff account found for this user');
  const { rows: [t] } = await client.query('select slug from tenants where id = $1', [ctx.tenant_id]);
  if (!t || t.slug !== '50-platform') throw httpError(403, 'The reps area is only for 50. staff');
  if (admin && !ctx.is_admin) throw httpError(403, 'Only the 50. admin can see or change rep money', 'admin_only');
  return ctx;
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
    leads_brought_in: r.leads_brought_in,
    companies_closed: r.companies_closed,
    companies_onboarded: r.companies_onboarded,
  };
}

router.get('/reps', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId);
    const { rows } = await client.query(
      `select r.id, r.name, r.email, r.phone, r.active, r.notes, r.created_at,
              (select count(*)::int from rep_leads l where l.brought_in_by_rep_id = r.id) as leads_brought_in,
              (select count(*)::int from rep_assignments a where a.closer_rep_id = r.id and a.effective_to is null) as companies_closed,
              (select count(*)::int from rep_assignments a where a.onboarder_rep_id = r.id and a.effective_to is null) as companies_onboarded
       from reps r
       order by r.active desc, lower(r.name)`
    );
    const reps = rows.map(repRow);
    if (!ctx.is_admin) return { reps };

    const month = await currentMonth(client);
    const { rows: money } = await client.query(
      `select r.id,
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
      reps: reps.map((r) => ({ ...r, owed_cents: byId[r.id].owed_cents, earned_this_month_cents: byId[r.id].earned_this_month_cents })),
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

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
const leadFields = {
  company_name: z.string().trim().min(1).max(200),
  contact_name: optText(120),
  phone: optText(50),
  email: optText(200),
  brought_in_by_rep_id: uuid.nullable().optional(),
  found_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};
const leadCreate = z.object({ ...leadFields, confirm_duplicate: z.boolean().optional() });
const leadPatch = z.object({ ...leadFields, status: z.enum(['open', 'lost']).optional() }).partial();

const LEAD_COLUMNS = `l.id, l.company_name, l.contact_name, l.phone, l.email, l.brought_in_by_rep_id, l.found_on, l.status,
  l.closed_by_rep_id, l.onboarded_by_rep_id, l.closed_on, l.tenant_id, l.created_at`;

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

router.get('/rep-leads', requireAuth, wrap(async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && !['open', 'closed', 'lost'].includes(status)) throw httpError(400, 'status must be open, closed or lost');
  const rows = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    const { rows } = await client.query(
      `select ${LEAD_COLUMNS} from rep_leads l ${status ? 'where l.status = $1' : ''} order by l.found_on desc, l.created_at desc limit 500`,
      status ? [status] : []
    );
    return rows;
  });
  res.json({ leads: rows });
}));

// Leads that look like the same company: the same name (ignoring case and
// spacing), the same phone digits, or the same email.
async function findDuplicateLeads(client, { company_name, phone, email }, excludeId) {
  const { rows } = await client.query(
    `select ${LEAD_COLUMNS}
     from rep_leads l
     where ($4::uuid is null or l.id <> $4::uuid)
       and (
         regexp_replace(lower(l.company_name), '\\s+', '', 'g') = regexp_replace(lower($1), '\\s+', '', 'g')
         or ($2 <> '' and length($2) >= 7 and regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g') = $2)
         or ($3 <> '' and lower(l.email) = $3)
       )
     order by l.created_at limit 10`,
    [company_name, digits(phone), String(email || '').trim().toLowerCase(), excludeId || null]
  );
  return rows;
}

router.post('/rep-leads', requireAuth, wrap(async (req, res) => {
  const body = parseOr400(leadCreate, req.body || {});
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    if (!body.confirm_duplicate) {
      const dupes = await findDuplicateLeads(client, body);
      if (dupes.length) {
        const err = httpError(409, 'This looks like a lead that is already in the list. Check it, then add it anyway if it is a different company.', 'possible_duplicate');
        err.matches = dupes;
        throw err;
      }
    }
    const { rows: [lead] } = await client.query(
      `insert into rep_leads (company_name, contact_name, phone, email, brought_in_by_rep_id, found_on)
       values ($1, $2, $3, $4, $5, coalesce($6::date, current_date))
       returning ${LEAD_COLUMNS.replace(/l\./g, '')}`,
      [body.company_name, body.contact_name || null, body.phone || null, body.email || null, body.brought_in_by_rep_id || null, body.found_on || null]
    );
    return lead;
  });
  res.status(201).json(out);
}));

router.patch('/rep-leads/:id', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(leadPatch, req.body || {});
  const lead = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    const sets = [];
    const vals = [id];
    for (const key of ['company_name', 'contact_name', 'phone', 'email', 'brought_in_by_rep_id', 'found_on', 'status']) {
      if (body[key] !== undefined) {
        vals.push(body[key] === '' ? null : body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    if (!sets.length) throw httpError(400, 'Nothing to change');
    // A closed lead stays closed: closing is the one step that assigns reps
    // to a dealer, and undoing it is a reassignment, not a status flip.
    const { rows: [cur] } = await client.query('select status from rep_leads where id = $1', [id]);
    if (!cur) throw httpError(404, 'No such lead');
    if (cur.status === 'closed' && body.status !== undefined) throw httpError(409, 'This lead is already closed');
    const { rows: [l] } = await client.query(`update rep_leads set ${sets.join(', ')} where id = $1 returning ${LEAD_COLUMNS.replace(/l\./g, '')}`, vals);
    return l;
  });
  res.json(lead);
}));

const closeBody = z.object({
  closed_by_rep_id: uuid,
  onboarded_by_rep_id: uuid.nullable().optional(),
  tenant_id: uuid.nullable().optional(),
  effective_from: z.string().datetime({ offset: true }).optional(),
});

// Closing a lead: whoever closed it gets the sign-up credit. When the signed
// company is already a 50. dealer (tenant_id), the closer and onboarder are
// put on it in the same step — that assignment is what earns money.
router.post('/rep-leads/:id/close', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const body = parseOr400(closeBody, req.body || {});
  const lead = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    const { rows: [cur] } = await client.query('select status from rep_leads where id = $1 for update', [id]);
    if (!cur) throw httpError(404, 'No such lead');
    if (cur.status === 'closed') throw httpError(409, 'This lead is already closed');
    if (body.tenant_id) {
      await client.query('select assign_rep($1, $2, $3, $4)', [
        body.tenant_id, body.closed_by_rep_id, body.onboarded_by_rep_id || null, body.effective_from || null,
      ]);
    } else if (body.effective_from) {
      throw httpError(400, 'effective_from only applies together with a dealer (tenant_id)');
    }
    const { rows: [l] } = await client.query(
      `update rep_leads set status = 'closed', closed_by_rep_id = $2, onboarded_by_rep_id = $3, closed_on = current_date, tenant_id = $4
       where id = $1 returning ${LEAD_COLUMNS.replace(/l\./g, '')}`,
      [id, body.closed_by_rep_id, body.onboarded_by_rep_id || null, body.tenant_id || null]
    );
    return l;
  });
  res.json(lead);
}));

// ---------------------------------------------------------------------------
// Dealers and who is on them
// ---------------------------------------------------------------------------
router.get('/rep-dealers', requireAuth, wrap(async (req, res) => {
  const rows = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId);
    const { rows } = await client.query('select * from rep_dealer_list()');
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
    })),
  });
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

router.get('/reps/:id/statement', requireAuth, wrap(async (req, res) => {
  const id = parseOr400(uuid, req.params.id);
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
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
       left join rep_dealer_list() d on d.tenant_id = e.tenant_id
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

const settingsBody = z.object({
  activation_cents: money,
  referral_cents: money,
  referral_cents_after_threshold: money,
  threshold_companies: z.number().int().min(1).max(10000000),
  full_rate_card_cents: z.number().int().min(1).max(100000000),
}).partial();

const SETTINGS_COLUMNS = 'activation_cents, referral_cents, referral_cents_after_threshold, threshold_companies, full_rate_card_cents';

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

module.exports = router;
