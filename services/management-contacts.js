// Management contacts — Operations / Accounts / HR phone + email blob.
// Stored as JSON in system_config under 'management_contacts' so admins
// can edit at runtime from the HR Dashboard without a schema migration.
// Workers read this on /w/contacts (linked from the More page under WORK).
//
// If the row doesn't exist yet, the DEFAULT_CONTACTS below are returned
// — so the page works out-of-the-box on a fresh DB. The first admin
// save persists whatever they've edited to into system_config.

'use strict';

const { getDb } = require('../db/database');

const CONFIG_KEY = 'management_contacts';

// Seed values from the original request. The 'key' is a stable
// machine-friendly slug used to round-trip from the edit form; the
// 'label' is what workers see.
const DEFAULT_CONTACTS = [
  { key: 'operations', label: 'Operations', email: 'operations@tstc.com.au', phone: '0450 819 004' },
  { key: 'accounts',   label: 'Accounts',   email: 'accounts@tstc.com.au',   phone: '0415 665 768' },
  { key: 'hr',         label: 'HR',         email: 'suhail@tstc.com.au',     phone: '0404 865 150' },
];

function getContacts() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT config_value FROM system_config WHERE config_key = ?").get(CONFIG_KEY);
    if (!row || !row.config_value) return DEFAULT_CONTACTS.slice();
    const parsed = JSON.parse(row.config_value);
    if (!Array.isArray(parsed)) return DEFAULT_CONTACTS.slice();
    // Normalise rows so callers don't have to defend against missing keys.
    return parsed.map(c => ({
      key:   String(c.key || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40),
      label: String(c.label || '').trim().slice(0, 80),
      email: String(c.email || '').trim().slice(0, 200),
      phone: String(c.phone || '').trim().slice(0, 40),
    })).filter(c => c.label);
  } catch (e) {
    console.error('[management-contacts] read failed:', e.message);
    return DEFAULT_CONTACTS.slice();
  }
}

// Replaces the entire contacts list. Input is an array of {key?, label,
// email, phone}. Rows without a label are dropped. Returns the saved
// list for echo-back to the edit form.
function setContacts(contacts, userId) {
  const normalised = (Array.isArray(contacts) ? contacts : []).map(c => ({
    key:   String(c.key || c.label || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40),
    label: String(c.label || '').trim().slice(0, 80),
    email: String(c.email || '').trim().slice(0, 200),
    phone: String(c.phone || '').trim().slice(0, 40),
  })).filter(c => c.label);

  const db = getDb();
  db.prepare(`
    INSERT INTO system_config (config_key, config_value, config_type, description, updated_at, updated_by_id)
    VALUES (?, ?, 'json', 'T&S management contacts (Operations / Accounts / HR …) — edited from /hr/management-contacts', CURRENT_TIMESTAMP, ?)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      config_type = 'json',
      updated_at = CURRENT_TIMESTAMP,
      updated_by_id = excluded.updated_by_id
  `).run(CONFIG_KEY, JSON.stringify(normalised), userId || null);

  // Invalidate the settings cache so getConfig reads see the new value
  // immediately. Loaded lazily — the require is local to avoid a circular
  // dependency on startup.
  try {
    const { reloadSettings } = require('../middleware/settings');
    reloadSettings();
  } catch (e) { /* best-effort */ }

  return normalised;
}

module.exports = { getContacts, setContacts, DEFAULT_CONTACTS };
