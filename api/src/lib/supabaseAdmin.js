// Creating sign-in accounts, through Supabase Auth's admin API.
//
// The platform has always been able to READ who someone is (a token the
// browser already holds, verified against Supabase's JWKS). This is the other
// direction: making a login for someone who does not have one yet — a sales
// rep being given their own pipeline, and from the next stage on, the admin of
// a dealer that was just built. Neither can be done with the publishable key
// the pages use, so this is the one place in the codebase that holds
// SUPABASE_SERVICE_ROLE_KEY.
//
// A password is never created, sent, or stored here. Every account is made
// with no password at all, and the person is sent a one-time link that lets
// them set their own. That is the whole reason this file exists rather than
// generating a temporary password somewhere and emailing it.
//
// No SDK: fetch, like lib/postmark.js and lib/stripe.js. SUPABASE_URL is
// already configured for token verification, and the tests point it at the
// auth stand-in exactly as they do everywhere else.
const AUTH_LINK_TYPE = 'recovery';

function authBase() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set — see .env.example');
  return `${url.replace(/\/+$/, '')}/auth/v1`;
}

// The guard, deliberately loud and deliberately separate from the calls: a
// missing key must fail the one request that needed it with an explanation an
// operator can act on, not fail silently or half-create an account.
function serviceRoleKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set, so this platform cannot create sign-in accounts yet. ' +
        'Add it to the API service (Supabase → Project Settings → API Keys → service_role). See .env.example.'
    );
  }
  return key;
}

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function adminFetch(path, body) {
  const key = serviceRoleKey();
  const res = await fetch(`${authBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// An account for this email, with NO password: the person cannot sign in at
// all until they follow the link from setPasswordLink() below and choose one.
// email_confirm skips the "confirm your address" email, because the only way
// in is the link we are about to send to that same address anyway.
//
// Already exists? That is a normal outcome, not an error — a rep who was
// invited before, or whose invite is being resent — so the existing account's
// id comes back with created: false and nothing about it is changed.
async function createPasswordlessUser(email) {
  const address = String(email || '').trim();
  if (!address) throw new Error('An email address is required to create a login');

  const { ok, status, json } = await adminFetch('/admin/users', { email: address, email_confirm: true });
  if (ok && json && json.id) return { userId: json.id, created: true };

  const message = String((json && (json.msg || json.message || json.error_description || json.error)) || '');
  if (status === 422 || /already (been )?registered|already exists/i.test(message)) {
    const existing = await findUserByEmail(address);
    if (existing) return { userId: existing, created: false };
  }
  const err = new Error(message || `Supabase could not create that login (${status})`);
  err.supabaseStatus = status;
  throw err;
}

async function findUserByEmail(email) {
  const key = serviceRoleKey();
  const url = `${authBase()}/admin/users?per_page=1&filter=${encodeURIComponent(String(email).trim())}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  const users = Array.isArray(json) ? json : json.users || [];
  const match = users.find((u) => String(u.email || '').toLowerCase() === String(email).trim().toLowerCase());
  return match ? match.id : null;
}

// The one-time link the person follows to choose their own password. Supabase
// expires it on its own and invalidates it once used, so nothing here has to
// keep, hash or clean up a token of our own.
//
// 'recovery' rather than 'invite' on purpose: it works the same for an account
// that has just been created and for one being re-sent, so a resent invite is
// the same code path as a first one.
async function setPasswordLink(email, redirectTo) {
  const { ok, status, json } = await adminFetch('/admin/generate_link', {
    type: AUTH_LINK_TYPE,
    email: String(email || '').trim(),
    ...(redirectTo ? { redirect_to: redirectTo } : {}),
  });
  // Supabase has returned this at the top level and under `properties`
  // depending on version; accept either rather than pinning to one.
  const link = (json && (json.action_link || (json.properties && json.properties.action_link))) || null;
  if (!ok || !link) {
    const err = new Error(
      (json && (json.msg || json.message || json.error_description)) || `Supabase could not create a set-password link (${status})`
    );
    err.supabaseStatus = status;
    throw err;
  }
  return link;
}

// Both steps together, which is what every caller actually wants.
async function createLoginWithSetPasswordLink(email, redirectTo) {
  const { userId, created } = await createPasswordlessUser(email);
  const link = await setPasswordLink(email, redirectTo);
  return { userId, created, link };
}

module.exports = {
  isConfigured,
  createPasswordlessUser,
  setPasswordLink,
  createLoginWithSetPasswordLink,
  findUserByEmail,
};
