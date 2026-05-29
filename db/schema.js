const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'tstraffic.db');

function runMigrations(db) {
  // Create migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const isMigrationApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordMigration = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  // ── Whitelabel-prep seed gates (Phase A audit fix) ──
  // Some historical seed migrations imported T&S customer-operational data
  // (Villawood depot crew, 2026 TGS Register, Abergeldie client list, T&S
  // fleet) or test fixtures (EMP-TEST/PIN-1234 dummy worker). Fresh white-
  // label deployments must not inherit any of that, so the seed bodies are
  // gated by the env vars below. Defaults to skip.
  //
  // T&S production is unaffected: these migrations were recorded in
  // schema_migrations months ago, so they don't re-run anyway. The gates
  // matter only for new (buyer) deployments and dev DB rebuilds.
  //
  // To re-hydrate a fresh T&S-like DB (staging, restore-from-scratch),
  // set SEED_T_AND_S_DATA=true. For dev/staging that wants the EMP-TEST
  // preview account, set SEED_TEST_USERS=true.
  const SEED_T_AND_S_DATA = process.env.SEED_T_AND_S_DATA === 'true';
  const SEED_TEST_USERS = process.env.SEED_TEST_USERS === 'true';

  // =============================================
  // Migration 1: Job Register Improvements
  // =============================================
  if (!isMigrationApplied.get(1)) {
    console.log('Running migration 1: Job Register Improvements');

    // Add new columns to jobs (use try/catch for each since column may already exist)
    const newJobCols = [
      "ALTER TABLE jobs ADD COLUMN client_project_number TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN project_name TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN principal_contractor TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN traffic_supervisor_id INTEGER REFERENCES users(id)",
      "ALTER TABLE jobs ADD COLUMN contract_value REAL DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN estimated_hours REAL DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN crew_size INTEGER DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN rol_required INTEGER DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN tmp_required INTEGER DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN sharepoint_url TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN state TEXT DEFAULT 'NSW'",
    ];
    for (const sql of newJobCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Recreate jobs table to update status CHECK constraint
    // Check if migration is already done by looking for 'tender' in the CHECK constraint
    let needsRecreate = true;
    try {
      // If we can insert 'tender' status, the new CHECK is already in place
      db.exec("CREATE TABLE _migration_test_jobs AS SELECT * FROM jobs WHERE 0");
      db.exec("DROP TABLE _migration_test_jobs");
      // Try a more reliable check: see if the old constraint rejects 'tender'
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'tender'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed with recreation */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE jobs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_number TEXT UNIQUE NOT NULL,
            job_name TEXT NOT NULL,
            client TEXT NOT NULL,
            site_address TEXT NOT NULL,
            suburb TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'tender' CHECK(status IN ('tender','won','prestart','active','on_hold','completed','closed')),
            stage TEXT NOT NULL DEFAULT 'tender' CHECK(stage IN ('tender','prestart','delivery','closeout')),
            percent_complete INTEGER NOT NULL DEFAULT 0 CHECK(percent_complete >= 0 AND percent_complete <= 100),
            start_date DATE NOT NULL,
            end_date DATE,
            project_manager_id INTEGER REFERENCES users(id),
            ops_supervisor_id INTEGER REFERENCES users(id),
            planning_owner_id INTEGER REFERENCES users(id),
            marketing_owner_id INTEGER REFERENCES users(id),
            accounts_owner_id INTEGER REFERENCES users(id),
            health TEXT NOT NULL DEFAULT 'green' CHECK(health IN ('green','amber','red')),
            accounts_status TEXT NOT NULL DEFAULT 'na' CHECK(accounts_status IN ('na','on_track','overdue','disputed')),
            division_tags TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            last_update_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            client_project_number TEXT DEFAULT '',
            project_name TEXT DEFAULT '',
            principal_contractor TEXT DEFAULT '',
            traffic_supervisor_id INTEGER REFERENCES users(id),
            contract_value REAL DEFAULT 0,
            estimated_hours REAL DEFAULT 0,
            crew_size INTEGER DEFAULT 0,
            rol_required INTEGER DEFAULT 0,
            tmp_required INTEGER DEFAULT 0,
            sharepoint_url TEXT DEFAULT '',
            state TEXT DEFAULT 'NSW'
          );
        `);

        db.exec(`
          INSERT INTO jobs_new (
            id, job_number, job_name, client, site_address, suburb,
            status, stage, percent_complete, start_date, end_date,
            project_manager_id, ops_supervisor_id, planning_owner_id,
            marketing_owner_id, accounts_owner_id, health, accounts_status,
            division_tags, notes, last_update_date, created_at, updated_at,
            client_project_number, project_name, principal_contractor,
            traffic_supervisor_id, contract_value, estimated_hours,
            crew_size, rol_required, tmp_required, sharepoint_url, state
          )
          SELECT
            id, job_number, job_name, client, site_address, suburb,
            CASE status WHEN 'lead' THEN 'tender' WHEN 'lost' THEN 'closed' ELSE status END,
            stage, percent_complete, start_date, end_date,
            project_manager_id, ops_supervisor_id, planning_owner_id,
            marketing_owner_id, accounts_owner_id, health, accounts_status,
            division_tags, notes, last_update_date, created_at, updated_at,
            client_project_number, project_name, principal_contractor,
            traffic_supervisor_id, contract_value, estimated_hours,
            crew_size, rol_required, tmp_required, sharepoint_url, state
          FROM jobs;
        `);

        db.exec('DROP TABLE jobs');
        db.exec('ALTER TABLE jobs_new RENAME TO jobs');

        // Recreate all indexes on jobs
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
          CREATE INDEX IF NOT EXISTS idx_jobs_job_number ON jobs(job_number);
          CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
          CREATE INDEX IF NOT EXISTS idx_jobs_suburb ON jobs(suburb);
          CREATE INDEX IF NOT EXISTS idx_jobs_health ON jobs(health);
          CREATE INDEX IF NOT EXISTS idx_jobs_pm ON jobs(project_manager_id);
          CREATE INDEX IF NOT EXISTS idx_jobs_start_date ON jobs(start_date);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(1, 'Job Register Improvements');
    console.log('Migration 1 complete.');
  }

  // =============================================
  // Migration 2: Audit Log Enhancement
  // =============================================
  if (!isMigrationApplied.get(2)) {
    console.log('Running migration 2: Audit Log Enhancement');

    const auditCols = [
      "ALTER TABLE activity_log ADD COLUMN before_value TEXT DEFAULT ''",
      "ALTER TABLE activity_log ADD COLUMN after_value TEXT DEFAULT ''",
    ];
    for (const sql of auditCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(2, 'Audit Log Enhancement');
    console.log('Migration 2 complete.');
  }

  // =============================================
  // Migration 3: Crew Competency
  // =============================================
  if (!isMigrationApplied.get(3)) {
    console.log('Running migration 3: Crew Competency');

    const crewCols = [
      "ALTER TABLE crew_members ADD COLUMN tcp_level TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN white_card TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN white_card_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN first_aid TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN first_aid_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN tc_ticket TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN tc_ticket_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN ti_ticket TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN ti_ticket_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN induction_status TEXT DEFAULT 'pending'",
      "ALTER TABLE crew_members ADD COLUMN company TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN medical_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN employment_type TEXT DEFAULT 'employee'",
      "ALTER TABLE crew_members ADD COLUMN status TEXT DEFAULT 'active'",
    ];
    for (const sql of crewCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(3, 'Crew Competency');
    console.log('Migration 3 complete.');
  }

  // =============================================
  // Migration 4: Equipment Register
  // =============================================
  if (!isMigrationApplied.get(4)) {
    console.log('Running migration 4: Equipment Register');

    const equipCols = [
      "ALTER TABLE equipment ADD COLUMN registration TEXT DEFAULT ''",
      "ALTER TABLE equipment ADD COLUMN location TEXT DEFAULT ''",
    ];
    for (const sql of equipCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Recreate equipment table to expand category CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='equipment'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'ute'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE equipment_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_number TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('ute','truck','arrow_board','vms_board','trailer','barriers','signs','lights','cone','delineator','vehicle','lighting','barrier','sign','vms','other')),
            description TEXT DEFAULT '',
            serial_number TEXT DEFAULT '',
            purchase_date DATE,
            purchase_cost REAL DEFAULT 0,
            current_condition TEXT NOT NULL DEFAULT 'good' CHECK(current_condition IN ('new','good','fair','poor','damaged','decommissioned')),
            storage_location TEXT DEFAULT '',
            next_inspection_date DATE,
            inspection_interval_days INTEGER DEFAULT 90,
            notes TEXT DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            registration TEXT DEFAULT '',
            location TEXT DEFAULT ''
          );
        `);

        db.exec(`
          INSERT INTO equipment_new (
            id, asset_number, name, category, description, serial_number,
            purchase_date, purchase_cost, current_condition, storage_location,
            next_inspection_date, inspection_interval_days, notes, active,
            created_at, updated_at, registration, location
          )
          SELECT
            id, asset_number, name, category, description, serial_number,
            purchase_date, purchase_cost, current_condition, storage_location,
            next_inspection_date, inspection_interval_days, notes, active,
            created_at, updated_at, registration, location
          FROM equipment;
        `);

        db.exec('DROP TABLE equipment');
        db.exec('ALTER TABLE equipment_new RENAME TO equipment');

        // Recreate all indexes on equipment
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(category);
          CREATE INDEX IF NOT EXISTS idx_equipment_active ON equipment(active);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(4, 'Equipment Register');
    console.log('Migration 4 complete.');
  }

  // =============================================
  // Migration 5: Incident Upgrade
  // =============================================
  if (!isMigrationApplied.get(5)) {
    console.log('Running migration 5: Incident Upgrade');

    const incidentCols = [
      "ALTER TABLE incidents ADD COLUMN traffic_disruption TEXT DEFAULT ''",
      "ALTER TABLE incidents ADD COLUMN police_notified INTEGER DEFAULT 0",
      "ALTER TABLE incidents ADD COLUMN client_notified INTEGER DEFAULT 0",
      "ALTER TABLE incidents ADD COLUMN close_out_date DATE",
    ];
    for (const sql of incidentCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Recreate incidents table to expand incident_type CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='incidents'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'traffic_incident'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE incidents_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            incident_number TEXT UNIQUE NOT NULL,
            incident_type TEXT NOT NULL CHECK(incident_type IN ('near_miss','traffic_incident','worker_injury','vehicle_damage','public_complaint','environmental','injury','hazard','property_damage','vehicle','other')),
            severity TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            location TEXT DEFAULT '',
            incident_date DATE NOT NULL,
            incident_time TEXT DEFAULT '',
            reported_by_id INTEGER NOT NULL REFERENCES users(id),
            persons_involved TEXT DEFAULT '',
            witnesses TEXT DEFAULT '',
            immediate_actions TEXT DEFAULT '',
            root_cause TEXT DEFAULT '',
            investigation_status TEXT NOT NULL DEFAULT 'reported' CHECK(investigation_status IN ('reported','investigating','resolved','closed')),
            notifiable_incident INTEGER NOT NULL DEFAULT 0,
            photo_path TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            traffic_disruption TEXT DEFAULT '',
            police_notified INTEGER DEFAULT 0,
            client_notified INTEGER DEFAULT 0,
            close_out_date DATE
          );
        `);

        db.exec(`
          INSERT INTO incidents_new (
            id, job_id, incident_number, incident_type, severity, title,
            description, location, incident_date, incident_time, reported_by_id,
            persons_involved, witnesses, immediate_actions, root_cause,
            investigation_status, notifiable_incident, photo_path,
            created_at, updated_at, traffic_disruption, police_notified,
            client_notified, close_out_date
          )
          SELECT
            id, job_id, incident_number, incident_type, severity, title,
            description, location, incident_date, incident_time, reported_by_id,
            persons_involved, witnesses, immediate_actions, root_cause,
            investigation_status, notifiable_incident, photo_path,
            created_at, updated_at, traffic_disruption, police_notified,
            client_notified, close_out_date
          FROM incidents;
        `);

        db.exec('DROP TABLE incidents');
        db.exec('ALTER TABLE incidents_new RENAME TO incidents');

        // Recreate all indexes on incidents
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_incidents_job ON incidents(job_id);
          CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(investigation_status);
          CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
          CREATE INDEX IF NOT EXISTS idx_incidents_date ON incidents(incident_date);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(5, 'Incident Upgrade');
    console.log('Migration 5 complete.');
  }

  // =============================================
  // Migration 6: Compliance Register
  // =============================================
  if (!isMigrationApplied.get(6)) {
    console.log('Running migration 6: Compliance Register');

    // Recreate compliance table to expand item_type CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='compliance'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'rol'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE compliance_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','other')),
            title TEXT NOT NULL,
            authority_approver TEXT DEFAULT '',
            internal_approver_id INTEGER REFERENCES users(id),
            due_date DATE NOT NULL,
            submitted_date DATE,
            approved_date DATE,
            expiry_date DATE,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
            document_path TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        db.exec(`
          INSERT INTO compliance_new (
            id, job_id, item_type, title, authority_approver, internal_approver_id,
            due_date, submitted_date, approved_date, expiry_date, status,
            document_path, notes, created_at, updated_at
          )
          SELECT
            id, job_id, item_type, title, authority_approver, internal_approver_id,
            due_date, submitted_date, approved_date, expiry_date, status,
            document_path, notes, created_at, updated_at
          FROM compliance;
        `);

        db.exec('DROP TABLE compliance');
        db.exec('ALTER TABLE compliance_new RENAME TO compliance');

        // Recreate all indexes on compliance
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
          CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
          CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(6, 'Compliance Register');
    console.log('Migration 6 complete.');
  }

  // =============================================
  // Migration 7: Notification Expansion
  // =============================================
  if (!isMigrationApplied.get(7)) {
    console.log('Running migration 7: Notification Expansion');

    // Recreate notifications table to expand type CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'rol_pending'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE notifications_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','new_incident','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','timesheet_approval','budget_alert','general','rol_pending','ticket_expiry','equipment_inspection_due','induction_overdue')),
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            link TEXT DEFAULT '',
            job_id INTEGER REFERENCES jobs(id),
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        db.exec(`
          INSERT INTO notifications_new (
            id, user_id, type, title, message, link, job_id, is_read, created_at
          )
          SELECT
            id, user_id, type, title, message, link, job_id, is_read, created_at
          FROM notifications;
        `);

        db.exec('DROP TABLE notifications');
        db.exec('ALTER TABLE notifications_new RENAME TO notifications');

        // Recreate all indexes on notifications
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
          CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
          CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(7, 'Notification Expansion');
    console.log('Migration 7 complete.');
  }

  // =============================================
  // Migration 8: Traffic Plans table (NEW)
  // =============================================
  if (!isMigrationApplied.get(8)) {
    console.log('Running migration 8: Traffic Plans table');

    db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        plan_number TEXT UNIQUE NOT NULL,
        plan_type TEXT NOT NULL CHECK(plan_type IN ('TGS','TCP','TMP')),
        designer TEXT DEFAULT '',
        rol_required INTEGER DEFAULT 0,
        rol_submitted INTEGER DEFAULT 0,
        rol_approved INTEGER DEFAULT 0,
        council TEXT DEFAULT '',
        tfnsw TEXT DEFAULT '',
        submitted_date DATE,
        approval_date DATE,
        approved_date DATE,
        expiry_date DATE,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','under_review','approved','rejected','expired')),
        file_link TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_traffic_plans_job ON traffic_plans(job_id);
      CREATE INDEX IF NOT EXISTS idx_traffic_plans_status ON traffic_plans(status);
      CREATE INDEX IF NOT EXISTS idx_traffic_plans_type ON traffic_plans(plan_type);
      CREATE INDEX IF NOT EXISTS idx_traffic_plans_expiry ON traffic_plans(expiry_date);
    `);

    recordMigration.run(8, 'Traffic Plans table');
    console.log('Migration 8 complete.');
  }

  // =============================================
  // Migration 9: Budget Enhancements
  // =============================================
  if (!isMigrationApplied.get(9)) {
    console.log('Running migration 9: Budget Enhancements');

    const budgetCols = [
      "ALTER TABLE cost_entries ADD COLUMN receipt_url TEXT DEFAULT ''",
      "ALTER TABLE job_budgets ADD COLUMN budget_contingency REAL NOT NULL DEFAULT 0",
    ];
    for (const sql of budgetCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Expand notifications type CHECK to include over_budget
    let needsNotifRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'over_budget'")) {
        needsNotifRecreate = false;
      }
    } catch (e) { }

    if (needsNotifRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE notifications_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','rol_pending','ticket_expiry','equipment_inspection_due','induction_overdue','over_budget','deadline_reminder','general')),
            title TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            link TEXT DEFAULT '',
            job_id INTEGER REFERENCES jobs(id),
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO notifications_new SELECT * FROM notifications;
          DROP TABLE notifications;
          ALTER TABLE notifications_new RENAME TO notifications;
          CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
          CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
          CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
        `);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) { }
        console.log('Notification table recreation skipped:', e.message);
      }
    }

    recordMigration.run(9, 'Budget Enhancements');
    console.log('Migration 9 complete.');
  }

  // =============================================
  // Migration 10: Crew Allocations (Booking Board)
  // =============================================
  if (!isMigrationApplied.get(10)) {
    console.log('Running migration 10: Crew Allocations');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crew_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        allocation_date DATE NOT NULL,
        start_time TEXT DEFAULT '06:00',
        end_time TEXT DEFAULT '14:30',
        shift_type TEXT NOT NULL DEFAULT 'day' CHECK(shift_type IN ('day','night','split')),
        role_on_site TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'allocated' CHECK(status IN ('allocated','confirmed','declined','completed','cancelled')),
        notes TEXT DEFAULT '',
        allocated_by_id INTEGER NOT NULL REFERENCES users(id),
        confirmed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_crew_alloc_date ON crew_allocations(allocation_date);
      CREATE INDEX IF NOT EXISTS idx_crew_alloc_job ON crew_allocations(job_id);
      CREATE INDEX IF NOT EXISTS idx_crew_alloc_crew ON crew_allocations(crew_member_id);
      CREATE INDEX IF NOT EXISTS idx_crew_alloc_status ON crew_allocations(status);
    `);

    recordMigration.run(10, 'Crew Allocations');
    console.log('Migration 10 complete.');
  }

  // =============================================
  // Migration 11: Integration Hooks
  // =============================================
  if (!isMigrationApplied.get(11)) {
    console.log('Running migration 11: Integration Hooks');

    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL UNIQUE CHECK(provider IN ('traffio','quickbooks','employment_hero','teams','sharepoint')),
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT DEFAULT '{}',
        last_sync_at DATETIME,
        sync_status TEXT DEFAULT 'never' CHECK(sync_status IN ('never','syncing','success','error')),
        error_message TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('import','export','webhook')),
        entity_type TEXT NOT NULL,
        records_processed INTEGER DEFAULT 0,
        records_created INTEGER DEFAULT 0,
        records_updated INTEGER DEFAULT 0,
        records_failed INTEGER DEFAULT 0,
        error_details TEXT DEFAULT '',
        triggered_by TEXT DEFAULT 'manual',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS external_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        internal_id INTEGER NOT NULL,
        external_id TEXT NOT NULL,
        external_data TEXT DEFAULT '{}',
        last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, entity_type, internal_id),
        UNIQUE(provider, entity_type, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_ext_refs_lookup ON external_refs(provider, entity_type, external_id);
      CREATE INDEX IF NOT EXISTS idx_sync_log_provider ON sync_log(provider, started_at);
    `);

    // Seed default provider rows (all disabled)
    const seedProvider = db.prepare(`INSERT OR IGNORE INTO integration_config (provider) VALUES (?)`);
    seedProvider.run('traffio');
    seedProvider.run('quickbooks');
    seedProvider.run('employment_hero');
    seedProvider.run('teams');
    seedProvider.run('sharepoint');

    recordMigration.run(11, 'Integration Hooks');
    console.log('Migration 11 complete.');
  }

  // =============================================
  // Migration 12: Sprint 1 — Worker Profile & Allocation Blocking
  // =============================================
  if (!isMigrationApplied.get(12)) {
    console.log('Running migration 12: Worker Profile & Allocation Blocking');

    // 1. Supervisor approval fields on crew_members
    const crewCols = [
      "ALTER TABLE crew_members ADD COLUMN supervisor_approved INTEGER DEFAULT 0",
      "ALTER TABLE crew_members ADD COLUMN supervisor_approved_by_id INTEGER REFERENCES users(id)",
      "ALTER TABLE crew_members ADD COLUMN supervisor_approved_at DATETIME",
    ];
    for (const sql of crewCols) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }

    // 2. Required TCP level on jobs
    try {
      db.exec("ALTER TABLE jobs ADD COLUMN required_tcp_level TEXT DEFAULT ''");
    } catch (e) { /* column may already exist */ }

    // 3. Incident ↔ crew member link table
    db.exec(`
      CREATE TABLE IF NOT EXISTS incident_crew_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        involvement_type TEXT NOT NULL DEFAULT 'involved'
          CHECK(involvement_type IN ('involved','witness','injured','reporting')),
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(incident_id, crew_member_id)
      );
      CREATE INDEX IF NOT EXISTS idx_incident_crew_incident ON incident_crew_members(incident_id);
      CREATE INDEX IF NOT EXISTS idx_incident_crew_member ON incident_crew_members(crew_member_id);
    `);

    recordMigration.run(12, 'Worker Profile & Allocation Blocking');
    console.log('Migration 12 complete.');
  }

  // =============================================
  // Migration 13: Settings & Configuration Module
  // =============================================
  if (!isMigrationApplied.get(13)) {
    console.log('Running migration 13: Settings & Configuration Module');

    // 1. App Settings table — stores all configurable enumerations
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        color TEXT DEFAULT '',
        icon TEXT DEFAULT '',
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category, key)
      );
      CREATE INDEX IF NOT EXISTS idx_app_settings_category ON app_settings(category);
      CREATE INDEX IF NOT EXISTS idx_app_settings_active ON app_settings(category, is_active);
    `);

    // 2. System Config table — key-value store for operational parameters
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT NOT NULL UNIQUE,
        config_value TEXT NOT NULL DEFAULT '',
        config_type TEXT DEFAULT 'string',
        description TEXT DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by_id INTEGER REFERENCES users(id)
      );
    `);

    // 3. Seed all enumeration settings
    const insertSetting = db.prepare(`
      INSERT OR IGNORE INTO app_settings (category, key, label, display_order, is_active, color)
      VALUES (?, ?, ?, ?, 1, ?)
    `);

    const seedCategory = (category, items) => {
      items.forEach((item, idx) => {
        const key = typeof item === 'string' ? item : item.key;
        const label = typeof item === 'string'
          ? item.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          : item.label;
        const color = (typeof item === 'object' && item.color) ? item.color : '';
        insertSetting.run(category, key, label, idx + 1, color);
      });
    };

    // Job statuses
    seedCategory('job_status', [
      { key: 'tender', label: 'Tender', color: 'slate' },
      { key: 'won', label: 'Won', color: 'emerald' },
      { key: 'prestart', label: 'Prestart', color: 'sky' },
      { key: 'active', label: 'Active', color: 'green' },
      { key: 'on_hold', label: 'On Hold', color: 'amber' },
      { key: 'completed', label: 'Completed', color: 'blue' },
      { key: 'closed', label: 'Closed', color: 'gray' },
    ]);

    // Job stages
    seedCategory('job_stage', [
      { key: 'tender', label: 'Tender' },
      { key: 'pre_construction', label: 'Pre-Construction' },
      { key: 'mobilisation', label: 'Mobilisation' },
      { key: 'in_progress', label: 'In Progress' },
      { key: 'delivery', label: 'Delivery' },
      { key: 'demobilisation', label: 'Demobilisation' },
      { key: 'defects', label: 'Defects' },
      { key: 'closed', label: 'Closed' },
    ]);

    // Job health
    seedCategory('job_health', [
      { key: 'green', label: 'Green', color: 'green' },
      { key: 'amber', label: 'Amber', color: 'amber' },
      { key: 'red', label: 'Red', color: 'red' },
    ]);

    // Accounts status
    seedCategory('accounts_status', [
      { key: 'na', label: 'N/A', color: 'slate' },
      { key: 'on_track', label: 'On Track', color: 'green' },
      { key: 'overdue', label: 'Overdue', color: 'red' },
      { key: 'disputed', label: 'Disputed', color: 'amber' },
    ]);

    // TC levels
    seedCategory('tcp_level', [
      { key: 'beginner', label: 'Beginner' },
      { key: 'intermediate', label: 'Intermediate' },
      { key: 'team_leader', label: 'Team Leader' },
      { key: 'supervisor', label: 'Supervisor' },
    ]);

    // Incident types
    seedCategory('incident_type', [
      { key: 'near_miss', label: 'Near Miss', color: 'amber' },
      { key: 'traffic_incident', label: 'Traffic Incident', color: 'red' },
      { key: 'worker_injury', label: 'Worker Injury', color: 'red' },
      { key: 'vehicle_damage', label: 'Vehicle Damage', color: 'orange' },
      { key: 'public_complaint', label: 'Public Complaint', color: 'purple' },
      { key: 'injury', label: 'Injury', color: 'red' },
      { key: 'hazard', label: 'Hazard', color: 'amber' },
      { key: 'property_damage', label: 'Property Damage', color: 'orange' },
      { key: 'environmental', label: 'Environmental', color: 'teal' },
      { key: 'vehicle', label: 'Vehicle', color: 'blue' },
      { key: 'other', label: 'Other', color: 'slate' },
    ]);

    // Incident severity
    seedCategory('incident_severity', [
      { key: 'low', label: 'Low', color: 'green' },
      { key: 'medium', label: 'Medium', color: 'amber' },
      { key: 'high', label: 'High', color: 'orange' },
      { key: 'critical', label: 'Critical', color: 'red' },
    ]);

    // Equipment categories
    seedCategory('equipment_category', [
      { key: 'ute', label: 'Ute' },
      { key: 'truck', label: 'Truck' },
      { key: 'arrow_board', label: 'Arrow Board' },
      { key: 'vms_board', label: 'VMS Board' },
      { key: 'trailer', label: 'Trailer' },
      { key: 'barriers', label: 'Barriers' },
      { key: 'signs', label: 'Signs' },
      { key: 'lights', label: 'Lights' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'cone', label: 'Cone' },
      { key: 'delineator', label: 'Delineator' },
      { key: 'other', label: 'Other' },
    ]);

    // Crew roles
    seedCategory('crew_role', [
      { key: 'traffic_controller', label: 'Traffic Controller' },
      { key: 'leading_hand', label: 'Leading Hand' },
      { key: 'supervisor', label: 'Supervisor' },
      { key: 'pilot_vehicle', label: 'Pilot Vehicle' },
      { key: 'spotter', label: 'Spotter' },
      { key: 'labourer', label: 'Labourer' },
      { key: 'other', label: 'Other' },
    ]);

    // Employment types
    seedCategory('employment_type', [
      { key: 'employee', label: 'Employee' },
      { key: 'subcontractor', label: 'Subcontractor' },
      { key: 'casual', label: 'Casual' },
      { key: 'agency', label: 'Agency' },
    ]);

    // Defect severity
    seedCategory('defect_severity', [
      { key: 'minor', label: 'Minor', color: 'green' },
      { key: 'moderate', label: 'Moderate', color: 'amber' },
      { key: 'major', label: 'Major', color: 'orange' },
      { key: 'critical', label: 'Critical', color: 'red' },
    ]);

    // Defect status
    seedCategory('defect_status', [
      { key: 'open', label: 'Open', color: 'red' },
      { key: 'investigating', label: 'Investigating', color: 'amber' },
      { key: 'rectification', label: 'Rectification', color: 'blue' },
      { key: 'closed', label: 'Closed', color: 'green' },
      { key: 'deferred', label: 'Deferred', color: 'slate' },
    ]);

    // Task status
    seedCategory('task_status', [
      { key: 'not_started', label: 'Not Started', color: 'slate' },
      { key: 'in_progress', label: 'In Progress', color: 'blue' },
      { key: 'blocked', label: 'Blocked', color: 'red' },
      { key: 'complete', label: 'Complete', color: 'green' },
    ]);

    // Task priority
    seedCategory('task_priority', [
      { key: 'low', label: 'Low', color: 'green' },
      { key: 'medium', label: 'Medium', color: 'amber' },
      { key: 'high', label: 'High', color: 'red' },
    ]);

    seedCategory('task_type', [
      { key: 'daily', label: 'Daily', color: 'amber' },
      { key: 'weekly', label: 'Weekly', color: 'blue' },
      { key: 'one_off', label: 'One-off', color: 'slate' },
    ]);

    // Traffic plan types
    seedCategory('plan_type', [
      { key: 'TGS', label: 'Traffic Guidance Scheme' },
      { key: 'TCP', label: 'Traffic Control Plan' },
      { key: 'TMP', label: 'Traffic Management Plan' },
    ]);

    // Traffic plan status
    seedCategory('plan_status', [
      { key: 'draft', label: 'Draft', color: 'slate' },
      { key: 'submitted', label: 'Submitted', color: 'blue' },
      { key: 'under_review', label: 'Under Review', color: 'amber' },
      { key: 'approved', label: 'Approved', color: 'green' },
      { key: 'rejected', label: 'Rejected', color: 'red' },
      { key: 'expired', label: 'Expired', color: 'gray' },
    ]);

    // Shift types
    seedCategory('shift_type', [
      { key: 'day', label: 'Day', color: 'amber' },
      { key: 'night', label: 'Night', color: 'indigo' },
      { key: 'split', label: 'Split', color: 'purple' },
    ]);

    // Allocation status
    seedCategory('allocation_status', [
      { key: 'allocated', label: 'Allocated', color: 'blue' },
      { key: 'confirmed', label: 'Confirmed', color: 'green' },
      { key: 'declined', label: 'Declined', color: 'red' },
      { key: 'completed', label: 'Completed', color: 'emerald' },
      { key: 'cancelled', label: 'Cancelled', color: 'slate' },
    ]);

    // Compliance status
    seedCategory('compliance_status', [
      { key: 'not_started', label: 'Not Started', color: 'slate' },
      { key: 'submitted', label: 'Submitted', color: 'blue' },
      { key: 'approved', label: 'Approved', color: 'green' },
      { key: 'rejected', label: 'Rejected', color: 'red' },
      { key: 'expired', label: 'Expired', color: 'gray' },
    ]);

    // Australian states
    seedCategory('state', [
      { key: 'NSW', label: 'New South Wales' },
      { key: 'VIC', label: 'Victoria' },
      { key: 'QLD', label: 'Queensland' },
      { key: 'SA', label: 'South Australia' },
      { key: 'WA', label: 'Western Australia' },
      { key: 'TAS', label: 'Tasmania' },
      { key: 'NT', label: 'Northern Territory' },
      { key: 'ACT', label: 'Australian Capital Territory' },
    ]);

    // 4. Seed system configuration
    const insertConfig = db.prepare(`
      INSERT OR IGNORE INTO system_config (config_key, config_value, config_type, description)
      VALUES (?, ?, ?, ?)
    `);

    insertConfig.run('company_name', 'T&S Traffic Control', 'string', 'Company display name');
    insertConfig.run('company_tagline', 'Operations Dashboard', 'string', 'Dashboard subtitle');
    insertConfig.run('default_timezone', 'Australia/Sydney', 'string', 'Default timezone for dates');
    insertConfig.run('currency', 'AUD', 'string', 'Default currency');
    insertConfig.run('default_shift_hours', '12', 'number', 'Default shift length in hours');
    insertConfig.run('fatigue_max_days', '5', 'number', 'Max work days in fatigue window before blocked');
    insertConfig.run('fatigue_window_days', '7', 'number', 'Rolling window for fatigue calculation (days)');
    insertConfig.run('ticket_expiry_warning_days', '30', 'number', 'Days before ticket expiry to show warning');
    insertConfig.run('max_shift_length_hours', '14', 'number', 'Maximum allowed shift length in hours');
    insertConfig.run('min_rest_between_shifts_hours', '10', 'number', 'Minimum rest period between shifts in hours');

    recordMigration.run(13, 'Settings & Configuration Module');
    console.log('Migration 13 complete.');
  }

  // =============================================
  // Migration 14: Worker Portal Auth
  // =============================================
  if (!isMigrationApplied.get(14)) {
    console.log('Running migration 14: Worker Portal Auth');

    const workerCols = [
      "ALTER TABLE crew_members ADD COLUMN pin_hash TEXT",
      "ALTER TABLE crew_members ADD COLUMN pin_set_at TEXT",
      "ALTER TABLE crew_members ADD COLUMN pin_set_by_id INTEGER",
      "ALTER TABLE crew_members ADD COLUMN last_worker_login TEXT",
      "ALTER TABLE crew_members ADD COLUMN worker_login_count INTEGER DEFAULT 0",
    ];
    for (const sql of workerCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(14, 'Worker Portal Auth');
    console.log('Migration 14 complete.');
  }

  // =============================================
  // Migration 15: Client Register & Project Structure
  // =============================================
  if (!isMigrationApplied.get(15)) {
    console.log('Running migration 15: Client Register & Project Structure');

    // Create clients table
    db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT NOT NULL,
        abn TEXT DEFAULT '',
        primary_contact_name TEXT DEFAULT '',
        primary_contact_phone TEXT DEFAULT '',
        primary_contact_email TEXT DEFAULT '',
        address TEXT DEFAULT '',
        billing_address TEXT DEFAULT '',
        payment_terms TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add client_id and parent_project_id to jobs
    const newCols15 = [
      "ALTER TABLE jobs ADD COLUMN client_id INTEGER REFERENCES clients(id)",
      "ALTER TABLE jobs ADD COLUMN parent_project_id INTEGER REFERENCES jobs(id)",
    ];
    for (const sql of newCols15) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Seed clients from existing unique client text values in jobs table
    const uniqueClients = db.prepare('SELECT DISTINCT client FROM jobs WHERE client IS NOT NULL AND client != ?').all('');
    const insertClient = db.prepare('INSERT INTO clients (company_name) VALUES (?)');
    for (const row of uniqueClients) {
      try { insertClient.run(row.client); } catch (e) { /* ignore dups */ }
    }

    // Backfill client_id on jobs from the newly created clients
    db.exec(`
      UPDATE jobs SET client_id = (
        SELECT c.id FROM clients c WHERE c.company_name = jobs.client
      ) WHERE client IS NOT NULL AND client != '' AND client_id IS NULL
    `);

    recordMigration.run(15, 'Client Register & Project Structure');
    console.log('Migration 15 complete.');
  }

  // =============================================
  // Migration 16: Task Types (daily/weekly/one-off)
  // =============================================
  if (!isMigrationApplied.get(16)) {
    console.log('Running migration 16: Task Types');

    const taskCols = [
      "ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'one_off'",
    ];
    for (const sql of taskCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(16, 'Task Types');
    console.log('Migration 16 complete.');
  }

  // =============================================
  // Migration 17: SMTP Email Configuration
  // =============================================
  if (!isMigrationApplied.get(17)) {
    console.log('Running migration 17: SMTP Email Configuration');

    const insertConfig = db.prepare(`
      INSERT OR IGNORE INTO system_config (config_key, config_value, config_type, description)
      VALUES (?, ?, ?, ?)
    `);

    insertConfig.run('smtp_host', '', 'string', 'SMTP server hostname (e.g. smtp.gmail.com)');
    insertConfig.run('smtp_port', '587', 'string', 'SMTP server port (587 for TLS, 465 for SSL)');
    insertConfig.run('smtp_user', '', 'string', 'SMTP username / email address');
    insertConfig.run('smtp_pass', '', 'string', 'SMTP password or app password');
    insertConfig.run('smtp_from', 'noreply@tstraffic.com.au', 'string', 'Default sender email address');

    recordMigration.run(17, 'SMTP Email Configuration');
    console.log('Migration 17 complete.');
  }

  // =============================================
  // Migration 18: Make tasks.job_id optional
  // =============================================
  if (!isMigrationApplied.get(18)) {
    console.log('Running migration 18: Make tasks.job_id optional');

    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(`
        CREATE TABLE tasks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          owner_id INTEGER REFERENCES users(id),
          due_date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
          priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
          task_type TEXT DEFAULT 'one_off',
          notes TEXT DEFAULT '',
          completed_date DATE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO tasks_new SELECT * FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      `);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (r) {}
      console.log('Migration 18 skipped:', e.message);
    }

    recordMigration.run(18, 'Make tasks.job_id optional');
    console.log('Migration 18 complete.');
  }

  // =============================================
  // Migration 19: Fix tasks.job_id to allow NULL (explicit columns)
  // =============================================
  if (!isMigrationApplied.get(19)) {
    console.log('Running migration 19: Fix tasks.job_id nullable');

    // Check if job_id is already nullable
    const tableInfo = db.prepare("PRAGMA table_info(tasks)").all();
    const jobIdCol = tableInfo.find(c => c.name === 'job_id');
    if (jobIdCol && jobIdCol.notnull === 1) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE tasks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
            division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER NOT NULL REFERENCES users(id),
            due_date DATE NOT NULL,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
            escalation_level INTEGER NOT NULL DEFAULT 0,
            completed_date DATE,
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            task_type TEXT DEFAULT 'one_off'
          );
          INSERT INTO tasks_new (id, job_id, division, title, description, owner_id, due_date, status, priority, escalation_level, completed_date, notes, created_at, updated_at, task_type)
          SELECT id, job_id, division, title, description, owner_id, due_date, status, priority, escalation_level, completed_date, notes, created_at, updated_at, task_type FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
          CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
        `);
        db.exec('COMMIT');
        console.log('Migration 19: tasks.job_id is now nullable.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) {}
        console.log('Migration 19 error:', e.message);
      }
    } else {
      console.log('Migration 19: tasks.job_id already nullable, skipping DDL.');
    }

    recordMigration.run(19, 'Fix tasks.job_id nullable');
    console.log('Migration 19 complete.');
  }

  // Migration 20: Email Invitations & Preferences
  // =============================================
  if (!isMigrationApplied.get(20)) {
    console.log('Running migration 20: Email Invitations & Preferences');

    db.exec(`
      CREATE TABLE IF NOT EXISTS invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('admin_user', 'crew_member', 'password_reset', 'pin_reset')),
        target_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_by_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
      CREATE INDEX IF NOT EXISTS idx_invitations_target ON invitations(type, target_id);
    `);

    const emailCols = [
      "ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER DEFAULT 1",
      "ALTER TABLE users ADD COLUMN notification_frequency TEXT DEFAULT 'immediate'",
      "ALTER TABLE crew_members ADD COLUMN email_notifications_enabled INTEGER DEFAULT 1",
      "ALTER TABLE crew_members ADD COLUMN notification_frequency TEXT DEFAULT 'immediate'",
      "ALTER TABLE notifications ADD COLUMN email_sent_at DATETIME",
    ];
    for (const sql of emailCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(20, 'Email Invitations & Preferences');
    console.log('Migration 20 complete.');
  }

  // Migration 21: Add SPA to compliance item_type + assigned_to_id column
  // =============================================
  if (!isMigrationApplied.get(21)) {
    console.log('Running migration 21: Add SPA type + assigned_to_id to compliance');

    // Recreate compliance table to add 'spa' to item_type CHECK and assigned_to_id column
    try {
      db.exec(`
        CREATE TABLE compliance_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','spa','other')),
          title TEXT NOT NULL,
          authority_approver TEXT DEFAULT '',
          internal_approver_id INTEGER REFERENCES users(id),
          assigned_to_id INTEGER REFERENCES users(id),
          due_date DATE,
          submitted_date DATE,
          approved_date DATE,
          expiry_date DATE,
          status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
          notes TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO compliance_new (id, job_id, item_type, title, authority_approver, internal_approver_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at)
          SELECT id, job_id, item_type, title, authority_approver, internal_approver_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at FROM compliance;
        DROP TABLE compliance;
        ALTER TABLE compliance_new RENAME TO compliance;
        CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
        CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
        CREATE INDEX IF NOT EXISTS idx_compliance_type ON compliance(item_type);
      `);
    } catch (e) {
      console.log('Migration 21 note:', e.message);
    }

    recordMigration.run(21, 'Add SPA type and assigned_to_id to compliance');
    console.log('Migration 21 complete.');
  }

  // =============================================
  // Migration 22: Allow compliance to link to client instead of requiring a project
  // =============================================
  if (!isMigrationApplied.get(22)) {
    console.log('Running migration 22: Make job_id nullable + add client_id to compliance');
    try {
      db.exec(`
        CREATE TABLE compliance_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
          client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
          item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','spa','other')),
          title TEXT NOT NULL,
          authority_approver TEXT DEFAULT '',
          internal_approver_id INTEGER REFERENCES users(id),
          assigned_to_id INTEGER REFERENCES users(id),
          due_date DATE,
          submitted_date DATE,
          approved_date DATE,
          expiry_date DATE,
          status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
          notes TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO compliance_new (id, job_id, client_id, item_type, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at)
          SELECT id, job_id, NULL, item_type, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at FROM compliance;
        DROP TABLE compliance;
        ALTER TABLE compliance_new RENAME TO compliance;
        CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_client_id ON compliance(client_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
        CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
        CREATE INDEX IF NOT EXISTS idx_compliance_type ON compliance(item_type);
      `);
    } catch (e) {
      console.log('Migration 22 note:', e.message);
    }
    recordMigration.run(22, 'Make job_id nullable and add client_id to compliance');
    console.log('Migration 22 complete.');
  }

  // Migration 23: Was a failed attempt to rename roles via UPDATE (CHECK constraint blocked it)
  if (!isMigrationApplied.get(23)) {
    recordMigration.run(23, 'Rename roles: management->admin, accounts->finance, remove marketing (no-op, see migration 24)');
  }

  // Migration 24: was recorded but failed — skip it
  if (!isMigrationApplied.get(24)) {
    recordMigration.run(24, 'Recreate users table (no-op, see migration 25)');
  }

  // Migration 25: Recreate users table with updated role CHECK constraint
  // Must disable foreign keys to allow DROP TABLE
  if (!isMigrationApplied.get(25)) {
    console.log('Running migration 25: Recreate users table with new role CHECK');

    try {
      // Disable foreign keys so we can drop the users table
      db.pragma('foreign_keys = OFF');

      // Get column info to handle both old and new schemas
      const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const hasEmailNotif = cols.includes('email_notifications_enabled');
      const hasNotifFreq = cols.includes('notification_frequency');

      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          full_name TEXT NOT NULL,
          email TEXT,
          role TEXT NOT NULL CHECK(role IN ('admin','operations','planning','finance')),
          active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          email_notifications_enabled INTEGER DEFAULT 1,
          notification_frequency TEXT DEFAULT 'immediate'
        );
      `);

      db.exec(`
        INSERT INTO users_new (id, username, password_hash, full_name, email, role, active, created_at, email_notifications_enabled, notification_frequency)
        SELECT id, username, password_hash, full_name, email,
          CASE role
            WHEN 'management' THEN 'admin'
            WHEN 'accounts' THEN 'finance'
            WHEN 'marketing' THEN 'operations'
            ELSE role
          END,
          active, created_at,
          ${hasEmailNotif ? 'COALESCE(email_notifications_enabled, 1)' : '1'},
          ${hasNotifFreq ? "COALESCE(notification_frequency, 'immediate')" : "'immediate'"}
        FROM users;
      `);

      db.exec('DROP TABLE users;');
      db.exec('ALTER TABLE users_new RENAME TO users;');

      // Re-enable foreign keys
      db.pragma('foreign_keys = ON');

      // Also update tasks divisions
      try { db.prepare("UPDATE tasks SET division = 'admin' WHERE division = 'management'").run(); } catch (e) { /* ignore */ }
      try { db.prepare("UPDATE tasks SET division = 'finance' WHERE division = 'accounts'").run(); } catch (e) { /* ignore */ }
      try { db.prepare("UPDATE tasks SET division = 'ops' WHERE division = 'marketing'").run(); } catch (e) { /* ignore */ }

      recordMigration.run(25, 'Recreate users table with new role CHECK constraint');
      console.log('Migration 25 complete.');
    } catch (e) {
      db.pragma('foreign_keys = ON');
      // Clean up if users_new was created but not renamed
      try { db.exec('DROP TABLE IF EXISTS users_new'); } catch (re) { /* ignore */ }
      console.error('Migration 25 FAILED:', e.message);
    }
  }

  if (!isMigrationApplied.get(26)) {
    console.log('Running migration 26: Add designer, file_link, council fee fields to compliance');
    const newCols = [
      "ALTER TABLE compliance ADD COLUMN designer TEXT DEFAULT ''",
      "ALTER TABLE compliance ADD COLUMN file_link TEXT DEFAULT ''",
      "ALTER TABLE compliance ADD COLUMN council_fee_paid INTEGER DEFAULT 0",
      "ALTER TABLE compliance ADD COLUMN council_fee_amount REAL DEFAULT 0",
    ];
    for (const sql of newCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }
    recordMigration.run(26, 'Add designer, file_link, council fee fields to compliance');
    console.log('Migration 26 complete.');
  }

  // =============================================
  // Migration 27: Fix tasks division CHECK constraint
  // =============================================
  if (!isMigrationApplied.get(27)) {
    console.log('Running migration 27: Fix tasks division CHECK constraint');

    // Check current CHECK constraint by inspecting table SQL
    const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const needsFix = tableSQL && !tableSQL.sql.includes("'finance'");

    if (needsFix) {
      // Get current columns to build explicit INSERT
      const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      const colList = cols.join(', ');

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE tasks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
            division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER REFERENCES users(id),
            due_date DATE NOT NULL,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
            task_type TEXT DEFAULT 'one_off',
            notes TEXT DEFAULT '',
            completed_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
          CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
        `);
        db.exec('COMMIT');
        console.log('Migration 27: tasks table rebuilt with updated CHECK constraint.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) {}
        console.error('Migration 27 error:', e.message);
      }
    } else {
      console.log('Migration 27: CHECK constraint already correct, skipping rebuild.');
    }

    recordMigration.run(27, 'Fix tasks division CHECK constraint');
    console.log('Migration 27 complete.');
  }

  // =============================================
  // Migration 28: Force-fix tasks division CHECK constraint (retry-safe)
  // =============================================
  if (!isMigrationApplied.get(28)) {
    console.log('Running migration 28: Force-fix tasks division CHECK');

    const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const currentSQL = tableSQL ? tableSQL.sql : '';
    console.log('[Migration 28] Current tasks DDL:', currentSQL);

    if (!currentSQL.includes("'finance'") || !currentSQL.includes("'admin'")) {
      // Get only column names that actually exist in current table
      const existingCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      console.log('[Migration 28] Existing columns:', existingCols.join(', '));

      // Target columns for new table
      const targetCols = ['id','job_id','division','title','description','owner_id','due_date','status','priority','task_type','notes','completed_date','created_at','updated_at'];
      // Only copy columns present in BOTH old and new
      const commonCols = targetCols.filter(c => existingCols.includes(c));
      const colList = commonCols.join(', ');
      console.log('[Migration 28] Copying columns:', colList);

      try {
        db.exec('BEGIN TRANSACTION');
        db.exec(`
          CREATE TABLE tasks_rebuild (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
            division TEXT NOT NULL DEFAULT 'ops' CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER REFERENCES users(id),
            due_date DATE NOT NULL,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
            task_type TEXT DEFAULT 'one_off',
            notes TEXT DEFAULT '',
            completed_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db.exec(`INSERT INTO tasks_rebuild (${colList}) SELECT ${colList} FROM tasks`);
        db.exec('DROP TABLE tasks');
        db.exec('ALTER TABLE tasks_rebuild RENAME TO tasks');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)');
        db.exec('COMMIT');
        console.log('Migration 28: tasks table rebuilt successfully.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) {}
        console.error('Migration 28 FAILED:', e.message, e.stack);
        // Do NOT record migration — allow retry on next restart
        throw new Error('Migration 28 failed: ' + e.message);
      }
    } else {
      console.log('Migration 28: CHECK constraint already includes finance/admin, skipping.');
    }

    recordMigration.run(28, 'Force-fix tasks division CHECK constraint');
    console.log('Migration 28 complete.');
  }

  // =============================================
  // Migration 29: Push notification subscriptions
  // =============================================
  if (!isMigrationApplied.get(29)) {
    console.log('Running migration 29: Push notification subscriptions table');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)');
      recordMigration.run(29, 'Push notification subscriptions table');
      console.log('Migration 29 complete.');
    } catch (e) {
      console.error('Migration 29 error:', e.message);
    }
  }

  // Migration 30: Saved views + user preferences
  if (!isMigrationApplied.get(30)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_views (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          module TEXT NOT NULL,
          name TEXT NOT NULL,
          query_params TEXT NOT NULL DEFAULT '',
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id, module)');
      // Add preferences column to users if not exists
      try { db.exec("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'"); } catch (e) { /* already exists */ }
      recordMigration.run(30, 'Saved views table + user preferences column');
      console.log('Migration 30 complete.');
    } catch (e) {
      console.error('Migration 30 error:', e.message);
    }
  }

  // =============================================
  // Migration 31: Task comments, subtasks, and dependencies
  // =============================================
  if (!isMigrationApplied.get(31)) {
    console.log('Running migration 31: Task comments, subtasks, and dependencies');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id),
          comment TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS subtasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          completed INTEGER DEFAULT 0,
          completed_at DATETIME,
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS task_dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(task_id, depends_on_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on_id)');
      recordMigration.run(31, 'Task comments, subtasks, and dependencies');
      console.log('Migration 31 complete.');
    } catch (e) {
      console.error('Migration 31 error:', e.message);
    }
  }

  // =============================================
  // Migration 32: Timesheet OT split
  // =============================================
  if (!isMigrationApplied.get(32)) {
    console.log('Running migration 32: Timesheet OT split');
    try {
      const hasOrdinaryHours = db.prepare("SELECT 1 FROM pragma_table_info('timesheets') WHERE name = 'ordinary_hours'").get();
      if (!hasOrdinaryHours) {
        db.exec(`
          ALTER TABLE timesheets ADD COLUMN ordinary_hours REAL DEFAULT 0;
        `);
        db.exec(`
          ALTER TABLE timesheets ADD COLUMN overtime_hours REAL DEFAULT 0;
        `);
        // Backfill: assume 7.6 hours is ordinary, rest is OT
        db.exec(`
          UPDATE timesheets SET
            ordinary_hours = CASE WHEN total_hours <= 7.6 THEN total_hours ELSE 7.6 END,
            overtime_hours = CASE WHEN total_hours > 7.6 THEN ROUND(total_hours - 7.6, 2) ELSE 0 END
        `);
      }
      recordMigration.run(32, 'Timesheet OT split');
      console.log('Migration 32 complete.');
    } catch (e) {
      console.error('Migration 32 error:', e.message);
    }
  }

  // =============================================
  // Migration 33: Equipment status states
  // =============================================
  if (!isMigrationApplied.get(33)) {
    console.log('Running migration 33: Equipment status states');
    try {
      const hasStatus = db.prepare("SELECT 1 FROM pragma_table_info('equipment') WHERE name = 'status'").get();
      if (!hasStatus) {
        db.exec(`ALTER TABLE equipment ADD COLUMN status TEXT DEFAULT 'available'`);
        // Backfill based on current state
        db.exec(`UPDATE equipment SET status = 'retired' WHERE active = 0`);
        db.exec(`UPDATE equipment SET status = 'deployed' WHERE id IN (SELECT equipment_id FROM equipment_assignments WHERE actual_return_date IS NULL) AND active = 1`);
        db.exec(`UPDATE equipment SET status = 'inspection_due' WHERE next_inspection_date IS NOT NULL AND next_inspection_date <= date('now', '+7 days') AND active = 1 AND status = 'available'`);
        db.exec(`UPDATE equipment SET status = 'maintenance' WHERE current_condition IN ('poor', 'damaged') AND active = 1 AND status = 'available'`);
      }
      recordMigration.run(33, 'Equipment status states');
      console.log('Migration 33 complete.');
    } catch (e) {
      console.error('Migration 33 error:', e.message);
    }
  }

  // =============================================
  // Migration 34: Incident escalation + photo columns
  // =============================================
  if (!isMigrationApplied.get(34)) {
    console.log('Running migration 34: Incident escalation columns');
    try {
      const hasEscalation = db.prepare("SELECT 1 FROM pragma_table_info('incidents') WHERE name = 'escalation_level'").get();
      if (!hasEscalation) {
        db.exec(`ALTER TABLE incidents ADD COLUMN escalation_level TEXT DEFAULT 'standard'`);
        db.exec(`ALTER TABLE incidents ADD COLUMN escalated_at DATETIME`);
        db.exec(`ALTER TABLE incidents ADD COLUMN escalated_by_id INTEGER REFERENCES users(id)`);
        // Backfill: escalate based on severity and notifiable status
        db.exec(`UPDATE incidents SET escalation_level = 'elevated' WHERE severity = 'high'`);
        db.exec(`UPDATE incidents SET escalation_level = 'critical' WHERE severity = 'critical'`);
        db.exec(`UPDATE incidents SET escalation_level = 'regulator' WHERE notifiable_incident = 1`);
      }
      recordMigration.run(34, 'Incident escalation columns');
      console.log('Migration 34 complete.');
    } catch (e) {
      console.error('Migration 34 error:', e.message);
    }
  }

  // =============================================
  // Migration 35: Company Directory — add company_type + type-specific fields to clients, company_id to client_contacts
  // =============================================
  if (!isMigrationApplied.get(35)) {
    console.log('Running migration 35: Company Directory — company_type + type-specific fields');
    try {
      const newCols = [
        "ALTER TABLE clients ADD COLUMN company_type TEXT NOT NULL DEFAULT 'client'",
        "ALTER TABLE clients ADD COLUMN trade_specialty TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN insurance_expiry DATE",
        "ALTER TABLE clients ADD COLUMN insurance_policy TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN product_categories TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN account_number TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN website TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN approved INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE clients ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE client_contacts ADD COLUMN company_id INTEGER REFERENCES clients(id) ON DELETE SET NULL",
      ];
      for (const sql of newCols) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }
      // Indexes
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_company_type ON clients(company_type)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_client_contacts_company ON client_contacts(company_id)'); } catch (e) {}

      recordMigration.run(35, 'Company Directory — company_type, type-specific fields, company_id on contacts');
      console.log('Migration 35 complete.');
    } catch (e) {
      console.error('Migration 35 error:', e.message);
    }
  }

  // =============================================
  // Migration 36: CRM / BDM Module
  // =============================================
  if (!isMigrationApplied.get(36)) {
    console.log('Running migration 36: CRM / BDM Module — opportunities, activities, account enhancements');
    try {
      // A. New CRM columns on clients table
      const crmClientCols = [
        "ALTER TABLE clients ADD COLUMN account_status TEXT DEFAULT 'active'",
        "ALTER TABLE clients ADD COLUMN account_owner_id INTEGER REFERENCES users(id)",
        "ALTER TABLE clients ADD COLUMN bdm_owner_id INTEGER REFERENCES users(id)",
        "ALTER TABLE clients ADD COLUMN lead_source TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN estimated_annual_value REAL DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN last_contacted_date DATE",
        "ALTER TABLE clients ADD COLUMN next_action_date DATE",
        "ALTER TABLE clients ADD COLUMN next_action_note TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN service_interests TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN target_regions TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN priority TEXT DEFAULT 'normal'",
        "ALTER TABLE clients ADD COLUMN prequal_status TEXT DEFAULT 'none'",
        "ALTER TABLE clients ADD COLUMN vendor_status TEXT DEFAULT 'none'",
        "ALTER TABLE clients ADD COLUMN contract_status TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN industry_segment TEXT DEFAULT ''",
      ];
      for (const sql of crmClientCols) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // B. New CRM columns on client_contacts table
      const crmContactCols = [
        "ALTER TABLE client_contacts ADD COLUMN relationship_strength TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN influence_level TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN buying_role TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN preferred_comm_method TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN last_contact_date DATE",
        "ALTER TABLE client_contacts ADD COLUMN next_contact_date DATE",
        "ALTER TABLE client_contacts ADD COLUMN contact_owner_id INTEGER REFERENCES users(id)",
        "ALTER TABLE client_contacts ADD COLUMN referred_by TEXT DEFAULT ''",
      ];
      for (const sql of crmContactCols) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // C. Opportunities table
      db.exec(`
        CREATE TABLE IF NOT EXISTS opportunities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          opportunity_number TEXT UNIQUE,
          title TEXT NOT NULL,
          client_id INTEGER REFERENCES clients(id),
          contact_id INTEGER REFERENCES client_contacts(id),
          owner_id INTEGER REFERENCES users(id),
          service_type TEXT DEFAULT '',
          stage TEXT DEFAULT 'new_lead',
          probability INTEGER DEFAULT 10,
          estimated_value REAL DEFAULT 0,
          weighted_value REAL DEFAULT 0,
          expected_close_date DATE,
          source TEXT DEFAULT '',
          region TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          next_step TEXT DEFAULT '',
          next_step_due_date DATE,
          status TEXT DEFAULT 'open' CHECK(status IN ('open','won','lost','on_hold')),
          loss_reason TEXT DEFAULT '',
          related_job_id INTEGER REFERENCES jobs(id),
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_client ON opportunities(client_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON opportunities(owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_close_date ON opportunities(expected_close_date)'); } catch (e) {}

      // D. CRM Activities table
      db.exec(`
        CREATE TABLE IF NOT EXISTS crm_activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_type TEXT NOT NULL,
          subject TEXT NOT NULL,
          notes TEXT DEFAULT '',
          outcome TEXT DEFAULT '',
          client_id INTEGER REFERENCES clients(id),
          contact_id INTEGER REFERENCES client_contacts(id),
          opportunity_id INTEGER REFERENCES opportunities(id),
          job_id INTEGER REFERENCES jobs(id),
          owner_id INTEGER REFERENCES users(id),
          activity_date DATETIME,
          next_step TEXT DEFAULT '',
          next_step_due_date DATE,
          location TEXT DEFAULT '',
          is_completed INTEGER DEFAULT 0,
          reminder INTEGER DEFAULT 0,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_client ON crm_activities(client_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_opportunity ON crm_activities(opportunity_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_owner ON crm_activities(owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_date ON crm_activities(activity_date)'); } catch (e) {}

      // E. Seed CRM settings
      const seedSetting = db.prepare(`
        INSERT OR IGNORE INTO app_settings (category, key, label, color, display_order, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `);

      const crmSeeds = {
        opportunity_stages: [
          { key: 'new_lead', label: 'New Lead', color: 'sky' },
          { key: 'qualified', label: 'Qualified', color: 'blue' },
          { key: 'contacted', label: 'Contacted', color: 'indigo' },
          { key: 'meeting_booked', label: 'Meeting Booked', color: 'purple' },
          { key: 'proposal_pending', label: 'Proposal Pending', color: 'amber' },
          { key: 'quote_sent', label: 'Quote Sent', color: 'orange' },
          { key: 'negotiation', label: 'Negotiation', color: 'red' },
          { key: 'awaiting_decision', label: 'Awaiting Decision', color: 'pink' },
          { key: 'won', label: 'Won', color: 'emerald' },
          { key: 'lost', label: 'Lost', color: 'gray' },
          { key: 'on_hold', label: 'On Hold', color: 'slate' },
        ],
        crm_activity_types: [
          { key: 'call', label: 'Call', color: 'blue' },
          { key: 'email', label: 'Email', color: 'sky' },
          { key: 'meeting', label: 'Meeting', color: 'purple' },
          { key: 'site_visit', label: 'Site Visit', color: 'emerald' },
          { key: 'proposal_sent', label: 'Proposal Sent', color: 'amber' },
          { key: 'follow_up', label: 'Follow Up', color: 'orange' },
          { key: 'tender_submitted', label: 'Tender Submitted', color: 'indigo' },
          { key: 'onboarding', label: 'Onboarding', color: 'teal' },
          { key: 'intro_networking', label: 'Intro / Networking', color: 'pink' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        lead_sources: [
          { key: 'inbound', label: 'Inbound', color: 'blue' },
          { key: 'outbound', label: 'Outbound', color: 'purple' },
          { key: 'referral', label: 'Referral', color: 'emerald' },
          { key: 'website', label: 'Website', color: 'sky' },
          { key: 'tender_portal', label: 'Tender Portal', color: 'amber' },
          { key: 'networking', label: 'Networking', color: 'pink' },
          { key: 'existing_client', label: 'Existing Client', color: 'teal' },
          { key: 'cold_call', label: 'Cold Call', color: 'orange' },
          { key: 'event', label: 'Event', color: 'indigo' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        loss_reasons: [
          { key: 'price', label: 'Price', color: 'red' },
          { key: 'timing', label: 'Timing', color: 'amber' },
          { key: 'competitor', label: 'Competitor', color: 'orange' },
          { key: 'no_budget', label: 'No Budget', color: 'gray' },
          { key: 'no_response', label: 'No Response', color: 'slate' },
          { key: 'scope', label: 'Scope Mismatch', color: 'purple' },
          { key: 'relationship', label: 'Relationship', color: 'pink' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        service_categories: [
          { key: 'traffic_control', label: 'Traffic Control', color: 'blue' },
          { key: 'traffic_plans', label: 'Traffic Plans', color: 'indigo' },
          { key: 'rol_permits', label: 'ROL / Permits', color: 'purple' },
          { key: 'equipment_hire', label: 'Equipment Hire', color: 'amber' },
          { key: 'events', label: 'Events', color: 'pink' },
          { key: 'shutdown_emergency', label: 'Shutdown / Emergency', color: 'red' },
          { key: 'civil_support', label: 'Civil Support', color: 'emerald' },
        ],
        priority_levels: [
          { key: 'low', label: 'Low', color: 'gray' },
          { key: 'normal', label: 'Normal', color: 'blue' },
          { key: 'high', label: 'High', color: 'amber' },
          { key: 'strategic', label: 'Strategic', color: 'purple' },
        ],
      };

      for (const [category, items] of Object.entries(crmSeeds)) {
        items.forEach((item, idx) => {
          seedSetting.run(category, item.key, item.label, item.color || '', idx);
        });
      }

      // Client CRM indexes
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_account_owner ON clients(account_owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_bdm_owner ON clients(bdm_owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_next_action ON clients(next_action_date)'); } catch (e) {}

      recordMigration.run(36, 'CRM / BDM Module — opportunities, activities, account enhancements');
      console.log('Migration 36 complete.');
    } catch (e) {
      console.error('Migration 36 error:', e.message);
    }
  }

  // =============================================
  // Migration 37: CRM Sprint 2 — meetings, missing fields, settings
  // =============================================
  if (!isMigrationApplied.get(37)) {
    console.log('Running migration 37: CRM Sprint 2 — meetings, missing fields, settings');
    try {
      // A. New columns on clients
      const clientCols37 = [
        "ALTER TABLE clients ADD COLUMN phone TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN email_general TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN suburb TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN state TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN postcode TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN client_category TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN onboarding_stage TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN tender_panel_status TEXT DEFAULT ''",
      ];
      for (const sql of clientCols37) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // B. Remove CHECK constraint on client_contacts.contact_type by recreating table
      // SQLite does not support ALTER TABLE DROP CONSTRAINT, so we must recreate
      try {
        const hasCheck = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='client_contacts'").get();
        if (hasCheck && hasCheck.sql && hasCheck.sql.includes("CHECK(contact_type IN")) {
          db.exec(`
            CREATE TABLE client_contacts_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
              company_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
              contact_type TEXT NOT NULL DEFAULT 'other',
              company TEXT NOT NULL DEFAULT '',
              full_name TEXT NOT NULL DEFAULT '',
              position TEXT DEFAULT '',
              phone TEXT DEFAULT '',
              email TEXT DEFAULT '',
              notes TEXT DEFAULT '',
              is_primary INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              relationship_strength TEXT DEFAULT '',
              influence_level TEXT DEFAULT '',
              buying_role TEXT DEFAULT '',
              preferred_comm_method TEXT DEFAULT '',
              referred_by TEXT DEFAULT '',
              contact_owner_id INTEGER REFERENCES users(id),
              last_contact_date DATE,
              next_contact_date DATE,
              first_name TEXT DEFAULT '',
              last_name TEXT DEFAULT '',
              mobile TEXT DEFAULT '',
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          // Copy existing data
          const existingCols = db.pragma('table_info(client_contacts)').map(c => c.name);
          const commonCols = existingCols.filter(c =>
            ['id','job_id','company_id','contact_type','company','full_name','position','phone','email',
             'notes','is_primary','created_at','relationship_strength','influence_level','buying_role',
             'preferred_comm_method','referred_by','contact_owner_id','last_contact_date','next_contact_date',
             'first_name','last_name','mobile','updated_at'].includes(c)
          );
          const colList = commonCols.join(', ');
          db.exec(`INSERT INTO client_contacts_new (${colList}) SELECT ${colList} FROM client_contacts`);
          db.exec('DROP TABLE client_contacts');
          db.exec('ALTER TABLE client_contacts_new RENAME TO client_contacts');
          console.log('  Recreated client_contacts without CHECK constraint');
        }
      } catch (e) {
        console.warn('  Could not recreate client_contacts:', e.message);
        // Fallback: just add new columns
        const contactCols37 = [
          "ALTER TABLE client_contacts ADD COLUMN first_name TEXT DEFAULT ''",
          "ALTER TABLE client_contacts ADD COLUMN last_name TEXT DEFAULT ''",
          "ALTER TABLE client_contacts ADD COLUMN mobile TEXT DEFAULT ''",
          "ALTER TABLE client_contacts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
        ];
        for (const sql of contactCols37) {
          try { db.exec(sql); } catch (e2) { /* column likely already exists */ }
        }
      }

      // C. New columns on opportunities
      const oppCols37 = [
        "ALTER TABLE opportunities ADD COLUMN won_date DATE",
        "ALTER TABLE opportunities ADD COLUMN lost_date DATE",
        "ALTER TABLE opportunities ADD COLUMN last_activity_at DATETIME",
      ];
      for (const sql of oppCols37) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // D. New column on crm_activities
      try { db.exec("ALTER TABLE crm_activities ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}

      // E. crm_meetings table
      db.exec(`
        CREATE TABLE IF NOT EXISTS crm_meetings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id INTEGER REFERENCES crm_activities(id) ON DELETE SET NULL,
          account_id INTEGER REFERENCES clients(id),
          opportunity_id INTEGER REFERENCES opportunities(id),
          owner_id INTEGER REFERENCES users(id),
          title TEXT NOT NULL,
          meeting_date DATETIME NOT NULL,
          duration_minutes INTEGER,
          location_type TEXT DEFAULT '',
          location_text TEXT DEFAULT '',
          attendees TEXT DEFAULT '',
          purpose TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          outcome TEXT DEFAULT '',
          follow_up_actions TEXT DEFAULT '',
          next_meeting_date DATE,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Indexes on crm_meetings
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_account ON crm_meetings(account_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_opportunity ON crm_meetings(opportunity_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_owner ON crm_meetings(owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_date ON crm_meetings(meeting_date)'); } catch (e) {}

      // F. Seed new settings categories
      const seedSetting37 = db.prepare(`
        INSERT OR IGNORE INTO app_settings (category, key, label, color, display_order, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `);

      const newSeeds = {
        industry_segments: [
          { key: 'civil', label: 'Civil', color: 'blue' },
          { key: 'utilities', label: 'Utilities', color: 'amber' },
          { key: 'government', label: 'Government', color: 'indigo' },
          { key: 'council', label: 'Council', color: 'teal' },
          { key: 'events', label: 'Events', color: 'pink' },
          { key: 'commercial_builder', label: 'Commercial Builder', color: 'orange' },
          { key: 'rail', label: 'Rail', color: 'purple' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        client_categories: [
          { key: 'principal_contractor', label: 'Principal Contractor', color: 'blue' },
          { key: 'subcontractor', label: 'Subcontractor', color: 'amber' },
          { key: 'builder', label: 'Builder', color: 'orange' },
          { key: 'utility', label: 'Utility', color: 'teal' },
          { key: 'council', label: 'Council', color: 'indigo' },
          { key: 'event_organiser', label: 'Event Organiser', color: 'pink' },
          { key: 'government', label: 'Government', color: 'purple' },
          { key: 'private_client', label: 'Private Client', color: 'emerald' },
        ],
        contact_types: [
          { key: 'decision_maker', label: 'Decision Maker', color: 'red' },
          { key: 'project_manager', label: 'Project Manager', color: 'blue' },
          { key: 'estimator', label: 'Estimator', color: 'amber' },
          { key: 'procurement', label: 'Procurement', color: 'purple' },
          { key: 'safety', label: 'Safety', color: 'emerald' },
          { key: 'planner', label: 'Planner', color: 'indigo' },
          { key: 'accounts', label: 'Accounts', color: 'teal' },
          { key: 'site_contact', label: 'Site Contact', color: 'orange' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
      };

      for (const [category, items] of Object.entries(newSeeds)) {
        items.forEach((item, idx) => {
          seedSetting37.run(category, item.key, item.label, item.color || '', idx);
        });
      }

      recordMigration.run(37, 'CRM Sprint 2 — meetings table, missing fields, new settings');
      console.log('Migration 37 complete.');
    } catch (e) {
      console.error('Migration 37 error:', e.message);
    }
  }

  // =============================================
  // Migration 38: HR / People Ops Foundation
  // =============================================
  if (!isMigrationApplied.get(38)) {
    console.log('Running migration 38: HR / People Ops Foundation');
    try {
      // --- A. employees table ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS employees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_code TEXT UNIQUE,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          full_name TEXT NOT NULL,
          preferred_name TEXT DEFAULT '',
          company TEXT DEFAULT '',
          division TEXT DEFAULT '',
          role_title TEXT DEFAULT '',
          employment_type TEXT DEFAULT 'full_time',
          employment_status TEXT DEFAULT 'active',
          start_date DATE,
          end_date DATE,
          probation_end_date DATE,
          manager_id INTEGER REFERENCES employees(id),
          email TEXT DEFAULT '',
          phone TEXT DEFAULT '',
          address TEXT DEFAULT '',
          suburb TEXT DEFAULT '',
          state TEXT DEFAULT '',
          postcode TEXT DEFAULT '',
          traffic_role_level TEXT DEFAULT '',
          ticket_classification TEXT DEFAULT '',
          white_card_required INTEGER DEFAULT 0,
          medical_required INTEGER DEFAULT 0,
          allocatable INTEGER DEFAULT 1,
          blocked_from_allocation INTEGER DEFAULT 0,
          block_reason TEXT DEFAULT '',
          induction_status TEXT DEFAULT 'pending',
          ppe_issued_status TEXT DEFAULT 'not_issued',
          uniform_issued_status TEXT DEFAULT 'not_issued',
          company_vehicle_assigned TEXT DEFAULT '',
          primary_work_region TEXT DEFAULT '',
          base_location TEXT DEFAULT '',
          emergency_contact_name TEXT DEFAULT '',
          emergency_contact_phone TEXT DEFAULT '',
          emergency_contact_relationship TEXT DEFAULT '',
          date_of_birth DATE,
          payroll_reference TEXT DEFAULT '',
          internal_notes TEXT DEFAULT '',
          active INTEGER DEFAULT 1,
          linked_crew_member_id INTEGER REFERENCES crew_members(id),
          linked_user_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(employee_code)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(employment_status)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_crew ON employees(linked_crew_member_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_user ON employees(linked_user_id)'); } catch(e) {}

      // --- B. employee_documents table ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS employee_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          document_type TEXT NOT NULL DEFAULT 'other',
          document_name TEXT NOT NULL,
          filename TEXT NOT NULL,
          original_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER DEFAULT 0,
          issue_date DATE,
          expiry_date DATE,
          mandatory INTEGER DEFAULT 0,
          verification_status TEXT DEFAULT 'pending',
          verified_by_id INTEGER REFERENCES users(id),
          verified_at DATETIME,
          notes TEXT DEFAULT '',
          uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_employee ON employee_documents(employee_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_type ON employee_documents(document_type)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_expiry ON employee_documents(expiry_date)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_verification ON employee_documents(verification_status)'); } catch(e) {}

      // --- C. employee_competencies table ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS employee_competencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          competency_type TEXT NOT NULL DEFAULT 'other',
          competency_name TEXT NOT NULL,
          competency_level TEXT DEFAULT '',
          issue_date DATE,
          expiry_date DATE,
          status TEXT DEFAULT 'valid',
          mandatory_for_role INTEGER DEFAULT 0,
          linked_document_id INTEGER REFERENCES employee_documents(id),
          notes TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_employee ON employee_competencies(employee_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_type ON employee_competencies(competency_type)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_expiry ON employee_competencies(expiry_date)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_status ON employee_competencies(status)'); } catch(e) {}

      // --- D. Expand users role CHECK to include 'hr' and 'sales' ---
      const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const userSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (userSql && userSql.sql && !userSql.sql.includes("'hr'")) {
        db.pragma('foreign_keys = OFF');
        db.exec(`
          CREATE TABLE users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT NOT NULL,
            email TEXT,
            role TEXT NOT NULL CHECK(role IN ('admin','operations','planning','finance','hr','sales')),
            active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            email_notifications_enabled INTEGER DEFAULT 1,
            notification_frequency TEXT DEFAULT 'immediate'
          );
        `);
        db.exec(`
          INSERT INTO users_new (id, username, password_hash, full_name, email, role, active, created_at, email_notifications_enabled, notification_frequency)
          SELECT id, username, password_hash, full_name, email, role, active, created_at,
            COALESCE(email_notifications_enabled, 1),
            COALESCE(notification_frequency, 'immediate')
          FROM users;
        `);
        db.exec('DROP TABLE users;');
        db.exec('ALTER TABLE users_new RENAME TO users;');
        db.pragma('foreign_keys = ON');
      }

      // --- E. Auto-seed employees from crew_members ---
      const crewRows = db.prepare('SELECT * FROM crew_members WHERE active = 1').all();
      const insertEmp = db.prepare(`
        INSERT OR IGNORE INTO employees (employee_code, first_name, last_name, full_name, company, employment_type, email, phone, traffic_role_level, induction_status, active, linked_crew_member_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
      `);
      for (const cm of crewRows) {
        const parts = (cm.full_name || '').trim().split(/\s+/);
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';
        const empType = cm.employment_type || 'full_time';
        const inductionStatus = cm.induction_status || (cm.induction_date ? 'completed' : 'pending');
        insertEmp.run(
          cm.employee_id || null,
          firstName, lastName, cm.full_name || '',
          cm.company || '',
          empType,
          cm.email || '', cm.phone || '',
          cm.tcp_level || cm.role || '',
          inductionStatus,
          cm.id
        );
      }

      // --- F. Seed HR settings categories ---
      const insertSetting = db.prepare(`
        INSERT OR IGNORE INTO app_settings (category, key, label, display_order, is_active)
        VALUES (?, ?, ?, ?, 1)
      `);
      // Employment types
      [['full_time','Full Time'],['part_time','Part Time'],['casual','Casual'],['subcontractor','Subcontractor']].forEach(([k,l], i) => {
        insertSetting.run('hr_employment_types', k, l, i+1);
      });
      // Employment statuses
      [['active','Active'],['onboarding','Onboarding'],['on_leave','On Leave'],['suspended','Suspended'],['inactive','Inactive'],['offboarded','Offboarded']].forEach(([k,l], i) => {
        insertSetting.run('hr_employment_statuses', k, l, i+1);
      });
      // Divisions
      [['operations','Operations'],['planning','Planning'],['admin','Admin'],['safety','Safety'],['finance','Finance'],['hr','Human Resources'],['sales','Sales']].forEach(([k,l], i) => {
        insertSetting.run('hr_divisions', k, l, i+1);
      });
      // Document types
      [['contract','Contract'],['licence','Licence'],['white_card','White Card'],['induction_record','Induction Record'],['training_certificate','Training Certificate'],['voc','VOC'],['medical','Medical'],['id','ID'],['policy_acknowledgement','Policy Acknowledgement'],['other','Other']].forEach(([k,l], i) => {
        insertSetting.run('hr_document_types', k, l, i+1);
      });
      // Competency types
      [['traffic_ticket','Traffic Ticket'],['white_card','White Card'],['first_aid','First Aid'],['plant_ticket','Plant Ticket'],['driver_licence','Driver Licence'],['hr_licence','HR Licence'],['voc','VOC'],['induction','Induction'],['medical_clearance','Medical Clearance'],['other','Other']].forEach(([k,l], i) => {
        insertSetting.run('hr_competency_types', k, l, i+1);
      });
      // PPE statuses
      [['not_issued','Not Issued'],['issued','Issued'],['partial','Partial'],['returned','Returned']].forEach(([k,l], i) => {
        insertSetting.run('hr_ppe_statuses', k, l, i+1);
      });
      // Block reasons
      [['expired_licence','Expired Licence'],['missing_induction','Missing Induction'],['medical_expired','Medical Expired'],['disciplinary','Disciplinary'],['other','Other']].forEach(([k,l], i) => {
        insertSetting.run('hr_block_reasons', k, l, i+1);
      });

      recordMigration.run(38, 'HR / People Ops Foundation — employees, documents, competencies, role expansion');
      console.log('Migration 38 complete.');
    } catch (e) {
      try { db.pragma('foreign_keys = ON'); } catch(re) {}
      try { db.exec('DROP TABLE IF EXISTS users_new'); } catch(re) {}
      console.error('Migration 38 error:', e.message);
    }
  }

  // =============================================
  // Migration 39: Seed realistic demo budget data for active jobs
  // =============================================
  if (!isMigrationApplied.get(39)) {
    try {
      // Only seed if job_budgets is empty (don't overwrite real data)
      const existingBudgets = db.prepare('SELECT COUNT(*) as c FROM job_budgets').get().c;
      if (existingBudgets === 0) {
        const activeJobs = db.prepare("SELECT id, job_number, contract_value FROM jobs WHERE status IN ('active','won','on_hold') ORDER BY job_number").all();
        if (activeJobs.length > 0) {
          const insertBudget = db.prepare(`INSERT OR IGNORE INTO job_budgets (job_id, contract_value, budget_labour, budget_materials, budget_subcontractors, budget_equipment, budget_other, budget_contingency, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const insertCost = db.prepare(`INSERT INTO cost_entries (job_id, budget_id, category, description, amount, entry_date, invoice_ref, supplier, entered_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

          const adminUser = db.prepare("SELECT id FROM users WHERE role IN ('admin','finance') LIMIT 1").get();
          const enteredBy = adminUser ? adminUser.id : 1;

          const profiles = [
            { labourPct: 0.50, matPct: 0.08, subPct: 0.18, equipPct: 0.14, otherPct: 0.03, contPct: 0.07 },
            { labourPct: 0.52, matPct: 0.06, subPct: 0.20, equipPct: 0.12, otherPct: 0.04, contPct: 0.06 },
            { labourPct: 0.48, matPct: 0.10, subPct: 0.15, equipPct: 0.16, otherPct: 0.03, contPct: 0.08 },
            { labourPct: 0.55, matPct: 0.05, subPct: 0.17, equipPct: 0.13, otherPct: 0.04, contPct: 0.06 },
          ];

          const contractValues = [185000, 320000, 95000, 450000, 78000, 520000, 125000, 680000, 210000, 145000];
          const spendPcts = [0.38, 0.62, 0.78, 0.22, 0.45, 0.05, 0.55, 0.12, 0.35, 0.68];
          const daysAgo39 = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

          activeJobs.forEach((job, i) => {
            const contractVal = job.contract_value || contractValues[i % contractValues.length];
            const p = profiles[i % profiles.length];
            const totalBudget = contractVal * 0.92;

            insertBudget.run(job.id, contractVal,
              Math.round(totalBudget * p.labourPct), Math.round(totalBudget * p.matPct),
              Math.round(totalBudget * p.subPct), Math.round(totalBudget * p.equipPct),
              Math.round(totalBudget * p.otherPct), Math.round(totalBudget * p.contPct),
              'Auto-seeded budget');

            const budgetRow = db.prepare('SELECT id FROM job_budgets WHERE job_id = ?').get(job.id);
            if (!budgetRow) return;

            const spendPct = spendPcts[i % spendPcts.length];
            const totalSpend = totalBudget * spendPct;

            const costEntries = [
              { cat: 'labour', pct: 0.55, desc: 'Crew labour — weeks 1-' + Math.ceil(spendPct * 20), supplier: 'Internal', pre: 'LAB' },
              { cat: 'equipment', pct: 0.18, desc: 'TMA & equipment hire', supplier: 'T&S Fleet', pre: 'EQP' },
              { cat: 'materials', pct: 0.10, desc: 'Signage, cones & delineators', supplier: 'Traffix Devices', pre: 'MAT' },
              { cat: 'subcontractors', pct: 0.14, desc: 'Line marking & civil sub', supplier: 'Roadline Markings', pre: 'SUB' },
              { cat: 'other', pct: 0.03, desc: 'Permits & admin', supplier: 'Various', pre: 'OTH' },
            ];

            costEntries.forEach((ce, ci) => {
              const amount = Math.round(totalSpend * ce.pct);
              if (amount <= 0) return;
              insertCost.run(job.id, budgetRow.id, ce.cat, ce.desc, amount,
                daysAgo39(Math.max(1, Math.round((ci + 1) * 7 * spendPct))),
                ce.pre + '-' + job.job_number + '-' + String(ci + 1).padStart(3, '0'),
                ce.supplier, enteredBy);
            });

            if (!job.contract_value) {
              db.prepare('UPDATE jobs SET contract_value = ? WHERE id = ?').run(contractVal, job.id);
            }
          });

          console.log('Migration 39: Seeded budget data for ' + activeJobs.length + ' jobs');
        }
      }
      recordMigration.run(39, 'Seed realistic demo budget data');
      console.log('Migration 39 complete.');
    } catch (e) {
      console.error('Migration 39 error:', e.message);
    }
  }

  // =============================================
  // Migration 40: Seed comprehensive demo data (schema-only marker)
  // Actual data seeded in seedDemoData() after initial user/job seed
  // =============================================
  if (!isMigrationApplied.get(40)) {
    // Add preferences column to users if missing
    try { db.exec("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'"); } catch (e) { /* already exists */ }
    recordMigration.run(40, 'Seed comprehensive demo data — allocations, equipment, activity, CRM, updates');
    console.log('Migration 40 complete (schema marker).');
  }

  // =============================================
  // Migration 41: Induction Module
  // =============================================
  if (!isMigrationApplied.get(41)) {
    console.log('Running migration 41: Induction Module');

    db.exec(`
      CREATE TABLE IF NOT EXISTS induction_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        access_token TEXT UNIQUE NOT NULL,
        payment_type TEXT NOT NULL CHECK(payment_type IN ('cash', 'tfn', 'abn')),
        status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('draft', 'submitted', 'approved', 'rejected')),

        full_name TEXT NOT NULL DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        date_of_birth DATE,
        address TEXT DEFAULT '',
        suburb TEXT DEFAULT '',
        state TEXT DEFAULT '',
        postcode TEXT DEFAULT '',

        can_drive TEXT DEFAULT '',
        can_drive_truck TEXT DEFAULT '',
        has_injuries TEXT DEFAULT '',
        injury_details TEXT DEFAULT '',
        is_indigenous TEXT DEFAULT '',

        white_card_number TEXT DEFAULT '',
        tc_licence_number TEXT DEFAULT '',
        drivers_licence_number TEXT DEFAULT '',

        white_card_photo TEXT DEFAULT '',
        tc_licence_photo TEXT DEFAULT '',
        drivers_licence_photo TEXT DEFAULT '',

        tax_file_number TEXT DEFAULT '',
        bank_bsb TEXT DEFAULT '',
        bank_account_number TEXT DEFAULT '',
        bank_account_name TEXT DEFAULT '',
        abn_number TEXT DEFAULT '',

        company_intro_completed INTEGER DEFAULT 0,
        ppe_acknowledged INTEGER DEFAULT 0,

        reviewed_by_id INTEGER REFERENCES users(id),
        reviewed_at DATETIME,
        review_notes TEXT DEFAULT '',

        linked_crew_member_id INTEGER REFERENCES crew_members(id),

        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        submitted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_induction_token ON induction_submissions(access_token);
      CREATE INDEX IF NOT EXISTS idx_induction_status ON induction_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_induction_payment ON induction_submissions(payment_type);
      CREATE INDEX IF NOT EXISTS idx_induction_submitted ON induction_submissions(submitted_at);

      CREATE TABLE IF NOT EXISTS induction_presentations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL CHECK(module IN ('employee_guide', 'tc_training_1')),
        presented_by_id INTEGER NOT NULL REFERENCES users(id),
        attendee_names TEXT DEFAULT '',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        last_slide INTEGER DEFAULT 1,
        total_slides INTEGER NOT NULL,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_presentations_module ON induction_presentations(module);
    `);

    recordMigration.run(41, 'Induction Module — submissions and presentations tables');
    console.log('Migration 41 complete.');
  }

  // =============================================
  // Migration 42: Add created_by to tasks
  // =============================================
  if (!isMigrationApplied.get(42)) {
    console.log('Running migration 42: Add created_by to tasks');
    try { db.exec('ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id)'); } catch (e) { /* column may already exist */ }
    recordMigration.run(42, 'Add created_by column to tasks table');
    console.log('Migration 42 complete.');
  }

  // =============================================
  // Migration 43: Backfill created_by on existing tasks
  // =============================================
  if (!isMigrationApplied.get(43)) {
    console.log('Running migration 43: Backfill created_by on existing tasks');
    // Set created_by to the first admin user for any tasks missing it
    const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (firstAdmin) {
      db.prepare('UPDATE tasks SET created_by = ? WHERE created_by IS NULL').run(firstAdmin.id);
    }
    recordMigration.run(43, 'Backfill created_by on existing tasks');
    console.log('Migration 43 complete.');
  }

  // Migration 44: Add bank_name column to induction_submissions
  if (!isMigrationApplied.get(44)) {
    console.log('Running migration 44: Add bank_name to induction_submissions');
    db.exec(`ALTER TABLE induction_submissions ADD COLUMN bank_name TEXT DEFAULT ''`);
    recordMigration.run(44, 'Add bank_name to induction_submissions');
    console.log('Migration 44 complete.');
  }

  // =============================================
  // Migration 45: Client operational fields + import real client data
  // =============================================
  if (!isMigrationApplied.get(45)) {
    console.log('Running migration 45: Client operational fields + real client data');
    try {
      // Add operational columns to clients
      const clientCols45 = [
        "ALTER TABLE clients ADD COLUMN cancellation_window_hrs INTEGER DEFAULT 3",
        "ALTER TABLE clients ADD COLUMN is_non_billable INTEGER DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN is_cash_only INTEGER DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN credit_stop INTEGER DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN credit_stop_reason TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN default_purchase_order TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_suburb TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_state TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_postcode TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_attention TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN external_id TEXT DEFAULT ''",
      ];
      for (const sql of clientCols45) {
        try { db.exec(sql); } catch (e) { /* column likely exists */ }
      }

      // Add send_docket / send_invoice to client_contacts
      const contactCols45 = [
        "ALTER TABLE client_contacts ADD COLUMN send_docket INTEGER DEFAULT 0",
        "ALTER TABLE client_contacts ADD COLUMN send_invoice INTEGER DEFAULT 0",
      ];
      for (const sql of contactCols45) {
        try { db.exec(sql); } catch (e) { /* column likely exists */ }
      }

      // Import real client data
      const insertClient45 = db.prepare(`
        INSERT INTO clients (external_id, company_name, abn, cancellation_window_hrs, is_non_billable, is_cash_only, credit_stop, credit_stop_reason, payment_terms, default_purchase_order, company_type, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', 1)
      `);
      const insertContact45 = db.prepare(`
        INSERT INTO client_contacts (company_id, contact_type, company, full_name, phone, email, send_docket, send_invoice, is_primary)
        VALUES (?, 'client', ?, ?, ?, ?, ?, ?, ?)
      `);

      const clients45 = [
        {id:"74577",name:"2 Way Concrete",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Frank 2-Way",phone:"0410428084",email:null,docket:false,invoice:false}]},
        {id:"94296",name:"Abergeldie Complex Infrastructure",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Harry Iqbal",phone:"0499 516 282",email:null,docket:false,invoice:false}]},
        {id:"73797",name:"Active Civil Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Adam Mourad",phone:"0490333329",email:null,docket:false,invoice:false}]},
        {id:"73796",name:"AGM Constructions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ghassan Al-Kamisie",phone:"0401272829",email:null,docket:false,invoice:false}]},
        {id:"93884",name:"Al-Faisal College",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Waed Khalifeh",phone:"0405 288 828",email:null,docket:false,invoice:false}]},
        {id:"74461",name:"All Civil Works",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Charbel Younan",phone:"0433922290",email:null,docket:false,invoice:false}]},
        {id:"27671",name:"Alpha Cranes & Rigging",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Aaron Alpha",phone:"0414 525 556",email:null,docket:false,invoice:false}]},
        {id:"74154",name:"AM2PM Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Craig AM2PM",phone:"0412393300",email:null,docket:false,invoice:false}]},
        {id:"36003",name:"ANR Engineering",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Sami ANR",phone:"0439 038 993",email:null,docket:false,invoice:false}]},
        {id:"75094",name:"Apex Sewer & Water",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Matthew Clancey",phone:"0432073840",email:null,docket:false,invoice:false}]},
        {id:"90622",name:"Atlantis",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Sarah Atlantis",phone:"0432 282 380",email:null,docket:false,invoice:false}]},
        {id:"74215",name:"Atlas Plumbing",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Pat Atlas",phone:"0404604050",email:null,docket:false,invoice:false}]},
        {id:"73798",name:"Axial Construction",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Michael Cassisi",phone:"0407727170",email:null,docket:false,invoice:false}]},
        {id:"34044",name:"Blaq Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Wasim Blaq",phone:"0430 838 488",email:null,docket:false,invoice:false}]},
        {id:"73799",name:"Brushwood Engineering",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jason Brushwood",phone:"0412898983",email:null,docket:false,invoice:false}]},
        {id:"77632",name:"Build Life",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Elias Saad",phone:"0404676767",email:null,docket:false,invoice:false}]},
        {id:"86602",name:"Builtwise Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ahmed Builtwise",phone:"0423188888",email:null,docket:false,invoice:false}]},
        {id:"35767",name:"BXD Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jacob BXD",phone:"0425 696 969",email:null,docket:false,invoice:false}]},
        {id:"94092",name:"Carlton Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Marwan Nassar",phone:"0403 077 887",email:null,docket:false,invoice:false}]},
        {id:"90484",name:"CIP Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Alex CIP",phone:"0416 838 288",email:null,docket:false,invoice:false}]},
        {id:"75913",name:"City Line Marking",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Walid City",phone:"0414140004",email:null,docket:false,invoice:false}]},
        {id:"87649",name:"City Traffic",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Peter City Traffic",phone:"0413254000",email:null,docket:false,invoice:false}]},
        {id:"88399",name:"Civil Com Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"George Civil",phone:"0413 060 506",email:null,docket:false,invoice:false}]},
        {id:"35733",name:"Civil Environmental Services",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Steve CES",phone:"0434616113",email:null,docket:false,invoice:false}]},
        {id:"73800",name:"Civil Environmental Services",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ahmed CES",phone:"0426041882",email:null,docket:false,invoice:false}]},
        {id:"32043",name:"Civil Ops",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[]},
        {id:"32044",name:"Civil Ops",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Mitch",phone:"0473549737",email:null,docket:false,invoice:false}]},
        {id:"33209",name:"Combined",abn:null,cancel:3,nonBill:true,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Taj",phone:"+61 416 221 801",email:null,docket:false,invoice:false}]},
        {id:"92421",name:"Compass Developments",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Liam Marshall",phone:"0451 006 293",email:null,docket:false,invoice:false},{name:"Adnan Compass",phone:"0421316669",email:null,docket:false,invoice:false}]},
        {id:"83863",name:"Conquest",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Danny Conquest",phone:"0413 803 386",email:null,docket:false,invoice:false}]},
        {id:"73801",name:"Construx Solutions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jack Construx",phone:"0400 777 666",email:null,docket:false,invoice:false}]},
        {id:"85666",name:"Cubic Construction",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Luke Cubic",phone:"0404 770 900",email:null,docket:false,invoice:false}]},
        {id:"73805",name:"D&M Asphalt",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Danny D&M",phone:"0424 897 733",email:null,docket:false,invoice:false}]},
        {id:"89044",name:"Daracon Group",abn:"82 002 344 667",cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Nathan Hillier",phone:"0499 941 623",email:"nathan.hillier@daracon.com.au",docket:true,invoice:false},{name:"Simpson Wong",phone:"0427 000 834",email:"simpson.wong@daracon.com.au",docket:false,invoice:false},{name:"Chandan Naidu",phone:"0432 987 654",email:"chandan.naidu@daracon.com.au",docket:false,invoice:false}]},
        {id:"91246",name:"Daracon Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[]},
        {id:"74792",name:"Delaney Civil",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Michael Delaney",phone:"0407414714",email:null,docket:false,invoice:false}]},
        {id:"78459",name:"Designline Building",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Maysam Designline",phone:"0449 225 885",email:null,docket:false,invoice:false}]},
        {id:"84307",name:"Domain Constructions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Frank Domain",phone:"0402338831",email:null,docket:false,invoice:false}]},
        {id:"78546",name:"Dynamic Lanemarking",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ross Dynamic",phone:"0418 428 080",email:null,docket:false,invoice:false}]},
        {id:"88257",name:"E.M.O Civil",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jihad EMO",phone:"0414 660 090",email:null,docket:false,invoice:false}]},
        {id:"31906",name:"Earthbuilt",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ahmad Earthbuilt",phone:"0421 601 061",email:null,docket:false,invoice:false}]},
        {id:"86054",name:"Easter's Pacific",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Greg Easter",phone:"0414 242 829",email:null,docket:false,invoice:false}]},
        {id:"29781",name:"Fleek Constructions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jason Fleek",phone:"0410335556",email:null,docket:false,invoice:false}]},
        {id:"33644",name:"Ghass",abn:null,cancel:3,nonBill:true,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[]},
        {id:"73807",name:"Greenbrook",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Nathaniel Greenbrook",phone:"0408 727 343",email:null,docket:false,invoice:false}]},
        {id:"73802",name:"Ground King Civil",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Marcus King",phone:"0424448000",email:null,docket:false,invoice:false}]},
        {id:"73803",name:"H Lap Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Hisham H-Lap",phone:"0412040030",email:null,docket:false,invoice:false}]},
        {id:"91325",name:"Hacer Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Weston Hacer",phone:"0436 083 663",email:null,docket:false,invoice:false}]},
        {id:"87594",name:"HPAC",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Steve HPAC",phone:"0410 696 060",email:null,docket:false,invoice:false}]},
        {id:"73807",name:"I Connected",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Fatih Cantas",phone:"0477 777 877",email:null,docket:false,invoice:false},{name:"Harry ICA",phone:"0487409488",email:null,docket:false,invoice:false}]},
        {id:"74156",name:"I Connected",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Fatih Cantas",phone:"0477 777 877",email:null,docket:false,invoice:false}]},
      ];

      for (const c of clients45) {
        // Check if client with same name + external_id already exists
        const existing = db.prepare('SELECT id FROM clients WHERE company_name = ? AND external_id = ?').get(c.name, c.id);
        let clientDbId;
        if (existing) {
          clientDbId = existing.id;
          // Update operational fields
          db.prepare(`UPDATE clients SET cancellation_window_hrs = ?, is_non_billable = ?, is_cash_only = ?, credit_stop = ?, credit_stop_reason = ?, abn = COALESCE(NULLIF(?, ''), abn), external_id = ? WHERE id = ?`)
            .run(c.cancel, c.nonBill ? 1 : 0, c.cash ? 1 : 0, c.creditStop ? 1 : 0, c.creditReason || '', c.abn || '', c.id, clientDbId);
        } else {
          const r = insertClient45.run(c.id, c.name, c.abn || '', c.cancel, c.nonBill ? 1 : 0, c.cash ? 1 : 0, c.creditStop ? 1 : 0, c.creditReason || '', c.payTerm || '', c.po || '');
          clientDbId = r.lastInsertRowid;
        }

        // Insert contacts
        for (let i = 0; i < c.contacts.length; i++) {
          const ct = c.contacts[i];
          // Check if contact already exists for this company
          const existingContact = db.prepare('SELECT id FROM client_contacts WHERE company_id = ? AND full_name = ?').get(clientDbId, ct.name);
          if (!existingContact) {
            insertContact45.run(clientDbId, c.name, ct.name, ct.phone || '', ct.email || '', ct.docket ? 1 : 0, ct.invoice ? 1 : 0, i === 0 ? 1 : 0);
          }
        }
      }

      console.log('Migration 45: Imported ' + clients45.length + ' clients with contacts');
    } catch (e) {
      console.error('Migration 45 error:', e.message);
    }
    recordMigration.run(45, 'Client operational fields + real client data');
    console.log('Migration 45 complete.');
  }

  // Migration 46: Split name fields + payment_type on employees & induction_submissions
  if (!isMigrationApplied.get(46)) {
    console.log('Running migration 46: Split name fields + payment_type');
    // Add middle_name and payment_type to employees
    try { db.exec(`ALTER TABLE employees ADD COLUMN middle_name TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE employees ADD COLUMN payment_type TEXT DEFAULT ''`); } catch(e) {}
    // Add split name fields to induction_submissions
    try { db.exec(`ALTER TABLE induction_submissions ADD COLUMN first_name TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE induction_submissions ADD COLUMN middle_name TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE induction_submissions ADD COLUMN last_name TEXT DEFAULT ''`); } catch(e) {}
    recordMigration.run(46, 'Split name fields + payment_type');
    console.log('Migration 46 complete.');
  }

  // Migration 47: Pay rate fields on employees
  if (!isMigrationApplied.get(47)) {
    console.log('Running migration 47: Employee pay rates');
    const rateColumns = [
      'rate_day', 'rate_ot', 'rate_dt',
      'rate_night', 'rate_night_ot', 'rate_night_dt',
      'rate_travel', 'rate_meal', 'rate_weekend'
    ];
    rateColumns.forEach(col => {
      try { db.exec(`ALTER TABLE employees ADD COLUMN ${col} REAL DEFAULT 0`); } catch(e) {}
    });
    recordMigration.run(47, 'Employee pay rates');
    console.log('Migration 47 complete.');
  }

  // Migration 48: Fix CHECK constraints — users role + incidents type
  if (!isMigrationApplied.get(48)) {
    console.log('Running migration 48: Fix CHECK constraints');
    db.pragma('foreign_keys = OFF');

    // Fix users table — add hr, sales roles alongside management, marketing, accounts
    try {
      const allRoles = "'admin','operations','planning','finance','hr','sales','management','marketing','accounts'";
      const userCols = db.pragma('table_info(users)').map(c => c.name);
      db.exec(`CREATE TABLE users_fix (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL CHECK(role IN (${allRoles})),
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        email_notifications_enabled INTEGER DEFAULT 1,
        notification_frequency TEXT DEFAULT 'immediate'
      )`);
      const cols = ['id','username','password_hash','full_name','email','role','active','created_at',
        'email_notifications_enabled','notification_frequency'].filter(c => userCols.includes(c));
      db.exec(`INSERT INTO users_fix (${cols.join(',')}) SELECT ${cols.join(',')} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_fix RENAME TO users');
      console.log('  Fixed users CHECK constraint');
    } catch(e) { console.error('  Users fix error:', e.message); }

    // Fix incidents table — add all incident types
    try {
      const allTypes = "'near_miss','traffic_incident','worker_injury','vehicle_damage','public_complaint','environmental','injury','hazard','property_damage','vehicle','other'";
      const incCols = db.pragma('table_info(incidents)').map(c => c.name);
      if (incCols.length > 0) {
        const colDefs = db.pragma('table_info(incidents)');
        // Build new table with same columns but fixed CHECK
        let createSQL = 'CREATE TABLE incidents_fix (';
        const colParts = colDefs.map(c => {
          let def = `${c.name} ${c.type || 'TEXT'}`;
          if (c.pk) def = `${c.name} INTEGER PRIMARY KEY AUTOINCREMENT`;
          if (c.name === 'incident_type') def = `incident_type TEXT NOT NULL CHECK(incident_type IN (${allTypes}))`;
          if (c.notnull && !c.pk && c.name !== 'incident_type') def += ' NOT NULL';
          if (c.dflt_value !== null && !c.pk) def += ` DEFAULT ${c.dflt_value}`;
          return def;
        });
        createSQL += colParts.join(', ') + ')';
        db.exec(createSQL);
        const safeCols = incCols.join(',');
        db.exec(`INSERT INTO incidents_fix (${safeCols}) SELECT ${safeCols} FROM incidents`);
        db.exec('DROP TABLE incidents');
        db.exec('ALTER TABLE incidents_fix RENAME TO incidents');
        console.log('  Fixed incidents CHECK constraint');
      }
    } catch(e) { console.error('  Incidents fix error:', e.message); }

    db.pragma('foreign_keys = ON');
    recordMigration.run(48, 'Fix CHECK constraints');
    console.log('Migration 48 complete.');
  }

  // Migration 49: Bookings module tables
  if (!isMigrationApplied.get(49)) {
    console.log('Running migration 49: Bookings module');
    db.exec(`
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_number TEXT UNIQUE,
        job_id INTEGER REFERENCES jobs(id),
        client_id INTEGER REFERENCES clients(id),
        title TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(status IN ('unconfirmed','confirmed','green_to_go','in_progress','completed','cancelled','on_hold')),
        depot TEXT DEFAULT '',
        start_datetime TEXT NOT NULL,
        end_datetime TEXT NOT NULL,
        site_address TEXT DEFAULT '',
        suburb TEXT DEFAULT '',
        state TEXT DEFAULT '',
        postcode TEXT DEFAULT '',
        order_number TEXT DEFAULT '',
        billing_code TEXT DEFAULT '',
        client_contact TEXT DEFAULT '',
        supervisor_id INTEGER REFERENCES crew_members(id),
        requirements_text TEXT DEFAULT '',
        is_emergency INTEGER DEFAULT 0,
        is_callout INTEGER DEFAULT 0,
        billable INTEGER DEFAULT 1,
        invoiced INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(start_datetime);
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
      CREATE INDEX IF NOT EXISTS idx_bookings_depot ON bookings(depot);
      CREATE INDEX IF NOT EXISTS idx_bookings_job ON bookings(job_id);

      CREATE TABLE IF NOT EXISTS booking_crew (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        role_on_site TEXT DEFAULT '',
        status TEXT DEFAULT 'assigned' CHECK(status IN ('assigned','confirmed','declined','completed')),
        confirmed_at DATETIME,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_crew_booking ON booking_crew(booking_id);
      CREATE INDEX IF NOT EXISTS idx_booking_crew_member ON booking_crew(crew_member_id);

      CREATE TABLE IF NOT EXISTS booking_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL,
        is_private INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_notes_booking ON booking_notes(booking_id);

      CREATE TABLE IF NOT EXISTS booking_vehicles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        vehicle_name TEXT DEFAULT '',
        registration TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_vehicles_booking ON booking_vehicles(booking_id);
    `);
    recordMigration.run(49, 'Bookings module tables');
    console.log('Migration 49 complete.');
  }

  // Migration 50: Plans register — add missing fields from Excel register
  if (!isMigrationApplied.get(50)) {
    console.log('Running migration 50: Plans register extra fields');
    const cols = [
      ['reference_number', 'TEXT DEFAULT \'\''],
      ['rol_required', 'INTEGER DEFAULT 0'],
      ['rol_response', 'TEXT DEFAULT \'\''],
      ['bus_approvals_required', 'INTEGER DEFAULT 0'],
      ['bus_approvals_response', 'TEXT DEFAULT \'\''],
      ['client_pm', 'TEXT DEFAULT \'\''],
      ['costs', 'REAL DEFAULT 0'],
      ['action_required', 'TEXT DEFAULT \'\''],
      ['charge_client', 'INTEGER DEFAULT 0'],
      ['charge_amount', 'REAL DEFAULT 0'],
      ['invoiced', 'INTEGER DEFAULT 0'],
      ['invoice_number', 'TEXT DEFAULT \'\''],
      ['police_notification', 'INTEGER DEFAULT 0'],
      ['letter_drop', 'INTEGER DEFAULT 0'],
    ];
    cols.forEach(([col, type]) => {
      try { db.exec(`ALTER TABLE compliance ADD COLUMN ${col} ${type}`); } catch(e) {}
    });
    recordMigration.run(50, 'Plans register extra fields');
    console.log('Migration 50 complete.');
  }

  // Migration 51: Booking dockets — time tracking + signatures
  if (!isMigrationApplied.get(51)) {
    console.log('Running migration 51: Booking dockets');
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_dockets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        docket_number TEXT UNIQUE,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pending_signoff','signed','finalised')),
        physical_docket_number TEXT DEFAULT '',
        client_billing_ref TEXT DEFAULT '',
        bill_from TEXT DEFAULT '',
        site_address TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        private_notes TEXT DEFAULT '',
        client_feedback TEXT DEFAULT '',
        worker_signature TEXT DEFAULT '',
        worker_signed_name TEXT DEFAULT '',
        worker_signed_at DATETIME,
        client_signature TEXT DEFAULT '',
        client_signed_name TEXT DEFAULT '',
        client_signed_at DATETIME,
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_dockets_booking ON booking_dockets(booking_id);
      CREATE INDEX IF NOT EXISTS idx_dockets_status ON booking_dockets(status);

      CREATE TABLE IF NOT EXISTS docket_time_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        docket_id INTEGER NOT NULL REFERENCES booking_dockets(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        start_on_site DATETIME,
        finish_on_site DATETIME,
        first_break REAL DEFAULT 0,
        first_break_at TEXT DEFAULT '',
        travel REAL DEFAULT 0,
        lafha INTEGER DEFAULT 0,
        total_hours REAL DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_time_entries_docket ON docket_time_entries(docket_id);
      CREATE INDEX IF NOT EXISTS idx_time_entries_crew ON docket_time_entries(crew_member_id);
    `);
    recordMigration.run(51, 'Booking dockets');
    console.log('Migration 51 complete.');
  }

  // Migration 52: Booking documents
  if (!isMigrationApplied.get(52)) {
    console.log('Running migration 52: Booking documents');
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        document_type TEXT DEFAULT 'other',
        title TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        uploaded_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_docs_booking ON booking_documents(booking_id);
    `);
    recordMigration.run(52, 'Booking documents');
    console.log('Migration 52 complete.');
  }

  // Migration 53: Booking resource requirements + equipment assignments
  if (!isMigrationApplied.get(53)) {
    console.log('Running migration 53: Booking requirements + equipment');
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_requirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        quantity_required INTEGER DEFAULT 1,
        quantity_assigned INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_req_booking ON booking_requirements(booking_id);

      CREATE TABLE IF NOT EXISTS booking_equipment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        equipment_id INTEGER REFERENCES equipment(id),
        equipment_name TEXT DEFAULT '',
        equipment_type TEXT DEFAULT '',
        quantity INTEGER DEFAULT 1,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_equip_booking ON booking_equipment(booking_id);
    `);
    recordMigration.run(53, 'Booking requirements + equipment');
    console.log('Migration 53 complete.');
  }

  // Migration 54: Operational Chat / Messaging Tables
  if (!isMigrationApplied.get(54)) {
    console.log('Running migration 54: Operational Chat / Messaging Tables');
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_type TEXT NOT NULL CHECK(thread_type IN ('job','incident','compliance','broadcast')),
        related_entity_id INTEGER NOT NULL,
        related_entity_type TEXT NOT NULL CHECK(related_entity_type IN ('job','incident','compliance')),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','locked')),
        created_by INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_thread_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_in_thread TEXT NOT NULL DEFAULT 'member' CHECK(role_in_thread IN ('owner','member','readonly')),
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        muted_at DATETIME,
        last_read_message_id INTEGER DEFAULT 0,
        UNIQUE(thread_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id),
        body TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text','image','file','system')),
        reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        edited_at DATETIME,
        deleted_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        file_url TEXT NOT NULL,
        thumbnail_url TEXT DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        file_size INTEGER NOT NULL DEFAULT 0,
        original_name TEXT NOT NULL,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS message_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(message_id, mentioned_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_chat_threads_type ON chat_threads(thread_type);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_entity ON chat_threads(related_entity_type, related_entity_id);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_status ON chat_threads(status);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_thread ON chat_thread_members(thread_id);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_user ON chat_thread_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions(mentioned_user_id);
      CREATE INDEX IF NOT EXISTS idx_message_mentions_message ON message_mentions(message_id);
    `);
    recordMigration.run(54, 'Operational Chat / Messaging Tables');
    console.log('Migration 54 complete.');
  }

  // Migration 55: Extend chat_threads for DMs, channels, announcements
  if (!isMigrationApplied.get(55)) {
    console.log('Running migration 55: DMs, channels, announcements');

    // Rebuild chat_threads with extended CHECK + nullable entity columns + new columns
    // Save existing data first
    const existingThreads = db.prepare('SELECT * FROM chat_threads').all();
    const existingMembers = db.prepare('SELECT * FROM chat_thread_members').all();

    // Disable FK temporarily for the rebuild
    db.pragma('foreign_keys = OFF');

    // Drop old tables (messages FK references chat_threads but we keep messages intact)
    db.exec('DROP TABLE IF EXISTS chat_thread_members');
    db.exec('DROP TABLE IF EXISTS chat_threads');

    // Create new tables with extended schema
    db.exec(`
      CREATE TABLE chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_type TEXT NOT NULL CHECK(thread_type IN ('job','incident','compliance','broadcast','dm','channel','announcement')),
        related_entity_id INTEGER,
        related_entity_type TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','locked')),
        is_default INTEGER NOT NULL DEFAULT 0,
        channel_slug TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE chat_thread_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_in_thread TEXT NOT NULL DEFAULT 'member' CHECK(role_in_thread IN ('owner','member','readonly')),
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        muted_at DATETIME,
        last_read_message_id INTEGER DEFAULT 0,
        UNIQUE(thread_id, user_id)
      );
    `);

    // Restore data
    if (existingThreads.length > 0) {
      const insertThread = db.prepare('INSERT INTO chat_threads (id, thread_type, related_entity_id, related_entity_type, title, status, is_default, channel_slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)');
      for (const t of existingThreads) {
        insertThread.run(t.id, t.thread_type, t.related_entity_id, t.related_entity_type, t.title, t.status, t.created_by, t.created_at, t.updated_at);
      }
    }
    if (existingMembers.length > 0) {
      const insertMember = db.prepare('INSERT OR IGNORE INTO chat_thread_members (id, thread_id, user_id, role_in_thread, joined_at, muted_at, last_read_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const m of existingMembers) {
        insertMember.run(m.id, m.thread_id, m.user_id, m.role_in_thread, m.joined_at, m.muted_at, m.last_read_message_id);
      }
    }

    // Re-enable FK
    db.pragma('foreign_keys = ON');

    // Recreate indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_threads_type ON chat_threads(thread_type);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_entity ON chat_threads(related_entity_type, related_entity_id);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_status ON chat_threads(status);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_slug ON chat_threads(channel_slug);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_thread ON chat_thread_members(thread_id);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_user ON chat_thread_members(user_id);
    `);

    // Seed default channels
    const channels = [
      { slug: 'all-team', title: 'All Team', type: 'announcement', isDefault: 1 },
      { slug: 'operations', title: 'Operations', type: 'channel', isDefault: 1 },
      { slug: 'field-workers', title: 'Field Workers', type: 'channel', isDefault: 1 },
      { slug: 'supervisors', title: 'Supervisors', type: 'channel', isDefault: 1 },
      { slug: 'planning', title: 'Planning', type: 'channel', isDefault: 1 },
    ];
    const insertChannel = db.prepare('INSERT OR IGNORE INTO chat_threads (thread_type, title, status, is_default, channel_slug) VALUES (?, ?, \'active\', ?, ?)');
    for (const ch of channels) {
      const exists = db.prepare('SELECT id FROM chat_threads WHERE channel_slug = ?').get(ch.slug);
      if (!exists) {
        insertChannel.run(ch.type, ch.title, ch.isDefault, ch.slug);
      }
    }

    // Auto-add all existing active users to All Team channel
    const allTeam = db.prepare("SELECT id FROM chat_threads WHERE channel_slug = 'all-team'").get();
    if (allTeam) {
      const users = db.prepare('SELECT id FROM users WHERE active = 1').all();
      const addMember = db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)');
      for (const u of users) {
        addMember.run(allTeam.id, u.id, 'member');
      }
    }

    // Post welcome system messages in default channels
    const welcomeStmt = db.prepare("INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, NULL, ?, 'system')");
    const allChannels = db.prepare("SELECT id, title, channel_slug FROM chat_threads WHERE is_default = 1").all();
    for (const ch of allChannels) {
      const hasMessages = db.prepare('SELECT id FROM messages WHERE thread_id = ? LIMIT 1').get(ch.id);
      if (!hasMessages) {
        welcomeStmt.run(ch.id, `Welcome to ${ch.title}. This channel was created automatically.`);
      }
    }

    recordMigration.run(55, 'DMs, channels, announcements');
    console.log('Migration 55 complete.');
  }

  // Migration 56: Pinned messages + message editing support
  if (!isMigrationApplied.get(56)) {
    console.log('Running migration 56: Pinned messages');
    const cols56 = [
      "ALTER TABLE messages ADD COLUMN pinned_at DATETIME",
      "ALTER TABLE messages ADD COLUMN pinned_by INTEGER REFERENCES users(id)",
    ];
    for (const sql of cols56) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }
    recordMigration.run(56, 'Pinned messages');
    console.log('Migration 56 complete.');
  }

  // Migration 57: Clock events, crew availability, docket signatures, safety forms, employee leave
  if (!isMigrationApplied.get(57)) {
    console.log('Running migration 57: Sprint 2 tables — clock events, availability, dockets, safety forms, leave');
    db.exec(`
      CREATE TABLE IF NOT EXISTS clock_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        allocation_id INTEGER REFERENCES crew_allocations(id),
        event_type TEXT NOT NULL CHECK(event_type IN ('clock_in', 'clock_out')),
        event_time DATETIME NOT NULL DEFAULT (datetime('now')),
        latitude REAL,
        longitude REAL,
        accuracy REAL,
        address TEXT,
        notes TEXT,
        photo_path TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_clock_events_crew ON clock_events(crew_member_id, event_time);

      CREATE TABLE IF NOT EXISTS crew_availability (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'unavailable', 'preferred_off', 'leave')),
        shift_preference TEXT DEFAULT 'any' CHECK(shift_preference IN ('day', 'night', 'any')),
        notes TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(crew_member_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_crew_availability_crew ON crew_availability(crew_member_id, date);

      CREATE TABLE IF NOT EXISTS docket_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_id INTEGER REFERENCES crew_allocations(id),
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        docket_type TEXT DEFAULT 'daily_docket' CHECK(docket_type IN ('daily_docket', 'delivery', 'completion')),
        docket_number TEXT,
        client_name TEXT,
        signature_data TEXT,
        signed_at DATETIME DEFAULT (datetime('now')),
        notes TEXT,
        photo_path TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_docket_signatures_crew ON docket_signatures(crew_member_id);

      CREATE TABLE IF NOT EXISTS safety_forms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        -- form_type is widened to the full Job-Pack list in migration 139;
        -- the old CHECK ('prestart','take5','incident','hazard','equipment') is
        -- kept here so existing prod databases (which have it) line up exactly,
        -- then 139 rebuilds the table once with the expanded list.
        form_type TEXT NOT NULL CHECK(form_type IN ('prestart', 'take5', 'incident', 'hazard', 'equipment')),
        job_id INTEGER REFERENCES jobs(id),
        allocation_id INTEGER REFERENCES crew_allocations(id),
        data TEXT,
        status TEXT DEFAULT 'submitted' CHECK(status IN ('draft', 'submitted', 'reviewed')),
        submitted_at DATETIME DEFAULT (datetime('now')),
        reviewed_by_id INTEGER REFERENCES users(id),
        reviewed_at DATETIME,
        latitude REAL,
        longitude REAL,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_safety_forms_crew ON safety_forms(crew_member_id, form_type);

      CREATE TABLE IF NOT EXISTS employee_leave (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER REFERENCES employees(id),
        crew_member_id INTEGER REFERENCES crew_members(id),
        leave_type TEXT NOT NULL DEFAULT 'annual' CHECK(leave_type IN ('annual', 'sick', 'personal', 'unpaid', 'other')),
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        total_days REAL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
        reason TEXT,
        approved_by_id INTEGER REFERENCES users(id),
        approved_at DATETIME,
        notes TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_employee_leave_crew ON employee_leave(crew_member_id, status);
    `);

    // Add columns to crew_members
    const cols57cm = [
      "ALTER TABLE crew_members ADD COLUMN last_clock_event TEXT",
      "ALTER TABLE crew_members ADD COLUMN last_clock_time DATETIME",
      "ALTER TABLE crew_members ADD COLUMN onboarding_completed INTEGER DEFAULT 0",
    ];
    for (const sql of cols57cm) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }

    // Add column to incidents
    try { db.exec("ALTER TABLE incidents ADD COLUMN reported_by_crew_id INTEGER REFERENCES crew_members(id)"); } catch (e) { /* column may already exist */ }

    recordMigration.run(57, 'Sprint 2 tables — clock events, availability, dockets, safety forms, leave');
    console.log('Migration 57 complete.');
  }

  // =============================================
  // Migration 58: Induction form enhancements — new fields
  // =============================================
  if (!isMigrationApplied.get(58)) {
    console.log('Running migration 58: Induction form enhancements');
    try {
      const newCols58 = [
        "ALTER TABLE induction_submissions ADD COLUMN tc_licence_date_of_issue TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN tc_licence_state TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN experience_years TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN experience_description TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN drivers_licence_back_photo TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_fund_name TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_fund_abn TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_usi TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_member_number TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN has_insurance TEXT DEFAULT ''",
      ];
      for (const sql of newCols58) {
        try { db.exec(sql); } catch (e) { /* column likely exists */ }
      }
    } catch (e) {
      console.error('Migration 58 error:', e.message);
    }
    recordMigration.run(58, 'Induction form enhancements');
    console.log('Migration 58 complete.');
  }

  // =============================================
  // Migration 59: Clear all dummy/seed data
  // =============================================
  if (!isMigrationApplied.get(59)) {
    console.log('Running migration 59: Clear dummy/seed data');
    try {
      // Clear tables that only contain seed data
      const tablesToClear = [
        'traffic_plans',
        'crew_allocations',
        'timesheets',
        'cost_entries',
        'job_budgets',
        'incidents',
        'defects',
        'tasks',
        'equipment',
        'contacts',
        'compliance_items',
        'crew_members',
        'employees',
        'jobs',
        'clients',
      ];
      for (const table of tablesToClear) {
        try {
          db.exec(`DELETE FROM ${table}`);
          console.log(`  Cleared ${table}`);
        } catch (e) {
          // Table might not exist
          console.log(`  Skipped ${table}: ${e.message}`);
        }
      }
      // Reset auto-increment counters
      try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('traffic_plans','crew_allocations','timesheets','cost_entries','job_budgets','incidents','defects','tasks','equipment','contacts','compliance_items','crew_members','employees','jobs','clients')"); } catch(e) {}
    } catch (e) {
      console.error('Migration 59 error:', e.message);
    }
    recordMigration.run(59, 'Clear dummy/seed data');
    console.log('Migration 59 complete — all seed data cleared.');
  }

  // Migration 60: Add emergency contact fields to induction_submissions
  if (!isMigrationApplied.get(60)) {
    console.log('Running migration 60: Add emergency contact to induction_submissions');
    const newCols60 = [
      "ALTER TABLE induction_submissions ADD COLUMN emergency_contact_name TEXT DEFAULT ''",
      "ALTER TABLE induction_submissions ADD COLUMN emergency_contact_phone TEXT DEFAULT ''",
      "ALTER TABLE induction_submissions ADD COLUMN emergency_contact_relationship TEXT DEFAULT ''",
    ];
    for (const sql of newCols60) {
      try { db.exec(sql); } catch (e) { /* column likely exists */ }
    }
    recordMigration.run(60, 'Add emergency contact to induction_submissions');
    console.log('Migration 60 complete.');
  }

  // Migration 61: Add licence/card number fields to employees table
  if (!isMigrationApplied.get(61)) {
    console.log('Running migration 61: Add licence number fields to employees');
    const newCols61 = [
      "ALTER TABLE employees ADD COLUMN white_card_number TEXT DEFAULT ''",
      "ALTER TABLE employees ADD COLUMN tc_licence_number TEXT DEFAULT ''",
      "ALTER TABLE employees ADD COLUMN tc_licence_state TEXT DEFAULT ''",
      "ALTER TABLE employees ADD COLUMN tc_licence_date_of_issue TEXT DEFAULT ''",
      "ALTER TABLE employees ADD COLUMN drivers_licence_number TEXT DEFAULT ''",
    ];
    for (const sql of newCols61) {
      try { db.exec(sql); } catch (e) { /* column likely exists */ }
    }
    recordMigration.run(61, 'Add licence number fields to employees');
    console.log('Migration 61 complete.');
  }

  // Migration 62: Enhanced docket_signatures with time entries + client signature
  if (!isMigrationApplied.get(62)) {
    console.log('Running migration 62: Enhanced docket signatures');
    const newCols62 = [
      "ALTER TABLE docket_signatures ADD COLUMN start_on_site TEXT DEFAULT ''",
      "ALTER TABLE docket_signatures ADD COLUMN finish_on_site TEXT DEFAULT ''",
      "ALTER TABLE docket_signatures ADD COLUMN break_minutes INTEGER DEFAULT 0",
      "ALTER TABLE docket_signatures ADD COLUMN travel_hours REAL DEFAULT 0",
      "ALTER TABLE docket_signatures ADD COLUMN total_hours REAL DEFAULT 0",
      "ALTER TABLE docket_signatures ADD COLUMN client_signature TEXT DEFAULT ''",
      "ALTER TABLE docket_signatures ADD COLUMN client_signed_name TEXT DEFAULT ''",
      "ALTER TABLE docket_signatures ADD COLUMN client_signed_at DATETIME",
    ];
    for (const sql of newCols62) {
      try { db.exec(sql); } catch (e) { /* column likely exists */ }
    }
    recordMigration.run(62, 'Enhanced docket signatures');
    console.log('Migration 62 complete.');
  }

  // Migration 63: Nuke ALL data for clean production launch (keep only users)
  if (!isMigrationApplied.get(63)) {
    console.log('Running migration 63: Wipe all data for clean production launch');
    try {
      // Order matters: children before parents to respect foreign keys
      const tablesToWipe = [
        'activity_log', 'notifications', 'push_subscriptions',
        'messages', 'message_attachments', 'message_mentions',
        'chat_thread_members', 'chat_threads',
        'docket_signatures', 'docket_time_entries',
        'booking_crew', 'booking_dockets', 'booking_documents',
        'booking_equipment', 'booking_notes', 'booking_requirements', 'booking_vehicles',
        'bookings',
        'clock_events', 'crew_allocations', 'crew_availability',
        'task_comments', 'task_dependencies', 'subtasks', 'tasks',
        'cost_entries', 'job_budgets',
        'corrective_actions', 'incident_crew_members', 'incidents',
        'safety_forms',
        'equipment_maintenance', 'equipment_assignments', 'equipment',
        'employee_competencies', 'employee_documents', 'employee_leave',
        'timesheets', 'crew_members', 'employees',
        'documents', 'compliance', 'defects',
        'project_updates', 'traffic_plans',
        'communication_log', 'client_contacts',
        'crm_activities', 'crm_meetings', 'opportunities',
        'saved_views', 'invitations',
        'external_refs', 'sync_log',
        'clients', 'jobs',
      ];
      for (const table of tablesToWipe) {
        try {
          db.exec(`DELETE FROM ${table}`);
          console.log(`  Cleared ${table}`);
        } catch (e) {
          console.log(`  Skipped ${table}: ${e.message}`);
        }
      }
      // Reset auto-increment counters
      try {
        const names = tablesToWipe.map(t => `'${t}'`).join(',');
        db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${names})`);
      } catch (e) { /* ok */ }
    } catch (e) {
      console.error('Migration 63 error:', e.message);
    }
    recordMigration.run(63, 'Wipe all data for clean production launch');
    console.log('Migration 63 complete — database is clean.');
  }

  // Migration 64: Import 2026 TGS Register into Plans & Approvals
  // Seed body is T&S-customer-specific (92 TGS entries assigned to T&S staff).
  // Gated by SEED_T_AND_S_DATA. T&S production already has this migration
  // recorded so this gate has no effect there. Fresh deployments skip.
  if (!isMigrationApplied.get(64)) {
    if (!SEED_T_AND_S_DATA) {
      console.log('Migration 64: skipped T&S TGS Register seed (set SEED_T_AND_S_DATA=true to enable)');
      recordMigration.run(64, 'Import 2026 TGS Register (skipped, not a T&S deployment)');
    } else {
    console.log('Running migration 64: Import 2026 TGS Register (92 entries)');
    try {
      // Map PM short names to user IDs
      const pmUsers = db.prepare("SELECT id, username, full_name FROM users").all();
      const pmMap = {};
      pmUsers.forEach(u => {
        pmMap[u.username.toLowerCase()] = u.id;
        if (u.full_name) pmMap[u.full_name.split(' ')[0].toLowerCase()] = u.id;
      });

      const ins64 = db.prepare(`INSERT INTO compliance (job_id, client_id, item_type, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, designer, file_link, council_fee_paid, council_fee_amount, reference_number, rol_required, rol_response, bus_approvals_required, bus_approvals_response, client_pm, costs, action_required, charge_client, charge_amount, invoiced, invoice_number, police_notification, letter_drop) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

      ins64.run(null, null, 'traffic_guidance', 'TGS | Impact Cranes | 16 Mountain St, Ultimo', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-01-12', null, null, null, 'not_started', 'ROL, Police,Letter Drop - New Date Update 20.02.2026', '', '', 0, 0, '', 1, '', 1, 'Yes', 'Paul', 0, 'All Updates', 0, 0, 0, '', 1, 1);
      ins64.run(null, null, 'traffic_guidance', 'Deferred Date Application | Impact Cranes', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', 'Deferred Date Application', '', '', 0, 0, 'Deferred Date Application', 0, '', 0, '', 'Paul', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'other', 'Police Notif | TQM | Wentworth  Hotel', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Police Notif', 0, '', 0, '', 'Greg', 0, '', 0, 0, 0, '', 1, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3001 | Labourconnect | Simpson St, Dundas Valley', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3001', 0, '', 0, '', 'Alex', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'Parking Fee | Impact Cranes | York St', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Parking Fee', 0, '', 0, '', 'Paul', 1050.0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3002 | QMC Group | Highview Ave, Manly', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3002', 0, '', 0, '', 'Jayden', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'road_occupancy', 'ROL ext. | SIFU | Darlinghurst Rd', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'ROL ext.', 1, '', 0, '', 'Frank', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'other', 'Police Notif | TQM | Wentworth Hotel', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', 'New Dates received', '', '', 0, 0, 'Police Notif', 1, '', 0, '', 'Greg', 0, '', 0, 0, 0, '', 1, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3003 | Ace Demo & Civil | 2-4 URANGA PDE MIRANDA', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3003', 0, '', 0, '', 'Osama', 0, '', 1, 150.0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3010 | Cubic CM | Pappa Flock Parramatta', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-01-19', null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3010', 0, '', 0, '', 'Zain', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3011 | Cubic CM', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-01-19', null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3011', 0, '', 0, '', 'Zain', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'tmp_approval', 'TMP | Cubic CM | Pappa Flock Parramatta', '', pmMap['suhail'] || null, pmMap['suhail'] || null, '2026-01-19', null, null, null, 'not_started', '', '', '', 0, 0, 'TMP', 0, '', 0, '', 'Zain', 0, '', 1, 2500.0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3004 | LBC | 30 Botany Rd, Alexandria', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3004', 0, '', 0, '', 'Antony', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3005 | AICC', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3005', 0, '', 0, '', 'Munzir', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3006 | TQM | 47-51 Wentowrth St Port Kembla Project ', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-01-22', null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3006', 0, '', 0, '', 'Youseff', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TGS | TQM | Wentworth Hotel', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-01-27', null, null, null, 'not_started', '', '', '', 0, 0, '', 1, '', 0, '', 'Greg', 0, 'ROL ext', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3008 | Compass Dev', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3008', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3009 | CIP', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3009', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3012 | AICC | Wollongong Mosque', '', pmMap['noah'] || null, pmMap['noah'] || null, null, null, null, null, 'not_started', 'to be invoiced once works complete', '', '', 0, 0, 'TSTGS3012', 0, '', 0, '', 'Munzir', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3013 | AICC | Wollongong Mosque', '', pmMap['noah'] || null, pmMap['noah'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3013', 0, '', 0, '', 'Munzir', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3014 | AICC | Wollongong Mosque', '', pmMap['noah'] || null, pmMap['noah'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3014', 0, '', 0, '', 'Munzir', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'other', 'Police notif | TQM | Wentworth  Hotel', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-01-30', null, '2026-02-02', null, 'approved', 'Crane works delayed again to 04-06/02', '', '', 0, 0, 'Police notif', 1, 'Approved', 1, 'Approved', 'Greg', 0, 'ROL + Police', 0, 0, 1, '', 1, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3016 | Just Flow | Darlinghurst Public School', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-02-02', null, null, null, 'approved', '', '', '', 0, 0, 'TSTGS3016', 0, 'Approved', 1, 'Pending', 'Monzir', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'other', 'Police notif | Just Flow', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Police notif', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 1, 0);
      ins64.run(null, null, 'traffic_guidance', 'ROP | Just Flow | Darlinghurst Public School', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'ROP', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TGS Revision | Axial Constructions', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TGS Revision', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3015 | LBC | Botany Rd, Alexandria', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-02-02', null, '2026-02-02', null, 'approved', '', '', '', 0, 0, 'TSTGS3015', 0, '', 0, '', 'Anthony', 0.0, 'TGS', 1, 120.0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TGS3021 | LBC | 79 - 101 Heath Rd, Leppington (Roads 1 & 2 Tie-in)', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-02-02', null, null, null, 'not_started', '', '', '', 0, 0, 'TGS3021', 0, '', 0, '', 'Chad', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'council_permit', 'Council Approval | Axial Constructions | Holindsworth Rd, Marsden Park', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Council Approval', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTG3017 | Tamaki Constructions | 16 Fremont Ave Ermington', '', pmMap['sav'] || null, pmMap['sav'] || null, '2026-02-03', null, '2026-02-03', null, 'approved', 'tamakiconstructiongroup@gmail.com', '', '', 0, 0, 'TSTG3017', 0, '', 0, '', '', 0, '', 1, 200.0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'Extend Date of application | Icon Build', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Extend Date of application', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3018 | LBC', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-02-03', null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3018', 1, '', 0, '', 'Antony', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3019 | LBC | Vicar St, Coogee', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3019', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3020 | LBC | 3 Homebush road Strathfield', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3020', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'tmp_approval', 'LC CTMP105 | LBC', '', pmMap['suhail'] || null, pmMap['suhail'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'LC CTMP105', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3027 | LBC | 21 McGill street lewisham', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, '2026-02-16', null, 'approved', '', '', '', 0, 0, 'TSTGS3027', 0, '', 0, '', 'Anthony', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'tmp_approval', 'LC CTMP104 | LBC', '', pmMap['suhail'] || null, pmMap['suhail'] || null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'LC CTMP104', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'council_permit', 'Council Appliation | Skyscraper Tower Cranes', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Council Appliation', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3021 | LBC | Bronte SLSC', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3021', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'council_permit', 'Council Approval | AICC', '', null, null, null, null, null, null, 'not_started', 'Laylatul Qadr 16.03.2026', '', '', 0, 0, 'Council Approval', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TGS3023 | Impact Cranes | 39 York St', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TGS3023', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'council_permit', 'Council Approval | Impact Cranes | 39 York St', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Council Approval', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'other', 'Police Approval | Impact Cranes', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Police Approval', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 1, 0);
      ins64.run(null, null, 'council_permit', 'Council Application | LBC | Chapel Ln, Alexandria', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Council Application', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'other', 'Police Notification | LBC | Chapel Ln, Alexandria', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Police Notification', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 1, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3022 | LBC | Chapel Ln, Alexandria', '', pmMap['sav'] || null, pmMap['sav'] || null, '2026-02-11', null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3022', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3023 | Taha | 310 Marsden Rd, Carlingford', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3023', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS 3027 | ACG | 1450 Pittwater Rd, North Narrabeen', '', pmMap['taj'] || null, pmMap['taj'] || null, '2025-02-15', null, '2025-02-16', null, 'approved', '', '', '', 0, 0, 'TSTGS 3027', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS 3028 | ACG | 1450 Pittwater Rd, North Narrabeen', '', pmMap['taj'] || null, pmMap['taj'] || null, '2025-02-16', null, '2025-02-17', null, 'approved', '', '', '', 0, 0, 'TSTGS 3028', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3024 | ACG | 70 Mame Rd, St Marys', '', pmMap['sav'] || null, pmMap['sav'] || null, '2025-02-16', null, '2026-02-17', null, 'approved', '', '', '', 0, 0, 'TSTGS3024', 0, 'Pending', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3025 | ACG | 603 George St, Windsor', '', pmMap['sav'] || null, pmMap['sav'] || null, '2025-02-16', null, '2026-02-17', null, 'approved', '', '', '', 0, 0, 'TSTGS3025', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3032 | ACG', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3032', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3026 | ManWorx | 94 Epping Rd, North Ryde', '', pmMap['taj'] || null, pmMap['taj'] || null, '2026-02-15', null, '2026-02-17', null, 'approved', '', '', '', 0, 0, 'TSTGS3026', 0, '', 1, 'Pending', 'Hammad', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TGS3029 | Greenbrook | 103 Moore St, Liverpool', '', null, null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TGS3029', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TGS3030 | LBC | Bronte SLSC', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TGS3030', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3031 | AM2PM Group | 98 Audley St, Petersham', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3031', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3034 | AM2PM Group | Northwood Rd, Longueville', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3034', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3035 | AM2PM Group', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3035', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'council_permit', 'Council Application | AM2PM Group | Northwood Rd, Longueville', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Council Application', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3033 | UMA', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3033', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3032 | LBC | Botany Rd, Alexandria', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3032', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'tmp_approval', 'LC CTMP106 | LBC | Glossop St, St Marys', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'LC CTMP106', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3036 | LBC | Glossop St, St Marys', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3036', 0, '', 0, '', '', 0, '', 0, 0, 1, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3037 | ACG | Barcom Ave Marrylands', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3037', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3038 | AM2PM Group | 94 Beami9sh St, Camspie', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'TSTGS3038', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'council_permit', 'Council Application | Axial Constructions | Heddon Gretta', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, 'Council Application', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3030 | ACG | Marion St, Auburn', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3030', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3031 | ACG | Milton St, Lidcombe', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3031', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3032 | ACG | Myall St, Merrylands', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3032', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3033 | ACG | Neil St, Merrylands', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3033', 0, 'Pending', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3034 | ACG | Nottinghill Rd, Berala', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3034', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3035 | ACG | Vaughan St, Lidcombe', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3035', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3036 | ACG | Hill Rd, Olyimpic Park', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3036', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3037 | ACG | Dawn Fraser Ave, Olympic Park', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3037', 0, 'Pending', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3038 | ACG | 603 George St, Windsor', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3038', 0, 'Pending', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3039 | Atlantis | 178 Corrimal St', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3039', 0, 'Pending', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3040 | AM2PM Group | Doyle St, Narrabri', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3040', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TGS | March - 2026', '', null, null, null, null, null, null, 'not_started', '', '', '', 0, 0, '', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3050 | Ace Demo | 365 CLYDE ST SOUTH GRANVILLE', '', null, null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3050', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3051 | Ace Demo | 10 Ian St Rose Bay', '', null, null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3051', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3052 | Ace Demo | 10 Ian St Rose Bay', '', null, null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3052', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3041 | ACG | Bridge st, Lidcombe', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3041', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3042 | ACG | Grace Ave, Lidcombe', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3042', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3043 | ACG | Loftus Rd, Yennora', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3043', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3044 | ACG | 2 Hawksbury Rd, Westmead', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3044', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3045 | ACG | 26 Junia Ave, Toongabbie', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3045', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3046 | ACG | Fox St, Holroyd', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3046', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3047 | ACG | Gallpoli st, Lidcombe', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3047', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3048 | ACG | Blaxcell st, Guildford', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3048', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3049 | ACG | Locksley Sve, Merrylands', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3049', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3050 | ACG | Amy St, Regents Park', '', pmMap['sav'] || null, pmMap['sav'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3050', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);
      ins64.run(null, null, 'traffic_guidance', 'TSTGS3053 | LBC | 9 Bourke Rd, Alexandria', '', pmMap['taj'] || null, pmMap['taj'] || null, null, null, null, null, 'submitted', '', '', '', 0, 0, 'TSTGS3053', 0, '', 0, '', '', 0, '', 0, 0, 0, '', 0, 0);

    } catch (e) {
      console.error('Migration 64 error:', e.message);
    }
    recordMigration.run(64, 'Import 2026 TGS Register');
    console.log('Migration 64 complete — 92 TGS entries imported.');
    } // end else (SEED_T_AND_S_DATA)
  }

  // Migration 65: Add police_notification and letter_drop to compliance item_type CHECK
  if (!isMigrationApplied.get(65)) {
    console.log('Running migration 65: Expand compliance item_type CHECK constraint');
    try {
      const oldDDL = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'compliance'").get().sql;
      if (!oldDDL.includes('police_notification')) {
        const cols = db.prepare("PRAGMA table_info(compliance)").all();
        const colDefs = cols.map(c => {
          let def = `${c.name} ${c.type}`;
          if (c.name === 'item_type') {
            def = "item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','spa','police_notification','letter_drop','other'))";
          } else {
            if (c.notnull) def += ' NOT NULL';
            if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
          }
          if (c.pk) def += ' PRIMARY KEY AUTOINCREMENT';
          return def;
        }).join(', ');

        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');
        db.exec(`CREATE TABLE compliance_new (${colDefs})`);
        db.exec('INSERT INTO compliance_new SELECT * FROM compliance');
        db.exec('DROP TABLE compliance');
        db.exec('ALTER TABLE compliance_new RENAME TO compliance');
        db.exec('COMMIT');
        db.exec('PRAGMA foreign_keys = ON');
        console.log('  Rebuilt compliance table with expanded item_type CHECK.');
      }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error('Migration 65 error:', e.message);
    }
    recordMigration.run(65, 'Add police_notification and letter_drop to compliance item_type');
    console.log('Migration 65 complete.');
  }

  // Migration 66: Compliance documents table
  if (!isMigrationApplied.get(66)) {
    console.log('Running migration 66: Compliance documents table');
    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compliance_id INTEGER NOT NULL REFERENCES compliance(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT DEFAULT '',
        uploaded_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_compliance_docs_compliance ON compliance_documents(compliance_id);
    `);
    recordMigration.run(66, 'Compliance documents table');
    console.log('Migration 66 complete.');
  }

  // =============================================
  // Migration 67: Worker Availability table (Sprint 2 — detailed per-day availability)
  // =============================================
  if (!isMigrationApplied.get(67)) {
    console.log('Running migration 67: Worker Availability table');
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_availability (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('available', 'unavailable', 'partial')),
        start_time TEXT,
        end_time TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now')),
        FOREIGN KEY (crew_member_id) REFERENCES crew_members(id),
        UNIQUE(crew_member_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_worker_availability_crew ON worker_availability(crew_member_id);
      CREATE INDEX IF NOT EXISTS idx_worker_availability_date ON worker_availability(crew_member_id, date);
    `);
    recordMigration.run(67, 'Worker Availability table');
    console.log('Migration 67 complete.');
  }

  // =============================================
  // Migration 68: Site Diary Entries table
  // =============================================
  if (!isMigrationApplied.get(68)) {
    console.log('Running migration 68: Site Diary Entries table');
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_diary_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        entry_date DATE NOT NULL,
        task TEXT DEFAULT '',
        representative TEXT DEFAULT '',
        client_representative TEXT DEFAULT '',
        outcomes TEXT DEFAULT '',
        issues TEXT DEFAULT '',
        comments TEXT DEFAULT '',
        stage TEXT DEFAULT '',
        tgs_number TEXT DEFAULT '',
        tgs_scope TEXT DEFAULT '',
        tgs_plan_id INTEGER REFERENCES traffic_plans(id),
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_site_diary_job ON site_diary_entries(job_id);
      CREATE INDEX IF NOT EXISTS idx_site_diary_date ON site_diary_entries(entry_date);
    `);
    recordMigration.run(68, 'Site Diary Entries table');
    console.log('Migration 68 complete.');
  }

  // =============================================
  // Migration 69: Traffic Plans enhancements
  // =============================================
  if (!isMigrationApplied.get(69)) {
    console.log('Running migration 69: Traffic Plans enhancements');
    const planCols = [
      "ALTER TABLE traffic_plans ADD COLUMN plan_types TEXT DEFAULT ''",
      "ALTER TABLE traffic_plans ADD COLUMN client_required_date DATE",
      "ALTER TABLE traffic_plans ADD COLUMN works_expected_date DATE",
      "ALTER TABLE traffic_plans ADD COLUMN file_path TEXT DEFAULT ''",
      "ALTER TABLE traffic_plans ADD COLUMN file_original_name TEXT DEFAULT ''"
    ];
    planCols.forEach(sql => { try { db.exec(sql); } catch(e) { /* column may exist */ } });
    // Backfill plan_types from plan_type
    try { db.exec("UPDATE traffic_plans SET plan_types = plan_type WHERE (plan_types = '' OR plan_types IS NULL) AND plan_type IS NOT NULL"); } catch(e) {}
    recordMigration.run(69, 'Traffic Plans enhancements: plan_types, new dates, file upload');
    console.log('Migration 69 complete.');
  }

  // =============================================
  // Migration 70: Compliance item_types multi-select
  // =============================================
  if (!isMigrationApplied.get(70)) {
    console.log('Running migration 70: Compliance item_types multi-select');
    try { db.exec("ALTER TABLE compliance ADD COLUMN item_types TEXT DEFAULT ''"); } catch(e) { /* column may exist */ }
    try { db.exec("UPDATE compliance SET item_types = item_type WHERE (item_types = '' OR item_types IS NULL) AND item_type IS NOT NULL AND item_type != ''"); } catch(e) {}
    recordMigration.run(70, 'Compliance item_types multi-select column');
    console.log('Migration 70 complete.');
  }

  if (!isMigrationApplied.get(71)) {
    console.log('Running migration 71: Remove CHECK constraint on jobs.stage');
    db.exec('PRAGMA foreign_keys=OFF;');
    try {
      const fixExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_stage_fix'").get();
      const jobsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get();
      // Step 1: backup jobs data (skip if already done in a previous partial run)
      if (!fixExists && jobsExists) {
        db.exec('CREATE TABLE jobs_stage_fix AS SELECT * FROM jobs;');
      }
      // Step 2: drop old jobs table (skip if already dropped)
      if (jobsExists) {
        db.exec('DROP TABLE jobs;');
      }
      // Step 3: recreate jobs without CHECK constraint on stage
      const jobsExistsNow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get();
      if (!jobsExistsNow) {
        db.exec(`CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_number TEXT UNIQUE NOT NULL,
          job_name TEXT NOT NULL,
          client TEXT NOT NULL,
          site_address TEXT NOT NULL,
          suburb TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'tender',
          stage TEXT NOT NULL DEFAULT 'tender',
          percent_complete INTEGER NOT NULL DEFAULT 0 CHECK(percent_complete >= 0 AND percent_complete <= 100),
          start_date DATE NOT NULL,
          end_date DATE,
          project_manager_id INTEGER REFERENCES users(id),
          ops_supervisor_id INTEGER REFERENCES users(id),
          planning_owner_id INTEGER REFERENCES users(id),
          marketing_owner_id INTEGER REFERENCES users(id),
          accounts_owner_id INTEGER REFERENCES users(id),
          health TEXT DEFAULT 'good',
          accounts_status TEXT DEFAULT 'not_invoiced',
          division_tags TEXT DEFAULT '[]',
          notes TEXT DEFAULT '',
          client_project_number TEXT DEFAULT '',
          project_name TEXT DEFAULT '',
          principal_contractor TEXT DEFAULT '',
          traffic_supervisor_id INTEGER REFERENCES users(id),
          contract_value REAL DEFAULT 0,
          estimated_hours REAL DEFAULT 0,
          crew_size INTEGER DEFAULT 0,
          rol_required INTEGER DEFAULT 0,
          tmp_required INTEGER DEFAULT 0,
          sharepoint_url TEXT DEFAULT '',
          state TEXT DEFAULT 'NSW',
          required_tcp_level TEXT DEFAULT '',
          client_id INTEGER REFERENCES clients(id),
          parent_project_id INTEGER REFERENCES jobs(id),
          last_update_date DATE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );`);
      }
      // Step 4: restore data from backup using explicit column list to avoid count mismatches
      const fixStillExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_stage_fix'").get();
      if (fixStillExists) {
        db.exec(`INSERT INTO jobs (id, job_number, job_name, client, site_address, suburb, status, stage,
          percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id,
          planning_owner_id, marketing_owner_id, accounts_owner_id, health, accounts_status,
          division_tags, notes, client_project_number, project_name, principal_contractor,
          traffic_supervisor_id, contract_value, estimated_hours, crew_size, rol_required,
          tmp_required, sharepoint_url, state, required_tcp_level, client_id, parent_project_id,
          last_update_date, created_at, updated_at)
          SELECT id, job_number, job_name, client, site_address, suburb, status, stage,
          percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id,
          planning_owner_id, marketing_owner_id, accounts_owner_id, health, accounts_status,
          division_tags, notes, client_project_number, project_name, principal_contractor,
          traffic_supervisor_id, contract_value, estimated_hours, crew_size, rol_required,
          tmp_required, sharepoint_url, state, required_tcp_level, client_id, parent_project_id,
          last_update_date, created_at, updated_at FROM jobs_stage_fix;`);
        db.exec('DROP TABLE jobs_stage_fix;');
      }
    } finally {
      db.exec('PRAGMA foreign_keys=ON;');
    }
    recordMigration.run(71, 'Remove CHECK constraint on jobs.stage');
    console.log('Migration 71 complete.');
  }

  // Migration 72: Remove status CHECK constraint from compliance (allow any status value)
  if (!isMigrationApplied.get(72)) {
    try {
      // First check if backup table was left from a failed previous attempt
      const backupExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_compliance_backup_72'").get();
      if (backupExists) {
        // Previous migration attempt failed mid-way — check which table has data
        const mainExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compliance'").get();
        if (!mainExists) {
          db.exec('ALTER TABLE _compliance_backup_72 RENAME TO compliance');
          console.log('Migration 72: Restored compliance from orphaned backup.');
        } else {
          db.exec('DROP TABLE IF EXISTS _compliance_backup_72');
          console.log('Migration 72: Cleaned up orphaned backup (compliance exists).');
        }
      }

      const ddlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='compliance'").get();
      if (ddlRow && ddlRow.sql && ddlRow.sql.includes('status') && ddlRow.sql.includes('CHECK')) {
        const cols = db.prepare("PRAGMA table_info(compliance)").all().map(c => c.name);
        const colList = cols.join(', ');
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');
        db.exec('ALTER TABLE compliance RENAME TO _compliance_backup_72');
        // Remove the status CHECK entirely — enforce at app level instead
        let newDDL = ddlRow.sql.replace('_compliance_backup_72', 'compliance');
        // Remove CHECK(status IN (...)) with any content
        newDDL = newDDL.replace(/,?\s*CHECK\s*\(\s*status\s+IN\s*\([^)]+\)\s*\)/gi, '');
        db.exec(newDDL);
        db.exec(`INSERT INTO compliance (${colList}) SELECT ${colList} FROM _compliance_backup_72`);
        db.exec('DROP TABLE _compliance_backup_72');
        db.exec('COMMIT');
        db.exec('PRAGMA foreign_keys = ON');
        console.log('Migration 72: Removed status CHECK from compliance table.');
      } else {
        console.log('Migration 72: No status CHECK found, skipping.');
      }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
      try {
        const backupStillExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_compliance_backup_72'").get();
        const mainStillExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compliance'").get();
        if (backupStillExists && !mainStillExists) {
          db.exec('ALTER TABLE _compliance_backup_72 RENAME TO compliance');
          console.log('Migration 72: Restored from backup after error.');
        }
      } catch (_) {}
      console.error('Migration 72 error:', e.message);
    }
    recordMigration.run(72, 'Remove status CHECK from compliance');
    console.log('Migration 72 complete.');
  }

  // Migration 73: Add approval flags and vehicles to jobs table
  if (!isMigrationApplied.get(73)) {
    const newCols73 = [
      ['tgs_required', 'INTEGER DEFAULT 0'],
      ['spa_required', 'INTEGER DEFAULT 0'],
      ['council_approval', 'INTEGER DEFAULT 0'],
      ['bus_approval', 'INTEGER DEFAULT 0'],
      ['vehicles', 'INTEGER DEFAULT 0'],
    ];
    newCols73.forEach(([col, def]) => {
      try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${def}`); } catch(e) { /* exists */ }
    });
    recordMigration.run(73, 'Add approval flags and vehicles to jobs');
    console.log('Migration 73 complete.');
  }

  // Migration 74: Site Diary enhancements — rep dropdown, compliance link, equipment, attachments
  if (!isMigrationApplied.get(74)) {
    const newCols74 = [
      ['representative_id', 'INTEGER REFERENCES users(id)'],
      ['compliance_item_id', 'INTEGER REFERENCES compliance(id)'],
      ['equipment_assignment_id', 'INTEGER REFERENCES equipment_assignments(id)'],
    ];
    newCols74.forEach(([col, def]) => {
      try { db.exec(`ALTER TABLE site_diary_entries ADD COLUMN ${col} ${def}`); } catch(e) { /* exists */ }
    });
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_diary_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        diary_entry_id INTEGER NOT NULL REFERENCES site_diary_entries(id) ON DELETE CASCADE,
        file_path TEXT DEFAULT '',
        original_name TEXT DEFAULT '',
        sharepoint_link TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_diary_attach_entry ON site_diary_attachments(diary_entry_id)'); } catch(e) {}
    recordMigration.run(74, 'Site diary enhancements');
    console.log('Migration 74 complete.');
  }

  // Migration 75: Add ready_for_invoice flag to compliance
  if (!isMigrationApplied.get(75)) {
    try { db.exec("ALTER TABLE compliance ADD COLUMN ready_for_invoice INTEGER DEFAULT 0"); } catch(e) { /* exists */ }
    try { db.exec("ALTER TABLE compliance ADD COLUMN ready_for_invoice_at DATETIME"); } catch(e) { /* exists */ }
    try { db.exec("ALTER TABLE compliance ADD COLUMN ready_for_invoice_by INTEGER REFERENCES users(id)"); } catch(e) { /* exists */ }
    recordMigration.run(75, 'Add ready_for_invoice to compliance');
    console.log('Migration 75 complete.');
  }

  // Migration 76: Add per-type response columns to compliance
  if (!isMigrationApplied.get(76)) {
    const cols76 = [
      ['tmp_response', "TEXT DEFAULT ''"],
      ['spa_response', "TEXT DEFAULT ''"],
      ['council_response', "TEXT DEFAULT ''"],
      ['tgs_response', "TEXT DEFAULT ''"],
      ['police_response', "TEXT DEFAULT ''"],
      ['letter_drop_response', "TEXT DEFAULT ''"],
    ];
    cols76.forEach(([col, def]) => {
      try { db.exec(`ALTER TABLE compliance ADD COLUMN ${col} ${def}`); } catch(e) { /* exists */ }
    });
    recordMigration.run(76, 'Add per-type response columns to compliance');
    console.log('Migration 76 complete.');
  }

  // Migration 77: Fix compliance_documents FK after table rebuild + cleanup backup
  if (!isMigrationApplied.get(77)) {
    try {
      // Drop orphaned backup table if it exists
      db.exec('DROP TABLE IF EXISTS _compliance_backup_72');
      // Add other_description column
      try { db.exec("ALTER TABLE compliance ADD COLUMN other_description TEXT DEFAULT ''"); } catch(e) { /* exists */ }
      // Rebuild compliance_documents to fix broken FK reference
      const cdExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compliance_documents'").get();
      if (cdExists) {
        const cdCols = db.prepare("PRAGMA table_info(compliance_documents)").all().map(c => c.name);
        const cdColList = cdCols.join(', ');
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');
        db.exec('ALTER TABLE compliance_documents RENAME TO _cd_backup_77');
        db.exec(`
          CREATE TABLE compliance_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            compliance_id INTEGER NOT NULL REFERENCES compliance(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            original_name TEXT DEFAULT '',
            file_path TEXT DEFAULT '',
            file_size INTEGER DEFAULT 0,
            mime_type TEXT DEFAULT '',
            uploaded_by_id INTEGER REFERENCES users(id),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db.exec(`INSERT INTO compliance_documents (${cdColList}) SELECT ${cdColList} FROM _cd_backup_77`);
        db.exec('DROP TABLE _cd_backup_77');
        db.exec('COMMIT');
        db.exec('PRAGMA foreign_keys = ON');
        console.log('Migration 77: Rebuilt compliance_documents with correct FK.');
      }
    } catch(e) {
      try { db.exec('ROLLBACK'); } catch(_) {}
      try { db.exec('PRAGMA foreign_keys = ON'); } catch(_) {}
      try {
        const backup = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_cd_backup_77'").get();
        const main = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compliance_documents'").get();
        if (backup && !main) db.exec('ALTER TABLE _cd_backup_77 RENAME TO compliance_documents');
      } catch(_) {}
      console.error('Migration 77 error:', e.message);
    }
    recordMigration.run(77, 'Fix compliance_documents FK');
    console.log('Migration 77 complete.');
  }

  // Migration 78: Add sza_response column to compliance
  if (!isMigrationApplied.get(78)) {
    try { db.exec("ALTER TABLE compliance ADD COLUMN sza_response TEXT DEFAULT ''"); } catch(e) { /* exists */ }
    recordMigration.run(78, 'Add sza_response column to compliance');
    console.log('Migration 78 complete.');
  }

  // Migration 79: Add priority column to jobs
  if (!isMigrationApplied.get(79)) {
    try { db.exec("ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'"); } catch(e) { /* exists */ }
    recordMigration.run(79, 'Add priority column to jobs');
    console.log('Migration 79 complete.');
  }

  // Migration 80: Add compliance_id to tasks (links auto-generated tasks to compliance items)
  if (!isMigrationApplied.get(80)) {
    try { db.exec("ALTER TABLE tasks ADD COLUMN compliance_id INTEGER REFERENCES compliance(id) ON DELETE SET NULL"); } catch(e) { /* exists */ }
    try { db.exec("ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id)"); } catch(e) { /* exists */ }
    recordMigration.run(80, 'Add compliance_id to tasks for auto-linking');
    console.log('Migration 80 complete.');
  }

  // Migration 81: Add must_change_password flag + flag default admin
  if (!isMigrationApplied.get(81)) {
    try { db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0"); } catch(e) { /* exists */ }
    // Flag the default admin if they still have the seed password
    try {
      const admin = db.prepare("SELECT id, password_hash FROM users WHERE username = 'admin'").get();
      if (admin && bcrypt.compareSync('admin123', admin.password_hash)) {
        db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(admin.id);
        console.log('Migration 81: Default admin flagged for password change.');
      }
    } catch(e) { /* ok */ }
    // Also flag any seed users with 'password' as their password
    try {
      const seedUsers = db.prepare("SELECT id, password_hash FROM users WHERE username IN ('ops_user','planning_user','finance_user','accounts_user')").all();
      seedUsers.forEach(u => {
        if (bcrypt.compareSync('password', u.password_hash)) {
          db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(u.id);
        }
      });
    } catch(e) { /* ok */ }
    recordMigration.run(81, 'Add must_change_password flag for default credentials');
    console.log('Migration 81 complete.');
  }

  // Migration 82: Plans & approvals enhancements — TGS quantity, revision tracking, start/finish dates
  if (!isMigrationApplied.get(82)) {
    // New columns on compliance table
    const newCols82 = [
      ['tgs_quantity', 'INTEGER DEFAULT 1'],
      ['received_date', 'DATE'],
      ['revision_required', 'INTEGER DEFAULT 0'],
      ['revision_count', 'INTEGER DEFAULT 0'],
      ['start_date', 'DATE'],
      ['finish_date', 'DATE'],
    ];
    newCols82.forEach(([col, type]) => {
      try { db.prepare(`ALTER TABLE compliance ADD COLUMN ${col} ${type}`).run(); } catch(e) { /* already exists */ }
    });

    // New compliance_revisions table for revision log
    db.prepare(`CREATE TABLE IF NOT EXISTS compliance_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compliance_id INTEGER NOT NULL REFERENCES compliance(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL,
      revision_date DATE,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
    try { db.prepare('CREATE INDEX IF NOT EXISTS idx_compliance_revisions_compliance ON compliance_revisions(compliance_id)').run(); } catch(e) {}

    recordMigration.run(82, 'Plans enhancements: TGS quantity, revision tracking, start/finish dates');
    console.log('Migration 82 complete.');
  }

  // Migration 83: Import/update clients from Dashboard CSV export
  // Seed body lists 80+ T&S customer/supplier records (incl. Abergeldie,
  // T&S Traffic Control self-reference). Gated by SEED_T_AND_S_DATA so
  // fresh white-label deployments don't inherit T&S's client list.
  if (!isMigrationApplied.get(83)) {
    if (!SEED_T_AND_S_DATA) {
      console.log('Migration 83: skipped T&S client CSV import (set SEED_T_AND_S_DATA=true to enable)');
      recordMigration.run(83, 'Import/update clients from Dashboard CSV export (skipped, not a T&S deployment)');
    } else {
    const csvClients83 = [
      {extId:"74577",name:"2 Way Concrete",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"94296",name:"Abergeldie Complex Infrastructure",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73797",name:"Active Civil Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"94846",name:"Aesthetic Buildings and Facades",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73796",name:"AGM Constructions",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"93884",name:"Al-Faisal College",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"74461",name:"All Civil Works",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"27671",name:"Alpha Cranes & Rigging",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"74154",name:"AM2PM Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"36003",name:"ANR Engineering",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"75094",name:"Apex Sewer & Water",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"90622",name:"Atlantis",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"74215",name:"Atlas Plumbing",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73798",name:"Axial Construction",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"34044",name:"Blaq Projects",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73799",name:"Brushwood Engineering",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"77632",name:"Build Life",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"86602",name:"Builtwise Projects",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"35767",name:"BXD Projects",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"94092",name:"Carlton Projects",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"90484",name:"CIP Projects",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"75913",name:"City Line Marking",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"87649",name:"City Traffic",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"88399",name:"Civil Com Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"35733",name:"Civil Environmental Services",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73800",name:"Civil Environmental Services",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"32044",name:"Civil Ops",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"33209",name:"Combined",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"92421",name:"Compass Developments",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"33187",name:"Construx Solutions",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"83863",name:"Cubic Construction",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73801",name:"D&M Asphalt",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"89044",name:"Daracon Group",abn:"82 002 344 667",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"85666",name:"Delaney Civil",abn:"85 086 897 476",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73805",name:"Designline Building",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"91246",name:"Domain Constructions",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"74792",name:"Dynamic Lanemarking",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"78459",name:"E.M.O Civil",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"84307",name:"Earthbuilt",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"78546",name:"Fleek Constructions",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"88257",name:"Greenbrook",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"31906",name:"Ground King Civil",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"86054",name:"H Lap Projects",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"29781",name:"Hacer Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"33644",name:"HPAC",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73807",name:"I Connected",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73802",name:"Icon Build",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73803",name:"Impact Cranes",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"91325",name:"InTech Electrical",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"87594",name:"Issacon",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"78848",name:"Just Flow Trade Services",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"90807",name:"Kandaq Civil",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"78557",name:"Kaycorp",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"75669",name:"Kinetic Pools",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"84220",name:"Kwikflogroup",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"75279",name:"Labour Connect",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"94716",name:"M&S Electrical",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"82538",name:"Mabna",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"74665",name:"Masjid Omar",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"37821",name:"Masscon",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"89629",name:"Metway Developments",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"32264",name:"Mosque",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"75256",name:"Multi Home Builders",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"91091",name:"NIS Corporate",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"37893",name:"Pavement Management Services",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"32948",name:"Pro Arbor Services",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"91730",name:"Pro Workforce",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"27575",name:"Quality Management & Construction",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"80386",name:"Rose Testing",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"86916",name:"Sabeh Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"28681",name:"SafeRoadsRUs",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"86950",name:"Shad Family Super P/L",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73804",name:"SIFU Services",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"27733",name:"Silver Star Maintenance",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"83728",name:"Skyscraper Tower Cranes",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"30586",name:"Stateline Asphalt",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"75606",name:"Steller Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"75452",name:"Streamlined Property Services Pty Ltd",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"33506",name:"T&S Traffic Control",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"93813",name:"Tamaki Constructions",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"28030",name:"TQM",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"33005",name:"Traffic Australia Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"35774",name:"TRX Construction",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"77965",name:"UMA",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"27674",name:"Vari Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"86901",name:"Vigilant Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"37958",name:"Virtus Traffic",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"29362",name:"Wonderfield Property Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"90474",name:"Zenmark",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
      {extId:"73806",name:"Zett Group",abn:"",phone:"",email:"",billingAddr:"",billingAttn:"",billingSub:"",billingSt:"",billingPC:"",cancel:3,creditStop:0,notes:"",payTerms:"30 days"},
    ];

    let inserted83 = 0, updated83 = 0;

    const updateStmt83 = db.prepare(`
      UPDATE clients SET
        external_id = COALESCE(NULLIF(?, ''), external_id),
        abn = COALESCE(NULLIF(?, ''), abn),
        primary_contact_phone = COALESCE(NULLIF(?, ''), primary_contact_phone),
        primary_contact_email = COALESCE(NULLIF(?, ''), primary_contact_email),
        billing_address = COALESCE(NULLIF(?, ''), billing_address),
        billing_attention = COALESCE(NULLIF(?, ''), billing_attention),
        billing_suburb = COALESCE(NULLIF(?, ''), billing_suburb),
        billing_state = COALESCE(NULLIF(?, ''), billing_state),
        billing_postcode = COALESCE(NULLIF(?, ''), billing_postcode),
        cancellation_window_hrs = ?,
        credit_stop = ?,
        payment_terms = COALESCE(NULLIF(?, ''), payment_terms),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const insertStmt83 = db.prepare(`
      INSERT INTO clients (company_name, company_type, external_id, abn, primary_contact_phone, primary_contact_email,
        billing_address, billing_attention, billing_suburb, billing_state, billing_postcode,
        cancellation_window_hrs, credit_stop, notes, payment_terms, active)
      VALUES (?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const c of csvClients83) {
      // Match by company_name (first match wins for duplicates)
      const existing = db.prepare('SELECT id FROM clients WHERE company_name = ?').get(c.name);
      if (existing) {
        updateStmt83.run(
          c.extId, c.abn, c.phone, c.email,
          c.billingAddr, c.billingAttn, c.billingSub, c.billingSt, c.billingPC,
          c.cancel, c.creditStop, c.payTerms,
          existing.id
        );
        updated83++;
      } else {
        insertStmt83.run(
          c.name, c.extId, c.abn, c.phone, c.email,
          c.billingAddr, c.billingAttn, c.billingSub, c.billingSt, c.billingPC,
          c.cancel, c.creditStop, c.notes, c.payTerms
        );
        inserted83++;
      }
    }

    recordMigration.run(83, 'Import/update clients from Dashboard CSV export');
    console.log(`Migration 83 complete. Clients: ${inserted83} inserted, ${updated83} updated.`);
    } // end else (SEED_T_AND_S_DATA)
  }

  // Migration 84: Job system rearchitecture — auto-codes, plan revisions, plan flags, dual-view
  if (!isMigrationApplied.get(84)) {
    // 1. Job code sequence table for J-XXXX auto-generation
    // (Comment originally said TSJ-XXXX; codes were normalised to J- by
    // mig 106 and lib/jobNumbers.js. Comment updated for accuracy.)
    db.prepare(`CREATE TABLE IF NOT EXISTS job_code_sequence (
      id INTEGER PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0
    )`).run();
    // Seed with current max job count so we don't collide
    const maxJobCount = db.prepare('SELECT COUNT(*) as cnt FROM jobs').get().cnt;
    db.prepare('INSERT OR IGNORE INTO job_code_sequence (id, last_number) VALUES (1, ?)').run(maxJobCount);

    // 2. Plan revisions table for revision history
    db.prepare(`CREATE TABLE IF NOT EXISTS plan_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES traffic_plans(id) ON DELETE CASCADE,
      revision_label TEXT NOT NULL,
      file_url TEXT DEFAULT '',
      file_path TEXT DEFAULT '',
      file_original_name TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
    try { db.prepare('CREATE INDEX IF NOT EXISTS idx_plan_revisions_plan ON plan_revisions(plan_id)').run(); } catch(e) {}

    // 3. Plan flags table (operations → planning feedback)
    db.prepare(`CREATE TABLE IF NOT EXISTS plan_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES traffic_plans(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      flagged_by INTEGER NOT NULL REFERENCES users(id),
      description TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
      resolved_by INTEGER REFERENCES users(id),
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
    try { db.prepare('CREATE INDEX IF NOT EXISTS idx_plan_flags_plan ON plan_flags(plan_id)').run(); } catch(e) {}
    try { db.prepare('CREATE INDEX IF NOT EXISTS idx_plan_flags_job ON plan_flags(job_id)').run(); } catch(e) {}

    // 4. Add is_final and revision columns to traffic_plans
    const newPlanCols84 = [
      ['is_final', 'INTEGER DEFAULT 0'],
      ['marked_final_at', 'DATETIME'],
      ['marked_final_by', 'INTEGER REFERENCES users(id)'],
      ['current_revision_label', "TEXT DEFAULT 'Rev A'"],
    ];
    newPlanCols84.forEach(([col, type]) => {
      try { db.prepare(`ALTER TABLE traffic_plans ADD COLUMN ${col} ${type}`).run(); } catch(e) { /* already exists */ }
    });

    // 5. Add created_by_id to jobs table (tracks which planner started the job)
    try { db.prepare('ALTER TABLE jobs ADD COLUMN created_by_id INTEGER REFERENCES users(id)').run(); } catch(e) {}

    recordMigration.run(84, 'Job system rearchitecture: auto-codes, plan revisions, plan flags, dual-view');
    console.log('Migration 84 complete.');
  }

  // Migration 85: Add client_issued flag to compliance_revisions (for charging)
  if (!isMigrationApplied.get(85)) {
    try { db.prepare('ALTER TABLE compliance_revisions ADD COLUMN client_issued INTEGER DEFAULT 0').run(); } catch(e) { /* already exists */ }
    recordMigration.run(85, 'Add client_issued flag to compliance_revisions');
    console.log('Migration 85 complete.');
  }

  // Migration 86: Bulk-fix stale tasks linked to submitted/approved compliance items
  if (!isMigrationApplied.get(86)) {
    const fixed = db.prepare(`
      UPDATE tasks SET status = 'complete', completed_date = date('now'), updated_at = CURRENT_TIMESTAMP
      WHERE compliance_id IS NOT NULL
        AND status != 'complete'
        AND compliance_id IN (SELECT id FROM compliance WHERE status IN ('submitted', 'approved'))
    `).run();
    recordMigration.run(86, 'Bulk-fix stale tasks: auto-complete tasks linked to submitted/approved compliance');
    console.log(`Migration 86 complete. ${fixed.changes} stale tasks auto-completed.`);
  }

  // Migration 87: Sync ALL task statuses with their linked compliance items
  if (!isMigrationApplied.get(87)) {
    const fix1 = db.prepare(`
      UPDATE tasks SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP
      WHERE compliance_id IS NOT NULL AND status = 'not_started'
        AND compliance_id IN (SELECT id FROM compliance WHERE status = 'started')
    `).run();
    const fix2 = db.prepare(`
      UPDATE tasks SET status = 'complete', completed_date = date('now'), updated_at = CURRENT_TIMESTAMP
      WHERE compliance_id IS NOT NULL AND status != 'complete'
        AND compliance_id IN (SELECT id FROM compliance WHERE status IN ('submitted', 'approved'))
    `).run();
    recordMigration.run(87, 'Sync all task statuses with linked compliance items');
    console.log(`Migration 87 complete. ${fix1.changes} tasks → in_progress, ${fix2.changes} tasks → complete.`);
  }

  // Migration 88: Remove approved/rejected statuses — migrate existing items
  if (!isMigrationApplied.get(88)) {
    const m1 = db.prepare("UPDATE compliance SET status = 'submitted' WHERE status = 'approved'").run();
    const m2 = db.prepare("UPDATE compliance SET status = 'not_started' WHERE status = 'rejected'").run();
    recordMigration.run(88, 'Remove approved/rejected statuses: approved→submitted, rejected→not_started');
    console.log(`Migration 88 complete. ${m1.changes} approved→submitted, ${m2.changes} rejected→not_started.`);
  }

  // Migration 89: Expand booking statuses to match Traffio lifecycle
  // Add: client_booking, locked, conflict, finalised, late_cancellation
  // SQLite doesn't support ALTER CHECK, so we recreate the table
  if (!isMigrationApplied.get(89)) {
    console.log('Running migration 89: Expand booking statuses (Traffio lifecycle)');
    try {
      const ddlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get();
      if (ddlRow) {
        const cols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
        const colList = cols.join(', ');
        db.exec('ALTER TABLE bookings RENAME TO _bookings_backup_89');
        // Recreate with expanded status enum
        let newDDL = ddlRow.sql.replace('bookings', '_bookings_new_89');
        newDDL = newDDL.replace(
          /CHECK\s*\(\s*status\s+IN\s*\([^)]+\)\s*\)/i,
          "CHECK(status IN ('client_booking','unconfirmed','confirmed','locked','conflict','green_to_go','in_progress','complete','finalised','cancelled','late_cancellation','on_hold'))"
        );
        db.exec(newDDL);
        db.exec(`INSERT INTO _bookings_new_89 (${colList}) SELECT ${colList} FROM _bookings_backup_89`);
        db.exec('ALTER TABLE _bookings_new_89 RENAME TO bookings');
        db.exec('DROP TABLE _bookings_backup_89');
        // Migrate old status names
        db.prepare("UPDATE bookings SET status = 'complete' WHERE status = 'completed'").run();
        // Re-create indexes
        db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(start_datetime)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_depot ON bookings(depot)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_job ON bookings(job_id)");
      }
      recordMigration.run(89, 'Expand booking statuses: add client_booking, locked, conflict, finalised, late_cancellation; rename completed→complete');
      console.log('Migration 89 complete: Booking statuses expanded to Traffio lifecycle.');
    } catch (e) {
      console.error('Migration 89 error:', e.message);
    }
  }

  // Migration 90: Seed Villawood depot crew members from Traffio export
  // Inserts 54 named TCs (real names, phones, emails) into crew_members.
  // Gated by SEED_T_AND_S_DATA so new tenants get an empty roster.
  if (!isMigrationApplied.get(90)) {
    if (!SEED_T_AND_S_DATA) {
      console.log('Migration 90: skipped Villawood depot crew seed (set SEED_T_AND_S_DATA=true to enable)');
      recordMigration.run(90, 'Seed Villawood depot crew members from Traffio export (skipped, not a T&S deployment)');
    } else {
    try {
      db.exec(`
        INSERT OR IGNORE INTO crew_members (full_name, employee_id, role, phone, email, licence_type, active) VALUES
        ('Abdalaziz Rabeea', 'EMP-150863', 'traffic_controller', '0481568010', 'abdalazizrabeea24@gmail.com', '', 1),
        ('Abdelhadi Mustapha', 'EMP-136928', 'traffic_controller', '0422786488', 'abdelhadi.mustapha7999@gmail.com', '', 1),
        ('Adam Chami', 'EMP-120716', 'traffic_controller', '0414633050', 'adamchami2004@hotmail.com', '', 1),
        ('Ali Khanafer', 'EMP-125390', 'traffic_controller', '0413431349', 'alii747@icloud.com', '24931586', 1),
        ('Anhar Al-kamisie', 'EMP-160972', 'traffic_controller', '0420775393', 'anharalkamisie36@gmail.com', '', 1),
        ('Antony Kaldas', 'EMP-162463', 'traffic_controller', '0415305804', 'antonykaldas24@gmail.com', '', 1),
        ('Bailey Davis', 'EMP-160973', 'traffic_controller', '0434741774', 'baileydavis293@gmail.com', '', 1),
        ('Bassam Bashir', 'EMP-43600', 'traffic_controller', '0414791308', 'bassamkbashir99@hotmail.com', '', 1),
        ('Batoul Abou Samra', 'EMP-137256', 'traffic_controller', '0404908057', 'Batoul_Elbaba1997@hotmail.com', '', 1),
        ('Charbel Andonian', 'EMP-160926', 'traffic_controller', '0410586324', 'candonian@hotmail.com', '', 1),
        ('Dean Tinellis', 'EMP-154761', 'traffic_controller', '0450355483', 'dtinellis@gmail.com', '21530116', 1),
        ('Fahad Rahman', 'EMP-154891', 'traffic_controller', '0456789345', 'FAHAD.RAHMAN@LIVE.COM', '', 1),
        ('Fardeen Rahman', 'EMP-164224', 'traffic_controller', '0420239102', 'fardeen4094@gmail.com', '', 1),
        ('Faysal Rahman', 'EMP-154890', 'traffic_controller', '0456893723', 'FAYSAL@TSTC.COM.AU', '', 1),
        ('Francis Faupula', 'EMP-158826', 'traffic_controller', '0466246051', 'francisfaupula06@gmail.com', '', 1),
        ('Gabriela Santana', 'EMP-152966', 'traffic_controller', '0451111862', 'gabrielacsantana10@gmail.com', '25660098', 1),
        ('Hassan Albarak', 'EMP-155712', 'traffic_controller', '0413992809', 'hassanalbarak@icloud.com', '', 1),
        ('Helen Vesga', 'EMP-152999', 'traffic_controller', '0421779622', 'helen_tamayo@hotmail.com', '', 1),
        ('Husain Naji', 'EMP-152266', 'traffic_controller', '0435995617', 'husainnaji2007@gmail.com', '', 1),
        ('Irina Faupula', 'EMP-157941', 'traffic_controller', '0452481292', 'faupulamaumi22@gmail.com', '', 1),
        ('Jaleel Kakar', 'EMP-159506', 'traffic_controller', '0478698955', 'Jaleel.Kakar@hotmail.com', '', 1),
        ('Jaycee Cross', 'EMP-148984', 'traffic_controller', '0484740119', 'jaycee.cross05@gmail.com', '24407590', 1),
        ('Katty Diani', 'EMP-136456', 'traffic_controller', '0450087053', 'Kawtar.1989diani@gmail.com', '23675695', 1),
        ('Karanpreet Singh', 'EMP-162492', 'traffic_controller', '0435791514', 'karan98preet@icloud.com', '', 1),
        ('Keanu Rosso', 'EMP-160971', 'traffic_controller', '0411210765', 'keanu.rosso5@gmail.com', '', 1),
        ('Lake Armstrong', 'EMP-119469', 'traffic_controller', '0452622293', 'larmstrongpr@gmail.com', '', 1),
        ('Lucien Reynolds', 'EMP-121299', 'traffic_controller', '0410755283', 'lucienr2006@gmail.com', '24532453', 1),
        ('Madison Nichols', 'EMP-161151', 'traffic_controller', '0424532392', 'mady1327@icloud.com', '', 1),
        ('Mar Subirats', 'EMP-158508', 'traffic_controller', '0478931191', 'subiratsmar@gmail.com', '25396974', 1),
        ('Marcella Patti', 'EMP-164164', 'traffic_controller', '0466693455', 'Marcela.patti123@gmail.com', '', 1),
        ('Mohamad Merheb', 'EMP-162462', 'traffic_controller', '0421378796', 'mm.merhebb@gmail.com', '', 1),
        ('Mostafa El-Masry', 'EMP-162385', 'traffic_controller', '0478703602', 'mostafaog836@gmail.com', '', 1),
        ('Muntasir Ahmed', 'EMP-119475', 'traffic_controller', '0435023366', 'muntasir0405@gmail.com', '24544652', 1),
        ('Rabah Sabouh', 'EMP-119479', 'traffic_controller', '0432720817', 'rabsabouh98@icloud.com', '22022985', 1),
        ('Rafat Islam', 'EMP-151117', 'traffic_controller', '0450809000', 'rhythm8.au@gmail.com', '25166763', 1),
        ('Rania Bakri', 'EMP-119451', 'traffic_controller', '0451663265', 'Rania_bakri98@hotmail.com', '28224279', 1),
        ('Rohan Jamil', 'EMP-160884', 'traffic_controller', '0456560982', 'Rohanjamil@hotmail.com', '', 1),
        ('Rumman Khan', 'EMP-45438', 'traffic_controller', '0469071966', 'ronnyex1234@hotmail.com', '', 1),
        ('Ryan Hand', 'EMP-160209', 'traffic_controller', '0474783388', 'ryanhand05@gmail.com', '', 1),
        ('Saadat Ahmed', 'EMP-128575', 'traffic_controller', '0469295448', 'saadat@tstc.com.au', '21789783', 1),
        ('Sajid Rahman', 'EMP-39940', 'traffic_controller', '0422207176', 'sajidr2104@gmail.com', '', 1),
        ('Salif Hoque', 'EMP-121302', 'traffic_controller', '0405033348', 'hoquesalif@gmail.com', '24962179', 1),
        ('Samir Elkheir', 'EMP-162541', 'traffic_controller', '0414983988', 'Elkheirsamir96@gmail.com', '', 1),
        ('Savanah Armstrong', 'EMP-55896', 'traffic_controller', '0435913943', 'Savannah@tstc.com.au', '23108923', 1),
        ('Shahid Hussain', 'EMP-155502', 'traffic_controller', '0416353660', 'Shady187@y7mail.com', '', 1),
        ('Shanaq Hasan', 'EMP-128318', 'traffic_controller', '0411160825', 'hasanshanaq@gmail.com', '24164148', 0),
        ('Skye Smallfield', 'EMP-162328', 'traffic_controller', '0477642302', 'skyesmallfield1@gmail.com', '', 1),
        ('Suhail Ahmed', 'EMP-155771', 'traffic_controller', '0404865150', 'operations@tstc.com.au', '24680795', 0),
        ('Syed Ali', 'EMP-120485', 'traffic_controller', '0498162260', 'saalishanali@gmail.com', '24588767', 1),
        ('Taj Rahman', 'EMP-39938', 'traffic_controller', '0416221801', 'TAJ@tstc.com.au', '21959616', 1),
        ('Ummay Honey', 'EMP-156687', 'traffic_controller', '0404865150', 'ummayhayderhoney@outlook.com', '23495695', 1),
        ('Wendy Del Castillo', 'EMP-164161', 'traffic_controller', '0405914340', 'wendydelcas@hotmail.com', '', 1),
        ('Yusuf Rahman', 'EMP-154892', 'traffic_controller', '04123456789', 'yusufrahman284@gmail.com', '', 1),
        ('Zayn Pao', 'EMP-162464', 'traffic_controller', '0426539626', 'paozayn08@gmail.com', '', 1)
      `);
      const crewCount = db.prepare('SELECT COUNT(*) as c FROM crew_members').get().c;
      console.log('Migration 90: Villawood crew seeded. Total crew now: ' + crewCount);
      recordMigration.run(90, 'Seed Villawood depot crew members from Traffio export (54 active/reserve TCs)');
    } catch (e) {
      console.error('Migration 90 error:', e.message);
    }
    } // end else (SEED_T_AND_S_DATA)
  }

  // Migration 91: Seed Villawood crew into employees table (HR roster)
  // Same gating as mig 90 — T&S-specific employee roster.
  if (!isMigrationApplied.get(91)) {
    if (!SEED_T_AND_S_DATA) {
      console.log('Migration 91: skipped Villawood employees seed (set SEED_T_AND_S_DATA=true to enable)');
      recordMigration.run(91, 'Seed Villawood depot into employees table for HR roster (skipped, not a T&S deployment)');
    } else {
    try {
      const villawood = [
        ['Abdalaziz','Rabeea','','0481568010','abdalazizrabeea24@gmail.com','EMP-150863'],
        ['Abdelhadi','Mustapha','','0422786488','abdelhadi.mustapha7999@gmail.com','EMP-136928'],
        ['Adam','Chami','','0414633050','adamchami2004@hotmail.com','EMP-120716'],
        ['Ali','Khanafer','','0413431349','alii747@icloud.com','EMP-125390'],
        ['Anhar','Al-kamisie','','0420775393','anharalkamisie36@gmail.com','EMP-160972'],
        ['Antony','Kaldas','','0415305804','antonykaldas24@gmail.com','EMP-162463'],
        ['Bailey','Davis','','0434741774','baileydavis293@gmail.com','EMP-160973'],
        ['Bassam','Bashir','','0414791308','bassamkbashir99@hotmail.com','EMP-43600'],
        ['Batoul','Abou Samra','','0404908057','Batoul_Elbaba1997@hotmail.com','EMP-137256'],
        ['Charbel','Andonian','','0410586324','candonian@hotmail.com','EMP-160926'],
        ['Dean','Tinellis','','0450355483','dtinellis@gmail.com','EMP-154761'],
        ['Fahad','Rahman','','0456789345','FAHAD.RAHMAN@LIVE.COM','EMP-154891'],
        ['Fardeen','Rahman','','0420239102','fardeen4094@gmail.com','EMP-164224'],
        ['Faysal','Rahman','','0456893723','FAYSAL@TSTC.COM.AU','EMP-154890'],
        ['Francis','Faupula','','0466246051','francisfaupula06@gmail.com','EMP-158826'],
        ['Gabriela','Santana','','0451111862','gabrielacsantana10@gmail.com','EMP-152966'],
        ['Hassan','Albarak','','0413992809','hassanalbarak@icloud.com','EMP-155712'],
        ['Helen','Vesga','','0421779622','helen_tamayo@hotmail.com','EMP-152999'],
        ['Husain','Naji','','0435995617','husainnaji2007@gmail.com','EMP-152266'],
        ['Irina','Faupula','','0452481292','faupulamaumi22@gmail.com','EMP-157941'],
        ['Jaleel','Kakar','','0478698955','Jaleel.Kakar@hotmail.com','EMP-159506'],
        ['Jaycee','Cross','','0484740119','jaycee.cross05@gmail.com','EMP-148984'],
        ['Kaoutar','Diani','Katty','0450087053','Kawtar.1989diani@gmail.com','EMP-136456'],
        ['Karanpreet','Singh','','0435791514','karan98preet@icloud.com','EMP-162492'],
        ['Keanu','Rosso','','0411210765','keanu.rosso5@gmail.com','EMP-160971'],
        ['Lake','Armstrong','','0452622293','larmstrongpr@gmail.com','EMP-119469'],
        ['Lucien','Reynolds','','0410755283','lucienr2006@gmail.com','EMP-121299'],
        ['Madison','Nichols','','0424532392','mady1327@icloud.com','EMP-161151'],
        ['Mar','Subirats','','0478931191','subiratsmar@gmail.com','EMP-158508'],
        ['Marcella','Patti','','0466693455','Marcela.patti123@gmail.com','EMP-164164'],
        ['Mohamad','Merheb','','0421378796','mm.merhebb@gmail.com','EMP-162462'],
        ['Mostafa','El-Masry','','0478703602','mostafaog836@gmail.com','EMP-162385'],
        ['Muntasir','Ahmed','','0435023366','muntasir0405@gmail.com','EMP-119475'],
        ['Rabah','Sabouh','','0432720817','rabsabouh98@icloud.com','EMP-119479'],
        ['Rafat','Islam','','0450809000','rhythm8.au@gmail.com','EMP-151117'],
        ['Rania','Bakri','','0451663265','Rania_bakri98@hotmail.com','EMP-119451'],
        ['Rohan','Jamil','','0456560982','Rohanjamil@hotmail.com','EMP-160884'],
        ['Rumman','Khan','','0469071966','ronnyex1234@hotmail.com','EMP-45438'],
        ['Ryan','Hand','','0474783388','ryanhand05@gmail.com','EMP-160209'],
        ['Saadat','Ahmed','','0469295448','saadat@tstc.com.au','EMP-128575'],
        ['Sajid','Rahman','Captain Sajidur','0422207176','sajidr2104@gmail.com','EMP-39940'],
        ['Salif','Hoque','','0405033348','hoquesalif@gmail.com','EMP-121302'],
        ['Samir','Elkheir','','0414983988','Elkheirsamir96@gmail.com','EMP-162541'],
        ['Savanah','Armstrong','','0435913943','Savannah@tstc.com.au','EMP-55896'],
        ['Shahid','Hussain','','0416353660','Shady187@y7mail.com','EMP-155502'],
        ['Shanaq','Hasan','','0411160825','hasanshanaq@gmail.com','EMP-128318'],
        ['Skye','Smallfield','','0477642302','skyesmallfield1@gmail.com','EMP-162328'],
        ['Suhail','Ahmed','','0404865150','operations@tstc.com.au','EMP-155771'],
        ['Syed','Ali','','0498162260','saalishanali@gmail.com','EMP-120485'],
        ['Taj','Rahman','','0416221801','TAJ@tstc.com.au','EMP-39938'],
        ['Ummay','Honey','','0404865150','ummayhayderhoney@outlook.com','EMP-156687'],
        ['Wendy','Del Castillo','','0405914340','wendydelcas@hotmail.com','EMP-164161'],
        ['Yusuf','Rahman','','04123456789','yusufrahman284@gmail.com','EMP-154892'],
        ['Zayn','Pao','','0426539626','paozayn08@gmail.com','EMP-162464'],
      ];
      const insertEmp = db.prepare(`INSERT OR IGNORE INTO employees (employee_code, first_name, last_name, full_name, preferred_name, phone, email, role_title, employment_type, employment_status, company, active, payment_type, start_date, linked_crew_member_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'Traffic Controller', 'casual', 'active', 'T&S Traffic Control', 1, 'abn', DATE('now'), ?)`);
      for (const [first, last, pref, phone, email, empCode] of villawood) {
        const fullName = pref ? pref + ' ' + last : first + ' ' + last;
        const crewLink = db.prepare('SELECT id FROM crew_members WHERE employee_id = ?').get(empCode);
        insertEmp.run(empCode, first, last, fullName, pref, phone, email, crewLink ? crewLink.id : null);
      }
      const empCount = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'active'").get().c;
      console.log('Migration 91: Villawood employees seeded. Active employees: ' + empCount);
      recordMigration.run(91, 'Seed Villawood depot into employees table for HR roster');
    } catch (e) {
      console.error('Migration 91 error:', e.message);
    }
    } // end else (SEED_T_AND_S_DATA)
  }

  // =============================================
  // Migration 92: Booking form Phase 2 — new columns
  // =============================================
  if (!isMigrationApplied.get(92)) {
    console.log('Running migration 92: Booking form Phase 2 columns');
    const newBookingCols = [
      "ALTER TABLE bookings ADD COLUMN site_contacts TEXT DEFAULT '[]'",
      "ALTER TABLE bookings ADD COLUMN depot_meeting_time TEXT DEFAULT ''",
      "ALTER TABLE bookings ADD COLUMN straight_to_site_time TEXT DEFAULT ''",
      "ALTER TABLE bookings ADD COLUMN booking_tags TEXT DEFAULT '[]'",
      "ALTER TABLE bookings ADD COLUMN latitude REAL",
      "ALTER TABLE bookings ADD COLUMN longitude REAL",
      "ALTER TABLE bookings ADD COLUMN marker_is_accurate INTEGER DEFAULT 0",
      "ALTER TABLE bookings ADD COLUMN location_notes TEXT DEFAULT ''",
      "ALTER TABLE bookings ADD COLUMN worksite_location TEXT DEFAULT ''",
      "ALTER TABLE bookings ADD COLUMN works_direction TEXT DEFAULT ''",
      "ALTER TABLE bookings ADD COLUMN chainage_from TEXT DEFAULT ''",
      "ALTER TABLE bookings ADD COLUMN chainage_to TEXT DEFAULT ''",
      "ALTER TABLE bookings ADD COLUMN has_mobile_works INTEGER DEFAULT 0",
      "ALTER TABLE bookings ADD COLUMN booking_type TEXT DEFAULT 'regular'",
      "ALTER TABLE bookings ADD COLUMN is_booking_pool INTEGER DEFAULT 0",
      "ALTER TABLE bookings ADD COLUMN requester_id INTEGER",
      "ALTER TABLE bookings ADD COLUMN planner_id INTEGER",
      "ALTER TABLE bookings ADD COLUMN location_context TEXT DEFAULT ''",
    ];
    for (const sql of newBookingCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }
    recordMigration.run(92, 'Booking form Phase 2 — 18 new columns');
    console.log('Migration 92: 18 new booking columns added');
  }

  // Migration 93: Fix broken FK references (_bookings_backup_89 → bookings)
  if (!isMigrationApplied.get(93)) {
    console.log('Running migration 93: Fix FK references on booking child tables');
    db.pragma('foreign_keys = OFF');
    const childTables = ['booking_crew', 'booking_notes', 'booking_vehicles', 'booking_dockets', 'booking_documents', 'booking_requirements', 'booking_equipment'];
    for (const tbl of childTables) {
      try {
        const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
        if (!info || !info.sql.includes('_bookings_backup_89')) continue;
        const fixedSql = info.sql.replace(/_bookings_backup_89/g, 'bookings');
        db.exec(`ALTER TABLE ${tbl} RENAME TO _${tbl}_fix93`);
        db.exec(fixedSql);
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name).join(', ');
        db.exec(`INSERT INTO ${tbl} (${cols}) SELECT ${cols} FROM _${tbl}_fix93`);
        db.exec(`DROP TABLE _${tbl}_fix93`);
      } catch (e) { console.log('Migration 93: skip ' + tbl + ': ' + e.message); }
    }
    db.pragma('foreign_keys = ON');
    recordMigration.run(93, 'Fix broken FK references on booking child tables');
    console.log('Migration 93: FK references fixed');
  }

  // Migration 94: Add deleted_at column for soft-delete
  if (!isMigrationApplied.get(94)) {
    try { db.exec("ALTER TABLE bookings ADD COLUMN deleted_at DATETIME"); } catch (e) { /* column may exist */ }
    recordMigration.run(94, 'bookings_soft_delete');
    console.log('Migration 94 applied: bookings soft delete column');
  }

  // Migration 95: Quiz scoring columns on induction_presentations
  if (!isMigrationApplied.get(95)) {
    try { db.exec("ALTER TABLE induction_presentations ADD COLUMN quiz_score INTEGER DEFAULT NULL"); } catch (e) { /* column may exist */ }
    try { db.exec("ALTER TABLE induction_presentations ADD COLUMN quiz_passed INTEGER DEFAULT NULL"); } catch (e) { /* column may exist */ }
    try { db.exec("ALTER TABLE induction_presentations ADD COLUMN quiz_answers TEXT DEFAULT NULL"); } catch (e) { /* column may exist */ }
    recordMigration.run(95, 'Quiz scoring columns on induction_presentations');
    console.log('Migration 95 applied: quiz scoring columns');
  }

  // Migration 96: Backfill site diary entries for existing tasks linked to a project
  if (!isMigrationApplied.get(96)) {
    console.log('Running migration 96: Backfill site diary entries for project-linked tasks');
    try {
      const tasksWithJobs = db.prepare(`
        SELECT t.id, t.title, t.job_id, t.due_date, t.created_at, t.created_by,
               u.full_name as creator_name
        FROM tasks t
        LEFT JOIN users u ON t.created_by = u.id
        WHERE t.job_id IS NOT NULL
      `).all();

      const insertDiary = db.prepare(`
        INSERT INTO site_diary_entries (job_id, entry_date, task, outcomes, created_by_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const hasEntry = db.prepare(`
        SELECT 1 FROM site_diary_entries
        WHERE job_id = ? AND outcomes LIKE ? LIMIT 1
      `);

      let added = 0;
      for (const t of tasksWithJobs) {
        const summary = `[${t.creator_name || 'System'}] Task linked to project: "${t.title}"${t.due_date ? ' (due ' + t.due_date + ')' : ''}.`;
        // Skip if an entry with same outcome already exists for this job
        const exists = hasEntry.get(t.job_id, '%Task linked to project: "' + t.title + '"%');
        if (exists) continue;
        const entryDate = (t.created_at || new Date().toISOString()).split('T')[0].split(' ')[0];
        try {
          insertDiary.run(t.job_id, entryDate, 'Plans & Approvals Update', summary, t.created_by || null, t.created_at || new Date().toISOString());
          added++;
        } catch (e) { /* skip failures */ }
      }
      recordMigration.run(96, `Backfilled ${added} site diary entries for project-linked tasks`);
      console.log(`Migration 96 applied: ${added} diary entries backfilled`);
    } catch (e) {
      console.error('Migration 96 error:', e.message);
      recordMigration.run(96, 'Backfill skipped: ' + e.message);
    }
  }

  // Migration 97: Retry backfill of site diary entries for project-linked tasks
  // (Migration 96 silently produced 0 rows on production — this version logs each insert and surfaces errors.)
  if (!isMigrationApplied.get(97)) {
    console.log('Running migration 97: Retry diary backfill for project-linked tasks (verbose)');
    try {
      const tasksWithJobs = db.prepare(`
        SELECT t.id, t.title, t.job_id, t.due_date, t.created_at, t.created_by,
               u.full_name as creator_name
        FROM tasks t
        LEFT JOIN users u ON t.created_by = u.id
        WHERE t.job_id IS NOT NULL
      `).all();
      console.log(`Migration 97: found ${tasksWithJobs.length} tasks linked to projects`);

      const insertDiary = db.prepare(`
        INSERT INTO site_diary_entries (job_id, entry_date, task, outcomes, created_by_id)
        VALUES (?, ?, ?, ?, ?)
      `);
      const hasEntryForTask = db.prepare(`
        SELECT id FROM site_diary_entries
        WHERE job_id = ? AND outcomes LIKE ?
        LIMIT 1
      `);

      let added = 0, skipped = 0, failed = 0;
      for (const t of tasksWithJobs) {
        const needle = `%Task linked to project: "${t.title.replace(/"/g, '""')}"%`;
        const exists = hasEntryForTask.get(t.job_id, needle);
        if (exists) { skipped++; continue; }

        const summary = `[${t.creator_name || 'System'}] Task linked to project: "${t.title}"${t.due_date ? ' (due ' + t.due_date + ')' : ''}.`;
        const raw = t.created_at || new Date().toISOString();
        const entryDate = String(raw).split('T')[0].split(' ')[0];

        // Verify created_by actually exists; otherwise use NULL to avoid FK failure
        let createdById = null;
        if (t.created_by) {
          const userRow = db.prepare('SELECT id FROM users WHERE id = ?').get(t.created_by);
          createdById = userRow ? t.created_by : null;
        }

        try {
          insertDiary.run(t.job_id, entryDate, 'Plans & Approvals Update', summary, createdById);
          added++;
        } catch (e) {
          failed++;
          console.error(`Migration 97: insert failed for task ${t.id} (job ${t.job_id}):`, e.message);
        }
      }
      recordMigration.run(97, `Backfill retry: ${added} added, ${skipped} skipped, ${failed} failed`);
      console.log(`Migration 97 applied: ${added} added, ${skipped} skipped, ${failed} failed`);
    } catch (e) {
      console.error('Migration 97 fatal error:', e.message, e.stack);
      recordMigration.run(97, 'Backfill retry failed: ' + e.message);
    }
  }

  // Migration 99: Site audits (Traffic Control Site Safety Audit — FORM-663)
  if (!isMigrationApplied.get(99)) {
    console.log('Running migration 99: Site audits module');
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        project_site TEXT DEFAULT '',
        client TEXT DEFAULT '',
        location TEXT DEFAULT '',
        audit_datetime TEXT DEFAULT '',
        auditor_id INTEGER REFERENCES users(id),
        auditor_name TEXT DEFAULT '',
        supervisor_name TEXT DEFAULT '',
        tgs_ref TEXT DEFAULT '',
        shift TEXT DEFAULT 'day',
        weather TEXT DEFAULT '',
        overall_result TEXT DEFAULT '',
        overall_finding TEXT DEFAULT '',
        responses_json TEXT DEFAULT '{}',
        nonconformances_json TEXT DEFAULT '[]',
        score_total INTEGER DEFAULT 0,
        score_max INTEGER DEFAULT 0,
        score_percent REAL DEFAULT 0,
        status TEXT DEFAULT 'draft',
        signed_off_by_id INTEGER REFERENCES users(id),
        signed_off_at DATETIME,
        follow_up_required INTEGER DEFAULT 0,
        follow_up_date DATE,
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_site_audits_job ON site_audits(job_id);
      CREATE INDEX IF NOT EXISTS idx_site_audits_status ON site_audits(status);
      CREATE INDEX IF NOT EXISTS idx_site_audits_created_by ON site_audits(created_by_id);
    `);
    recordMigration.run(99, 'Site audits table (FORM-663)');
    console.log('Migration 99 applied: site_audits table created');
  }

  // Migration 100: Site audit attachments (images + documents per audit)
  if (!isMigrationApplied.get(100)) {
    console.log('Running migration 100: Site audit attachments');
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id INTEGER NOT NULL REFERENCES site_audits(id) ON DELETE CASCADE,
        context_key TEXT DEFAULT 'general',  -- 'general' or section item key (e.g. '4.5') or 'nc_1'
        caption TEXT DEFAULT '',
        filename TEXT NOT NULL,              -- stored filename on disk
        original_name TEXT NOT NULL,         -- user-visible name
        file_path TEXT NOT NULL,             -- served path e.g. /data/uploads/audits/5/xxx.jpg
        file_size INTEGER DEFAULT 0,
        mime_type TEXT DEFAULT '',
        uploaded_by_id INTEGER REFERENCES users(id),
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audit_attachments_audit ON audit_attachments(audit_id);
      CREATE INDEX IF NOT EXISTS idx_audit_attachments_context ON audit_attachments(audit_id, context_key);
    `);
    recordMigration.run(100, 'Site audit attachments table');
    console.log('Migration 100 applied: audit_attachments table created');
  }

  // Migration 101: Signature columns for site_audits (auditor + supervisor typed signatures)
  if (!isMigrationApplied.get(101)) {
    console.log('Running migration 101: Audit signature columns');
    try {
      const cols = db.prepare("PRAGMA table_info(site_audits)").all().map(c => c.name);
      if (!cols.includes('auditor_signature_text')) {
        db.exec(`ALTER TABLE site_audits ADD COLUMN auditor_signature_text TEXT DEFAULT ''`);
      }
      if (!cols.includes('auditor_signed_at')) {
        db.exec(`ALTER TABLE site_audits ADD COLUMN auditor_signed_at DATETIME`);
      }
      if (!cols.includes('supervisor_signature_text')) {
        db.exec(`ALTER TABLE site_audits ADD COLUMN supervisor_signature_text TEXT DEFAULT ''`);
      }
      if (!cols.includes('supervisor_signed_at')) {
        db.exec(`ALTER TABLE site_audits ADD COLUMN supervisor_signed_at DATETIME`);
      }
      recordMigration.run(101, 'Added signature text columns to site_audits');
      console.log('Migration 101 applied: signature columns added');
    } catch (e) {
      console.error('Migration 101 error:', e.message);
    }
  }

  // Migration 102: Add deleted_at column for soft-delete on employees
  if (!isMigrationApplied.get(102)) {
    try { db.exec("ALTER TABLE employees ADD COLUMN deleted_at DATETIME"); } catch (e) { /* column may exist */ }
    recordMigration.run(102, 'employees_soft_delete');
    console.log('Migration 102 applied: employees soft delete column');
  }

  // Migration 103: Training completions table
  if (!isMigrationApplied.get(103)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS training_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER REFERENCES employees(id),
        module TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { db.exec("CREATE INDEX idx_tc_employee ON training_completions(employee_id)"); } catch (e) {}
    try { db.exec("CREATE INDEX idx_tc_email ON training_completions(email)"); } catch (e) {}
    recordMigration.run(103, 'training_completions table');
    console.log('Migration 103 applied: training_completions table');
  }

  // Migration 104: Hire equipment columns + hire checklists table
  if (!isMigrationApplied.get(104)) {
    try { db.exec("ALTER TABLE equipment ADD COLUMN ownership_type TEXT DEFAULT 'owned'"); } catch (e) {}
    try { db.exec("ALTER TABLE equipment ADD COLUMN hire_supplier TEXT DEFAULT ''"); } catch (e) {}
    try { db.exec("ALTER TABLE equipment ADD COLUMN hire_daily_rate REAL DEFAULT 0"); } catch (e) {}
    try { db.exec("ALTER TABLE equipment ADD COLUMN hire_start_date DATE"); } catch (e) {}
    try { db.exec("ALTER TABLE equipment ADD COLUMN hire_end_date DATE"); } catch (e) {}
    try { db.exec("ALTER TABLE equipment ADD COLUMN hire_reference TEXT DEFAULT ''"); } catch (e) {}

    db.exec(`
      CREATE TABLE IF NOT EXISTS equipment_hire_checklists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id INTEGER NOT NULL REFERENCES equipment(id),
        checklist_type TEXT NOT NULL DEFAULT 'pickup',
        checked_by TEXT NOT NULL,
        checked_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        general_condition TEXT DEFAULT 'good',
        body_exterior TEXT DEFAULT 'pass',
        lights_indicators TEXT DEFAULT 'pass',
        safety_features TEXT DEFAULT 'pass',
        tyres_wheels TEXT DEFAULT 'pass',
        fluid_levels TEXT DEFAULT 'pass',
        beacons_signals TEXT DEFAULT 'pass',
        cleanliness TEXT DEFAULT 'pass',
        defects_noted TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        odometer_reading TEXT DEFAULT '',
        fuel_level TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { db.exec("CREATE INDEX idx_ehc_equipment ON equipment_hire_checklists(equipment_id)"); } catch (e) {}
    recordMigration.run(104, 'Hire equipment columns + hire checklists table');
    console.log('Migration 104 applied: hire equipment + checklists');
  }

  // Migration 105: Checklist templates + items
  if (!isMigrationApplied.get(105)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS checklist_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        sort_order INTEGER DEFAULT 0,
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS checklist_template_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
        item_order INTEGER DEFAULT 0,
        section TEXT DEFAULT '',
        question TEXT NOT NULL,
        response_type TEXT NOT NULL DEFAULT 'yes_no_na',
        required INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { db.exec("CREATE INDEX idx_cti_template ON checklist_template_items(template_id)"); } catch (e) {}
    recordMigration.run(105, 'Checklist templates + template items tables');
    console.log('Migration 105 applied: checklist templates');
  }

  // Migration 106: Normalise all job numbers to J-XXXX format + reseed sequence
  if (!isMigrationApplied.get(106)) {
    // Two-pass rename to avoid UNIQUE collisions:
    // Pass 1: rename all to temporary names (_TMP_1, _TMP_2, ...)
    // Pass 2: rename from temp to final J-XXXX
    const allJobs106 = db.prepare('SELECT id, job_number FROM jobs ORDER BY id ASC').all();
    const updateJN = db.prepare('UPDATE jobs SET job_number = ? WHERE id = ?');
    const updateJNAndName = db.prepare('UPDATE jobs SET job_number = ?, job_name = REPLACE(job_name, ?, ?) WHERE id = ?');

    // Pass 1: temporary names
    let idx106 = 0;
    for (const job of allJobs106) {
      idx106++;
      updateJN.run('_TMP_' + idx106, job.id);
    }

    // Pass 2: final sequential J-XXXX names
    idx106 = 0;
    for (const job of allJobs106) {
      idx106++;
      const newNum = 'J-' + String(idx106).padStart(4, '0');
      updateJNAndName.run(newNum, job.job_number, newNum, job.id);
      if (job.job_number !== newNum) {
        console.log('  Renumbered: ' + job.job_number + ' -> ' + newNum);
      }
    }

    // Reseed the sequence so next auto-gen continues from the highest number
    db.prepare('UPDATE job_code_sequence SET last_number = ? WHERE id = 1').run(idx106);

    recordMigration.run(106, 'Normalise all job numbers to J-XXXX + reseed sequence');
    console.log('Migration 106 applied: renumbered ' + allJobs106.length + ' jobs to J-XXXX format, sequence at ' + idx106);
  }

  // =============================================
  // Migration 107: Fix old diary categories — reclassify task entries
  // =============================================
  if (!isMigrationApplied.get(107)) {
    console.log('Running migration 107: Fix old diary entry categories');

    // Reclassify entries that say "Plans & Approvals Update" but are clearly task-related
    // Pattern: outcomes starts with "Task:" (from logStatusChange) or contains "Task linked" / "Task created" / "Task updated" / "Task deleted"
    const taskStatusEntries = db.prepare(`
      UPDATE site_diary_entries SET task = 'Task Status Change'
      WHERE task = 'Plans & Approvals Update'
        AND (outcomes LIKE 'Task:%' OR outcomes LIKE '%Task:%→%')
    `).run();

    const taskLinkedEntries = db.prepare(`
      UPDATE site_diary_entries SET task = 'Task Created'
      WHERE task = 'Plans & Approvals Update'
        AND (outcomes LIKE '%Task linked to project%' OR outcomes LIKE '%New task created%')
    `).run();

    const taskUpdatedEntries = db.prepare(`
      UPDATE site_diary_entries SET task = 'Task Updated'
      WHERE task = 'Plans & Approvals Update'
        AND outcomes LIKE '%Task updated:%'
    `).run();

    const taskDeletedEntries = db.prepare(`
      UPDATE site_diary_entries SET task = 'Task Deleted'
      WHERE task = 'Plans & Approvals Update'
        AND outcomes LIKE '%Task deleted:%'
    `).run();

    const total = taskStatusEntries.changes + taskLinkedEntries.changes + taskUpdatedEntries.changes + taskDeletedEntries.changes;
    recordMigration.run(107, 'Fix old diary categories for task entries');
    console.log('Migration 107 applied: reclassified ' + total + ' diary entries');
  }

  // =============================================
  // Migration 108: task_owners junction table for multi-owner tasks
  // =============================================
  if (!isMigrationApplied.get(108)) {
    console.log('Running migration 108: Create task_owners junction table');

    db.exec(`
      CREATE TABLE IF NOT EXISTS task_owners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(task_id, user_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_owners_task ON task_owners(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_owners_user ON task_owners(user_id)');

    // Migrate existing owner_id data into task_owners
    const tasksWithOwner = db.prepare('SELECT id, owner_id FROM tasks WHERE owner_id IS NOT NULL').all();
    const insertOwner = db.prepare('INSERT OR IGNORE INTO task_owners (task_id, user_id) VALUES (?, ?)');
    let migratedCount = 0;
    for (const t of tasksWithOwner) {
      insertOwner.run(t.id, t.owner_id);
      migratedCount++;
    }

    recordMigration.run(108, 'Create task_owners junction table');
    console.log('Migration 108 applied: task_owners table created, migrated ' + migratedCount + ' existing assignments');
  }

  // ─── Migration 109: Generate initial weekly summaries for all jobs with diary entries ───
  if (!isMigrationApplied.get(109)) {
    try {
      // Get all active jobs that have ANY diary entries up to 12/04/2026
      const jobsWithDiary = db.prepare(`
        SELECT j.id, j.job_number, j.client, j.project_name,
          COUNT(sd.id) as entry_count,
          GROUP_CONCAT(DISTINCT sd.task) as categories,
          SUM(CASE WHEN sd.issues IS NOT NULL AND sd.issues != '' THEN 1 ELSE 0 END) as issue_count
        FROM jobs j
        JOIN site_diary_entries sd ON sd.job_id = j.id
        WHERE j.status IN ('active','on_hold','won','prestart')
        AND sd.entry_date <= '2026-04-12'
        GROUP BY j.id
        ORDER BY j.job_number
      `).all();

      if (jobsWithDiary.length > 0) {
        // Build summary message
        const totalEntries = jobsWithDiary.reduce((sum, j) => sum + j.entry_count, 0);
        const jobsWithIssues = jobsWithDiary.filter(j => j.issue_count > 0);

        const title = `Weekly Summary: ${jobsWithDiary.length} job${jobsWithDiary.length !== 1 ? 's' : ''} — All diary entries to date`;
        let message = `${totalEntries} diary entries across ${jobsWithDiary.length} jobs.`;
        if (jobsWithIssues.length > 0) {
          message += ` Issues flagged on: ${jobsWithIssues.map(j => j.job_number).join(', ')}.`;
        }
        message += '\n\n';
        message += jobsWithDiary.map(j => {
          let line = `${j.job_number} — ${j.project_name || j.client}`;
          line += ` | ${j.entry_count} diary entr${j.entry_count === 1 ? 'y' : 'ies'}`;
          if (j.categories) {
            const cats = j.categories.split(',').filter(Boolean).slice(0, 5);
            if (cats.length > 0) line += ` | Categories: ${cats.join(', ')}`;
          }
          if (j.issue_count > 0) line += ` | ⚠ ${j.issue_count} issue${j.issue_count !== 1 ? 's' : ''}`;
          return line;
        }).join('\n');

        // Notify Taj and Saadat
        const notifyUsers = db.prepare("SELECT id FROM users WHERE username IN ('taj', 'saadat') AND active = 1").all();
        const insertNotif = db.prepare(`
          INSERT INTO notifications (user_id, type, title, message, link, job_id)
          VALUES (?, 'weekly_summary', ?, ?, '/dashboard', NULL)
        `);
        for (const u of notifyUsers) {
          try { insertNotif.run(u.id, title, message); } catch(e) {}
        }
        console.log(`Migration 109: Generated initial summary for ${jobsWithDiary.length} jobs, notified ${notifyUsers.length} users`);
      }

      // Also update last_update_date on all jobs that have diary entries
      db.prepare(`
        UPDATE jobs SET last_update_date = (
          SELECT MAX(entry_date) FROM site_diary_entries WHERE job_id = jobs.id
        )
        WHERE id IN (SELECT DISTINCT job_id FROM site_diary_entries)
      `).run();

    } catch(e) { console.error('Migration 109 error:', e.message); }
    recordMigration.run(109, 'Generate initial weekly summaries + backfill last_update_date from diary');
    console.log('Migration 109 applied.');
  }

  // ─── Migration 110: Expand notifications type CHECK to include chat_message + weekly_summary ───
  if (!isMigrationApplied.get(110)) {
    let needsExpand = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'chat_message'")) needsExpand = false;
    } catch(e) {}

    if (needsExpand) {
      db.exec('BEGIN TRANSACTION');
      try {
        // Check if email_sent_at column exists
        const cols = db.prepare("PRAGMA table_info('notifications')").all();
        const hasEmailSent = cols.some(c => c.name === 'email_sent_at');

        const emailSentCol = hasEmailSent ? 'email_sent_at DATETIME,' : '';
        const emailSentSelect = hasEmailSent ? ',email_sent_at' : '';

        db.exec(`
          CREATE TABLE notifications_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','rol_pending','ticket_expiry','equipment_inspection_due','induction_overdue','over_budget','deadline_reminder','chat_message','weekly_summary','general')),
            title TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            link TEXT DEFAULT '',
            job_id INTEGER REFERENCES jobs(id),
            is_read INTEGER NOT NULL DEFAULT 0,
            ${emailSentCol}
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO notifications_new (id, user_id, type, title, message, link, job_id, is_read${emailSentSelect}, created_at)
            SELECT id, user_id, type, title, message, link, job_id, is_read${emailSentSelect}, created_at FROM notifications;
          DROP TABLE notifications;
          ALTER TABLE notifications_new RENAME TO notifications;
          CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
          CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
          CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
        `);
        db.exec('COMMIT');
        console.log('Migration 110: Expanded notifications type CHECK for chat_message + weekly_summary');
      } catch(e) {
        try { db.exec('ROLLBACK'); } catch(r) {}
        console.error('Migration 110 error:', e.message);
      }
    }
    recordMigration.run(110, 'Expand notifications type CHECK for chat_message + weekly_summary');
  }

  // Migration 111: Add missing rate_* columns to employees (fixes Update Employee crash)
  // + pin_plain to crew_members (admins can read back the portal PIN)
  if (!isMigrationApplied.get(111)) {
    const rateCols = ['rate_day','rate_ot','rate_dt','rate_night','rate_night_ot','rate_night_dt','rate_travel','rate_meal','rate_weekend'];
    rateCols.forEach(col => {
      try { db.exec(`ALTER TABLE employees ADD COLUMN ${col} REAL DEFAULT 0`); } catch (e) { /* column may exist */ }
    });
    try { db.exec("ALTER TABLE crew_members ADD COLUMN pin_plain TEXT DEFAULT NULL"); } catch (e) { /* column may exist */ }
    recordMigration.run(111, 'Employee rate columns + crew_members.pin_plain');
    console.log('Migration 111 applied: rate columns + pin_plain');
  }

  // Migration 112: Add booking_id to crew_allocations to bridge bookings → worker portal
  if (!isMigrationApplied.get(112)) {
    try { db.exec("ALTER TABLE crew_allocations ADD COLUMN booking_id INTEGER REFERENCES bookings(id)"); } catch (e) { /* column may exist */ }
    try { db.exec("CREATE INDEX idx_crew_alloc_booking ON crew_allocations(booking_id)"); } catch (e) {}
    recordMigration.run(112, 'Add booking_id to crew_allocations');
    console.log('Migration 112 applied: booking_id on crew_allocations');
  }

  // Migration 113: Make crew_allocations.job_id nullable (bookings may not have a job linked)
  if (!isMigrationApplied.get(113)) {
    // SQLite can't ALTER COLUMN, but we can work around by allowing NULL via new inserts
    // The NOT NULL constraint in the original CREATE TABLE prevents NULLs, but we can
    // recreate the table. Simpler approach: just catch errors on insert when job_id is null.
    // Actually, let's just update the code to always provide a job_id.
    // For bookings without a job, we'll use the booking details directly.
    recordMigration.run(113, 'Placeholder: handle bookings without job_id');
    console.log('Migration 113 applied');
  }

  // Migration 115: Add 'hr' to tasks.division CHECK constraint
  if (!isMigrationApplied.get(115)) {
    console.log('Running migration 115: Add hr to tasks.division CHECK');
    const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const currentSQL = tableSQL ? tableSQL.sql : '';
    if (!currentSQL.includes("'hr'")) {
      const existingCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      const targetCols = ['id','job_id','division','title','description','owner_id','due_date','status','priority','escalation_level','task_type','notes','completed_date','created_at','updated_at','created_by','compliance_id'];
      const commonCols = targetCols.filter(c => existingCols.includes(c));
      const colList = commonCols.join(', ');
      try {
        db.exec('BEGIN TRANSACTION');
        db.exec(`
          CREATE TABLE tasks_rebuild_115 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
            division TEXT NOT NULL DEFAULT 'ops' CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management','hr')),
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER REFERENCES users(id),
            due_date DATE,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
            escalation_level INTEGER NOT NULL DEFAULT 0,
            task_type TEXT DEFAULT 'one_off',
            notes TEXT DEFAULT '',
            completed_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER REFERENCES users(id),
            compliance_id INTEGER REFERENCES compliance(id) ON DELETE SET NULL
          )
        `);
        db.exec(`INSERT INTO tasks_rebuild_115 (${colList}) SELECT ${colList} FROM tasks`);
        db.exec('DROP TABLE tasks');
        db.exec('ALTER TABLE tasks_rebuild_115 RENAME TO tasks');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)');
        db.exec('COMMIT');
        console.log('Migration 115: tasks table rebuilt with hr division.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) {}
        console.error('Migration 115 FAILED:', e.message);
        throw new Error('Migration 115 failed: ' + e.message);
      }
    } else {
      console.log('Migration 115: hr already in CHECK, skipping.');
    }
    recordMigration.run(115, 'Add hr to tasks.division CHECK constraint');
    console.log('Migration 115 complete.');
  }

  // Migration 114: Seed test dummy worker account for Worker Portal Preview
  // Creates EMP-TEST / PIN 1234 traffic_controller for dev/staging demos.
  // Gated by SEED_TEST_USERS so production deployments (incl. white-label)
  // don't ship with a live test account in the crew roster. T&S production
  // already has this migration recorded — gate has no effect there.
  if (!isMigrationApplied.get(114)) {
    if (!SEED_TEST_USERS) {
      console.log('Migration 114: skipped EMP-TEST dummy worker (set SEED_TEST_USERS=true for dev/staging)');
      recordMigration.run(114, 'Seed test dummy worker (skipped, set SEED_TEST_USERS=true to enable)');
    } else {
    try {
      const pinHash = bcrypt.hashSync('1234', 12);
      const existing = db.prepare("SELECT id FROM crew_members WHERE employee_id = 'EMP-TEST'").get();
      let crewId;
      if (existing) {
        db.prepare("UPDATE crew_members SET pin_hash = ?, active = 1 WHERE id = ?").run(pinHash, existing.id);
        crewId = existing.id;
      } else {
        const result = db.prepare(`
          INSERT INTO crew_members (full_name, employee_id, role, phone, email, active, pin_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('Test Dummy', 'EMP-TEST', 'traffic_controller', '0400000000', 'test@tstc.com.au', 1, pinHash);
        crewId = result.lastInsertRowid;
      }
      // Matching employees row so it appears in the Roster
      const empExists = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-TEST'").get();
      if (!empExists) {
        db.prepare(`
          INSERT INTO employees (employee_code, first_name, last_name, full_name, role_title, employment_type, employment_status, email, phone, active, linked_crew_member_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('EMP-TEST', 'Test', 'Dummy', 'Test Dummy', 'Traffic Controller', 'casual', 'active', 'test@tstc.com.au', '0400000000', 1, crewId);
      } else {
        db.prepare("UPDATE employees SET linked_crew_member_id = ?, employment_status = 'active', active = 1 WHERE id = ?").run(crewId, empExists.id);
      }
    } catch (e) { console.log('Migration 114 error (non-fatal):', e.message); }
    recordMigration.run(114, 'Seed test dummy worker (EMP-TEST / PIN 1234) for portal preview');
    console.log('Migration 114 applied: test dummy worker seeded');
    } // end else (SEED_TEST_USERS)
  }

  // Migration 116: Add shift_period to employee_leave for day/night/full_day split
  if (!isMigrationApplied.get(116)) {
    try { db.exec("ALTER TABLE employee_leave ADD COLUMN shift_period TEXT DEFAULT 'full_day'"); } catch (e) { /* column may exist */ }
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_employee_leave_dates ON employee_leave(crew_member_id, start_date, end_date)"); } catch (e) { /* may exist */ }
    recordMigration.run(116, 'Add shift_period to employee_leave (day/night/full_day)');
    console.log('Migration 116 applied: shift_period on employee_leave');
  }

  // Migration 137: Payslips
  // (Originally shipped as 126, but 126 was already recorded on prod by the
  //  earlier hire_dockets migration — so this never ran there and the table
  //  was missing. Renumbered to 137 so it actually creates the table.)
  if (!isMigrationApplied.get(137)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payslips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        pay_date DATE NOT NULL,
        gross_pay REAL DEFAULT 0,
        tax_withheld REAL DEFAULT 0,
        super_amount REAL DEFAULT 0,
        net_pay REAL DEFAULT 0,
        ytd_gross REAL DEFAULT 0,
        ytd_tax REAL DEFAULT 0,
        ytd_super REAL DEFAULT 0,
        ytd_net REAL DEFAULT 0,
        notes TEXT DEFAULT '',
        pdf_filename TEXT,
        pdf_original_name TEXT,
        pdf_size INTEGER DEFAULT 0,
        uploaded_by_id INTEGER REFERENCES users(id),
        uploaded_at DATETIME DEFAULT (datetime('now')),
        viewed_at DATETIME,
        view_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(employee_id, period_start, period_end)
      );
      CREATE INDEX IF NOT EXISTS idx_payslips_employee ON payslips(employee_id, pay_date DESC);
      CREATE INDEX IF NOT EXISTS idx_payslips_paydate ON payslips(pay_date DESC);
    `);
    recordMigration.run(137, 'Payslips table');
    console.log('Migration 137 applied: payslips table');
  }

  // Migration 125: Second-pass merge using first-name prefix match.
  // Migration 124 only caught exact full_name matches — but users.full_name on prod is
  // stored as just the first name ("Taj", "Saadat", "Savanah") while the canonical crew
  // row uses the full legal name ("Taj Rahman", "Saadat Ahmed", etc.). This pass matches
  // by crew.full_name LIKE '<firstname> %' (prefix + space) and prefers the row with
  // real shift history.
  if (!isMigrationApplied.get(125)) {
    console.log('Migration 125: prefix-match merge for remaining MGR-XXX duplicates');
    const managerUsers = db.prepare("SELECT id, username, full_name FROM users WHERE username IN ('taj','saadat','suhail.a','savanah')").all();

    const fkTables = [
      ['crew_allocations', 'crew_member_id'],
      ['timesheets', 'crew_member_id'],
      ['clock_events', 'crew_member_id'],
      ['employee_leave', 'crew_member_id'],
      ['worker_availability', 'crew_member_id'],
      ['crew_availability', 'crew_member_id'],
      ['kudos', 'sender_crew_id'],
      ['kudos_recipients', 'recipient_crew_id'],
      ['kudos_reactions', 'crew_member_id'],
      ['kudos_comments', 'crew_member_id'],
      ['kudos_reports', 'reporter_crew_id'],
      ['kudos_blocks', 'blocker_crew_id'],
      ['kudos_blocks', 'blocked_crew_id'],
      ['kudos_milestones', 'crew_member_id'],
      ['leaderboard_optouts', 'crew_member_id'],
      ['home_cards', 'crew_member_id'],
      ['home_preferences', 'crew_member_id'],
      ['streaks', 'crew_member_id'],
    ];

    for (const u of managerUsers) {
      try {
        const mgr = db.prepare(`SELECT * FROM crew_members WHERE employee_id LIKE 'MGR-%' AND LOWER(full_name) = LOWER(?)`).get(u.full_name);
        if (!mgr) continue;

        // Prefix-match: canonical full_name starts with user's first name + space OR exact match.
        // Tiebreaker: most activity wins.
        const candidates = db.prepare(`
          SELECT cm.*,
            (SELECT COUNT(*) FROM timesheets t WHERE t.crew_member_id = cm.id) +
            (SELECT COUNT(*) FROM crew_allocations a WHERE a.crew_member_id = cm.id) +
            (SELECT COUNT(*) FROM clock_events ce WHERE ce.crew_member_id = cm.id) AS activity
          FROM crew_members cm
          WHERE cm.id != ?
            AND cm.employee_id NOT LIKE 'MGR-%'
            AND (LOWER(cm.full_name) = LOWER(?) OR LOWER(cm.full_name) LIKE LOWER(?) || ' %')
          ORDER BY activity DESC, cm.id ASC
        `).all(mgr.id, u.full_name, u.full_name);
        const canonical = candidates[0];

        if (!canonical) {
          console.log(`[mig 125] ${mgr.employee_id} still orphaned — no prefix match for "${u.full_name}"`);
          continue;
        }

        console.log(`[mig 125] Merging ${mgr.employee_id} → ${canonical.employee_id} (${canonical.full_name})`);

        db.prepare('UPDATE crew_members SET is_manager = 1 WHERE id = ?').run(canonical.id);
        if (!canonical.pin_hash && mgr.pin_hash) {
          try { db.prepare('UPDATE crew_members SET pin_hash = ?, pin_set_at = ? WHERE id = ?').run(mgr.pin_hash, mgr.pin_set_at, canonical.id); } catch (e) {}
        }

        const canonicalEmp = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ? LIMIT 1').get(canonical.id);
        const mgrEmp = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ? LIMIT 1').get(mgr.id);
        if (canonicalEmp && mgrEmp && canonicalEmp.id !== mgrEmp.id) {
          if (!canonicalEmp.linked_user_id && mgrEmp.linked_user_id) {
            db.prepare('UPDATE employees SET linked_user_id = ? WHERE id = ?').run(mgrEmp.linked_user_id, canonicalEmp.id);
          }
          const empFkTables = [
            'emergency_contacts','employee_competencies','employee_documents','employee_leave',
            'bank_accounts','super_funds','tfn_declarations',
          ];
          for (const t of empFkTables) {
            try { db.prepare(`UPDATE OR IGNORE ${t} SET employee_id = ? WHERE employee_id = ?`).run(canonicalEmp.id, mgrEmp.id); } catch (e) {}
            try { db.prepare(`DELETE FROM ${t} WHERE employee_id = ?`).run(mgrEmp.id); } catch (e) {}
          }
          try { db.prepare('DELETE FROM employees WHERE id = ?').run(mgrEmp.id); } catch (e) { console.log('[mig 125] could not delete duplicate employees row:', e.message); }
        } else if (mgrEmp && !canonicalEmp) {
          db.prepare('UPDATE employees SET linked_crew_member_id = ? WHERE id = ?').run(canonical.id, mgrEmp.id);
        }

        for (const [table, col] of fkTables) {
          try { db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`).run(canonical.id, mgr.id); } catch (e) {}
          try { db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(mgr.id); } catch (e) {}
        }
        try { db.prepare(`UPDATE activity_log SET entity_id = ? WHERE entity_type = 'crew_member' AND entity_id = ?`).run(canonical.id, mgr.id); } catch (e) {}

        db.prepare('DELETE FROM crew_members WHERE id = ?').run(mgr.id);
        console.log(`[mig 125] ${mgr.employee_id} merged into ${canonical.employee_id} and deleted`);
      } catch (e) {
        console.error(`[mig 125] Merge failed for ${u.username}:`, e.message);
      }
    }

    recordMigration.run(125, 'Prefix-match merge for remaining MGR-XXX manager duplicates');
    console.log('Migration 125 applied');
  }

  // Migration 124: Merge MGR-XXX duplicate crew rows into existing canonical rows.
  // Migration 123 created fresh crew_member rows for every known manager, but most of
  // them already worked shifts and had a crew profile. This merge preserves the real
  // employee history and moves the is_manager flag + linked_user_id across.
  if (!isMigrationApplied.get(124)) {
    console.log('Migration 124: merging MGR-XXX manager duplicates into canonical crew rows');
    const managerUsers = db.prepare("SELECT id, username, full_name FROM users WHERE username IN ('taj','saadat','suhail.a','savanah')").all();

    // All child tables that reference crew_members.id — updated with OR IGNORE then
    // leftovers deleted in case a UNIQUE constraint prevents the move.
    const fkTables = [
      ['crew_allocations', 'crew_member_id'],
      ['timesheets', 'crew_member_id'],
      ['clock_events', 'crew_member_id'],
      ['employee_leave', 'crew_member_id'],
      ['worker_availability', 'crew_member_id'],
      ['crew_availability', 'crew_member_id'],
      ['kudos', 'sender_crew_id'],
      ['kudos_recipients', 'recipient_crew_id'],
      ['kudos_reactions', 'crew_member_id'],
      ['kudos_comments', 'crew_member_id'],
      ['kudos_reports', 'reporter_crew_id'],
      ['kudos_blocks', 'blocker_crew_id'],
      ['kudos_blocks', 'blocked_crew_id'],
      ['kudos_milestones', 'crew_member_id'],
      ['leaderboard_optouts', 'crew_member_id'],
      ['home_cards', 'crew_member_id'],
      ['home_preferences', 'crew_member_id'],
      ['streaks', 'crew_member_id'],
    ];

    for (const u of managerUsers) {
      try {
        // The row migration 123 minted — always has employee_id LIKE 'MGR-%'
        const mgr = db.prepare(`SELECT * FROM crew_members WHERE employee_id LIKE 'MGR-%' AND LOWER(full_name) = LOWER(?)`).get(u.full_name);
        if (!mgr) continue;

        // Find a canonical row: same name, not the MGR row, prefer one with actual
        // history (more timesheets / allocations / clock events wins).
        const candidates = db.prepare(`
          SELECT cm.*,
            (SELECT COUNT(*) FROM timesheets t WHERE t.crew_member_id = cm.id) +
            (SELECT COUNT(*) FROM crew_allocations a WHERE a.crew_member_id = cm.id) +
            (SELECT COUNT(*) FROM clock_events ce WHERE ce.crew_member_id = cm.id) AS activity
          FROM crew_members cm
          WHERE cm.id != ? AND LOWER(cm.full_name) = LOWER(?)
          ORDER BY activity DESC, cm.id ASC
        `).all(mgr.id, u.full_name);
        const canonical = candidates[0];

        if (!canonical) {
          console.log(`[mig 124] ${mgr.employee_id} kept as-is — no existing crew row matched "${u.full_name}"`);
          continue;
        }

        console.log(`[mig 124] Merging ${mgr.employee_id} → ${canonical.employee_id} (${u.full_name})`);

        // Mark the canonical row as manager and carry PIN if canonical didn't have one
        db.prepare('UPDATE crew_members SET is_manager = 1 WHERE id = ?').run(canonical.id);
        if (!canonical.pin_hash && mgr.pin_hash) {
          try { db.prepare('UPDATE crew_members SET pin_hash = ?, pin_set_at = ? WHERE id = ?').run(mgr.pin_hash, mgr.pin_set_at, canonical.id); } catch (e) {}
        }

        // Consolidate employees rows. MGR always has one (we inserted it in 123). Canonical
        // may or may not — handle both.
        const canonicalEmp = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ? LIMIT 1').get(canonical.id);
        const mgrEmp = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ? LIMIT 1').get(mgr.id);
        if (canonicalEmp && mgrEmp && canonicalEmp.id !== mgrEmp.id) {
          // Keep canonical, carry linked_user_id across if missing
          if (!canonicalEmp.linked_user_id && mgrEmp.linked_user_id) {
            db.prepare('UPDATE employees SET linked_user_id = ? WHERE id = ?').run(mgrEmp.linked_user_id, canonicalEmp.id);
          }
          // Move all employee_id-keyed children from mgrEmp to canonicalEmp before deleting it
          const empFkTables = [
            'emergency_contacts','employee_competencies','employee_documents','employee_leave',
            'bank_accounts','super_funds','tfn_declarations',
          ];
          for (const t of empFkTables) {
            try { db.prepare(`UPDATE OR IGNORE ${t} SET employee_id = ? WHERE employee_id = ?`).run(canonicalEmp.id, mgrEmp.id); } catch (e) {}
            try { db.prepare(`DELETE FROM ${t} WHERE employee_id = ?`).run(mgrEmp.id); } catch (e) {}
          }
          // Drop the duplicate employees row
          try { db.prepare('DELETE FROM employees WHERE id = ?').run(mgrEmp.id); } catch (e) { console.log('[mig 124] could not delete duplicate employees row:', e.message); }
        } else if (mgrEmp && !canonicalEmp) {
          // Canonical had no employees record yet — just repoint MGR's to canonical
          db.prepare('UPDATE employees SET linked_crew_member_id = ? WHERE id = ?').run(canonical.id, mgrEmp.id);
        }

        // Repoint crew_members child rows. Unique-constraint conflicts fall through to
        // DELETE which keeps the canonical row's existing record.
        for (const [table, col] of fkTables) {
          try { db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`).run(canonical.id, mgr.id); } catch (e) { /* table may not exist yet */ }
          try { db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(mgr.id); } catch (e) { /* table may not exist yet */ }
        }

        // Activity log references crew_members.id through entity_id for some rows — update those too
        try { db.prepare(`UPDATE activity_log SET entity_id = ? WHERE entity_type = 'crew_member' AND entity_id = ?`).run(canonical.id, mgr.id); } catch (e) {}

        // Finally drop the MGR crew_member row
        db.prepare('DELETE FROM crew_members WHERE id = ?').run(mgr.id);
        console.log(`[mig 124] ${mgr.employee_id} merged into ${canonical.employee_id} and deleted`);
      } catch (e) {
        console.error(`[mig 124] Merge failed for ${u.username}:`, e.message);
      }
    }

    recordMigration.run(124, 'Merge MGR-XXX manager duplicates into canonical crew rows');
    console.log('Migration 124 applied: manager duplicates consolidated');
  }

  // Migration 123: Manager portal access — is_manager flag + provision rows for known managers
  if (!isMigrationApplied.get(123)) {
    try { db.exec("ALTER TABLE crew_members ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* exists */ }

    // Provision a crew_member + employees row for each existing admin-level user so they can sign
    // into the employee portal. PIN must be set by an admin via the standard /hr/employees/:id flow —
    // we intentionally don't write a default PIN here (passwords in migrations are a smell).
    const managers = ['taj', 'saadat', 'suhail.a', 'savanah'];
    const getUser = db.prepare("SELECT id, full_name, email FROM users WHERE username = ? AND active = 1");
    const hasCrew = db.prepare("SELECT id FROM crew_members WHERE employee_id = ?");
    const insCrew = db.prepare(`
      INSERT INTO crew_members (full_name, employee_id, role, phone, email, company, employment_type, active, status, is_manager)
      VALUES (?, ?, 'supervisor', '', ?, 'T&S Traffic Control', 'employee', 1, 'active', 1)
    `);
    const hasEmp = db.prepare("SELECT id FROM employees WHERE employee_code = ?");
    const insEmp = db.prepare(`
      INSERT INTO employees (employee_code, first_name, last_name, full_name, company, employment_type, employment_status, email, active, linked_crew_member_id, linked_user_id, internal_notes, induction_status)
      VALUES (?, ?, ?, ?, 'T&S Traffic Control', 'full_time', 'active', ?, 1, ?, ?, 'Auto-created manager account', 'completed')
    `);

    let counter = 1;
    for (const uname of managers) {
      try {
        const u = getUser.get(uname); if (!u) continue;
        const empId = `MGR-${String(counter).padStart(3, '0')}`;
        counter++;
        let crewRow = hasCrew.get(empId);
        if (!crewRow) {
          const result = insCrew.run(u.full_name || uname, empId, u.email || '');
          crewRow = { id: result.lastInsertRowid };
        } else {
          db.prepare("UPDATE crew_members SET is_manager = 1 WHERE id = ?").run(crewRow.id);
        }
        if (!hasEmp.get(empId)) {
          const parts = (u.full_name || uname).split(' ');
          const first = parts[0] || uname;
          const last = parts.slice(1).join(' ') || '';
          insEmp.run(empId, first, last, u.full_name || uname, u.email || '', crewRow.id, u.id);
        }
      } catch (e) { console.log('Migration 123: skip ' + uname + ': ' + e.message); }
    }

    recordMigration.run(123, 'Manager portal access — is_manager flag + provision manager crew rows');
    console.log('Migration 123 applied: manager portal flag + provisioned manager logins');
  }

  // Migration 122: Kudos — peer recognition system
  if (!isMigrationApplied.get(122)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        colour TEXT NOT NULL DEFAULT '#2B7FFF',
        icon TEXT DEFAULT 'star',
        description TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS kudos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_crew_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        value_id INTEGER REFERENCES company_values(id),
        message TEXT NOT NULL,
        photo_url TEXT,
        visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','team','private')),
        is_leadership INTEGER NOT NULL DEFAULT 0,
        hidden_at DATETIME,
        hidden_by_user_id INTEGER REFERENCES users(id),
        hidden_reason TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_kudos_sender ON kudos(sender_crew_id);
      CREATE INDEX IF NOT EXISTS idx_kudos_value ON kudos(value_id);
      CREATE INDEX IF NOT EXISTS idx_kudos_created ON kudos(created_at DESC);

      CREATE TABLE IF NOT EXISTS kudos_recipients (
        kudos_id INTEGER NOT NULL REFERENCES kudos(id) ON DELETE CASCADE,
        recipient_crew_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        PRIMARY KEY (kudos_id, recipient_crew_id)
      );
      CREATE INDEX IF NOT EXISTS idx_kudos_recipients_rcpt ON kudos_recipients(recipient_crew_id);

      CREATE TABLE IF NOT EXISTS kudos_reactions (
        kudos_id INTEGER NOT NULL REFERENCES kudos(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        reaction_type TEXT NOT NULL CHECK(reaction_type IN ('clap','heart','raise','flex','fire')),
        created_at DATETIME DEFAULT (datetime('now')),
        PRIMARY KEY (kudos_id, crew_member_id, reaction_type)
      );

      CREATE TABLE IF NOT EXISTS kudos_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kudos_id INTEGER NOT NULL REFERENCES kudos(id) ON DELETE CASCADE,
        parent_comment_id INTEGER REFERENCES kudos_comments(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        hidden_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_kudos_comments_kudos ON kudos_comments(kudos_id);

      CREATE TABLE IF NOT EXISTS kudos_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kudos_id INTEGER REFERENCES kudos(id) ON DELETE CASCADE,
        comment_id INTEGER REFERENCES kudos_comments(id) ON DELETE CASCADE,
        reporter_crew_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        reason TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','actioned','dismissed')),
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_kudos_reports_status ON kudos_reports(status);

      CREATE TABLE IF NOT EXISTS kudos_blocks (
        blocker_crew_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        blocked_crew_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT (datetime('now')),
        PRIMARY KEY (blocker_crew_id, blocked_crew_id)
      );

      CREATE TABLE IF NOT EXISTS kudos_milestones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        milestone_type TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        posted_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(crew_member_id, milestone_type)
      );

      CREATE TABLE IF NOT EXISTS leaderboard_optouts (
        crew_member_id INTEGER PRIMARY KEY REFERENCES crew_members(id) ON DELETE CASCADE,
        opted_out_at DATETIME DEFAULT (datetime('now'))
      );
    `);

    // Seed default company values
    const seed = db.prepare("INSERT OR IGNORE INTO company_values (name, slug, colour, icon, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
    seed.run('Safety First', 'safety', '#EF4444', 'shield', 'Looking out for mates and the public on every job.', 10);
    seed.run('Teamwork', 'teamwork', '#2B7FFF', 'users', 'Lifting the crew — sharing knowledge and backing each other.', 20);
    seed.run('Going The Extra Mile', 'extra-mile', '#F59E0B', 'star', 'Doing more than asked, staying late, catching the details.', 30);
    seed.run('Customer Focus', 'customer', '#8B5CF6', 'handshake', 'Professional, respectful, problem-solvers for our clients.', 40);
    seed.run('Reliability', 'reliability', '#10B981', 'check', 'On time, every time. People you can count on.', 50);

    recordMigration.run(122, 'Kudos peer recognition system');
    console.log('Migration 122 applied: kudos tables + default values seeded');
  }

  // Migration 121: Home personalisation — cards, preferences, streaks
  if (!isMigrationApplied.get(121)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS home_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        card_type TEXT NOT NULL,
        card_key TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50,
        payload TEXT DEFAULT '{}',
        shown_at DATETIME,
        dismissed_at DATETIME,
        acted_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(crew_member_id, card_key)
      );
      CREATE INDEX IF NOT EXISTS idx_home_cards_member ON home_cards(crew_member_id);
      CREATE INDEX IF NOT EXISTS idx_home_cards_active ON home_cards(crew_member_id, dismissed_at);

      CREATE TABLE IF NOT EXISTS home_preferences (
        crew_member_id INTEGER PRIMARY KEY REFERENCES crew_members(id) ON DELETE CASCADE,
        section_order TEXT DEFAULT '',
        hidden_sections TEXT DEFAULT '',
        fab_actions TEXT DEFAULT '',
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS streaks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
        streak_type TEXT NOT NULL,
        current_count INTEGER NOT NULL DEFAULT 0,
        best_count INTEGER NOT NULL DEFAULT 0,
        last_incremented_at DATETIME,
        UNIQUE(crew_member_id, streak_type)
      );
      CREATE INDEX IF NOT EXISTS idx_streaks_member ON streaks(crew_member_id);
    `);
    recordMigration.run(121, 'Home personalisation: home_cards, home_preferences, streaks');
    console.log('Migration 121 applied: home personalisation tables');
  }

  // Migration 120: Induction signature — consent block + signed PDF
  if (!isMigrationApplied.get(120)) {
    try { db.exec("ALTER TABLE induction_submissions ADD COLUMN signature_url TEXT DEFAULT ''"); } catch (e) {}
    try { db.exec("ALTER TABLE induction_submissions ADD COLUMN consent_signed_at DATETIME"); } catch (e) {}
    try { db.exec("ALTER TABLE induction_submissions ADD COLUMN consent_full_name TEXT DEFAULT ''"); } catch (e) {}
    try { db.exec("ALTER TABLE induction_submissions ADD COLUMN consent_version TEXT DEFAULT ''"); } catch (e) {}
    try { db.exec("ALTER TABLE induction_submissions ADD COLUMN signed_pdf_url TEXT DEFAULT ''"); } catch (e) {}
    try { db.exec("ALTER TABLE induction_submissions ADD COLUMN signed_ip TEXT DEFAULT ''"); } catch (e) {}
    recordMigration.run(120, 'Induction signature + signed PDF columns');
    console.log('Migration 120 applied: induction signature columns');
  }

  // Migration 119: Expand activity_log CHECK to include 'view'
  if (!isMigrationApplied.get(119)) {
    try {
      const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activity_log'").get();
      if (info && info.sql && !info.sql.includes("'view'")) {
        db.exec('BEGIN TRANSACTION');
        const cols = db.prepare("PRAGMA table_info(activity_log)").all().map(c => c.name).join(', ');
        db.exec(`CREATE TABLE activity_log_rebuild (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          user_name TEXT,
          action TEXT NOT NULL CHECK(action IN ('create','update','delete','view','login','logout','upload','download','complete','approve','reject')),
          entity_type TEXT,
          entity_id INTEGER,
          entity_label TEXT DEFAULT '',
          job_id INTEGER,
          job_number TEXT DEFAULT '',
          details TEXT DEFAULT '',
          before_value TEXT DEFAULT '',
          after_value TEXT DEFAULT '',
          ip_address TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.exec(`INSERT INTO activity_log_rebuild (${cols}) SELECT ${cols} FROM activity_log`);
        db.exec('DROP TABLE activity_log');
        db.exec('ALTER TABLE activity_log_rebuild RENAME TO activity_log');
        db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_job ON activity_log(job_id)');
        db.exec('COMMIT');
      }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (r) {}
      console.error('Migration 119 error:', e.message);
    }
    recordMigration.run(119, 'Expand activity_log action CHECK to include view');
    console.log('Migration 119 applied: activity_log supports view action');
  }

  // Migration 118: Secure HR forms — bank_accounts, super_funds, tfn_declarations
  if (!isMigrationApplied.get(118)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        account_name TEXT NOT NULL,
        bsb_last3 TEXT DEFAULT '',
        account_last3 TEXT DEFAULT '',
        bsb_encrypted TEXT,
        account_number_encrypted TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','rejected')),
        synced_at DATETIME,
        synced_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bank_accounts_emp ON bank_accounts(employee_id);
      CREATE INDEX IF NOT EXISTS idx_bank_accounts_status ON bank_accounts(status);

      CREATE TABLE IF NOT EXISTS super_funds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        fund_name TEXT,
        usi TEXT,
        member_number TEXT,
        fund_abn TEXT,
        choice_form_url TEXT,
        use_default INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','rejected')),
        synced_at DATETIME,
        synced_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_super_funds_emp ON super_funds(employee_id);
      CREATE INDEX IF NOT EXISTS idx_super_funds_status ON super_funds(status);

      CREATE TABLE IF NOT EXISTS tfn_declarations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        tfn_encrypted TEXT,
        tfn_last3 TEXT DEFAULT '',
        residency_status TEXT CHECK(residency_status IN ('resident','foreign','working_holiday')),
        claim_threshold INTEGER DEFAULT 0,
        has_help_debt INTEGER DEFAULT 0,
        has_stsl_debt INTEGER DEFAULT 0,
        medicare_variation TEXT DEFAULT 'none',
        signature_url TEXT,
        pdf_url TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','rejected')),
        submitted_at DATETIME DEFAULT (datetime('now')),
        processed_at DATETIME,
        processed_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tfn_emp ON tfn_declarations(employee_id);
      CREATE INDEX IF NOT EXISTS idx_tfn_status ON tfn_declarations(status);
    `);
    recordMigration.run(118, 'Secure HR forms — bank_accounts, super_funds, tfn_declarations');
    console.log('Migration 118 applied: secure HR forms schema');
  }

  // Migration 117: My Profile — profile_photo_url, address_line1/2 on employees + emergency_contacts table
  if (!isMigrationApplied.get(117)) {
    try { db.exec("ALTER TABLE employees ADD COLUMN profile_photo_url TEXT"); } catch (e) { /* exists */ }
    try { db.exec("ALTER TABLE employees ADD COLUMN address_line1 TEXT DEFAULT ''"); } catch (e) { /* exists */ }
    try { db.exec("ALTER TABLE employees ADD COLUMN address_line2 TEXT DEFAULT ''"); } catch (e) { /* exists */ }
    // Backfill address_line1 from legacy single-line address if present
    try { db.exec("UPDATE employees SET address_line1 = COALESCE(address,'') WHERE COALESCE(address_line1,'') = '' AND COALESCE(address,'') != ''"); } catch (e) { /* ignore */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS emergency_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        relationship TEXT DEFAULT '',
        phone TEXT NOT NULL,
        alt_phone TEXT DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
    `);
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_emergency_contacts_emp ON emergency_contacts(employee_id)"); } catch (e) { /* exists */ }
    recordMigration.run(117, 'My Profile: address_line1/2, profile_photo_url, emergency_contacts');
    console.log('Migration 117 applied: profile + emergency contacts schema');
  }

  // Migration 135: Equipment hire dockets — multi-item pick-up / drop-off checklists
  // (Was originally numbered 126 but collided with the payslips migration that
  //  shipped first and locked the 126 slot on prod — renumbered so this runs.)
  if (!isMigrationApplied.get(135)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hire_dockets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        docket_number TEXT,
        job_number TEXT DEFAULT '',
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        date_prepared DATE,
        site_location TEXT DEFAULT '',
        prepared_by TEXT DEFAULT '',
        prepared_by_contact TEXT DEFAULT '',
        supervisor TEXT DEFAULT '',
        crew TEXT DEFAULT '',
        supplier_name TEXT DEFAULT '',
        supplier_hire_ref TEXT DEFAULT '',
        supplier_contact TEXT DEFAULT '',
        supplier_phone TEXT DEFAULT '',
        pickup_address TEXT DEFAULT '',
        hire_period TEXT DEFAULT '',
        agreed_rate TEXT DEFAULT '',
        pickup_notes TEXT DEFAULT '',
        dropoff_notes TEXT DEFAULT '',
        pickup_collected_by TEXT DEFAULT '',
        pickup_signature TEXT DEFAULT '',
        pickup_date DATE,
        pickup_supplier_rep TEXT DEFAULT '',
        dropoff_returned_by TEXT DEFAULT '',
        dropoff_signature TEXT DEFAULT '',
        dropoff_date DATE,
        dropoff_supplier_rep TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','picked_up','returned','closed')),
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS hire_docket_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        docket_id INTEGER NOT NULL REFERENCES hire_dockets(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 1,
        equipment_type TEXT DEFAULT '',
        rego_serial TEXT DEFAULT '',
        asset_id TEXT DEFAULT '',
        equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL,
        quantity INTEGER DEFAULT 1,
        summary_notes TEXT DEFAULT '',
        pickup_datetime DATETIME,
        pickup_hours_odometer TEXT DEFAULT '',
        pickup_fuel TEXT DEFAULT '',
        pickup_damage_observed INTEGER DEFAULT 0,
        pickup_photos_taken INTEGER DEFAULT 0,
        pickup_damage_notes TEXT DEFAULT '',
        pickup_roadworthy TEXT DEFAULT '',
        pickup_accessories TEXT DEFAULT '',
        pickup_clean INTEGER DEFAULT 0,
        pickup_initials TEXT DEFAULT '',
        dropoff_datetime DATETIME,
        dropoff_hours_odometer TEXT DEFAULT '',
        dropoff_fuel TEXT DEFAULT '',
        dropoff_damage_observed INTEGER DEFAULT 0,
        dropoff_photos_taken INTEGER DEFAULT 0,
        dropoff_damage_notes TEXT DEFAULT '',
        dropoff_roadworthy TEXT DEFAULT '',
        dropoff_accessories TEXT DEFAULT '',
        dropoff_clean INTEGER DEFAULT 0,
        dropoff_initials TEXT DEFAULT ''
      )
    `);
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hire_docket_items_docket ON hire_docket_items(docket_id)"); } catch (e) {}
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hire_dockets_status ON hire_dockets(status)"); } catch (e) {}
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hire_dockets_job ON hire_dockets(job_id)"); } catch (e) {}
    recordMigration.run(135, 'Equipment hire dockets: multi-item pick-up / drop-off checklists');
    console.log('Migration 126 applied: hire_dockets + hire_docket_items');
  }

  // Migration 127: Backfill stale closed jobs so every row in the register visibly reflects
  // the closed state — stage='closeout', percent_complete=100, priority='normal'.
  // Safe to re-run: only touches rows where one of those fields is still stale.
  if (!isMigrationApplied.get(127)) {
    try {
      const r = db.prepare(`
        UPDATE jobs SET
          stage = 'closeout',
          percent_complete = 100,
          priority = 'normal',
          updated_at = CURRENT_TIMESTAMP
        WHERE status = 'closed'
          AND (stage != 'closeout' OR percent_complete < 100 OR priority != 'normal')
      `).run();
      console.log(`Migration 127: backfilled ${r.changes} closed jobs to stage='closeout', percent_complete=100, priority='normal'`);
    } catch (e) {
      console.error('Migration 127 error:', e.message);
    }
    recordMigration.run(127, 'Backfill closed jobs: stage=closeout, percent_complete=100, priority=normal');
    console.log('Migration 127 applied: closed jobs backfilled');
  }

  // Migration 128: Add deleted_at column to tasks for soft-delete (enables "view deleted tasks")
  if (!isMigrationApplied.get(128)) {
    try { db.exec("ALTER TABLE tasks ADD COLUMN deleted_at DATETIME"); } catch (e) { /* column may exist */ }
    try { db.exec("ALTER TABLE tasks ADD COLUMN deleted_by INTEGER REFERENCES users(id)"); } catch (e) { /* column may exist */ }
    recordMigration.run(128, 'Tasks soft-delete columns');
    console.log('Migration 128 applied: tasks.deleted_at + deleted_by');
  }

  // Migration 129: Hire docket checklist v2 — rebuild to PDF spec
  // Adds: commercial terms, off-hire notification, dispute block, reconciliation,
  // canvas-signature paths, hire_end_date, soft-delete columns on hire_dockets.
  // Adds: chain of custody, pre-existing damage tracking, operational test,
  // site/weather, inspection exception, per-item sign-off on hire_docket_items.
  // New tables: hire_docket_accessories, hire_docket_attachments, hire_docket_photos.
  if (!isMigrationApplied.get(129)) {
    console.log('Running migration 129: Hire docket checklist v2');

    const docketCols = [
      // Commercial terms
      "ALTER TABLE hire_dockets ADD COLUMN included_allowance TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN excess_charge TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN fuel_return_requirement TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN cleaning_expectation TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN damage_liability_received INTEGER DEFAULT 0",
      "ALTER TABLE hire_dockets ADD COLUMN late_return_approved TEXT DEFAULT ''",
      // Off-hire notification
      "ALTER TABLE hire_dockets ADD COLUMN offhire_method TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN offhire_notified_at DATETIME",
      "ALTER TABLE hire_dockets ADD COLUMN offhire_person_notified TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN offhire_reference TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN offhire_notified_by TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN offhire_confirmed INTEGER DEFAULT 0",
      // Dispute
      "ALTER TABLE hire_dockets ADD COLUMN dispute_alleged_damage INTEGER DEFAULT 0",
      "ALTER TABLE hire_dockets ADD COLUMN dispute_photos_both_parties INTEGER DEFAULT 0",
      "ALTER TABLE hire_dockets ADD COLUMN dispute_raised_immediately INTEGER DEFAULT 0",
      "ALTER TABLE hire_dockets ADD COLUMN dispute_details TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN dispute_internal_notified TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN dispute_est_value REAL DEFAULT 0",
      "ALTER TABLE hire_dockets ADD COLUMN dispute_next_action TEXT DEFAULT ''",
      // Admin / reconciliation
      "ALTER TABLE hire_dockets ADD COLUMN recon_reviewed_by_id INTEGER REFERENCES users(id)",
      "ALTER TABLE hire_dockets ADD COLUMN recon_review_date DATE",
      "ALTER TABLE hire_dockets ADD COLUMN recon_invoice_number TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN recon_charges_checked INTEGER DEFAULT 0",
      "ALTER TABLE hire_dockets ADD COLUMN recon_variations_reconciled TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN recon_closed_out INTEGER DEFAULT 0",
      "ALTER TABLE hire_dockets ADD COLUMN recon_notes TEXT DEFAULT ''",
      // Canvas signatures (PNG file paths)
      "ALTER TABLE hire_dockets ADD COLUMN pickup_signature_path TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN pickup_supplier_rep_signature_path TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN dropoff_signature_path TEXT DEFAULT ''",
      "ALTER TABLE hire_dockets ADD COLUMN dropoff_supplier_rep_signature_path TEXT DEFAULT ''",
      // Hire window + soft-delete
      "ALTER TABLE hire_dockets ADD COLUMN hire_end_date DATE",
      "ALTER TABLE hire_dockets ADD COLUMN deleted_at DATETIME",
      "ALTER TABLE hire_dockets ADD COLUMN deleted_by INTEGER REFERENCES users(id)",
    ];
    for (const sql of docketCols) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }

    const itemCols = [
      // Chain of custody
      "ALTER TABLE hire_docket_items ADD COLUMN collected_full_name TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN collected_mobile TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN collected_company TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN returned_full_name TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN returned_mobile TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN returned_company TEXT DEFAULT ''",
      // Pre-existing damage
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_pre_existing_damage_ack INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_supplier_disputes_damage TEXT DEFAULT ''",
      // Operational test — pickup
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_op_test_completed INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_op_powers_on INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_op_safe_to_use TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_op_reported_to_supplier TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_op_faults TEXT DEFAULT ''",
      // Operational test — dropoff
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_op_test_completed INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_op_powers_on INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_op_safe_to_use TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_op_reported_to_supplier TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_op_faults TEXT DEFAULT ''",
      // Site & weather
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_site_conditions TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_weather TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_site_conditions TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_weather TEXT DEFAULT ''",
      // Inspection exception — pickup
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_full_inspection_not_possible INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_inspection_reason TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_limited_photos INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_supplier_notified_limited INTEGER DEFAULT 0",
      // Inspection exception — dropoff
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_full_inspection_not_possible INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_inspection_reason TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_limited_photos INTEGER DEFAULT 0",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_supplier_notified_limited INTEGER DEFAULT 0",
      // Per-item sign-off
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_signoff_name TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_signoff_signature_path TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN pickup_signoff_at DATETIME",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_signoff_name TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_signoff_signature_path TEXT DEFAULT ''",
      "ALTER TABLE hire_docket_items ADD COLUMN dropoff_signoff_at DATETIME",
    ];
    for (const sql of itemCols) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }

    // Accessories line items (one row per accessory per equipment item)
    db.exec(`
      CREATE TABLE IF NOT EXISTS hire_docket_accessories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES hire_docket_items(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        qty_out INTEGER DEFAULT 0,
        qty_back INTEGER DEFAULT 0,
        condition TEXT DEFAULT '',
        missing_damaged INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hda_item ON hire_docket_accessories(item_id)"); } catch (e) { /* ignore */ }

    // Categorised docket-level attachments (hire agreement, pickup/return dockets, etc.)
    db.exec(`
      CREATE TABLE IF NOT EXISTS hire_docket_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        docket_id INTEGER NOT NULL REFERENCES hire_dockets(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_name TEXT DEFAULT '',
        mime_type TEXT DEFAULT '',
        size_bytes INTEGER DEFAULT 0,
        uploaded_by_id INTEGER REFERENCES users(id),
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hda_att_docket ON hire_docket_attachments(docket_id, category)"); } catch (e) { /* ignore */ }

    // Per-item photos (with optional link to a required-shot slot via checklist_key)
    db.exec(`
      CREATE TABLE IF NOT EXISTS hire_docket_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES hire_docket_items(id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        checklist_key TEXT DEFAULT '',
        file_path TEXT NOT NULL,
        original_name TEXT DEFAULT '',
        mime_type TEXT DEFAULT '',
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hdp_item_phase ON hire_docket_photos(item_id, phase)"); } catch (e) { /* ignore */ }

    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hire_dockets_deleted ON hire_dockets(deleted_at)"); } catch (e) { /* ignore */ }
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hire_dockets_overdue ON hire_dockets(status, hire_end_date) WHERE deleted_at IS NULL"); } catch (e) { /* SQLite may reject partial-index expression on older versions */ }

    recordMigration.run(129, 'Hire docket checklist v2 — PDF spec fields + accessories/photos/attachments tables');
    console.log('Migration 129 applied: hire docket v2 fields + tables');
  }

  // Migration 130: Hire docket dispute — link an allegation to a specific item
  // so crews can pinpoint which item a supplier is disputing (rather than
  // leaving the whole docket's dispute block ambiguous).
  if (!isMigrationApplied.get(130)) {
    try { db.exec("ALTER TABLE hire_dockets ADD COLUMN dispute_item_id INTEGER REFERENCES hire_docket_items(id) ON DELETE SET NULL"); } catch (e) { /* column may exist */ }
    recordMigration.run(130, 'Hire docket dispute_item_id column');
    console.log('Migration 130 applied: hire_dockets.dispute_item_id');
  }

  // Migration 131: Hire supplier profiles — save supplier contact + commercial
  // terms once, pre-fill on future hire dockets instead of retyping every time.
  if (!isMigrationApplied.get(131)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hire_suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        contact_person TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        pickup_address TEXT DEFAULT '',
        included_allowance TEXT DEFAULT '',
        excess_charge TEXT DEFAULT '',
        fuel_return_requirement TEXT DEFAULT '',
        cleaning_expectation TEXT DEFAULT '',
        damage_liability_received INTEGER DEFAULT 0,
        late_return_approved TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try { db.exec("CREATE INDEX IF NOT EXISTS idx_hire_suppliers_name ON hire_suppliers(name COLLATE NOCASE)"); } catch (e) { /* ignore */ }
    recordMigration.run(131, 'Hire supplier profiles table');
    console.log('Migration 131 applied: hire_suppliers');
  }

  // Migration 132: Backfill — close tasks whose linked compliance item is
  // already approved or submitted. Without this, planning assignees see a
  // queue of tasks that were never marked complete because historical bulk-
  // status actions didn't sync task state. One-shot cleanup.
  if (!isMigrationApplied.get(132)) {
    try {
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'complete',
            completed_date = COALESCE(completed_date, date('now')),
            updated_at = CURRENT_TIMESTAMP
        WHERE compliance_id IN (SELECT id FROM compliance WHERE status IN ('approved','submitted'))
          AND status != 'complete'
          AND deleted_at IS NULL
      `).run();
      console.log(`Migration 132: closed ${result.changes} task(s) for approved/submitted compliance items`);
    } catch (e) {
      console.error('Migration 132 error:', e.message);
    }
    recordMigration.run(132, 'Backfill: close tasks for approved/submitted compliance');
    console.log('Migration 132 applied: task cleanup');
  }

  // Migration 133: Expand users.role CHECK to include 'marketing' (and the
  // legacy aliases 'management', 'accounts' that the /admin/users form has
  // always offered but the CHECK constraint quietly rejected).
  if (!isMigrationApplied.get(133)) {
    const userSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (userSql && userSql.sql && !userSql.sql.includes("'marketing'")) {
      const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const colDefs = db.prepare("PRAGMA table_info(users)").all().map(c => {
        const notNull = c.notnull ? ' NOT NULL' : '';
        const dflt = c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : '';
        const pk = c.pk ? ' PRIMARY KEY AUTOINCREMENT' : '';
        const unique = c.name === 'username' ? ' UNIQUE' : '';
        return `${c.name} ${c.type}${pk}${unique}${notNull}${dflt}`;
      }).join(',\n            ');

      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE users_new (
            ${colDefs},
            CHECK(role IN ('admin','operations','planning','finance','hr','sales','management','marketing','accounts'))
        );
      `);
      db.exec(`INSERT INTO users_new (${cols.join(',')}) SELECT ${cols.join(',')} FROM users;`);
      db.exec('DROP TABLE users;');
      db.exec('ALTER TABLE users_new RENAME TO users;');
      db.pragma('foreign_keys = ON');
      console.log("Migration 133: users.role CHECK now includes 'marketing', 'management', 'accounts'");
    } else {
      console.log('Migration 133: users CHECK already permits marketing — nothing to do.');
    }
    recordMigration.run(133, "Expand users.role CHECK to include marketing/management/accounts");
    console.log('Migration 133 applied.');
  }

  // Migration 134: Marketing internal-workflow tables — tasks, approvals,
  // activity log. Backs the /marketing Tasks, Waiting on approval, Quick
  // ask, and Activity feed panels. External-data panels (KPIs, campaigns,
  // SEO, social, reviews, etc.) remain illustrative until the relevant
  // integration adapters land.
  if (!isMigrationApplied.get(134)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS marketing_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        assignee_label TEXT NOT NULL,
        from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        from_label TEXT,
        priority TEXT NOT NULL DEFAULT 'med' CHECK(priority IN ('low','med','high','urgent')),
        due_text TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mkt_tasks_assignee ON marketing_tasks(assignee_user_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mkt_tasks_status ON marketing_tasks(status);`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS marketing_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        meta TEXT,
        due_text TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        decided_at TEXT,
        decision_note TEXT,
        decided_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mkt_approvals_status ON marketing_approvals(status);`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS marketing_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL,
        verb TEXT NOT NULL,
        target_type TEXT,
        target_id INTEGER,
        snippet TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mkt_activity_created ON marketing_activity(created_at DESC);`);

    // Seed once — illustrative tasks + approvals + activity so the page
    // has something to show on fresh install. If any row exists we skip.
    const existingTasks = db.prepare('SELECT COUNT(*) as c FROM marketing_tasks').get().c;
    if (existingTasks === 0) {
      const adminUser = db.prepare("SELECT id, full_name FROM users WHERE role IN ('admin') AND active = 1 ORDER BY id LIMIT 1").get();
      const adminId = adminUser ? adminUser.id : null;
      const adminName = adminUser ? adminUser.full_name : 'Admin';

      const insertTask = db.prepare(`
        INSERT INTO marketing_tasks (title, assignee_user_id, assignee_label, from_user_id, from_label, priority, due_text, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', datetime('now', ?))
      `);

      // Assigned to owner
      insertTask.run('Review & approve Parramatta Council case study (v2)', adminId, adminName, null, 'Lisa (agency)', 'high', 'Due tomorrow', '-2 hours');
      insertTask.run('Approve Google Ads budget increase (+$2,000)',         adminId, adminName, null, 'Tom (agency)',  'med',  'Due today',    '-6 hours');
      insertTask.run('Sign off Acknowledgement of Country video script',     adminId, adminName, null, 'Jess (internal)','high','Fri 25 Apr',   '-1 day');
      insertTask.run('Send 3 recent tender wins for case study pipeline',    adminId, adminName, null, 'Lisa (agency)', 'med',  'Wed 30 Apr',   '-3 hours');

      // Assigned to agency / team (external labels, no user id)
      insertTask.run('Book shoot day for controller recruitment video',                      null, 'Lisa (agency)', adminId, adminName, 'high', 'Tue 29 Apr', '-4 hours');
      insertTask.run('Draft May content calendar with safety + RAP themes',                  null, 'Lisa (agency)', adminId, adminName, 'high', 'Thu 1 May',  '-5 hours');
      insertTask.run('Propose 3 regional LGA content pieces',                                null, 'Tom (agency)',  adminId, adminName, 'med',  'Mon 5 May',  '-6 hours');
      insertTask.run("Reschedule missed blog \"Why safety isn't a checkbox\"",               null, 'Lisa (agency)', adminId, adminName, 'med',  'Fri 25 Apr', '-1 day');
      insertTask.run('Lift employee advocacy participation from 7 → 12',                     null, 'Jess (internal)',adminId, adminName, 'low',  'End May',    '-2 days');
      insertTask.run('Site CRO review (leads conversion 0.8% — below B2B benchmark)',        null, 'Mike (agency)', adminId, adminName, 'high', 'Fri 9 May',  '-2 days');
      insertTask.run('Shortlist 2 Supply Nation partners for next shoot',                    null, 'Lisa (agency)', adminId, adminName, 'med',  'Fri 9 May',  '-3 days');

      const insertApproval = db.prepare(`
        INSERT INTO marketing_approvals (type, title, meta, due_text, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', datetime('now', ?))
      `);
      insertApproval.run('BUDGET',     'Google Ads April — top-up $2,000',            'Tom (agency) · Strong CPL ($128 vs $145 target); wants to scale.', 'today',      '-12 hours');
      insertApproval.run('CONTENT',    "Blog — \"Western Sydney projects we're proud of\"", 'Lisa (agency) · Draft ready · 4 images pending sign-off.',         'Fri 25 Apr', '-1 day');
      insertApproval.run('CASE STUDY', 'Parramatta Council TGS — final version',      'Council legal cleared · waiting on your logo + quote approval.',    'Sat 26 Apr', '-1 day');
      insertApproval.run('CREATIVE',   'LinkedIn ABM creative set (3 variants)',      'Tom (agency) · Live next Monday · needs your pick.',                'Thu 5pm',    '-2 days');

      const insertAct = db.prepare(`
        INSERT INTO marketing_activity (actor_user_id, actor_label, verb, target_type, target_id, snippet, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
      `);
      insertAct.run(null,    'Tom (agency)',  'requested', 'approval', null, '<strong>Tom (agency)</strong> requested a $2,000 budget top-up on <strong>Google Ads — Traffic control NSW</strong>. Awaiting your approval.', '-12 minutes');
      insertAct.run(null,    'Lisa (agency)', 'moved',     'content',  null, "<strong>Lisa (agency)</strong> moved <strong>\"Western Sydney projects we're proud of\"</strong> to Awaiting approval.",                         '-48 minutes');
      insertAct.run(adminId, adminName,       'commented', 'content',  null, '<strong>You</strong> commented on the Parramatta case study: <em>"Use the wide shot from page 3 as the hero."</em>',                                '-2 hours');
      insertAct.run(null,    'Jess (internal)','uploaded', 'content',  null, '<strong>Jess</strong> uploaded the Acknowledgement of Country script · cultural review cleared by Uncle David.',                                    '-3 hours');
      insertAct.run(null,    'Tom (agency)',  'leads',     'leads',    null, '3 new leads from <strong>Google Ads</strong> (1 form, 2 phone). Enquiries routed to sales inbox.',                                                 '-5 hours');
      insertAct.run(null,    'Mike (agency)', 'shipped',   'seo',      null, '<strong>Mike (agency)</strong> shipped SEO update: "traffic guidance scheme newcastle" improved by 4 positions.',                                  '-1 day');
      insertAct.run(null,    'Lisa (agency)', 'shipped',   'content',  null, '<strong>Lisa (agency)</strong> shipped blog: "TMP vs TGS — what councils actually need." Published on LinkedIn + site.',                           '-2 days');
      insertAct.run(adminId, adminName,       'approved',  'invoice',  null, '<strong>You</strong> approved invoice $8,000 · April retainer.',                                                                                   '-2 days');

      console.log(`Migration 134: seeded ${existingTasks === 0 ? '11 tasks, 4 approvals, 8 activity rows' : 'nothing (tables non-empty)'}`);
    } else {
      console.log('Migration 134: marketing_tasks already has rows, skipping seed.');
    }

    recordMigration.run(134, 'Marketing internal-workflow tables (tasks, approvals, activity) + seed');
    console.log('Migration 134 applied.');
  }

  // Migration 136: Backfill bank / super / TFN secure rows for already-accepted inductees.
  // The original induction→employee conversion dumped bank details into employees.internal_notes
  // as plaintext and never seeded the encrypted payroll tables. For every submission with
  // linked_crew_member_id set, this walks the data into bank_accounts, super_funds and
  // tfn_declarations (skipping any employee who already has a record there), then scrubs the
  // plaintext bank leak from internal_notes.
  if (!isMigrationApplied.get(136)) {
    try {
      const { encrypt } = require('../services/encryption');

      const submissions = db.prepare(`
        SELECT s.*, e.id as emp_id
        FROM induction_submissions s
        JOIN employees e ON e.linked_crew_member_id = s.linked_crew_member_id
        WHERE s.linked_crew_member_id IS NOT NULL
      `).all();

      const hasBank = db.prepare('SELECT 1 FROM bank_accounts WHERE employee_id = ?');
      const hasSuper = db.prepare('SELECT 1 FROM super_funds WHERE employee_id = ?');
      const hasTfn = db.prepare('SELECT 1 FROM tfn_declarations WHERE employee_id = ?');
      const insertBank = db.prepare(`
        INSERT INTO bank_accounts (employee_id, account_name, bsb_last3, account_last3,
          bsb_encrypted, account_number_encrypted, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `);
      const insertSuper = db.prepare(`
        INSERT INTO super_funds (employee_id, fund_name, usi, member_number, fund_abn, use_default, status)
        VALUES (?, ?, ?, ?, ?, 0, 'pending')
      `);
      const insertTfn = db.prepare(`
        INSERT INTO tfn_declarations (employee_id, tfn_encrypted, tfn_last3,
          residency_status, claim_threshold, has_help_debt, has_stsl_debt,
          medicare_variation, submitted_at, status)
        VALUES (?, ?, ?, 'resident', 1, 0, 0, 'none', datetime('now'), 'pending')
      `);
      const scrubNotes = db.prepare(`
        UPDATE employees SET internal_notes = ? WHERE id = ? AND internal_notes LIKE '%Bank:%BSB:%'
      `);

      let banks = 0, supers = 0, tfns = 0, scrubbed = 0;
      for (const s of submissions) {
        try {
          const empId = s.emp_id;
          if (!empId) continue;

          const bsb = (s.bank_bsb || '').replace(/\s|-/g, '');
          const acct = (s.bank_account_number || '').replace(/\s|-/g, '');
          if (!hasBank.get(empId) && /^\d{6}$/.test(bsb) && /^\d{6,10}$/.test(acct)) {
            insertBank.run(empId, (s.bank_account_name || s.full_name || '').trim(), bsb.slice(-3), acct.slice(-3), encrypt(bsb), encrypt(acct));
            banks++;
          }

          const hasAnySuper = (s.super_fund_name || s.super_usi || s.super_member_number || s.super_fund_abn);
          if (!hasSuper.get(empId) && hasAnySuper) {
            insertSuper.run(empId, (s.super_fund_name || '').trim(), (s.super_usi || '').trim(), (s.super_member_number || '').trim(), (s.super_fund_abn || '').replace(/\s/g, '').trim());
            supers++;
          }

          const tfn = (s.tax_file_number || '').replace(/\D/g, '');
          if (!hasTfn.get(empId) && /^\d{9}$/.test(tfn)) {
            insertTfn.run(empId, encrypt(tfn), tfn.slice(-3));
            tfns++;
          }

          // Scrub plaintext bank leak from internal_notes
          const note = `Auto-created from induction #${s.id}. Payroll details (bank/super/TFN) stored in the encrypted payroll tables — review at /hr/secure-queue.`;
          const result = scrubNotes.run(note, empId);
          if (result.changes) scrubbed++;
        } catch (inner) {
          console.log('[mig 136] skipped submission', s.id, inner.message);
        }
      }
      console.log(`Migration 136: backfilled ${banks} banks, ${supers} supers, ${tfns} TFNs; scrubbed notes on ${scrubbed} employees`);
    } catch (e) {
      console.error('Migration 136 error:', e.message);
    }
    recordMigration.run(136, 'Backfill bank/super/TFN from induction_submissions for already-accepted inductees');
    console.log('Migration 136 applied');
  }

  // Migration 138: clock_events schema repair.
  //
  // Migration 57 created clock_events with a CHECK that only permits
  // event_type in ('clock_in','clock_out'), but every live code path
  // reading the table also writes 'break_start' / 'break_end' — so the
  // Clock feature crashes the moment anyone starts a break.
  //
  // Rebuild the table with the full event_type set. Keep the canonical
  // `event_time` column name (which routes/worker/home.js, manage.js,
  // shifts.js, timesheets.js, services/homeContext.js, and the timesheet
  // form view all already read). A sibling migration/patch switches the
  // three files that were using `timestamp` back to `event_time` so the
  // whole codebase agrees.
  //
  // Carries across every existing row regardless of whether the old table
  // had `event_time` (original shape) or `timestamp` (shape left by an
  // earlier iteration of this migration in development).
  if (!isMigrationApplied.get(138)) {
    try {
      const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='clock_events'").get();
      const hasAllEventTypes = sqlRow && sqlRow.sql.includes("'break_start'");
      const hasEventTimeCol = sqlRow && /\bevent_time\b/.test(sqlRow.sql);
      const needsRebuild = sqlRow && (!hasAllEventTypes || !hasEventTimeCol);
      if (needsRebuild) {
        db.pragma('foreign_keys = OFF');
        db.exec(`
          CREATE TABLE clock_events_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
            allocation_id INTEGER REFERENCES crew_allocations(id),
            event_type TEXT NOT NULL CHECK(event_type IN ('clock_in','clock_out','break_start','break_end')),
            event_time DATETIME NOT NULL DEFAULT (datetime('now')),
            latitude REAL,
            longitude REAL,
            accuracy REAL,
            address TEXT,
            notes TEXT,
            photo_path TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
          );
        `);
        const oldCols = db.prepare("PRAGMA table_info(clock_events)").all().map(c => c.name);
        const tsSelect = oldCols.includes('event_time') ? 'event_time'
                        : oldCols.includes('timestamp') ? 'timestamp'
                        : "datetime('now')";
        db.exec(`
          INSERT INTO clock_events_new (id, crew_member_id, allocation_id, event_type, event_time, latitude, longitude, accuracy, address, notes, photo_path, created_at)
          SELECT id, crew_member_id, allocation_id, event_type, ${tsSelect}, latitude, longitude, accuracy, address, notes, photo_path, created_at
          FROM clock_events;
        `);
        db.exec('DROP TABLE clock_events;');
        db.exec('ALTER TABLE clock_events_new RENAME TO clock_events;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_clock_events_member_ts ON clock_events(crew_member_id, event_time DESC);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_clock_events_allocation ON clock_events(allocation_id);');
        db.pragma('foreign_keys = ON');
        console.log('Migration 138: rebuilt clock_events with expanded event_type CHECK (+ break_start/break_end)');
      } else {
        console.log('Migration 138: clock_events already in target shape, nothing to rebuild');
      }
    } catch (e) {
      console.error('Migration 138 error:', e.message);
    }
    recordMigration.run(138, 'Expand clock_events event_type to include break_start/break_end');
    console.log('Migration 138 applied');
  }

  // Migration 139: Job-pack foundation — extend safety_forms.form_type to cover
  // the five Traffio-equivalent checklists, plus add photo + admin-document tables.
  //
  // Existing safety_forms.form_type CHECK only allows
  // ('prestart','take5','incident','hazard','equipment'). We need to add
  // ('vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle')
  // which means rebuilding the table (SQLite can't ALTER a CHECK).
  //
  // Also add:
  //   - safety_form_photos: many photos per submission (arrow board ×3, setup ×5, etc)
  //   - job_documents: TGS, TMP, ROL day/night, stage plans uploaded by allocators
  if (!isMigrationApplied.get(139)) {
    try {
      const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='safety_forms'").get();
      const hasNewTypes = sqlRow && sqlRow.sql.includes("'vehicle_prestart'");
      if (sqlRow && !hasNewTypes) {
        db.pragma('foreign_keys = OFF');
        db.exec(`
          CREATE TABLE safety_forms_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
            form_type TEXT NOT NULL CHECK(form_type IN (
              'prestart','take5','incident','hazard','equipment',
              'vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle'
            )),
            job_id INTEGER REFERENCES jobs(id),
            allocation_id INTEGER REFERENCES crew_allocations(id),
            data TEXT,
            status TEXT DEFAULT 'submitted' CHECK(status IN ('draft','submitted','reviewed')),
            submitted_at DATETIME DEFAULT (datetime('now')),
            reviewed_by_id INTEGER REFERENCES users(id),
            reviewed_at DATETIME,
            latitude REAL,
            longitude REAL,
            signature_data TEXT,
            signed_name TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
          );
        `);
        const oldCols = db.prepare("PRAGMA table_info(safety_forms)").all().map(c => c.name);
        const has = (c) => oldCols.includes(c) ? c : 'NULL';
        db.exec(`
          INSERT INTO safety_forms_new (id, crew_member_id, form_type, job_id, allocation_id, data, status, submitted_at, reviewed_by_id, reviewed_at, latitude, longitude, signature_data, signed_name, created_at)
          SELECT id, crew_member_id, form_type, job_id, allocation_id, data, status, submitted_at, reviewed_by_id, reviewed_at, latitude, longitude, ${has('signature_data')}, ${has('signed_name')}, created_at
          FROM safety_forms;
        `);
        db.exec('DROP TABLE safety_forms;');
        db.exec('ALTER TABLE safety_forms_new RENAME TO safety_forms;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_safety_forms_crew ON safety_forms(crew_member_id, form_type);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_safety_forms_allocation ON safety_forms(allocation_id, form_type);');
        db.pragma('foreign_keys = ON');
        console.log('Migration 139: rebuilt safety_forms with expanded form_type CHECK + signature columns');
      } else if (!sqlRow) {
        // Fresh DB: the inline CREATE earlier in this file made the table with
        // the OLD CHECK list. Force-rebuild so the CHECK matches the new list.
        // (No data to copy — table absent.)
        console.log('Migration 139: safety_forms missing — earlier migration will create it; nothing to rebuild');
      } else {
        console.log('Migration 139: safety_forms already has expanded form_type CHECK');
      }

      // Photos attached to a safety_form submission (arrow board ×3, setup ×5,
      // worker portrait, fuel gauge, equipment cage, interior, etc).
      // tag identifies which question slot the photo belongs to so the admin PDF
      // can render them under the right heading.
      db.exec(`
        CREATE TABLE IF NOT EXISTS safety_form_photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          safety_form_id INTEGER NOT NULL REFERENCES safety_forms(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          file_path TEXT NOT NULL,
          original_name TEXT,
          mime_type TEXT,
          size_bytes INTEGER DEFAULT 0,
          width INTEGER,
          height INTEGER,
          created_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_safety_form_photos_form ON safety_form_photos(safety_form_id);
      `);

      // Admin-uploaded documents bound to a job (TGS, TMP, ROL day/night, stage
      // plans). Workers see these on the DOCS tab; admins manage uploads.
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          doc_type TEXT NOT NULL DEFAULT 'other' CHECK(doc_type IN (
            'tgs','tmp','rol_day','rol_night','stage_plan','swms','permit','other'
          )),
          title TEXT NOT NULL,
          file_path TEXT NOT NULL,
          original_name TEXT,
          mime_type TEXT,
          size_bytes INTEGER DEFAULT 0,
          uploaded_by_id INTEGER REFERENCES users(id),
          uploaded_at DATETIME DEFAULT (datetime('now')),
          archived_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_job_documents_job ON job_documents(job_id, doc_type);
      `);
    } catch (e) {
      console.error('Migration 139 error:', e.message);
    }
    recordMigration.run(139, 'Job-pack: expand safety_forms form_type + safety_form_photos + job_documents');
    console.log('Migration 139 applied');
  }

  // Migration 140: Docket — explicit "no client on site" path + reason.
  // Traffio's docket UX lets the worker toggle "no client on site" and add a
  // free-text reason instead of capturing a client signature. Today the worker
  // just leaves the client signature blank; admins can't tell whether the
  // client refused / was off-site / wasn't asked. Make it explicit.
  if (!isMigrationApplied.get(140)) {
    const cols = db.prepare("PRAGMA table_info(docket_signatures)").all().map(c => c.name);
    if (!cols.includes('no_client_on_site')) {
      db.exec("ALTER TABLE docket_signatures ADD COLUMN no_client_on_site INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.includes('no_client_reason')) {
      db.exec("ALTER TABLE docket_signatures ADD COLUMN no_client_reason TEXT DEFAULT ''");
    }
    recordMigration.run(140, 'docket_signatures.no_client_on_site + no_client_reason');
    console.log('Migration 140 applied');
  }

  // Migration 141: Pay runs — Traffio CSV import + Cash/TFN/ABN payroll page.
  // Stores one pay_run per week, with one pay_run_line per worker. Hours are
  // bucketed Mon..Sun and split Day/Night based on shift start time. Rates +
  // allowances + BSB/account are snapshotted onto each line so historical
  // runs are immutable even if the employee record changes later.
  if (!isMigrationApplied.get(141)) {
    // Operational BSB + account on employees (separate from secure bank_accounts).
    // The office reads these straight off CommBank to pay workers; the secure
    // table is for HR/super sync. Two different audiences, two different fields.
    try { db.exec("ALTER TABLE employees ADD COLUMN payroll_bsb TEXT DEFAULT ''"); } catch (e) { /* exists */ }
    try { db.exec("ALTER TABLE employees ADD COLUMN payroll_account TEXT DEFAULT ''"); } catch (e) { /* exists */ }

    db.exec(`
      CREATE TABLE IF NOT EXISTS pay_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        label TEXT DEFAULT '',
        csv_filename TEXT DEFAULT '',
        csv_uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized')),
        created_by_id INTEGER REFERENCES users(id),
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pay_runs_period ON pay_runs(period_start);

      CREATE TABLE IF NOT EXISTS pay_run_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pay_run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
        employee_id INTEGER REFERENCES employees(id),
        person_id TEXT DEFAULT '',
        full_name TEXT NOT NULL,
        payment_type TEXT DEFAULT '',
        bsb TEXT DEFAULT '',
        acc_number TEXT DEFAULT '',
        day_hours_json TEXT DEFAULT '[0,0,0,0,0,0,0]',
        night_hours_json TEXT DEFAULT '[0,0,0,0,0,0,0]',
        total_day_hours REAL DEFAULT 0,
        total_night_hours REAL DEFAULT 0,
        total_hours REAL DEFAULT 0,
        rate_day REAL DEFAULT 0,
        rate_night REAL DEFAULT 0,
        total_day_wages REAL DEFAULT 0,
        total_night_wages REAL DEFAULT 0,
        total_wages REAL DEFAULT 0,
        travel_allowance REAL DEFAULT 0,
        meal_allowance REAL DEFAULT 0,
        other_allowance REAL DEFAULT 0,
        total_allowance REAL DEFAULT 0,
        grand_total REAL DEFAULT 0,
        paid INTEGER DEFAULT 0,
        paid_ref TEXT DEFAULT '',
        paid_at DATETIME,
        notes TEXT DEFAULT '',
        shifts_json TEXT DEFAULT '[]',
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pay_run_lines_run ON pay_run_lines(pay_run_id);
      CREATE INDEX IF NOT EXISTS idx_pay_run_lines_employee ON pay_run_lines(employee_id);
      CREATE INDEX IF NOT EXISTS idx_pay_run_lines_payment_type ON pay_run_lines(payment_type);
    `);

    recordMigration.run(141, 'Pay runs + pay run lines + payroll BSB/account on employees');
    console.log('Migration 141 applied: payroll schema');
  }

  // Migration 142: Make crew_allocations.job_id nullable.
  //
  // Bookings can exist without a job_id (ad-hoc shifts). Workers on those
  // bookings should still get the full Job-Pack flow — checklists, docket,
  // documents — which all hang off a crew_allocations row. The existing
  // NOT NULL on job_id forced us to refuse to lazy-create allocations for
  // job-less bookings, which surfaced as "checklists will unlock once your
  // allocator links it" in the worker portal. Drop the constraint.
  //
  // SQLite can't ALTER COLUMN to drop NOT NULL — rebuild the table.
  if (!isMigrationApplied.get(142)) {
    try {
      const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='crew_allocations'").get();
      const alreadyNullable = sqlRow && /job_id INTEGER REFERENCES jobs\(id\) ON DELETE/i.test(sqlRow.sql) && !/job_id INTEGER NOT NULL/i.test(sqlRow.sql);
      if (sqlRow && !alreadyNullable) {
        db.pragma('foreign_keys = OFF');
        db.exec(`
          CREATE TABLE crew_allocations_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
            crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
            allocation_date DATE NOT NULL,
            start_time TEXT DEFAULT '06:00',
            end_time TEXT DEFAULT '14:30',
            shift_type TEXT NOT NULL DEFAULT 'day' CHECK(shift_type IN ('day','night','split')),
            role_on_site TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'allocated' CHECK(status IN ('allocated','confirmed','declined','completed','cancelled')),
            notes TEXT DEFAULT '',
            allocated_by_id INTEGER REFERENCES users(id),
            confirmed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL
          );
        `);
        // Copy every existing row across. The booking_id column is from
        // an earlier migration; guard against legacy DBs that never
        // picked it up.
        const oldCols = db.prepare("PRAGMA table_info(crew_allocations)").all().map(c => c.name);
        const has = (c) => oldCols.includes(c) ? c : 'NULL';
        db.exec(`
          INSERT INTO crew_allocations_new
            (id, job_id, crew_member_id, allocation_date, start_time, end_time,
             shift_type, role_on_site, status, notes, allocated_by_id, confirmed_at,
             created_at, booking_id)
          SELECT id, job_id, crew_member_id, allocation_date, start_time, end_time,
                 shift_type, role_on_site, status, notes, allocated_by_id, confirmed_at,
                 created_at, ${has('booking_id')}
          FROM crew_allocations;
        `);
        db.exec('DROP TABLE crew_allocations;');
        db.exec('ALTER TABLE crew_allocations_new RENAME TO crew_allocations;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_crew_alloc_date ON crew_allocations(allocation_date);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_crew_alloc_job ON crew_allocations(job_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_crew_alloc_crew ON crew_allocations(crew_member_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_crew_alloc_status ON crew_allocations(status);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_crew_alloc_booking ON crew_allocations(booking_id);');
        db.pragma('foreign_keys = ON');
        console.log('Migration 142: crew_allocations.job_id is now nullable');
      } else {
        console.log('Migration 142: crew_allocations.job_id already nullable, nothing to rebuild');
      }
    } catch (e) {
      console.error('Migration 142 error:', e.message);
    }
    recordMigration.run(142, 'crew_allocations.job_id nullable for job-less bookings');
    console.log('Migration 142 applied');
  }

  // Migration 143: Award-rate phase for payroll —
  //   • employees gain rate_public_holiday + rate_fares_daily + award_classification_id
  //   • new public_holidays table (NSW dates seed below)
  //   • new award_classifications table (Fair Work classification rates,
  //     effective-dated so historical pay runs stay locked)
  //   • pay_run_lines gains buckets_json holding all 8 hour buckets
  //     (day_normal/day_ot/day_dt, night_normal/night_ot/night_dt,
  //      weekend, public_holiday). Backfills existing rows from the old
  //      day_hours_json + night_hours_json pair.
  if (!isMigrationApplied.get(143)) {
    try { db.exec("ALTER TABLE employees ADD COLUMN rate_public_holiday REAL DEFAULT 0"); } catch (e) {}
    try { db.exec("ALTER TABLE employees ADD COLUMN rate_fares_daily REAL DEFAULT 0"); } catch (e) {}
    try { db.exec("ALTER TABLE employees ADD COLUMN award_classification_id INTEGER REFERENCES award_classifications(id) ON DELETE SET NULL"); } catch (e) {}

    db.exec(`
      CREATE TABLE IF NOT EXISTS public_holidays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL UNIQUE,
        label TEXT NOT NULL,
        jurisdiction TEXT NOT NULL DEFAULT 'NSW',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_public_holidays_date ON public_holidays(date);

      CREATE TABLE IF NOT EXISTS award_classifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        award_name TEXT NOT NULL DEFAULT '',
        classification TEXT NOT NULL,
        effective_from DATE NOT NULL DEFAULT '2024-07-01',
        effective_to DATE,
        rate_day REAL DEFAULT 0,
        rate_day_ot REAL DEFAULT 0,
        rate_day_dt REAL DEFAULT 0,
        rate_night REAL DEFAULT 0,
        rate_night_ot REAL DEFAULT 0,
        rate_night_dt REAL DEFAULT 0,
        rate_weekend REAL DEFAULT 0,
        rate_public_holiday REAL DEFAULT 0,
        rate_meal REAL DEFAULT 0,
        rate_fares_daily REAL DEFAULT 0,
        notes TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_award_class_active ON award_classifications(active);
      CREATE INDEX IF NOT EXISTS idx_award_class_effective ON award_classifications(effective_from);
    `);

    // pay_run_lines.buckets_json — initialise to an empty 8-bucket shape
    try {
      db.exec("ALTER TABLE pay_run_lines ADD COLUMN buckets_json TEXT DEFAULT ''");
    } catch (e) { /* column exists */ }

    // Backfill: convert the legacy day_hours_json + night_hours_json pair into
    // the new buckets_json shape. day_hours → day_normal, night_hours → night_normal.
    try {
      const empty = (rate) => ({ hours: [0, 0, 0, 0, 0, 0, 0], total_hours: 0, rate: rate || 0, total_wages: 0 });
      const parse = (s, fb) => { try { const v = JSON.parse(s); return Array.isArray(v) && v.length === 7 ? v : fb; } catch (e) { return fb; } };
      const legacy = db.prepare("SELECT id, day_hours_json, night_hours_json, total_day_hours, total_night_hours, total_day_wages, total_night_wages, rate_day, rate_night FROM pay_run_lines WHERE COALESCE(buckets_json, '') = ''").all();
      const update = db.prepare("UPDATE pay_run_lines SET buckets_json = ? WHERE id = ?");
      let n = 0;
      for (const row of legacy) {
        const day = parse(row.day_hours_json, [0, 0, 0, 0, 0, 0, 0]);
        const night = parse(row.night_hours_json, [0, 0, 0, 0, 0, 0, 0]);
        const buckets = {
          day_normal:    { hours: day,                          total_hours: row.total_day_hours || 0,   rate: row.rate_day || 0,   total_wages: row.total_day_wages || 0 },
          day_ot:        empty(0),
          day_dt:        empty(0),
          night_normal:  { hours: night,                        total_hours: row.total_night_hours || 0, rate: row.rate_night || 0, total_wages: row.total_night_wages || 0 },
          night_ot:      empty(0),
          night_dt:      empty(0),
          weekend:       empty(0),
          public_holiday: empty(0),
        };
        update.run(JSON.stringify(buckets), row.id);
        n++;
      }
      if (n) console.log(`Migration 143: backfilled buckets_json on ${n} pay_run_lines`);
    } catch (e) { console.error('Migration 143 backfill error:', e.message); }

    // Seed NSW public holidays for 2025–2027 (close to operational use). Idempotent.
    const seed = db.prepare("INSERT OR IGNORE INTO public_holidays (date, label, jurisdiction) VALUES (?, ?, 'NSW')");
    [
      // 2025
      ['2025-01-01', "New Year's Day"],
      ['2025-01-27', 'Australia Day (observed)'],
      ['2025-04-18', 'Good Friday'],
      ['2025-04-19', 'Easter Saturday'],
      ['2025-04-20', 'Easter Sunday'],
      ['2025-04-21', 'Easter Monday'],
      ['2025-04-25', 'ANZAC Day'],
      ['2025-06-09', "King's Birthday"],
      ['2025-10-06', 'Labour Day'],
      ['2025-12-25', 'Christmas Day'],
      ['2025-12-26', 'Boxing Day'],
      // 2026
      ['2026-01-01', "New Year's Day"],
      ['2026-01-26', 'Australia Day'],
      ['2026-04-03', 'Good Friday'],
      ['2026-04-04', 'Easter Saturday'],
      ['2026-04-05', 'Easter Sunday'],
      ['2026-04-06', 'Easter Monday'],
      ['2026-04-25', 'ANZAC Day'],
      ['2026-06-08', "King's Birthday"],
      ['2026-10-05', 'Labour Day'],
      ['2026-12-25', 'Christmas Day'],
      ['2026-12-26', 'Boxing Day'],
      ['2026-12-28', 'Boxing Day (observed)'],
      // 2027
      ['2027-01-01', "New Year's Day"],
      ['2027-01-26', 'Australia Day'],
      ['2027-03-26', 'Good Friday'],
      ['2027-03-27', 'Easter Saturday'],
      ['2027-03-28', 'Easter Sunday'],
      ['2027-03-29', 'Easter Monday'],
      ['2027-04-25', 'ANZAC Day'],
      ['2027-04-26', 'ANZAC Day (observed)'],
      ['2027-06-14', "King's Birthday"],
      ['2027-10-04', 'Labour Day'],
      ['2027-12-25', 'Christmas Day'],
      ['2027-12-27', 'Christmas Day (observed)'],
      ['2027-12-28', 'Boxing Day (observed)'],
    ].forEach(([d, l]) => { try { seed.run(d, l); } catch (e) {} });

    recordMigration.run(143, 'Award-rate payroll phase: PH + classifications + buckets_json + NSW PH seed');
    console.log('Migration 143 applied: award-rate payroll schema + NSW public holidays seeded');
  }

  // Migration 144: portal_role on crew_members — hierarchical role for the
  // worker portal. Three tiers, each inheriting the powers below it:
  //
  //   traffic_controller   (TC)  — baseline. Can fill TC Prestart, Risk
  //                                Assessment, Vehicle Pre-Start, sign
  //                                their own docket, etc.
  //   team_leader          (TL)  — TC + can fill the Team Leader
  //                                Checklist + audit other TCs on the
  //                                same shift.
  //   supervisor           (S)   — TL + see / sign off other workers'
  //                                checklists, manage shifts as a
  //                                stand-in office user.
  //
  // We keep the legacy crew_members.role column (job descriptor, used for
  // payroll + scheduling) untouched. portal_role is a separate concept.
  if (!isMigrationApplied.get(144)) {
    const cols = db.prepare("PRAGMA table_info(crew_members)").all().map(c => c.name);
    if (!cols.includes('portal_role')) {
      db.exec(`
        ALTER TABLE crew_members ADD COLUMN portal_role TEXT NOT NULL
          DEFAULT 'traffic_controller'
          CHECK(portal_role IN ('traffic_controller','team_leader','supervisor'));
      `);
    }
    // Backfill: anyone already flagged is_manager bumps to team_leader by
    // default. The legacy descriptor role='supervisor' bumps straight to
    // supervisor. Office can promote / demote individuals from the crew
    // profile screen afterwards.
    try {
      const n1 = db.prepare("UPDATE crew_members SET portal_role = 'team_leader' WHERE is_manager = 1 AND portal_role = 'traffic_controller'").run().changes;
      const n2 = db.prepare("UPDATE crew_members SET portal_role = 'supervisor'  WHERE role = 'supervisor' AND portal_role != 'supervisor'").run().changes;
      if (n1) console.log(`Migration 144: backfilled ${n1} crew_members → team_leader (was is_manager)`);
      if (n2) console.log(`Migration 144: backfilled ${n2} crew_members → supervisor (was role='supervisor')`);
    } catch (e) { console.error('Migration 144 backfill error:', e.message); }
    recordMigration.run(144, 'crew_members.portal_role hierarchy (TC / TL / Supervisor)');
    console.log('Migration 144 applied');
  }

  // Migration 145: shift_tasks — per-shift to-do list assigned to crew.
  // Allocators (and TLs / supervisors on the worker portal) can attach
  // tasks to a specific allocation; the assigned worker sees them on
  // their shift detail Tasks section, TLs+Supervisors see every task on
  // every crew member of the same shift.
  if (!isMigrationApplied.get(145)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shift_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_id INTEGER REFERENCES crew_allocations(id) ON DELETE CASCADE,
        booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','cancelled')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
        due_at DATETIME,
        completed_at DATETIME,
        created_by_user_id INTEGER REFERENCES users(id),
        created_by_crew_id INTEGER REFERENCES crew_members(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_shift_tasks_alloc   ON shift_tasks(allocation_id);
      CREATE INDEX IF NOT EXISTS idx_shift_tasks_booking ON shift_tasks(booking_id);
      CREATE INDEX IF NOT EXISTS idx_shift_tasks_crew    ON shift_tasks(crew_member_id, status);
    `);
    recordMigration.run(145, 'shift_tasks: per-shift to-do list assigned to crew');
    console.log('Migration 145 applied');
  }

  // Migration 146: booking_vehicles.crew_member_id — nominate the driver
  // for each vehicle on a booking. The office wants every vehicle on the
  // shift assignable to a specific worker so checklists / fuel cards /
  // accountability tie back to a person. Nullable: a vehicle can sit
  // unassigned until the allocator picks the driver.
  if (!isMigrationApplied.get(146)) {
    const cols = db.prepare("PRAGMA table_info(booking_vehicles)").all().map(c => c.name);
    if (!cols.includes('crew_member_id')) {
      db.exec("ALTER TABLE booking_vehicles ADD COLUMN crew_member_id INTEGER REFERENCES crew_members(id)");
    }
    if (!cols.includes('vehicle_role')) {
      // Free-text label for the vehicle's role on the shift (e.g. "ute",
      // "VMS ute", "TMA"). Defaults to empty so existing rows aren't
      // touched.
      db.exec("ALTER TABLE booking_vehicles ADD COLUMN vehicle_role TEXT DEFAULT ''");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_booking_vehicles_driver ON booking_vehicles(crew_member_id)");
    recordMigration.run(146, 'booking_vehicles.crew_member_id + vehicle_role');
    console.log('Migration 146 applied');
  }

  // Migration 147: Compliance invoice workflow — track who invoiced each item
  // and when. The `invoiced` flag and `invoice_number` already exist (from
  // earlier migrations) but there was no audit trail for when accounts marked
  // it. Adds invoiced_at + invoiced_by_id so the Plans & Approvals page can
  // show a proper "Invoiced 4 May 2026 by Jane" line.
  if (!isMigrationApplied.get(147)) {
    const cols = db.prepare("PRAGMA table_info(compliance)").all().map(c => c.name);
    if (!cols.includes('invoiced_at')) {
      try { db.exec("ALTER TABLE compliance ADD COLUMN invoiced_at DATETIME"); } catch (e) {}
    }
    if (!cols.includes('invoiced_by_id')) {
      try { db.exec("ALTER TABLE compliance ADD COLUMN invoiced_by_id INTEGER REFERENCES users(id)"); } catch (e) {}
    }
    // Backfill: any row already marked invoiced gets updated_at as the stamp
    try { db.exec("UPDATE compliance SET invoiced_at = updated_at WHERE invoiced = 1 AND invoiced_at IS NULL"); } catch (e) {}
    recordMigration.run(147, 'compliance: invoiced_at + invoiced_by_id audit columns');
    console.log('Migration 147 applied: compliance invoice audit columns');
  }

  // Migration 148: Worker push subscriptions + shift reminder log
  // Workers don't have a `users` row, so the existing push_subscriptions
  // (FK -> users) table can't hold their subscriptions. Add a parallel
  // table keyed on crew_member_id and a small log table so the shift
  // reminder scanner can dedupe (only push once per shift, even though
  // the scanner runs every 15 min).
  if (!isMigrationApplied.get(148)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worker_push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_worker_push_crew ON worker_push_subscriptions(crew_member_id)');
      db.exec(`
        CREATE TABLE IF NOT EXISTS shift_reminder_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crew_member_id INTEGER NOT NULL,
          shift_key TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT '24h',
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(crew_member_id, shift_key, kind)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_shift_reminder_crew ON shift_reminder_log(crew_member_id, sent_at)');
      recordMigration.run(148, 'worker_push_subscriptions + shift_reminder_log');
      console.log('Migration 148 applied: worker push + shift reminder dedupe');
    } catch (e) {
      console.error('Migration 148 error:', e.message);
    }
  }

  // =============================================
  // Migration 149: vehicle columns on equipment + seed T&S fleet
  // =============================================
  // Equipment table previously only stored asset_number/name/category. Vehicles
  // need licence plate, make/model, VIN, engine, odometer, licence expiry,
  // depot, billed-as classification, and an optional default driver. Add the
  // columns idempotently then seed the 11 T&S vehicles from Traffio so the
  // ute fleet is in the system without manual data entry.
  if (!isMigrationApplied.get(149)) {
    try {
      const cols = db.prepare("PRAGMA table_info(equipment)").all().map(c => c.name);
      const addCol = (name, ddl) => { if (!cols.includes(name)) try { db.exec(`ALTER TABLE equipment ADD COLUMN ${ddl}`); } catch (e) {} };
      addCol('licence_plate',     'licence_plate TEXT DEFAULT \'\'');
      addCol('licence_class',     'licence_class TEXT DEFAULT \'\'');
      addCol('licence_expiry',    'licence_expiry DATE');
      addCol('vehicle_category',  'vehicle_category TEXT DEFAULT \'\''); // Pod Truck / Ute / TMA / VMS Ute
      addCol('vehicle_make',      'vehicle_make TEXT DEFAULT \'\'');
      addCol('vehicle_model',     'vehicle_model TEXT DEFAULT \'\'');
      addCol('vin',               'vin TEXT DEFAULT \'\'');
      addCol('engine_number',     'engine_number TEXT DEFAULT \'\'');
      addCol('odometer_km',       'odometer_km INTEGER');
      addCol('odometer_read_at',  'odometer_read_at DATE');
      addCol('billed_as',         'billed_as TEXT DEFAULT \'\'');
      addCol('depot',             'depot TEXT DEFAULT \'\'');
      addCol('default_driver_id', 'default_driver_id INTEGER REFERENCES crew_members(id) ON DELETE SET NULL');
      db.exec("CREATE INDEX IF NOT EXISTS idx_equipment_licence_plate ON equipment(licence_plate)");

      // Vehicle columns above are generic and apply to any tenant. The fleet
      // seed below is T&S-specific (real plates, VINs, depot, driver names)
      // and is gated by SEED_T_AND_S_DATA so new deployments get the schema
      // but not the T&S fleet rows.
      let inserted = 0, updated = 0;
      if (!SEED_T_AND_S_DATA) {
        console.log('Migration 149: equipment vehicle schema applied; skipped T&S fleet seed (set SEED_T_AND_S_DATA=true)');
      } else {
      // Seed the T&S fleet. Asset numbers are the canonical "Name" column from
      // Traffio; ON CONFLICT(asset_number) DO UPDATE keeps fields fresh on
      // re-deploy without duplicating rows. ODO + licence dates are taken from
      // the snapshot the user pasted on 4 May 2026.
      const fleet = [
        { asset:'DDV002',  plate:'CF94HW',  cls:'LR',  cat:'Pod Truck', make:'',       model:'',       vin:'',                engine:'',          odo:null,    odoAt:null,         lexp:null,         billed:'Pod Truck', depot:'Villawood', driver:null },
        { asset:'DDV001',  plate:'CG56MC',  cls:'LR',  cat:'Pod Truck', make:'Isuzu',  model:'NPR400', vin:'JAANPR75HF7106878',engine:'4HK1444392',odo:245082,  odoAt:'2026-02-18', lexp:'2027-02-22', billed:'Pod Truck', depot:'Villawood', driver:null },
        { asset:'PTM001',  plate:'DH90AD',  cls:'',    cat:'Ute',       make:'',       model:'',       vin:'',                engine:'',          odo:79835,   odoAt:'2026-04-24', lexp:null,         billed:'Ute',       depot:'Villawood', driver:null },
        { asset:'TSTC003', plate:'ERU83U',  cls:'C',   cat:'Ute',       make:'Toyota', model:'Hilux',  vin:'MR0CX3CB304328000',engine:'',          odo:288430,  odoAt:'2026-03-13', lexp:'2027-02-10', billed:'Ute',       depot:'Villawood', driver:null },
        { asset:'TCTC001', plate:'ETR82VC', cls:'C',   cat:'Ute',       make:'Toyota', model:'Hilux',  vin:'MR0CX3CBX04332688',engine:'',          odo:56770,   odoAt:'2026-03-20', lexp:'2026-06-19', billed:'Ute',       depot:'Villawood', driver:null },
        { asset:'TSTC005', plate:'EUT88J',  cls:'C',   cat:'Ute',       make:'Toyota', model:'Hilux',  vin:'MR0CX3CB804336092',engine:'',          odo:135538,  odoAt:'2026-02-17', lexp:'2026-08-25', billed:'Ute',       depot:'Villawood', driver:null },
        { asset:'TSTC006', plate:'EUT88K',  cls:'C',   cat:'Ute',       make:'Toyota', model:'Hilux',  vin:'MR0CX3CB504336082',engine:'',          odo:598837,  odoAt:'2026-02-12', lexp:'2026-08-25', billed:'Ute',       depot:'Villawood', driver:'Syed Ali' },
        { asset:'TSTC004', plate:'FMG67Z',  cls:'C',   cat:'Ute',       make:'Toyota', model:'Hilux',  vin:'MR0EX3CB501103684',engine:'',          odo:139137,  odoAt:'2026-05-01', lexp:'2027-02-22', billed:'Ute',       depot:'Villawood', driver:null },
        { asset:'TMA',     plate:'',        cls:'',    cat:'TMA',       make:'',       model:'',       vin:'',                engine:'',          odo:null,    odoAt:null,         lexp:null,         billed:'TMA',       depot:'T&S HQ',    driver:null },
        { asset:'TSTC002', plate:'YLS85F',  cls:'C',   cat:'Ute',       make:'Toyota', model:'Hilux',  vin:'MR0CX3CB204334676',engine:'',          odo:74454,   odoAt:'2026-04-28', lexp:'2026-07-14', billed:'Ute',       depot:'Villawood', driver:null },
        { asset:'TSTC007', plate:'YOV37G',  cls:'C',   cat:'Ute',       make:'Isuzu',  model:'D-Max',  vin:'MPATFR40JPT002189',engine:'',          odo:49000,   odoAt:'2026-03-13', lexp:'2026-07-02', billed:'VMS Ute',   depot:'Villawood', driver:null },
      ];

      const upsert = db.prepare(`
        INSERT INTO equipment (
          asset_number, name, category,
          licence_plate, licence_class, licence_expiry,
          vehicle_category, vehicle_make, vehicle_model, vin, engine_number,
          odometer_km, odometer_read_at, billed_as, depot,
          default_driver_id, current_condition, active, created_at, updated_at
        )
        VALUES (?, ?, 'vehicle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'good', 1, datetime('now'), datetime('now'))
        ON CONFLICT(asset_number) DO UPDATE SET
          licence_plate    = excluded.licence_plate,
          licence_class    = excluded.licence_class,
          licence_expiry   = excluded.licence_expiry,
          vehicle_category = excluded.vehicle_category,
          vehicle_make     = excluded.vehicle_make,
          vehicle_model    = excluded.vehicle_model,
          vin              = excluded.vin,
          engine_number    = excluded.engine_number,
          odometer_km      = excluded.odometer_km,
          odometer_read_at = excluded.odometer_read_at,
          billed_as        = excluded.billed_as,
          depot            = excluded.depot,
          default_driver_id= excluded.default_driver_id,
          updated_at       = datetime('now')
      `);

      // Resolve driver names → crew_members.id (best effort — if the name
      // doesn't match, leave default_driver_id null).
      function resolveDriver(name) {
        if (!name) return null;
        try {
          const r = db.prepare("SELECT id FROM crew_members WHERE LOWER(full_name) = LOWER(?) LIMIT 1").get(name);
          return r ? r.id : null;
        } catch (e) { return null; }
      }

      for (const v of fleet) {
        const exists = db.prepare("SELECT id FROM equipment WHERE asset_number = ?").get(v.asset);
        upsert.run(
          v.asset,
          [v.cat, v.asset, v.plate].filter(Boolean).join(' · ') || v.asset,
          v.plate, v.cls, v.lexp,
          v.cat, v.make, v.model, v.vin, v.engine,
          v.odo, v.odoAt, v.billed, v.depot,
          resolveDriver(v.driver)
        );
        if (exists) updated++; else inserted++;
      }
      } // end else (SEED_T_AND_S_DATA — fleet seed)

      recordMigration.run(149, 'equipment vehicle columns + T&S fleet seed');
      console.log(`Migration 149 applied: equipment vehicle columns + seed (${inserted} new, ${updated} updated)`);
    } catch (e) {
      console.error('Migration 149 error:', e.message);
    }
  }

  // =============================================
  // Migration 150: Custom checklists — admin-authored forms that show
  // up on the worker portal, with versioned revisions so an admin can
  // tweak a template without breaking submissions filed against an
  // earlier revision.
  // =============================================
  if (!isMigrationApplied.get(150)) {
    try {
      const ctCols = db.prepare("PRAGMA table_info(checklist_templates)").all().map(c => c.name);
      const addCt = (name, ddl) => { if (!ctCols.includes(name)) try { db.exec(`ALTER TABLE checklist_templates ADD COLUMN ${ddl}`); } catch (e) {} };
      addCt('worker_visible',     "worker_visible INTEGER NOT NULL DEFAULT 0");
      addCt('require_signature',  "require_signature INTEGER NOT NULL DEFAULT 0");
      addCt('require_photo',      "require_photo INTEGER NOT NULL DEFAULT 0");
      addCt('published_revision', "published_revision INTEGER DEFAULT 0");
      addCt('published_at',       "published_at DATETIME");
      addCt('published_by_id',    "published_by_id INTEGER REFERENCES users(id)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS checklist_template_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
          revision_number INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          require_signature INTEGER NOT NULL DEFAULT 0,
          require_photo INTEGER NOT NULL DEFAULT 0,
          items_json TEXT NOT NULL,
          published_by_id INTEGER REFERENCES users(id),
          published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(template_id, revision_number)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_ctr_template ON checklist_template_revisions(template_id, revision_number DESC)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS custom_checklist_responses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
          revision_number INTEGER NOT NULL,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          allocation_id INTEGER REFERENCES crew_allocations(id) ON DELETE SET NULL,
          booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
          answers_json TEXT NOT NULL DEFAULT '{}',
          signature_data TEXT,
          submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_ccr_template ON custom_checklist_responses(template_id, submitted_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_ccr_crew ON custom_checklist_responses(crew_member_id, submitted_at DESC)");

      recordMigration.run(150, 'custom checklists: worker_visible + revisions + responses');
      console.log('Migration 150 applied: custom checklists schema');
    } catch (e) {
      console.error('Migration 150 error:', e.message);
    }
  }

  // =============================================
  // Migration 151: Promote the 5 hard-coded Job-Pack checklists into
  // editable system templates so admins can revise + publish new
  // versions from /checklists, and the worker portal renders the
  // latest published revision's questions instead of a hardcoded JS
  // array. system_key is the stable handle the worker routes use to
  // look up "the Vehicle Pre-Start template" regardless of name
  // changes; options_json + item_key on checklist_template_items hold
  // the extra fields some forms need (radio/checkbox options, the
  // POST input key like `item_jack_wrench`).
  // =============================================
  if (!isMigrationApplied.get(151)) {
    try {
      // Schema additions
      const ctCols2 = db.prepare("PRAGMA table_info(checklist_templates)").all().map(c => c.name);
      if (!ctCols2.includes('system_key')) try { db.exec("ALTER TABLE checklist_templates ADD COLUMN system_key TEXT"); } catch (e) {}
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_system_key ON checklist_templates(system_key) WHERE system_key IS NOT NULL");
      const ctiCols = db.prepare("PRAGMA table_info(checklist_template_items)").all().map(c => c.name);
      if (!ctiCols.includes('item_key'))   try { db.exec("ALTER TABLE checklist_template_items ADD COLUMN item_key TEXT"); }   catch (e) {}
      if (!ctiCols.includes('options_json'))try { db.exec("ALTER TABLE checklist_template_items ADD COLUMN options_json TEXT"); }catch (e) {}

      // Seed each system template if not present.
      const systemTemplates = [
        {
          system_key: 'vehicle_prestart',
          name: 'Vehicle Pre-Start',
          description: 'Pre-shift inspection of the assigned vehicle. 22 OK / Not OK / N/A items. Failed items must be reported to a supervisor.',
          require_signature: 1,
          items: [
            'jack_wrench:Jack and Wrench','steering:Steering','horn:Horn','vehicle_damage:Vehicle Damage',
            'spare_wheel:Spare Wheel','windshield:Windshield','brakes:Brakes','headlights:Headlights',
            'tail_lights:Tail Lights','mirrors:Mirrors','seatbelts:Seatbelts','tyre_wear:Tyre Wear',
            'arrow_board:Arrow Board','vms_board:VMS Board','beacons_front:Flashing Beacons (Front)',
            'beacons_rear:Flashing Beacons (Rear)','fluid_leaks:Fluid Leaks','reverse_squawker:Reverse Squawker',
            'fire_extinguisher:Fire Extinguisher','first_aid_kit:Fully Stocked First Aid Kit',
            'cabin_clean:Cabin/Tray Free From Litter/Rubbish','load_restraint:Load Restraint',
          ].map(s => { const [k, l] = s.split(':'); return { item_key: k, question: l, response_type: 'ok_notok_na', section: 'Inspection', required: 1 }; }),
        },
        {
          system_key: 'risk_toolbox',
          name: 'Risk Assessment & Toolbox',
          description: 'On-site toolbox / risk assessment run with the crew before work commences.',
          require_signature: 1,
          items: [
            { item_key: 'struck_by_traffic_controls', question: 'Controls for being struck by traffic', response_type: 'checkbox',
              options: ['Buffer Vehicle','Clear visibility of control points','Clear visibility of signs','Escape Routes','Not turning back to traffic','Remain outside live traffic lanes'], required: 1 },
            { item_key: 'exclusion_zone_items', question: 'Items / machinery needing exclusion zones', response_type: 'checkbox',
              options: ['Open excavation, pits and manholes','Overhead Crane or EWP','Mobile Plant','None Identified'], required: 0 },
            { item_key: 'exclusion_zone_controls', question: 'Controls for exclusion zones', response_type: 'checkbox',
              options: ['Client mandated exclusion zone','Delineation (cones/Tiger Tails/Bollards/Tape)','Protected pedestrian corridors','Visible contact / confirmation with Plant operators'], required: 0 },
            { item_key: 'pedestrian_controls', question: 'Controls for pedestrians being struck by traffic', response_type: 'checkbox',
              options: ['Delineation (cones/tiger tails/bollards/tape)','Escort','Signs','Pedestrian corridor','None - no pedestrians on site'], required: 0 },
            { item_key: 'slip_trip_controls', question: 'Controls for slips, trips and falls', response_type: 'checkbox',
              options: ['Boot Safety - Laces tied and zips pulled up',"Don't rush tasks",'Isolate hazardous area','Cones around manholes/trip hazards'], required: 0 },
            { item_key: 'weather_conditions', question: 'Adverse weather conditions', response_type: 'checkbox',
              options: ['N/A - No adverse weather','Heat','Cold','Rain','Strong Wind','Reduced Visibility / Fog','Storm / Lightning'], required: 0 },
            { item_key: 'manual_handling_controls', question: 'Controls for manual handling', response_type: 'checkbox',
              options: ['N/A - Not stopping traffic','Two-person lifts','Use of trolley/dolly','Lifting techniques','PPE'], required: 0 },
            { item_key: 'queue_management', question: 'How are end-of-queue lengths being managed?', response_type: 'checkbox',
              options: ['N/A - Not stopping traffic','VMS / Arrow Board','Tail-end controller','Queue protection vehicle','Police support'], required: 0 },
            { item_key: 'other_hazards', question: 'Other hazards identified', response_type: 'textarea', required: 0 },
            { item_key: 'safe_to_proceed', question: 'With the selected controls in place, can the job be conducted safely?', response_type: 'radio',
              options: ['Yes','No - work must not commence'], required: 1 },
            { item_key: 'communicated_items', question: 'Items communicated to all staff in the toolbox', response_type: 'checkbox',
              options: ['Breaks','Client Requirements','Emergency Procedures','Exclusion Zones','Golden Rules of Safety','Sequencing','Site Set Up and Pack Up'], required: 0 },
          ],
        },
        {
          system_key: 'tc_prestart',
          name: 'TC Prestart Declaration',
          description: 'Per-Traffic-Controller declaration filed before commencing controlled traffic work.',
          require_signature: 1,
          items: [
            { item_key: 'inducted',           question: 'I have been inducted onto site for this job',                                response_type: 'yes_no_na', required: 1, section: 'Declaration' },
            { item_key: 'reviewed_swms',      question: 'I have reviewed the SWMS for this job',                                     response_type: 'yes_no_na', required: 1, section: 'Declaration' },
            { item_key: 'reviewed_tcp',       question: 'I have reviewed the TCP / TGS for this job',                                response_type: 'yes_no_na', required: 1, section: 'Declaration' },
            { item_key: 'fit_for_work',       question: 'I am physically and mentally fit for work',                                 response_type: 'yes_no_na', required: 1, section: 'Declaration' },
            { item_key: 'free_of_substances', question: 'I am free of drugs, alcohol and impairing substances',                       response_type: 'yes_no_na', required: 1, section: 'Declaration' },
            { item_key: 'tickets_current',    question: 'My tickets and certifications are current',                                  response_type: 'yes_no_na', required: 1, section: 'Declaration' },
            { item_key: 'ppe_compliant',      question: 'My PPE is compliant and in good condition',                                  response_type: 'yes_no_na', required: 1, section: 'Declaration' },
          ],
        },
        {
          system_key: 'team_leader',
          name: 'Team Leader Checklist',
          description: 'Crew lead / acting TL checklist — includes per-worker PPE check.',
          require_signature: 1,
          items: [
            { item_key: 'site_briefing',      question: 'Site briefing delivered to all crew',                       response_type: 'yes_no_na', required: 1, section: 'Briefing' },
            { item_key: 'tcp_displayed',      question: 'TCP/TGS available and displayed on site',                   response_type: 'yes_no_na', required: 1, section: 'Briefing' },
            { item_key: 'emergency_plan',     question: 'Emergency procedures discussed (escape routes, contacts)',   response_type: 'yes_no_na', required: 1, section: 'Briefing' },
            { item_key: 'hi_vis',             question: 'Hi-Vis vest / shirt',                                        response_type: 'yes_no_na', required: 1, section: 'PPE Check' },
            { item_key: 'safety_boots',       question: 'Safety boots',                                               response_type: 'yes_no_na', required: 1, section: 'PPE Check' },
            { item_key: 'hard_hat',           question: 'Hard hat',                                                   response_type: 'yes_no_na', required: 1, section: 'PPE Check' },
            { item_key: 'eye_protection',     question: 'Eye protection',                                             response_type: 'yes_no_na', required: 1, section: 'PPE Check' },
            { item_key: 'sun_protection',     question: 'Sun protection (hat, sunscreen)',                            response_type: 'yes_no_na', required: 0, section: 'PPE Check' },
            { item_key: 'night_wands',        question: 'Night Wands (Nights only — N/A for day shift)',              response_type: 'yes_no_na', required: 0, section: 'PPE Check' },
            { item_key: 'crew_fit_for_work',  question: 'All crew confirm fit for work',                              response_type: 'yes_no_na', required: 1, section: 'Crew' },
            { item_key: 'comms_check',        question: 'Two-way / phone comms check completed',                      response_type: 'yes_no_na', required: 1, section: 'Crew' },
          ],
        },
        {
          system_key: 'post_shift_vehicle',
          name: 'Post-Shift Vehicle Checklist',
          description: 'End-of-shift vehicle return inspection. Records ODO close + any new defects.',
          require_signature: 1,
          items: [
            { item_key: 'vehicle_clean',     question: 'Vehicle returned clean (cabin + tray)',     response_type: 'yes_no_na', required: 1, section: 'Return Condition' },
            { item_key: 'no_new_damage',     question: 'No new damage from this shift',             response_type: 'yes_no_na', required: 1, section: 'Return Condition' },
            { item_key: 'fuel_topped_up',    question: 'Fuel topped up if required',                 response_type: 'yes_no_na', required: 0, section: 'Return Condition' },
            { item_key: 'arrow_board_off',   question: 'Arrow board powered off and secured',       response_type: 'yes_no_na', required: 0, section: 'Equipment' },
            { item_key: 'beacons_off',       question: 'Beacons / VMS powered off',                 response_type: 'yes_no_na', required: 0, section: 'Equipment' },
            { item_key: 'load_secured',      question: 'Tray load fully secured',                   response_type: 'yes_no_na', required: 1, section: 'Equipment' },
            { item_key: 'keys_returned',     question: 'Keys returned / parked at depot',           response_type: 'yes_no_na', required: 1, section: 'Handover' },
            { item_key: 'defects_logged',    question: 'New defects logged in notes',               response_type: 'yes_no_na', required: 0, section: 'Handover' },
          ],
        },
      ];

      const adminId = (db.prepare("SELECT id FROM users WHERE LOWER(role) IN ('admin','management') ORDER BY id ASC LIMIT 1").get() || {}).id || null;

      const findByKey = db.prepare("SELECT id FROM checklist_templates WHERE system_key = ?");
      const insertTemplate = db.prepare(`
        INSERT INTO checklist_templates (system_key, name, description, status, worker_visible, require_signature, created_by_id)
        VALUES (?, ?, ?, 'active', 1, ?, ?)
      `);
      const insertItem = db.prepare(`
        INSERT INTO checklist_template_items (template_id, item_order, section, item_key, question, response_type, required, options_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRev = db.prepare(`
        INSERT INTO checklist_template_revisions (template_id, revision_number, name, description, require_signature, items_json, published_by_id)
        VALUES (?, 1, ?, ?, ?, ?, ?)
      `);
      const setPublished = db.prepare(`
        UPDATE checklist_templates SET published_revision = 1, published_at = datetime('now'), published_by_id = ? WHERE id = ?
      `);

      let created = 0;
      for (const tpl of systemTemplates) {
        if (findByKey.get(tpl.system_key)) continue;
        const tx = db.transaction(() => {
          const r = insertTemplate.run(tpl.system_key, tpl.name, tpl.description, tpl.require_signature || 0, adminId);
          const tplId = r.lastInsertRowid;
          const itemRows = [];
          tpl.items.forEach((it, idx) => {
            const optionsJson = it.options ? JSON.stringify(it.options) : null;
            insertItem.run(tplId, idx, it.section || '', it.item_key, it.question, it.response_type, it.required ? 1 : 0, optionsJson);
            itemRows.push({
              item_order: idx, section: it.section || '', item_key: it.item_key,
              question: it.question, response_type: it.response_type,
              required: it.required ? 1 : 0,
              options: it.options || null,
            });
          });
          // Auto-publish revision 1 so the worker portal can resolve it immediately.
          insertRev.run(tplId, tpl.name, tpl.description, tpl.require_signature ? 1 : 0,
                        JSON.stringify(itemRows), adminId);
          setPublished.run(adminId, tplId);
        });
        tx();
        created++;
      }

      recordMigration.run(151, 'system Job-Pack templates seeded as editable + auto-published rev 1');
      console.log(`Migration 151 applied: seeded ${created} system Job-Pack templates`);
    } catch (e) {
      console.error('Migration 151 error:', e.message);
    }
  }

  // =============================================
  // Migration 152: Realign compliance reference_number prefixes with
  // item_type. Council rows that ended up with TSTGS, free-text refs
  // like 'Council Approval', etc. get a fresh prefix that matches the
  // type. Numbering continues from the highest existing suffix —
  // monotonically upwards, no resets — so a system already at
  // TSTGS3099 produces TSCA3100, TSCA3101, … as fixes land.
  // =============================================
  if (!isMigrationApplied.get(152)) {
    try {
      const prefixMap = {
        traffic_guidance: 'TSTGS',
        road_occupancy: 'TSROL',
        rol: 'TSROL',
        council_permit: 'TSCA',
        tmp_approval: 'TSTMP',
        swms_review: 'TSSWMS',
        insurance: 'TSINS',
        induction: 'TSIND',
        environmental: 'TSENV',
        utility_clearance: 'TSUC',
        spa: 'TSSPA',
        police_notification: 'TSPN',
        letter_drop: 'TSLD',
        other: 'TSOTH',
      };

      const allRefs = db.prepare("SELECT reference_number FROM compliance WHERE reference_number IS NOT NULL AND reference_number != ''").all();
      const tailRe = /^TS[A-Z]+(\d+)(?:-\d+)?$/;
      let maxNum = 3000;
      allRefs.forEach(r => {
        const m = (r.reference_number || '').match(tailRe);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      });

      const rows = db.prepare("SELECT id, item_type, reference_number FROM compliance WHERE reference_number IS NOT NULL AND reference_number != ''").all();
      const update = db.prepare("UPDATE compliance SET reference_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      let fixed = 0;
      rows.forEach(row => {
        const expected = prefixMap[row.item_type] || 'TSREF';
        if (!row.reference_number.startsWith(expected)) {
          maxNum += 1;
          update.run(expected + maxNum, row.id);
          fixed += 1;
        }
      });

      recordMigration.run(152, 'compliance refs: realign prefix to item_type, continue numbering from current max');
      console.log(`Migration 152 applied: realigned ${fixed} compliance reference number(s) to match item_type`);
    } catch (e) {
      console.error('Migration 152 error:', e.message);
    }
  }

  // =============================================
  // Migration 153: Promote the Vehicle Pre-Start system template from
  // a flat 22-row inspection list into the full hand-built form the
  // worker actually fills in — vehicle ID, ODO, the 22 rows, photo
  // uploads, notes, and signature — all as editable elements. After
  // this runs, the worker portal can render Vehicle Pre-Start straight
  // from the published revision with no hardcoded EJS structure left.
  // =============================================
  if (!isMigrationApplied.get(153)) {
    try {
      const tpl = db.prepare("SELECT id FROM checklist_templates WHERE system_key = 'vehicle_prestart'").get();
      if (tpl) {
        const existing = db.prepare("SELECT COUNT(*) AS c FROM checklist_template_items WHERE template_id = ? AND item_key IN ('vehicle','odo_start_km','arrow_board_photos','notes','driver_signature')").get(tpl.id).c;
        if (existing === 0) {
          // Push every existing inspection row down by 4 to make room
          // for the heading + vehicle + ODO + heading at the top.
          const allItems = db.prepare("SELECT id, item_order FROM checklist_template_items WHERE template_id = ? ORDER BY item_order ASC").all(tpl.id);
          const bump = db.prepare("UPDATE checklist_template_items SET item_order = ? WHERE id = ?");
          allItems.forEach((row, idx) => { bump.run(idx + 4, row.id); });

          const insertItem = db.prepare(`
            INSERT INTO checklist_template_items (template_id, item_order, section, item_key, question, response_type, required, options_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          insertItem.run(tpl.id, 0, 'Vehicle',    'vehicle_heading',     'Vehicle',                                                     'heading',      0, null);
          insertItem.run(tpl.id, 1, 'Vehicle',    'vehicle',             'Vehicle ID',                                                  'text',         1, null);
          insertItem.run(tpl.id, 2, 'Vehicle',    'odo_start_km',        'ODO at start of shift',                                       'measurement',  1, JSON.stringify({ unit: 'km' }));
          insertItem.run(tpl.id, 3, 'Inspection', 'inspection_heading',  'Inspection — 22 items',                                       'heading',      0, null);

          const tailStart = 4 + allItems.length;
          insertItem.run(tpl.id, tailStart + 0, 'Photos',   'photos_heading',     'Arrow Board Photos',                                                'heading',      0, null);
          insertItem.run(tpl.id, tailStart + 1, 'Photos',   'photos_info',        'Upload 3 photos: actuator (driver side), front-on, passenger side.', 'information', 0, JSON.stringify({ body: 'Three photos required for QA.' }));
          insertItem.run(tpl.id, tailStart + 2, 'Photos',   'arrow_board_photos', 'Arrow board photos',                                                'media_upload', 0, null);
          insertItem.run(tpl.id, tailStart + 3, 'Sign off', 'notes',              'Notes (optional)',                                                  'textarea',     0, null);
          insertItem.run(tpl.id, tailStart + 4, 'Sign off', 'driver_signature',   'Driver signature',                                                  'signature',    1, null);

          // Snapshot a fresh published revision with the parsed options.
          const items = db.prepare(`SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY item_order ASC, id ASC`).all(tpl.id);
          const itemsForSnapshot = items.map(it => {
            let opts = null;
            if (it.options_json) { try { opts = JSON.parse(it.options_json); } catch (e) {} }
            return Object.assign({}, it, { options: opts });
          });
          const adminId = (db.prepare("SELECT id FROM users WHERE LOWER(role) IN ('admin','management') ORDER BY id ASC LIMIT 1").get() || {}).id || null;
          const next = (db.prepare('SELECT MAX(revision_number) AS m FROM checklist_template_revisions WHERE template_id = ?').get(tpl.id).m || 0) + 1;
          db.prepare(`
            INSERT INTO checklist_template_revisions (template_id, revision_number, name, description, require_signature, items_json, published_by_id)
            VALUES (?, ?, 'Vehicle Pre-Start', 'Pre-shift inspection. Vehicle, ODO, 22 OK/Not OK/N/A items, photos, sign-off.', 1, ?, ?)
          `).run(tpl.id, next, JSON.stringify(itemsForSnapshot), adminId);
          db.prepare(`UPDATE checklist_templates SET published_revision = ?, published_at = datetime('now'), published_by_id = ? WHERE id = ?`).run(next, adminId, tpl.id);
          console.log(`Migration 153: Vehicle Pre-Start extended to full form (rev ${next})`);
        } else {
          console.log('Migration 153: Vehicle Pre-Start already extended, skipping');
        }
      } else {
        console.log('Migration 153: Vehicle Pre-Start template not found (mig 151 must run first)');
      }
      recordMigration.run(153, 'Vehicle Pre-Start template extended to full form');
    } catch (e) {
      console.error('Migration 153 error:', e.message);
    }
  }

  // =============================================
  // Migration 154: Plans → Sub-Plans hierarchy. Extend `compliance` so
  // a parent Plan owns N typed Sub-Plans in the same table:
  //   - parent_id: NULL on parents + legacy rows; set on sub-plans
  //   - plan_number: shared base used in sub-plan refs (Plan 3100 →
  //     TSTGS3100-1, TSROL3100-1, …). Set on parents only.
  //   - description: free-text suffix shown next to sub-plan ref
  //     ("Northbound 2 lanes")
  //   - client_request_date: replaces the multi-date cluster on the
  //     parent (single date on create)
  //   - extension_required: ROL-specific flag, sub-plan-level
  // Existing flat rows stay as-is (parent_id NULL + item_type set);
  // they continue to render unchanged in the list view.
  // =============================================
  if (!isMigrationApplied.get(154)) {
    try {
      const cols = db.prepare("PRAGMA table_info(compliance)").all().map(c => c.name);
      const add = (name, ddl) => { if (!cols.includes(name)) try { db.exec(`ALTER TABLE compliance ADD COLUMN ${ddl}`); } catch (e) {} };
      add('parent_id',            "parent_id INTEGER");
      add('plan_number',          "plan_number INTEGER");
      add('description',          "description TEXT DEFAULT ''");
      add('client_request_date',  "client_request_date DATE");
      add('extension_required',   "extension_required INTEGER NOT NULL DEFAULT 0");
      db.exec("CREATE INDEX IF NOT EXISTS idx_compliance_parent ON compliance(parent_id)");

      recordMigration.run(154, 'compliance: parent_id + plan_number + description + client_request_date + extension_required');
      console.log('Migration 154 applied: compliance Plans → Sub-Plans columns + index');
    } catch (e) {
      console.error('Migration 154 error:', e.message);
    }
  }

  // =============================================
  // Migration 155: hours_spent column on compliance — captured per
  // sub-plan at upload-and-submit time so each Sub-Plan records the
  // hours of effort that went into it. Cost / fee fields already exist
  // (costs, charge_client, charge_amount, council_fee_paid,
  // council_fee_amount); this just adds the time dimension.
  // =============================================
  if (!isMigrationApplied.get(155)) {
    try {
      const cols = db.prepare("PRAGMA table_info(compliance)").all().map(c => c.name);
      if (!cols.includes('hours_spent')) {
        try { db.exec("ALTER TABLE compliance ADD COLUMN hours_spent NUMERIC NOT NULL DEFAULT 0"); } catch (e) {}
      }
      recordMigration.run(155, 'compliance: hours_spent column for sub-plan effort tracking');
      console.log('Migration 155 applied: compliance.hours_spent column');
    } catch (e) {
      console.error('Migration 155 error:', e.message);
    }
  }

  // =============================================
  // Migration 156: Management pay run support.
  //   - pay_runs.pay_run_type discriminator: 'traffic_control' (default)
  //     vs 'management'. CHECK constraint enforced in app code rather
  //     than schema (SQLite can't add CHECK to existing columns without
  //     a table rebuild, and the existing pay_runs table is large).
  //   - employees.on_management_payroll: orthogonal to payment_type so
  //     a salaried director can also be on a Traffic Control run for
  //     ad-hoc cash work.
  //   - employees.weekly_salary + super_rate: pay parameters for each
  //     management employee.
  //   - pay_run_lines.salary_amount + super_amount + income_label:
  //     one line per income source (Salary, Director fee, Bonus, …).
  // =============================================
  if (!isMigrationApplied.get(156)) {
    try {
      const prCols = db.prepare("PRAGMA table_info(pay_runs)").all().map(c => c.name);
      if (!prCols.includes('pay_run_type')) {
        try { db.exec("ALTER TABLE pay_runs ADD COLUMN pay_run_type TEXT NOT NULL DEFAULT 'traffic_control'"); } catch (e) {}
      }

      const empCols = db.prepare("PRAGMA table_info(employees)").all().map(c => c.name);
      const addEmp = (name, ddl) => { if (!empCols.includes(name)) try { db.exec(`ALTER TABLE employees ADD COLUMN ${ddl}`); } catch (e) {} };
      addEmp('on_management_payroll', "on_management_payroll INTEGER NOT NULL DEFAULT 0");
      addEmp('weekly_salary',         "weekly_salary REAL DEFAULT 0");
      addEmp('super_rate',            "super_rate REAL DEFAULT 0.12");

      const lineCols = db.prepare("PRAGMA table_info(pay_run_lines)").all().map(c => c.name);
      const addLine = (name, ddl) => { if (!lineCols.includes(name)) try { db.exec(`ALTER TABLE pay_run_lines ADD COLUMN ${ddl}`); } catch (e) {} };
      addLine('salary_amount', "salary_amount REAL DEFAULT 0");
      addLine('super_amount',  "super_amount REAL DEFAULT 0");
      addLine('income_label',  "income_label TEXT DEFAULT ''");

      // Partial index to make "who's on management payroll?" lookups fast
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_employees_management ON employees(on_management_payroll) WHERE on_management_payroll = 1"); } catch (e) {}

      recordMigration.run(156, 'pay_runs: management type + employee salaried fields + per-line salary/super/income_label');
      console.log('Migration 156 applied: management pay-run schema');
    } catch (e) {
      console.error('Migration 156 error:', e.message);
    }
  }

  // =============================================
  // Migration 157: Pay run feature pack
  //   - income_labels: managed dropdown of income labels for management runs
  //   - pay_run_line_expenses: per-line expense items with optional receipts
  //     (Fuel / Tolls / Parking / Other-with-custom-label, attached file)
  //   - pay_run_line_deductions: per-line deductions {description, amount}
  //   - pay_run_lines.travel_rate / travel_count / meal_rate / meal_count:
  //     break travel/meal allowances into rate × quantity for transparent
  //     editing on the pay-run line edit modal.
  //   - pay_run_lines.total_deductions: SUM of pay_run_line_deductions for
  //     the line, denormalised so the existing recomputeLine path can
  //     subtract it from grand_total.
  // =============================================
  if (!isMigrationApplied.get(157)) {
    try {
      // Income labels dropdown (used by management pay runs)
      db.exec(`
        CREATE TABLE IF NOT EXISTS income_labels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL UNIQUE,
          sort_order INTEGER NOT NULL DEFAULT 100,
          active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      const seedLabels = ['Salary', 'Director Fee', 'Bonus', 'Commission', 'Allowance', 'Reimbursement'];
      const seedStmt = db.prepare("INSERT OR IGNORE INTO income_labels (label, sort_order) VALUES (?, ?)");
      seedLabels.forEach((l, i) => seedStmt.run(l, (i + 1) * 10));

      // Per-line expenses with optional receipt attachments
      db.exec(`
        CREATE TABLE IF NOT EXISTS pay_run_line_expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pay_run_line_id INTEGER NOT NULL REFERENCES pay_run_lines(id) ON DELETE CASCADE,
          label TEXT NOT NULL DEFAULT 'Fuel',
          custom_label TEXT,
          amount REAL NOT NULL DEFAULT 0,
          receipt_path TEXT,
          receipt_filename TEXT,
          mime_type TEXT,
          file_size INTEGER,
          uploaded_by_id INTEGER,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_pay_run_line_expenses_line ON pay_run_line_expenses(pay_run_line_id);
      `);

      // Per-line deductions
      db.exec(`
        CREATE TABLE IF NOT EXISTS pay_run_line_deductions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pay_run_line_id INTEGER NOT NULL REFERENCES pay_run_lines(id) ON DELETE CASCADE,
          description TEXT NOT NULL,
          amount REAL NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 100,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_pay_run_line_deductions_line ON pay_run_line_deductions(pay_run_line_id);
      `);

      // travel/meal rate × count + total_deductions on pay_run_lines
      const lineCols157 = db.prepare("PRAGMA table_info(pay_run_lines)").all().map(c => c.name);
      const addLine157 = (name, ddl) => { if (!lineCols157.includes(name)) try { db.exec(`ALTER TABLE pay_run_lines ADD COLUMN ${ddl}`); } catch (e) {} };
      addLine157('travel_rate',     "travel_rate REAL DEFAULT 0");
      addLine157('travel_count',    "travel_count INTEGER DEFAULT 0");
      addLine157('meal_rate',       "meal_rate REAL DEFAULT 0");
      addLine157('meal_count',      "meal_count INTEGER DEFAULT 0");
      addLine157('total_deductions',"total_deductions REAL DEFAULT 0");

      // Backfill rate/count for existing rows from employees table
      try {
        db.exec(`
          UPDATE pay_run_lines
          SET travel_rate = COALESCE(
            (SELECT rate_fares_daily FROM employees WHERE id = pay_run_lines.employee_id), 0)
          WHERE (travel_rate IS NULL OR travel_rate = 0) AND employee_id IS NOT NULL;
        `);
        db.exec(`
          UPDATE pay_run_lines
          SET travel_count = CASE
            WHEN travel_rate > 0 THEN CAST(ROUND(travel_allowance / travel_rate) AS INTEGER)
            ELSE 0 END
          WHERE (travel_count IS NULL OR travel_count = 0) AND travel_allowance > 0;
        `);
        db.exec(`
          UPDATE pay_run_lines
          SET meal_rate = COALESCE(
            (SELECT rate_meal FROM employees WHERE id = pay_run_lines.employee_id), 0)
          WHERE (meal_rate IS NULL OR meal_rate = 0) AND employee_id IS NOT NULL;
        `);
        db.exec(`
          UPDATE pay_run_lines
          SET meal_count = CASE
            WHEN meal_rate > 0 THEN CAST(ROUND(meal_allowance / meal_rate) AS INTEGER)
            ELSE 0 END
          WHERE (meal_count IS NULL OR meal_count = 0) AND meal_allowance > 0;
        `);
      } catch (e) {
        console.error('Migration 157 backfill warning:', e.message);
      }

      recordMigration.run(157, 'pay run feature pack: income_labels, expenses, deductions, travel/meal rate×count');
      console.log('Migration 157 applied: pay run feature pack (income_labels + expenses + deductions + travel/meal rate×count)');
    } catch (e) {
      console.error('Migration 157 error:', e.message);
    }
  }

  // =============================================
  // Migration 158: Tenders — first-class parent records grouping jobs +
  // compliance (plans). A tender represents work being bid on; once it's
  // won, the linked jobs/plans roll up under it. tender_id FK is added
  // to jobs and compliance with ON DELETE SET NULL so deleting a tender
  // doesn't cascade-delete real work.
  // =============================================
  if (!isMigrationApplied.get(158)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tender_number TEXT UNIQUE,
          title TEXT NOT NULL,
          client_id INTEGER REFERENCES clients(id),
          status TEXT NOT NULL DEFAULT 'open',
          estimated_value REAL DEFAULT 0,
          submission_due DATE,
          submitted_at DATE,
          decision_at DATE,
          decision_notes TEXT,
          principal_contractor TEXT,
          site_address TEXT,
          notes TEXT,
          created_by_id INTEGER REFERENCES users(id),
          owner_id INTEGER REFERENCES users(id),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(status);
        CREATE INDEX IF NOT EXISTS idx_tenders_client ON tenders(client_id);
      `);

      const jobsCols158 = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
      if (!jobsCols158.includes('tender_id')) {
        try { db.exec("ALTER TABLE jobs ADD COLUMN tender_id INTEGER REFERENCES tenders(id) ON DELETE SET NULL"); } catch (e) {}
      }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_tender ON jobs(tender_id)"); } catch (e) {}

      const compCols158 = db.prepare("PRAGMA table_info(compliance)").all().map(c => c.name);
      if (!compCols158.includes('tender_id')) {
        try { db.exec("ALTER TABLE compliance ADD COLUMN tender_id INTEGER REFERENCES tenders(id) ON DELETE SET NULL"); } catch (e) {}
      }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_compliance_tender ON compliance(tender_id)"); } catch (e) {}

      recordMigration.run(158, 'tenders table + tender_id FK on jobs and compliance');
      console.log('Migration 158 applied: tenders table + tender_id FK on jobs + compliance');
    } catch (e) {
      console.error('Migration 158 error:', e.message);
    }
  }

  // =============================================
  // Migration 159: Super guarantee rate to 12% (FY2025-26).
  //   - Bumps employees.super_rate default from 0.115 → 0.12.
  //   - Backfills existing employees on the old 0.115 rate.
  //   - Recalculates super_amount on existing pay_run_lines for management
  //     runs where super_amount = round(salary × 0.115). Pay runs already
  //     finalised but mis-rated should be corrected — the only rows we
  //     recompute are those whose super_amount currently matches the old
  //     11.5% formula (so manually-overridden rows survive untouched).
  // =============================================
  if (!isMigrationApplied.get(159)) {
    try {
      db.prepare("UPDATE employees SET super_rate = 0.12 WHERE super_rate IS NULL OR super_rate = 0.115").run();

      // Recompute super_amount on management lines where it matches the
      // old 0.115 formula. round2 in JS = Math.round(n*100)/100, mirror in SQL.
      const stale = db.prepare(`
        SELECT id, salary_amount, super_amount FROM pay_run_lines
        WHERE salary_amount IS NOT NULL AND salary_amount > 0
      `).all();
      const upd = db.prepare("UPDATE pay_run_lines SET super_amount = ? WHERE id = ?");
      let n = 0;
      for (const l of stale) {
        const expectedOld = Math.round(parseFloat(l.salary_amount) * 0.115 * 100) / 100;
        if (Math.abs(parseFloat(l.super_amount) - expectedOld) < 0.005) {
          const newSuper = Math.round(parseFloat(l.salary_amount) * 0.12 * 100) / 100;
          upd.run(newSuper, l.id);
          n++;
        }
      }

      recordMigration.run(159, 'super rate bumped to 12% + backfill matching pay-run lines');
      console.log(`Migration 159 applied: super rate → 12% (refreshed ${n} pay-run lines that were on the old 11.5% rate)`);
    } catch (e) {
      console.error('Migration 159 error:', e.message);
    }
  }

  // =============================================
  // Migration 160: Seed Building & Construction General On-site Award
  // (MA000020) classifications — General Building / Non-Residential
  // Shiftworker rates, FY2025-26.
  //   Base hourly rates from the FW Commission award library.
  //   Shift loadings derived from clauses 17 (shiftworker penalties) and
  //   24 (overtime, weekend, PH multipliers). Meal/Fares are placeholders
  //   the user can adjust on /payroll/award-rates — they don't drift from
  //   the award by classification anyway.
  // =============================================
  if (!isMigrationApplied.get(160)) {
    try {
      const AWARD_NAME = 'MA000020 — General Building (Non-Residential) Shiftworker';
      const FY = '2025-07-01';
      const MEAL = 19.50;
      const FARES = 19.30;
      // [classification, base ordinary $/hr]
      const LEVELS = [
        ['CW/ECW 1a',  25.46],
        ['CW/ECW 1b',  25.96],
        ['CW/ECW 1c',  26.31],
        ['CW/ECW 1d',  26.78],
        ['CW/ECW 2',   27.32],
        ['CW/ECW 3',   28.12],
        ['CW/ECW 4',   29.00],
        ['CW/ECW 5',   29.89],
        ['CW/ECW 6',   30.68],
        ['CW/ECW 7',   31.56],
        ['CW/ECW 8',   32.33],
      ];
      const r2 = n => Math.round(n * 100) / 100;

      // Match any existing seeded version by name+effective_from so we
      // don't duplicate. Use REPLACE-equivalent via DELETE + INSERT
      // to refresh stale rates without leaving zombie copies.
      const existing = db.prepare("SELECT id FROM award_classifications WHERE award_name = ? AND effective_from = ?").all(AWARD_NAME, FY);
      for (const e of existing) db.prepare("DELETE FROM award_classifications WHERE id = ?").run(e.id);

      const ins = db.prepare(`
        INSERT INTO award_classifications
          (award_name, classification, effective_from, effective_to,
           rate_day, rate_day_ot, rate_day_dt,
           rate_night, rate_night_ot, rate_night_dt,
           rate_weekend, rate_public_holiday,
           rate_meal, rate_fares_daily,
           notes, active)
        VALUES (?, ?, ?, NULL,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?,
           ?, ?,
           ?, 1)
      `);
      let inserted = 0;
      for (const [cls, base] of LEVELS) {
        ins.run(
          AWARD_NAME, cls, FY,
          // Day:    1.0  / OT 1.5  / DT 2.0
          r2(base * 1.0),  r2(base * 1.5),  r2(base * 2.0),
          // Night (afternoon/night shift loading 150%): base × 1.5,
          // night OT × 2.0, night DT × 2.5
          r2(base * 1.5),  r2(base * 2.0),  r2(base * 2.5),
          // Weekend Saturday × 1.5, PH × 2.5
          r2(base * 1.5),  r2(base * 2.5),
          MEAL, FARES,
          'Seeded from FW Commission award library; verify against current Schedule B before payroll.'
        );
        inserted++;
      }

      recordMigration.run(160, 'Seed BCG Award MA000020 General Building Shiftworker classifications');
      console.log(`Migration 160 applied: seeded ${inserted} BCG Award classifications (effective ${FY})`);
    } catch (e) {
      console.error('Migration 160 error:', e.message);
    }
  }

  // =============================================
  // Migration 161: Casual loading + CW/ECW 9.
  //   Every T&S worker is engaged as casual under the BCG Award, so every
  //   classification rate gets a 25% casual loading per clause 11.4. We
  //   keep the published ordinary rate visible as base_rate_day so the
  //   admin can verify against Schedule B.
  //   Also adds CW/ECW 9 (the missing top-tier classification).
  // =============================================
  if (!isMigrationApplied.get(161)) {
    try {
      const acCols = db.prepare("PRAGMA table_info(award_classifications)").all().map(c => c.name);
      if (!acCols.includes('base_rate_day')) {
        try { db.exec("ALTER TABLE award_classifications ADD COLUMN base_rate_day REAL"); } catch (e) {}
      }

      const AWARD_NAME = 'MA000020 — General Building (Non-Residential) Shiftworker';
      const FY = '2025-07-01';
      const MEAL = 19.00;
      const FARES = 21.94;
      const LOADING = 1.25;
      // [classification, base ordinary $/hr]
      const LEVELS = [
        ['CW/ECW 1a',  25.46],
        ['CW/ECW 1b',  25.96],
        ['CW/ECW 1c',  26.31],
        ['CW/ECW 1d',  26.78],
        ['CW/ECW 2',   27.32],
        ['CW/ECW 3',   28.12],
        ['CW/ECW 4',   29.00],
        ['CW/ECW 5',   29.89],
        ['CW/ECW 6',   30.68],
        ['CW/ECW 7',   31.56],
        ['CW/ECW 8',   32.33],
        ['CW/ECW 9',   33.13],  // verify against current Schedule B
      ];
      const r2 = n => Math.round(n * 100) / 100;

      // Wipe and re-seed so casual loading is applied uniformly.
      db.prepare("DELETE FROM award_classifications WHERE award_name = ? AND effective_from = ?").run(AWARD_NAME, FY);

      const ins = db.prepare(`
        INSERT INTO award_classifications
          (award_name, classification, effective_from, effective_to,
           base_rate_day,
           rate_day, rate_day_ot, rate_day_dt,
           rate_night, rate_night_ot, rate_night_dt,
           rate_weekend, rate_public_holiday,
           rate_meal, rate_fares_daily,
           notes, active)
        VALUES (?, ?, ?, NULL,
           ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?,
           ?, ?,
           ?, 1)
      `);
      let inserted = 0;
      for (const [cls, base] of LEVELS) {
        // BCG clause 11.4: casual loading 25% applies on top of the
        // *appropriate* rate of pay (i.e. inclusive of OT/shift loadings).
        ins.run(
          AWARD_NAME, cls, FY,
          base, // base_rate_day — published ordinary rate before casual loading
          // Day:    1.0 * 1.25
          r2(base * 1.0  * LOADING),
          r2(base * 1.5  * LOADING), // Day OT
          r2(base * 2.0  * LOADING), // Day DT
          // Night (afternoon/night 150% shift loading) × casual loading
          r2(base * 1.5  * LOADING),
          r2(base * 2.0  * LOADING), // Night OT
          r2(base * 2.5  * LOADING), // Night DT
          // Weekend Saturday × 1.5  × casual; PH × 2.5 × casual
          r2(base * 1.5  * LOADING),
          r2(base * 2.5  * LOADING),
          MEAL, FARES,
          'Casual loading 25% applied per clause 11.4. Base ordinary stored as base_rate_day. Verify against current Schedule B before payroll.'
        );
        inserted++;
      }

      recordMigration.run(161, 'Casual loading 25% on BCG classifications + CW/ECW 9');
      console.log(`Migration 161 applied: seeded ${inserted} BCG classifications with 25% casual loading (incl. CW/ECW 9)`);
    } catch (e) {
      console.error('Migration 161 error:', e.message);
    }
  }

  // =============================================
  // Migration 162: tasks.tender_id so tasks can be attached to a tender,
  // matching the existing tender_id on jobs and compliance.
  // =============================================
  if (!isMigrationApplied.get(162)) {
    try {
      const tasksCols162 = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      if (!tasksCols162.includes('tender_id')) {
        try { db.exec("ALTER TABLE tasks ADD COLUMN tender_id INTEGER REFERENCES tenders(id) ON DELETE SET NULL"); } catch (e) {}
      }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_tender ON tasks(tender_id)"); } catch (e) {}
      recordMigration.run(162, 'tasks.tender_id FK to tenders');
      console.log('Migration 162 applied: tasks.tender_id added');
    } catch (e) {
      console.error('Migration 162 error:', e.message);
    }
  }

  // =============================================
  // Migration 163: Expand compliance.item_type CHECK to allow every sub-plan
  // type that routes/compliance.js generates. Migration 65 added
  // police_notification + letter_drop but missed sza and bus_approval, so
  // those plan types blow up at insert time with a CHECK constraint error.
  // Rebuild the table with the full superset.
  // =============================================
  if (!isMigrationApplied.get(163)) {
    console.log('Running migration 163: Expand compliance item_type CHECK to include sza + bus_approval');
    try {
      const ddlRow = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'compliance'").get();
      const oldDDL = ddlRow ? ddlRow.sql : '';
      const needsRebuild = !oldDDL.includes("'sza'") || !oldDDL.includes("'bus_approval'");
      if (needsRebuild) {
        const cols = db.prepare("PRAGMA table_info(compliance)").all();
        const fkRows = db.prepare("PRAGMA foreign_key_list(compliance)").all();
        const fkByCol = {};
        fkRows.forEach(fk => { fkByCol[fk.from] = fk; });

        const colDefs = cols.map(c => {
          let def = `${c.name} ${c.type}`;
          if (c.name === 'item_type') {
            def = "item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','spa','sza','police_notification','letter_drop','bus_approval','other'))";
          } else {
            if (c.notnull && !c.pk) def += ' NOT NULL';
            if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
          }
          if (c.pk) def += ' PRIMARY KEY AUTOINCREMENT';
          if (fkByCol[c.name] && c.name !== 'item_type') {
            const fk = fkByCol[c.name];
            def += ` REFERENCES ${fk.table}(${fk.to})`;
            if (fk.on_delete && fk.on_delete !== 'NO ACTION') def += ` ON DELETE ${fk.on_delete}`;
            if (fk.on_update && fk.on_update !== 'NO ACTION') def += ` ON UPDATE ${fk.on_update}`;
          }
          return def;
        }).join(', ');

        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');
        db.exec(`CREATE TABLE compliance_new (${colDefs})`);
        const colNames = cols.map(c => c.name).join(', ');
        db.exec(`INSERT INTO compliance_new (${colNames}) SELECT ${colNames} FROM compliance`);
        db.exec('DROP TABLE compliance');
        db.exec('ALTER TABLE compliance_new RENAME TO compliance');
        db.exec('COMMIT');
        db.exec('PRAGMA foreign_keys = ON');
        // Rebuild dropped indexes (table rebuild drops them).
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id)'); } catch (e) {}
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_compliance_tender ON compliance(tender_id)'); } catch (e) {}
        console.log('Migration 163: compliance rebuilt with sza + bus_approval allowed.');
      } else {
        console.log('Migration 163: CHECK already includes sza + bus_approval, skipping rebuild.');
      }
      recordMigration.run(163, 'Expand compliance item_type CHECK with sza + bus_approval');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error('Migration 163 error:', e.message);
    }
  }

  // =============================================
  // Migration 164: Add 'safety' to users.role CHECK so we can assign the
  // new Safety role (Site Audits, Incidents, Checklists). Mirrors the
  // table-rebuild pattern from migration 133.
  // =============================================
  if (!isMigrationApplied.get(164)) {
    const userSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (userSql && userSql.sql && !userSql.sql.includes("'safety'")) {
      const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const colDefs = db.prepare("PRAGMA table_info(users)").all().map(c => {
        const notNull = c.notnull ? ' NOT NULL' : '';
        const dflt = c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : '';
        const pk = c.pk ? ' PRIMARY KEY AUTOINCREMENT' : '';
        const unique = c.name === 'username' ? ' UNIQUE' : '';
        return `${c.name} ${c.type}${pk}${unique}${notNull}${dflt}`;
      }).join(',\n            ');

      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE users_new (
            ${colDefs},
            CHECK(role IN ('admin','operations','planning','finance','hr','sales','management','marketing','accounts','safety'))
        );
      `);
      db.exec(`INSERT INTO users_new (${cols.join(',')}) SELECT ${cols.join(',')} FROM users;`);
      db.exec('DROP TABLE users;');
      db.exec('ALTER TABLE users_new RENAME TO users;');
      db.pragma('foreign_keys = ON');
      console.log("Migration 164: users.role CHECK now includes 'safety'");
    } else {
      console.log('Migration 164: users CHECK already permits safety — nothing to do.');
    }
    recordMigration.run(164, "Expand users.role CHECK to include safety");
    console.log('Migration 164 applied.');
  }

  // =============================================
  // Migration 165: SWMS register. A single table holds both reusable
  // templates (kind = 'template') and job-linked SWMS docs (kind = 'job').
  // Either flavour can be in 'draft' (no file uploaded yet — a placeholder
  // assigned to someone to fill in), 'active' (file uploaded, in use),
  // or 'archived'. Soft-deletes rather than ON DELETE CASCADE so a job
  // delete doesn't lose the SWMS history.
  // =============================================
  if (!isMigrationApplied.get(165)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS swms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'job' CHECK(kind IN ('template','job')),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          owner_id INTEGER REFERENCES users(id),
          file_path TEXT DEFAULT '',
          file_original_name TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_swms_kind ON swms(kind);
        CREATE INDEX IF NOT EXISTS idx_swms_job ON swms(job_id);
        CREATE INDEX IF NOT EXISTS idx_swms_status ON swms(status);
      `);
      recordMigration.run(165, 'SWMS register table');
      console.log('Migration 165 applied: swms table');
    } catch (e) {
      console.error('Migration 165 error:', e.message);
    }
  }

  // =============================================
  // Migration 166: SWMS expiry tracking. Job-linked SWMS renew every 6
  // months, templates update every 3 months. expiry_date is auto-set on
  // create from kind, but admins can override. last_reminded_at lets the
  // notifier de-dupe expiry reminders without spamming.
  // Backfills existing rows so the register shows sensible expiry from
  // day one.
  // =============================================
  if (!isMigrationApplied.get(166)) {
    try {
      const swmsCols = db.prepare("PRAGMA table_info(swms)").all().map(c => c.name);
      if (!swmsCols.includes('expiry_date')) {
        try { db.exec("ALTER TABLE swms ADD COLUMN expiry_date DATE"); } catch (e) {}
      }
      if (!swmsCols.includes('last_reminded_at')) {
        try { db.exec("ALTER TABLE swms ADD COLUMN last_reminded_at DATETIME"); } catch (e) {}
      }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_swms_expiry ON swms(expiry_date)"); } catch (e) {}

      // Backfill: any existing row without an expiry_date gets created_at + 6mo (job)
      // or + 3mo (template). New rows go through the route handler which does the same.
      const backfilled = db.prepare(`
        UPDATE swms
        SET expiry_date = date(created_at, CASE kind WHEN 'template' THEN '+3 months' ELSE '+6 months' END)
        WHERE expiry_date IS NULL
      `).run();
      recordMigration.run(166, 'swms.expiry_date + last_reminded_at + backfill');
      console.log(`Migration 166 applied: swms expiry tracking added (${backfilled.changes} rows backfilled)`);
    } catch (e) {
      console.error('Migration 166 error:', e.message);
    }
  }

  // =============================================
  // Migration 167: Risk Assessment register. Mirrors the SWMS table 1:1
  // (templates + job-linked, draft/active/archived, expiry tracking) so
  // the two modules can share UI patterns and the operator only has to
  // learn one workflow.
  // =============================================
  if (!isMigrationApplied.get(167)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS risk_assessments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'job' CHECK(kind IN ('template','job')),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          owner_id INTEGER REFERENCES users(id),
          file_path TEXT DEFAULT '',
          file_original_name TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          expiry_date DATE,
          last_reminded_at DATETIME,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ra_kind ON risk_assessments(kind);
        CREATE INDEX IF NOT EXISTS idx_ra_job ON risk_assessments(job_id);
        CREATE INDEX IF NOT EXISTS idx_ra_status ON risk_assessments(status);
        CREATE INDEX IF NOT EXISTS idx_ra_expiry ON risk_assessments(expiry_date);
      `);
      recordMigration.run(167, 'risk_assessments register table');
      console.log('Migration 167 applied: risk_assessments table');
    } catch (e) {
      console.error('Migration 167 error:', e.message);
    }
  }

  // =============================================
  // Migration 168: add 'safety' to tasks.division CHECK so the task form
  // can offer Safety as a division (matches the 'safety' role added in
  // migration 164). Same table-rebuild pattern as migration 115's
  // tasks_rebuild_115. Idempotent — skips when 'safety' already permitted.
  // =============================================
  if (!isMigrationApplied.get(168)) {
    try {
      const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
      const currentSQL = tableSQL ? tableSQL.sql : '';
      if (currentSQL && !currentSQL.includes("'safety'")) {
        const existingCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
        // Get full DDL for each column so we don't lose anything (added by later migrations)
        const colDefs = db.prepare("PRAGMA table_info(tasks)").all().map(c => {
          let def = `${c.name} ${c.type}`;
          if (c.name === 'division') {
            def = "division TEXT NOT NULL DEFAULT 'ops' CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management','hr','safety'))";
          } else {
            if (c.notnull && !c.pk) def += ' NOT NULL';
            if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
            if (c.pk) def += ' PRIMARY KEY AUTOINCREMENT';
          }
          return def;
        }).join(', ');
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');
        db.exec(`CREATE TABLE tasks_new_168 (${colDefs})`);
        const colList = existingCols.join(', ');
        db.exec(`INSERT INTO tasks_new_168 (${colList}) SELECT ${colList} FROM tasks`);
        db.exec('DROP TABLE tasks');
        db.exec('ALTER TABLE tasks_new_168 RENAME TO tasks');
        db.exec('COMMIT');
        db.exec('PRAGMA foreign_keys = ON');
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id)'); } catch (e) {}
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tender ON tasks(tender_id)'); } catch (e) {}
        console.log("Migration 168: tasks.division CHECK now allows 'safety'");
      } else {
        console.log("Migration 168: 'safety' already in tasks.division CHECK — skipping rebuild.");
      }
      recordMigration.run(168, "tasks.division CHECK + 'safety'");
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error('Migration 168 error:', e.message);
    }
  }

  // Migration 169: seed default internal hourly cost rate ($40/hr).
  // Used by the compliance Sub-plans P&L (admin/finance only) to convert
  // hours_spent into a T&S cost figure so we can compare to charge_amount.
  if (!isMigrationApplied.get(169)) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO system_config (config_key, config_value, config_type, description)
        VALUES (?, ?, ?, ?)
      `).run('internal_hourly_rate', '40', 'number', 'Internal T&S labour cost per hour (admin/finance P&L only)');
      recordMigration.run(169, 'Internal hourly rate config');
      console.log('Migration 169 applied: internal_hourly_rate seeded');
    } catch (e) {
      console.error('Migration 169 error:', e.message);
    }
  }

  // Migration 170: link corrective_actions to tasks. Each new CA spawns a
  // task assigned to the same user; closing one side closes the other.
  // Nullable so legacy CAs (created before this) still work.
  if (!isMigrationApplied.get(170)) {
    try {
      const cols = db.prepare("PRAGMA table_info(corrective_actions)").all().map(c => c.name);
      if (!cols.includes('task_id')) {
        db.exec("ALTER TABLE corrective_actions ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL");
        db.exec("CREATE INDEX IF NOT EXISTS idx_ca_task ON corrective_actions(task_id)");
      }
      recordMigration.run(170, 'corrective_actions.task_id link');
      console.log('Migration 170 applied: corrective_actions.task_id added');
    } catch (e) {
      console.error('Migration 170 error:', e.message);
    }
  }

  // Migration 171: Pay run approval workflow.
  // Expands pay_runs.status CHECK to ('draft','pending_approval','approved','paid','finalized')
  // and adds audit columns (who submitted/approved/paid/unlocked + when).
  // Existing rows keep their current status. SQLite can't ALTER a CHECK in
  // place, so we rebuild the table — disable FKs first because pay_run_lines
  // references pay_runs.
  if (!isMigrationApplied.get(171)) {
    let needsRebuild = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pay_runs'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'pending_approval'")) needsRebuild = false;
    } catch (e) { /* fall through */ }

    if (needsRebuild) {
      db.pragma('foreign_keys = OFF');
      try {
        const cols = db.prepare("PRAGMA table_info(pay_runs)").all().map(c => c.name);
        const hasPayRunType = cols.includes('pay_run_type');
        const payRunTypeCol = hasPayRunType ? "pay_run_type TEXT NOT NULL DEFAULT 'traffic_control'," : '';
        const payRunTypeSelect = hasPayRunType ? ',pay_run_type' : '';

        db.exec(`
          CREATE TABLE pay_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            period_start DATE NOT NULL,
            period_end DATE NOT NULL,
            label TEXT DEFAULT '',
            csv_filename TEXT DEFAULT '',
            csv_uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','paid','finalized')),
            ${payRunTypeCol}
            submitted_for_approval_at DATETIME,
            submitted_by_id INTEGER REFERENCES users(id),
            approved_at DATETIME,
            approved_by_id INTEGER REFERENCES users(id),
            paid_at DATETIME,
            paid_by_id INTEGER REFERENCES users(id),
            unlocked_at DATETIME,
            unlocked_by_id INTEGER REFERENCES users(id),
            created_by_id INTEGER REFERENCES users(id),
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO pay_runs_new (id, period_start, period_end, label, csv_filename, csv_uploaded_at, status${payRunTypeSelect}, created_by_id, notes, created_at, updated_at)
            SELECT id, period_start, period_end, label, csv_filename, csv_uploaded_at, status${payRunTypeSelect}, created_by_id, notes, created_at, updated_at FROM pay_runs;
          DROP TABLE pay_runs;
          ALTER TABLE pay_runs_new RENAME TO pay_runs;
          CREATE INDEX IF NOT EXISTS idx_pay_runs_period ON pay_runs(period_start);
        `);
        db.pragma('foreign_keys = ON');
        recordMigration.run(171, 'pay_runs: approval workflow status + audit columns');
        console.log('Migration 171 applied: pay_runs approval workflow');
      } catch (e) {
        db.pragma('foreign_keys = ON');
        try { db.exec('DROP TABLE IF EXISTS pay_runs_new'); } catch (re) { /* ignore */ }
        console.error('Migration 171 error:', e.message);
      }
    } else {
      recordMigration.run(171, 'pay_runs: approval workflow status + audit columns');
    }
  }

  // Migration 172: Backfill payroll BSB + Account on employees from their
  // latest induction submission so the worker rates page is pre-populated
  // and finance doesn't have to copy the details across. Inductions are
  // linked via linked_crew_member_id (or email fallback). Only writes
  // when the employee's existing field is blank — once finance edits on
  // the rates page, the employee record is authoritative.
  if (!isMigrationApplied.get(172)) {
    try {
      let hasInduction = false;
      try { hasInduction = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='induction_submissions'").get() != null; } catch (e) {}
      if (hasInduction) {
        const indCols = new Set(db.prepare("PRAGMA table_info(induction_submissions)").all().map(c => c.name));
        if (indCols.has('bank_bsb') && indCols.has('bank_account_number') && indCols.has('linked_crew_member_id')) {
          db.exec(`
            UPDATE employees
            SET
              payroll_bsb = CASE WHEN COALESCE(payroll_bsb, '') = '' THEN COALESCE((
                SELECT bank_bsb FROM induction_submissions
                WHERE COALESCE(bank_bsb, '') != ''
                  AND (
                    (linked_crew_member_id IS NOT NULL AND linked_crew_member_id = employees.linked_crew_member_id)
                    OR (COALESCE(employees.email, '') != '' AND LOWER(email) = LOWER(employees.email))
                  )
                ORDER BY id DESC LIMIT 1
              ), '') ELSE payroll_bsb END,
              payroll_account = CASE WHEN COALESCE(payroll_account, '') = '' THEN COALESCE((
                SELECT bank_account_number FROM induction_submissions
                WHERE COALESCE(bank_account_number, '') != ''
                  AND (
                    (linked_crew_member_id IS NOT NULL AND linked_crew_member_id = employees.linked_crew_member_id)
                    OR (COALESCE(employees.email, '') != '' AND LOWER(email) = LOWER(employees.email))
                  )
                ORDER BY id DESC LIMIT 1
              ), '') ELSE payroll_account END
          `);
        }
      }
      recordMigration.run(172, 'employees: backfill payroll_bsb + payroll_account from induction submissions');
      console.log('Migration 172 applied: BSB + Account backfilled from inductions');
    } catch (e) {
      console.error('Migration 172 error:', e.message);
    }
  }

  // =============================================
  // Migration 173: SOP signing sessions + acknowledgements
  // Group in-person inductions: presenter creates a session, attendees sign
  // on their own phones via QR code. Standalone individual sigs also live
  // here (for early-starters / portal-prompt path).
  // =============================================
  if (!isMigrationApplied.get(173)) {
    console.log('Running migration 173: SOP signing sessions + acknowledgements');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sop_signing_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        title TEXT DEFAULT '',
        sop_version TEXT NOT NULL,
        presentation_id INTEGER REFERENCES induction_presentations(id),
        created_by_id INTEGER NOT NULL REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_sop_sessions_token ON sop_signing_sessions(token);

      CREATE TABLE IF NOT EXISTS sop_acknowledgements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER REFERENCES sop_signing_sessions(id),
        crew_member_id INTEGER REFERENCES crew_members(id),
        full_name TEXT NOT NULL,
        email TEXT DEFAULT '',
        sop_version TEXT NOT NULL,
        signature_url TEXT NOT NULL,
        signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        signed_via TEXT DEFAULT 'mobile',
        signed_ip TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_sop_ack_crew ON sop_acknowledgements(crew_member_id);
      CREATE INDEX IF NOT EXISTS idx_sop_ack_session ON sop_acknowledgements(session_id);
      CREATE INDEX IF NOT EXISTS idx_sop_ack_version ON sop_acknowledgements(sop_version);
    `);
    recordMigration.run(173, 'SOP signing sessions + acknowledgements');
    console.log('Migration 173 applied');
  }

  // =============================================
  // Migration 174: target_crew_member_id on sop_signing_sessions
  // Per-person sign links bind a session to one specific crew member so
  // the mobile page locks the name and the recipient can't accidentally
  // sign as someone else.
  // =============================================
  if (!isMigrationApplied.get(174)) {
    console.log('Running migration 174: target_crew_member_id on sop_signing_sessions');
    try { db.exec('ALTER TABLE sop_signing_sessions ADD COLUMN target_crew_member_id INTEGER REFERENCES crew_members(id)'); } catch (e) { /* may exist */ }
    try { db.exec('ALTER TABLE sop_signing_sessions ADD COLUMN sent_to_email TEXT DEFAULT NULL'); } catch (e) { /* may exist */ }
    try { db.exec('ALTER TABLE sop_signing_sessions ADD COLUMN sent_at DATETIME DEFAULT NULL'); } catch (e) { /* may exist */ }
    recordMigration.run(174, 'target_crew_member_id + email tracking on sop_signing_sessions');
    console.log('Migration 174 applied');
  }

  // =============================================
  // Migration 175: induction tracking + online training permission
  // employees.inducted_at = canonical "this person has done the induction"
  // (settable via admin checkbox after in-person, or auto-set when online
  // training quiz passes). employees.online_training_allowed = admin grants
  // a worker permission to take training on their portal.
  // =============================================
  if (!isMigrationApplied.get(175)) {
    console.log('Running migration 175: induction + online training columns on employees');
    try { db.exec('ALTER TABLE employees ADD COLUMN online_training_allowed INTEGER DEFAULT 0'); } catch (e) { /* may exist */ }
    try { db.exec('ALTER TABLE employees ADD COLUMN inducted_at DATETIME'); } catch (e) { /* may exist */ }
    try { db.exec("ALTER TABLE employees ADD COLUMN inducted_method TEXT DEFAULT ''"); } catch (e) { /* may exist */ }
    try { db.exec('ALTER TABLE employees ADD COLUMN inducted_marked_by_id INTEGER REFERENCES users(id)'); } catch (e) { /* may exist */ }
    recordMigration.run(175, 'inducted + online_training_allowed columns on employees');
    console.log('Migration 175 applied');
  }

  // Migration 176: Abergeldie payment sheets — a finance-only "client payment
  // sheet" that imports a Traffio Person Dockets CSV (same shape as the pay
  // run import), keeps only shifts where client_name matches the configured
  // client (default "Abergeldie"), and computes a fee at $X / hour. Lines
  // are stored at the shift level so we can group by project on display.
  if (!isMigrationApplied.get(176)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS abergeldie_payment_sheets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_name TEXT NOT NULL DEFAULT 'Abergeldie',
          period_start DATE NOT NULL,
          period_end DATE NOT NULL,
          label TEXT DEFAULT '',
          csv_filename TEXT DEFAULT '',
          csv_uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          fee_per_hour REAL NOT NULL DEFAULT 1.50,
          notes TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized')),
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aps_period ON abergeldie_payment_sheets(period_start);

        CREATE TABLE IF NOT EXISTS abergeldie_payment_sheet_lines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sheet_id INTEGER NOT NULL REFERENCES abergeldie_payment_sheets(id) ON DELETE CASCADE,
          project_name TEXT NOT NULL DEFAULT '',
          job_number TEXT DEFAULT '',
          person_id TEXT DEFAULT '',
          full_name TEXT NOT NULL,
          shift_date DATE,
          time_on TEXT DEFAULT '',
          time_off TEXT DEFAULT '',
          hours REAL NOT NULL DEFAULT 0,
          fee_per_hour REAL NOT NULL DEFAULT 0,
          fee_total REAL NOT NULL DEFAULT 0,
          booking_address TEXT DEFAULT '',
          booking_id TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aps_lines_sheet ON abergeldie_payment_sheet_lines(sheet_id);
        CREATE INDEX IF NOT EXISTS idx_aps_lines_project ON abergeldie_payment_sheet_lines(sheet_id, project_name);
      `);
      recordMigration.run(176, 'Abergeldie payment sheets + lines');
      console.log('Migration 176 applied: Abergeldie payment sheets');
    } catch (e) {
      console.error('Migration 176 error:', e.message);
    }
  }

  // =============================================
  // Migration 177: SOP / SWMS document library
  // Admin uploads PDFs (or images / docx if needed). Workers see all active
  // docs on the sign page and must tick each before signing. Bumping
  // lib/sop.js CURRENT_VERSION still forces re-acknowledgement.
  // =============================================
  if (!isMigrationApplied.get(177)) {
    console.log('Running migration 177: SOP document library');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sop_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        mime_type TEXT DEFAULT '',
        display_order INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by_id INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sop_documents_active ON sop_documents(active, display_order);
    `);
    recordMigration.run(177, 'SOP document library');
    console.log('Migration 177 applied');
  }

  // Migration 178: Ready-to-pay + Paid status on Abergeldie payment sheets,
  // so finance can tick off each sheet through the billing cycle and see
  // running totals on the index. Both flags default to 0 (not ready / not
  // paid). Audit columns capture who flipped the switch and when.
  if (!isMigrationApplied.get(178)) {
    try {
      const cols = new Set(db.prepare("PRAGMA table_info(abergeldie_payment_sheets)").all().map(c => c.name));
      const addCol = (name, ddl) => {
        if (!cols.has(name)) {
          try { db.exec(`ALTER TABLE abergeldie_payment_sheets ADD COLUMN ${ddl}`); } catch (e) { /* ignore */ }
        }
      };
      addCol('ready_to_pay',       'ready_to_pay INTEGER NOT NULL DEFAULT 0');
      addCol('ready_to_pay_at',    'ready_to_pay_at DATETIME');
      addCol('ready_to_pay_by_id', 'ready_to_pay_by_id INTEGER REFERENCES users(id)');
      addCol('paid',               'paid INTEGER NOT NULL DEFAULT 0');
      addCol('paid_at',            'paid_at DATETIME');
      addCol('paid_by_id',         'paid_by_id INTEGER REFERENCES users(id)');
      recordMigration.run(178, 'abergeldie_payment_sheets: ready_to_pay + paid status flags');
      console.log('Migration 178 applied: Abergeldie ready-to-pay + paid flags');
    } catch (e) {
      console.error('Migration 178 error:', e.message);
    }
  }

  // =============================================
  // Migration 179: store rendered page filenames for SOP PDFs
  // When admin uploads a PDF SOP, the upload handler renders each page to
  // a PNG (via lib/pdf-render.js) and stores the filenames here so the
  // mobile sign page can display them as an inline image stack.
  // =============================================
  if (!isMigrationApplied.get(179)) {
    console.log('Running migration 179: page_renders column on sop_documents');
    try { db.exec("ALTER TABLE sop_documents ADD COLUMN page_renders TEXT DEFAULT NULL"); } catch (e) { /* may exist */ }
    recordMigration.run(179, 'page_renders column on sop_documents');
    console.log('Migration 179 applied');
  }

  // =============================================
  // Migration 180: explicit SOP slug pairing for documents
  // Lets admin pick which SOP "section" a PDF belongs to from a dropdown
  // instead of relying on filename regex. The slug points at an entry in
  // lib/sop-content.js. NULL means unlinked (shows under Reference Docs).
  // =============================================
  if (!isMigrationApplied.get(180)) {
    console.log('Running migration 180: sop_slug column on sop_documents');
    try { db.exec("ALTER TABLE sop_documents ADD COLUMN sop_slug TEXT DEFAULT NULL"); } catch (e) { /* may exist */ }
    recordMigration.run(180, 'sop_slug column on sop_documents');
    console.log('Migration 180 applied');
  }

  // Migration 181: Ute lines on the Abergeldie payment sheet so a single
  // monthly bill can include both worker hours (existing line_type='person')
  // and ute usage (line_type='ute', billed per shift). Utes are grouped by
  // (plate, driver, project_name) — same plate moving between projects
  // becomes multiple lines, which matches what we charge for.
  if (!isMigrationApplied.get(181)) {
    try {
      const sheetCols = new Set(db.prepare("PRAGMA table_info(abergeldie_payment_sheets)").all().map(c => c.name));
      const lineCols  = new Set(db.prepare("PRAGMA table_info(abergeldie_payment_sheet_lines)").all().map(c => c.name));
      const addSheet = (name, ddl) => { if (!sheetCols.has(name)) { try { db.exec(`ALTER TABLE abergeldie_payment_sheets ADD COLUMN ${ddl}`); } catch (e) {} } };
      const addLine  = (name, ddl) => { if (!lineCols.has(name))  { try { db.exec(`ALTER TABLE abergeldie_payment_sheet_lines ADD COLUMN ${ddl}`); } catch (e) {} } };
      addSheet('default_ute_rate_per_shift', 'default_ute_rate_per_shift REAL NOT NULL DEFAULT 0');
      addSheet('utes_csv_filename',          "utes_csv_filename TEXT DEFAULT ''");
      addSheet('utes_uploaded_at',           'utes_uploaded_at DATETIME');
      addLine('line_type',             "line_type TEXT NOT NULL DEFAULT 'person'");
      addLine('plate',                 "plate TEXT DEFAULT ''");
      addLine('vehicle_friendly_name', "vehicle_friendly_name TEXT DEFAULT ''");
      addLine('driver_name',           "driver_name TEXT DEFAULT ''");
      addLine('shift_count',           'shift_count INTEGER DEFAULT 0');
      addLine('rate_per_shift',        'rate_per_shift REAL DEFAULT 0');
      recordMigration.run(181, 'Abergeldie sheet: ute lines (line_type, plate, shift_count, rate_per_shift)');
      console.log('Migration 181 applied: ute lines on Abergeldie sheet');
    } catch (e) {
      console.error('Migration 181 error:', e.message);
    }
  }

  // =============================================
  // Migration 182: description column on sop_documents
  // Lets admin write the section body (intro / bullets / context) shown above
  // the inline PDF on the sign page. HTML allowed; rendered with EJS <%-.
  // Each sop_documents row is treated as one section in the acknowledgement
  // wizard, so admin can build the flow entirely from the admin UI without
  // touching lib/sop-content.js.
  // =============================================
  if (!isMigrationApplied.get(182)) {
    console.log('Running migration 182: description column on sop_documents');
    try { db.exec("ALTER TABLE sop_documents ADD COLUMN description TEXT DEFAULT ''"); } catch (e) { /* may exist */ }
    recordMigration.run(182, 'description column on sop_documents');
    console.log('Migration 182 applied');
  }

  // =============================================
  // Migration 183: Seek applicant tracker
  // Replaces the monthly Excel sheet admin used to keep for SEEK applicant
  // calls. One row per applicant; status moves through New → Contacted →
  // Induction Scheduled → Inducted → Hired (or Not Suitable / Withdrew /
  // No Show). The recruitment page rolls these up into weekly call counts
  // and monthly summary stats.
  // =============================================
  if (!isMigrationApplied.get(183)) {
    console.log('Running migration 183: seek_applicants table');
    db.exec(`
      CREATE TABLE IF NOT EXISTS seek_applicants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        applicant_name TEXT NOT NULL,
        phone TEXT DEFAULT '',
        email TEXT DEFAULT '',
        date_applied DATE,
        date_called DATE,
        called TEXT DEFAULT '',
        interested TEXT DEFAULT '',
        induction_booked TEXT DEFAULT '',
        induction_date DATE,
        status TEXT NOT NULL DEFAULT 'New',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by_id INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_seek_applied ON seek_applicants(date_applied);
      CREATE INDEX IF NOT EXISTS idx_seek_called ON seek_applicants(date_called);
      CREATE INDEX IF NOT EXISTS idx_seek_status ON seek_applicants(status);
    `);
    recordMigration.run(183, 'seek_applicants table');
    console.log('Migration 183 applied');
  }

  // =============================================
  // Migration 184: subtask assignee
  // =============================================
  if (!isMigrationApplied.get(184)) {
    console.log('Running migration 184: subtask assignee');
    try {
      const cols = db.prepare("PRAGMA table_info(subtasks)").all().map(c => c.name);
      if (!cols.includes('assigned_to_id')) {
        db.exec("ALTER TABLE subtasks ADD COLUMN assigned_to_id INTEGER REFERENCES users(id)");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_subtasks_assignee ON subtasks(assigned_to_id)");
      recordMigration.run(184, 'subtask assignee');
      console.log('Migration 184 applied');
    } catch (e) {
      console.error('Migration 184 error:', e.message);
    }
  }

  // =============================================
  // Migration 185: safety_updates + safety_update_reads
  // First half of the worker Safety module — feed of bulletins / alerts.
  // audience_roles is reserved for Phase 2 targeting; empty = visible to all.
  // =============================================
  if (!isMigrationApplied.get(185)) {
    console.log('Running migration 185: safety_updates + reads');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS safety_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'general'
            CHECK(category IN ('general','alert','reminder','toolbox','policy_change')),
          attachment_path TEXT DEFAULT '',
          attachment_original_name TEXT DEFAULT '',
          audience_roles TEXT DEFAULT '',
          audience_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','published','archived')),
          published_at DATETIME,
          published_by_id INTEGER REFERENCES users(id),
          pinned INTEGER NOT NULL DEFAULT 0,
          expires_at DATETIME,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS safety_update_reads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          safety_update_id INTEGER NOT NULL REFERENCES safety_updates(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          read_via TEXT DEFAULT 'web',
          read_ip TEXT DEFAULT '',
          UNIQUE(safety_update_id, crew_member_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_updates_status ON safety_updates(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_updates_pinned ON safety_updates(pinned, published_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sur_crew ON safety_update_reads(crew_member_id)');
      recordMigration.run(185, 'safety_updates + reads');
      console.log('Migration 185 applied');
    } catch (e) {
      console.error('Migration 185 error:', e.message);
    }
  }

  // =============================================
  // Migration 186: swms.version_token + back-fill
  // Token rotates whenever a SWMS file is replaced OR status flips
  // draft -> active. Worker acks are keyed on (swms_id, version_token)
  // so a new token forces a re-ack. Minor edits (title/notes) do NOT
  // rotate the token — that's handled by the route, not the schema.
  // =============================================
  if (!isMigrationApplied.get(186)) {
    console.log('Running migration 186: swms.version_token');
    try {
      const cols = db.prepare("PRAGMA table_info(swms)").all().map(c => c.name);
      if (!cols.includes('version_token')) {
        db.exec("ALTER TABLE swms ADD COLUMN version_token TEXT DEFAULT ''");
      }
      if (!cols.includes('version_published_at')) {
        db.exec("ALTER TABLE swms ADD COLUMN version_published_at DATETIME");
      }
      db.exec(`
        UPDATE swms
        SET version_token = printf('v%d-%s', id, COALESCE(strftime('%s', updated_at), strftime('%s','now')))
        WHERE COALESCE(version_token, '') = ''
      `);
      db.exec(`
        UPDATE swms
        SET version_published_at = COALESCE(updated_at, created_at)
        WHERE version_published_at IS NULL AND status = 'active'
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_swms_version ON swms(version_token)');
      recordMigration.run(186, 'swms.version_token');
      console.log('Migration 186 applied');
    } catch (e) {
      console.error('Migration 186 error:', e.message);
    }
  }

  // =============================================
  // Migration 187: swms_acknowledgements
  // Modelled on sop_acknowledgements. Snapshots full_name so a later
  // crew_member rename doesn't rewrite the audit trail.
  // =============================================
  if (!isMigrationApplied.get(187)) {
    console.log('Running migration 187: swms_acknowledgements');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS swms_acknowledgements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          swms_id INTEGER NOT NULL REFERENCES swms(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          version_token TEXT NOT NULL,
          full_name TEXT NOT NULL,
          signature_url TEXT DEFAULT '',
          signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          signed_via TEXT DEFAULT 'tap',
          signed_ip TEXT DEFAULT '',
          user_agent TEXT DEFAULT '',
          UNIQUE(swms_id, crew_member_id, version_token)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_swms_ack_crew ON swms_acknowledgements(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_swms_ack_swms_ver ON swms_acknowledgements(swms_id, version_token)');
      recordMigration.run(187, 'swms_acknowledgements');
      console.log('Migration 187 applied');
    } catch (e) {
      console.error('Migration 187 error:', e.message);
    }
  }

  // =============================================
  // Migration 188: sop_register (Standard Operating Procedures register)
  // Mirrors the swms table 1:1 — templates vs job-linked, draft/active/
  // archived, expiry tracking, version_token. Lives alongside SWMS in the
  // Safety section. Separate from sop_documents (induction sign-off).
  // =============================================
  if (!isMigrationApplied.get(188)) {
    console.log('Running migration 188: sop_register');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sop_register (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'job' CHECK(kind IN ('template','job')),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          owner_id INTEGER REFERENCES users(id),
          file_path TEXT DEFAULT '',
          file_original_name TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          expiry_date DATE,
          last_reminded_at DATETIME,
          version_token TEXT DEFAULT '',
          version_published_at DATETIME,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_kind    ON sop_register(kind)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_job     ON sop_register(job_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_status  ON sop_register(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_expiry  ON sop_register(expiry_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_version ON sop_register(version_token)');
      recordMigration.run(188, 'sop_register');
      console.log('Migration 188 applied');
    } catch (e) {
      console.error('Migration 188 error:', e.message);
    }
  }

  // =============================================
  // Migration 189: sop_register_acknowledgements
  // Mirrors swms_acknowledgements. Separate from sop_acknowledgements
  // (induction sessions) by design — different lifecycle.
  // =============================================
  if (!isMigrationApplied.get(189)) {
    console.log('Running migration 189: sop_register_acknowledgements');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sop_register_acknowledgements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sop_id INTEGER NOT NULL REFERENCES sop_register(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          version_token TEXT NOT NULL,
          full_name TEXT NOT NULL,
          signature_url TEXT DEFAULT '',
          signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          signed_via TEXT DEFAULT 'tap',
          signed_ip TEXT DEFAULT '',
          user_agent TEXT DEFAULT '',
          UNIQUE(sop_id, crew_member_id, version_token)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_ack_crew    ON sop_register_acknowledgements(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_ack_sop_ver ON sop_register_acknowledgements(sop_id, version_token)');
      recordMigration.run(189, 'sop_register_acknowledgements');
      console.log('Migration 189 applied');
    } catch (e) {
      console.error('Migration 189 error:', e.message);
    }
  }

  // =============================================
  // Migration 190: toolbox_talks + attachments + attendance
  // Phase 2 of the Safety module — archive of past toolbox talks with
  // attendance tracking and a worker "Mark as caught up" flow.
  // (Originally authored as migration 188 on the safety phase chain;
  // renumbered to 190 when merged after the SOP register landed on main.)
  // =============================================
  if (!isMigrationApplied.get(190)) {
    console.log('Running migration 190: toolbox_talks + attendance');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS toolbox_talks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          held_at DATE NOT NULL,
          presenter TEXT DEFAULT '',
          key_points TEXT NOT NULL DEFAULT '',
          slides_path TEXT DEFAULT '',
          slides_original_name TEXT DEFAULT '',
          signon_path TEXT DEFAULT '',
          signon_original_name TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','published','archived')),
          published_at DATETIME,
          published_by_id INTEGER REFERENCES users(id),
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS toolbox_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          toolbox_id INTEGER NOT NULL REFERENCES toolbox_talks(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_original_name TEXT DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'photo'
            CHECK(kind IN ('photo','doc')),
          uploaded_by_id INTEGER REFERENCES users(id),
          uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS toolbox_attendance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          toolbox_id INTEGER NOT NULL REFERENCES toolbox_talks(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'attended'
            CHECK(status IN ('attended','caught_up')),
          -- recorded_by_id is NULL when the worker self-marks "caught up";
          -- populated with the admin user_id when an office user marks attendance.
          recorded_by_id INTEGER REFERENCES users(id),
          recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(toolbox_id, crew_member_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_talks_status ON toolbox_talks(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_talks_held ON toolbox_talks(held_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_attach_tb ON toolbox_attachments(toolbox_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_att_crew ON toolbox_attendance(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_att_tb ON toolbox_attendance(toolbox_id)');
      recordMigration.run(190, 'toolbox_talks + attendance');
      console.log('Migration 190 applied');
    } catch (e) {
      console.error('Migration 190 error:', e.message);
    }
  }

  // =============================================
  // Migration 191: safety_comments + attachments + anonymous salt
  // Phase 2b — worker -> office channel for hazard flags, SWMS issues,
  // suggestions, equipment concerns, general comments. When the worker
  // submits anonymously, crew_member_id is NULL on the row and only the
  // deterministic submitter_token is stored. The salt for the token lives
  // in system_config under 'anonymous_comment_salt'; helpers in
  // lib/anonymousToken.js read it.
  // (Originally authored as migration 189; renumbered to 191 on merge.)
  // =============================================
  if (!isMigrationApplied.get(191)) {
    console.log('Running migration 191: safety_comments + anonymous salt');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS safety_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          -- NULL on anonymous rows. Joining to crew_members must never
          -- happen on a row where is_anonymous=1.
          crew_member_id INTEGER REFERENCES crew_members(id) ON DELETE SET NULL,
          -- Deterministic hash of (crew_member_id + salt). Set on every row
          -- (anon or not) so the worker portal can list its own submissions
          -- without re-using crew_member_id on anon rows.
          submitter_token TEXT NOT NULL,
          is_anonymous INTEGER NOT NULL DEFAULT 0,
          category TEXT NOT NULL DEFAULT 'general'
            CHECK(category IN ('hazard','swms_issue','suggestion','equipment','general')),
          body TEXT NOT NULL,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'submitted'
            CHECK(status IN ('submitted','acknowledged','under_review','closed')),
          assigned_to_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          internal_notes TEXT DEFAULT '',                -- office-only, never returned to worker
          office_response TEXT DEFAULT '',               -- visible to worker
          response_at DATETIME,
          response_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          submitted_ip TEXT DEFAULT '',
          user_agent TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS safety_comment_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          comment_id INTEGER NOT NULL REFERENCES safety_comments(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_original_name TEXT DEFAULT '',
          uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_comments_status ON safety_comments(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_comments_token ON safety_comments(submitter_token)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_comments_crew ON safety_comments(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_comments_created ON safety_comments(created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_comment_attach ON safety_comment_attachments(comment_id)');

      // Generate and store the anonymous-token salt if not present. system_config
      // is already used for VAPID + push subscriptions; reuse it here.
      try {
        const existing = db.prepare("SELECT config_value FROM system_config WHERE config_key = 'anonymous_comment_salt'").get();
        if (!existing || !existing.config_value) {
          const salt = require('crypto').randomBytes(32).toString('hex');
          db.prepare(`
            INSERT OR IGNORE INTO system_config (config_key, config_value, config_type, description)
            VALUES ('anonymous_comment_salt', ?, 'secret', 'Salt used to derive worker submitter_token on safety_comments rows. Never log or expose.')
          `).run(salt);
        }
      } catch (e) {
        console.error('Migration 191 salt seed error:', e.message);
      }

      recordMigration.run(191, 'safety_comments + anonymous salt');
      console.log('Migration 191 applied');
    } catch (e) {
      console.error('Migration 191 error:', e.message);
    }
  }

  // =============================================
  // Migration 192: safety_quizzes + questions + attempts + answers
  // Phase 3a — knowledge-check quizzes (MCQ single + true/false in v1).
  // Save-and-resume is supported by writing answers as the worker
  // progresses; an attempt sits in_progress until they hit submit.
  // (Originally authored as migration 190; renumbered to 192 on merge.)
  // =============================================
  if (!isMigrationApplied.get(192)) {
    console.log('Running migration 192: safety_quizzes + attempts');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS safety_quizzes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          pass_mark INTEGER NOT NULL DEFAULT 80,            -- percentage (0-100)
          retake_policy TEXT NOT NULL DEFAULT 'unlimited'
            CHECK(retake_policy IN ('none','unlimited','limited')),
          retake_limit INTEGER,                              -- NULL when policy != 'limited'
          deadline_at DATETIME,
          is_mandatory INTEGER NOT NULL DEFAULT 0,
          -- Optional source-content link. When source_type='toolbox' and the
          -- worker passes, we INSERT OR IGNORE a 'caught_up' attendance row
          -- so the quiz functions as a catch-up mechanism.
          source_type TEXT
            CHECK(source_type IN ('toolbox','swms','update') OR source_type IS NULL),
          source_id INTEGER,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','published','archived')),
          published_at DATETIME,
          published_by_id INTEGER REFERENCES users(id),
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS safety_quiz_questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quiz_id INTEGER NOT NULL REFERENCES safety_quizzes(id) ON DELETE CASCADE,
          question_text TEXT NOT NULL,
          question_type TEXT NOT NULL DEFAULT 'mcq_single'
            CHECK(question_type IN ('mcq_single','true_false')),
          -- For mcq_single: JSON array of {text, is_correct} objects (2-6 options).
          -- For true_false: ignored on write; the route enforces 2 fixed options.
          options_json TEXT NOT NULL DEFAULT '[]',
          -- For true_false: 'true' or 'false'. For mcq_single: the index (0-based)
          -- of the correct option. Stored alongside options_json so grading is
          -- a simple equality check without re-parsing the JSON each time.
          correct_value TEXT NOT NULL DEFAULT '',
          explanation TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS safety_quiz_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quiz_id INTEGER NOT NULL REFERENCES safety_quizzes(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'in_progress'
            CHECK(status IN ('in_progress','submitted')),
          score_pct INTEGER,                                  -- NULL until submitted
          passed INTEGER,                                     -- NULL until submitted
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          submitted_at DATETIME,
          UNIQUE(quiz_id, crew_member_id, attempt_number)
        );

        CREATE TABLE IF NOT EXISTS safety_quiz_answers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          attempt_id INTEGER NOT NULL REFERENCES safety_quiz_attempts(id) ON DELETE CASCADE,
          question_id INTEGER NOT NULL REFERENCES safety_quiz_questions(id) ON DELETE CASCADE,
          -- The worker's answer. For mcq_single: the option index as a string.
          -- For true_false: 'true' or 'false'.
          answer_value TEXT DEFAULT '',
          is_correct INTEGER,                                 -- NULL while in_progress
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(attempt_id, question_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_quizzes_status ON safety_quizzes(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_quizzes_source ON safety_quizzes(source_type, source_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_quiz_q_quiz ON safety_quiz_questions(quiz_id, sort_order)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_quiz_att_crew ON safety_quiz_attempts(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_quiz_att_quiz ON safety_quiz_attempts(quiz_id, status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_safety_quiz_ans_attempt ON safety_quiz_answers(attempt_id)');
      recordMigration.run(192, 'safety_quizzes + attempts');
      console.log('Migration 192 applied');
    } catch (e) {
      console.error('Migration 192 error:', e.message);
    }
  }

  // =============================================
  // Migration 193: sop_register safety net for phase-chain dev DBs
  // Some dev databases ran the safety phase chain's original numbering
  // (188 = toolbox, 189 = comments, 190 = quizzes) before this merge.
  // On those DBs the new 188/189 blocks above are skipped because the
  // migrations table already has rows for 188/189 — so sop_register and
  // sop_register_acknowledgements would never get created. This runs the
  // SOP register DDL as idempotent CREATE IF NOT EXISTS to catch them.
  // No-op on a clean DB or on production (tables already exist).
  // =============================================
  if (!isMigrationApplied.get(193)) {
    console.log('Running migration 193: sop_register safety net');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sop_register (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'job' CHECK(kind IN ('template','job')),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          owner_id INTEGER REFERENCES users(id),
          file_path TEXT DEFAULT '',
          file_original_name TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          expiry_date DATE,
          last_reminded_at DATETIME,
          version_token TEXT DEFAULT '',
          version_published_at DATETIME,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sop_register_acknowledgements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sop_id INTEGER NOT NULL REFERENCES sop_register(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          version_token TEXT NOT NULL,
          full_name TEXT NOT NULL,
          signature_url TEXT DEFAULT '',
          signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          signed_via TEXT DEFAULT 'tap',
          signed_ip TEXT DEFAULT '',
          user_agent TEXT DEFAULT '',
          UNIQUE(sop_id, crew_member_id, version_token)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_kind    ON sop_register(kind)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_job     ON sop_register(job_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_status  ON sop_register(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_expiry  ON sop_register(expiry_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_version ON sop_register(version_token)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_ack_crew    ON sop_register_acknowledgements(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sop_register_ack_sop_ver ON sop_register_acknowledgements(sop_id, version_token)');
      recordMigration.run(193, 'sop_register safety net');
      console.log('Migration 193 applied');
    } catch (e) {
      console.error('Migration 193 error:', e.message);
    }
  }

  // =============================================
  // Migration 194: task_comment_mentions + task_watchers
  // Lets office users @mention each other in task comments and watch a
  // task without being assigned to it. Mention insert ALSO inserts the
  // watcher row so the mentioned person can open the task and follow
  // progress. Watchers can be added/removed manually by an owner/admin.
  // =============================================
  if (!isMigrationApplied.get(194)) {
    console.log('Running migration 194: task_comment_mentions + task_watchers');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_comment_mentions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          comment_id INTEGER NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
          mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(comment_id, mentioned_user_id)
        );
        CREATE TABLE IF NOT EXISTS task_watchers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          -- 'mention' = auto-added because they were @mentioned;
          -- 'manual'  = explicitly added by an owner / admin.
          source TEXT NOT NULL DEFAULT 'mention'
            CHECK(source IN ('mention','manual')),
          added_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(task_id, user_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_comment_mentions_user ON task_comment_mentions(mentioned_user_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_comment_mentions_comment ON task_comment_mentions(comment_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_watchers_user ON task_watchers(user_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_watchers_task ON task_watchers(task_id)');
      recordMigration.run(194, 'task_comment_mentions + task_watchers');
      console.log('Migration 194 applied');
    } catch (e) {
      console.error('Migration 194 error:', e.message);
    }
  }

  // =============================================
  // Migration 195: Backfill employee_competencies from existing
  // licence / ticket documents.
  //
  // employee_documents has held white_card and tc_licence uploads for a
  // while, but only induction-approval submissions (and now manual HR
  // uploads, going forward) create the matching employee_competencies
  // row. Workers / employees added before that change have the file but
  // no competency, so they don't appear in the licences register, the
  // expiry tracker, or the worker wallet's certifications list.
  //
  // This migration mirrors any existing white_card / tc_licence document
  // into a competency row, skipping employees that already have one of
  // that type so we don't duplicate hand-keyed records. Mapping matches
  // lib/competencyMap.js.
  // =============================================
  if (!isMigrationApplied.get(195)) {
    console.log('Running migration 195: backfill competencies from existing licence/ticket docs');
    try {
      const result = db.prepare(`
        INSERT INTO employee_competencies (
          employee_id, competency_type, competency_name, competency_level,
          issue_date, expiry_date, status, mandatory_for_role,
          linked_document_id, notes
        )
        SELECT
          ed.employee_id,
          CASE ed.document_type
            WHEN 'white_card' THEN 'white_card'
            WHEN 'tc_licence' THEN 'traffic_ticket'
          END,
          CASE ed.document_type
            WHEN 'white_card' THEN 'SafeWork NSW White Card'
            WHEN 'tc_licence' THEN 'Traffic Control and IMP Licenses'
          END,
          '',
          ed.issue_date,
          ed.expiry_date,
          CASE
            WHEN ed.expiry_date IS NOT NULL AND ed.expiry_date < DATE('now') THEN 'expired'
            WHEN ed.expiry_date IS NOT NULL AND ed.expiry_date <= DATE('now', '+30 days') THEN 'expiring_soon'
            ELSE 'valid'
          END,
          1,
          ed.id,
          'Backfilled from existing document (migration 195)'
        FROM employee_documents ed
        WHERE ed.document_type IN ('white_card', 'tc_licence')
          AND NOT EXISTS (
            SELECT 1 FROM employee_competencies ec
            WHERE ec.employee_id = ed.employee_id
              AND ec.competency_type = CASE ed.document_type
                WHEN 'white_card' THEN 'white_card'
                WHEN 'tc_licence' THEN 'traffic_ticket'
              END
          )
      `).run();
      console.log(`Migration 195: backfilled ${result.changes} competency rows from existing documents`);
      recordMigration.run(195, 'backfill competencies from existing licence/ticket docs');
    } catch (e) {
      console.error('Migration 195 error:', e.message);
    }
  }

  // =============================================
  // Migration 196: Drop the `-1` suffix on sub-plans that are the only
  // one of their type within a parent. Convention now: 1 of a type = bare
  // ref (TSTGS3100); 2+ of a type = bare + -2, -3, … (TSTGS3100, TSTGS3100-2).
  // Titles default to the ref string, so when title == old ref we update
  // it too. The "Other" case stores titles like "<label> (<ref>)", so we
  // patch the parenthesised ref there as well.
  // =============================================
  if (!isMigrationApplied.get(196)) {
    try {
      const rows = db.prepare(`
        SELECT c1.id, c1.reference_number, c1.title
        FROM compliance c1
        WHERE c1.parent_id IS NOT NULL
          AND c1.reference_number LIKE '%-1'
          AND (SELECT COUNT(*) FROM compliance c2 WHERE c2.parent_id = c1.parent_id AND c2.item_type = c1.item_type) = 1
      `).all();
      const upd = db.prepare("UPDATE compliance SET reference_number = ?, title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      let renamed = 0;
      rows.forEach(r => {
        const oldRef = r.reference_number;
        const newRef = oldRef.replace(/-1$/, '');
        let newTitle = r.title;
        if (r.title === oldRef) newTitle = newRef;
        else if (r.title && r.title.includes(`(${oldRef})`)) newTitle = r.title.replace(`(${oldRef})`, `(${newRef})`);
        upd.run(newRef, newTitle, r.id);
        renamed += 1;
      });
      recordMigration.run(196, 'compliance refs: drop -1 suffix for single-of-a-type sub-plans');
      console.log(`Migration 196 applied: dropped -1 suffix from ${renamed} single-of-a-type sub-plan ref(s)`);
    } catch (e) {
      console.error('Migration 196 error:', e.message);
    }
  }

  // =============================================
  // Migration 197: Normalise traffic_plans.file_path + plan_revisions.file_path
  // to the public URL form `uploads/<filename>`. Older rows stored multer's
  // absolute disk path (e.g. /app/public/uploads/foo.pdf on Railway); the
  // EJS template prepended a '/' to that, producing //app/... which
  // browsers parse as protocol-relative (host = "app") and DNS-fail.
  // After this migration every row holds just `uploads/<filename>` so the
  // template renders /uploads/<filename> — a valid static URL.
  // =============================================
  if (!isMigrationApplied.get(197)) {
    try {
      const stripToUploads = (raw) => {
        if (!raw) return raw;
        const norm = String(raw).replace(/\\/g, '/');
        const idx = norm.lastIndexOf('uploads/');
        if (idx >= 0) return norm.slice(idx);
        const base = norm.split('/').pop();
        return base ? 'uploads/' + base : norm;
      };

      let fixedTp = 0;
      try {
        const tpRows = db.prepare("SELECT id, file_path FROM traffic_plans WHERE file_path IS NOT NULL AND file_path != ''").all();
        const updTp = db.prepare("UPDATE traffic_plans SET file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        tpRows.forEach(r => {
          const fixed = stripToUploads(r.file_path);
          if (fixed !== r.file_path) { updTp.run(fixed, r.id); fixedTp += 1; }
        });
      } catch (e) { console.log('Migration 197: traffic_plans skipped:', e.message); }

      let fixedRev = 0;
      try {
        const revRows = db.prepare("SELECT id, file_path FROM plan_revisions WHERE file_path IS NOT NULL AND file_path != ''").all();
        const updRev = db.prepare("UPDATE plan_revisions SET file_path = ? WHERE id = ?");
        revRows.forEach(r => {
          const fixed = stripToUploads(r.file_path);
          if (fixed !== r.file_path) { updRev.run(fixed, r.id); fixedRev += 1; }
        });
      } catch (e) { console.log('Migration 197: plan_revisions skipped:', e.message); }

      recordMigration.run(197, 'normalise traffic_plans / plan_revisions file_path to uploads/<filename>');
      console.log(`Migration 197 applied: normalised ${fixedTp} traffic_plans + ${fixedRev} plan_revisions file_path(s)`);
    } catch (e) {
      console.error('Migration 197 error:', e.message);
    }
  }

  // =============================================
  // Migration 198: Resync every parent Plan's rolled-up status from its
  // sub-plans. Prior versions of the bulk-status endpoint and the regular
  // edit-save handler didn't call syncParentStatus, so parents drifted out
  // of step with their children (sub-plan went to 'submitted' but the
  // parent stayed on 'started'). The route fixes the going-forward bug;
  // this migration repairs the data state once.
  // =============================================
  if (!isMigrationApplied.get(198)) {
    try {
      const planStatus = require('../lib/planStatus');
      const parents = db.prepare("SELECT id FROM compliance WHERE parent_id IS NULL AND plan_number IS NOT NULL").all();
      let resynced = 0;
      parents.forEach(p => {
        try { planStatus.syncParentStatus(db, p.id); resynced += 1; } catch (e) { /* skip individual failures */ }
      });
      recordMigration.run(198, 'resync parent Plan statuses from their sub-plans');
      console.log(`Migration 198 applied: resynced ${resynced} parent Plan status(es) from sub-plans`);
    } catch (e) {
      console.error('Migration 198 error:', e.message);
    }
  }

  // =============================================
  // Migration 199: Risk Assessments — link to compliance sub-plan +
  // form-template support. Adds `compliance_id` so an RA can be tied to
  // the TGS sub-plan it covers (NULL = legacy uploaded-file RAs).
  // `template_type` distinguishes 'tgs_risk_options' (the new
  // dashboard-fillable form) from legacy NULL rows. `responses_json` is
  // the form payload; `combined_pdf_path` is the merged RA+TGS file that
  // becomes the sub-plan's attachment after Generate Combined PDF.
  // =============================================
  if (!isMigrationApplied.get(199)) {
    try {
      const cols = db.prepare("PRAGMA table_info(risk_assessments)").all().map(c => c.name);
      const addCol = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE risk_assessments ADD COLUMN ${name} ${def}`); };
      addCol('compliance_id', 'INTEGER REFERENCES compliance(id) ON DELETE CASCADE');
      addCol('template_type', 'TEXT DEFAULT NULL');
      addCol('responses_json', 'TEXT DEFAULT NULL');
      addCol('combined_pdf_path', 'TEXT DEFAULT NULL');
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_risk_assessments_compliance ON risk_assessments(compliance_id)'); } catch (e) {}
      recordMigration.run(199, 'risk_assessments: add compliance_id, template_type, responses_json, combined_pdf_path');
      console.log('Migration 199 applied: risk_assessments columns added for TGS RA form');
    } catch (e) {
      console.error('Migration 199 error:', e.message);
    }
  }

  // =============================================
  // Migration 200: SWMS competency grants + access requests
  // Job-linked SWMS are no longer visible to all workers by default.
  // - crew_swms_grants: a crew member has been granted access to a
  //   job-linked SWMS (either by admin approving a request, or by
  //   admin manually attaching it as a competency).
  // - crew_swms_access_requests: a worker has requested access to a
  //   job-linked SWMS (claiming they completed the induction with us
  //   or the client). Admin reviews from the License & Competencies
  //   tab on the crew profile.
  // =============================================
  if (!isMigrationApplied.get(200)) {
    console.log('Running migration 200: crew_swms_grants + crew_swms_access_requests');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS crew_swms_grants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          swms_id INTEGER NOT NULL REFERENCES swms(id) ON DELETE CASCADE,
          granted_by_id INTEGER REFERENCES users(id),
          granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','request_approved')),
          notes TEXT DEFAULT '',
          UNIQUE(crew_member_id, swms_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_crew_swms_grants_crew ON crew_swms_grants(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_crew_swms_grants_swms ON crew_swms_grants(swms_id)');

      db.exec(`
        CREATE TABLE IF NOT EXISTS crew_swms_access_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          swms_id INTEGER NOT NULL REFERENCES swms(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
          worker_note TEXT DEFAULT '',
          inducted_with TEXT DEFAULT '',
          induction_date DATE,
          decided_by_id INTEGER REFERENCES users(id),
          decided_at DATETIME,
          decision_note TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_swms_access_req_crew   ON crew_swms_access_requests(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_swms_access_req_swms   ON crew_swms_access_requests(swms_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_swms_access_req_status ON crew_swms_access_requests(status)');
      recordMigration.run(200, 'crew_swms_grants + crew_swms_access_requests');
      console.log('Migration 200 applied');
    } catch (e) {
      console.error('Migration 200 error:', e.message);
    }
  }

  // =============================================
  // Migration 201: worker_notification_prefs
  // Per-category opt-in/out for worker push notifications. Defaults are
  // "enabled" — a missing row means the worker hasn't customised that
  // category yet, so the push sender treats it as on.
  //
  // Categories (initial set, extensible):
  //   swms_update, sop_update, safety_update, toolbox, quiz,
  //   shift_reminder, shift_change, kudos, dm, comment_response,
  //   cert_expiry, payday
  // =============================================
  if (!isMigrationApplied.get(201)) {
    console.log('Running migration 201: worker_notification_prefs');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worker_notification_prefs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'push' CHECK(channel IN ('push','email')),
          enabled INTEGER NOT NULL DEFAULT 1,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(crew_member_id, category, channel)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_worker_notif_prefs_crew ON worker_notification_prefs(crew_member_id)');
      recordMigration.run(201, 'worker_notification_prefs');
      console.log('Migration 201 applied');
    } catch (e) {
      console.error('Migration 201 error:', e.message);
    }
  }

  // =============================================
  // Migration 202: cert_expiry_reminder_log
  // Dedup table for the daily cert-expiry push: a row gets inserted per
  // (crew_member_id, item_key, days_out) so we don't fire the same 14-day
  // warning twice. crew_members.licence_expiry → item_key 'licence', etc.
  // =============================================
  if (!isMigrationApplied.get(202)) {
    console.log('Running migration 202: cert_expiry_reminder_log');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cert_expiry_reminder_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          item_key TEXT NOT NULL,
          days_out INTEGER NOT NULL,
          expiry_date DATE,
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(crew_member_id, item_key, days_out, expiry_date)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_cert_expiry_log_crew ON cert_expiry_reminder_log(crew_member_id)');
      recordMigration.run(202, 'cert_expiry_reminder_log');
      console.log('Migration 202 applied');
    } catch (e) {
      console.error('Migration 202 error:', e.message);
    }
  }

  // =============================================
  // Migration 203: training_completions.crew_member_id
  // Group-induction quiz writes a row per ticked attendee. The original
  // table only had employee_id, but not every crew_member has a linked
  // employees row, so attendees without that link were getting orphan
  // rows (employee_id=null) that didn't surface on their profile.
  // Add crew_member_id so completions are always retrievable.
  // =============================================
  if (!isMigrationApplied.get(203)) {
    console.log('Running migration 203: training_completions.crew_member_id');
    try {
      const cols = db.prepare("PRAGMA table_info(training_completions)").all().map(c => c.name);
      if (!cols.includes('crew_member_id')) {
        db.exec("ALTER TABLE training_completions ADD COLUMN crew_member_id INTEGER REFERENCES crew_members(id)");
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_tc_crew ON training_completions(crew_member_id)');
      recordMigration.run(203, 'training_completions.crew_member_id');
      console.log('Migration 203 applied');
    } catch (e) {
      console.error('Migration 203 error:', e.message);
    }
  }

  // =============================================
  // Migration 204: Toolbox attendance — sessions + absence reason
  // - new table toolbox_attendance_sessions: one token per toolbox so we
  //   can share a public attendance link with workers (precedent:
  //   sop_signing_sessions).
  // - new column toolbox_attendance.absence_reason: nullable; set when
  //   a worker confirms they can't attend.
  // The existing status enum had 'attended' | 'caught_up'; we now also
  // allow 'absent' to represent "marked themselves as not attending".
  // =============================================
  if (!isMigrationApplied.get(204)) {
    console.log('Running migration 204: toolbox attendance sessions + absence_reason');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS toolbox_attendance_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL UNIQUE,
          toolbox_id INTEGER NOT NULL REFERENCES toolbox_talks(id) ON DELETE CASCADE,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          closed_at DATETIME
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_session_toolbox ON toolbox_attendance_sessions(toolbox_id)');
      const cols = db.prepare("PRAGMA table_info(toolbox_attendance)").all().map(c => c.name);
      if (!cols.includes('absence_reason')) {
        db.exec("ALTER TABLE toolbox_attendance ADD COLUMN absence_reason TEXT");
      }
      recordMigration.run(204, 'toolbox_attendance_sessions + absence_reason');
      console.log('Migration 204 applied');
    } catch (e) {
      console.error('Migration 204 error:', e.message);
    }
  }

  // =============================================
  // Migration 205: toolbox_invitees
  // Scopes a toolbox talk to a specific list of crew members. When rows
  // exist for a toolbox_id, ONLY those workers appear on the public
  // attendance picker, the admin's worker-profile Toolbox Meetings tab,
  // and the worker-portal list. Empty (no rows) means "open to everyone"
  // — preserves prior behaviour for existing toolboxes.
  // =============================================
  if (!isMigrationApplied.get(205)) {
    console.log('Running migration 205: toolbox_invitees');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS toolbox_invitees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          toolbox_id INTEGER NOT NULL REFERENCES toolbox_talks(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(toolbox_id, crew_member_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_invitees_toolbox ON toolbox_invitees(toolbox_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_invitees_crew ON toolbox_invitees(crew_member_id)');
      recordMigration.run(205, 'toolbox_invitees');
      console.log('Migration 205 applied');
    } catch (e) {
      console.error('Migration 205 error:', e.message);
    }
  }

  // =============================================
  // Migration 206: dedupe crew_members by email
  // The HR Linked Workforce flow auto-creates a crew_members row when
  // the admin enables portal access. If a seeded crew_members row
  // already existed for that worker (demo data) AND the email didn't
  // match exactly (whitespace, case, or a typo), the linker created a
  // SECOND row. Result: two "Salif Hoque" entries in pickers, login
  // sometimes hits the row WITHOUT the PIN.
  // For each group of crew_members sharing the same LOWER(email), pick
  // the canonical row (has pin_hash > active > recent login > newest)
  // and mark the rest as active=0 + clear their email so they don't
  // appear in picker queries or match login lookups. Non-destructive.
  // =============================================
  if (!isMigrationApplied.get(206)) {
    console.log('Running migration 206: dedupe crew_members by email');
    try {
      const groups = db.prepare(`
        SELECT LOWER(email) AS lemail, COUNT(*) AS n
        FROM crew_members
        WHERE email IS NOT NULL AND TRIM(email) <> ''
        GROUP BY LOWER(email)
        HAVING n > 1
      `).all();
      let deactivated = 0;
      for (const g of groups) {
        const rows = db.prepare(`
          SELECT id, pin_hash, active, last_worker_login
          FROM crew_members
          WHERE LOWER(email) = ?
          ORDER BY (pin_hash IS NOT NULL AND pin_hash != '') DESC,
                   (active = 1) DESC,
                   (last_worker_login IS NOT NULL) DESC,
                   last_worker_login DESC,
                   id DESC
        `).all(g.lemail);
        // First row is the winner; deactivate the rest and blank their
        // email so they stop matching login + picker queries.
        for (let i = 1; i < rows.length; i++) {
          db.prepare("UPDATE crew_members SET active = 0, email = '' WHERE id = ?").run(rows[i].id);
          deactivated++;
        }
      }
      recordMigration.run(206, 'dedupe crew_members by email');
      console.log(`Migration 206 applied: deactivated ${deactivated} duplicate crew_members row(s)`);
    } catch (e) {
      console.error('Migration 206 error:', e.message);
    }
  }

  // =============================================
  // Migration 207: backfill crew_members.full_name from employees
  // HR profile edits employees.full_name; crew_members.full_name was
  // not synced. Pickers + the public attendance link read off
  // crew_members.full_name, so capitalising someone's HR name didn't
  // propagate. Going forward both edit handlers mirror; this one-shot
  // brings legacy rows into sync.
  // =============================================
  if (!isMigrationApplied.get(207)) {
    console.log('Running migration 207: backfill crew_members.full_name from employees');
    try {
      const result = db.prepare(`
        UPDATE crew_members
        SET full_name = (
          SELECT e.full_name FROM employees e
          WHERE e.linked_crew_member_id = crew_members.id
            AND e.deleted_at IS NULL
            AND e.full_name IS NOT NULL
            AND TRIM(e.full_name) <> ''
          ORDER BY e.id DESC LIMIT 1
        )
        WHERE EXISTS (
          SELECT 1 FROM employees e
          WHERE e.linked_crew_member_id = crew_members.id
            AND e.deleted_at IS NULL
            AND e.full_name IS NOT NULL
            AND TRIM(e.full_name) <> ''
            AND e.full_name != crew_members.full_name
        )
      `).run();
      recordMigration.run(207, 'backfill crew_members.full_name from employees');
      console.log(`Migration 207 applied: synced ${result.changes} crew_members name(s) from linked employees`);
    } catch (e) {
      console.error('Migration 207 error:', e.message);
    }
  }

  // =============================================
  // Migration 208: re-link employees to surviving crew_members
  // Migration 206 deactivated duplicate crew_members rows. If the
  // employees.linked_crew_member_id was pointing at the loser, the HR
  // profile is now wired to a deactivated row with cleared email — and
  // the "Email Invite" button fails with "Crew member needs an email
  // address". Re-link each affected employees row to the surviving
  // crew_members row matched by email.
  // =============================================
  if (!isMigrationApplied.get(208)) {
    console.log('Running migration 208: re-link employees to surviving crew_members');
    try {
      const broken = db.prepare(`
        SELECT e.id AS emp_id, e.email AS emp_email
        FROM employees e
        JOIN crew_members cm ON cm.id = e.linked_crew_member_id
        WHERE e.linked_crew_member_id IS NOT NULL
          AND e.deleted_at IS NULL
          AND e.email IS NOT NULL AND TRIM(e.email) <> ''
          AND (cm.active = 0 OR cm.email IS NULL OR TRIM(cm.email) = '')
      `).all();
      let relinked = 0;
      const findCanonical = db.prepare(`
        SELECT id FROM crew_members
        WHERE active = 1 AND LOWER(email) = LOWER(?)
        ORDER BY (pin_hash IS NOT NULL AND pin_hash != '') DESC, id DESC
        LIMIT 1
      `);
      const updateLink = db.prepare(
        'UPDATE employees SET linked_crew_member_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      );
      for (const row of broken) {
        const canonical = findCanonical.get(row.emp_email);
        if (canonical) { updateLink.run(canonical.id, row.emp_id); relinked++; }
      }
      recordMigration.run(208, 're-link employees to surviving crew_members');
      console.log(`Migration 208 applied: re-linked ${relinked} employees to surviving crew_members`);
    } catch (e) {
      console.error('Migration 208 error:', e.message);
    }
  }

  // =============================================
  // Migration 209: sop_document_files — multiple PDFs per section.
  // Adds a child table so each SOP/SWMS section can hold N files instead of
  // one. Backfilled from the parent row's existing file_path. The parent
  // columns (filename, file_path, page_renders, ...) are kept populated so
  // older code paths that still read them keep working until they're
  // migrated to the new shape.
  //
  // page_renders_dir: directory key under data/uploads/sop-documents/page-renders/
  //   - Legacy/backfilled rows reuse the parent doc id (so the existing
  //     PNGs at page-renders/<doc_id>/ remain reachable without copying).
  //   - New rows use 'file-<file_id>'.
  // =============================================
  if (!isMigrationApplied.get(209)) {
    console.log('Running migration 209: sop_document_files (multi-PDF sections)');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sop_document_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sop_document_id INTEGER NOT NULL REFERENCES sop_documents(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          original_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER DEFAULT 0,
          mime_type TEXT DEFAULT '',
          page_renders TEXT DEFAULT NULL,
          page_renders_dir TEXT NOT NULL DEFAULT '',
          display_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_sop_document_files_doc ON sop_document_files(sop_document_id, display_order);
      `);
      // Backfill: one child file per existing section, copying the parent's
      // file metadata. page_renders_dir is set to the parent's id (string)
      // so the existing on-disk PNGs at .../page-renders/<doc_id>/ are
      // located correctly by the file-level routes below.
      const parents = db.prepare(`
        SELECT id, filename, original_name, file_path, file_size, mime_type, page_renders
        FROM sop_documents
      `).all();
      const insertChild = db.prepare(`
        INSERT INTO sop_document_files
          (sop_document_id, filename, original_name, file_path, file_size, mime_type,
           page_renders, page_renders_dir, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);
      const existsChild = db.prepare(
        'SELECT 1 FROM sop_document_files WHERE sop_document_id = ? LIMIT 1'
      );
      let backfilled = 0;
      for (const p of parents) {
        if (existsChild.get(p.id)) continue;
        if (!p.filename || !p.file_path) continue;
        insertChild.run(
          p.id, p.filename, p.original_name || p.filename, p.file_path,
          p.file_size || 0, p.mime_type || '',
          p.page_renders || null, String(p.id)
        );
        backfilled++;
      }
      recordMigration.run(209, 'sop_document_files (multi-PDF sections)');
      console.log(`Migration 209 applied: sop_document_files created, ${backfilled} sections backfilled`);
    } catch (e) {
      console.error('Migration 209 error:', e.message);
    }
  }

  // Migration 210: standalone TGS Risk & Options Assessments under Plans.
  // Separate from risk_assessments — these are filled in the Planning area,
  // exported as PDF, and optionally attached to a traffic_plans row later
  // via plan_revisions. plan_id is nullable so the form can be drafted
  // before any plan exists.
  if (!isMigrationApplied.get(210)) {
    console.log('Running migration 210: tgs_risk_assessments table');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tgs_risk_assessments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id INTEGER REFERENCES traffic_plans(id) ON DELETE SET NULL,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          title TEXT DEFAULT '',
          tgs_ref_no TEXT DEFAULT '',
          status TEXT DEFAULT 'draft',
          responses_json TEXT DEFAULT '{}',
          residual_risk TEXT DEFAULT NULL,
          requires_one_up INTEGER DEFAULT 0,
          pdf_path TEXT DEFAULT '',
          pdf_generated_at DATETIME DEFAULT NULL,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_tgs_ra_plan_id ON tgs_risk_assessments(plan_id);
        CREATE INDEX IF NOT EXISTS idx_tgs_ra_job_id ON tgs_risk_assessments(job_id);
        CREATE INDEX IF NOT EXISTS idx_tgs_ra_status ON tgs_risk_assessments(status);
      `);
      recordMigration.run(210, 'tgs_risk_assessments standalone table');
      console.log('Migration 210 applied: tgs_risk_assessments table created');
    } catch (e) {
      console.error('Migration 210 error:', e.message);
    }
  }

  // =============================================
  // Migration 211: birthday_messages — coworker birthday wishes.
  // Each worker can leave AT MOST ONE message per coworker per birthday,
  // enforced by the UNIQUE constraint below. The birthday_date column
  // is the Sydney-local YYYY-MM-DD of the birthday, so the same worker
  // can wish the same person every subsequent year without colliding.
  // =============================================
  if (!isMigrationApplied.get(211)) {
    console.log('Running migration 211: birthday_messages');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS birthday_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          from_crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          birthday_date TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(from_crew_member_id, target_crew_member_id, birthday_date)
        );
        CREATE INDEX IF NOT EXISTS idx_birthday_messages_target
          ON birthday_messages(target_crew_member_id, birthday_date);
      `);
      recordMigration.run(211, 'birthday_messages');
      console.log('Migration 211 applied: birthday_messages table created');
    } catch (e) {
      console.error('Migration 211 error:', e.message);
    }
  }

  // =============================================
  // Migration 212: User Notes — personal notes / reminders / meeting
  // discussion items with selective sharing. user_notes is the row, with a
  // freeform `content`, a `note_date` (day-journal grouping defaults to
  // today), and a `tag` (note / reminder / meeting). Default visibility is
  // private to the author. user_note_shares is the per-user share list —
  // a note is visible to user U iff created_by_id = U OR a share row
  // exists for U. is_shared mirrors share-list non-emptiness for fast
  // filtering without a join.
  // =============================================
  if (!isMigrationApplied.get(212)) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS user_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        note_date DATE NOT NULL,
        tag TEXT NOT NULL DEFAULT 'note' CHECK(tag IN ('note','reminder','meeting')),
        is_shared INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_user_notes_creator_date ON user_notes(created_by_id, note_date)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_user_notes_date ON user_notes(note_date)');
      db.exec(`CREATE TABLE IF NOT EXISTS user_note_shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES user_notes(id) ON DELETE CASCADE,
        shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(note_id, shared_with_user_id)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_user_note_shares_user ON user_note_shares(shared_with_user_id)');
      recordMigration.run(212, 'user_notes + user_note_shares (personal notes with selective sharing)');
      console.log('Migration 212 applied: user_notes + user_note_shares created');
    } catch (e) {
      console.error('Migration 212 error:', e.message);
    }
  }

  // =============================================
  // Migration 213: training_records — in-house training log.
  // Free-text training_name so admin can add ad-hoc course types
  // (Portaboom, Trailer, Spotter, etc.) without first creating a
  // master row. Keyed on crew_member_id so the worker-side safety
  // tab can read it without an employees join. employee_id is kept
  // for HR convenience but is denormalised — crew_member_id is the
  // source of truth.
  // =============================================
  if (!isMigrationApplied.get(213)) {
    console.log('Running migration 213: training_records');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS training_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
          training_name TEXT NOT NULL,
          completed_date TEXT,
          expiry_date TEXT,
          trainer_name TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          certificate_url TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by_id INTEGER REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_training_records_crew ON training_records(crew_member_id, completed_date DESC);
        CREATE INDEX IF NOT EXISTS idx_training_records_employee ON training_records(employee_id);
      `);
      recordMigration.run(213, 'training_records');
      console.log('Migration 213 applied: training_records table created');
    } catch (e) {
      console.error('Migration 213 error:', e.message);
    }
  }

  // =============================================
  // Migration 214: PIN lockout for worker portal + force-change for named
  // seed admin accounts.
  //
  // (a) Adds pin_failed_attempts + pin_locked_until columns on crew_members
  //     so routes/worker/auth.js can lock an Employee ID after N wrong
  //     PINs. The existing global 10/15min limiter is per-IP — useless
  //     against a distributed brute force of a 4-digit PIN. Per-account
  //     lockout closes that gap.
  // (b) Migration 81 already flagged 'admin' (admin123) and the demo
  //     *_user accounts (password). It missed the named-admin seed users
  //     suhail.a / saadat / savanah / taj which were seeded with
  //     individual but well-known dev passwords. Flag them too so they
  //     can't slip through to production with the seed password intact.
  // =============================================
  if (!isMigrationApplied.get(214)) {
    console.log('Running migration 214: PIN lockout cols + flag named-admin seeds');
    try { db.exec("ALTER TABLE crew_members ADD COLUMN pin_failed_attempts INTEGER DEFAULT 0"); } catch(e) { /* exists */ }
    try { db.exec("ALTER TABLE crew_members ADD COLUMN pin_locked_until DATETIME"); } catch(e) { /* exists */ }

    const SEED_GUESSES = {
      'suhail.a': 'Suhail123',
      'saadat':   'TandS2026.',
      'savanah':  'Savanah123',
      'taj':      'Taj123',
    };
    try {
      for (const [username, seedPw] of Object.entries(SEED_GUESSES)) {
        const u = db.prepare('SELECT id, password_hash, must_change_password FROM users WHERE username = ?').get(username);
        if (u && !u.must_change_password && bcrypt.compareSync(seedPw, u.password_hash)) {
          db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(u.id);
          console.log(`Migration 214: flagged ${username} for password change (seed password still in use)`);
        }
      }
    } catch (e) { console.error('Migration 214 flag step error:', e.message); }
    recordMigration.run(214, 'PIN lockout cols + flag named-admin seeds');
  }

  // =============================================
  // Migration 215: VOC (Verification of Competency) tables.
  // voc_templates is the per-equipment definition (theory questions list +
  // practical checklist + default validity). voc_assessments stores each
  // filled record (worker + assessor + theory/practical responses +
  // outcome). Phase 2 fields (certificate_id, certificate_status,
  // pdf_path, revoke metadata) ship in this migration so Phase 2 won't
  // need a schema change. Seeds six empty equipment templates — admins
  // fill the question/checklist content via /voc-templates.
  // =============================================
  if (!isMigrationApplied.get(215)) {
    console.log('Running migration 215: voc_templates + voc_assessments');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS voc_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_key TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          default_validity_months INTEGER NOT NULL DEFAULT 24,
          theory_questions_json TEXT NOT NULL DEFAULT '[]',
          practical_checklist_json TEXT NOT NULL DEFAULT '[]',
          active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_by_id INTEGER REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS voc_assessments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          voc_number TEXT UNIQUE,
          template_id INTEGER NOT NULL REFERENCES voc_templates(id),
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          assessor_user_id INTEGER REFERENCES users(id),
          manager_user_id INTEGER REFERENCES users(id),
          assessment_type TEXT,
          assessment_type_other_text TEXT DEFAULT '',
          assessment_date DATE,
          location_site TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          outcome TEXT,
          prerequisites_json TEXT NOT NULL DEFAULT '{}',
          worker_details_json TEXT NOT NULL DEFAULT '{}',
          theory_responses_json TEXT NOT NULL DEFAULT '[]',
          theory_correct_count INTEGER DEFAULT 0,
          theory_total INTEGER DEFAULT 0,
          theory_pass INTEGER DEFAULT 0,
          practical_responses_json TEXT NOT NULL DEFAULT '[]',
          practical_pass INTEGER DEFAULT 0,
          valid_from DATE,
          valid_until DATE,
          reassessment_trigger TEXT DEFAULT '',
          assessor_comments TEXT DEFAULT '',
          worker_signed_name TEXT DEFAULT '',
          worker_signed_date DATE,
          assessor_signed_name TEXT DEFAULT '',
          assessor_signed_date DATE,
          manager_signed_name TEXT DEFAULT '',
          manager_signed_position TEXT DEFAULT '',
          manager_signed_date DATE,
          records_filed_yes INTEGER DEFAULT 0,
          records_filed_by TEXT DEFAULT '',
          records_filed_date DATE,
          copy_to_worker_yes INTEGER DEFAULT 0,
          matrix_entered_by TEXT DEFAULT '',
          certificate_id TEXT,
          certificate_status TEXT DEFAULT 'active',
          certificate_revoked_at DATETIME,
          certificate_revoked_by INTEGER REFERENCES users(id),
          certificate_revoked_reason TEXT DEFAULT '',
          pdf_path TEXT DEFAULT '',
          pdf_generated_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_by_id INTEGER REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_voc_crew ON voc_assessments(crew_member_id);
        CREATE INDEX IF NOT EXISTS idx_voc_template ON voc_assessments(template_id);
        CREATE INDEX IF NOT EXISTS idx_voc_status ON voc_assessments(status, outcome);
        CREATE INDEX IF NOT EXISTS idx_voc_valid_until ON voc_assessments(valid_until);
        CREATE INDEX IF NOT EXISTS idx_voc_certificate ON voc_assessments(certificate_id);
      `);

      // Seed six equipment templates with empty content (admins fill via UI).
      const seeds = [
        ['traffic_control_vehicle',   'Traffic Control Vehicle Operations'],
        ['drop_deck_vehicle',          'Drop Deck Vehicle Operations'],
        ['trailer_hitch_unhitch',      'Hitching and Unhitching a Trailer'],
        ['portable_boom_gate',         'Portable Boom Gate Operations'],
        ['light_tower',                'Light Tower Operations'],
        ['portable_vms',               'Portable Variable Message Sign (VMS) Operations'],
      ];
      const insTpl = db.prepare(`
        INSERT OR IGNORE INTO voc_templates (item_key, name, sort_order, default_validity_months)
        VALUES (?, ?, ?, 24)
      `);
      seeds.forEach((row, i) => insTpl.run(row[0], row[1], i + 1));

      recordMigration.run(215, 'voc_templates + voc_assessments');
      console.log('Migration 215 applied: voc_templates + voc_assessments created, 6 templates seeded');
    } catch (e) {
      console.error('Migration 215 error:', e.message);
    }
  }

  // =============================================
  // Migration 216: backfill site_audits.job_id from project_site.
  //
  // Before the /audits/draft autosave was fixed to carry job_id, drafts
  // were inserted unlinked. If a user submitted from the edit screen
  // without re-picking the job (project_site was auto-filled, so it
  // looked linked), the audit landed in the register with job_id NULL
  // and never surfaced in the job's Safety tab. This backfill walks
  // orphan audits and links them when project_site contains exactly
  // one known job_number as a substring — a confident match. Audits
  // with zero or ambiguous matches are left alone so they don't get
  // mis-linked.
  // =============================================
  if (!isMigrationApplied.get(216)) {
    console.log('Running migration 216: backfill site_audits.job_id from project_site');
    try {
      const orphans = db.prepare(`
        SELECT id, project_site FROM site_audits
        WHERE job_id IS NULL AND TRIM(COALESCE(project_site, '')) <> ''
      `).all();
      const allJobs = db.prepare(`
        SELECT id, job_number FROM jobs WHERE TRIM(COALESCE(job_number, '')) <> ''
      `).all();
      const update = db.prepare('UPDATE site_audits SET job_id = ? WHERE id = ?');
      let linked = 0, ambiguous = 0, unmatched = 0;
      for (const a of orphans) {
        const haystack = (a.project_site || '').toLowerCase();
        const hits = allJobs.filter(j => haystack.includes(j.job_number.toLowerCase()));
        if (hits.length === 1) {
          update.run(hits[0].id, a.id);
          linked++;
        } else if (hits.length > 1) {
          ambiguous++;
        } else {
          unmatched++;
        }
      }
      console.log(`Migration 216 applied: backfilled job_id on ${linked} site_audits (${ambiguous} ambiguous, ${unmatched} no match, ${orphans.length} total orphans)`);
      recordMigration.run(216, 'backfill site_audits.job_id from project_site');
    } catch (e) {
      console.error('Migration 216 error:', e.message);
    }
  }

  // =============================================
  // Migration 217: relax toolbox_attendance CHECK to allow 'attending'
  // and 'absent'.
  //
  // Original constraint was CHECK(status IN ('attended','caught_up')).
  // Migration 204 introduced 'absent' as a worker-side state via the
  // public picker but never updated the constraint, so 'absent' inserts
  // were failing CHECK in some paths. PR #378 adds 'attending' (worker
  // has accepted the invite but hasn't been ticked off yet). Bundle
  // both into a single rewrite of the table since SQLite can't ALTER
  // a CHECK constraint in place.
  // =============================================
  if (!isMigrationApplied.get(217)) {
    console.log('Running migration 217: relax toolbox_attendance CHECK');
    try {
      db.exec(`
        CREATE TABLE toolbox_attendance__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          toolbox_id INTEGER NOT NULL REFERENCES toolbox_talks(id) ON DELETE CASCADE,
          crew_member_id INTEGER NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'attending'
            CHECK(status IN ('attending','attended','caught_up','absent')),
          recorded_by_id INTEGER REFERENCES users(id),
          recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          absence_reason TEXT,
          UNIQUE(toolbox_id, crew_member_id)
        );
        INSERT INTO toolbox_attendance__new
          (id, toolbox_id, crew_member_id, status, recorded_by_id, recorded_at, absence_reason)
        SELECT id, toolbox_id, crew_member_id, status, recorded_by_id, recorded_at, absence_reason
        FROM toolbox_attendance;
        DROP TABLE toolbox_attendance;
        ALTER TABLE toolbox_attendance__new RENAME TO toolbox_attendance;
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_att_crew ON toolbox_attendance(crew_member_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_att_tb ON toolbox_attendance(toolbox_id)');
      recordMigration.run(217, 'toolbox_attendance CHECK + attending/absent');
      console.log('Migration 217 applied: toolbox_attendance status now allows attending/absent');
    } catch (e) {
      console.error('Migration 217 error:', e.message);
    }
  }

  // =============================================
  // Migration 218: Promote weather + GPS to first-class columns on incidents.
  //
  // The worker portal incident form (routes/worker/incidents.js) reads
  // weather_conditions, gps_lat, gps_lng from req.body but used to smash
  // them into the free-text location / persons_involved fields — workable
  // for display, useless for filtering, sorting, or charting. Add real
  // columns so the data is queryable. ALTER ADD COLUMN is idempotent
  // here (wrapped in try/catch). Existing rows get NULL — historical
  // weather/GPS still readable inside the legacy text columns.
  // =============================================
  if (!isMigrationApplied.get(218)) {
    console.log('Running migration 218: weather + GPS columns on incidents');
    try {
      try { db.exec("ALTER TABLE incidents ADD COLUMN weather_conditions TEXT DEFAULT ''"); } catch (e) { /* column may exist */ }
      try { db.exec("ALTER TABLE incidents ADD COLUMN gps_lat REAL"); } catch (e) { /* column may exist */ }
      try { db.exec("ALTER TABLE incidents ADD COLUMN gps_lng REAL"); } catch (e) { /* column may exist */ }
      recordMigration.run(218, 'weather_conditions + gps_lat + gps_lng columns on incidents');
      console.log('Migration 218 applied: incidents now has dedicated weather + GPS columns');
    } catch (e) {
      console.error('Migration 218 error:', e.message);
    }
  }

  // =============================================
  // Migration 219: swms_expiry_reminder_log
  //
  // Companion to services/swmsExpiryReminders.js. The cron fires reminders
  // at 30 / 14 / 7 days before swms.expiry_date and dedupes via this table
  // so re-running the job same-day (or hitting the same window after a
  // process restart) doesn't spam office staff. Unique tuple is
  // (swms_id, days_out, expiry_date) — if the SWMS gets its expiry
  // extended, the next window's reminder is a different expiry_date so it
  // fires again, which is what we want.
  // =============================================
  if (!isMigrationApplied.get(219)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS swms_expiry_reminder_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          swms_id INTEGER NOT NULL REFERENCES swms(id) ON DELETE CASCADE,
          days_out INTEGER NOT NULL,
          expiry_date DATE NOT NULL,
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(swms_id, days_out, expiry_date)
        );
        CREATE INDEX IF NOT EXISTS idx_swms_exp_log_swms ON swms_expiry_reminder_log(swms_id);
      `);
      recordMigration.run(219, 'swms_expiry_reminder_log table');
      console.log('Migration 219 applied: swms_expiry_reminder_log');
    } catch (e) {
      console.error('Migration 219 error:', e.message);
    }
  }

  // =============================================
  // Migration 220: Workshop tables (Safety > Workshops).
  //
  // Office-crew workshop tool: a facilitator opens a session from the admin
  // dashboard, participants scan a QR code on their phones, each gets a
  // random case (A–D) and works through 8 questions, live leaderboard on
  // the meeting-room screen.
  //
  // Four tables:
  //   workshop_definitions  — one row per workshop type. Seeded with swms-01.
  //   workshop_sessions     — a workshop run; session_code is the QR target.
  //   workshop_assignments  — which case each player claimed (sticky by
  //                           name within a session — refresh keeps you on
  //                           the same case).
  //   workshop_attempts     — one row per completed attempt
  //                           (score + raw answers_json for later analysis).
  //
  // All CREATE TABLE statements are IF NOT EXISTS; the seed is INSERT OR
  // IGNORE. Safe on prod and idempotent on re-run.
  // =============================================
  if (!isMigrationApplied.get(220)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workshop_definitions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS workshop_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workshop_id INTEGER NOT NULL REFERENCES workshop_definitions(id) ON DELETE CASCADE,
          facilitator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          session_code TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','archived')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          closed_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_workshop_sessions_code ON workshop_sessions(session_code);
        CREATE INDEX IF NOT EXISTS idx_workshop_sessions_status ON workshop_sessions(status);

        CREATE TABLE IF NOT EXISTS workshop_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES workshop_sessions(id) ON DELETE CASCADE,
          player_name TEXT NOT NULL,
          case_letter TEXT NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, player_name)
        );
        CREATE INDEX IF NOT EXISTS idx_workshop_assignments_session ON workshop_assignments(session_id);

        CREATE TABLE IF NOT EXISTS workshop_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER REFERENCES workshop_sessions(id) ON DELETE CASCADE,
          workshop_id INTEGER NOT NULL REFERENCES workshop_definitions(id),
          case_letter TEXT NOT NULL,
          player_name TEXT NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          score INTEGER NOT NULL DEFAULT 0,
          max_score INTEGER NOT NULL DEFAULT 0,
          answers_json TEXT,
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_workshop_attempts_session ON workshop_attempts(session_id);
        CREATE INDEX IF NOT EXISTS idx_workshop_attempts_workshop ON workshop_attempts(workshop_id);
      `);
      // Seed the swms-01 workshop definition. INSERT OR IGNORE keeps re-runs
      // safe — if the slug already exists (manual edit, restored DB), we
      // leave the existing row alone.
      db.prepare(`
        INSERT OR IGNORE INTO workshop_definitions (slug, title, description)
        VALUES (?, ?, ?)
      `).run(
        'swms-01',
        'SWMS 01 — Mini-SWMS Challenge',
        'Office crew exercise: four real traffic incidents, eight questions each. Tests recall and application of SWMS 01 Traffic Operations v3.0 (11 May 2026).'
      );
      recordMigration.run(220, 'workshop_* tables + swms-01 seed');
      console.log('Migration 220 applied: workshop tables created and swms-01 seeded');
    } catch (e) {
      console.error('Migration 220 error:', e.message);
    }
  }

  // =============================================
  // Migration 221: link seek_applicants to crew_members + backfill Hired
  //
  // Before this, an applicant moved to status='Hired' on the Recruitment
  // tab was never converted into a crew_members row, so they never showed
  // up on the roster. Add a linked_crew_member_id column to track the
  // conversion (idempotent on re-saves) and backfill anyone currently
  // marked Hired without a link.
  // =============================================
  if (!isMigrationApplied.get(221)) {
    console.log('Running migration 221: seek_applicants.linked_crew_member_id + Hired backfill');
    try {
      try { db.exec("ALTER TABLE seek_applicants ADD COLUMN linked_crew_member_id INTEGER REFERENCES crew_members(id)"); } catch (e) { /* column may exist */ }

      const { convertSeekApplicantToCrew } = require('../lib/seekApplicantConverter');
      const orphans = db.prepare(
        "SELECT * FROM seek_applicants WHERE LOWER(status) = 'hired' AND linked_crew_member_id IS NULL"
      ).all();
      let converted = 0;
      for (const applicant of orphans) {
        try {
          convertSeekApplicantToCrew(db, applicant);
          converted++;
        } catch (e) {
          console.error(`Migration 221: failed to convert seek_applicant id=${applicant.id} (${applicant.applicant_name}):`, e.message);
        }
      }
      recordMigration.run(221, 'seek_applicants.linked_crew_member_id + Hired backfill');
      console.log(`Migration 221 applied: backfilled ${converted}/${orphans.length} Hired applicants into crew_members`);
    } catch (e) {
      console.error('Migration 221 error:', e.message);
    }
  }

  // =============================================
  // Migration 222: Worker-driven attendance sign-off on toolbox meetings.
  //
  // Reworks the status flow so it reflects the real lifecycle the team
  // wants to capture:
  //   - Pending      (no row yet — invite link sent, no response)
  //   - Attending    (worker RSVP'd yes via the invite link or worker app)
  //   - Attended     (worker signed off post-meeting; signed_off_at +
  //                   signature_data populated)
  //   - Absent       (status='attending' AND held_at in the past with no
  //                   signed_off_at — i.e. said they'd come, didn't sign)
  //                   — pure display state, not stored
  //   - Not attending (status='absent' — worker declined the invite)
  //   - Caught up    (status='caught_up' — self-claim after the fact)
  //
  // Two structural moves:
  //   1. Add signed_off_at + signature_data columns so 'attended' can be
  //      gated on a real worker sign-off rather than admin tick alone.
  //   2. One-time backfill: every existing status='attended' row is
  //      downgraded to 'attending'. Reason: the legacy public RSVP picker
  //      and admin bulk-tick both wrote 'attended' without any sign-off,
  //      so the historical rows don't represent what the new model means
  //      by Attended. Recorded_at is preserved as the original RSVP /
  //      tick time so audit history isn't lost.
  // =============================================
  if (!isMigrationApplied.get(222)) {
    console.log('Running migration 222: toolbox sign-off columns + status backfill');
    try {
      const cols = db.prepare('PRAGMA table_info(toolbox_attendance)').all().map(c => c.name);
      if (!cols.includes('signed_off_at')) {
        db.exec('ALTER TABLE toolbox_attendance ADD COLUMN signed_off_at DATETIME');
      }
      if (!cols.includes('signature_data')) {
        db.exec('ALTER TABLE toolbox_attendance ADD COLUMN signature_data TEXT');
      }
      // Backfill: every legacy 'attended' row → 'attending'. The new flow
      // requires a worker signature to reach 'attended', so historical
      // ticks are surfaced as "Attending" until/unless the worker signs
      // off in the portal.
      const downgraded = db.prepare(
        "UPDATE toolbox_attendance SET status = 'attending' WHERE status = 'attended'"
      ).run();
      recordMigration.run(222, 'toolbox_attendance sign-off cols + legacy attended → attending');
      console.log(`Migration 222 applied: ${downgraded.changes} legacy 'attended' rows downgraded to 'attending'`);
    } catch (e) {
      console.error('Migration 222 error:', e.message);
    }
  }

  // =============================================
  // Migration 223: allow 'prep' kind on toolbox_attachments.
  //
  // The existing CHECK constraint pins kind ∈ ('photo','doc'). Adds a
  // third value, 'prep', for pre-meeting documents workers can review
  // before attending — distinct from the post-attendance 'doc' rows
  // (added in PR #423) which only unlock after sign-off. SQLite can't
  // ALTER a CHECK constraint in place, so rebuild the table.
  // =============================================
  if (!isMigrationApplied.get(223)) {
    console.log('Running migration 223: toolbox_attachments allow kind=prep');
    try {
      db.exec(`
        CREATE TABLE toolbox_attachments__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          toolbox_id INTEGER NOT NULL REFERENCES toolbox_talks(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_original_name TEXT DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'photo'
            CHECK(kind IN ('photo','doc','prep')),
          uploaded_by_id INTEGER REFERENCES users(id),
          uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO toolbox_attachments__new
          (id, toolbox_id, file_path, file_original_name, kind, uploaded_by_id, uploaded_at)
        SELECT id, toolbox_id, file_path, file_original_name, kind, uploaded_by_id, uploaded_at
        FROM toolbox_attachments;
        DROP TABLE toolbox_attachments;
        ALTER TABLE toolbox_attachments__new RENAME TO toolbox_attachments;
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_toolbox_attach_tb ON toolbox_attachments(toolbox_id)');
      recordMigration.run(223, "toolbox_attachments CHECK extended to allow 'prep'");
      console.log("Migration 223 applied: toolbox_attachments.kind now accepts 'prep'");
    } catch (e) {
      console.error('Migration 223 error:', e.message);
    }
  }

  // =============================================
  // Migration 224: Workshop group mode.
  //
  // Adds a 'group' mode to workshop sessions so the office can split a
  // crowd into pre-assigned teams (one team per case) instead of every
  // participant playing alone. Two structural moves:
  //   1. workshop_sessions.mode    — 'individual' (existing behaviour,
  //      default) or 'group' (new flow).
  //   2. workshop_assignments      — add members_csv (comma-separated
  //      names that make up the team) and claimed_by_name (the first
  //      participant who tapped this group on the join screen).
  //
  // In group mode the admin creates one workshop_assignments row per
  // group at session-creation time (player_name='Group 1', case_letter
  // randomly pre-assigned, members_csv = the team roster). When a
  // participant scans the QR, they see the list of groups + members,
  // tap theirs, and the row's claimed_by_name flips from NULL to the
  // tapper's name.
  // =============================================
  if (!isMigrationApplied.get(224)) {
    console.log('Running migration 224: workshop group mode columns');
    try {
      const sCols = db.prepare('PRAGMA table_info(workshop_sessions)').all().map(c => c.name);
      if (!sCols.includes('mode')) {
        db.exec("ALTER TABLE workshop_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'individual'");
      }
      const aCols = db.prepare('PRAGMA table_info(workshop_assignments)').all().map(c => c.name);
      if (!aCols.includes('members_csv')) {
        db.exec('ALTER TABLE workshop_assignments ADD COLUMN members_csv TEXT');
      }
      if (!aCols.includes('claimed_by_name')) {
        db.exec('ALTER TABLE workshop_assignments ADD COLUMN claimed_by_name TEXT');
      }
      recordMigration.run(224, 'workshop group mode columns');
      console.log('Migration 224 applied: workshop sessions can now run in group mode');
    } catch (e) {
      console.error('Migration 224 error:', e.message);
    }
  }

  // =============================================
  // Migration 231: employee_reviews — notes + full performance reviews
  // attached to an employee, with optional worker-portal visibility.
  // NOTE: originally gated on version 225, but version 225 was already
  // claimed by the FY26 Wage Panel migration on existing databases, so
  // this block silently skipped on every fresh deploy. Renumbered to
  // 231 — CREATE TABLE IF NOT EXISTS keeps it idempotent on DBs where
  // the table happened to be created under an earlier history.
  // =============================================
  if (!isMigrationApplied.get(231)) {
    console.log('Running migration 231: employee_reviews');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS employee_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','review')),
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          review_date TEXT,
          held_by TEXT NOT NULL DEFAULT '',
          visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','worker')),
          sections_json TEXT NOT NULL DEFAULT '[]',
          peer_comments_json TEXT NOT NULL DEFAULT '[]',
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_employee_reviews_employee ON employee_reviews(employee_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_employee_reviews_visibility ON employee_reviews(visibility);');
      recordMigration.run(231, 'employee_reviews');
      console.log('Migration 231 applied: employee_reviews table ready');
    } catch (e) {
      console.error('Migration 231 error:', e.message);
    }
  }

  // =============================================
  // Migration 226: FY26 Internal Wage Panel
  //   T&S operates a six-tier framework (Trainee TC → Site Supervisor)
  //   that supersedes the granular CW/ECW classifications for the day-to-
  //   day office workflow. Each tier has three rate cards (Cash, ABN,
  //   TFN/Award) with different shift breakdowns:
  //
  //     ABN  — Day / Sat / (Night|Sun|PH)               + $18 travel
  //     Cash — (Day|Sat) / (Night|Sun|PH)               + $15 travel
  //     TFN  — base + Sat≤2h / Sat>2h / Sun / PH /
  //              Night<5 / Night Perm / Night 5+        (award fares used)
  //
  //   Plus a global allowance table (fares, meal, first aid, leading
  //   hand %, km rates, industry allowance) that's editable from the
  //   admin without code changes.
  // =============================================
  if (!isMigrationApplied.get(226)) {
    console.log('Running migration 226: FY26 Internal Wage Panel (tier presets + allowances)');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS wage_tier_presets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tier INTEGER NOT NULL CHECK(tier BETWEEN 1 AND 6),
          payment_type TEXT NOT NULL CHECK(payment_type IN ('cash','abn','tfn')),
          role_label TEXT NOT NULL DEFAULT '',
          award_mapping TEXT NOT NULL DEFAULT '',
          qualifications TEXT NOT NULL DEFAULT '',
          rate_day REAL NOT NULL DEFAULT 0,
          rate_sat_short REAL NOT NULL DEFAULT 0,
          rate_sat_long REAL NOT NULL DEFAULT 0,
          rate_sun REAL NOT NULL DEFAULT 0,
          rate_public_holiday REAL NOT NULL DEFAULT 0,
          rate_night REAL NOT NULL DEFAULT 0,
          rate_night_perm REAL NOT NULL DEFAULT 0,
          rate_night_5plus REAL NOT NULL DEFAULT 0,
          travel_allowance REAL NOT NULL DEFAULT 0,
          effective_from DATE NOT NULL DEFAULT '2026-07-01',
          effective_to DATE,
          active INTEGER NOT NULL DEFAULT 1,
          notes TEXT NOT NULL DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tier, payment_type, effective_from)
        );
        CREATE INDEX IF NOT EXISTS idx_wtp_tier_payment ON wage_tier_presets(tier, payment_type);
        CREATE INDEX IF NOT EXISTS idx_wtp_active ON wage_tier_presets(active, effective_from);

        CREATE TABLE IF NOT EXISTS award_allowances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          amount REAL NOT NULL DEFAULT 0,
          unit TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          effective_from DATE NOT NULL DEFAULT '2026-07-01',
          active INTEGER NOT NULL DEFAULT 1,
          display_order INTEGER NOT NULL DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_award_allow_active ON award_allowances(active, display_order);
      `);

      // Seed tier presets — FY26 (effective 2026-07-01), straight from the
      // Internal Wage Panel v1.0 PDF. UNIQUE constraint on (tier, payment_type,
      // effective_from) makes this idempotent across reruns.
      const FY = '2026-07-01';
      const TIER_META = {
        1: { role: 'Trainee TC',         award: 'CW1(a)',          quals: 'RIIWHS205 only, first 90 days' },
        2: { role: 'Traffic Controller', award: 'CW1(c)',          quals: 'RIIWHS205 + 90+ days experience' },
        3: { role: 'Advanced TC / TMA',  award: 'CW2 / CW3',       quals: 'RIIWHS302 + MR/HR licence' },
        4: { role: 'Team Leader',        award: 'CW3 + Leading Hand', quals: 'Small crew leadership' },
        5: { role: 'Senior Team Leader', award: 'CW4 + Leading Hand', quals: 'Multi-crew leadership' },
        6: { role: 'Site Supervisor',    award: 'CW5 + Leading Hand', quals: 'Full project oversight' },
      };

      const ABN_RATES = {
        1: [31, 33, 40, 18],
        2: [33, 36, 41, 18],
        3: [35, 38, 43, 18],
        4: [38, 40, 45, 18],
        5: [40, 42, 47, 18],
        6: [43, 45, 50, 18],
      };
      const CASH_RATES = {
        1: [30, 37, 15],
        2: [31, 38, 15],
        3: [33, 40, 15],
        4: [35, 42, 15],
        5: [37, 44, 15],
        6: [40, 47, 15],
      };
      const TFN_RATES = {
        1: [33.94, 47.51, 61.09, 61.09, 74.66, 47.51, 42.08, 38.01],
        2: [35.00, 49.00, 63.00, 63.00, 77.00, 49.00, 43.40, 39.20],
        3: [36.26, 50.77, 65.27, 65.27, 79.78, 50.77, 44.97, 40.61],
        4: [37.26, 52.17, 67.07, 67.07, 81.98, 52.17, 46.21, 41.73],
        5: [38.36, 53.71, 69.05, 69.05, 84.40, 53.71, 47.57, 42.97],
        6: [39.48, 55.27, 71.06, 71.06, 86.85, 55.27, 48.95, 44.21],
      };

      const insertPreset = db.prepare(`
        INSERT OR IGNORE INTO wage_tier_presets
          (tier, payment_type, role_label, award_mapping, qualifications,
           rate_day, rate_sat_short, rate_sat_long, rate_sun, rate_public_holiday,
           rate_night, rate_night_perm, rate_night_5plus, travel_allowance,
           effective_from, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);

      let seeded = 0;
      for (let t = 1; t <= 6; t++) {
        const meta = TIER_META[t];
        const [aDay, aSat, aNight, aTravel] = ABN_RATES[t];
        insertPreset.run(t, 'abn', meta.role, meta.award, meta.quals,
          aDay, aSat, aSat, aNight, aNight, aNight, 0, 0, aTravel, FY);
        seeded++;
        const [cDay, cNight, cTravel] = CASH_RATES[t];
        insertPreset.run(t, 'cash', meta.role, meta.award, meta.quals,
          cDay, cDay, cDay, cNight, cNight, cNight, 0, 0, cTravel, FY);
        seeded++;
        const [tBase, tSatShort, tSatLong, tSun, tPH, tNight, tNightPerm, tNight5] = TFN_RATES[t];
        insertPreset.run(t, 'tfn', meta.role, meta.award, meta.quals,
          tBase, tSatShort, tSatLong, tSun, tPH, tNight, tNightPerm, tNight5, 0, FY);
        seeded++;
      }
      if (seeded) console.log(`Migration 226: seeded ${seeded} wage_tier_presets rows (FY26)`);

      const insertAllow = db.prepare(`
        INSERT OR IGNORE INTO award_allowances
          (code, label, amount, unit, notes, effective_from, active, display_order)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `);
      const ALLOWANCES = [
        ['fares_daily',          'Fares and travel',          21.94, 'per_day',  'All-purpose, paid for each day worked.',                              10],
        ['meal',                 'Meal — while travelling',   19.00, 'per_meal', 'Where the worker is required to travel for the job and/or 9.5hrs+ shift.', 20],
        ['first_aid_basic',      'First aid — basic',          3.85, 'per_day',  'Min qualifications, where nominated to provide first aid.',           30],
        ['first_aid_higher',     'First aid — higher',         6.09, 'per_day',  'Higher than minimum first aid qualifications.',                       40],
        ['leading_hand_1',       'Leading hand — 1 person',    2.4,  'percent',  'Of highest-class rate supervised, or own rate (whichever higher).',   50],
        ['leading_hand_2_5',     'Leading hand — 2 to 5',      5.3,  'percent',  'Same basis. Applies to all hours worked.',                            60],
        ['leading_hand_6_10',    'Leading hand — 6 to 10',     6.7,  'percent',  'Same basis. Applies to all hours worked.',                            70],
        ['leading_hand_10_plus', 'Leading hand — 10+',         9.0,  'percent',  'Same basis. Applies to all hours worked.',                            80],
        ['distant_work_km',      'Distant work — own vehicle', 0.59, 'per_km',   'Plus travel time at ordinary rate, half-hour minimum per return.',    90],
        ['site_to_site_km',      'Site-to-site — own vehicle', 0.98, 'per_km',   'Plus paid travel time between sites.',                                100],
        ['industry_allowance',   'Industry allowance',         1.69, 'per_hour', 'Already included in the casual TFN rates above.',                     110],
      ];
      let allowSeeded = 0;
      for (const [code, label, amount, unit, notes, order] of ALLOWANCES) {
        const r = insertAllow.run(code, label, amount, unit, notes, FY, order);
        if (r.changes) allowSeeded++;
      }
      if (allowSeeded) console.log(`Migration 226: seeded ${allowSeeded} award_allowances rows`);

      recordMigration.run(226, 'FY26 Internal Wage Panel: 6-tier × 3-payment presets + global allowances');
      console.log('Migration 226 applied');
    } catch (e) {
      console.error('Migration 226 error:', e.message);
    }
  }

  // =============================================
  // Migration 227: Wire wage tiers into employees + induction submissions
  //   - employees.tier (1-6, nullable): which row of the FY26 panel the
  //     worker sits on. Drives the rate stamp from wage_tier_presets and
  //     shows as the headline badge on their profile.
  //   - induction_submissions.tier: captured at Approve time so we can
  //     audit which tier the worker was hired at.
  // =============================================
  if (!isMigrationApplied.get(227)) {
    try {
      const empCols = db.prepare("PRAGMA table_info(employees)").all().map(c => c.name);
      if (!empCols.includes('tier')) {
        db.exec("ALTER TABLE employees ADD COLUMN tier INTEGER");
      }
      const subCols = db.prepare("PRAGMA table_info(induction_submissions)").all().map(c => c.name);
      if (!subCols.includes('tier')) {
        db.exec("ALTER TABLE induction_submissions ADD COLUMN tier INTEGER");
      }
      recordMigration.run(227, 'employees.tier + induction_submissions.tier');
      console.log('Migration 227 applied: tier columns');
    } catch (e) {
      console.error('Migration 227 error:', e.message);
    }
  }

  // =============================================
  // Migration 228: Pay-run engine TFN-fidelity columns
  //   - employees.rate_weekend_short: hourly rate for the first 2 hours
  //     of a Saturday shift (1.5× under BCG). The pay-run engine peels
  //     these hours off into a new weekend_short bucket. Anything past
  //     2 hours (or any shift starting 12pm+) stays in `weekend` at the
  //     2× rate.
  //   - employees.night_pattern: drives which TFN night rate gets
  //     stamped onto the worker — occasional (Night<5, default),
  //     permanent (Night Perm 1.3×), or continuous_5plus (Night 5+
  //     1.15×). Per the FY26 panel's operational rules.
  // =============================================
  if (!isMigrationApplied.get(228)) {
    try {
      const empCols = db.prepare("PRAGMA table_info(employees)").all().map(c => c.name);
      if (!empCols.includes('rate_weekend_short')) {
        db.exec("ALTER TABLE employees ADD COLUMN rate_weekend_short REAL DEFAULT 0");
      }
      if (!empCols.includes('night_pattern')) {
        db.exec("ALTER TABLE employees ADD COLUMN night_pattern TEXT DEFAULT 'occasional'");
      }
      recordMigration.run(228, 'employees.rate_weekend_short + night_pattern for TFN PDF fidelity');
      console.log('Migration 228 applied');
    } catch (e) {
      console.error('Migration 228 error:', e.message);
    }
  }

  // =============================================
  // Migration 229: TFN Night 5+ auto-detection
  //   - employees.rate_night_5plus: the Night 5+ rate (1.15×) for TFN
  //     workers on `occasional` night pattern. Stamped from the wage
  //     panel alongside rate_night so the pay-run engine can auto-
  //     elevate shifts that fall inside a 5+ consecutive Mon–Fri run.
  //   For `permanent` and `continuous_5plus` patterns this stays 0 —
  //   the night pattern itself already selected the right rate_night.
  // =============================================
  if (!isMigrationApplied.get(229)) {
    try {
      const empCols = db.prepare("PRAGMA table_info(employees)").all().map(c => c.name);
      if (!empCols.includes('rate_night_5plus')) {
        db.exec("ALTER TABLE employees ADD COLUMN rate_night_5plus REAL DEFAULT 0");
      }
      recordMigration.run(229, 'employees.rate_night_5plus for Night 5+ auto-detection');
      console.log('Migration 229 applied');
    } catch (e) {
      console.error('Migration 229 error:', e.message);
    }
  }

  // =============================================
  // Migration 230: employee_review_comments — HR-internal discussion
  // thread under each note / performance review. Always internal: the
  // worker never sees comments even when the parent review is shared.
  // @username mentions in `body` fan out to in-app + push notifications.
  // =============================================
  if (!isMigrationApplied.get(230)) {
    console.log('Running migration 230: employee_review_comments');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS employee_review_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id INTEGER NOT NULL REFERENCES employee_reviews(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          mentioned_user_ids TEXT,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_review_comments_review ON employee_review_comments(review_id);');
      recordMigration.run(230, 'employee_review_comments');
      console.log('Migration 230 applied: employee_review_comments table ready');
    } catch (e) {
      console.error('Migration 230 error:', e.message);
    }
  }

  // =============================================
  // Migration 232: voc_assessments.marking_complete
  //   Powers the "Quick Cert Generator" — when a VOC session has 30+
  //   workers queueing for their certificate, the assessor types name +
  //   date, hands them a printable cert immediately, and comes back to
  //   the assessment later to enter theory/practical responses. Rows
  //   with marking_complete=0 surface in a "Pending Marking" queue on
  //   the VOC index.
  //   Default = 1 so historical full assessments aren't flagged.
  // =============================================
  if (!isMigrationApplied.get(232)) {
    console.log('Running migration 232: voc_assessments.marking_complete');
    try {
      const cols = db.prepare("PRAGMA table_info(voc_assessments)").all().map(c => c.name);
      if (!cols.includes('marking_complete')) {
        db.exec("ALTER TABLE voc_assessments ADD COLUMN marking_complete INTEGER NOT NULL DEFAULT 1");
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_voc_marking ON voc_assessments(marking_complete, status);');
      recordMigration.run(232, 'voc_assessments.marking_complete');
      console.log('Migration 232 applied: voc_assessments.marking_complete ready');
    } catch (e) {
      console.error('Migration 232 error:', e.message);
    }
  }

  // =============================================
  // Migration 233: voc_assessments signature paths
  //   Stores the PNG paths captured by the in-browser signature pad
  //   (signature_pad.js) on the Quick VOC form and the regular
  //   assessment form. When set, the PDF + HTML cert embed the
  //   actual drawn signature above the line. When unset, the cert
  //   falls back to the typed name rendered in cursive.
  // =============================================
  if (!isMigrationApplied.get(233)) {
    console.log('Running migration 233: voc_assessments signature paths');
    try {
      const cols = db.prepare("PRAGMA table_info(voc_assessments)").all().map(c => c.name);
      if (!cols.includes('assessor_signature_path')) {
        db.exec("ALTER TABLE voc_assessments ADD COLUMN assessor_signature_path TEXT DEFAULT ''");
      }
      if (!cols.includes('worker_signature_path')) {
        db.exec("ALTER TABLE voc_assessments ADD COLUMN worker_signature_path TEXT DEFAULT ''");
      }
      recordMigration.run(233, 'voc_assessments signature paths');
      console.log('Migration 233 applied: signature path columns ready');
    } catch (e) {
      console.error('Migration 233 error:', e.message);
    }
  }

  // =============================================
  // Migration 234: VOC worker acknowledgement workflow
  //   Office issues the cert + signs as assessor. Worker then gets a
  //   push, opens their portal, signs to acknowledge — at which point
  //   the PDF regenerates with their signature embedded.
  //
  //   Status values:
  //     'not_required' — issued before this feature existed OR the
  //                      assessor captured the worker's sig in person
  //                      on the tablet (so no follow-up needed).
  //     'pending'      — cert issued, waiting on the worker to sign.
  //     'signed'       — worker has signed (worker_signature_path set,
  //                      worker_acknowledged_at populated).
  //     'declined'     — worker explicitly declined (future scope; for
  //                      now we just keep the column flexible).
  //
  //   worker_acknowledged_at carries the timestamp the worker actually
  //   signed — separate from the original cert dates so re-signing
  //   is auditable.
  // =============================================
  if (!isMigrationApplied.get(234)) {
    console.log('Running migration 234: voc worker acknowledgement workflow');
    try {
      const cols = db.prepare("PRAGMA table_info(voc_assessments)").all().map(c => c.name);
      if (!cols.includes('worker_acknowledgement_status')) {
        db.exec("ALTER TABLE voc_assessments ADD COLUMN worker_acknowledgement_status TEXT NOT NULL DEFAULT 'not_required'");
      }
      if (!cols.includes('worker_acknowledged_at')) {
        db.exec("ALTER TABLE voc_assessments ADD COLUMN worker_acknowledged_at DATETIME");
      }
      // Backfill: any submitted competent cert that already has a
      // worker signature on file is implicitly 'signed' (sig was
      // captured in person, no follow-up needed).
      db.prepare(`
        UPDATE voc_assessments
        SET worker_acknowledgement_status = 'signed',
            worker_acknowledged_at = COALESCE(worker_acknowledged_at, updated_at)
        WHERE worker_signature_path IS NOT NULL AND worker_signature_path != ''
          AND worker_acknowledgement_status = 'not_required'
      `).run();
      db.exec('CREATE INDEX IF NOT EXISTS idx_voc_ack_status ON voc_assessments(worker_acknowledgement_status);');
      recordMigration.run(234, 'voc worker acknowledgement workflow');
      console.log('Migration 234 applied: worker_acknowledgement_status + index ready');
    } catch (e) {
      console.error('Migration 234 error:', e.message);
    }
  }

  // =============================================
  // Migration 235: Fleet Maintenance & Compliance
  //   `vehicles`         — one row per vehicle (the Fleet Register)
  //   `service_records`  — every maintenance record (the Service Log)
  //   `vehicle_summary`  — view joining vehicles with last-service date,
  //                        highest odometer, and total maintenance cost.
  //                        Aggregates are computed, never stored, so
  //                        they always reflect current data.
  //
  //   First-run seed pulls the original 13-vehicle / 55-record register
  //   from db/seeds/fleet.js. Verify-flagged vehicles (duplicate VINs /
  //   Fleet ID clashes) are imported as-is with their data-quality notes
  //   so office staff can reconcile them in-app rather than silently
  //   merging duplicates.
  // =============================================
  if (!isMigrationApplied.get(235)) {
    console.log('Running migration 235: fleet maintenance & compliance');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vehicles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id TEXT UNIQUE NOT NULL,
          fleet_id TEXT,
          rego TEXT,
          make TEXT,
          model TEXT,
          year INTEGER,
          vin TEXT,
          vehicle_type TEXT,
          toll_tag TEXT,
          assigned_to TEXT,
          status TEXT NOT NULL DEFAULT 'Active',
          registration_expiry DATE,
          ctp_expiry DATE,
          insurance_renewal DATE,
          inspection_due DATE,
          next_service_date DATE,
          next_service_km INTEGER,
          fire_extinguisher_expiry DATE,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS service_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vehicle_id INTEGER NOT NULL,
          service_date DATE,
          odometer_km INTEGER,
          work_performed TEXT,
          service_type TEXT,
          performed_by TEXT,
          cost NUMERIC,
          invoice_number TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_service_records_vehicle ON service_records(vehicle_id);
        CREATE INDEX IF NOT EXISTS idx_service_records_date ON service_records(service_date);
        CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
        DROP VIEW IF EXISTS vehicle_summary;
        CREATE VIEW vehicle_summary AS
        SELECT v.*,
          (SELECT MAX(service_date) FROM service_records sr WHERE sr.vehicle_id = v.id) AS last_service_date,
          (SELECT MAX(odometer_km) FROM service_records sr WHERE sr.vehicle_id = v.id) AS highest_odo_km,
          COALESCE((SELECT SUM(cost) FROM service_records sr WHERE sr.vehicle_id = v.id), 0) AS total_maint_cost,
          (SELECT COUNT(*) FROM service_records sr WHERE sr.vehicle_id = v.id) AS service_count
        FROM vehicles v;
      `);
      recordMigration.run(235, 'fleet maintenance & compliance');
      console.log('Migration 235 applied: vehicles + service_records + vehicle_summary ready');

      // One-time seed from the original T&S Fleet Register spreadsheet.
      // Idempotent: skips if the vehicles table already has rows.
      try {
        require('./seeds/fleet').seedFleet(db);
      } catch (e) {
        console.error('Fleet seed error:', e.message);
      }
    } catch (e) {
      console.error('Migration 235 error:', e.message);
    }
  }

  // =============================================
  // Migration 236: link booking_vehicles back to the Fleet register
  //   Bookings already pulled vehicles from the equipment table (utes,
  //   trucks, VMS) — but Fleet is now the source-of-truth for everything
  //   with a rego. Add a nullable FK so bookings can point at a Fleet
  //   row, keeping the existing free-text + equipment-derived flow
  //   working untouched for legacy data.
  // =============================================
  if (!isMigrationApplied.get(236)) {
    console.log('Running migration 236: booking_vehicles.fleet_vehicle_id');
    try {
      const cols = db.prepare("PRAGMA table_info(booking_vehicles)").all().map(c => c.name);
      if (!cols.includes('fleet_vehicle_id')) {
        db.exec("ALTER TABLE booking_vehicles ADD COLUMN fleet_vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_booking_vehicles_fleet ON booking_vehicles(fleet_vehicle_id);");
      recordMigration.run(236, 'booking_vehicles.fleet_vehicle_id');
      console.log('Migration 236 applied: booking_vehicles → vehicles FK ready');
    } catch (e) {
      console.error('Migration 236 error:', e.message);
    }
  }

  // =============================================
  // Migration 237: link Equipment rows back to the Fleet register.
  //   Some physical vehicles are duplicated in both `equipment` (historical
  //   home) and `vehicles` (new Fleet register). This FK lets the office
  //   walk through equipment-vehicle rows on the Reconcile screen, point
  //   each one at its canonical Fleet row, and deactivate the equipment
  //   row in one click. Pickers that filter by active=1 then stop showing
  //   the duplicate without losing the audit trail.
  // =============================================
  if (!isMigrationApplied.get(237)) {
    console.log('Running migration 237: equipment.fleet_vehicle_id');
    try {
      const cols = db.prepare("PRAGMA table_info(equipment)").all().map(c => c.name);
      if (!cols.includes('fleet_vehicle_id')) {
        db.exec("ALTER TABLE equipment ADD COLUMN fleet_vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_equipment_fleet ON equipment(fleet_vehicle_id);");
      recordMigration.run(237, 'equipment.fleet_vehicle_id');
      console.log('Migration 237 applied: equipment → vehicles FK ready');
    } catch (e) {
      console.error('Migration 237 error:', e.message);
    }
  }

  // =============================================
  // Migration 238: Quoting Module — schema
  //   Pricing-side counterpart to the existing tenders module. A quote is
  //   a fixed-price offer for a known scope (vs. a tender = competitive
  //   bid submission). Tables fall into three groups:
  //
  //     Rate cards   — reusable price books, with variant pricing for
  //                    shift-type × hour-bracket matrices (Daracon-style
  //                    SoRs) and an allowances child table for meal /
  //                    travel / LAFHA / TMA-establishment surcharges.
  //     Quotes       — a quote header + groups + sites + line items.
  //                    Sell side (rate_snapshot) AND cost side
  //                    (unit_cost_snapshot, override) are both snapshotted
  //                    at line creation so rate-card / worker-rate edits
  //                    later don't retroactively shift historical margins.
  //     Imports      — rate_card_imports tracks PDF/Word/Excel uploads
  //                    that an admin can review + commit into a rate card.
  //                    Table only in this migration; UI lands later.
  //
  //   rate_cards.purpose ('quoting' | 'reference') keeps the door open for
  //   side-by-side compare against competitor SoRs without a future
  //   migration: reference cards are import-only, never selectable when
  //   building a quote.
  // =============================================
  if (!isMigrationApplied.get(238)) {
    console.log('Running migration 238: Quoting Module — schema');
    try {
      db.exec(`
        -- ─────────────────────────────────────────────────────────────
        -- quoting_settings (singleton)
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS quoting_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          default_tc_cost_rate REAL,
          default_tl_cost_rate REAL,
          default_supervisor_cost_rate REAL,
          gst_rate REAL NOT NULL DEFAULT 0.10,
          margin_healthy_threshold REAL NOT NULL DEFAULT 25.00,
          margin_watch_threshold REAL NOT NULL DEFAULT 15.00,
          quote_number_format TEXT NOT NULL DEFAULT 'TS-QTE-{YYYY}-{NNN}',
          default_validity_days INTEGER NOT NULL DEFAULT 30,
          company_inclusions_defaults_json TEXT NOT NULL DEFAULT '[]',
          company_exclusions_defaults_json TEXT NOT NULL DEFAULT '[]',
          company_terms_default TEXT DEFAULT '',
          default_within_50km INTEGER NOT NULL DEFAULT 1,
          tma_non_ts_vehicle_surcharge_pct REAL NOT NULL DEFAULT 20.0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- ─────────────────────────────────────────────────────────────
        -- rate_card_imports — uploaded PDF/Word/Excel review queue
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS rate_card_imports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          source_format TEXT NOT NULL CHECK(source_format IN ('pdf','docx','xlsx')),
          file_path TEXT NOT NULL,
          extracted_text TEXT,
          proposed_json TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','extracting','review','committed','failed','discarded')),
          error_message TEXT,
          committed_rate_card_id INTEGER REFERENCES rate_cards(id) ON DELETE SET NULL,
          uploaded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_rate_card_imports_status ON rate_card_imports(status, created_at DESC);

        -- ─────────────────────────────────────────────────────────────
        -- rate_cards
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS rate_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
          effective_from DATE,
          effective_to DATE,
          is_default INTEGER NOT NULL DEFAULT 0,
          purpose TEXT NOT NULL DEFAULT 'quoting'
            CHECK(purpose IN ('quoting','reference')),
          source TEXT
            CHECK(source IN ('manual','imported_pdf','imported_docx','imported_xlsx') OR source IS NULL),
          source_import_id INTEGER REFERENCES rate_card_imports(id) ON DELETE SET NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_rate_cards_purpose ON rate_cards(purpose, is_active);
        CREATE INDEX IF NOT EXISTS idx_rate_cards_client ON rate_cards(client_id);
        CREATE INDEX IF NOT EXISTS idx_rate_cards_default ON rate_cards(is_default, is_active);

        -- ─────────────────────────────────────────────────────────────
        -- rate_card_items
        --   Each row = one billable line on a rate card. Pricing lives in
        --   rate_card_item_variants — for cards that don't differentiate
        --   by shift/hour, exactly one variant row (shift_type='standard',
        --   hour_bracket='standard') carries the price.
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS rate_card_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rate_card_id INTEGER NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
          category TEXT NOT NULL
            CHECK(category IN ('planning_compliance','tc_labour','equipment_vehicles','provisioning','allowances_misc')),
          code TEXT,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          unit TEXT NOT NULL
            CHECK(unit IN ('per_shift','per_hour','per_site','per_day','per_week','per_km','per_application','per_plan','per_delivery','per_spa','fixed')),
          has_hours_input INTEGER NOT NULL DEFAULT 0,
          is_addon INTEGER NOT NULL DEFAULT 0,
          min_booking_hours REAL,
          pricing_status TEXT NOT NULL DEFAULT 'priced'
            CHECK(pricing_status IN ('priced','poa')),
          cost_method TEXT NOT NULL DEFAULT 'fixed'
            CHECK(cost_method IN ('fixed','computed_crew')),
          crew_composition_json TEXT,
          vehicle_cost_per_hour REAL,
          notes TEXT DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_rate_card_items_card ON rate_card_items(rate_card_id, category, sort_order);

        -- ─────────────────────────────────────────────────────────────
        -- rate_card_item_variants
        --   (item, shift_type, hour_bracket) → sell rate + unit cost.
        --   Daracon-style SoRs use multiple variants per item; the TfNSW
        --   Tube Count style uses a single (standard, standard) variant.
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS rate_card_item_variants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rate_card_item_id INTEGER NOT NULL REFERENCES rate_card_items(id) ON DELETE CASCADE,
          shift_type TEXT NOT NULL DEFAULT 'standard'
            CHECK(shift_type IN ('standard','weekday','weeknight','weekend','public_holiday')),
          hour_bracket TEXT NOT NULL DEFAULT 'standard'
            CHECK(hour_bracket IN ('standard','0_to_8','8_to_10','10_plus')),
          rate REAL,
          unit_cost REAL,
          notes TEXT DEFAULT '',
          UNIQUE(rate_card_item_id, shift_type, hour_bracket)
        );
        CREATE INDEX IF NOT EXISTS idx_rcv_item ON rate_card_item_variants(rate_card_item_id);

        -- ─────────────────────────────────────────────────────────────
        -- rate_card_allowances
        --   Conditional surcharges (meal allowance >9.5hr, travel per TC
        --   per shift, LAFHA per day, TMA establishment per person per
        --   shift). Snapshotted onto quote_allowances at quote time.
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS rate_card_allowances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rate_card_id INTEGER NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
          code TEXT,
          name TEXT NOT NULL,
          scope TEXT NOT NULL
            CHECK(scope IN ('per_person_per_shift','per_person_per_day','per_shift','per_day','flat')),
          amount REAL NOT NULL DEFAULT 0,
          unit_cost REAL,
          min_hours_trigger REAL,
          auto_apply INTEGER NOT NULL DEFAULT 1,
          notes TEXT DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_rca_card ON rate_card_allowances(rate_card_id, sort_order);

        -- ─────────────────────────────────────────────────────────────
        -- quotes
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS quotes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quote_number TEXT NOT NULL UNIQUE,
          client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
          client_name_snapshot TEXT NOT NULL DEFAULT '',
          project_name TEXT NOT NULL DEFAULT '',
          project_description TEXT DEFAULT '',
          prepared_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          rate_card_id INTEGER REFERENCES rate_cards(id) ON DELETE SET NULL,
          quote_date DATE NOT NULL DEFAULT (date('now')),
          valid_until_date DATE,
          within_50km INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','sent','accepted','rejected','expired','superseded')),
          version INTEGER NOT NULL DEFAULT 1,
          parent_quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
          subtotal_ex_gst REAL NOT NULL DEFAULT 0,
          gst REAL NOT NULL DEFAULT 0,
          total_inc_gst REAL NOT NULL DEFAULT 0,
          total_cost REAL NOT NULL DEFAULT 0,
          total_margin REAL NOT NULL DEFAULT 0,
          total_margin_pct REAL NOT NULL DEFAULT 0,
          inclusions_json TEXT NOT NULL DEFAULT '[]',
          exclusions_json TEXT NOT NULL DEFAULT '[]',
          terms TEXT DEFAULT '',
          internal_notes TEXT DEFAULT '',
          pdf_path TEXT,
          sent_at DATETIME,
          accepted_at DATETIME,
          rejected_at DATETIME,
          rejection_reason TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_quotes_status_date ON quotes(status, quote_date DESC);
        CREATE INDEX IF NOT EXISTS idx_quotes_client_date ON quotes(client_id, quote_date DESC);
        CREATE INDEX IF NOT EXISTS idx_quotes_parent ON quotes(parent_quote_id);

        -- ─────────────────────────────────────────────────────────────
        -- quote_groups (optional grouping of sites — screenline / stage)
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS quote_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_quote_groups_quote ON quote_groups(quote_id, sort_order);

        -- ─────────────────────────────────────────────────────────────
        -- quote_sites
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS quote_sites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
          group_id INTEGER REFERENCES quote_groups(id) ON DELETE SET NULL,
          site_code TEXT,
          site_name TEXT NOT NULL,
          road_name TEXT DEFAULT '',
          road_classification TEXT
            CHECK(road_classification IN ('state','regional','local','arterial','other') OR road_classification IS NULL),
          notes TEXT DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          subtotal_ex_gst REAL NOT NULL DEFAULT 0,
          total_cost REAL NOT NULL DEFAULT 0,
          total_margin REAL NOT NULL DEFAULT 0,
          total_margin_pct REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_quote_sites_quote ON quote_sites(quote_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_quote_sites_group ON quote_sites(group_id);

        -- ─────────────────────────────────────────────────────────────
        -- quote_line_items
        --   The cells of the Site Matrix grid. Both sell rate and cost
        --   are snapshotted at creation. shift_type + hour_bracket
        --   identify which rate_card_item_variant was resolved.
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS quote_line_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quote_site_id INTEGER NOT NULL REFERENCES quote_sites(id) ON DELETE CASCADE,
          rate_card_item_id INTEGER REFERENCES rate_card_items(id) ON DELETE SET NULL,
          rate_card_item_variant_id INTEGER REFERENCES rate_card_item_variants(id) ON DELETE SET NULL,
          item_name_snapshot TEXT NOT NULL,
          unit_snapshot TEXT NOT NULL,
          category_snapshot TEXT,
          shift_type TEXT NOT NULL DEFAULT 'standard'
            CHECK(shift_type IN ('standard','weekday','weeknight','weekend','public_holiday')),
          hour_bracket TEXT NOT NULL DEFAULT 'standard'
            CHECK(hour_bracket IN ('standard','0_to_8','8_to_10','10_plus')),
          rate_snapshot REAL NOT NULL DEFAULT 0,
          has_hours_snapshot INTEGER NOT NULL DEFAULT 0,
          qty REAL NOT NULL DEFAULT 0,
          hours REAL,
          cost_method_snapshot TEXT NOT NULL DEFAULT 'fixed'
            CHECK(cost_method_snapshot IN ('fixed','computed_crew')),
          unit_cost_snapshot REAL NOT NULL DEFAULT 0,
          crew_composition_snapshot_json TEXT,
          vehicle_cost_snapshot REAL,
          unit_cost_override REAL,
          line_revenue REAL NOT NULL DEFAULT 0,
          line_cost REAL NOT NULL DEFAULT 0,
          line_margin REAL NOT NULL DEFAULT 0,
          line_margin_pct REAL NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_qli_site ON quote_line_items(quote_site_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_qli_item ON quote_line_items(rate_card_item_id);

        -- ─────────────────────────────────────────────────────────────
        -- quote_rate_items
        --   Per-quote column list for the Site Matrix grid. When a quote
        --   is created from a rate card, one row per active rate_card_item
        --   is inserted here so the grid renders. Users can then hide
        --   columns (is_hidden=1), reorder them (sort_order), or add a
        --   one-off custom column not on any rate card by leaving
        --   rate_card_item_id NULL and filling the custom_* fields.
        --   Hidden rows preserve their line items underneath — unhiding
        --   restores everything.
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS quote_rate_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
          rate_card_item_id INTEGER REFERENCES rate_card_items(id) ON DELETE SET NULL,
          custom_name TEXT,
          custom_unit TEXT
            CHECK(custom_unit IN ('per_shift','per_hour','per_site','per_day','per_week','per_km','per_application','per_plan','per_delivery','per_spa','fixed') OR custom_unit IS NULL),
          custom_rate REAL,
          custom_unit_cost REAL,
          custom_has_hours_input INTEGER NOT NULL DEFAULT 0,
          custom_category TEXT
            CHECK(custom_category IN ('planning_compliance','tc_labour','equipment_vehicles','provisioning','allowances_misc') OR custom_category IS NULL),
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_hidden INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(quote_id, rate_card_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_qri_quote ON quote_rate_items(quote_id, sort_order);

        -- ─────────────────────────────────────────────────────────────
        -- quote_allowances
        --   Per-quote rolled-up surcharges (meal, travel, LAFHA, TMA
        --   establishment). Either auto-derived from the labour lines or
        --   manually added. Snapshots amount + cost so changes to the
        --   rate card later don't shift historical totals.
        -- ─────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS quote_allowances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
          rate_card_allowance_id INTEGER REFERENCES rate_card_allowances(id) ON DELETE SET NULL,
          name_snapshot TEXT NOT NULL,
          scope_snapshot TEXT NOT NULL,
          amount_snapshot REAL NOT NULL DEFAULT 0,
          unit_cost_snapshot REAL,
          qty REAL NOT NULL DEFAULT 0,
          line_revenue REAL NOT NULL DEFAULT 0,
          line_cost REAL NOT NULL DEFAULT 0,
          notes TEXT DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_quote_allowances_quote ON quote_allowances(quote_id, sort_order);
      `);

      // Singleton quoting_settings row (required config, not demo data).
      // Sensible defaults shipped with the module; admins edit on the
      // /rate-cards/settings page once that UI lands.
      const existingSettings = db.prepare('SELECT COUNT(*) AS c FROM quoting_settings').get().c;
      if (existingSettings === 0) {
        const defaultInclusions = JSON.stringify([
          'TGS preparation in accordance with TfNSW TcAWS v6.1',
          'Road Occupancy Licence (ROL) application and coordination',
          'Site mobilisation and establishment',
          'Accredited traffic control personnel',
          'All required signage and equipment',
          'Public liability insurance ($20M)',
          'Workers compensation insurance'
        ]);
        const defaultExclusions = JSON.stringify([
          'After-hours / weekend rates (charged at applicable penalty rates unless quoted)',
          'Additional services not specified in this quotation',
          'Council fees, permits and statutory charges',
          'Extended standby beyond contracted hours',
          'Damage to or theft of equipment due to client or third-party action',
          'Variations to scope — to be quoted separately'
        ]);
        const defaultTerms = [
          '**Validity:** This quote is valid for 30 days from quote date unless otherwise stated.',
          '',
          '**Payment Terms:** Net 30 days from date of invoice.',
          '',
          '**Cancellation:** Cancellations within 2 hours of shift commencement (or 4 hours for TMA/LTMA operators) incur the minimum booking period.',
          '',
          '**Variations:** Any changes to the scope will be quoted separately and require written approval before commencement.',
          '',
          '**Insurance:** T&S Traffic Management maintains Public Liability ($20M) and Workers Compensation insurance.'
        ].join('\n');

        db.prepare(`
          INSERT INTO quoting_settings (
            id, gst_rate, margin_healthy_threshold, margin_watch_threshold,
            quote_number_format, default_validity_days,
            company_inclusions_defaults_json, company_exclusions_defaults_json,
            company_terms_default, default_within_50km,
            tma_non_ts_vehicle_surcharge_pct
          ) VALUES (1, 0.10, 25.0, 15.0, 'TS-QTE-{YYYY}-{NNN}', 30, ?, ?, ?, 1, 20.0)
        `).run(defaultInclusions, defaultExclusions, defaultTerms);
      }

      recordMigration.run(238, 'Quoting Module — schema');
      console.log('Migration 238 applied: Quoting Module schema (11 tables, indexes, settings singleton)');
    } catch (e) {
      console.error('Migration 238 error:', e.message);
    }
  }

  // =============================================
  // Migration 239: induction time + reminder log
  //
  // Adds an `induction_time` column to seek_applicants so admins can put
  // a clock time alongside the induction date in the recruitment tracker,
  // plus an induction_reminder_log table used by
  // services/inductionReminders.js to dedup the 7 / 3 / 1 day reminders
  // it fires at admin / operations / hr roles ahead of each scheduled
  // induction. Unique tuple is (applicant_id, days_out, induction_date)
  // so re-scheduling regenerates the window.
  // =============================================
  if (!isMigrationApplied.get(239)) {
    console.log('Running migration 239: induction_time + induction_reminder_log');
    try {
      try { db.exec("ALTER TABLE seek_applicants ADD COLUMN induction_time TEXT DEFAULT ''"); } catch (e) { /* column may exist */ }
      db.exec(`
        CREATE TABLE IF NOT EXISTS induction_reminder_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          applicant_id INTEGER NOT NULL REFERENCES seek_applicants(id) ON DELETE CASCADE,
          days_out INTEGER NOT NULL,
          induction_date DATE NOT NULL,
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(applicant_id, days_out, induction_date)
        );
        CREATE INDEX IF NOT EXISTS idx_induction_rem_log_applicant ON induction_reminder_log(applicant_id);
      `);
      recordMigration.run(239, 'seek_applicants.induction_time + induction_reminder_log');
      console.log('Migration 239 applied: induction_time + induction_reminder_log');
    } catch (e) {
      console.error('Migration 239 error:', e.message);
    }
  }

  console.log('All migrations checked/applied.');
}

// seedDemoData — DISABLED (all demo data removed)
function seedDemoData(db) {
  return; // No-op: demo data seeding permanently disabled
  /* eslint-disable no-unreachable */
  try {
      const today40 = new Date().toISOString().split('T')[0];
      const daysAgo40 = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
      const daysFromNow40 = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];

      // --- 0. Seed budget data if migration 39 ran but found no jobs ---
      const existingBudgets = db.prepare('SELECT COUNT(*) as c FROM job_budgets').get().c;
      if (existingBudgets === 0) {
        const activeJobs = db.prepare("SELECT id, job_number, contract_value FROM jobs WHERE status IN ('active','won','on_hold') ORDER BY job_number").all();
        if (activeJobs.length > 0) {
          const insertBudget = db.prepare(`INSERT OR IGNORE INTO job_budgets (job_id, contract_value, budget_labour, budget_materials, budget_subcontractors, budget_equipment, budget_other, budget_contingency, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const insertCost = db.prepare(`INSERT INTO cost_entries (job_id, budget_id, category, description, amount, entry_date, invoice_ref, supplier, entered_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const enteredBy = db.prepare("SELECT id FROM users WHERE role IN ('admin','finance') LIMIT 1").get()?.id || 1;
          const profiles = [
            { labourPct: 0.50, matPct: 0.08, subPct: 0.18, equipPct: 0.14, otherPct: 0.03, contPct: 0.07 },
            { labourPct: 0.52, matPct: 0.06, subPct: 0.20, equipPct: 0.12, otherPct: 0.04, contPct: 0.06 },
            { labourPct: 0.48, matPct: 0.10, subPct: 0.15, equipPct: 0.16, otherPct: 0.03, contPct: 0.08 },
            { labourPct: 0.55, matPct: 0.05, subPct: 0.17, equipPct: 0.13, otherPct: 0.04, contPct: 0.06 },
          ];
          const contractValues = [185000, 320000, 95000, 450000, 78000, 520000, 125000, 680000, 210000, 145000];
          const spendPcts = [0.38, 0.62, 0.78, 0.22, 0.45, 0.05, 0.55, 0.12, 0.35, 0.68];
          activeJobs.forEach((job, i) => {
            const contractVal = job.contract_value || contractValues[i % contractValues.length];
            const p = profiles[i % profiles.length];
            const totalBudget = contractVal * 0.92;
            insertBudget.run(job.id, contractVal,
              Math.round(totalBudget * p.labourPct), Math.round(totalBudget * p.matPct),
              Math.round(totalBudget * p.subPct), Math.round(totalBudget * p.equipPct),
              Math.round(totalBudget * p.otherPct), Math.round(totalBudget * p.contPct),
              'Auto-seeded budget');
            const budgetRow = db.prepare('SELECT id FROM job_budgets WHERE job_id = ?').get(job.id);
            if (!budgetRow) return;
            const spendPct = spendPcts[i % spendPcts.length];
            const totalSpend = totalBudget * spendPct;
            const costEntries = [
              { cat: 'labour', pct: 0.55, desc: 'Crew labour — weeks 1-' + Math.ceil(spendPct * 20), supplier: 'Internal', pre: 'LAB' },
              { cat: 'equipment', pct: 0.18, desc: 'TMA & equipment hire', supplier: 'T&S Fleet', pre: 'EQP' },
              { cat: 'materials', pct: 0.10, desc: 'Signage, cones & delineators', supplier: 'Traffix Devices', pre: 'MAT' },
              { cat: 'subcontractors', pct: 0.14, desc: 'Line marking & civil sub', supplier: 'Roadline Markings', pre: 'SUB' },
              { cat: 'other', pct: 0.03, desc: 'Permits & admin', supplier: 'Various', pre: 'OTH' },
            ];
            costEntries.forEach((ce, ci) => {
              const amount = Math.round(totalSpend * ce.pct);
              if (amount <= 0) return;
              insertCost.run(job.id, budgetRow.id, ce.cat, ce.desc, amount,
                daysAgo40(Math.max(1, Math.round((ci + 1) * 7 * spendPct))),
                ce.pre + '-' + job.job_number + '-' + String(ci + 1).padStart(3, '0'),
                ce.supplier, enteredBy);
            });
            if (!job.contract_value) {
              db.prepare('UPDATE jobs SET contract_value = ? WHERE id = ?').run(contractVal, job.id);
            }
          });
          console.log('  Seeded budgets for ' + activeJobs.length + ' jobs');
        }
      }

      // --- A. Crew allocations for today + recent days ---
      const existingAllocs = db.prepare('SELECT COUNT(*) as c FROM crew_allocations').get().c;
      if (existingAllocs === 0) {
        const insertAlloc = db.prepare(`
          INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, status, notes, allocated_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        // Today's allocations — 14 crew across 5 active jobs
        const todayAllocs = [
          [1, 1, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', 'Barrier install Section A'],
          [1, 3, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [1, 4, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [1, 2, '06:00', '14:30', 'day', 'Leading Hand', 'allocated', 'Pending confirmation'],
          [6, 5, '19:00', '05:00', 'night', 'Supervisor', 'confirmed', 'Night works Main St'],
          [6, 7, '19:00', '05:00', 'night', 'Traffic Controller', 'confirmed', ''],
          [6, 8, '19:00', '05:00', 'night', 'Traffic Controller', 'allocated', ''],
          [6, 14, '19:00', '05:00', 'night', 'Spotter', 'confirmed', ''],
          [9, 11, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', 'Olympic Blvd works'],
          [9, 12, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', ''],
          [9, 13, '06:00', '14:30', 'day', 'Traffic Controller', 'allocated', ''],
          [10, 17, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', 'Victoria Rd setup'],
          [10, 15, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [4, 23, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', 'Final inspection prep'],
        ];
        todayAllocs.forEach(a => insertAlloc.run(a[0], a[1], today40, a[2], a[3], a[4], a[5], a[6], a[7]));

        // Yesterday allocations
        const yAllocs = [
          [1, 1, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', ''],
          [1, 3, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [1, 4, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [6, 5, '19:00', '05:00', 'night', 'Supervisor', 'confirmed', ''],
          [6, 7, '19:00', '05:00', 'night', 'Traffic Controller', 'confirmed', ''],
          [9, 11, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', ''],
          [9, 12, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', ''],
          [10, 17, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', ''],
          [7, 6, '06:00', '16:00', 'day', 'Leading Hand', 'confirmed', 'Demob Coward St'],
          [7, 18, '06:00', '16:00', 'day', 'Traffic Controller', 'confirmed', ''],
        ];
        yAllocs.forEach(a => insertAlloc.run(a[0], a[1], daysAgo40(1), a[2], a[3], a[4], a[5], a[6], a[7]));

        // Tomorrow allocations
        const tAllocs = [
          [1, 1, '06:00', '14:30', 'day', 'Supervisor', 'allocated', ''],
          [1, 2, '06:00', '14:30', 'day', 'Leading Hand', 'allocated', ''],
          [1, 3, '06:00', '14:30', 'day', 'Traffic Controller', 'allocated', ''],
          [6, 5, '19:00', '05:00', 'night', 'Supervisor', 'allocated', ''],
          [6, 7, '19:00', '05:00', 'night', 'Traffic Controller', 'allocated', ''],
          [6, 8, '19:00', '05:00', 'night', 'Traffic Controller', 'allocated', ''],
          [9, 11, '06:00', '14:30', 'day', 'Supervisor', 'allocated', ''],
          [10, 17, '06:00', '14:30', 'day', 'Leading Hand', 'allocated', ''],
        ];
        tAllocs.forEach(a => insertAlloc.run(a[0], a[1], daysFromNow40(1), a[2], a[3], a[4], a[5], a[6], a[7]));
      }

      // --- B. Equipment assignments (deployed to jobs) ---
      const existingEqAssign = db.prepare('SELECT COUNT(*) as c FROM equipment_assignments').get().c;
      if (existingEqAssign === 0) {
        const insertEqAssign = db.prepare(`
          INSERT INTO equipment_assignments (equipment_id, job_id, assigned_date, expected_return_date, actual_return_date, assigned_by_id, notes)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `);
        // Currently deployed (no actual_return_date)
        insertEqAssign.run(1, 1, daysAgo40(30), daysFromNow40(30), null, 'Arrow board for Canterbury Rd northbound');
        insertEqAssign.run(3, 9, daysAgo40(14), daysFromNow40(60), null, 'VMS Olympic Blvd detour info');
        insertEqAssign.run(5, 1, daysAgo40(30), daysFromNow40(30), null, 'Supervisor ute');
        insertEqAssign.run(6, 6, daysAgo40(10), daysFromNow40(45), null, 'Night works ute');
        insertEqAssign.run(7, 1, daysAgo40(30), daysFromNow40(30), null, 'Barriers Section A');
        insertEqAssign.run(9, 6, daysAgo40(10), daysFromNow40(45), null, 'Night works lighting');
        insertEqAssign.run(11, 9, daysAgo40(14), daysFromNow40(60), null, 'Traffic cones Olympic Blvd');
        insertEqAssign.run(14, 10, daysAgo40(7), daysFromNow40(90), null, 'Sign kit for Victoria Rd');
        // Previously deployed and returned
        insertEqAssign.run(2, 4, daysAgo40(60), daysAgo40(5), daysAgo40(5), 'Arrow board returned from Liverpool');
        insertEqAssign.run(8, 7, daysAgo40(45), daysAgo40(2), daysAgo40(2), 'Barriers returned from Mascot');
        insertEqAssign.run(12, 4, daysAgo40(60), daysAgo40(5), daysAgo40(5), 'Cone set B returned');
      }

      // --- C. Activity log entries (realistic recent activity) ---
      const existingActivity = db.prepare('SELECT COUNT(*) as c FROM activity_log').get().c;
      if (existingActivity < 5) {
        const insertActivity = db.prepare(`
          INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, details, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const userNames = { 1: 'Admin User', 2: 'Sam Operations', 3: 'Alex Planning', 4: 'Pat Finance', 5: 'Jordan Accounts' };
        const activities = [
          [1, 'create', 'job', 12, 'Created job J-02462 — Acciona Wolli Creek', daysAgo40(0) + ' 09:15:00'],
          [2, 'update', 'allocation', null, 'Confirmed 14 crew allocations for today', daysAgo40(0) + ' 07:30:00'],
          [1, 'update', 'job', 7, 'Updated J-02457 progress to 90%', daysAgo40(0) + ' 08:45:00'],
          [3, 'create', 'compliance', 5, 'Submitted ROL Extension for J-02454', daysAgo40(1) + ' 14:20:00'],
          [5, 'update', 'task', 5, 'Marked "Chase overdue invoice #INV-4421" as in_progress', daysAgo40(1) + ' 10:00:00'],
          [2, 'update', 'incident', null, 'Closed incident INC-003 — near miss resolved', daysAgo40(1) + ' 16:30:00'],
          [1, 'create', 'budget', 1, 'Set budget for J-02451 — $185,000 contract', daysAgo40(2) + ' 11:00:00'],
          [3, 'update', 'compliance', 1, 'TMP approved for Canterbury Rd', daysAgo40(2) + ' 09:15:00'],
          [2, 'create', 'allocation', null, 'Created allocations for week of ' + daysAgo40(7), daysAgo40(3) + ' 15:45:00'],
          [5, 'create', 'cost_entry', null, 'Added $12,400 labour cost to J-02456', daysAgo40(3) + ' 13:20:00'],
          [1, 'update', 'job', 4, 'Changed J-02454 health to red — payment overdue', daysAgo40(4) + ' 10:30:00'],
          [2, 'create', 'timesheet', null, 'Submitted 8 timesheets for March 14', daysAgo40(4) + ' 17:00:00'],
          [3, 'create', 'plan', null, 'Created TMP for Church St closure', daysAgo40(5) + ' 11:30:00'],
          [1, 'update', 'crew', 16, 'Updated Michelle Harris licence expiry', daysAgo40(5) + ' 14:00:00'],
          [4, 'create', 'opportunity', null, 'New lead: Penrith Council road upgrade $340k', daysAgo40(6) + ' 09:00:00'],
          [1, 'create', 'job', 8, 'Created job J-02458 — John Holland Norwest', daysAgo40(7) + ' 10:15:00'],
          [2, 'update', 'equipment', 10, 'Flagged Lighting Tower #2 condition as poor', daysAgo40(8) + ' 08:30:00'],
          [5, 'create', 'invoice', null, 'Sent progress claim #2 to Fulton Hogan', daysAgo40(9) + ' 14:45:00'],
          [3, 'update', 'plan', null, 'ROL approved for Olympic Blvd night works', daysAgo40(10) + ' 16:00:00'],
          [1, 'update', 'settings', null, 'Updated defect severity dropdown options', daysAgo40(12) + ' 11:00:00'],
        ];
        activities.forEach(a => insertActivity.run(a[0], userNames[a[0]], a[1], a[2], a[3], a[4], a[5]));
      }

      // --- D. Update job last_update_date for active jobs (fix "missing weekly update") ---
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 1").run(daysAgo40(2));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 6").run(daysAgo40(3));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 7").run(daysAgo40(1));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 9").run(daysAgo40(4));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 10").run(daysAgo40(5));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 11").run(daysAgo40(3));
      // Leave J-02454 (id=4) and J-02455 (id=5) with old dates to show realistic "missing update"

      // --- E. Seed CRM opportunities ---
      const existingOpps = db.prepare('SELECT COUNT(*) as c FROM opportunities').get().c;
      if (existingOpps === 0) {
        const insertOpp = db.prepare(`
          INSERT INTO opportunities (opportunity_number, title, client_id, owner_id, service_type, stage, probability, estimated_value, weighted_value, expected_close_date, source, region, notes, next_step, next_step_due_date, status, created_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertOpp.run('OPP-001', 'Penrith Council — Road Upgrade TCP', null, 4, 'traffic_management', 'proposal_pending', 60, 340000, 204000, daysFromNow40(30), 'referral', 'Western Sydney', 'Large road upgrade project. Council wants dedicated TCP for 6 months.', 'Follow up on proposal', daysFromNow40(5), 'open', 4);
        insertOpp.run('OPP-002', 'Laing O\'Rourke — M4 Widening', null, 4, 'traffic_management', 'qualified', 40, 580000, 232000, daysFromNow40(60), 'tender_portal', 'Western Sydney', 'Tier 1 project. Long-term opportunity if we get in.', 'Submit EOI', daysFromNow40(10), 'open', 4);
        insertOpp.run('OPP-003', 'Ausgrid — Cable Replacement', null, 4, 'traffic_management', 'quote_sent', 75, 125000, 93750, daysFromNow40(14), 'existing_client', 'Inner West', 'Follow-on from Penrith job. Good relationship with PM.', 'Chase quote response', daysFromNow40(3), 'open', 4);
        insertOpp.run('OPP-004', 'City of Sydney — Bike Lane Install', null, 4, 'traffic_management', 'meeting_booked', 30, 210000, 63000, daysFromNow40(45), 'website', 'CBD', 'Green infrastructure project. Needs night works capability.', 'Attend site meeting', daysFromNow40(7), 'open', 4);
        insertOpp.run('OPP-005', 'Downer EDI — Intersection Upgrade', null, 4, 'traffic_management', 'negotiation', 80, 195000, 156000, daysFromNow40(7), 'existing_client', 'Northern Sydney', 'Almost closed. Waiting on final PO.', 'Follow up PO', daysFromNow40(2), 'open', 4);
        insertOpp.run('OPP-006', 'Fulton Hogan — Night Works Package', 5, 4, 'traffic_management', 'won', 100, 320000, 320000, daysAgo40(10), 'existing_client', 'Western Sydney', 'Converted to J-02456', 'Mobilise crew', null, 'won', 4);
        insertOpp.run('OPP-007', 'Ventia — Water Main Repair', null, 4, 'traffic_management', 'new_lead', 15, 85000, 12750, daysFromNow40(90), 'cold_call', 'South West Sydney', 'Initial enquiry. Small job but good foot in the door.', 'Call back to qualify', daysFromNow40(5), 'open', 4);
      }

      // --- F. Seed CRM activities ---
      const existingCrmAct = db.prepare('SELECT COUNT(*) as c FROM crm_activities').get().c;
      if (existingCrmAct === 0) {
        const insertCrmAct = db.prepare(`
          INSERT INTO crm_activities (activity_type, subject, notes, outcome, opportunity_id, owner_id, activity_date, is_completed, created_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertCrmAct.run('call', 'Follow up with Penrith Council', 'Discussed project timeline and crew requirements', 'Positive — submitting proposal this week', 1, 4, daysAgo40(3) + ' 10:00:00', 1, 4);
        insertCrmAct.run('meeting', 'Site visit — M4 Widening', 'Walked site with Laing PM. Assessed TCP requirements.', 'Good fit for our capability. Large mobilisation needed.', 2, 4, daysAgo40(5) + ' 14:00:00', 1, 4);
        insertCrmAct.run('email', 'Quote sent to Ausgrid', 'Sent formal quote for cable replacement TCP', 'Awaiting response', 3, 4, daysAgo40(2) + ' 09:30:00', 1, 4);
        insertCrmAct.run('call', 'Intro call — City of Sydney', 'Discussed bike lane project scope and our night works experience', 'Meeting booked for next week', 4, 4, daysAgo40(7) + ' 11:00:00', 1, 4);
        insertCrmAct.run('meeting', 'Negotiation — Downer EDI intersection', 'Final rates discussion. Agreed terms.', 'PO expected this week', 5, 4, daysAgo40(1) + ' 15:00:00', 1, 4);
      }

      // --- G. Update Test Worker (crew_member id=1) with fuller data ---
      try {
        db.prepare(`UPDATE crew_members SET
          emergency_contact_name = 'Jane Smith',
          emergency_contact_phone = '0402 111 222'
          WHERE id = 1 AND (emergency_contact_name IS NULL OR emergency_contact_name = '')
        `).run();
      } catch (e) { /* columns may not exist */ }

      // --- H. Dismiss onboarding for admin user (demo should look production-ready) ---
      try {
        // Add preferences column if missing
        try { db.exec("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'"); } catch (e) { /* already exists */ }
        db.prepare("UPDATE users SET preferences = ? WHERE id = 1").run(JSON.stringify({ onboarding_dismissed: true }));
      } catch (e) { /* ignore */ }

      // --- I. Add more project updates so "missing weekly update" count is realistic ---
      try {
        const insertUpdate40 = db.prepare(`
          INSERT OR IGNORE INTO project_updates (job_id, week_ending, summary, milestones, issues_risks, blockers, submitted_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        insertUpdate40.run(6, daysAgo40(3), 'Night works progressing well. Lane closure setup efficient. No incidents.', 'Main St section 1 complete. Section 2 starting.', 'Noise complaints from residents — adjusted generator placement.', '', 2);
        insertUpdate40.run(7, daysAgo40(1), 'Demobilisation 80% complete. Final equipment collection scheduled.', 'All barriers removed. Signs collected.', 'None — clean finish expected.', '', 2);
        insertUpdate40.run(9, daysAgo40(4), 'Olympic Blvd works on track. ROL approved. Night crew performing well.', 'Stage 1 traffic switch complete.', 'Wet weather risk next week.', '', 3);
        insertUpdate40.run(10, daysAgo40(5), 'Victoria Rd setup progressing. Crew familiarised with TGS.', 'Initial setup 25% complete.', 'Heavy traffic volumes requiring additional spotter.', '', 2);
        insertUpdate40.run(11, daysAgo40(3), 'Campbelltown job approaching deadline. Progress claim dispute ongoing.', 'Barrier install 70% done.', 'Payment delay from Georgiou. Accounts following up.', 'Cannot order additional materials until payment received.', 1);
      } catch (e) { /* ignore duplicates */ }

      console.log('Demo data seeded successfully.');
    } catch (e) {
      console.error('Demo data seed error:', e.message);
    }
}

function initializeDatabase() {
  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Whitelabel seed gate — must be declared in this scope because the
  // dev-user seed (line ~10825) and the T&S named-admin re-seed
  // (line ~10883) live in initializeDatabase, not in runMigrations where
  // the same const is declared at line 35. Without this, prod startup
  // crashed with `ReferenceError: SEED_T_AND_S_DATA is not defined` and
  // Railway entered a restart loop (commit 6e7e36a regression).
  const SEED_T_AND_S_DATA = process.env.SEED_T_AND_S_DATA === 'true';

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin','operations','planning','finance','hr','sales','management','marketing','accounts')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_number TEXT UNIQUE NOT NULL,
      job_name TEXT NOT NULL,
      client TEXT NOT NULL,
      site_address TEXT NOT NULL,
      suburb TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'lead' CHECK(status IN ('lead','won','active','on_hold','completed','lost')),
      stage TEXT NOT NULL DEFAULT 'tender' CHECK(stage IN ('tender','prestart','delivery','closeout')),
      percent_complete INTEGER NOT NULL DEFAULT 0 CHECK(percent_complete >= 0 AND percent_complete <= 100),
      start_date DATE NOT NULL,
      end_date DATE,
      project_manager_id INTEGER REFERENCES users(id),
      ops_supervisor_id INTEGER REFERENCES users(id),
      planning_owner_id INTEGER REFERENCES users(id),
      marketing_owner_id INTEGER REFERENCES users(id),
      accounts_owner_id INTEGER REFERENCES users(id),
      health TEXT NOT NULL DEFAULT 'green' CHECK(health IN ('green','amber','red')),
      accounts_status TEXT NOT NULL DEFAULT 'na' CHECK(accounts_status IN ('na','on_track','overdue','disputed')),
      division_tags TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      last_update_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      week_ending DATE NOT NULL,
      summary TEXT NOT NULL,
      milestones TEXT DEFAULT '',
      issues_risks TEXT DEFAULT '',
      blockers TEXT DEFAULT '',
      submitted_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id),
      due_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      escalation_level INTEGER NOT NULL DEFAULT 0,
      completed_date DATE,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS compliance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','other')),
      title TEXT NOT NULL,
      authority_approver TEXT DEFAULT '',
      internal_approver_id INTEGER REFERENCES users(id),
      due_date DATE NOT NULL,
      submitted_date DATE,
      approved_date DATE,
      expiry_date DATE,
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
      document_path TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      library TEXT NOT NULL CHECK(library IN ('delivery','accounts')),
      category TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- TIER-ONE ENHANCEMENT TABLES
    -- ============================================

    -- Activity Log / Audit Trail
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('create','update','delete','login','logout','upload','download','complete','approve','reject')),
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      entity_label TEXT DEFAULT '',
      job_id INTEGER REFERENCES jobs(id),
      job_number TEXT DEFAULT '',
      details TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Safety & Incident Reporting
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      incident_number TEXT UNIQUE NOT NULL,
      incident_type TEXT NOT NULL CHECK(incident_type IN ('near_miss','traffic_incident','worker_injury','vehicle_damage','public_complaint','environmental','injury','hazard','property_damage','vehicle','other')),
      severity TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT DEFAULT '',
      incident_date DATE NOT NULL,
      incident_time TEXT DEFAULT '',
      reported_by_id INTEGER NOT NULL REFERENCES users(id),
      persons_involved TEXT DEFAULT '',
      witnesses TEXT DEFAULT '',
      immediate_actions TEXT DEFAULT '',
      root_cause TEXT DEFAULT '',
      investigation_status TEXT NOT NULL DEFAULT 'reported' CHECK(investigation_status IN ('reported','investigating','resolved','closed')),
      notifiable_incident INTEGER NOT NULL DEFAULT 0,
      photo_path TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS corrective_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      assigned_to_id INTEGER REFERENCES users(id),
      due_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','overdue','cancelled')),
      completed_date DATE,
      completion_notes TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Crew Members & Timesheets
    CREATE TABLE IF NOT EXISTS crew_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      employee_id TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'traffic_controller' CHECK(role IN ('traffic_controller','leading_hand','supervisor','pilot_vehicle','spotter','labourer','other')),
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      licence_type TEXT DEFAULT '',
      licence_expiry DATE,
      induction_date DATE,
      active INTEGER NOT NULL DEFAULT 1,
      hourly_rate REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS timesheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
      work_date DATE NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      break_minutes INTEGER NOT NULL DEFAULT 30,
      total_hours REAL NOT NULL DEFAULT 0,
      shift_type TEXT NOT NULL DEFAULT 'day' CHECK(shift_type IN ('day','night','split')),
      role_on_site TEXT DEFAULT '',
      approved INTEGER NOT NULL DEFAULT 0,
      approved_by_id INTEGER REFERENCES users(id),
      approved_at DATETIME,
      notes TEXT DEFAULT '',
      submitted_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Budget & Cost Tracking
    CREATE TABLE IF NOT EXISTS job_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      contract_value REAL NOT NULL DEFAULT 0,
      budget_labour REAL NOT NULL DEFAULT 0,
      budget_materials REAL NOT NULL DEFAULT 0,
      budget_subcontractors REAL NOT NULL DEFAULT 0,
      budget_equipment REAL NOT NULL DEFAULT 0,
      budget_other REAL NOT NULL DEFAULT 0,
      variations_approved REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      updated_by_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      budget_id INTEGER NOT NULL REFERENCES job_budgets(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK(category IN ('labour','materials','subcontractors','equipment','other')),
      description TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      entry_date DATE NOT NULL,
      invoice_ref TEXT DEFAULT '',
      supplier TEXT DEFAULT '',
      entered_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Client Contacts & Communication Log
    CREATE TABLE IF NOT EXISTS client_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      contact_type TEXT NOT NULL CHECK(contact_type IN ('client','council','utility','rms','subcontractor','consultant','other')),
      company TEXT NOT NULL,
      full_name TEXT NOT NULL,
      position TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS communication_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES client_contacts(id) ON DELETE SET NULL,
      comm_type TEXT NOT NULL CHECK(comm_type IN ('phone','email','meeting','site_visit','letter','other')),
      direction TEXT NOT NULL DEFAULT 'outgoing' CHECK(direction IN ('incoming','outgoing')),
      subject TEXT NOT NULL,
      summary TEXT NOT NULL,
      follow_up_required INTEGER NOT NULL DEFAULT 0,
      follow_up_date DATE,
      follow_up_done INTEGER NOT NULL DEFAULT 0,
      logged_by_id INTEGER NOT NULL REFERENCES users(id),
      comm_date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Equipment & Asset Register
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('barrier','sign','arrow_board','vms','vehicle','lighting','cone','delineator','other')),
      description TEXT DEFAULT '',
      serial_number TEXT DEFAULT '',
      purchase_date DATE,
      purchase_cost REAL DEFAULT 0,
      current_condition TEXT NOT NULL DEFAULT 'good' CHECK(current_condition IN ('new','good','fair','poor','damaged','decommissioned')),
      storage_location TEXT DEFAULT '',
      next_inspection_date DATE,
      inspection_interval_days INTEGER DEFAULT 90,
      notes TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS equipment_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      assigned_date DATE NOT NULL,
      expected_return_date DATE,
      actual_return_date DATE,
      quantity INTEGER NOT NULL DEFAULT 1,
      assigned_by_id INTEGER NOT NULL REFERENCES users(id),
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS equipment_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      maintenance_type TEXT NOT NULL CHECK(maintenance_type IN ('inspection','repair','service','calibration','replacement')),
      description TEXT NOT NULL,
      performed_date DATE NOT NULL,
      performed_by TEXT DEFAULT '',
      cost REAL DEFAULT 0,
      next_due_date DATE,
      result TEXT NOT NULL DEFAULT 'pass' CHECK(result IN ('pass','fail','conditional')),
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Defects & Snag List
    CREATE TABLE IF NOT EXISTS defects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      defect_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'minor' CHECK(severity IN ('minor','moderate','major','critical')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','rectification','closed','deferred')),
      reported_by_id INTEGER NOT NULL REFERENCES users(id),
      assigned_to_id INTEGER REFERENCES users(id),
      reported_date DATE NOT NULL,
      target_close_date DATE,
      actual_close_date DATE,
      photo_path TEXT DEFAULT '',
      rectification_notes TEXT DEFAULT '',
      linked_compliance_id INTEGER REFERENCES compliance(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','new_incident','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','timesheet_approval','budget_alert','general')),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT DEFAULT '',
      job_id INTEGER REFERENCES jobs(id),
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance (original)
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_job_number ON jobs(job_number);
    CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
    CREATE INDEX IF NOT EXISTS idx_jobs_suburb ON jobs(suburb);
    CREATE INDEX IF NOT EXISTS idx_jobs_health ON jobs(health);
    CREATE INDEX IF NOT EXISTS idx_jobs_pm ON jobs(project_manager_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_start_date ON jobs(start_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
    CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
    CREATE INDEX IF NOT EXISTS idx_updates_job_id ON project_updates(job_id);
    CREATE INDEX IF NOT EXISTS idx_updates_week ON project_updates(week_ending);
    CREATE INDEX IF NOT EXISTS idx_documents_job_id ON documents(job_id);
    CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library);

    -- New indexes for tier-one tables
    CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_job ON activity_log(job_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_job ON incidents(job_id);
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(investigation_status);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
    CREATE INDEX IF NOT EXISTS idx_incidents_date ON incidents(incident_date);
    CREATE INDEX IF NOT EXISTS idx_corrective_actions_incident ON corrective_actions(incident_id);
    CREATE INDEX IF NOT EXISTS idx_corrective_actions_status ON corrective_actions(status);
    CREATE INDEX IF NOT EXISTS idx_corrective_actions_due ON corrective_actions(due_date);
    CREATE INDEX IF NOT EXISTS idx_crew_members_active ON crew_members(active);
    CREATE INDEX IF NOT EXISTS idx_timesheets_job ON timesheets(job_id);
    CREATE INDEX IF NOT EXISTS idx_timesheets_crew ON timesheets(crew_member_id);
    CREATE INDEX IF NOT EXISTS idx_timesheets_date ON timesheets(work_date);
    CREATE INDEX IF NOT EXISTS idx_timesheets_approved ON timesheets(approved);
    CREATE INDEX IF NOT EXISTS idx_job_budgets_job ON job_budgets(job_id);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_job ON cost_entries(job_id);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_category ON cost_entries(category);
    CREATE INDEX IF NOT EXISTS idx_client_contacts_job ON client_contacts(job_id);
    CREATE INDEX IF NOT EXISTS idx_communication_log_job ON communication_log(job_id);
    CREATE INDEX IF NOT EXISTS idx_communication_log_contact ON communication_log(contact_id);
    CREATE INDEX IF NOT EXISTS idx_communication_log_followup ON communication_log(follow_up_required, follow_up_done);
    CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(category);
    CREATE INDEX IF NOT EXISTS idx_equipment_active ON equipment(active);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_equip ON equipment_assignments(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_job ON equipment_assignments(job_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_equip ON equipment_maintenance(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_defects_job ON defects(job_id);
    CREATE INDEX IF NOT EXISTS idx_defects_status ON defects(status);
    CREATE INDEX IF NOT EXISTS idx_defects_severity ON defects(severity);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
  `);

  // Run migrations to add new columns, expand CHECK constraints, and create new tables
  runMigrations(db);

  // Seed default admin user(s) if no users exist.
  //
  // Two distinct paths so the well-known dev passwords (admin/admin123,
  // *_user/password, named admins) never end up in a production DB on
  // first boot. The old behaviour seeded them unconditionally, which left
  // a 'admin/admin123' account on every fresh prod deploy waiting to be
  // changed by hand.
  //
  // Production first boot:
  //   - If INITIAL_ADMIN_PASSWORD is set, use it.
  //   - Else generate a strong random password and log it to stdout
  //     exactly once. The operator captures it from Railway logs, signs
  //     in, and is forced to change it (must_change_password = 1).
  //   - No other dev accounts are created.
  //
  // Non-production first boot:
  //   - Keep the existing developer convenience seeds (admin/admin123,
  //     etc.) but mark every one of them must_change_password = 1 so the
  //     account is unusable for real work without picking a new password.
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const isProd = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, must_change_password)
      VALUES (?, ?, ?, ?, ?, 1)
    `);

    if (isProd) {
      const explicit = process.env.INITIAL_ADMIN_PASSWORD;
      const adminPassword = explicit || require('crypto').randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16);
      const hash = bcrypt.hashSync(adminPassword, 12);
      insertUser.run('admin', hash, 'Admin User', 'admin@tstraffic.com.au', 'admin');

      const banner =
        '\n' + '='.repeat(60) +
        '\nFIRST BOOT — seeded a single admin account' +
        (explicit
          ? '\n  password: (from INITIAL_ADMIN_PASSWORD env var)'
          : '\n  username: admin' +
            '\n  password: ' + adminPassword +
            '\n  (no INITIAL_ADMIN_PASSWORD set — random password generated)') +
        '\nThis account is forced to change password on first login.' +
        '\nSign in NOW, change the password, then delete this log entry.' +
        '\n' + '='.repeat(60) + '\n';
      console.warn(banner);
    } else {
      // Developer convenience seeds — never used in production.
      // Every account is must_change_password=1 so even if a dev DB
      // somehow gets cloned to prod, the seed passwords can't be used.
      //
      // Generic dev users (admin, ops_user, planning_user, etc.) seed
      // on every fresh non-prod DB. T&S-named admins (suhail.a, saadat,
      // savanah, taj) are gated by SEED_T_AND_S_DATA so white-label
      // dev DBs don't ship with those identities.
      const dev = (pw) => bcrypt.hashSync(pw, 12);
      insertUser.run('admin',         dev('admin123'),    'Admin User',     'admin@tstraffic.com.au',     'admin');
      insertUser.run('ops_user',      dev('password'),    'Sam Operations', 'sam@tstraffic.com.au',       'operations');
      insertUser.run('planning_user', dev('password'),    'Alex Planning',  'alex@tstraffic.com.au',      'planning');
      insertUser.run('finance_user',  dev('password'),    'Pat Finance',    'pat@tstraffic.com.au',       'finance');
      insertUser.run('accounts_user', dev('password'),    'Jordan Accounts','jordan@tstraffic.com.au',    'finance');
      if (SEED_T_AND_S_DATA) {
        insertUser.run('suhail.a',  dev('Suhail123'),   'Suhail Ahmed', 'suhail@tstc.com.au',   'admin');
        insertUser.run('saadat',    dev('TandS2026.'),  'Saadat',       'saadat@tstc.com.au',   'admin');
        insertUser.run('savanah',   dev('Savanah123'),  'Savanah',      'savanah@tstc.com.au',  'admin');
        insertUser.run('taj',       dev('Taj123'),      'Taj',          'taj@tstc.com.au',      'admin');
        console.log('Dev DB seeded with generic + T&S-named admin users — all flagged must_change_password=1.');
      } else {
        console.log('Dev DB seeded with generic admin users only (set SEED_T_AND_S_DATA=true for T&S-named admins). All flagged must_change_password=1.');
      }
    }
  }

  // ── One-time cleanup: ensure all demo/seed data is gone ──
  // Uses system_config flag so it only runs once (won't wipe real data added later)
  try {
    const cleanupDone = db.prepare("SELECT value FROM system_config WHERE key = 'demo_data_cleaned'").get();
    if (!cleanupDone) {
      console.log('Cleaning up demo/seed data...');
      const demoTables = [
        'traffic_plans', 'crew_allocations', 'timesheets', 'cost_entries',
        'job_budgets', 'incidents', 'defects', 'tasks', 'equipment',
        'contacts', 'compliance_items', 'crew_members', 'employees',
        'jobs', 'clients', 'equipment_assignments', 'equipment_maintenance',
        'activity_log', 'opportunities', 'crm_activities', 'communication_log',
        'project_updates', 'compliance',
      ];
      for (const table of demoTables) {
        try {
          const count = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
          if (count > 0) {
            db.exec(`DELETE FROM ${table}`);
            console.log(`  Cleared ${count} rows from ${table}`);
          }
        } catch (e) { /* table may not exist */ }
      }
      // Reset auto-increment counters
      try {
        db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${demoTables.map(t => "'" + t + "'").join(',')})`);
      } catch (e) { /* ignore */ }
      // Mark cleanup as done so it never runs again
      db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('demo_data_cleaned', '1')").run();
      console.log('Demo data cleanup complete.');
    }
  } catch (e) {
    console.error('Demo cleanup error (non-fatal):', e.message);
  }

  // Ensure key T&S admin accounts always exist (survives DB resets).
  //
  // Phase A audit fix: this block previously ran unconditionally on every
  // startup and re-created suhail.a / saadat / savanah / taj with their
  // dev passwords if missing — *without* setting must_change_password=1.
  // That meant any account deletion (or a fresh white-label DB) would
  // immediately reintroduce live T&S admins with known credentials.
  //
  // Now gated by SEED_T_AND_S_DATA, and every insert is flagged
  // must_change_password=1 so the dev passwords are unusable for real
  // work even if the gate is on.
  if (SEED_T_AND_S_DATA) {
    const ensureUser = db.prepare(`
      INSERT OR IGNORE INTO users (username, password_hash, full_name, email, role, must_change_password)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const ensureUsers = [
      ['suhail.a', 'Suhail123', 'Suhail Ahmed', 'suhail@tstc.com.au', 'admin'],
      ['saadat', 'TandS2026.', 'Saadat', 'saadat@tstc.com.au', 'admin'],
      ['savanah', 'Savanah123', 'Savanah', 'savanah@tstc.com.au', 'admin'],
      ['taj', 'Taj123', 'Taj', 'taj@tstc.com.au', 'admin'],
    ];
    for (const [uname, pwd, fullName, email, role] of ensureUsers) {
      if (!db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) {
        ensureUser.run(uname, bcrypt.hashSync(pwd, 12), fullName, email, role);
        console.log(`Created ${uname} user (must_change_password=1).`);
      }
    }
  } else {
    console.log('ensureUsers: skipped T&S named-admin re-seed (set SEED_T_AND_S_DATA=true to enable)');
  }

  db.close();
  console.log('Database initialized at', DB_PATH);
}

module.exports = { initializeDatabase, DB_PATH };
