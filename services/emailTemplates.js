const APP_URL = () => process.env.APP_BASE_URL || 'http://localhost:3000';

function baseTemplate(title, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <!-- Header -->
        <tr><td style="background:#0F1115;padding:24px;border-radius:12px 12px 0 0;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#F5F5F7;font-size:26px;font-weight:500;letter-spacing:-0.04em;font-family:Georgia,serif;">atomis</td>
              <td align="right" style="color:#10B981;font-size:13px;font-style:italic;">simple systems. smarter business.</td>
            </tr>
          </table>
        </td></tr>
        <!-- Body -->
        <tr><td style="background:#ffffff;padding:32px 24px;border:1px solid #E5E7EB;border-top:none;">
          <h2 style="margin:0 0 16px;color:#111827;font-size:20px;font-weight:600;">${title}</h2>
          ${bodyContent}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:16px 24px;text-align:center;border-radius:0 0 12px 12px;">
          <p style="margin:0;color:#9CA3AF;font-size:12px;">&copy; T&S Traffic Control Pty Ltd &middot; Powered by Atomis. This is an automated message.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buttonHtml(text, url) {
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr><td style="background:#10B981;border-radius:8px;padding:12px 28px;">
      <a href="${url}" style="color:#0F1115;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">${text}</a>
    </td></tr>
  </table>`;
}

function adminInviteEmail(fullName, inviteUrl, expiresHours) {
  return baseTemplate('You\'ve Been Invited', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">You've been invited to <strong>Atomis</strong>, the operations dashboard for T&S Traffic Control. Click the button below to set your password and activate your account.</p>
    ${buttonHtml('Set Your Password', inviteUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. If you didn't expect this invitation, you can safely ignore this email.</p>
  `);
}

