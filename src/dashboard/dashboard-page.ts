// Operator board served at GET /dashboard. CSS/JS are inline (the worker sets no
// CSP; the only external asset is the optional Inter webfont, which degrades to
// the system font stack if blocked). Data is fetched client-side from
// /v1/dashboard/overview with the operations Bearer token. Layout: fixed left
// sidebar (brand, overview stats, controls) + scrolling main area (active
// sandboxes panel over three task lanes). Warm dark Claude palette.

const DASHBOARD_SCRIPT = String.raw`
const LANES = [
  { key: 'running', label: 'Running', cls: 'run' },
  { key: 'pending', label: 'Pending', cls: 'pend' },
  { key: 'blocked', label: 'Blocked', cls: 'blk' },
  { key: 'completed', label: 'Completed', cls: 'done' },
];
// The board shows one lane at a time; the sidebar stat tiles double as the
// lane filter. 'all' is the default and lists every task.
let activeFilter = 'all';
let lastData = null;
// Runs the operator approved this session. Approval is consumed asynchronously
// by a reconciler (up to ~60s), so a run stays in awaiting_approval across the
// next few snapshots. We keep the button in an "Approved" disabled state for
// these until the run actually leaves awaiting_approval, so repeated snapshots
// don't re-arm a clickable button.
const approvedRuns = new Set();
// Runs ticked for batch removal. Held only for this session; pruned in
// renderBoard() as runs leave the snapshot so it cannot grow unbounded.
const selectedRuns = new Set();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const laneCls = (lane) => ({ running: 'run', pending: 'pend', blocked: 'blk', completed: 'done' }[lane] || 'run');
const rel = (iso) => {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(d)) return '';
  if (d < 60) return Math.max(0, Math.round(d)) + 's ago';
  if (d < 3600) return Math.round(d / 60) + 'm ago';
  if (d < 86400) return Math.round(d / 3600) + 'h ago';
  return Math.round(d / 86400) + 'd ago';
};
const shortSandbox = (id) => {
  const s = String(id || '');
  return s.length > 22 ? s.slice(0, 14) + '…' + s.slice(-6) : s;
};
// Task ids are long; show a truncated head so the row stays compact, but keep
// the full value on the element for copy + tooltip.
const shortId = (id) => {
  const s = String(id || '');
  return s.length > 12 ? s.slice(0, 10) + '…' : s;
};
async function copyId(el, value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement('textarea');
      ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    el.classList.add('copied');
    const prev = el.getAttribute('data-label') || '';
    el.querySelector('.id-text').textContent = 'copied';
    setTimeout(() => {
      el.classList.remove('copied');
      el.querySelector('.id-text').textContent = prev;
    }, 1100);
  } catch (e) {}
}
window.copyId = copyId;

// Approve the repo_write gate for a run stuck in awaiting_approval. The server
// derives the plan key from live state; we only send the run id. On success we
// reload so the card moves to its new lane on the next snapshot.
async function approveRun(btn, runId) {
  const tok = token();
  if (!tok) { setStatus('Enter your operations token to approve', 'warn'); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.querySelector('.appr-text');
  const prev = label ? label.textContent : '';
  if (label) label.textContent = 'Approving…';
  try {
    const res = await fetch('/v1/dashboard/runs/' + encodeURIComponent(runId) + '/approve', {
      method: 'POST', headers: { authorization: 'Bearer ' + tok }, cache: 'no-store',
    });
    if (res.ok) {
      // Remember it so re-renders keep the button disabled until the run
      // actually advances, even though it lingers in awaiting_approval.
      approvedRuns.add(runId);
      if (label) label.textContent = 'Approved';
      btn.classList.add('done');
      btn.disabled = true;
      setStatus('Approved — run will start executing shortly', 'ok');
      setTimeout(load, 800);
      return;
    }
    if (res.status === 401) { setStatus('Unauthorized — check the token', 'err'); }
    else if (res.status === 409) {
      // Already advanced or no longer approvable — treat as done, don't re-arm.
      approvedRuns.add(runId);
      setStatus('Run is no longer awaiting approval', 'warn'); setTimeout(load, 400);
    }
    else { setStatus('Approve failed (' + res.status + ')', 'err'); }
  } catch (e) { setStatus('Network error', 'err'); }
  btn.disabled = false;
  if (label) label.textContent = prev;
}
window.approveRun = approveRun;

// A card click navigates to the run's detail page, unless the click landed on
// an inner control (copy-id, approve, PR link) which have their own behavior.
function onTaskClick(event, runId) {
  // The select checkbox lives inside the card, so ticking it must not also open
  // the detail panel.
  if (event.target.closest('button, a, input')) return;
  openDetail(runId);
}
window.onTaskClick = onTaskClick;

// openDetail just changes the URL hash; the hashchange router renders the page.
// This gives real, shareable, refreshable URLs (#/run/<id>) and a working Back
// button instead of a floating layer.
function openDetail(runId) { location.hash = '#/run/' + encodeURIComponent(runId); }
window.openDetail = openDetail;
// Sandbox cards address a run too, so they reuse the same navigation.
window.openRun = openDetail;

// goBack returns to the board. Prefer real history back so the browser restores
// scroll/filter; fall back to clearing the hash when we opened detail directly.
function goBack() {
  if (history.length > 1 && document.referrer !== '' || navEnteredBoard) { history.back(); }
  else { location.hash = ''; }
}
window.goBack = goBack;

let detailRun = null;
let navEnteredBoard = false; // true once the user has seen the board this session

// Show either the board or the detail page based on the current hash.
async function route() {
  const m = location.hash.match(/^#\/run\/(.+)$/);
  const shell = $('shell'), page = $('detail');
  stopSession(); // never leave a poll running for a page we navigated away from
  if (!m) {
    detailRun = null;
    page.hidden = true; page.setAttribute('aria-hidden', 'true');
    shell.hidden = false;
    navEnteredBoard = true;
    return;
  }
  const runId = decodeURIComponent(m[1]);
  detailRun = runId;
  shell.hidden = true;
  page.hidden = false; page.setAttribute('aria-hidden', 'false');
  page.scrollTop = 0;
  page.innerHTML = detailShell('<div class="detail-load">Loading…</div>');
  const tok = token();
  if (!tok) { page.innerHTML = detailShell('<div class="detail-load">Enter your operations token on the board first, then reopen this run.</div>'); return; }
  try {
    const res = await fetch('/v1/dashboard/runs/' + encodeURIComponent(runId), {
      headers: { authorization: 'Bearer ' + tok }, cache: 'no-store',
    });
    if (res.status === 404) { page.innerHTML = detailShell('<div class="detail-load">Run not found.</div>'); return; }
    if (!res.ok) { page.innerHTML = detailShell('<div class="detail-load">Error ' + res.status + '</div>'); return; }
    const d = await res.json();
    if (detailRun !== runId) return; // a newer navigation superseded this fetch
    renderDetail(d);
  } catch (e) { page.innerHTML = detailShell('<div class="detail-load">Network error</div>'); }
}
window.addEventListener('hashchange', route);

// The detail page's sticky top bar: a Back button (no more close-X overlay).
function detailShell(inner) {
  return '<div class="detail-bar"><button type="button" class="detail-back" onclick="goBack()">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" ' +
    'd="M10 13 5 8l5-5 1 1-4 4 4 4z"/></svg> Back to board</button></div>' +
    '<div class="detail-inner">' + inner + '</div>';
}

function renderDetail(d) {
  const pct = d.plan && d.plan.totalCount ? Math.round(100 * d.plan.doneCount / d.plan.totalCount) : 0;
  let html = '<div class="d-head">' +
    '<span class="state ' + laneCls(d.lane) + '">' + esc(d.state) + '</span>' +
    '<span class="d-pri">' + esc(d.priority) + '</span>' +
    '<span class="d-kind">' + esc(d.intentKind) + '</span></div>';
  html += '<h2 class="d-title">' + esc(d.title) + '</h2>';
  html += '<div class="d-repo">' + esc(d.repository) + ' · ' + esc(d.baseBranch) +
    (d.prNumber ? ' · <a href="' + esc(d.prUrl) + '" target="_blank" rel="noopener">PR #' + esc(d.prNumber) + '</a>' : '') + '</div>';

  // Approve inline when the run is parked at the gate.
  if (d.approvable) {
    const done = approvedRuns.has(d.runId);
    html += '<div class="d-approve">' + (done
      ? '<button type="button" class="approve done" disabled>Approved</button>'
      : '<button type="button" class="approve" onclick="approveRun(this,\'' + esc(d.runId) + '\')"><span class="appr-text">Approve</span></button>') +
      '<span class="d-approve-note">This run is waiting for approval to begin repository changes.</span></div>';
  }

  // Original request (from meego/feishu PRD etc.)
  html += '<section class="d-sec"><h3>Original request</h3>';
  if (d.origin) {
    html += '<div class="d-src">source: ' + esc(d.origin.sourceSystem) +
      (d.origin.sourceUrl ? ' · <a href="' + esc(d.origin.sourceUrl) + '" target="_blank" rel="noopener">open PRD</a>' : '') + '</div>';
    if (d.origin.description) html += '<div class="d-desc">' + esc(d.origin.description) + '</div>';
    if (d.origin.acceptanceCriteria && d.origin.acceptanceCriteria.length) {
      html += '<h4>Acceptance criteria</h4><ul class="d-ac">' +
        d.origin.acceptanceCriteria.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>';
    }
  } else {
    html += '<div class="d-empty">Original description is unavailable.</div>';
  }
  html += '</section>';

  // Agent-produced DOD plan + progress
  html += '<section class="d-sec"><h3>DOD plan &amp; progress</h3>';
  if (d.plan) {
    html += '<div class="d-plan-obj">' + esc(d.plan.objective) + '</div>';
    html += '<div class="d-prog"><div class="d-prog-bar"><span style="width:' + pct + '%"></span></div>' +
      '<span class="d-prog-txt">' + d.plan.doneCount + ' / ' + d.plan.totalCount + ' done · plan v' + esc(d.plan.planVersion) + ' (' + esc(d.plan.status) + ')</span></div>';
    html += '<ol class="d-items">' + d.plan.items.map(planItemRow).join('') + '</ol>';
  } else {
    html += '<div class="d-empty">No plan has been produced yet.</div>';
  }
  html += '</section>';

  // Live sandbox session. Filled in by the poll below; hidden until we know
  // whether this run actually has a sandbox.
  html += '<section class="d-sec" id="d-session" hidden><h3>Live session</h3>' +
    '<div id="d-session-body"></div></section>';

  // Removal lives at the end, away from the read-only body, and states plainly
  // that the record survives.
  html += '<section class="d-sec d-danger"><h3>Remove task</h3>' +
    '<p class="d-danger-note">Cancels the run and hides it from the board. The task ' +
    'record, plan and PR are kept and stay auditable. A running sandbox is only ' +
    'destroyed after you confirm.</p>' +
    '<button type="button" class="task-del" onclick="deleteRun(this,\'' + esc(d.runId) +
    '\')">Remove from board</button></section>';

  $('detail').innerHTML = detailShell(html);
  startSession(d.runId);
}

// ---- live session ----
// The runner writes counter-only activity records to the container's stdout:
// command text, file paths and agent messages are discarded upstream by design,
// so this shows progress evidence and diagnostics, never conversation content.
let sessionTimer = null;
let sessionRun = null;

function stopSession() {
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
  sessionRun = null;
}

function startSession(runId) {
  stopSession();
  sessionRun = runId;
  pollSession();
  // 3s is frequent enough to feel live without hammering the container; the
  // interval exists only while this detail page is open.
  sessionTimer = setInterval(pollSession, 3000);
}

async function pollSession() {
  const runId = sessionRun;
  if (!runId || detailRun !== runId) { stopSession(); return; }
  const sec = $('d-session'), body = $('d-session-body');
  if (!sec || !body) { stopSession(); return; }
  try {
    const res = await fetch('/v1/dashboard/runs/' + encodeURIComponent(runId) + '/session', {
      headers: { authorization: 'Bearer ' + token() }, cache: 'no-store',
    });
    if (detailRun !== runId) return;
    if (res.status === 404) {
      // No sandbox for this run: stop polling rather than retrying forever.
      sec.hidden = true;
      stopSession();
      return;
    }
    if (!res.ok) { sec.hidden = false; body.innerHTML = '<div class="d-empty">Session unavailable (' + res.status + ')</div>'; return; }
    const s = await res.json();
    sec.hidden = false;
    body.innerHTML = sessionHtml(s);
  } catch (e) {
    if (detailRun !== runId) return;
    sec.hidden = false;
    body.innerHTML = '<div class="d-empty">Network error reading session.</div>';
  }
}

function sessionHtml(s) {
  let h = '<div class="sess-head">' +
    '<code class="sbx-id" title="' + esc(s.sandboxId) + '">' + esc(shortSandbox(s.sandboxId)) + '</code>' +
    '<span class="role ' + esc(s.role) + '">' + esc(s.role) + '</span>' +
    '<span class="sess-st">' + esc(s.liveStatus || s.recordedStatus) + '</span>' +
    (s.startedAt ? '<span class="ago">' + rel(s.startedAt) + '</span>' : '') +
    '<button type="button" class="sbx-kill" onclick="killSandbox(this,\'' + esc(s.sandboxId) +
      '\')">Terminate sandbox</button></div>';
  if (s.unreachable) {
    // Be explicit: an empty session and a wedged container look identical
    // otherwise, and that difference is what an operator needs to know.
    h += '<div class="sess-warn">The container is not answering log reads. ' +
      'It may be wedged — terminating it frees the instance slot; the task can be retried.</div>';
  }
  if (!s.events.length && !s.unreachable) {
    h += '<div class="d-empty">The process has produced no output yet.</div>';
  }
  if (s.events.length) {
    if (s.truncated) h += '<div class="sess-trunc">Showing the most recent output only.</div>';
    h += '<ol class="sess-list">' + s.events.map(sessionRow).join('') + '</ol>';
  }
  if (s.stderr) {
    h += '<details class="sess-err"><summary>stderr</summary><pre>' + esc(s.stderr) + '</pre></details>';
  }
  return h;
}

function sessionRow(e) {
  if (e.raw !== null && e.raw !== undefined) {
    return '<li class="sess-row raw"><pre>' + esc(e.raw) + '</pre></li>';
  }
  const keys = Object.keys(e.fields || {});
  const fields = keys.length
    ? '<span class="sess-fields">' + keys.map((k) =>
        '<span class="sess-f"><b>' + esc(k) + '</b> ' + esc(fmtField(e.fields[k])) + '</span>').join('') +
      '</span>'
    : '';
  return '<li class="sess-row">' +
    '<span class="sess-ev">' + esc(e.event) + '</span>' +
    (e.observedAt ? '<span class="sess-at">' + esc(clock(e.observedAt)) + '</span>' : '') +
    fields + '</li>';
}

function fmtField(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
}

const PROGRESS_LABEL = {
  pending: 'pending', ready: 'ready', in_progress: 'in progress',
  passed: 'passed', failed: 'failed', blocked: 'blocked', skipped: 'skipped',
};
function planItemRow(it) {
  const cls = ({ passed: 'done', skipped: 'done', failed: 'blk', blocked: 'blk',
    in_progress: 'run', ready: 'run' }[it.progress]) || 'pend';
  const effects = (it.effects || []).length
    ? '<span class="d-eff">' + it.effects.map((e) => esc(e)).join(', ') + '</span>' : '';
  const dw = (it.doneWhen || []).length
    ? '<ul class="d-dw">' + it.doneWhen.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>' : '';
  return '<li class="d-item">' +
    '<div class="d-item-head"><span class="d-item-st ' + cls + '">' +
      esc(PROGRESS_LABEL[it.progress] || it.progress) + '</span>' +
    '<span class="d-item-kind">' + esc(it.kind) + '</span>' +
    (it.required ? '' : '<span class="d-opt">optional</span>') + effects + '</div>' +
    '<div class="d-item-title">' + esc(it.title) + '</div>' +
    '<div class="d-item-obj">' + esc(it.objective) + '</div>' + dw + '</li>';
}

// Esc closes the drawer.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailRun) goBack(); });

let timer = null;
function token() { return $('token').value.trim(); }
function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function load() {
  const tok = token();
  if (!tok) { setStatus('Enter your operations token to load', 'warn'); return; }
  setStatus('Loading…', '');
  try {
    const res = await fetch('/v1/dashboard/overview', {
      headers: { authorization: 'Bearer ' + tok }, cache: 'no-store',
    });
    if (res.status === 401) { setStatus('Unauthorized — check the token', 'err'); return; }
    if (!res.ok) { setStatus('Error ' + res.status, 'err'); return; }
    const data = await res.json();
    render(data);
    if ($('remember').checked) { try { localStorage.setItem('dl_ops_token', tok); } catch (e) {} }
    setStatus('Updated ' + new Date().toLocaleTimeString(), 'ok');
  } catch (e) { setStatus('Network error', 'err'); }
}

function render(data) {
  lastData = data;
  const counts = data.laneCounts || {};
  const total = LANES.reduce((n, l) => n + (counts[l.key] || 0), 0);
  // Stat tiles act as the lane filter. "All" leads, then the three lanes.
  const tiles = [{ key: 'all', label: 'All tasks', cls: 'all', n: total }]
    .concat(LANES.map((l) => ({ key: l.key, label: l.label, cls: l.cls, n: counts[l.key] || 0 })));
  $('stats').innerHTML = tiles.map((t) =>
    '<button type="button" class="stat ' + t.cls + (activeFilter === t.key ? ' active' : '') +
    '" data-filter="' + t.key + '"><span class="stat-n">' + t.n +
    '</span><span class="stat-l">' + esc(t.label) + '</span></button>'
  ).join('');
  for (const btn of $('stats').querySelectorAll('.stat')) {
    btn.addEventListener('click', () => { activeFilter = btn.getAttribute('data-filter'); renderBoard(); });
  }

  renderBoard();

  const sb = data.activeSandboxes || [];
  $('sbx-count').textContent = sb.length;
  $('sandboxes').innerHTML = sb.length ? sb.map(sandboxCard).join('')
    : '<div class="empty wide">No sandboxes are running right now.</div>';

  const stamp = new Date(data.generatedAt);
  $('clock').textContent = 'Snapshot ' + stamp.toLocaleTimeString();
}

// Render the task list for the active filter as a single column. Keeping stats
// and sandboxes untouched lets filter clicks re-render without a refetch.
function renderBoard() {
  if (!lastData) return;
  const tasks = lastData.tasks || [];
  // Drop approved flags for runs that have actually left awaiting_approval, so
  // the set doesn't grow unbounded and a genuine re-entry can be approved again.
  if (approvedRuns.size) {
    const stillWaiting = new Set(
      tasks.filter((t) => t.state === 'awaiting_approval').map((t) => t.runId),
    );
    for (const id of Array.from(approvedRuns)) {
      if (!stillWaiting.has(id)) approvedRuns.delete(id);
    }
  }
  // Drop selections for runs that have left the snapshot (removed, or aged out
  // of the limit), so a stale id can never be submitted for removal.
  if (selectedRuns.size) {
    const present = new Set(tasks.map((t) => t.runId));
    for (const id of Array.from(selectedRuns)) {
      if (!present.has(id)) selectedRuns.delete(id);
    }
  }
  const shown = activeFilter === 'all' ? tasks : tasks.filter((t) => t.lane === activeFilter);
  for (const btn of $('stats').querySelectorAll('.stat')) {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === activeFilter);
  }
  const meta = LANES.find((l) => l.key === activeFilter);
  const label = activeFilter === 'all' ? 'All tasks' : (meta ? meta.label : activeFilter);
  const cls = activeFilter === 'all' ? 'all' : (meta ? meta.cls : 'in');
  const body = shown.length ? shown.map(taskCard).join('')
    : '<div class="empty">No tasks</div>';
  $('board').innerHTML =
    '<section class="lane ' + cls + '">' +
    '<header class="lane-head"><span class="dot"></span><h2>' + esc(label) + '</h2>' +
    '<span class="pill">' + shown.length + '</span></header>' +
    '<div class="lane-list">' + body + '</div></section>';
  renderBulkBar();
}

// The batch action bar only exists while something is ticked, so the board stays
// unchanged for read-only use.
function renderBulkBar() {
  const bar = $('bulk');
  if (!bar) return;
  const n = selectedRuns.size;
  if (n === 0) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  // One action only. Deselecting is what the card checkboxes already do, so a
  // separate Clear button was redundant.
  bar.innerHTML = '<span class="bulk-n">' + n + (n === 1 ? ' task selected' : ' tasks selected') +
    '</span>' +
    '<button type="button" class="bulk-del" onclick="deleteSelected(this)">' +
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path fill="currentColor" d="M6.5 1h3a1 1 0 0 1 1 1v.5H13a.5.5 0 0 1 0 1h-.55l-.6 8.6A2 2 0 0 1 9.86 14H6.14a2 2 0 0 1-2-1.9l-.59-8.6H3a.5.5 0 0 1 0-1h2.5V2a1 1 0 0 1 1-1m0 1.5h3V2h-3zM4.55 3.5l.59 8.53a1 1 0 0 0 1 .97h3.72a1 1 0 0 0 1-.97l.59-8.53zM6.5 5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5m3 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5"/></svg>' +
    '<span>Remove</span></button>';
}

function taskCard(t) {
  const pr = t.prNumber
    ? '<a class="pr" href="' + esc(t.prUrl) + '" target="_blank" rel="noopener">PR #' + esc(t.prNumber) + '</a>'
    : '';
  const id = t.taskId || '';
  const idChip = id
    ? '<button type="button" class="id-chip" data-label="' + esc(shortId(id)) + '"' +
        ' title="' + esc(id) + ' — click to copy"' +
        ' onclick="copyId(this,\'' + esc(id) + '\')">' +
        '<svg class="id-ico" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
        '<path fill="currentColor" d="M10 1H4a2 2 0 0 0-2 2v7h1.5V3A.5.5 0 0 1 4 2.5h6zM12 4H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m.5 9a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V6a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5z"/></svg>' +
        '<span class="id-text">' + esc(shortId(id)) + '</span></button>'
    : '';
  const check = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path fill="currentColor" d="M13.5 3.5 6 11 2.5 7.5 3.5 6.5 6 9l6.5-6.5z"/></svg>';
  let approve = '';
  if (t.state === 'awaiting_approval') {
    approve = approvedRuns.has(t.runId)
      ? '<button type="button" class="approve done" disabled>' + check +
          '<span class="appr-text">Approved</span></button>'
      : '<button type="button" class="approve" onclick="approveRun(this,\'' + esc(t.runId) + '\')">' +
          check + '<span class="appr-text">Approve</span></button>';
  }
  const picked = selectedRuns.has(t.runId);
  // Both controls sit in one top-right cluster and stay invisible until hover,
  // so a read-only board looks unchanged. A ticked box stays visible.
  const pick = '<label class="pick"' + (picked ? ' data-on="1"' : '') +
    ' title="Select for removal">' +
    '<input type="checkbox"' + (picked ? ' checked' : '') +
    ' aria-label="Select task for removal"' +
    ' onclick="toggleSelect(this,\'' + esc(t.runId) + '\')" />' +
    '<span class="pick-box">' +
    '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
    '<path fill="currentColor" d="M13.5 3.5 6 11 2.5 7.5 3.5 6.5 6 9l6.5-6.5z"/></svg>' +
    '</span></label>';
  const trash = '<button type="button" class="card-del" title="Remove this task"' +
    ' aria-label="Remove this task"' +
    ' onclick="deleteRun(this,\'' + esc(t.runId) + '\')">' +
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path fill="currentColor" d="M6.5 1h3a1 1 0 0 1 1 1v.5H13a.5.5 0 0 1 0 1h-.55l-.6 8.6A2 2 0 0 1 9.86 14H6.14a2 2 0 0 1-2-1.9l-.59-8.6H3a.5.5 0 0 1 0-1h2.5V2a1 1 0 0 1 1-1m0 1.5h3V2h-3zM4.55 3.5l.59 8.53a1 1 0 0 0 1 .97h3.72a1 1 0 0 0 1-.97l.59-8.53zM6.5 5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5m3 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5"/></svg>' +
    '</button>';
  const actions = '<div class="task-actions">' + pick + trash + '</div>';
  return '<article class="task' + (picked ? ' picked' : '') +
    '" tabindex="0" role="button" data-run="' + esc(t.runId) + '"' +
    ' onclick="onTaskClick(event,\'' + esc(t.runId) + '\')"' +
    ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openDetail(\'' + esc(t.runId) + '\')}">' +
    actions +
    '<div class="task-title">' + esc(t.title) + '</div>' +
    '<div class="task-meta">' +
      '<span class="state ' + laneCls(t.lane) + '">' + esc(t.state) + '</span>' +
      '<span class="repo">' + esc(t.repository) + '</span>' +
    '</div>' +
    '<div class="task-foot"><span class="kind">' + esc(t.intentKind) + '</span>' + idChip +
      '<span class="ago">' + rel(t.updatedAt) + '</span>' + pr + '</div>' +
    approve +
    '</article>';
}

function sandboxCard(s) {
  return '<article class="sbx">' +
    '<span class="pulse"></span>' +
    '<div class="sbx-body">' +
      '<div class="sbx-line"><code class="sbx-id" title="' + esc(s.sandboxId) + '">' +
        esc(shortSandbox(s.sandboxId)) + '</code>' +
        '<span class="arrow">→</span>' +
        '<code class="sbx-repo">' + esc(s.repository) + '</code></div>' +
      '<div class="sbx-sub"><span class="role ' + esc(s.role) + '">' + esc(s.role) + '</span>' +
        '<span class="sbx-task">' + esc(s.taskTitle) + '</span>' +
        '<span class="ago">' + rel(s.startedAt || s.updatedAt) + '</span></div>' +
      '<div class="sbx-actions">' +
        '<button type="button" class="sbx-open" onclick="openRun(\'' + esc(s.runId) +
          '\')">Session</button>' +
        '<button type="button" class="sbx-kill" onclick="killSandbox(this,\'' +
          esc(s.sandboxId) + '\')">Terminate</button>' +
      '</div>' +
    '</div></article>';
}

// Graceful sandbox termination. Irreversible for the container (the process is
// SIGTERMed and the container destroyed), so it always asks first. The run,
// its plan and any PR are left untouched, so the task can be retried.
async function killSandbox(btn, sandboxId) {
  if (!confirm('Terminate this sandbox?\n\n' + sandboxId +
    '\n\nThe container process is killed and the container destroyed. ' +
    'The task record, plan and PR are kept — the run can be retried.')) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Terminating…';
  try {
    const res = await fetch('/v1/dashboard/sandboxes/' + encodeURIComponent(sandboxId) + '/cancel', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + $('token').value.trim() },
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const body = await res.json();
    btn.textContent = body.disposition === 'cancelled' ? 'Terminated' : 'Already gone';
    setTimeout(load, 800);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert('Terminate failed: ' + e.message);
  }
}
window.killSandbox = killSandbox;

// Removal is a two-phase confirm. The first request never authorises container
// destruction; if the server answers 409 sandbox_active we show exactly which
// tasks are still running and how many containers would die, and only a second
// explicit confirmation retries with cascadeSandboxes.
async function postDelete(url, runIds, cascade) {
  const body = {};
  if (runIds !== null) body.runIds = runIds;
  if (cascade) body.cascadeSandboxes = true;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + $('token').value.trim(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch (e) { payload = null; }
  return { ok: res.ok, status: res.status, payload };
}

function cascadePrompt(blocked, taskCount) {
  const titles = new Map((lastData && lastData.tasks ? lastData.tasks : [])
    .map((t) => [t.runId, t.title]));
  const containers = blocked.reduce((n, b) => n + (b.sandboxes || []).length, 0);
  const lines = blocked.map((b) => {
    const n = (b.sandboxes || []).length;
    return '  · ' + (titles.get(b.runId) || b.runId) + ' (' + n +
      (n === 1 ? ' container)' : ' containers)');
  }).join('\n');
  return (taskCount === 1 ? 'This task still has a sandbox running.' :
    blocked.length + ' of ' + taskCount + ' tasks still have sandboxes running.') +
    '\n\n' + lines + '\n\nContinuing cancels the run and destroys ' +
    (containers === 1 ? 'this container' : 'these ' + containers + ' containers') +
    '.\nThe task record, plan and PR are kept and stay auditable.\n\nProceed?';
}

async function deleteRuns(runIds, btn) {
  const many = runIds.length > 1;
  if (!$('token').value.trim()) {
    setStatus('Enter your operations token to remove tasks', 'warn');
    return;
  }
  if (!confirm((many ? 'Remove these ' + runIds.length + ' tasks' : 'Remove this task') +
    ' from the board?\n\nThe run is cancelled and hidden. Its record, plan and PR are ' +
    'kept — nothing is erased from the audit trail.')) return;

  const url = many
    ? '/v1/dashboard/runs/delete'
    : '/v1/dashboard/runs/' + encodeURIComponent(runIds[0]) + '/delete';
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
  try {
    let result = await postDelete(url, many ? runIds : null, false);
    if (result.status === 409 && result.payload && result.payload.status === 'sandbox_active') {
      if (!confirm(cascadePrompt(result.payload.blocked || [], runIds.length))) {
        if (btn) { btn.disabled = false; btn.textContent = original; }
        return;
      }
      result = await postDelete(url, many ? runIds : null, true);
    }
    if (!result.ok) {
      const code = result.payload && result.payload.error ? result.payload.error.message : null;
      throw new Error(code || 'http ' + result.status);
    }
    for (const id of runIds) selectedRuns.delete(id);
    const n = many && result.payload ? result.payload.deleted : 1;
    setStatus(n === 1 ? 'Task removed' : n + ' tasks removed', 'ok');
    load();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = original; }
    alert('Remove failed: ' + e.message);
  }
}

function deleteRun(btn, runId) { deleteRuns([runId], btn); }
function deleteSelected(btn) { deleteRuns(Array.from(selectedRuns), btn); }
function toggleSelect(cb, runId) {
  if (cb.checked) selectedRuns.add(runId); else selectedRuns.delete(runId);
  // Reflect the outline immediately; a full re-render would fight the snapshot
  // poll and is unnecessary for a local class toggle.
  const card = cb.closest('.task');
  if (card) card.classList.toggle('picked', cb.checked);
  const label = cb.closest('.pick');
  // Keeps a ticked box visible after the pointer leaves the card.
  if (label) {
    if (cb.checked) label.setAttribute('data-on', '1');
    else label.removeAttribute('data-on');
  }
  renderBulkBar();
}
window.deleteRun = deleteRun;
window.deleteSelected = deleteSelected;
window.toggleSelect = toggleSelect;

function toggleAuto() {
  const btn = $('auto');
  if (timer) { clearInterval(timer); timer = null; btn.textContent = 'Auto-refresh: off'; btn.classList.remove('on'); }
  else { timer = setInterval(load, 10000); btn.textContent = 'Auto-refresh: 10s'; btn.classList.add('on'); load(); }
}

$('load').addEventListener('click', load);
$('auto').addEventListener('click', toggleAuto);
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
(function init() {
  try {
    const saved = localStorage.getItem('dl_ops_token');
    if (saved) { $('token').value = saved; $('remember').checked = true; load(); }
  } catch (e) {}
  // Render whatever the current URL points at: board (empty hash) or a run page
  // (#/run/<id>) reached by refresh or a shared link.
  route();
})();
`;

