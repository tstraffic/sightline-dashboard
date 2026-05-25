const { getDb } = require('../db/database');

/**
 * Create a notification immediately (inline, not batch).
 * Optionally deduplicates within a 1-hour window.
 */
function createNotification({ userId, type, title, message, link, jobId, deduplicate }) {
  try {
    const db = getDb();
    if (deduplicate) {
      const existing = db.prepare(
        `SELECT 1 FROM notifications WHERE user_id = ? AND type = ? AND title = ? AND created_at > datetime('now', '-1 hour')`
      ).get(userId, type, title);
      if (existing) return;
    }
    db.prepare(
      `INSERT INTO notifications (user_id, type, title, message, link, job_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, type, title, message, link || '', jobId || null);
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}

/**
 * Notify multiple users about a task assignment.
 * Skips the person who did the assigning (assignedById).
 */
function notifyTaskAssignees(assigneeIds, { taskTitle, taskId, jobId, jobNumber, assignedByName, assignedById }) {
  for (const userId of assigneeIds) {
    if (Number(userId) === Number(assignedById)) continue;
    createNotification({
      userId: Number(userId),
      type: 'task_assigned',
      title: 'New Task: ' + taskTitle,
      message: assignedByName + ' assigned you to "' + taskTitle + '" on ' + (jobNumber || 'a job') + '.',
      link: '/tasks/' + taskId + '/edit',
      jobId: jobId || null,
      deduplicate: true
    });
  }
}

module.exports = { createNotification, notifyTaskAssignees };