function workerInviteEmail(fullName, setupUrl, expiresHours) {
  return baseTemplate('Set Up Your Atomis Crew PIN', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">You've been set up on <strong>Atomis Crew</strong>, T&S Traffic Control's field operations app. Tap the button below to create your sign-in PIN.</p>
    ${buttonHtml('Set Your PIN', setupUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. You'll use your email and PIN to sign in to Atomis Crew.</p>
  `);
}

function passwordResetEmail(fullName, resetUrl, expiresHours) {
  return baseTemplate('Reset Your Password', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">We received a request to reset your password. Click the button below to choose a new password.</p>
    ${buttonHtml('Reset Password', resetUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. If you didn't request this, you can safely ignore this email.</p>
  `);
}

function pinResetEmail(fullName, resetUrl, expiresHours) {
  return baseTemplate('Reset Your Atomis Crew PIN', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">We received a request to reset your Atomis Crew PIN. Tap the button below to set a new PIN.</p>
    ${buttonHtml('Reset PIN', resetUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">This link expires in ${expiresHours} hours. If you didn't request this, you can safely ignore this email.</p>
  `);
}

function notificationEmail(fullName, title, message, link) {
  const fullLink = link ? (link.startsWith('http') ? link : APP_URL() + link) : '';
  return baseTemplate(title, `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">${message}</p>
    ${fullLink ? buttonHtml('View Details', fullLink) : ''}
  `);
}

function dailyDigestEmail(fullName, notifications) {
  const items = notifications.map(n =>
    `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #F3F4F6;">
        <p style="margin:0;font-size:14px;color:#111827;font-weight:500;">${n.title}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#6B7280;">${n.message}</p>
      </td>
    </tr>`
  ).join('');

  return baseTemplate('Daily Notification Summary', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${fullName}, here's your daily summary of ${notifications.length} notification${notifications.length === 1 ? '' : 's'}:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${items}</table>
    ${buttonHtml('Open Dashboard', APP_URL() + '/notifications')}
  `);
}

function sopSignLinkEmail(fullName, signUrl) {
  return baseTemplate('SOP Sign-Off — Action Required', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${fullName},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">As part of working with T&S Traffic Control, we need you to sign off that you've reviewed our Standard Operating Procedures and been adequately educated on them.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Click the button below on your phone, draw your signature and submit. Takes about 30 seconds.</p>
    ${buttonHtml('Sign SOP acknowledgement', signUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">If the button doesn't work, copy and paste this link into your browser:<br><a href="${signUrl}" style="color:#059669;word-break:break-all;">${signUrl}</a></p>
  `);
}

// Link emailed to a worker so they can open the toolbox talk on their own
// phone and sign off their attendance (draw signature → submit).
function toolboxSignLinkEmail(fullName, toolbox, signUrl) {
  return baseTemplate('Toolbox Talk — Sign Off', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${escapeHtml(fullName || 'there')},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Please sign off your attendance for the toolbox talk <strong>${escapeHtml(toolbox.title)}</strong>${toolbox.held_at ? ' (' + escapeHtml(toolbox.held_at) + ')' : ''}.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Open the link on your phone, pick your name, draw your signature and submit. Takes about 30 seconds.</p>
    ${buttonHtml('Sign off attendance', signUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0;">If the button doesn't work, copy and paste this link into your browser:<br><a href="${signUrl}" style="color:#059669;word-break:break-all;">${signUrl}</a></p>
  `);
}

// Employment agreement — signing link. The unsigned PDF rides along as an
// attachment so the worker has the offer in hand before opening the link.
function contractSignLinkEmail(fullName, signUrl, agreementNumber) {
  return baseTemplate('Your employment agreement — review and sign', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${escapeHtml(fullName || 'there')},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Your casual employment agreement with T&amp;S Traffic Control (<strong>${escapeHtml(agreementNumber)}</strong>) is ready for you to review and sign.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Open the link below, read the agreement carefully — the whole document, including your rates in Schedule A — then tick the acknowledgements and sign on your phone. A copy is attached to this email so you can read it first, and you're welcome to seek independent advice before signing.</p>
    ${buttonHtml('Review and sign your agreement', signUrl)}
    <p style="color:#6B7280;font-size:13px;margin:0 0 8px;">This link is unique to you — please don't forward it. It expires after 14 days; if it does, contact the office for a fresh one.</p>
    <p style="color:#6B7280;font-size:13px;margin:0;">If the button doesn't work, copy and paste this link into your browser:<br><a href="${signUrl}" style="color:#059669;word-break:break-all;">${signUrl}</a></p>
  `);
}

// Employment agreement — signed confirmation, with the executed PDF attached.
function contractSignedEmail(fullName, agreementNumber) {
  return baseTemplate('Your signed employment agreement', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${escapeHtml(fullName || 'there')},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Thanks — your casual employment agreement with T&amp;S Traffic Control (<strong>${escapeHtml(agreementNumber)}</strong>) has been signed. Your copy is attached to this email; keep it for your records.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Welcome aboard. The office will be in touch with your onboarding and first-shift details.</p>
    <p style="color:#6B7280;font-size:13px;margin:0;">If anything in the agreement looks wrong, contact the T&amp;S office straight away.</p>
  `);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Cover email for the TS-SAF-FRM-005 Toolbox Talk Record PDF sent to a
// client as evidence the safety items raised on their job were addressed.
function toolboxClientEmail(recipientName, toolbox, message, senderName) {
  const rows = [
    ['Topic', toolbox.title],
    ['Date', toolbox.held_at],
    ['Site / Location', toolbox.site_location],
    ['Job / Project', toolbox.job_label],
    ['Presenter', toolbox.presenter],
    ['Atomis Record ID', 'TBX-' + toolbox.id],
  ].filter(r => r[1]).map(([label, value]) =>
    `<tr>
      <td style="padding:6px 12px 6px 0;font-size:13px;color:#6B7280;white-space:nowrap;">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:#111827;font-weight:500;">${escapeHtml(value)}</td>
    </tr>`
  ).join('');
  const customMessage = message
    ? `<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>`
    : '';
  return baseTemplate('Toolbox Talk Record', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px;">Hi ${escapeHtml(recipientName || 'there')},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Please find attached the signed toolbox talk record (TS-SAF-FRM-005) confirming the safety items discussed and addressed with our crew.</p>
    ${customMessage}
    <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:12px 16px;width:100%;">${rows}</table>
    <p style="color:#6B7280;font-size:13px;margin:0;">Sent by ${escapeHtml(senderName || 'T&S Traffic Control')} via Atomis. Worker attendance signatures are embedded in the attached PDF.</p>
  `);
}

// Induction booking confirmation sent to a Seek applicant when an induction
// date is set on the Recruitment board. `whenText` is the pre-formatted
// "on <date> at <time>" (or just "on <date>") clause.
function inductionConfirmationEmail(whenText, inductionUrl) {
  return baseTemplate('Induction Confirmation', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi,</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">This is Suhail from T&amp;S Traffic Control.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">This is a confirmation for your induction at our depot, located at <strong>9 Epic Place, Villawood</strong>.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">It will take place <strong>${escapeHtml(whenText)}</strong>, for the duration of approximately an hour. Please bring hard copies of your licenses, and keep your superannuation details ready if applicable.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 4px;">Please fill out our induction form before you arrive:</p>
    ${buttonHtml('Open Induction Form', inductionUrl)}
    <p style="color:#6B7280;font-size:13px;line-height:1.6;margin:0 0 16px;word-break:break-all;">Or paste this link into your browser: <a href="${inductionUrl}" style="color:#059669;">${inductionUrl}</a></p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0;">Thank you</p>
  `);
}

// Applicant-facing induction reminder — fired 36h and 12h before the booked
// time (services/inductionEmailReminders.js). Same voice and details as the
// confirmation email above so the applicant reads it as part of one thread.
function inductionReminderEmail(whenText, inductionUrl, leadLabel) {
  return baseTemplate('Induction Reminder', `
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi,</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">A friendly reminder from T&amp;S Traffic Control — your induction is <strong>${escapeHtml(leadLabel)}</strong>.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">It takes place <strong>${escapeHtml(whenText)}</strong> at our depot, located at <strong>9 Epic Place, Villawood</strong>, and runs for approximately an hour.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">Please bring hard copies of your licenses, and keep your superannuation details ready if applicable.</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 4px;">If you haven't yet, please fill out our induction form before you arrive:</p>
    ${buttonHtml('Open Induction Form', inductionUrl)}
    <p style="color:#6B7280;font-size:13px;line-height:1.6;margin:0 0 16px;word-break:break-all;">Or paste this link into your browser: <a href="${inductionUrl}" style="color:#059669;">${inductionUrl}</a></p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0;">See you there — T&amp;S Traffic Control</p>
  `);
}

module.exports = {
  adminInviteEmail,
  workerInviteEmail,
  passwordResetEmail,
  inductionConfirmationEmail,
  inductionReminderEmail,
  pinResetEmail,
  notificationEmail,
  dailyDigestEmail,
  sopSignLinkEmail,
  toolboxClientEmail,
  toolboxSignLinkEmail,
  contractSignLinkEmail,
  contractSignedEmail,
};
