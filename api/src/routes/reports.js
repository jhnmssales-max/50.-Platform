// Reports: what each rep has done, and what the platform makes and spends.
//
// Everything here is READ-ONLY arithmetic over rows that already exist —
// leads, assignments, billing_events, rep_earnings — plus the two things that
// cannot be derived and so have tables of their own (platform_expenses, and
// the lost-lead tally; see the reports migration).
//
// Who may see what, same rule as everywhere else in this area:
//   - A rep may open their OWN report. It is their sales record, and showing
//     it to them is most of the point.
//   - The company report — revenue, costs, profit — is the 50. admin's alone.
//     Not the helper's, not a rep's.
//
// Every figure is traceable to rows: nothing is modelled, projected or
// smoothed. Where a number is an estimate rather than a receipt — card
// processing is the only one — it is returned under a name that says so.
const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, withServiceRole, assertServiceRoleConnection, getCallerContext } = require('../db');

const router = express.Router();
router.use(cors());

const BILLING_TIME_ZONE = 'America/New_York';

function httpError(status, message, publicCode) {
  const err = new Error(message);
  err.status = status;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

async function requirePlatform(client, userId, { admin = false, rep = false } = {}) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw httpError(403, 'No account found for this user');
  const { rows: [t] } = await client.query('select slug from tenants where id = $1', [ctx.tenant_id]);
  if (!t || t.slug !== '50-platform') throw httpError(403, 'Reports are only for 50. staff');
  const { rows: [u] } = await client.query('select role from users where id = $1', [userId]);
  const isRep = Boolean(u && u.role === 'rep');
  const { rows: [r] } = await client.query('select current_rep_id() as rep_id');
  const repId = (r && r.rep_id) || null;
  if (isRep && !repId) throw httpError(403, 'This rep account has been switched off.', 'rep_inactive');
  if (isRep && !rep) throw httpError(403, 'That report is not for reps', 'staff_only');
  if (admin && !ctx.is_admin) throw httpError(403, 'Only the 50. admin can see the company report', 'admin_only');
  return { ...ctx, rep_id: repId, is_rep: isRep };
}

function wrap(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (err) { next(err); }
  };
}

function yearParam(value, fallback) {
  const y = String(value || fallback);
  if (!/^\d{4}$/.test(y) || Number(y) < 2020 || Number(y) > 2100) throw httpError(400, 'year must look like 2026');
  return Number(y);
}

async function currentYear(client) {
  const { rows: [r] } = await client.query(`select to_char(now() at time zone '${BILLING_TIME_ZONE}', 'YYYY') as y`);
  return Number(r.y);
}

