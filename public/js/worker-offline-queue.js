// Worker portal — offline form-submission queue.
//
// Field workers regularly try to submit prestarts / hazards / SWMS acks
// in spots with flaky 4G/5G. Without this, a fetch failure loses every
// keystroke. With it, the submission lands in IndexedDB and replays
// whenever the device gets a network again.
//
// Architecture:
//   - One IndexedDB database "tswq" with one store "queue".
//   - Each queued submission stores { id, url, method, fields[], files[],
//     scope, enqueuedAt, attempts, lastError }. Files go in directly as
//     Blobs — IndexedDB supports them natively, no base64 roundtrip.
//   - flush() runs the queue oldest-first. On 2xx the row is removed; on
//     network failure it's left for next retry; on 4xx it's marked
//     dead-letter (status 'failed') so the worker can see what went wrong.
//   - flush is invoked: on DOMContentLoaded once, on 'online' event, on
//     the service worker 'sync' event (Chrome/Edge), and after enqueue
//     succeeds (covers the case where we just lost signal momentarily).
//   - Window emits a 'wq:change' CustomEvent on every state shift so the
//     banner partial can repaint without polling.
//
// Naturally-idempotent endpoints (acks, INSERT OR IGNORE rows, etc.) are
// safe to retry. Non-idempotent endpoints (timesheets, leave) are not
// covered in v1 — the form tagging on the view side picks which submissions
// get queued.

