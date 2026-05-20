const { Resend } = require('resend');
const nodemailer = require('nodemailer');

let _resendClient = null;
let _transporter = null;
let _lastConfigHash = null;

/**
 * Get the Resend API key from env vars or system_config DB.
 * Returns { apiKey, fromName, fromEmail } or null.
 */
function getResendConfig() {
  // Check env vars: RESEND_API_KEY or SMTP_PASS starting with re_
  const apiKey = process.env.RESEND_API_KEY
    || (process.env.SMTP_PASS && process.env.SMTP_PASS.startsWith('re_') ? process.env.SMTP_PASS : null);

  if (apiKey) {
    return {
      apiKey,
      fromName: process.env.SMTP_FROM_NAME || 'T&S Traffic Control',
      fromEmail: process.env.SMTP_FROM_EMAIL || 'onboarding@resend.dev',
    };
  }

  // Fall back to system_config DB
  try {
    const { getConfig } = require('../middleware/settings');
    const pass = getConfig('smtp_pass', '');
    if (pass && pass.startsWith('re_')) {
      return {
        apiKey: pass,
        fromName: 'T&S Traffic Control',
        fromEmail: getConfig('smtp_from', 'onboarding@resend.dev'),
      };
    }
  } catch (e) { /* settings not ready */ }

  return null;
}

/**
 * Get SMTP config for non-Resend providers (M365, Gmail, etc.).
 */
function getSmtpConfig() {
  if (process.env.SMTP_USER && process.env.SMTP_PASS && !process.env.SMTP_PASS.startsWith('re_')) {
    return {
      host: process.env.SMTP_HOST || 'smtp.office365.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      fromName: process.env.SMTP_FROM_NAME || 'T&S Traffic Control',
      fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    };
  }

  try {
    const { getConfig } = require('../middleware/settings');
    const host = getConfig('smtp_host', '');
    const user = getConfig('smtp_user', '');
    const pass = getConfig('smtp_pass', '');
    if (host && user && pass && !pass.startsWith('re_')) {
      const port = parseInt(getConfig('smtp_port', '587'), 10);
      return {
        host, port,
        secure: port === 465,
        user, pass,
        fromName: 'T&S Traffic Control',
        fromEmail: getConfig('smtp_from', user),
      };
    }
  } catch (e) { /* settings not ready */ }

  return null;
}

function getResendClient() {
  const config = getResendConfig();
  if (!config) return null;
  if (!_resendClient || _lastConfigHash !== config.apiKey) {
    _resendClient = new Resend(config.apiKey);
    _lastConfigHash = config.apiKey;
  }
  return _resendClient;
}

function getTransporter() {
  const config = getSmtpConfig();
  if (!config) return null;
  const hash = `${config.host}:${config.port}:${config.user}`;
  if (_transporter && _lastConfigHash === hash) return _transporter;
  _transporter = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 10000, socketTimeout: 10000,
  });
  _lastConfigHash = hash;
  return _transporter;
}

/**
 * Check if email is configured (Resend API or SMTP)
 */
function isConfigured() {
  return getResendConfig() !== null || getSmtpConfig() !== null;
}

/**
 * Send an email. Uses Resend HTTP API if key starts with re_, otherwise SMTP.
 */
async function sendEmail(to, subject, html, opts) {
  // opts: { attachments: [{ filename, content: Buffer|Base64 }], cc, bcc, replyTo }
  const attachments = (opts && opts.attachments) || null;
  const cc = (opts && opts.cc) || undefined;
  const bcc = (opts && opts.bcc) || undefined;
  const replyTo = (opts && opts.replyTo) || undefined;

  // Try Resend HTTP API first
  const resendConfig = getResendConfig();
  if (resendConfig) {
    try {
      const client = getResendClient();
      // Resend wants base64 strings for attachment content. Coerce Buffers
      // up here so callers can hand us either form.
      const resendAttachments = attachments && attachments.map(a => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
      }));
      const payload = {
        from: `${resendConfig.fromName} <${resendConfig.fromEmail}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      };
      if (resendAttachments && resendAttachments.length) payload.attachments = resendAttachments;
      if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
      if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
      if (replyTo) payload.reply_to = replyTo;
      const { data, error } = await client.emails.send(payload);
      if (error) {
        console.error('[Email/Resend] API error:', error.message || JSON.stringify(error));
        return null;
      }
      // Log subject + Resend message id for ops tracking; recipient is PII so
      // omit it (id is enough to look the message up in Resend dashboard).
      console.log('[Email/Resend] Sent:', subject, '| id:', data?.id);
      return data;
    } catch (err) {
      console.error('[Email/Resend] Send error:', err.message);
      return null;
    }
  }

  // Fall back to SMTP
  const smtpConfig = getSmtpConfig();
  if (!smtpConfig) {
    console.warn('[Email] Not configured — skipping:', subject);
    return null;
  }
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from: `"${smtpConfig.fromName}" <${smtpConfig.fromEmail}>`,
      to, subject, html,
      attachments: attachments || undefined,
      cc, bcc, replyTo,
    });
    console.log('[Email/SMTP] Sent:', subject);
    return info;
  } catch (err) {
    console.error('[Email/SMTP] Send error:', err.message);
    return null;
  }
}

/**
 * Test email connectivity.
 */
async function testConnection() {
  const resendConfig = getResendConfig();
  if (resendConfig) {
    // Resend send-only keys can't call domains.list, so just validate the key is set
    if (!resendConfig.apiKey || !resendConfig.apiKey.startsWith('re_')) {
      throw new Error('Invalid Resend API key');
    }
    return true;
  }

  const transporter = getTransporter();
  if (!transporter) throw new Error('Email not configured');
  return transporter.verify();
}

module.exports = { sendEmail, testConnection, isConfigured };
