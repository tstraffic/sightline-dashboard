// Worker portal training — personal mode.
// Worker takes the SAME slide deck + quiz as the in-person presentation, on
// their phone. Identity is auto-assigned from the worker session, so there's
// no attendee picker. Gated by employees.online_training_allowed which the
// admin grants from the employee profile.
const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { employeeGuideSlides, tcTrainingSlides } = require('../../induction-slides');
const { maybeMarkInducted } = require('../../lib/induction');

const MODULES = {
  'employee-guide': { slides: employeeGuideSlides, title: 'T&S Employee Guide', key: 'employee_guide' },
  'traffic-control': { slides: tcTrainingSlides, title: 'TC Training — Module 1', key: 'tc_training_1' },
};

function quizFromSlides(slides) {
  return slides.filter(s => s.layout === 'interactive-quiz' && s.quizData).map(s => s.quizData);
}

// Look up the employee record + permission for the logged-in worker.
function workerEmployee(db, workerId) {
  return db.prepare(`
    SELECT id, full_name, email, online_training_allowed, inducted_at, linked_crew_member_id
    FROM employees
    WHERE linked_crew_member_id = ? AND deleted_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(workerId);
}

// GET /w/training — list of modules with status
router.get('/training', (req, res) => {
  const db = getDb();
  const employee = workerEmployee(db, req.session.worker.id);

  const modules = Object.entries(MODULES).map(([slug, cfg]) => {
    let status = null;
    if (employee) {
      // Match any of (employee_id, crew_member_id, legacy-orphan email)
      // so group-induction completions surface for workers whose
      // employees.linked_crew_member_id wasn't set at the time.
      const pass = db.prepare(`
        SELECT id, completed_at, score, total FROM training_completions
        WHERE module = ? AND passed = 1
          AND (
            employee_id = ?
            OR (crew_member_id IS NOT NULL AND crew_member_id = ?)
            OR (employee_id IS NULL AND email IS NOT NULL AND LOWER(email) = LOWER(?))
          )
        ORDER BY completed_at DESC LIMIT 1
      `).get(cfg.key, employee.id, employee.linked_crew_member_id || -1, employee.email || '');
      status = pass || null;
    }
    return { slug, title: cfg.title, key: cfg.key, totalQuestions: quizFromSlides(cfg.slides).length, passed: !!status, lastPass: status };
  });

  res.render('worker/training-index', {
    title: 'Training',
    currentPage: 'training',
    modules,
    accessAllowed: !!(employee && employee.online_training_allowed),
    inductedAt: employee ? employee.inducted_at : null,
    worker: req.session.worker,
  });
});

// GET /w/training/:slug — full presentation (slides + quiz). Same view as the
// admin presenter, just rendered in personal mode (no attendee picker).
router.get('/training/:slug', (req, res) => {
  const cfg = MODULES[req.params.slug];
  if (!cfg) { req.flash('error', 'Unknown training module.'); return req.session.save(() => res.redirect('/w/training')); }

  const db = getDb();
  const employee = workerEmployee(db, req.session.worker.id);
  if (!employee || !employee.online_training_allowed) {
    return res.render('worker/training-locked', {
      title: 'Training', currentPage: 'training',
      worker: req.session.worker,
    });
  }

  res.render('induction/admin/presenter', {
    layout: false,
    module: req.params.slug,
    moduleKey: cfg.key,
    moduleTitle: cfg.title,
    slides: cfg.slides,
    totalSlides: cfg.slides.length,
    attendees: [],
    title: cfg.title,
    mode: 'personal',
    submitUrl: `/w/training/${req.params.slug}/submit-presentation`,
    exitUrl: '/w/training',
  });
});

// POST /w/training/:slug/submit-presentation — auto-assigns to worker
// session. Same payload shape as the admin /quiz-result endpoint, but
// attendee_ids is ignored.
router.post('/training/:slug/submit-presentation', (req, res) => {
  const cfg = MODULES[req.params.slug];
  if (!cfg) return res.status(404).json({ success: false, error: 'Unknown module' });

  const db = getDb();
  const employee = workerEmployee(db, req.session.worker.id);
  if (!employee || !employee.online_training_allowed) {
    return res.status(403).json({ success: false, error: 'Online training is not enabled for your account.' });
  }

  const { score, total, passed, answers } = req.body;
  const passedFlag = passed ? 1 : 0;
  const correct = parseInt(score, 10) || 0;
  const totalCount = parseInt(total, 10) || quizFromSlides(cfg.slides).length;

  db.prepare(`
    INSERT INTO training_completions (employee_id, module, full_name, email, score, total, passed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(employee.id, cfg.key, employee.full_name, employee.email || '', correct, totalCount, passedFlag);

  let recorded = [];
  if (passedFlag) {
    recorded.push(employee.full_name);
    try { maybeMarkInducted(db, employee.id, 'online'); } catch (e) { console.error('maybeMarkInducted failed:', e.message); }
  }

  res.json({ success: true, recorded });
});

module.exports = router;
