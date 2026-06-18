'use strict';
//
// Merge two duplicate workers into one.
//
//   A "worker" = an `employees` row + its linked `crew_members` row
//   (employees.linked_crew_member_id). Duplicates arise from imports / older
//   pre-dedup induction approvals. Merging moves EVERY child record off the
//   loser onto the winner, reconciles the scalar profile fields (staff choose
//   the conflicts), then SOFT-deactivates the loser — never hard-deletes,
//   because several audit tables reference crew_members without a foreign key
//   and a hard delete would either orphan or CASCADE them away.
//
//   The child-move is schema-introspecting rather than a hardcoded table list:
//   we walk every table, and for any column that is a known worker-reference
//   we re-point loser→winner. UNIQUE constraints are detected via PRAGMA so we
//   move only non-colliding rows and drop the leftover duplicates (a blind
//   UPDATE would throw on the collision). This keeps the merge correct as the
//   schema grows, instead of silently missing a table someone added later.
//

// Columns that reference employees(id).
const EMP_REF_COLS = new Set(['employee_id', 'manager_id']);
// Columns that reference crew_members(id) (incl. the kudos/birthday variants).
const CREW_REF_COLS = new Set([
  'crew_member_id', 'sender_crew_id', 'recipient_crew_id', 'reporter_crew_id',
  'blocker_crew_id', 'blocked_crew_id', 'target_crew_member_id',
  'from_crew_member_id', 'created_by_crew_id',
]);

// Never offer these employees columns as merge choices — identity, audit, and
// link bookkeeping the merge manages itself.
const EMP_SKIP = new Set([
  'id', 'employee_code', 'created_at', 'updated_at', 'deleted_at',
  'merged_into_id', 'linked_crew_member_id', 'linked_user_id',
]);
// crew_members columns to leave on the winner untouched.
const CREW_SKIP = new Set([
  'id', 'created_at', 'updated_at', 'merged_into_id',
  'pin_hash', 'pin_plain', 'pin_set_at', 'pin_set_by_id', 'pin_locked_until',
  'pin_failed_attempts', 'worker_login_count', 'last_worker_login',
]);

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function colInfo(db, table) {
  try { return db.prepare(`PRAGMA table_info("${table}")`).all(); } catch (e) { return []; }
}
function colNames(db, table) { return colInfo(db, table).map(c => c.name); }

// All UNIQUE column-groups for a table (explicit unique indexes + the PK).
function uniqueGroups(db, table) {
  const groups = [];
  try {
    for (const idx of db.prepare(`PRAGMA index_list("${table}")`).all()) {
      if (!idx.unique) continue;
      const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all().map(c => c.name).filter(Boolean);
      if (cols.length) groups.push(cols);
    }
  } catch (e) { /* no indexes */ }
  const pk = colInfo(db, table).filter(c => c.pk).map(c => c.name);
  if (pk.length) groups.push(pk);
  return groups;
}

const isEmpty = (v) => v === null || v === undefined || v === '';