(function () {
  'use strict';

  var DB_NAME = 'tswq';
  var DB_VERSION = 1;
  var STORE = 'queue';

  // ---- IndexedDB helpers ---------------------------------------------------

  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('enqueuedAt', 'enqueuedAt', { unique: false });
          s.createIndex('status', 'status', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbPromise = null; reject(req.error || new Error('idb open failed')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var result;
        Promise.resolve(fn(store)).then(function (r) { result = r; }, reject);
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error || new Error('tx error')); };
        t.onabort = function () { reject(t.error || new Error('tx aborted')); };
      });
    });
  }

  function idbRequest(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // ---- Public API ----------------------------------------------------------

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'wq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Snapshot a FormData into { fields, files }. text values become string
  // entries; file values become { name, blob } so the same File can be
  // recreated on retry.
  function snapshotFormData(formData) {
    var fields = [];
    var files = [];
    var iter = formData.entries();
    while (true) {
      var step = iter.next();
      if (step.done) break;
      var name = step.value[0];
      var val = step.value[1];
      if (val instanceof File || val instanceof Blob) {
        if (val instanceof File && !val.size && !val.name) continue; // skip empty file inputs
        files.push({ name: name, filename: (val.name || 'blob'), type: val.type || '', blob: val });
      } else {
        fields.push({ name: name, value: String(val == null ? '' : val) });
      }
    }
    return { fields: fields, files: files };
  }

  function rehydrateFormData(snap) {
    var fd = new FormData();
    snap.fields.forEach(function (f) { fd.append(f.name, f.value); });
    snap.files.forEach(function (f) { fd.append(f.name, f.blob, f.filename); });
    return fd;
  }

  // Enqueue a submission. Returns the row id once persisted.
  function enqueue(opts) {
    var url = opts.url;
    var method = (opts.method || 'POST').toUpperCase();
    var scope = opts.scope || 'form';
    if (!url) return Promise.reject(new Error('enqueue: url required'));
    var snap = snapshotFormData(opts.formData);
    var row = {
      url: url,
      method: method,
      scope: scope,
      fields: snap.fields,
      files: snap.files,
      enqueuedAt: Date.now(),
      attempts: 0,
      status: 'pending',
      idempotencyKey: uuid(),
      lastError: null,
    };
    return tx('readwrite', function (store) {
      return idbRequest(store.add(row));
    }).then(function (id) {
      row.id = id;
      emit({ kind: 'enqueued', item: row });
      // If we still have signal (somehow), try flushing immediately.
      if (navigator.onLine !== false) flush().catch(function () {});
      // Best-effort BackgroundSync registration (Chrome/Edge) so the worker
      // gets retried while the page is closed.
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg.sync && typeof reg.sync.register === 'function') {
            reg.sync.register('wq-flush').catch(function () {});
          }
        }).catch(function () {});
      }
      return id;
    });
  }

  function listPending() {
    return tx('readonly', function (store) {
      return idbRequest(store.getAll()).then(function (rows) {
        return (rows || []).filter(function (r) { return r.status !== 'done'; })
                            .sort(function (a, b) { return a.enqueuedAt - b.enqueuedAt; });
      });
    });
  }

  function remove(id) {
    return tx('readwrite', function (store) {
      return idbRequest(store.delete(id));
    });
  }

  function updateRow(id, patch) {
    return tx('readwrite', function (store) {
      return idbRequest(store.get(id)).then(function (row) {
        if (!row) return null;
        Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
        return idbRequest(store.put(row));
      });
    });
  }

  // ---- Flush loop ----------------------------------------------------------

  var flushing = false;

  function flush() {
    if (flushing) return Promise.resolve({ sent: 0, failed: 0, pending: -1 });
    flushing = true;
    return listPending().then(function (rows) {
      var sent = 0, failed = 0, pending = rows.length;
      var promise = Promise.resolve();
      rows.forEach(function (row) {
        promise = promise.then(function () {
          if (row.status === 'failed') return; // skip dead-letter rows
          return attemptSend(row).then(function (result) {
            if (result === 'sent') { sent++; pending--; }
            else if (result === 'failed') { failed++; }
            // 'retry' means leave in queue, don't change counters.
          });
        });
      });
      return promise.then(function () {
        flushing = false;
        emit({ kind: 'flushed', sent: sent, failed: failed, pending: pending });
        return { sent: sent, failed: failed, pending: pending };
      }, function (err) {
        flushing = false;
        emit({ kind: 'flushed', error: err && err.message });
        throw err;
      });
    }, function (err) {
      flushing = false;
      throw err;
    });
  }

  // attemptSend returns 'sent' | 'retry' | 'failed'.
  // 'retry' means transient (network / 5xx) — keep in queue.
  // 'failed' means permanent (4xx) — mark dead-letter so user can retry/delete manually.
  function attemptSend(row) {
    var fd = rehydrateFormData(row);
    return fetch(row.url, {
      method: row.method,
      body: fd,
      credentials: 'same-origin',
      headers: { 'X-Idempotency-Key': row.idempotencyKey || '' },
    }).then(function (res) {
      if (res.ok || res.status === 302 || res.status === 303) {
        return remove(row.id).then(function () { return 'sent'; });
      }
      if (res.status >= 400 && res.status < 500) {
        return updateRow(row.id, {
          status: 'failed',
          attempts: (row.attempts || 0) + 1,
          lastError: 'HTTP ' + res.status,
        }).then(function () { return 'failed'; });
      }
      // 5xx — retry
      return updateRow(row.id, {
        attempts: (row.attempts || 0) + 1,
        lastError: 'HTTP ' + res.status,
      }).then(function () { return 'retry'; });
    }).catch(function (err) {
      // Network / DNS / timeout — keep in queue.
      return updateRow(row.id, {
        attempts: (row.attempts || 0) + 1,
        lastError: (err && err.message) || 'network error',
      }).then(function () { return 'retry'; });
    });
  }

  // ---- Event emitter -------------------------------------------------------

  function emit(detail) {
    try { window.dispatchEvent(new CustomEvent('wq:change', { detail: detail })); } catch (e) {}
  }

  function count() {
    return listPending().then(function (rows) { return rows.length; });
  }

  // ---- Auto-flush triggers -------------------------------------------------

  window.addEventListener('online', function () { flush().catch(function () {}); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { flush().catch(function () {}); });
  } else {
    setTimeout(function () { flush().catch(function () {}); }, 200);
  }
  // Chrome BackgroundSync wakes the service worker on reconnect; the SW
  // postMessages every client to flush.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      if (ev.data && ev.data.kind === 'wq-flush') flush().catch(function () {});
    });
  }

  // ---- Public ---------------------------------------------------------------
  window.WorkerOfflineQueue = {
    enqueue: enqueue,
    flush: flush,
    count: count,
    listPending: listPending,
    remove: remove,
  };
})();
