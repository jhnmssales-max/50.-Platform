// Refuses to start when the database is behind the code.
//
// Render deploys this repo on every merge to main. It does not run the
// migrations in supabase/ -- those are applied by hand in the Supabase SQL
// editor, and supabase/ is not even deployed (render.yaml sets rootDir to
// api/). So code that reads a new column can, and did, go live against a
// database that does not have it yet.
//
// What that looked like: the Logins dialog asked for a column that was not
// there, got a 500, reported the error and gave up, so the button looked
// dead. Worse, the same column was read inside the transaction that marks a
// referral paid -- which rolled back, while 50.'s usage fee had already been
// charged a moment earlier. A dealer could be billed for a referral that
// never completed, and nothing said so except one line in a log nobody was
// reading.
//
// One missing column should therefore stop the whole service at boot, where
// it is obvious, rather than breaking a handful of routes quietly. The
// README has said "apply it before deploying the API code that reads it"
// since the billing migrations; this is that sentence, enforced.
//
// Keeping this list current is a manual step, and saying so plainly is
// better than pretending otherwise: a migration that adds a column the API
// reads adds a line here in the same pull request. A column missing from
// this list is not checked -- the list is a floor, not a guarantee.

const REQUIRED_COLUMNS = [
  // 20261025000000_dealer_pricing
  ['tenants', 'referral_fee_cents', '20261025000000_dealer_pricing'],
  ['tenants', 'reward_fulfillment', '20261025000000_dealer_pricing'],
  ['tenants', 'charge_card_cost', '20261025000000_dealer_pricing'],
  ['billing_events', 'fee_cents', '20261025000000_dealer_pricing'],
  // 20261026000000_activated_dealer_becomes_a_referrer
  ['customers', 'source_activated_tenant_id', '20261026000000_activated_dealer_becomes_a_referrer'],
  // 20261027000000_who_gets_the_gift_card_alert
  ['users', 'gets_reward_alerts', '20261027000000_who_gets_the_gift_card_alert'],
  // 20261028000000_invite_followups
  ['tenants', 'invite_followup_months', '20261028000000_invite_followups'],
  ['customers', 'unsubscribed_at', '20261028000000_invite_followups'],
  ['customers', 'unsubscribe_token', '20261028000000_invite_followups'],
  // 20261027000000_record_delivery_failures
  ['customers', 'delivery_failed_at', '20261027000000_record_delivery_failures'],
  ['customers', 'delivery_error', '20261027000000_record_delivery_failures'],
  // 20261112000000_crm_integration_api_keys
  ['api_keys', 'key_hash', '20261112000000_crm_integration_api_keys'],
  ['api_keys', 'revoked_at', '20261112000000_crm_integration_api_keys'],
  ['integration_requests', 'idempotency_key', '20261112000000_crm_integration_api_keys'],
  ['integration_requests', 'response_body', '20261112000000_crm_integration_api_keys'],
];

// Policies, checked the same way and reported differently — see below.
//
// A migration that only moves an RLS policy adds no column, so the list
// above cannot see it, and the failure it causes is the quiet kind: a
// salesperson opens Connect your CRM, the policy still says admins only,
// and they get an empty list and a key that vanishes the moment they create
// it. Nothing errors. Nothing is logged. The screen simply looks broken.
const REQUIRED_POLICIES = [
  // 20261117000000_dealer_settings_any_login
  ['api_keys', 'api_keys_select_own_tenant', '20261117000000_dealer_settings_any_login'],
  ['api_keys', 'api_keys_update_own_tenant', '20261117000000_dealer_settings_any_login'],
];

