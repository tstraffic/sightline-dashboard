// Preserve typed form input across a validation-error redirect (Post/Redirect/
// Get pattern). When a POST fails validation and redirects back to the form,
// the browser drops everything the user typed — on a phone, re-typing a long
// incident description or leave reason is a real abandonment risk.
//
//   POST handler (on error):  stashForm(req, 'incident', req.body)
//                             return req.session.save(() => res.redirect(...))
//   GET handler (render):     res.render('...', { old: takeForm(req, 'incident'), ... })
//   View:                     value="<%= old.location || '' %>"
//
// One slot per session — a fresh submit overwrites the last. Values are stashed
// under a scope so the echo only lands on the matching form's GET. Uploaded
// files and the CSRF token are never stashed.

function stashForm(req, scope, values) {
  if (!req.session || !values) return;
  var clean = {};
  Object.keys(values).forEach(function (k) {
    if (k === '_csrf') return;
    var v = values[k];
    // Only plain form values — strings, numbers, and string arrays (checkboxes).
    if (typeof v === 'string' || typeof v === 'number') clean[k] = v;
    else if (Array.isArray(v)) clean[k] = v.filter(function (x) { return typeof x === 'string'; });
  });
  req.session._formEcho = { scope: String(scope), values: clean };
}

// Read + clear the stashed values for `scope`. Returns {} when there's nothing
// (or it belongs to a different form), so views can always do `old.field || ''`.
function takeForm(req, scope) {
  var e = req.session && req.session._formEcho;
  if (!e || e.scope !== String(scope)) return {};
  delete req.session._formEcho;
  return e.values || {};
}

module.exports = { stashForm, takeForm };
