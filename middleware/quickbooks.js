// QuickBooks Online integration — OAuth2 + invoice push (Traffio Phase 3).
//
// Hand-rolled against the QBO v3 REST API with axios (deliberately no
// node-quickbooks — it lags Intuit's API and hides token rotation).
//
// Auth state lives in integration_config('quickbooks').config_json:
//   client_id / client_secret  — Intuit app keys (env QBO_CLIENT_ID /
//                                QBO_CLIENT_SECRET override the DB values)
//   environment                — 'sandbox' | 'production' (selects API host)
//   realm_id                   — the connected QBO company
//   access_token / access_token_expires_at
//   refresh_token / refresh_token_expires_at
//   default_item_ref           — cached "Traffic Control Services" Item id
//   tax_code_gst / tax_code_fre — cached AU TaxCode ids (resolved by query,
//                                never hardcoded — ids differ per company)
//
// CRITICAL: Intuit rotates the refresh token on every refresh. The rotated
// token MUST be persisted immediately or the connection dies within ~24h.

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const {
  getIntegrationConfig,
  saveIntegrationConfig,
  getExternalRef,
  setExternalRef,
} = require('./integrations');

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = 73;

function apiBase(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/** Effective app keys — env vars win over the admin-screen config. */
function getAppKeys() {
  const cfg = getIntegrationConfig('quickbooks').config || {};
  return {
    clientId: process.env.QBO_CLIENT_ID || cfg.client_id || '',
    clientSecret: process.env.QBO_CLIENT_SECRET || cfg.client_secret || '',
  };
}

/** The OAuth redirect URI — must EXACTLY match one registered on the Intuit app. */
function redirectUri() {
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/admin/integrations/quickbooks/callback`;
}

/** Build the Intuit authorize URL (state is caller-generated, kept in session). */
function buildAuthorizeUrl(state) {
  const { clientId } = getAppKeys();
  if (!clientId) throw new Error('QuickBooks Client ID is not configured.');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Persist a token response (rotated refresh token included) onto the config. */
function saveTokens(tokenData, realmId) {
  const now = Date.now();
  const patch = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    access_token_expires_at: now + (tokenData.expires_in || 3600) * 1000,
    refresh_token_expires_at: now + (tokenData.x_refresh_token_expires_in || 8726400) * 1000,
  };
  if (realmId) patch.realm_id = String(realmId);
  const existing = getIntegrationConfig('quickbooks');
  saveIntegrationConfig('quickbooks', patch, existing.enabled);
}

function basicAuthHeader() {
  const { clientId, clientSecret } = getAppKeys();
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/** Exchange the OAuth authorization code for tokens (callback step). */
async function exchangeCodeForTokens(code, realmId) {
  const res = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  }).toString(), {
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    timeout: 20000,
  });
  saveTokens(res.data, realmId);
  return res.data;
}

/** Refresh the access token; persists the ROTATED refresh token immediately. */
async function refreshAccessToken() {
  const cfg = getIntegrationConfig('quickbooks').config || {};
  if (!cfg.refresh_token) throw new Error('QuickBooks is not connected — no refresh token. Use Connect to QuickBooks first.');
  const res = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.refresh_token,
  }).toString(), {
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    timeout: 20000,
  });
  saveTokens(res.data);
  return res.data.access_token;
}

/**
 * Authenticated axios instance for the connected company. Refreshes the
 * access token when it's within 5 minutes of expiry.
 */
async function getQboClient() {
  const ic = getIntegrationConfig('quickbooks');
  const cfg = ic.config || {};
  if (!cfg.realm_id) throw new Error('QuickBooks is not connected — no company (realm) linked yet.');

  let accessToken = cfg.access_token;
  const expiresAt = Number(cfg.access_token_expires_at) || 0;
  if (!accessToken || Date.now() > expiresAt - 5 * 60 * 1000) {
    accessToken = await refreshAccessToken();
  }

  return {
    realmId: cfg.realm_id,
    http: axios.create({
      baseURL: `${apiBase(cfg.environment)}/v3/company/${cfg.realm_id}`,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      params: { minorversion: MINOR_VERSION },
      timeout: 30000,
    }),
  };
}

/** Readable message out of a QBO Fault response. */
function qboErrorMessage(err) {
  const fault = err.response && err.response.data && (err.response.data.Fault || err.response.data.fault);
  if (fault && Array.isArray(fault.Error || fault.error)) {
    return (fault.Error || fault.error)
      .map(e => [e.Message || e.message, e.Detail || e.detail].filter(Boolean).join(' — '))
      .join('; ');
  }
  return err.message;
}

/** Run a QBO SQL-ish query, returning the entity array (possibly empty). */
async function qboQuery(client, query, entityKey) {
  const res = await client.http.get('/query', { params: { query, minorversion: MINOR_VERSION } });
  const qr = res.data && res.data.QueryResponse;
  return (qr && qr[entityKey]) || [];
}

const esc = (s) => String(s || '').replace(/'/g, "\\'");

// ---- Entity resolution -------------------------------------------------------

/**
 * Resolve (or create) the QBO Customer for a local clients row. Mapping is
 * cached in external_refs('quickbooks','customer', local client id).
 */
async function ensureQboCustomer(client, localClientId, displayNameFallback) {
  const db = getDb();
  if (localClientId) {
    const ref = getExternalRef('quickbooks', 'customer', localClientId);
    if (ref) return ref.external_id;
  }
  const local = localClientId ? db.prepare('SELECT * FROM clients WHERE id = ?').get(localClientId) : null;
  const displayName = (local && local.company_name) || displayNameFallback;
  if (!displayName) throw new Error('Invoice has no client to map to a QuickBooks customer.');

  const found = await qboQuery(client, `select Id from Customer where DisplayName = '${esc(displayName)}'`, 'Customer');
  let qboId;
  if (found.length) {
    qboId = found[0].Id;
  } else {
    const body = { DisplayName: displayName };
    if (local) {
      if (local.primary_contact_email) body.PrimaryEmailAddr = { Address: local.primary_contact_email };
      if (local.primary_contact_phone) body.PrimaryPhone = { FreeFormNumber: local.primary_contact_phone };
    }
    const res = await client.http.post('/customer', body);
    qboId = res.data.Customer.Id;
  }
  if (localClientId) setExternalRef('quickbooks', 'customer', localClientId, qboId, { display_name: displayName });
  return qboId;
}

/**
 * Resolve (or create) the generic Service item invoice lines bill against.
 * QBO requires every SalesItemLine to carry an ItemRef. Cached in config.
 */
async function ensureDefaultItem(client) {
  const ic = getIntegrationConfig('quickbooks');
  if (ic.config.default_item_ref) return ic.config.default_item_ref;

  const name = 'Traffic Control Services';
  const found = await qboQuery(client, `select Id from Item where Name = '${esc(name)}'`, 'Item');
  let itemId;
  if (found.length) {
    itemId = found[0].Id;
  } else {
    const income = await qboQuery(client, "select Id, Name from Account where AccountType = 'Income' maxresults 1", 'Account');
    if (!income.length) throw new Error('No Income account found in QuickBooks to attach the service item to.');
    const res = await client.http.post('/item', {
      Name: name,
      Type: 'Service',
      IncomeAccountRef: { value: income[0].Id },
    });
    itemId = res.data.Item.Id;
  }
  saveIntegrationConfig('quickbooks', { default_item_ref: itemId }, ic.enabled);
  return itemId;
}

/**
 * Resolve the company's GST and GST-free TaxCode ids by name query (AU
 * companies ship with 'GST' and 'GST-free'/'FRE'; ids vary per company so
 * they are never hardcoded). Cached in config.
 */
async function ensureTaxCodes(client) {
  const ic = getIntegrationConfig('quickbooks');
  if (ic.config.tax_code_gst && ic.config.tax_code_fre) {
    return { GST: ic.config.tax_code_gst, FRE: ic.config.tax_code_fre };
  }
  const codes = await qboQuery(client, 'select Id, Name from TaxCode', 'TaxCode');
  const findCode = (...names) => {
    for (const n of names) {
      const c = codes.find(x => String(x.Name).toLowerCase() === n.toLowerCase());
      if (c) return c.Id;
    }
    return null;
  };
  const gst = findCode('GST');
  const fre = findCode('GST-free', 'FRE', 'GST free') || gst;
  if (!gst) throw new Error(`No 'GST' tax code found in the QuickBooks company — is it an AU company with GST enabled? (Found: ${codes.map(c => c.Name).join(', ') || 'none'})`);
  saveIntegrationConfig('quickbooks', { tax_code_gst: gst, tax_code_fre: fre }, ic.enabled);
  return { GST: gst, FRE: fre };
}

// ---- Invoice push -------------------------------------------------------------

/**
 * Push an approved local invoice into QBO. Idempotent — if the invoice was
 * already pushed (external_refs('quickbooks','invoice')), returns the existing
 * id without creating a duplicate. Returns { qboInvoiceId, docNumber }.
 */
async function pushInvoiceToQbo(localInvoiceId) {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(localInvoiceId);
  if (!invoice) throw new Error('Invoice not found.');

  const existing = getExternalRef('quickbooks', 'invoice', localInvoiceId);
  if (existing) {
    return { qboInvoiceId: existing.external_id, docNumber: invoice.qbo_doc_number, alreadyPushed: true };
  }

  const lines = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order').all(localInvoiceId);
  if (!lines.length) throw new Error('Invoice has no line items.');
  const flagged = lines.filter(l => l.rate_flagged).length;
  if (flagged) throw new Error(`${flagged} line(s) still have unconfirmed rates — set them in review first.`);

  const client = await getQboClient();
  const customerId = await ensureQboCustomer(client, invoice.client_id, invoice.client_name_snapshot);
  const itemId = await ensureDefaultItem(client);
  const taxCodes = await ensureTaxCodes(client);

  const body = {
    CustomerRef: { value: customerId },
    GlobalTaxCalculation: 'TaxExcluded', // line amounts are ex-GST; QBO adds the 10%
    TxnDate: (invoice.period_end || '').slice(0, 10) || undefined,
    PrivateNote: `Atomis ${invoice.invoice_number || ('draft #' + invoice.id)} · Traffio dockets: ${invoice.docket_ref || '-'}`.slice(0, 4000),
    Line: lines.map((l, i) => ({
      LineNum: i + 1,
      Description: (l.description || '').slice(0, 4000),
      Amount: Math.round((Number(l.line_total) || 0) * 100) / 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: Number(l.qty) || 0,
        UnitPrice: Number(l.unit_price) || 0,
        TaxCodeRef: { value: l.tax_code === 'FRE' ? taxCodes.FRE : taxCodes.GST },
      },
    })),
  };
  if (invoice.invoice_number) body.DocNumber = String(invoice.invoice_number).slice(0, 21);

  let res;
  try {
    res = await client.http.post('/invoice', body);
  } catch (err) {
    throw new Error(qboErrorMessage(err));
  }
  const qbo = res.data.Invoice;

  db.prepare(`UPDATE invoices SET qbo_invoice_id = ?, qbo_doc_number = ?, pushed_at = CURRENT_TIMESTAMP,
    error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(String(qbo.Id), qbo.DocNumber || null, localInvoiceId);
  setExternalRef('quickbooks', 'invoice', localInvoiceId, String(qbo.Id), { doc_number: qbo.DocNumber });

  return { qboInvoiceId: String(qbo.Id), docNumber: qbo.DocNumber };
}

/**
 * Attach a PDF (the signed docket) to a pushed QBO invoice. Multipart upload:
 * part `file_metadata_01` = Attachable JSON linking to the invoice, part
 * `file_content_01` = the PDF bytes. Throws with the QBO fault on failure.
 */
async function attachDocketPdf(qboInvoiceId, pdfPath, fileName) {
  if (!fs.existsSync(pdfPath)) throw new Error(`Docket PDF not found at ${pdfPath}`);
  const client = await getQboClient();
  const name = fileName || path.basename(pdfPath);

  const metadata = {
    AttachableRef: [{ EntityRef: { type: 'Invoice', value: String(qboInvoiceId) }, IncludeOnSend: true }],
    FileName: name,
    ContentType: 'application/pdf',
  };

  const boundary = '----atomis' + Date.now().toString(36);
  const head = (partName, contentType, extra) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${partName}"${extra || ''}\r\nContent-Type: ${contentType}\r\n\r\n`;
  const payload = Buffer.concat([
    Buffer.from(head('file_metadata_01', 'application/json; charset=UTF-8')),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from('\r\n'),
    Buffer.from(head('file_content_01', 'application/pdf', `; filename="${name}"`)),
    fs.readFileSync(pdfPath),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  try {
    const res = await client.http.post('/upload', payload, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      maxBodyLength: 100 * 1024 * 1024,
    });
    const ar = res.data && res.data.AttachableResponse && res.data.AttachableResponse[0];
    if (ar && ar.Fault) {
      const f = (ar.Fault.Error || [])[0] || {};
      throw new Error([f.Message, f.Detail].filter(Boolean).join(' — ') || 'Attachment upload failed.');
    }
    return ar && ar.Attachable ? ar.Attachable.Id : null;
  } catch (err) {
    throw new Error(qboErrorMessage(err));
  }
}

/** Connection check — fetches CompanyInfo for the linked realm. */
async function testQboConnection() {
  const client = await getQboClient();
  const res = await client.http.get(`/companyinfo/${client.realmId}`);
  const info = res.data.CompanyInfo || {};
  return { companyName: info.CompanyName, country: info.Country };
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  pushInvoiceToQbo,
  attachDocketPdf,
  testQboConnection,
  redirectUri,
  // exported for tests
  getAppKeys,
};