// Returns the entries this database does not have, in the order listed.
async function findMissingColumns(pool, required = REQUIRED_COLUMNS) {
  const { rows } = await pool.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in (
          select * from unnest($1::text[], $2::text[])
        )`,
    [required.map((r) => r[0]), required.map((r) => r[1])]
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  return required.filter(([t, c]) => !have.has(`${t}.${c}`));
}

async function findMissingPolicies(pool, required = REQUIRED_POLICIES) {
  const { rows } = await pool.query(
    `select tablename, policyname
       from pg_policies
      where schemaname = 'public'
        and (tablename, policyname) in (
          select * from unnest($1::text[], $2::text[])
        )`,
    [required.map((r) => r[0]), required.map((r) => r[1])]
  );
  const have = new Set(rows.map((r) => `${r.tablename}.${r.policyname}`));
  return required.filter(([t, p]) => !have.has(`${t}.${p}`));
}

// Checked once, at boot. Three outcomes, deliberately different:
//
//   nothing missing  -> one quiet line, so a healthy boot still says it ran
//   something missing-> the list, the migrations that add it, and exit(1)
//   check itself failed -> a warning, and carry on
//
// That last one matters. A database that cannot be reached at boot is a
// different problem from a database that is behind, and crash-looping the
// service over a momentary connection failure would turn a blip into an
// outage. Every route would fail on its own in that case anyway.
async function assertSchemaUpToDate(pool, { exit = () => process.exit(1) } = {}) {
  let missing;
  try {
    missing = await findMissingColumns(pool);
  } catch (err) {
    console.error(
      `SCHEMA CHECK could not run: ${err.message}. Starting anyway — this says the database could not be read just now, not that it is out of date.`
    );
    return { ran: false, missing: [] };
  }

  // Policies are warned about, not died on, and the difference is
  // deliberate. A missing column is read inside the transaction that marks a
  // referral paid, after 50.'s fee has been charged — starting without it is
  // not the safe option. A missing policy hides one screen from one kind of
  // login. Refusing to boot over that would take the whole platform down to
  // protect a settings tab, which is the wrong trade; a loud line in the
  // deploy log is the right one.
  let missingPolicies = [];
  try {
    missingPolicies = await findMissingPolicies(pool);
  } catch (err) {
    console.error(`SCHEMA CHECK could not read the RLS policies: ${err.message}. Carrying on.`);
  }
  if (missingPolicies.length) {
    const byMig = new Map();
    for (const [table, policy, migration] of missingPolicies) {
      if (!byMig.has(migration)) byMig.set(migration, []);
      byMig.get(migration).push(`${table}.${policy}`);
    }
    console.error(
      'SCHEMA CHECK: the database is missing RLS policies this code expects.\n' +
        [...byMig].map(([m, ps]) => `  supabase/migrations/${m}.sql\n` + ps.map((p) => `      ${p}`).join('\n')).join('\n') +
        '\nUntil those are applied, the screens behind them look broken rather than\n' +
        'failing: rows a policy still hides simply do not appear. Starting anyway —\n' +
        'everything else works.'
    );
  }

  if (!missing.length) {
    console.log(
      `Schema check: all ${REQUIRED_COLUMNS.length} required columns present` +
        (missingPolicies.length ? `, ${missingPolicies.length} RLS policies missing (see above).` : '.')
    );
    return { ran: true, missing: [], missingPolicies };
  }

  const byMigration = new Map();
  for (const [table, column, migration] of missing) {
    if (!byMigration.has(migration)) byMigration.set(migration, []);
    byMigration.get(migration).push(`${table}.${column}`);
  }
  console.error(
    'DATABASE IS BEHIND THE CODE — refusing to start.\n' +
      '\n' +
      'These columns are missing, by the migration that adds them:\n' +
      [...byMigration].map(([m, cols]) => `  supabase/migrations/${m}.sql\n` + cols.map((c) => `      ${c}`).join('\n')).join('\n') +
      '\n\n' +
      'Apply those migrations in the Supabase SQL editor, then restart this\n' +
      'service. Nothing needs redeploying — the running code picks up a\n' +
      'column the moment it exists.\n' +
      '\n' +
      'Starting without them would not be safer: marking a referral paid\n' +
      'reads these inside the same transaction that records the payment,\n' +
      "after 50.'s fee has already been charged."
  );
  return exit();
}

module.exports = {
  assertSchemaUpToDate,
  findMissingColumns,
  findMissingPolicies,
  REQUIRED_COLUMNS,
  REQUIRED_POLICIES,
};
