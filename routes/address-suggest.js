// Address autocomplete backend for the job form's Location step.
//
// Provider chain (same idiom as services/bookingGeocode.js):
//   Google Places Autocomplete when a google_maps_api_key is configured
//   (env var or Admin → Integrations) — full AU street-number coverage.
//   Otherwise the endpoint answers { provider: 'photon' } and the client
//   falls back to querying Photon (OSM) directly, so the search always
//   works even with zero configuration.
//
// The key never reaches the browser — Google calls are proxied here.
// `sessiontoken` is minted client-side per search session and passed
// through so Google bills autocomplete+details as one session.
const express = require('express');
const router = express.Router();
const { getGoogleKey } = require('../services/bookingGeocode');

// Small in-memory TTL caches to stay well inside the free tier.
const suggestCache = new Map();  // q → suggestions (10 min)
const detailsCache = new Map();  // place_id → parsed address (24 h)
const SUGGEST_TTL = 10 * 60 * 1000;
const DETAILS_TTL = 24 * 3600 * 1000;

function cacheGet(map, key) {
  const hit = map.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (hit) map.delete(key);
  return null;
}
function cacheSet(map, key, data, ttl) {
  if (map.size > 500) map.clear(); // crude bound — these are tiny objects
  map.set(key, { expires: Date.now() + ttl, data });
}

// GET /api/address-suggest?q=…&sessiontoken=…
router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const key = getGoogleKey();
  if (!key || q.length < 3) return res.json({ provider: 'photon' });

  const cached = cacheGet(suggestCache, q.toLowerCase());
  if (cached) return res.json({ provider: 'google', suggestions: cached });

  try {
    const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json'
      + '?input=' + encodeURIComponent(q)
      + '&components=country:au&types=address'
      + '&location=-33.87,151.21&radius=100000'
      + (req.query.sessiontoken ? '&sessiontoken=' + encodeURIComponent(String(req.query.sessiontoken)) : '')
      + '&key=' + key;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn('[addressSuggest] Google autocomplete rejected:', data.status, data.error_message || '');
      return res.json({ provider: 'photon' });
    }
    const suggestions = (data.predictions || []).slice(0, 6).map(p => ({
      id: p.place_id,
      label: (p.structured_formatting && p.structured_formatting.main_text) || p.description,
      sub: (p.structured_formatting && p.structured_formatting.secondary_text) || '',
    }));
    cacheSet(suggestCache, q.toLowerCase(), suggestions, SUGGEST_TTL);
    res.json({ provider: 'google', suggestions });
  } catch (e) {
    console.warn('[addressSuggest] Google autocomplete error:', e.message);
    res.json({ provider: 'photon' });
  }
});

// GET /api/address-suggest/details?place_id=…&sessiontoken=…
router.get('/details', async (req, res) => {
  const placeId = String(req.query.place_id || '').trim();
  const key = getGoogleKey();
  if (!key || !placeId) return res.status(400).json({ error: 'place_id required' });

  const cached = cacheGet(detailsCache, placeId);
  if (cached) return res.json(cached);

  try {
    const url = 'https://maps.googleapis.com/maps/api/place/details/json'
      + '?place_id=' + encodeURIComponent(placeId)
      + '&fields=address_components,formatted_address'
      + (req.query.sessiontoken ? '&sessiontoken=' + encodeURIComponent(String(req.query.sessiontoken)) : '')
      + '&key=' + key;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK' || !data.result) {
      console.warn('[addressSuggest] Google details rejected:', data.status, data.error_message || '');
      return res.status(502).json({ error: 'lookup failed' });
    }
    const comps = data.result.address_components || [];
    const find = (type, short) => {
      const c = comps.find(c => c.types && c.types.includes(type));
      return c ? (short ? c.short_name : c.long_name) : '';
    };
    const streetNumber = find('street_number');
    const route = find('route');
    const out = {
      street: [streetNumber, route].filter(Boolean).join(' '),
      suburb: find('locality') || find('sublocality') || '',
      state: find('administrative_area_level_1', true),
      postcode: find('postal_code'),
      formatted: data.result.formatted_address || '',
    };
    cacheSet(detailsCache, placeId, out, DETAILS_TTL);
    res.json(out);
  } catch (e) {
    console.warn('[addressSuggest] Google details error:', e.message);
    res.status(502).json({ error: 'lookup failed' });
  }
});

module.exports = router;
