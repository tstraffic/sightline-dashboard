/**
 * Auto-fill bookings.latitude / bookings.longitude from the address
 * fields when the user hasn't set them manually. Called after every
 * booking insert / update so a booking always has coordinates if its
 * address is geocodable.
 *
 * Provider chain:
 *   1. Google Geocoding API (if GOOGLE_MAPS_API_KEY env var is set)
 *      — street-level accuracy, best for AU. Free $200/mo credit
 *      from Google covers ~40k lookups.
 *   2. Open-Meteo geocoder — suburb-level fallback. Free, no key.
 *
 * Strategy:
 *  - If marker_is_accurate is set, the user dropped a pin — leave alone.
 *  - If lat/lng are already set AND geocode_source = 'google' AND the
 *    address text hasn't changed, leave alone.
 *  - If lat/lng are set but came from Open-Meteo and Google is now
 *    configured, re-geocode to upgrade to street-level accuracy.
 *  - Otherwise build a query string from
 *      [site_address, suburb, state, postcode, 'Australia']
 *    and hit the configured provider.
 *
 * Best-effort: failures are logged and swallowed. The booking save
 * never blocks on geocoding errors.
 */
const { getDb } = require('../db/database');
const { geocodeAddress: geocodeOpenMeteo } = require('./homeContext');
const { getConfig } = require('../middleware/settings');

// Resolve the active key on every call so an admin can paste a key into
// /admin/integrations (writes to system_config) and have it pick up
// without a redeploy. Env vars still win if both are set.
function getGoogleKey() {
  return process.env.GOOGLE_MAPS_API_KEY
      || process.env.GOOGLE_GEOCODING_API_KEY
      || getConfig('google_maps_api_key', '');
}

// Cache geocode results in-memory for 24h to avoid re-billing for
// identical addresses across the same process lifetime.
const cache = new Map();
const CACHE_TTL_MS = 24 * 3600 * 1000;

function buildQuery(b) {
  return [b.site_address, b.suburb, b.state, b.postcode, 'Australia']
    .map(s => (s == null ? '' : String(s).trim()))
    .filter(Boolean)
    .join(', ');
}

async function geocodeWithGoogle(q) {
  const key = getGoogleKey();
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=au&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn('[bookingGeocode] Google API HTTP', res.status);
    return null;
  }
  const data = await res.json();
  if (data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
    console.warn('[bookingGeocode] Google API rejected:', data.status, data.error_message || '');
    return null;
  }
  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results[0]) return null;
  const r = data.results[0];
  const loc = r.geometry && r.geometry.location;
  if (!loc || loc.lat == null || loc.lng == null) return null;
  // Pull suburb out of address components for the city label.
  let city = '';
  if (Array.isArray(r.address_components)) {
    const sub = r.address_components.find(c => c.types && (c.types.includes('locality') || c.types.includes('sublocality') || c.types.includes('postal_town')));
    if (sub) city = sub.long_name;
  }
  return { lat: loc.lat, lng: loc.lng, city, source: 'google', formatted: r.formatted_address || '' };
}

async function geocodeWithOpenMeteo(q) {
  const r = await geocodeOpenMeteo(q);
  if (!r) return null;
  return { lat: r.lat, lng: r.lng, city: r.city || '', source: 'open_meteo' };
}

async function geocodeQuery(q) {
  if (!q) return null;
  const googleKey = getGoogleKey();
  const cacheKey = `q:${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  let result = null;
  if (googleKey) {
    try { result = await geocodeWithGoogle(q); } catch (e) { console.warn('[bookingGeocode] google error:', e.message); }
  }
  if (!result) {
    try { result = await geocodeWithOpenMeteo(q); } catch (e) { console.warn('[bookingGeocode] open-meteo error:', e.message); }
  }
  if (result) cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, data: result });
  return result;
}

async function geocodeBookingIfNeeded(bookingId, opts = {}) {
  try {
    const googleKey = getGoogleKey();
    const db = getDb();
    const b = db.prepare(`
      SELECT id, site_address, suburb, state, postcode, latitude, longitude,
             marker_is_accurate, geocode_source, geocoded_query
      FROM bookings WHERE id = ?
    `).get(bookingId);
    if (!b) return null;
    if (b.marker_is_accurate) return null;     // user-placed pin wins

    const force = !!opts.force;
    const q = buildQuery(b);
    if (!q) return null;                        // nothing to geocode

    const hasCoords = b.latitude != null && b.longitude != null;
    const queryUnchanged = b.geocoded_query && b.geocoded_query === q;
    const isGoogleSourced = b.geocode_source === 'google';

    // Skip if we already have Google-quality coords for this exact query.
    if (hasCoords && isGoogleSourced && queryUnchanged && !force) return null;

    // Skip if no Google key configured AND we already have any coords AND
    // the address text hasn't changed — preserves the original behaviour.
    if (!googleKey && hasCoords && queryUnchanged && !force) return null;

    const geo = await geocodeQuery(q);
    if (!geo) return null;

    db.prepare(`
      UPDATE bookings
      SET latitude = ?, longitude = ?, geocode_source = ?, geocoded_at = CURRENT_TIMESTAMP, geocoded_query = ?
      WHERE id = ?
    `).run(geo.lat, geo.lng, geo.source, q, bookingId);

    return geo;
  } catch (e) {
    console.warn('[bookingGeocode] failed for booking', bookingId, ':', e.message);
    return null;
  }
}

// Backfill: re-geocode every booking that doesn't yet have Google-source
// coordinates. Yields a summary { scanned, upgraded, failed }. Safe to
// run repeatedly — rows already on Google with an unchanged query are
// skipped.
async function geocodeBackfill({ limit = 500, onlyMissing = false } = {}) {
  const googleKey = getGoogleKey();
  const db = getDb();
  const sql = onlyMissing
    ? 'SELECT id FROM bookings WHERE latitude IS NULL OR longitude IS NULL ORDER BY id DESC LIMIT ?'
    : "SELECT id FROM bookings WHERE (geocode_source IS NULL OR geocode_source != 'google') AND marker_is_accurate IS NOT 1 ORDER BY id DESC LIMIT ?";
  const rows = db.prepare(sql).all(limit);
  let upgraded = 0, failed = 0;
  for (const r of rows) {
    const res = await geocodeBookingIfNeeded(r.id, { force: true });
    if (res) upgraded++; else failed++;
    // small delay so we don't blow Google QPS limits
    await new Promise(r => setTimeout(r, 25));
  }
  return { scanned: rows.length, upgraded, failed, provider: googleKey ? 'google' : 'open_meteo' };
}

module.exports = { geocodeBookingIfNeeded, geocodeBackfill, geocodeQuery, buildQuery, getGoogleKey };