// Brand mark: a 72px metallic ring, inlined as a data URI so the board stays
// self-contained (no external image request). Replaces the earlier emoji.
const DASHBOARD_LOGO = 'data:image/png;base64,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';

const DASHBOARD_STYLE = String.raw`
:root{
  /* Warm Claude dark palette */
  --bg:#1f1e1c; --bg-2:#26241f; --panel:#2a2724; --panel-2:#322e29;
  --border:#3a352f; --border-soft:#332f2a;
  --text:#f3efe6; --text-2:#d8d2c6; --muted:#a8a096; --faint:#6f675d;
  --clay:#d97757;
  --in:#c98a4b; --un:#cd6f5a; --done:#8a9a6b; --live:#d97757;
  /* lane accents: running=green, pending=amber, blocked=red */
  --run:#6f9f5b; --pend:#d0a24a; --blk:#cd6f5a;
  --radius:14px; --radius-sm:10px;
  --sidebar-w:280px;
  --font:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}

/* ---- scrollbars: thin, palette-matched, only on hover-ish contrast ---- */
*{scrollbar-width:thin;scrollbar-color:var(--border) transparent}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#453f38;border-radius:8px;
  border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:#554d44;background-clip:padding-box}
::-webkit-scrollbar-corner{background:transparent}
body{background:var(--bg);color:var(--text);font-family:var(--font);
  font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility}
a{color:var(--clay);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono)}

/* ---- shell: sidebar + main ---- */
[hidden]{display:none!important}
.shell{display:flex;min-height:100vh}
.sidebar{width:var(--sidebar-w);flex:0 0 var(--sidebar-w);position:sticky;top:0;
  height:100vh;background:var(--bg-2);border-right:1px solid var(--border);
  padding:26px 22px;display:flex;flex-direction:column;gap:24px;overflow-y:auto}
.main{flex:1;min-width:0;padding:34px 40px 60px;max-width:1500px}
@media (max-width:860px){
  .shell{flex-direction:column}
  .sidebar{width:auto;flex:none;height:auto;position:static;
    flex-direction:row;flex-wrap:wrap;align-items:center;gap:14px}
  .main{padding:22px 18px 48px}
}

/* ---- brand ---- */
.brand{display:flex;align-items:center;gap:11px}
.brand .logo{width:38px;height:38px;flex:0 0 38px;display:block;
  filter:drop-shadow(0 2px 8px rgba(120,130,220,.35))}
.brand .name{font-weight:600;font-size:15px;letter-spacing:.2px}
.brand .tag{font-size:11.5px;color:var(--faint);margin-top:1px}

/* ---- sidebar stats ---- */
.stats{display:flex;flex-direction:column;gap:8px}
.stat{display:flex;align-items:baseline;gap:10px;padding:12px 15px;border-radius:var(--radius-sm);
  background:var(--panel);border:1px solid var(--border-soft);width:100%;text-align:left;
  cursor:pointer;font-family:inherit;transition:border-color .15s,background .15s}
.stat:hover{border-color:var(--border);background:var(--panel-2)}
.stat.active{border-color:var(--clay);background:var(--panel-2);
  box-shadow:inset 2px 0 0 var(--clay)}
.stat-n{font-size:24px;font-weight:650;line-height:1;font-variant-numeric:tabular-nums}
.stat-l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.stat.run .stat-n{color:var(--run)} .stat.pend .stat-n{color:var(--pend)}
.stat.blk .stat-n{color:var(--blk)} .stat.done .stat-n{color:var(--done)}
.stat.all .stat-n{color:var(--text)}

/* ---- sidebar controls ---- */
.controls{display:flex;flex-direction:column;gap:10px;margin-top:auto}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
input[type=password]{width:100%;background:var(--panel-2);border:1px solid var(--border);
  color:var(--text);border-radius:10px;padding:10px 12px;font-size:13px;font-family:var(--mono)}
input[type=password]:focus{outline:none;border-color:var(--clay);
  box-shadow:0 0 0 3px rgba(217,119,87,.16)}
.remember{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);cursor:pointer}
.remember input{accent-color:var(--clay)}
button{font-family:var(--font);cursor:pointer;border-radius:10px;font-size:13px;
  padding:10px 14px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);
  transition:border-color .15s,background .15s}
button:hover{border-color:var(--clay)}
button.primary{background:var(--clay);border-color:var(--clay);color:#2a1a12;font-weight:600}
button.primary:hover{background:#e08863}
button.ghost.on{border-color:var(--clay);color:var(--clay)}
.status{font-size:12px;color:var(--muted);min-height:16px;padding-top:2px}
.status.ok{color:var(--done)} .status.err{color:var(--un)} .status.warn{color:var(--in)}

/* ---- main header ---- */
.page-head{display:flex;align-items:baseline;justify-content:space-between;
  gap:16px;margin-bottom:26px;flex-wrap:wrap}
.page-head h1{font-size:22px;font-weight:600;margin:0;letter-spacing:-.01em}
.page-head .clock{font-size:12.5px;color:var(--faint)}

/* ---- sandboxes panel ---- */
.panel{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius);
  padding:20px 22px;margin-bottom:28px}
.panel-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.panel-head h2{font-size:15px;font-weight:600;margin:0}
.panel-head .count{margin-left:2px;background:var(--panel-2);border:1px solid var(--border);
  border-radius:20px;font-size:12px;padding:1px 9px;color:var(--muted)}
.panel .desc{font-size:12.5px;color:var(--muted);margin:0 0 16px}
.sbx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.sbx{display:flex;gap:12px;padding:13px 15px;border-radius:var(--radius-sm);
  background:var(--panel-2);border:1px solid var(--border-soft)}
.sbx-body{min-width:0;flex:1}
.sbx-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sbx-id{font-size:12px;color:var(--text)}
.arrow{color:var(--clay);font-weight:600}
.sbx-repo{font-size:12px;color:var(--clay)}
.sbx-sub{display:flex;align-items:center;gap:9px;margin-top:6px;flex-wrap:wrap;
  font-size:11.5px;color:var(--muted)}
.sbx-task{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}

/* ---- board: single filtered lane ---- */
.board{display:block}
.lane{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius);
  display:flex;flex-direction:column;overflow:hidden}
.lane-head{display:flex;align-items:center;gap:9px;padding:15px 18px;
  border-bottom:1px solid var(--border-soft)}
.lane-head h2{font-size:13px;font-weight:600;margin:0;text-transform:uppercase;letter-spacing:.6px}
.lane-head .dot{width:8px;height:8px;border-radius:50%;background:var(--clay)}
.lane.run .dot{background:var(--run)} .lane.pend .dot{background:var(--pend)}
.lane.blk .dot{background:var(--blk)} .lane.done .dot{background:var(--done)}
.lane-head .pill{margin-left:auto;background:var(--panel-2);border:1px solid var(--border);
  border-radius:20px;font-size:12px;padding:1px 10px;color:var(--muted);font-variant-numeric:tabular-nums}
/* One column, but wrap into responsive columns when the list is long/wide. */
.lane-list{padding:14px;display:grid;gap:10px;
  grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}

/* ---- task cards ---- */
.task{background:var(--panel-2);border:1px solid var(--border-soft);border-radius:var(--radius-sm);
  padding:13px 14px;transition:border-color .15s}
.task:hover{border-color:var(--border)}
.task-title{font-weight:550;font-size:13.5px;line-height:1.4;margin-bottom:9px;word-break:break-word}
.task-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}
.state{font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;text-transform:lowercase}
.state.run{color:var(--run);background:rgba(111,159,91,.14)}
.state.pend{color:var(--pend);background:rgba(208,162,74,.14)}
.state.blk{color:var(--blk);background:rgba(205,111,90,.13)}
.state.done{color:var(--done);background:rgba(138,154,107,.15)}
/* ---- task card is clickable ---- */
.task{cursor:pointer;position:relative}
.task:hover{border-color:var(--border)}
.task:focus-visible{outline:2px solid var(--clay);outline-offset:2px}
/* ---- selection for batch removal ---- */
/* Select + remove cluster, top-right of a card. Hidden until hover so the board
   reads the same as before when nobody is editing. */
.task-actions{position:absolute;top:10px;right:10px;display:flex;align-items:center;gap:4px}
.task-actions .pick,.card-del{opacity:0;transition:opacity .15s,color .15s,background .15s,
  border-color .15s}
.task:hover .task-actions .pick,.task:hover .card-del,
.task-actions .pick[data-on],.task:focus-within .task-actions .pick,
.task:focus-within .card-del{opacity:1}
/* The native control is replaced: its OS accent colour (blue/orange) clashes
   with the warm palette. The input stays for semantics and keyboard focus. */
.task-actions .pick{display:inline-flex;cursor:pointer;padding:3px;border-radius:5px}
.task-actions .pick input{position:absolute;width:1px;height:1px;opacity:0;margin:0;
  pointer-events:none}
.pick-box{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;
  border:1px solid var(--muted);border-radius:4px;background:transparent;color:transparent;
  transition:border-color .15s,background .15s,color .15s}
.task-actions .pick:hover .pick-box{border-color:var(--clay)}
.task-actions .pick input:checked + .pick-box{background:var(--clay);border-color:var(--clay);
  color:#1f1e1c}
.task-actions .pick input:focus-visible + .pick-box{outline:2px solid var(--clay);
  outline-offset:2px}
.card-del{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
  padding:0;border:0;border-radius:5px;background:transparent;color:var(--faint);cursor:pointer}
.card-del:hover{background:rgba(215,86,68,.14);color:#f0a99a}
.card-del:focus-visible{outline:2px solid var(--clay);outline-offset:1px;opacity:1}
.card-del:disabled{cursor:default;opacity:.5}
.task.picked{border-color:var(--clay)}
.task-title{padding-right:52px}
.bulk{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 14px;
  background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius-sm)}
.bulk-n{font-size:12.5px;font-weight:600;color:var(--text);margin-right:auto}
.bulk-del{display:inline-flex;align-items:center;gap:6px;font-family:inherit;font-size:11.5px;
  font-weight:600;padding:5px 11px;border-radius:7px;cursor:pointer;background:transparent;
  color:#d98b7a;border:1px solid rgba(215,86,68,.4);
  transition:border-color .15s,color .15s,background .15s}
.bulk-del:hover{background:rgba(215,86,68,.12);border-color:#d75644;color:#f0a99a}
.bulk-del:disabled{cursor:default;opacity:.6}
/* ---- remove task (detail) ---- */
.d-danger{border-top:1px solid var(--border-soft);padding-top:16px}
.d-danger-note{font-size:12.5px;color:var(--muted);line-height:1.55;margin:0 0 11px}
.task-del{font-family:inherit;font-size:12px;font-weight:600;padding:7px 13px;
  border-radius:8px;cursor:pointer;background:transparent;color:#d98b7a;
  border:1px solid rgba(215,86,68,.4);transition:border-color .15s,color .15s,background .15s}
.task-del:hover{background:rgba(215,86,68,.12);border-color:#d75644;color:#f0a99a}
.task-del:disabled{cursor:default;opacity:.6}
/* ---- detail page (full screen route) ---- */
.detail-page{min-height:100vh;background:var(--bg)}
.detail-bar{position:sticky;top:0;z-index:2;background:var(--bg);
  border-bottom:1px solid var(--border-soft);padding:14px 40px}
.detail-back{display:inline-flex;align-items:center;gap:7px;background:transparent;
  border:1px solid var(--border);color:var(--text-2);font-family:inherit;font-size:13px;
  font-weight:550;padding:7px 13px;border-radius:9px;cursor:pointer;transition:border-color .15s,color .15s}
.detail-back:hover{color:var(--text);border-color:var(--muted)}
.detail-back svg{flex:0 0 auto}
.detail-inner{max-width:860px;margin:0 auto;padding:30px 40px 80px}
.detail-load{color:var(--muted);padding:40px 4px}
.d-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:8px}
.d-pri,.d-kind{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;
  border:1px solid var(--border);border-radius:20px;padding:2px 9px}
.d-title{font-size:26px;font-weight:650;margin:2px 0 7px;line-height:1.25}
.d-repo{font-size:12.5px;color:var(--muted);font-family:var(--mono);margin-bottom:16px}
.d-approve{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 15px;margin-bottom:18px;
  background:rgba(208,162,74,.08);border:1px solid rgba(208,162,74,.3);border-radius:var(--radius-sm)}
.d-approve .approve{width:auto;margin:0}
.d-approve-note{font-size:12.5px;color:var(--muted)}
.d-sec{border-top:1px solid var(--border-soft);padding-top:16px;margin-top:18px}
.d-sec h3{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;
  color:var(--muted);margin:0 0 10px}
.d-sec h4{font-size:12px;font-weight:600;margin:14px 0 6px;color:var(--text-2)}
.d-src{font-size:12px;color:var(--muted);font-family:var(--mono);margin-bottom:10px}
.d-desc{font-size:14px;line-height:1.6;white-space:pre-wrap;color:var(--text-2)}
.d-ac{margin:4px 0 0;padding-left:20px;font-size:13.5px;line-height:1.55;color:var(--text-2)}
.d-ac li{margin:3px 0}
.d-empty{font-size:13px;color:var(--muted);font-style:italic}
.d-plan-obj{font-size:14px;line-height:1.55;color:var(--text-2);margin-bottom:12px}
.d-prog{display:flex;align-items:center;gap:11px;margin-bottom:16px}
.d-prog-bar{flex:1;height:7px;border-radius:4px;background:var(--panel-2);overflow:hidden}
.d-prog-bar span{display:block;height:100%;background:var(--run);border-radius:4px;transition:width .2s}
.d-prog-txt{font-size:12px;color:var(--muted);white-space:nowrap}
.d-items{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.d-item{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:12px 14px}
.d-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px}
.d-item-st{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:12px;text-transform:uppercase;letter-spacing:.4px}
.d-item-st.done{color:var(--run);background:rgba(111,159,91,.14)}
.d-item-st.run{color:var(--pend);background:rgba(208,162,74,.14)}
.d-item-st.blk{color:var(--blk);background:rgba(205,111,90,.14)}
.d-item-st.pend{color:var(--muted);background:var(--panel-2)}
.d-item-kind{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.d-opt{font-size:10.5px;color:var(--muted);border:1px solid var(--border);border-radius:10px;padding:1px 7px}
.d-eff{font-size:10.5px;color:var(--muted);font-family:var(--mono);margin-left:auto}
.d-item-title{font-size:14px;font-weight:600;margin-bottom:3px}
.d-item-obj{font-size:13px;color:var(--text-2);line-height:1.5}
.d-dw{margin:7px 0 0;padding-left:18px;font-size:12.5px;color:var(--muted);line-height:1.5}
.repo{font-family:var(--mono);font-size:11px;color:var(--muted)}
.task-foot{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;color:var(--faint)}
.kind{border:1px solid var(--border);border-radius:5px;padding:1px 7px;color:var(--muted)}
.ago{color:var(--faint)}
.pr{margin-left:auto;font-weight:600}
.pr:hover{text-decoration:underline}
/* copyable task id */
.id-chip{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);
  font-size:10.5px;line-height:1;color:var(--muted);background:var(--panel);
  border:1px solid var(--border);border-radius:5px;padding:2px 7px;cursor:pointer;
  transition:border-color .15s,color .15s}
.id-chip:hover{border-color:var(--clay);color:var(--text)}
.id-chip.copied{border-color:var(--done);color:var(--done)}
.id-ico{flex:0 0 auto;opacity:.8}
/* approve action on awaiting_approval cards */
.approve{display:inline-flex;align-items:center;gap:6px;margin-top:11px;width:100%;
  justify-content:center;font-family:inherit;font-size:12.5px;font-weight:600;
  padding:8px 12px;border-radius:8px;cursor:pointer;
  background:var(--clay);border:1px solid var(--clay);color:#2a1a12;
  transition:background .15s,border-color .15s,opacity .15s}
.approve:hover{background:#e08863}
.approve:disabled{cursor:default;opacity:.7}
.approve.done{background:transparent;border-color:var(--done);color:var(--done)}
.approve svg{flex:0 0 auto}

/* ---- sandbox card actions ---- */
.sbx-actions{display:flex;gap:7px;margin-top:11px}
.sbx-open,.sbx-kill{font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;
  border-radius:7px;cursor:pointer;background:transparent;color:var(--muted);
  border:1px solid var(--border);transition:border-color .15s,color .15s,background .15s}
.sbx-open:hover{border-color:var(--clay);color:var(--text)}
.sbx-kill{color:#d98b7a;border-color:rgba(215,86,68,.4)}
.sbx-kill:hover{background:rgba(215,86,68,.12);border-color:#d75644;color:#f0a99a}
.sbx-kill:disabled,.sbx-open:disabled{cursor:default;opacity:.6}

/* ---- live session ---- */
.sess-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:11px}
.sess-st{font-size:11px;color:var(--muted);border:1px solid var(--border);
  border-radius:5px;padding:2px 8px}
.sess-head .sbx-kill{margin-left:auto}
.sess-warn{font-size:12.5px;color:#f0a99a;background:rgba(215,86,68,.1);
  border:1px solid rgba(215,86,68,.34);border-radius:8px;padding:10px 12px;margin-bottom:11px}
.sess-trunc{font-size:11.5px;color:var(--faint);font-style:italic;margin-bottom:7px}
.sess-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;
  max-height:340px;overflow-y:auto}
.sess-row{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;font-size:12px;
  padding:6px 10px;border-radius:6px;background:var(--panel);border:1px solid var(--border-soft)}
.sess-row.raw{display:block}
.sess-row.raw pre{margin:0;font-size:11.5px;color:var(--muted);white-space:pre-wrap;
  word-break:break-word}
.sess-ev{font-weight:600;color:var(--text)}
.sess-at{font-family:var(--mono,ui-monospace,monospace);font-size:11px;color:var(--faint)}
.sess-fields{display:flex;gap:11px;flex-wrap:wrap}
.sess-f{font-size:11.5px;color:var(--muted)}
.sess-f b{font-weight:500;color:var(--faint)}
.sess-err{margin-top:11px}
.sess-err summary{cursor:pointer;font-size:12px;color:var(--muted)}
.sess-err pre{margin:8px 0 0;font-size:11.5px;color:#e0a99a;white-space:pre-wrap;
  word-break:break-word;max-height:220px;overflow-y:auto;background:var(--panel);
  border:1px solid var(--border-soft);border-radius:6px;padding:10px}

/* ---- pulse + empty ---- */
.pulse{width:9px;height:9px;margin-top:5px;border-radius:50%;flex:0 0 9px;background:var(--live);
  box-shadow:0 0 0 0 rgba(217,119,87,.55);animation:pulse 1.9s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(217,119,87,.5)}
  70%{box-shadow:0 0 0 8px rgba(217,119,87,0)}100%{box-shadow:0 0 0 0 rgba(217,119,87,0)}}
.empty{color:var(--faint);font-size:12.5px;font-style:italic;padding:14px 4px;text-align:center}
.empty.wide{padding:20px}
`;
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Delivery Loop</title>
<link rel="icon" type="image/png" href="` + DASHBOARD_LOGO + String.raw`" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;650&display=swap" />
<style>
` + DASHBOARD_STYLE + String.raw`
</style>
</head>
<body>
<div class="shell" id="shell">
  <aside class="sidebar">
    <div class="brand">
      <img class="logo" alt="Delivery Loop" src="` + DASHBOARD_LOGO + String.raw`" />
      <div>
        <div class="name">Delivery Loop</div>
        <div class="tag">Operator board</div>
      </div>
    </div>
    <div class="stats" id="stats"></div>
    <div class="controls">
      <div class="field">
        <label for="token">Operations token</label>
        <input id="token" type="password" placeholder="Bearer token" autocomplete="off" />
      </div>
      <label class="remember"><input id="remember" type="checkbox" /> Remember on this device</label>
      <button id="load" class="primary">Load board</button>
      <button id="auto" class="ghost">Auto-refresh: off</button>
      <div id="status" class="status"></div>
    </div>
  </aside>
  <main class="main">
    <div class="page-head">
      <h1>Delivery board</h1>
      <span id="clock" class="clock"></span>
    </div>
    <section class="panel">
      <div class="panel-head">
        <span class="pulse"></span>
        <h2>Active sandboxes</h2>
        <span class="count" id="sbx-count">0</span>
      </div>
      <p class="desc">Sandboxes currently running and the repository each one is modifying.</p>
      <div class="sbx-grid" id="sandboxes"></div>
    </section>
    <div class="bulk" id="bulk" hidden></div>
    <div class="board" id="board"></div>
  </main>
</div>
<main class="detail-page" id="detail" hidden aria-hidden="true"></main>
<script>
` + DASHBOARD_SCRIPT + String.raw`
</script>
</body>
</html>`;


