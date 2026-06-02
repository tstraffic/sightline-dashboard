/**
 * Centralised job number generation — J-XXXX format.
 * All routes (projects, jobs, opportunities) use this single function.
 */
const { getDb } = require('../db/database');

/**
 * Generate the next sequential job number in J-XXXX format.
 * Uses the job_code_sequence table for atomic increment.
 *
 * Self-healing: if the sequence has fallen out of sync with the
 * actual jobs table (e.g. after a DB import / restore where rows
 * were inserted without bumping the sequence), the next call would
 * otherwise produce a number that already exists and the INSERT
 * would explode with a UNIQUE constraint. Instead we bump the
 * sequence forward until we land on an unused number — bounded
 * to a safe ceiling so a corrupted sequence can't spin forever.
 *
 * @returns {string} e.g. "J-0015"
 */
function generateJobNumber() {
  const db = getDb();
  const used = db.prepare('SELECT 1 FROM jobs WHERE job_number = ?');
  const bump = db.prepare('UPDATE job_code_sequence SET last_number = last_number + 1 WHERE id = 1');
  const peek = db.prepare('SELECT last_number FROM job_code_sequence WHERE id = 1');

  for (let i = 0; i < 10000; i++) {
    bump.run();
    const n = peek.get().last_number;
    const candidate = 'J-' + String(n).padStart(4, '0');
    if (!used.get(candidate)) return candidate;
  }
  throw new Error('Could not allocate a free job number after 10000 attempts — check job_code_sequence');
}

module.exports = { generateJobNumber };