// Re-point one (table, column) from loser id → winner id, honouring any UNIQUE
// constraint the column participates in. Returns the number of rows moved.
function repointColumn(db, table, col, fromId, toId) {
  if (!tableExists(db, table)) return 0;
  if (!colNames(db, table).includes(col)) return 0;
  const moved = db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE "${col}" = ?`).get(fromId).c;
  if (!moved) return 0;

  const groups = uniqueGroups(db, table);
  const soleUnique = groups.find(g => g.length === 1 && g[0] === col);
  const composite = groups.find(g => g.includes(col) && g.length > 1);

  if (soleUnique) {
    // One row per worker keyed solely by this column (PK / single-col UNIQUE).
    // Keep the winner's row if present, otherwise hand the loser's over.
    const winnerHas = db.prepare(`SELECT 1 FROM "${table}" WHERE "${col}" = ?`).get(toId);
    if (winnerHas) db.prepare(`DELETE FROM "${table}" WHERE "${col}" = ?`).run(fromId);
    else db.prepare(`UPDATE "${table}" SET "${col}" = ? WHERE "${col}" = ?`).run(toId, fromId);
    return moved;
  }

  if (composite) {
    // Move only loser rows whose other-key values don't already exist for the
    // winner (`IS` so NULLs compare equal); delete the colliding leftovers.
    const others = composite.filter(c => c !== col);
    const notExists = others.map(c => `t2."${c}" IS "${table}"."${c}"`).join(' AND ');
    db.prepare(`
      UPDATE "${table}" SET "${col}" = @to
      WHERE "${col}" = @from
        AND NOT EXISTS (SELECT 1 FROM "${table}" t2 WHERE t2."${col}" = @to AND ${notExists})
    `).run({ to: toId, from: fromId });
    db.prepare(`DELETE FROM "${table}" WHERE "${col}" = ?`).run(fromId);
    return moved;
  }

  // No unique constraint on this column — straight re-point.
  db.prepare(`UPDATE "${table}" SET "${col}" = ? WHERE "${col}" = ?`).run(toId, fromId);
  return moved;
}

// Walk every table and re-point all worker-reference columns loser→winner.
// `empFrom`/`empTo` are employees.id; `crewFrom`/`crewTo` are crew_members.id
// (either crew id may be null when a side has no linked crew member).
function moveAllChildren(db, { empFrom, empTo, crewFrom, crewTo }) {
  const summary = {};
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  for (const table of tables) {
    for (const col of colNames(db, table)) {
      // Don't rewrite the base rows' own identity/link columns here.
      if (table === 'employees' && (col === 'id' || col === 'linked_crew_member_id')) continue;
      if (table === 'crew_members' && col === 'id') continue;

      let n = 0;
      if (EMP_REF_COLS.has(col) && empFrom && empTo) {
        n = repointColumn(db, table, col, empFrom, empTo);
      } else if (CREW_REF_COLS.has(col) && crewFrom && crewTo) {
        n = repointColumn(db, table, col, crewFrom, crewTo);
      }
      if (n) summary[`${table}.${col}`] = (summary[`${table}.${col}`] || 0) + n;
    }
  }
  return summary;
}

// Load a worker (employee + linked crew + child-record counts) for the preview.
function loadWorker(db, employeeId) {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) return null;
  const crew = employee.linked_crew_member_id
    ? db.prepare('SELECT * FROM crew_members WHERE id = ?').get(employee.linked_crew_member_id)
    : null;
  const count = (table, col, id) => {
    if (id == null || !tableExists(db, table) || !colNames(db, table).includes(col)) return 0;
    try { return db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE "${col}" = ?`).get(id).c; } catch (e) { return 0; }
  };
  const counts = {
    documents: count('employee_documents', 'employee_id', employee.id),
    competencies: count('employee_competencies', 'employee_id', employee.id),
    bank_accounts: count('bank_accounts', 'employee_id', employee.id),
    super_funds: count('super_funds', 'employee_id', employee.id),
    tfn_declarations: count('tfn_declarations', 'employee_id', employee.id),
    payslips: count('payslips', 'employee_id', employee.id),
    pay_run_lines: count('pay_run_lines', 'employee_id', employee.id),
    allocations: count('crew_allocations', 'crew_member_id', employee.linked_crew_member_id),
    clock_events: count('clock_events', 'crew_member_id', employee.linked_crew_member_id),
  };
  counts._docs_and_comps = counts.documents + counts.competencies;
  return { employee, crew, counts };
}

// Pick the default survivor: the profile that HAS competencies + documents (per
// the requirement). Tie-break on more child data overall, then lower id (older).
function chooseWinner(a, b) {
  const score = (w) => w.counts._docs_and_comps * 1000
    + w.counts.bank_accounts + w.counts.super_funds + w.counts.tfn_declarations
    + w.counts.payslips + w.counts.allocations;
  if (score(a) !== score(b)) return score(a) > score(b) ? a : b;
  return a.employee.id <= b.employee.id ? a : b;
}

// Conflicting scalar fields between winner and loser for a given table.
// - both non-empty & differ  → a genuine conflict the staff must resolve.
// - winner empty, loser set   → auto-filled from the loser (nothing dropped).
function diffFields(db, table, winnerRow, loserRow, skip) {
  const conflicts = [];
  const autofill = [];
  for (const col of colNames(db, table)) {
    if (skip.has(col)) continue;
    const w = winnerRow ? winnerRow[col] : null;
    const l = loserRow ? loserRow[col] : null;
    if (w === l) continue;
    if (isEmpty(w) && !isEmpty(l)) { autofill.push({ col, value: l }); continue; }
    if (!isEmpty(w) && isEmpty(l)) continue; // keep winner
    if (isEmpty(w) && isEmpty(l)) continue;
    conflicts.push({ col, winner: w, loser: l }); // both set & differ
  }
  return { conflicts, autofill };
}

// Build the full preview payload for the merge confirmation screen.
// `forcedWinnerId` lets staff override the auto-chosen survivor (the "swap"
// button) — otherwise the profile with competencies + documents wins.
function buildPreview(db, empIdA, empIdB, forcedWinnerId) {
  const a = loadWorker(db, empIdA);
  const b = loadWorker(db, empIdB);
  if (!a || !b) return { error: 'One or both workers not found.' };
  if (a.employee.id === b.employee.id) return { error: 'Pick two different workers.' };
  if (a.employee.merged_into_id || b.employee.merged_into_id) return { error: 'One of these profiles has already been merged.' };

  let winner;
  const fw = parseInt(forcedWinnerId, 10);
  if (fw === a.employee.id) winner = a;
  else if (fw === b.employee.id) winner = b;
  else winner = chooseWinner(a, b);
  const loser = winner === a ? b : a;
  const empDiff = diffFields(db, 'employees', winner.employee, loser.employee, EMP_SKIP);
  const crewDiff = (winner.crew || loser.crew)
    ? diffFields(db, 'crew_members', winner.crew || {}, loser.crew || {}, CREW_SKIP)
    : { conflicts: [], autofill: [] };
  return { winner, loser, empDiff, crewDiff };
}