// Twelve months of a year, always all twelve, in order. A chart with holes in
// it where a quiet month was is a chart that lies about the shape of the year.
function emptyMonths(year) {
  return Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, '0')}`,
    label: new Date(Date.UTC(year, i, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
  }));
}

function fill(months, rows, keys) {
  const by = Object.fromEntries(rows.map((r) => [r.month, r]));
  return months.map((m) => {
    const row = by[m.month] || {};
    const out = { month: m.month, label: m.label };
    for (const k of keys) out[k] = Number(row[k] || 0);
    return out;
  });
}

// ---------------------------------------------------------------------------
// One rep's year
// ---------------------------------------------------------------------------
router.get('/reports/rep/:id', requireAuth, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const out = await withUserTransaction(req.userId, async (client) => {
    const ctx = await requirePlatform(client, req.userId, { rep: true });
    if (ctx.is_rep && ctx.rep_id !== id) throw httpError(403, 'You can only open your own report', 'own_report_only');

    const year = yearParam(req.query.year, await currentYear(client));
    const { rows: [rep] } = await client.query('select id, name, email, active, created_at from reps where id = $1', [id]);
    if (!rep) throw httpError(404, 'No such rep');

    const months = emptyMonths(year);
    const bounds = [`${year}-01-01`, `${year + 1}-01-01`];

    // Leads they brought in, by the month they found them.
    const { rows: inbound } = await client.query(
      `select to_char(found_on, 'YYYY-MM') as month, count(*)::int as leads
       from rep_leads where brought_in_by_rep_id = $1 and found_on >= $2::date and found_on < $3::date
       group by 1`,
      [id, ...bounds]
    );

    // Companies they closed, by the month they closed them.
    const { rows: won } = await client.query(
      `select to_char(closed_on, 'YYYY-MM') as month, count(*)::int as won
       from rep_leads where closed_by_rep_id = $1 and status = 'won' and closed_on >= $2::date and closed_on < $3::date
       group by 1`,
      [id, ...bounds]
    );

    // What they earned, by the month it was earned, in Eastern time — the same
    // boundaries their statement and their balance already use.
    const { rows: earned } = await client.query(
      `select to_char(earned_at at time zone '${BILLING_TIME_ZONE}', 'YYYY-MM') as month,
              sum(amount_cents) filter (where kind = 'activation')::int as bonus_cents,
              sum(amount_cents) filter (where kind = 'referral')::int as royalty_cents,
              sum(amount_cents)::int as earned_cents
       from rep_earnings
       where rep_id = $1
         and (earned_at at time zone '${BILLING_TIME_ZONE}') >= $2::date
         and (earned_at at time zone '${BILLING_TIME_ZONE}') < $3::date
       group by 1`,
      [id, ...bounds]
    );

    const { rows: lost } = await client.query(
      `select month, lost_count::int as lost from rep_lead_outcomes where rep_id = $1 and month like $2`,
      [id, `${year}-%`]
    );

    // Still in play right now — not a monthly figure, a standing one.
    const { rows: [open] } = await client.query(
      `select count(*)::int as open_leads,
              count(*) filter (where found_on < current_date - interval '30 days')::int as open_over_30_days
       from rep_leads where brought_in_by_rep_id = $1 and status = 'open'`,
      [id]
    );
    const { rows: [waiting] } = await client.query(
      `select count(*)::int as awaiting_build
       from rep_leads where closed_by_rep_id = $1 and build_status = 'awaiting_approval'`,
      [id]
    );
    const { rows: [dealers] } = await client.query(
      `select count(distinct tenant_id)::int as dealers_now
       from rep_assignments where effective_to is null and (closer_rep_id = $1 or onboarder_rep_id = $1)`,
      [id]
    );
    const { rows: [balance] } = await client.query(
      `select (coalesce((select sum(amount_cents) from rep_earnings where rep_id = $1), 0)
             - coalesce((select sum(amount_cents) from rep_payouts where rep_id = $1), 0))::int as owed_cents`,
      [id]
    );

    const byMonth = fill(months, [...inbound, ...won, ...earned, ...lost].reduce((acc, row) => {
      const at = acc.find((x) => x.month === row.month);
      if (at) Object.assign(at, row); else acc.push({ ...row });
      return acc;
    }, []), ['leads', 'won', 'lost', 'bonus_cents', 'royalty_cents', 'earned_cents']);

    const total = (k) => byMonth.reduce((n, m) => n + m[k], 0);
    const decided = total('won') + total('lost');

    return {
      year,
      rep: { id: rep.id, name: rep.name, email: rep.email, active: rep.active },
      months: byMonth,
      totals: {
        leads: total('leads'),
        won: total('won'),
        lost: total('lost'),
        earned_cents: total('earned_cents'),
        bonus_cents: total('bonus_cents'),
        royalty_cents: total('royalty_cents'),
      },
      now: {
        open_leads: open.open_leads,
        open_over_30_days: open.open_over_30_days,
        awaiting_build: waiting.awaiting_build,
        dealers: dealers.dealers_now,
        owed_cents: balance.owed_cents,
      },
      // Out of the leads that actually reached an answer. Leads still open are
      // left out on purpose: counting them as losses flatters nobody and
      // counting them as wins flatters everybody.
      conversion: {
        decided,
        won: total('won'),
        lost: total('lost'),
        rate: decided ? Math.round((total('won') / decided) * 1000) / 10 : null,
      },
    };
  });
  res.json(out);
}));

// ---------------------------------------------------------------------------
// The whole company's year
// ---------------------------------------------------------------------------
router.get('/reports/company', requireAuth, wrap(async (req, res) => {
  const out = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const year = yearParam(req.query.year, await currentYear(client));
    const months = emptyMonths(year);
    const bounds = [`${year}-01-01`, `${year + 1}-01-01`];

    // Money in: only what actually cleared, and only for real. A test-mode
    // charge is not revenue.
    //
    // Read as the SERVICE ROLE, not as Joseph. billing_events belongs to each
    // dealer and RLS scopes it to that dealer's own tenant, so a query run as
    // the 50. admin sees 50.'s own rows and nothing else — which is not an
    // error, just an empty revenue line that looks like a quiet year. The
    // admin check happened a few lines up, under RLS, before any of this.
    const revenue = await withServiceRole(async (sc) => {
      await assertServiceRoleConnection(sc);
      const { rows } = await sc.query(
      `select to_char(created_at at time zone '${BILLING_TIME_ZONE}', 'YYYY-MM') as month,
              coalesce(sum(amount_cents) filter (where event_type = 'activation_charge'), 0)::int as activation_cents,
              coalesce(sum(amount_cents) filter (where event_type = 'annual_renewal_charge'), 0)::int as renewal_cents,
              coalesce(sum(amount_cents) filter (where event_type = 'referral_fee'), 0)::int as fee_cents,
              coalesce(sum(amount_cents), 0)::int as revenue_cents,
              count(*)::int as payments
       from billing_events
       where status = 'succeeded' and livemode is true
         and event_type in ('activation_charge', 'annual_renewal_charge', 'referral_fee')
         and (created_at at time zone '${BILLING_TIME_ZONE}') >= $1::date
         and (created_at at time zone '${BILLING_TIME_ZONE}') < $2::date
       group by 1`,
        bounds
      );
      return rows;
    });

    // What the reps earned, which is a cost whether or not it has been paid yet.
    const { rows: repCost } = await client.query(
      `select to_char(earned_at at time zone '${BILLING_TIME_ZONE}', 'YYYY-MM') as month,
              coalesce(sum(amount_cents), 0)::int as rep_cost_cents
       from rep_earnings
       where (earned_at at time zone '${BILLING_TIME_ZONE}') >= $1::date
         and (earned_at at time zone '${BILLING_TIME_ZONE}') < $2::date
       group by 1`,
      bounds
    );

    // Leads in and companies closed, the shape of the pipeline over the year.
    const { rows: pipeline } = await client.query(
      `select to_char(found_on, 'YYYY-MM') as month, count(*)::int as leads
       from rep_leads where found_on >= $1::date and found_on < $2::date group by 1`,
      bounds
    );
    const { rows: closed } = await client.query(
      `select to_char(closed_on, 'YYYY-MM') as month, count(*)::int as closed
       from rep_leads where status = 'won' and closed_on >= $1::date and closed_on < $2::date group by 1`,
      bounds
    );
    const { rows: built } = await client.query(
      `select to_char(built_at at time zone '${BILLING_TIME_ZONE}', 'YYYY-MM') as month, count(*)::int as built
       from rep_leads
       where build_status = 'built'
         and (built_at at time zone '${BILLING_TIME_ZONE}') >= $1::date
         and (built_at at time zone '${BILLING_TIME_ZONE}') < $2::date
       group by 1`,
      bounds
    );

    const { rows: expenseRows } = await client.query(
      `select id, name, category, amount_cents, recurrence,
              started_on::text as started_on, ended_on::text as ended_on, notes
       from platform_expenses order by category, name`
    );
    const { rows: [fees] } = await client.query('select card_fee_bps, card_fee_fixed_cents from platform_finance_settings');

    const base = fill(months, [...revenue, ...repCost, ...pipeline, ...closed, ...built].reduce((acc, row) => {
      const at = acc.find((x) => x.month === row.month);
      if (at) Object.assign(at, row); else acc.push({ ...row });
      return acc;
    }, []), ['activation_cents', 'renewal_cents', 'fee_cents', 'revenue_cents', 'payments', 'rep_cost_cents', 'leads', 'closed', 'built']);

    // A monthly cost applies to every month it covers; a yearly one is spread
    // across twelve so a single January bill does not read as a terrible
    // January; a one-off lands where it happened.
    // started_on/ended_on are read as text on purpose (see the queries above):
    // a date column arrives as a JS Date, and comparing one to '2026-03' is a
    // comparison that never matches and never complains.
    const runningCostFor = (monthKey) => {
      const first = new Date(`${monthKey}-01T00:00:00Z`);
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
      return expenseRows.reduce((sum, e) => {
        const started = new Date(`${e.started_on}T00:00:00Z`);
        const ended = e.ended_on ? new Date(`${e.ended_on}T00:00:00Z`) : null;
        if (started > last) return sum;
        if (ended && ended < first) return sum;
        if (e.recurrence === 'monthly') return sum + e.amount_cents;
        if (e.recurrence === 'yearly') return sum + Math.round(e.amount_cents / 12);
        return sum + (String(e.started_on).slice(0, 7) === monthKey ? e.amount_cents : 0);
      }, 0);
    };

    const rows = base.map((m) => {
      const running = runningCostFor(m.month);
      // An estimate, and named one: a percentage of what was taken plus a flat
      // bit per payment. The real figure is on the Stripe statement.
      const processing = Math.round((m.revenue_cents * fees.card_fee_bps) / 10000) + m.payments * fees.card_fee_fixed_cents;
      const costs = running + processing + m.rep_cost_cents;
      return { ...m, running_cost_cents: running, processing_estimate_cents: processing, cost_cents: costs, profit_cents: m.revenue_cents - costs };
    });

    const sum = (k) => rows.reduce((n, m) => n + m[k], 0);
    const { rows: [dealers] } = await client.query(
      `select count(*) filter (where billing_required is true)::int as dealers,
              count(*) filter (where billing_required is true and activation_paid_at is not null and activation_livemode is true)::int as paid,
              count(*) filter (where billing_required is false)::int as in_house
       from tenants`
    );

    return {
      year,
      months: rows,
      totals: {
        revenue_cents: sum('revenue_cents'),
        activation_cents: sum('activation_cents'),
        renewal_cents: sum('renewal_cents'),
        fee_cents: sum('fee_cents'),
        rep_cost_cents: sum('rep_cost_cents'),
        running_cost_cents: sum('running_cost_cents'),
        processing_estimate_cents: sum('processing_estimate_cents'),
        cost_cents: sum('cost_cents'),
        profit_cents: sum('profit_cents'),
        leads: sum('leads'),
        closed: sum('closed'),
        built: sum('built'),
      },
      companies: dealers,
      expenses: expenseRows,
      card_fee: fees,
      // Said plainly so a figure built on an assumption is never mistaken for
      // one built on a receipt.
      caveats: [
        'Card processing is an estimate from the rate below, not from Stripe’s own statement.',
        'Rep pay is counted the month it was earned, not the month you paid it.',
        'Gift cards a dealer sends are paid by that dealer, so they are not a cost here.',
      ],
    };
  });
  res.json(out);
}));

// ---------------------------------------------------------------------------
// The expense list itself
// ---------------------------------------------------------------------------
const expenseBody = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(['hosting', 'email', 'payments', 'software', 'rewards', 'people', 'other']),
  amount_cents: z.number().int().min(0).max(100000000),
  recurrence: z.enum(['monthly', 'yearly', 'once']),
  started_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ended_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

router.post('/reports/expenses', requireAuth, wrap(async (req, res) => {
  const body = expenseBody.parse(req.body || {});
  const row = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [e] } = await client.query(
      `insert into platform_expenses (name, category, amount_cents, recurrence, started_on, ended_on, notes)
       values ($1, $2, $3, $4, coalesce($5::date, current_date), $6::date, $7)
       returning id, name, category, amount_cents, recurrence,
                 started_on::text as started_on, ended_on::text as ended_on, notes`,
      [body.name, body.category, body.amount_cents, body.recurrence, body.started_on || null, body.ended_on || null, body.notes || null]
    );
    return e;
  });
  res.status(201).json(row);
}));

router.patch('/reports/expenses/:id', requireAuth, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = expenseBody.partial().parse(req.body || {});
  const row = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const keys = Object.keys(body);
    if (!keys.length) throw httpError(400, 'Nothing to change');
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const { rows: [e] } = await client.query(
      `update platform_expenses set ${sets.join(', ')} where id = $1
       returning id, name, category, amount_cents, recurrence,
                 started_on::text as started_on, ended_on::text as ended_on, notes`,
      [id, ...keys.map((k) => body[k])]
    );
    if (!e) throw httpError(404, 'No such expense');
    return e;
  });
  res.json(row);
}));

router.delete('/reports/expenses/:id', requireAuth, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const r = await client.query('delete from platform_expenses where id = $1', [id]);
    if (!r.rowCount) throw httpError(404, 'No such expense');
  });
  res.json({ ok: true });
}));

router.put('/reports/card-fee', requireAuth, wrap(async (req, res) => {
  const body = z.object({
    card_fee_bps: z.number().int().min(0).max(10000),
    card_fee_fixed_cents: z.number().int().min(0).max(10000),
  }).parse(req.body || {});
  const row = await withUserTransaction(req.userId, async (client) => {
    await requirePlatform(client, req.userId, { admin: true });
    const { rows: [f] } = await client.query(
      `update platform_finance_settings set card_fee_bps = $1, card_fee_fixed_cents = $2, updated_at = now()
       returning card_fee_bps, card_fee_fixed_cents`,
      [body.card_fee_bps, body.card_fee_fixed_cents]
    );
    return f;
  });
  res.json(row);
}));

module.exports = router;
