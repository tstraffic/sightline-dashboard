// Public VOC certificate verification. No auth.
//
// Auditors scan the QR on a printed cert and land here. Shows the
// worker's name, equipment, dates, and a clear status (Valid /
// Expiring / Expired / Revoked). Revocation reason surfaces when
// applicable. The certificate_id is the public handle — no lookup
// by integer id, so workers + auditors can't enumerate other certs.
//
// Mounted in server.js BEFORE blockWorkerFromAdmin so it works in
// either a public browser or a logged-in admin/worker session.

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

router.get('/verify/:certId', (req, res) => {
  const db = getDb();
  // Look up by certificate_id only — and only return assessments that
  // were actually submitted Competent (so a draft or NYC row can never
  // accidentally show up as a "valid" cert).
  const row = db.prepare(`
    SELECT a.id, a.certificate_id, a.certificate_status,
      a.certificate_revoked_at, a.certificate_revoked_reason,
      a.voc_number, a.assessment_date, a.valid_from, a.valid_until,
      a.assessor_signed_name, a.manager_signed_name,
      t.name AS equipment_name,
      cm.full_name AS worker_name, cm.employee_id AS worker_emp_id
    FROM voc_assessments a
    JOIN voc_templates t ON t.id = a.template_id
    JOIN crew_members cm ON cm.id = a.crew_member_id
    WHERE a.certificate_id = ?
      AND a.status = 'submitted'
      AND a.outcome = 'competent'
  `).get(req.params.certId);

  if (!row) {
    return res.status(404).render('voc-public/verify', {
      title: 'Certificate Not Found',
      cert: null,
      state: 'not_found',
      layout: false,
    });
  }

  const today = todayISO();
  let state = 'valid';
  if (row.certificate_status === 'revoked') {
    state = 'revoked';
  } else if (row.valid_until && row.valid_until < today) {
    state = 'expired';
  } else if (row.valid_until) {
    const days = Math.ceil((new Date(row.valid_until) - new Date(today)) / (24 * 60 * 60 * 1000));
    if (days <= 30) state = 'expiring';
  }

  res.render('voc-public/verify', {
    title: 'Verify VOC Certificate',
    cert: row,
    state,
    layout: false,
  });
});

module.exports = router;