// Execute the merge in a single transaction. `fieldChoices` = { emp: {col: 'loser'}, crew: {col:'loser'} }
// — any col set to 'loser' takes the loser's value; everything else keeps the
// winner's (auto-fills always apply). Returns a summary of moved child rows.
function executeMerge(db, { winnerEmpId, loserEmpId, fieldChoices, userId }) {
  const run = db.transaction(() => {
    const winner = loadWorker(db, winnerEmpId);
    const loser = loadWorker(db, loserEmpId);
    if (!winner || !loser) throw new Error('Worker not found.');
    if (winner.employee.id === loser.employee.id) throw new Error('Cannot merge a worker into itself.');
    if (winner.employee.merged_into_id || loser.employee.merged_into_id) throw new Error('Already merged.');

    const choices = fieldChoices || {};
    const empCols = new Set(colNames(db, 'employees'));
    const crewCols = new Set(colNames(db, 'crew_members'));

    // 1) Reconcile employees scalar fields onto the winner.
    {
      const { conflicts, autofill } = diffFields(db, 'employees', winner.employee, loser.employee, EMP_SKIP);
      const sets = [], params = [];
      for (const f of autofill) { sets.push(`"${f.col}" = ?`); params.push(f.value); }
      for (const c of conflicts) {
        if (choices.emp && choices.emp[c.col] === 'loser') { sets.push(`"${c.col}" = ?`); params.push(c.loser); }
      }
      if (sets.length) {
        if (empCols.has('updated_at')) sets.push('updated_at = CURRENT_TIMESTAMP');
        db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...params, winner.employee.id);
      }
    }

    // 2) Reconcile crew_members scalar fields (when the winner has a crew row).
    const winnerCrewId = winner.employee.linked_crew_member_id;
    const loserCrewId = loser.employee.linked_crew_member_id;
    if (winnerCrewId && winner.crew && loser.crew) {
      const { conflicts, autofill } = diffFields(db, 'crew_members', winner.crew, loser.crew, CREW_SKIP);
      const sets = [], params = [];
      for (const f of autofill) { sets.push(`"${f.col}" = ?`); params.push(f.value); }
      for (const c of conflicts) {
        if (choices.crew && choices.crew[c.col] === 'loser') { sets.push(`"${c.col}" = ?`); params.push(c.loser); }
      }
      if (sets.length) {
        if (crewCols.has('updated_at')) sets.push('updated_at = CURRENT_TIMESTAMP');
        db.prepare(`UPDATE crew_members SET ${sets.join(', ')} WHERE id = ?`).run(...params, winnerCrewId);
      }
    }

    // 3) Move every child record loser→winner (employees + crew sides).
    const summary = moveAllChildren(db, {
      empFrom: loser.employee.id, empTo: winner.employee.id,
      crewFrom: loserCrewId, crewTo: winnerCrewId,
    });

    // 4) If the winner had no crew but the loser did, hand the loser's crew to
    //    the winner so portal access survives (its children already point there).
    if (!winnerCrewId && loserCrewId) {
      db.prepare('UPDATE employees SET linked_crew_member_id = ? WHERE id = ?').run(loserCrewId, winner.employee.id);
    }

    // 5) Soft-deactivate the loser. Keep the rows (audit trail) but point them
    //    at the survivor and pull them out of every active list.
    const eSet = ['merged_into_id = ?'];
    const eParams = [winner.employee.id];
    if (empCols.has('deleted_at')) eSet.push("deleted_at = CURRENT_TIMESTAMP");
    if (empCols.has('active')) eSet.push('active = 0');
    if (empCols.has('employment_status')) { eSet.push('employment_status = ?'); eParams.push('merged'); }
    if (empCols.has('updated_at')) eSet.push('updated_at = CURRENT_TIMESTAMP');
    db.prepare(`UPDATE employees SET ${eSet.join(', ')} WHERE id = ?`).run(...eParams, loser.employee.id);

    // Only deactivate the loser's crew when it's genuinely a different crew row
    // that we drained (step 3). If we re-homed it to the winner (step 4), leave it.
    if (loserCrewId && loserCrewId !== winnerCrewId && winnerCrewId) {
      const cSet = ['merged_into_id = ?'];
      const cParams = [winnerCrewId];
      if (crewCols.has('active')) cSet.push('active = 0');
      if (crewCols.has('status')) { cSet.push('status = ?'); cParams.push('merged'); }
      if (crewCols.has('updated_at')) cSet.push('updated_at = CURRENT_TIMESTAMP');
      db.prepare(`UPDATE crew_members SET ${cSet.join(', ')} WHERE id = ?`).run(...cParams, loserCrewId);
    }

    return {
      winnerEmpId: winner.employee.id,
      loserEmpId: loser.employee.id,
      winnerName: winner.employee.full_name,
      loserName: loser.employee.full_name,
      moved: summary,
    };
  });
  return run();
}

module.exports = { buildPreview, executeMerge, loadWorker, chooseWinner };
