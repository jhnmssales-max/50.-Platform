// Shared by routes/tenantSettings.js (setting a tenant's Tremendous
// credentials) and routes/referrals.js (decrypting them to actually issue
// a reward) — one place for the passphrase lookup so both stay in sync.
function encryptionKey() {
  const key = process.env.TENANT_CREDENTIALS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('TENANT_CREDENTIALS_ENCRYPTION_KEY is not set — see .env.example');
  }
  return key;
}

module.exports = { encryptionKey };
