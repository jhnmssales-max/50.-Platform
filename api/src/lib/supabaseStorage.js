// Where a rep's brand files actually live.
//
// Render wipes a service's disk on every deploy, so a logo written next to the
// API would survive until the next push and then quietly stop loading on a
// dealer's live page. Supabase Storage is already part of this project's
// Supabase account, costs nothing at this size, and hands back a plain public
// URL — which is exactly what tenants.branding.logoUrl needs to be, since the
// pages that read it are static HTML with no credentials of their own.
//
// Public on purpose: a company's own logo is on their website already. Nothing
// private is ever put in this bucket, and the path carries the lead id rather
// than anything about a person.
//
// Same approach as lib/postmark.js and lib/supabaseAdmin.js: fetch, no SDK.
const BUCKET = process.env.SUPABASE_BRAND_BUCKET || 'brand-uploads';

// Deliberately narrow. These are logos and brand sheets, nothing else, and
// what a page can safely load is the limit that matters: anything executable
// or unknown is refused before it reaches storage rather than after.
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};
const MAX_BYTES = 5 * 1024 * 1024;

function base() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set — see .env.example');
  return `${url.replace(/\/+$/, '')}/storage/v1`;
}

function serviceRoleKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set, so this platform cannot store uploaded files. ' +
        'Add it to the API service (Supabase → Project Settings → API Keys → service_role). See .env.example.'
    );
  }
  return key;
}

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function headers(extra = {}) {
  const key = serviceRoleKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function extensionFor(contentType) {
  return ALLOWED[String(contentType || '').toLowerCase().split(';')[0].trim()] || null;
}

// Made on first use rather than asked of whoever sets the project up: one less
// step that can be forgotten, and an "already exists" is a success, not a race
// to lose.
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const res = await fetch(`${base()}/bucket`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: MAX_BYTES,
      allowed_mime_types: Object.keys(ALLOWED),
    }),
  });
  if (res.ok || res.status === 409) {
    bucketReady = true;
    return;
  }
  const body = await res.json().catch(() => ({}));
  const message = String(body.message || body.error || '');
  if (/already exists|duplicate/i.test(message)) {
    bucketReady = true;
    return;
  }
  throw new Error(`Could not prepare the brand file store: ${message || res.status}`);
}

// A path nobody can guess their way along and nothing collides on: the lead it
// belongs to, then a random name. The original filename is kept in the
// database, not in the path, so a file called "Final FINAL logo (3).png"
// cannot produce a URL that needs escaping.
// `owner` is {leadId} or {tenantId}. A tenant's logo goes under tenants/
// rather than leads/ because it outlives the lead it may have come from: the
// lead can be deleted, and a company's live logo must not be filed under a
// folder named for something that is gone.
function pathFor(owner, contentType) {
  const ext = extensionFor(contentType);
  if (!ext) throw new Error(`That kind of file cannot be uploaded (${contentType})`);
  const random = require('crypto').randomBytes(12).toString('hex');
  const folder = owner.tenantId ? `tenants/${owner.tenantId}` : `leads/${owner.leadId}`;
  return `${folder}/${random}.${ext}`;
}

function publicUrlFor(storagePath) {
  return `${base()}/object/public/${BUCKET}/${storagePath}`;
}

async function upload({ leadId, tenantId, bytes, contentType }) {
  // The key before the URL: a missing key is the thing an operator forgets and
  // the thing they can act on, so it must be what the error names.
  serviceRoleKey();
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('There was nothing in that file');
  if (bytes.length > MAX_BYTES) throw new Error(`That file is too big (${Math.round(bytes.length / 1024)}KB; the limit is 5MB)`);
  if (!extensionFor(contentType)) throw new Error('Upload a PNG, JPG, WEBP, GIF, SVG or PDF');

  await ensureBucket();
  if (!leadId && !tenantId) throw new Error('An upload must belong to a lead or a company');
  const storagePath = pathFor({ leadId, tenantId }, contentType);
  const res = await fetch(`${base()}/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType, 'cache-control': 'max-age=31536000' }),
    body: bytes,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Supabase would not store that file: ${body.message || body.error || res.status}`);
  }
  return { storagePath, publicUrl: publicUrlFor(storagePath), sizeBytes: bytes.length };
}

// Best effort by design: the row is the record, and a file left behind in a
// public bucket is litter, not a leak. A failure here must never stop the
// delete the person asked for.
async function remove(storagePath) {
  try {
    const res = await fetch(`${base()}/object/${BUCKET}/${storagePath}`, { method: 'DELETE', headers: headers() });
    return res.ok;
  } catch (err) {
    return false;
  }
}

module.exports = { BUCKET, MAX_BYTES, ALLOWED, isConfigured, upload, remove, publicUrlFor, extensionFor };
