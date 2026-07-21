const express = require('express');
const router = express.Router();

// The worker shifts UI lives at /w/jobs (routes/worker/jobs.js) — it has been
// the "My Shifts" page since the 2026-03-19 jobs redesign, and jobs.js also
// owns the /w/shifts and /w/shifts/:id alias redirects plus the
// confirm/decline flow (POST /w/jobs/:id/respond).
//
// This router is intentionally empty. The old standalone shifts page that
// lived here was shadowed by those aliases (jobs.js is mounted first in
// server.js) and had been unreachable since March; it was removed as dead
// code. Do not add routes here — add them to jobs.js. The remaining cleanup
// (deleting this file and its mount in server.js) is deferred until server.js
// is safe to commit.

module.exports = router;
