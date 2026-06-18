// Shared crew-member de-duplication used by every path that creates a roster
// record (recruitment "Hired" conversion, induction-form approval/convert) so a
// person who flows through more than one path isn't added twice. Single source
// of truth — the previous per-path copies drifted, which is what let the same
// person land as two profiles with different phone formats.
//
// Matches on email (strongest) → phone (normalised to the last 9 digits, so
// 0410 236 948 / 0410236948 / +61 410 236 948 all compare equal) → normalised
// full name, across BOTH crew_members and employees (following
// employees.linked_crew_member_id back to a crew_member). Deliberately ignores
// active/deleted_at so an archived or renamed-but-deactivated dupe is still
// caught — that gap is what let duplicates through.

function normalizePhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Returns { id, full_name, employee_id } of the crew_member to link to, or null.
// fields: { email, phone, fullName, excludeId }
function findExistingCrew(db, { email, phone, fullName, excludeId } = {}) {
  const e = normalizeEmail(email);
  const np = normalizePhone(phone);
  const name = normalizeName(fullName);
  const ex = excludeId ? ` AND id != ${parseInt(excludeId, 10)} ` : ' ';
  const out = (r) => (r ? { id: r.id, full_name: r.full_name, employee_id: r.employee_id } : null);
  const phoneMatch = (rows) => rows.find(c => normalizePhone(c.phone) === np);

  // 1) crew_members direct — email, then phone (last-9), then name.
  if (e) {
    const r = db.prepare(`SELECT id, full_name, employee_id FROM crew_members WHERE LOWER(TRIM(COALESCE(email,''))) = ?${ex}ORDER BY id DESC LIMIT 1`).get(e);
    if (r) return out(r);
  }
  if (np.length >= 8) {
    const r = phoneMatch(db.prepare(`SELECT id, full_name, employee_id, phone FROM crew_members WHERE COALESCE(phone,'') != ''${ex}`).all());
    if (r) return out(r);
  }
  if (name) {
    const r = db.prepare(`SELECT id, full_name, employee_id FROM crew_members WHERE LOWER(TRIM(COALESCE(full_name,''))) = ?${ex}ORDER BY id DESC LIMIT 1`).get(name);
    if (r) return out(r);
  }

  // 2) employees side — a worker created in HR without a crew_members row won't
  //    match above; follow the link back to their crew_member.
  const crewById = db.prepare('SELECT id, full_name, employee_id FROM crew_members WHERE id = ?');
  let emp = null;
  if (e) emp = db.prepare("SELECT linked_crew_member_id FROM employees WHERE LOWER(TRIM(COALESCE(email,''))) = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(e);
  if (!emp && np.length >= 8) emp = phoneMatch(db.prepare("SELECT linked_crew_member_id, phone FROM employees WHERE COALESCE(phone,'') != '' AND deleted_at IS NULL").all()) || null;
  if (!emp && name) emp = db.prepare("SELECT linked_crew_member_id FROM employees WHERE LOWER(TRIM(COALESCE(full_name,''))) = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(name);
  if (emp && emp.linked_crew_member_id) {
    const r = crewById.get(emp.linked_crew_member_id);
    if (r) return out(r);
  }
  return null;
}

module.exports = { normalizePhone, normalizeEmail, normalizeName, findExistingCrew };
