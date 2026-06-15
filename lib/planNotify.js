// Shared notification fan-out for plan submissions.
//
// Used by both the Compliance ("Plans & Approvals") module and the Traffic
// Plans module. When a plan is submitted we:
//   • broadcast to everyone in admin + planning, and
//   • optionally send a stronger "tagged you" notification to the specific
//     people the submitter chose.
// Tagged users are removed from the broadcast set so they get exactly one
// (the stronger) notification rather than two.

const { notifyUsers } = require('../middleware/notifications');

// Roles that receive the broadcast when a plan is submitted.
const BROADCAST_ROLES = ['admin', 'planning'];

// Form fields submit tagged ids as a single value, an array, or nothing.
// Normalise to a clean array of numeric ids.
function parseTaggedIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return [...new Set(arr.map(Number).filter(Boolean))];
}

/**
 * Fan out notifications for a plan submission.
 *
 * @param {object} db
 * @param {object} opts
 * @param {number} opts.submitterId   - the user who submitted (excluded from all notifs)
 * @param {string} opts.submitterName - display name for the message
 * @param {Array<number>} opts.taggedIds - user ids the submitter tagged
 * @param {string} opts.ref           - short reference, e.g. "TSCA-0001" or "TP-0042"
 * @param {string} opts.label         - human label, e.g. "Council Permit"
 * @param {string} [opts.jobNumber]   - optional job reference for context
 * @param {string} opts.link          - where the notification points
 * @param {number} [opts.jobId]
 */
function notifyPlanSubmission(db, opts) {
  const {
    submitterId, submitterName, taggedIds = [],
    ref, label, jobNumber, link, jobId = null, verb = 'submitted',
  } = opts;

  const onJob = jobNumber ? ` on ${jobNumber}` : '';
  const tagged = [...new Set(taggedIds.map(Number).filter(Boolean))]
    .filter(id => id !== submitterId);

  // Tagged users — targeted "tagged you" notification.
  if (tagged.length) {
    notifyUsers(db, tagged, {
      type: 'plan_tagged',
      title: `${submitterName} tagged you on ${ref}`,
      message: `${submitterName} ${verb} ${label} (${ref})${onJob} and tagged you to follow up.`,
      link,
      jobId,
    });
  }

  // Broadcast — admin + planning, minus the submitter and anyone tagged above.
  const exclude = new Set([submitterId, ...tagged]);
  const placeholders = BROADCAST_ROLES.map(() => '?').join(',');
  const broadcast = db.prepare(
    `SELECT id FROM users WHERE active = 1 AND LOWER(role) IN (${placeholders})`
  ).all(...BROADCAST_ROLES).map(u => u.id).filter(id => !exclude.has(id));

  notifyUsers(db, broadcast, {
    type: 'plan_submitted',
    title: `Plan ${verb}: ${ref}`,
    message: `${submitterName} ${verb} ${label} (${ref})${onJob}.`,
    link,
    jobId,
  });
}

module.exports = { notifyPlanSubmission, parseTaggedIds, BROADCAST_ROLES };
