// Admin Dashboard API — extends the metrics HTTP server with management endpoints
// Routes:
//   GET  /dashboard           — Web UI
//   GET  /api/overview        — KPIs and system health
//   GET  /api/users           — List users (with pagination)
//   GET  /api/users/:id       — Get user details
//   POST /api/users/:id/block — Block/unblock a user
//   POST /api/users/:id/admin — Grant/revoke admin
//   GET  /api/threads         — List threads (with pagination)
//   GET  /api/threads/:id     — Get thread details
//   GET  /api/messages        — Recent messages (with filters)
//   GET  /api/env             — Read editable env vars
//   POST /api/env             — Update editable env vars

import { getEditableEnv, updateEnv } from '../config/index.mjs';

/**
 * Create the admin dashboard request handler.
 * @param {Object} db - Database instance
 * @param {Object} metrics - Metrics instance
 * @param {Object} logger - Logger instance
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean}
 */
export function createDashboardHandler(db, metrics, logger) {
  const log = logger.child('dashboard');

  return function handleDashboard(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Only handle /api/* and /dashboard
    if (!path.startsWith('/api/') && path !== '/dashboard') return false;

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    try {
      if (path === '/dashboard') {
        serveDashboardHTML(res);
        return true;
      }

      if (path === '/api/overview' && req.method === 'GET') {
        return handleOverview(res, db, metrics);
      }

      if (path === '/api/users' && req.method === 'GET') {
        return handleListUsers(res, url, db);
      }

      const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && req.method === 'GET') {
        return handleGetUser(res, userMatch[1], db);
      }

      const blockMatch = path.match(/^\/api\/users\/([^/]+)\/block$/);
      if (blockMatch && req.method === 'POST') {
        return handleBody(req, res, (body) => handleBlockUser(res, blockMatch[1], body, db, log));
      }

      const adminMatch = path.match(/^\/api\/users\/([^/]+)\/admin$/);
      if (adminMatch && req.method === 'POST') {
        return handleBody(req, res, (body) => handleAdminUser(res, adminMatch[1], body, db, log));
      }

      if (path === '/api/threads' && req.method === 'GET') {
        return handleListThreads(res, url, db);
      }

      const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
      if (threadMatch && req.method === 'GET') {
        return handleGetThread(res, threadMatch[1], db);
      }

      if (path === '/api/messages' && req.method === 'GET') {
        return handleListMessages(res, url, db);
      }

      if (path === '/api/env' && req.method === 'GET') {
        return handleGetEnv(res);
      }

      if (path === '/api/env' && req.method === 'POST') {
        return handleBody(req, res, (body) => handleUpdateEnv(res, body, log));
      }

      // 404 for unmatched API routes
      sendJSON(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      log.error('Dashboard error', { error: err.message, path });
      sendJSON(res, 500, { error: 'Internal server error' });
      return true;
    }
  };
}

// --- Route handlers ---

function handleOverview(res, db, metrics) {
  const snapshot = metrics.snapshot();
  const dbStats = db ? db.stats() : { messages: 0, threads: 0, users: 0 };
  sendJSON(res, 200, {
    uptime_seconds: snapshot.uptime_seconds || 0,
    events: {
      received: snapshot['events.received'] || 0,
      processed: snapshot['events.processed'] || 0,
      blocked: snapshot['events.blocked'] || 0,
      deduplicated: snapshot['events.deduplicated'] || 0,
      dropped: snapshot['events.dropped'] || 0,
    },
    messaging: {
      sent: snapshot['messages.sent'] || 0,
      media_sent: snapshot['media.sent'] || 0,
    },
    errors: {
      handler: snapshot['errors.handler'] || 0,
      total: snapshot['errors.total'] || 0,
    },
    memory: {
      rss: snapshot.memory_rss || 0,
      heap_used: snapshot.memory_heap_used || 0,
      heap_total: snapshot.memory_heap_total || 0,
      external: snapshot.memory_external || 0,
    },
    database: dbStats,
  });
  return true;
}

function handleListUsers(res, url, db) {
  if (!db) { sendJSON(res, 503, { error: 'Database not available' }); return true; }
  const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, Infinity, 0);
  const rows = db.listUsers(limit, offset);
  sendJSON(res, 200, { users: rows, limit, offset });
  return true;
}

function handleGetUser(res, userId, db) {
  if (!db) { sendJSON(res, 503, { error: 'Database not available' }); return true; }
  const user = db.getUser(userId);
  if (!user) { sendJSON(res, 404, { error: 'User not found' }); return true; }
  sendJSON(res, 200, user);
  return true;
}

function handleBlockUser(res, userId, body, db, log) {
  if (!db) { sendJSON(res, 503, { error: 'Database not available' }); return; }
  const user = db.getUser(userId);
  if (!user) { sendJSON(res, 404, { error: 'User not found' }); return; }
  const blocked = body.blocked === true;
  db.setBlocked(userId, blocked);
  log.info('User block status changed', { userId, blocked });
  sendJSON(res, 200, { userId, blocked });
}

function handleAdminUser(res, userId, body, db, log) {
  if (!db) { sendJSON(res, 503, { error: 'Database not available' }); return; }
  const user = db.getUser(userId);
  if (!user) { sendJSON(res, 404, { error: 'User not found' }); return; }
  const isAdmin = body.admin === true;
  db.setAdmin(userId, isAdmin);
  log.info('User admin status changed', { userId, isAdmin });
  sendJSON(res, 200, { userId, admin: isAdmin });
}

function handleListThreads(res, url, db) {
  if (!db) { sendJSON(res, 503, { error: 'Database not available' }); return true; }
  const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, Infinity, 0);
  const rows = db.listThreads(limit, offset);
  sendJSON(res, 200, { threads: rows, limit, offset });
  return true;
}

function handleGetThread(res, threadId, db) {
  if (!db) { sendJSON(res, 503, { error: 'Database not available' }); return true; }
  const thread = db.getThread(threadId);
  if (!thread) { sendJSON(res, 404, { error: 'Thread not found' }); return true; }
  sendJSON(res, 200, thread);
  return true;
}

function handleListMessages(res, url, db) {
  if (!db) { sendJSON(res, 503, { error: 'Database not available' }); return true; }
  const threadId = url.searchParams.get('thread');
  const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
  if (!threadId) { sendJSON(res, 400, { error: 'Missing "thread" query parameter' }); return true; }
  const rows = db.getMessages(threadId, limit);
  sendJSON(res, 200, { messages: rows, thread: threadId, limit });
  return true;
}

function handleGetEnv(res) {
  sendJSON(res, 200, { env: getEditableEnv() });
  return true;
}

function handleUpdateEnv(res, body, log) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJSON(res, 400, { error: 'Request body must be a JSON object of key-value pairs' });
    return;
  }
  const result = updateEnv(body);
  log.info('Env updated via dashboard', { applied: result.applied });
  sendJSON(res, 200, { ok: true, applied: result.applied });
}

// --- Helpers ---

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function clampInt(val, min, max, fallback) {
  if (val === null || val === undefined) return fallback;
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function handleBody(req, res, handler) {
  const chunks = [];
  req.on('data', chunk => { chunks.push(chunk); });
  req.on('end', () => {
    try {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      handler(body);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
    }
  });
  return true;
}

// --- Dashboard HTML (single page) ---

function serveDashboardHTML(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot Admin Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
  .container { max-width: 1200px; margin: 0 auto; padding: 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #38bdf8; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; }
  .card { background: #1e293b; border-radius: 8px; padding: 1rem; }
  .card .label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.75rem; font-weight: 700; margin-top: 0.25rem; }
  .card .value.ok { color: #4ade80; }
  .card .value.warn { color: #fbbf24; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th { text-align: left; padding: 0.5rem; border-bottom: 1px solid #334155; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; }
  td { padding: 0.5rem; border-bottom: 1px solid #1e293b; font-size: 0.875rem; }
  .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; }
  .badge-admin { background: #7c3aed; color: white; }
  .badge-blocked { background: #dc2626; color: white; }
  .badge-active { background: #059669; color: white; }
  .refresh-btn { background: #1e293b; color: #38bdf8; border: 1px solid #334155; padding: 0.375rem 0.75rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
  .refresh-btn:hover { background: #334155; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
  #error { color: #f87171; margin: 0.5rem 0; display: none; }
  .env-form { background: #1e293b; border-radius: 8px; padding: 1rem; margin-top: 0.5rem; }
  .env-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
  .env-row label { min-width: 220px; font-size: 0.8rem; color: #94a3b8; font-family: monospace; }
  .env-row input { flex: 1; background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 0.375rem 0.5rem; border-radius: 4px; font-size: 0.85rem; font-family: monospace; }
  .env-row input:focus { outline: none; border-color: #38bdf8; }
  .save-btn { background: #059669; color: white; border: none; padding: 0.5rem 1.25rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; margin-top: 0.5rem; }
  .save-btn:hover { background: #047857; }
  .save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #env-status { font-size: 0.8rem; margin-left: 0.75rem; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>&#x1F916; Bot Admin Dashboard</h1>
    <button class="refresh-btn" onclick="loadAll()">&#x21BB; Refresh</button>
  </div>
  <div id="error"></div>

  <h2>Overview</h2>
  <div class="grid" id="kpis"></div>

  <h2>Users</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Status</th><th>First Seen</th><th>Actions</th></tr></thead>
    <tbody id="users-body"><tr><td colspan="6" style="color:#64748b">Loading...</td></tr></tbody>
  </table>

  <h2>Threads</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Group</th><th>Prefix</th><th>Enabled</th></tr></thead>
    <tbody id="threads-body"><tr><td colspan="5" style="color:#64748b">Loading...</td></tr></tbody>
  </table>

  <h2>&#x2699;&#xFE0F; Environment Settings</h2>
  <div class="env-form" id="env-form">
    <div style="color:#64748b">Loading...</div>
  </div>
  <div style="margin-top:0.5rem;display:flex;align-items:center">
    <button class="save-btn" id="env-save-btn" onclick="saveEnv()">Save Changes</button>
    <span id="env-status"></span>
  </div>
</div>

<script>
const API = window.location.origin;
var HEAP_WARN_THRESHOLD = 0.85;

function fmt(n) { return n != null ? n.toLocaleString() : '\\u2014'; }

function formatUptime(s) {
  if (!s) return '0s';
  var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
      m = Math.floor((s % 3600) / 60), sec = s % 60;
  var p = [];
  if (d) p.push(d + 'd');
  if (h) p.push(h + 'h');
  if (m) p.push(m + 'm');
  p.push(sec + 's');
  return p.join(' ');
}

function showError(msg) {
  var el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function card(label, value, cls) {
  return '<div class="card"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>';
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function fmtBytes(b) {
  if (!b) return '0 B';
  var u = ['B','KB','MB','GB'];
  var i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(1) + ' ' + u[i];
}

async function loadOverview() {
  try {
    var res = await fetch(API + '/api/overview');
    var data = await res.json();
    var kpis = document.getElementById('kpis');
    var errClass = (data.errors && data.errors.total > 0) ? 'warn' : 'ok';
    var memClass = (data.memory && data.memory.heap_used > data.memory.heap_total * HEAP_WARN_THRESHOLD) ? 'warn' : 'ok';
    kpis.innerHTML =
      card('Uptime', formatUptime(data.uptime_seconds), 'ok') +
      card('Processed', fmt(data.events && data.events.processed), 'ok') +
      card('Sent', fmt(data.messaging && data.messaging.sent), 'ok') +
      card('Media', fmt(data.messaging && data.messaging.media_sent), 'ok') +
      card('Errors', fmt(data.errors && data.errors.total), errClass) +
      card('Users', fmt(data.database && data.database.users), 'ok') +
      card('Threads', fmt(data.database && data.database.threads), 'ok') +
      card('Messages', fmt(data.database && data.database.messages), 'ok') +
      card('Memory (RSS)', fmtBytes(data.memory && data.memory.rss), memClass) +
      card('Heap Used', fmtBytes(data.memory && data.memory.heap_used), memClass);
    showError('');
  } catch (e) { showError('Failed to load overview: ' + e.message); }
}

async function toggleBlock(userId, block) {
  if (!confirm('Are you sure you want to ' + (block ? 'BLOCK' : 'UNBLOCK') + ' user ' + userId + '?')) return;
  try {
    var res = await fetch(API + '/api/users/' + userId + '/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked: block })
    });
    if (!res.ok) throw new Error('Action failed');
    loadUsers(); 
  } catch (e) { alert(e.message); }
}

async function toggleAdmin(userId, isAdmin) {
  if (!confirm('Are you sure you want to ' + (isAdmin ? 'GRANT' : 'REVOKE') + ' admin rights for user ' + userId + '?')) return;
  try {
    var res = await fetch(API + '/api/users/' + userId + '/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin: isAdmin })
    });
    if (!res.ok) throw new Error('Action failed');
    loadUsers(); 
  } catch (e) { alert(e.message); }
}

async function loadUsers() {
  try {
    var res = await fetch(API + '/api/users?limit=50');
    var data = await res.json();
    var tbody = document.getElementById('users-body');
    if (!data.users || !data.users.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:#64748b">No users yet</td></tr>'; return; }
    tbody.innerHTML = data.users.map(function(u) {
      var actionBtn = u.is_blocked
        ? '<button class="refresh-btn" style="color:#4ade80;border-color:#4ade80" onclick="toggleBlock(\\'' + u.id + '\\', false)">Unban</button>'
        : '<button class="refresh-btn" style="color:#f87171;border-color:#f87171" onclick="toggleBlock(\\'' + u.id + '\\', true)">Ban</button>';
      
      var adminBtn = u.is_admin
        ? '<button class="refresh-btn" style="color:#fbbf24;border-color:#fbbf24;margin-left:0.5rem" onclick="toggleAdmin(\\'' + u.id + '\\', false)">Demote</button>'
        : '<button class="refresh-btn" style="color:#a78bfa;border-color:#a78bfa;margin-left:0.5rem" onclick="toggleAdmin(\\'' + u.id + '\\', true)">Promote</button>';

      return '<tr>' +
      '<td>' + esc(u.id) + '</td>' +
      '<td>' + esc(u.name || '\\u2014') + '</td>' +
      '<td>' + (u.is_admin ? '<span class="badge badge-admin">Admin</span>' : 'User') + '</td>' +
      '<td>' + (u.is_blocked ? '<span class="badge badge-blocked">Blocked</span>' : '<span class="badge badge-active">Active</span>') + '</td>' +
      '<td>' + esc(u.first_seen || '') + '</td>' +
      '<td>' + actionBtn + adminBtn + '</td></tr>';
    }).join('');
  } catch (e) { showError('Failed to load users: ' + e.message); }
}

async function loadThreads() {
  try {
    var res = await fetch(API + '/api/threads?limit=50');
    var data = await res.json();
    var tbody = document.getElementById('threads-body');
    if (!data.threads || !data.threads.length) { tbody.innerHTML = '<tr><td colspan="5" style="color:#64748b">No threads yet</td></tr>'; return; }
    tbody.innerHTML = data.threads.map(function(t) { return '<tr>' +
      '<td>' + esc(t.id) + '</td>' +
      '<td>' + esc(t.name || '\\u2014') + '</td>' +
      '<td>' + (t.is_group ? 'Yes' : 'No') + '</td>' +
      '<td>' + esc(t.prefix || '!') + '</td>' +
      '<td>' + (t.enabled ? '<span class="badge badge-active">Yes</span>' : 'No') + '</td></tr>';
    }).join('');
  } catch (e) { showError('Failed to load threads: ' + e.message); }
}

async function loadEnv() {
  try {
    var res = await fetch(API + '/api/env');
    var data = await res.json();
    var form = document.getElementById('env-form');
    if (!data.env || !Object.keys(data.env).length) {
      form.innerHTML = '<div style="color:#64748b">No editable variables</div>';
      return;
    }
    var SECRET_KEYS = ['GEMINI_API_KEY'];
    form.innerHTML = Object.keys(data.env).map(function(key) {
      var inputType = SECRET_KEYS.indexOf(key) >= 0 ? 'password' : 'text';
      return '<div class="env-row">' +
        '<label for="env-' + esc(key) + '">' + esc(key) + '</label>' +
        '<input type="' + inputType + '" id="env-' + esc(key) + '" data-env-key="' + esc(key) + '" value="' + esc(data.env[key]) + '"' +
        (inputType === 'password' ? ' autocomplete="off"' : '') + '>' +
        '</div>';
    }).join('');
    document.getElementById('env-status').textContent = '';
  } catch (e) { showError('Failed to load env: ' + e.message); }
}

async function saveEnv() {
  var inputs = document.querySelectorAll('#env-form input[data-env-key]');
  var body = {};
  inputs.forEach(function(el) { body[el.getAttribute('data-env-key')] = el.value; });
  var btn = document.getElementById('env-save-btn');
  var status = document.getElementById('env-status');
  btn.disabled = true;
  status.textContent = 'Saving...';
  status.style.color = '#94a3b8';
  try {
    var res = await fetch(API + '/api/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    status.textContent = '\\u2713 Saved (' + data.applied.length + ' keys updated)';
    status.style.color = '#4ade80';
  } catch (e) {
    status.textContent = '\\u2717 ' + e.message;
    status.style.color = '#f87171';
  } finally { btn.disabled = false; }
}

function loadAll() { loadOverview(); loadUsers(); loadThreads(); loadEnv(); }
loadAll();
setInterval(loadAll, 30000);
</script>
</body>
</html>`;
