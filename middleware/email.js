/**
 * Email Utility — Task-specific email templates.
 * Uses the unified services/email.js (Resend HTTP API + SMTP fallback).
 */
const { sendEmail } = require('../services/email');

/**
 * Send a task assignment email to the task owner.
 */
async function sendTaskAssignmentEmail(taskData, ownerUser, jobLabel, assignedByName, baseUrl) {
  if (!ownerUser || !ownerUser.email) return false;

  const priorityColors = { high: '#EF4444', medium: '#F59E0B', low: '#9CA3AF' };
  const priorityColor = priorityColors[taskData.priority] || '#9CA3AF';
  const priorityLabel = (taskData.priority || 'medium').charAt(0).toUpperCase() + (taskData.priority || 'medium').slice(1);
  const dueDate = taskData.due_date ? new Date(taskData.due_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'No due date';
  const taskUrl = (baseUrl || process.env.APP_BASE_URL || '') + '/tasks/' + taskData.id + '/edit';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <div style="background: #0F1115; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #F5F5F7; margin: 0; font-size: 22px; font-weight: 500; letter-spacing: -0.03em; font-family: Georgia, serif;">atomis</h2>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; background: #FAFAFA;">
        <p style="color: #374151; margin: 0 0 16px;">Hi <strong>${ownerUser.full_name}</strong>,</p>
        <p style="color: #6B7280; margin: 0 0 20px; font-size: 14px;">A task has been assigned to you${assignedByName ? ' by <strong>' + assignedByName + '</strong>' : ''}:</p>
        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: #111827; margin: 0 0 8px; font-size: 16px;">${taskData.title}</h3>
          ${taskData.description ? '<p style="color: #9CA3AF; margin: 0 0 12px; font-size: 13px;">' + taskData.description + '</p>' : ''}
          <table style="width: 100%; font-size: 13px; color: #6B7280;">
            <tr><td style="padding: 4px 0;"><strong>Project:</strong></td><td style="padding: 4px 0;">${jobLabel}</td></tr>
            <tr><td style="padding: 4px 0;"><strong>Due Date:</strong></td><td style="padding: 4px 0;">${dueDate}</td></tr>
            <tr><td style="padding: 4px 0;"><strong>Priority:</strong></td><td style="padding: 4px 0;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${priorityColor};margin-right:6px;"></span>${priorityLabel}</td></tr>
          </table>
        </div>
        <div style="text-align: center;">
          <a href="${taskUrl}" style="display: inline-block; background: #10B981; color: #0F1115; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View Task</a>
        </div>
        <p style="color: #9CA3AF; font-size: 12px; margin: 20px 0 0; text-align: center;">T&S Traffic Control Pty Ltd · Powered by Atomis</p>
      </div>
    </div>
  `;

  return sendEmail(ownerUser.email, 'Task Assigned: ' + taskData.title, html);
}

/**
 * Send a task status change email to the task owner.
 */
async function sendTaskStatusEmail(taskData, ownerUser, newStatus, changedByName, baseUrl) {
  if (!ownerUser || !ownerUser.email) return false;

  const statusLabels = { not_started: 'Not Started', in_progress: 'In Progress', blocked: 'Blocked', complete: 'Complete' };
  const statusLabel = statusLabels[newStatus] || newStatus;
  const taskUrl = (baseUrl || process.env.APP_BASE_URL || '') + '/tasks/' + taskData.id + '/edit';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <div style="background: #0F1115; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #F5F5F7; margin: 0; font-size: 22px; font-weight: 500; letter-spacing: -0.03em; font-family: Georgia, serif;">atomis</h2>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; background: #FAFAFA;">
        <p style="color: #374151; margin: 0 0 16px;">Hi <strong>${ownerUser.full_name}</strong>,</p>
        <p style="color: #6B7280; margin: 0 0 20px; font-size: 14px;">The status of your task has been updated${changedByName ? ' by <strong>' + changedByName + '</strong>' : ''}:</p>
        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: #111827; margin: 0 0 8px; font-size: 16px;">${taskData.title}</h3>
          <p style="color: #6B7280; font-size: 14px; margin: 0;">New Status: <strong>${statusLabel}</strong></p>
        </div>
        <div style="text-align: center;">
          <a href="${taskUrl}" style="display: inline-block; background: #10B981; color: #0F1115; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View Task</a>
        </div>
        <p style="color: #9CA3AF; font-size: 12px; margin: 20px 0 0; text-align: center;">T&S Traffic Control Pty Ltd · Powered by Atomis</p>
      </div>
    </div>
  `;

  return sendEmail(ownerUser.email, 'Task Update: ' + taskData.title + ' — ' + statusLabel, html);
}

/**
 * Send a deadline reminder email for tasks due soon.
 */
async function sendDeadlineReminderEmail(taskData, ownerUser, daysUntilDue, baseUrl) {
  if (!ownerUser || !ownerUser.email) return false;

  const taskUrl = (baseUrl || process.env.APP_BASE_URL || '') + '/tasks/' + taskData.id + '/edit';
  const dueDate = taskData.due_date ? new Date(taskData.due_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Unknown';
  const urgencyColor = daysUntilDue <= 1 ? '#EF4444' : '#F59E0B';
  const urgencyText = daysUntilDue === 0 ? 'due today' : daysUntilDue === 1 ? 'due tomorrow' : `due in ${daysUntilDue} days`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <div style="background: ${urgencyColor}; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: white; margin: 0; font-size: 18px;">Deadline Reminder</h2>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; background: #FAFAFA;">
        <p style="color: #374151; margin: 0 0 16px;">Hi <strong>${ownerUser.full_name}</strong>,</p>
        <p style="color: #6B7280; margin: 0 0 20px; font-size: 14px;">You have a task <strong style="color: ${urgencyColor};">${urgencyText}</strong>:</p>
        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: #111827; margin: 0 0 8px; font-size: 16px;">${taskData.title}</h3>
          <p style="color: #6B7280; font-size: 13px; margin: 0 0 4px;"><strong>Due:</strong> ${dueDate}</p>
          ${taskData.job_number ? '<p style="color: #6B7280; font-size: 13px; margin: 0;"><strong>Project:</strong> ' + taskData.job_number + '</p>' : ''}
        </div>
        <div style="text-align: center;">
          <a href="${taskUrl}" style="display: inline-block; background: #10B981; color: #0F1115; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View Task</a>
        </div>
        <p style="color: #9CA3AF; font-size: 12px; margin: 20px 0 0; text-align: center;">T&S Traffic Control Pty Ltd · Powered by Atomis</p>
      </div>
    </div>
  `;

  return sendEmail(ownerUser.email, `Deadline ${urgencyText}: ${taskData.title}`, html);
}

/**
 * Send allocation notification email to a user (PM or supervisor) when crew is allocated.
 */
async function sendAllocationEmail(allocation, recipientUser, allocatedByName, baseUrl) {
  if (!recipientUser || !recipientUser.email) return false;

  const allocUrl = (baseUrl || process.env.APP_BASE_URL || '') + '/allocations?date=' + allocation.allocation_date;
  const dateStr = new Date(allocation.allocation_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
      <div style="background: #0F1115; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #F5F5F7; margin: 0; font-size: 22px; font-weight: 500; letter-spacing: -0.03em; font-family: Georgia, serif;">atomis</h2>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; background: #FAFAFA;">
        <p style="color: #374151; margin: 0 0 16px;">Hi <strong>${recipientUser.full_name}</strong>,</p>
        <p style="color: #6B7280; margin: 0 0 20px; font-size: 14px;">A crew allocation has been made${allocatedByName ? ' by <strong>' + allocatedByName + '</strong>' : ''}:</p>
        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <table style="width: 100%; font-size: 13px; color: #6B7280;">
            <tr><td style="padding: 4px 0;"><strong>Crew Member:</strong></td><td style="padding: 4px 0;">${allocation.crew_name}</td></tr>
            <tr><td style="padding: 4px 0;"><strong>Job:</strong></td><td style="padding: 4px 0;">${allocation.job_number} — ${allocation.client}</td></tr>
            <tr><td style="padding: 4px 0;"><strong>Date:</strong></td><td style="padding: 4px 0;">${dateStr}</td></tr>
            ${allocation.shift_type ? '<tr><td style="padding: 4px 0;"><strong>Shift:</strong></td><td style="padding: 4px 0;">' + allocation.shift_type + '</td></tr>' : ''}
          </table>
        </div>
        <div style="text-align: center;">
          <a href="${allocUrl}" style="display: inline-block; background: #10B981; color: #0F1115; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View Allocations</a>
        </div>
        <p style="color: #9CA3AF; font-size: 12px; margin: 20px 0 0; text-align: center;">T&S Traffic Control Pty Ltd · Powered by Atomis</p>
      </div>
    </div>
  `;

  return sendEmail(recipientUser.email, `Crew Allocated: ${allocation.crew_name} → ${allocation.job_number}`, html);
}

module.exports = { sendEmail, sendTaskAssignmentEmail, sendTaskStatusEmail, sendDeadlineReminderEmail, sendAllocationEmail };
