const crypto = require('crypto');

// Paths that skip CSRF validation (service workers, webhooks, etc.)
const SKIP_PATHS = [
  '/admin-sw.js',
  '/worker-sw.js',
  '/induction/submit',
  '/induction/cash/submit',
  '/induction/tfn/submit',
  '/induction/abn/submit',
];

// Path prefixes that skip CSRF — for token-protected public endpoints
// (e.g. /sop-sign/:token/submit hit by external phones with no session).
const SKIP_PREFIXES = [
  '/sop-sign/',
  '/toolbox-attend/',
  // /contract-sign/:token/sign — a new hire's phone has no session, so no
  // CSRF token; the unguessable URL token is the capability that gates it.
  '/contract-sign/',
  // /wq/:code is the participant entry point for Safety > Workshops.
  // Office staff scan the room QR; the session_code in the URL is the
  // capability that gates POSTs to start / submit / poll the leaderboard.
  '/wq/',
];

function csrfProtection(req, res, next) {
  // Skip for non-session requests (static assets handled by express.static before this)
  if (SKIP_PATHS.some(p => req.path === p)) return next();
  if (SKIP_PREFIXES.some(p => req.path.startsWith(p))) return next();

  // Generate token if not in session
  if (!req.session._csrf) {
    req.session._csrf = crypto.randomBytes(32).toString('hex');
  }

  // Always expose token to templates
  res.locals.csrfToken = req.session._csrf;

  // Only validate on state-changing methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip CSRF for multipart/form-data uploads (multer handles body parsing after CSRF middleware)
  // The session cookie still provides authentication security
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return next();
  }

  // Get token from body or header (handle array from nested forms)
  const rawToken = req.body._csrf || req.headers['x-csrf-token'];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  if (!token || token !== req.session._csrf) {
    // AJAX request — return JSON error
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token. Please refresh the page and try again.' });
    }
    // Form submission — flash and redirect back
    if (req.flash) req.flash('error', 'Form expired or invalid. Please try again.');
    return res.redirect('back');
  }

  next();
}

module.exports = { csrfProtection };
