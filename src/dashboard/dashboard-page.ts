// Operator board served at GET /dashboard. CSS/JS are inline (the worker sets no
// CSP; the only external asset is the optional Inter webfont, which degrades to
// the system font stack if blocked). Data is fetched client-side from
// /v1/dashboard/overview with the operations Bearer token. Layout: fixed left
// sidebar (brand, overview stats, controls) + scrolling main area (active
// sandboxes panel over three task lanes). Warm dark Claude palette.

const DASHBOARD_SCRIPT = String.raw`
const LANES = [
  { key: 'in_progress', label: 'In progress', cls: 'in' },
  { key: 'unfinished', label: 'Unfinished', cls: 'un' },
  { key: 'completed', label: 'Completed', cls: 'done' },
];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const laneCls = (lane) => ({ in_progress: 'in', unfinished: 'un', completed: 'done' }[lane] || 'in');
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
  const counts = data.laneCounts || {};
  $('stats').innerHTML = LANES.map((l) =>
    '<div class="stat ' + l.cls + '"><span class="stat-n">' + (counts[l.key] || 0) +
    '</span><span class="stat-l">' + l.label + '</span></div>'
  ).join('');

  const byLane = { in_progress: [], unfinished: [], completed: [] };
  for (const t of (data.tasks || [])) (byLane[t.lane] || byLane.in_progress).push(t);
  $('board').innerHTML = LANES.map((l) => {
    const items = byLane[l.key] || [];
    const body = items.length ? items.map(taskCard).join('')
      : '<div class="empty">No tasks</div>';
    return '<section class="lane ' + l.cls + '">' +
      '<header class="lane-head"><span class="dot"></span><h2>' + l.label + '</h2>' +
      '<span class="pill">' + items.length + '</span></header>' +
      '<div class="lane-body">' + body + '</div></section>';
  }).join('');

  const sb = data.activeSandboxes || [];
  $('sbx-count').textContent = sb.length;
  $('sandboxes').innerHTML = sb.length ? sb.map(sandboxCard).join('')
    : '<div class="empty wide">No sandboxes are running right now.</div>';

  const stamp = new Date(data.generatedAt);
  $('clock').textContent = 'Snapshot ' + stamp.toLocaleTimeString();
}

function taskCard(t) {
  const pr = t.prNumber
    ? '<a class="pr" href="' + esc(t.prUrl) + '" target="_blank" rel="noopener">PR #' + esc(t.prNumber) + '</a>'
    : '';
  return '<article class="task">' +
    '<div class="task-title">' + esc(t.title) + '</div>' +
    '<div class="task-meta">' +
      '<span class="state ' + laneCls(t.lane) + '">' + esc(t.state) + '</span>' +
      '<span class="repo">' + esc(t.repository) + '</span>' +
    '</div>' +
    '<div class="task-foot"><span class="kind">' + esc(t.intentKind) + '</span>' +
      '<span class="ago">' + rel(t.updatedAt) + '</span>' + pr + '</div>' +
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
    '</div></article>';
}

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
})();
`;

const DASHBOARD_STYLE = String.raw`
:root{
  /* Warm Claude dark palette */
  --bg:#1f1e1c; --bg-2:#26241f; --panel:#2a2724; --panel-2:#322e29;
  --border:#3a352f; --border-soft:#332f2a;
  --text:#f3efe6; --muted:#a8a096; --faint:#6f675d;
  --clay:#d97757;
  --in:#c98a4b; --un:#cd6f5a; --done:#8a9a6b; --live:#d97757;
  --radius:14px; --radius-sm:10px;
  --sidebar-w:280px;
  --font:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--font);
  font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility}
a{color:var(--clay);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono)}

/* ---- shell: sidebar + main ---- */
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
.brand .logo{width:34px;height:34px;border-radius:9px;flex:0 0 34px;
  background:linear-gradient(135deg,var(--clay),#b45c3e);display:grid;place-items:center;
  font-size:18px;box-shadow:0 2px 10px rgba(217,119,87,.28)}
.brand .name{font-weight:600;font-size:15px;letter-spacing:.2px}
.brand .tag{font-size:11.5px;color:var(--faint);margin-top:1px}

/* ---- sidebar stats ---- */
.stats{display:flex;flex-direction:column;gap:10px}
.stat{display:flex;align-items:baseline;gap:10px;padding:13px 15px;border-radius:var(--radius-sm);
  background:var(--panel);border:1px solid var(--border-soft)}
.stat-n{font-size:26px;font-weight:650;line-height:1;font-variant-numeric:tabular-nums}
.stat-l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.stat.in .stat-n{color:var(--in)} .stat.un .stat-n{color:var(--un)} .stat.done .stat-n{color:var(--done)}

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

/* ---- board: three lanes ---- */
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;align-items:start}
@media (max-width:1100px){.board{grid-template-columns:1fr}}
.lane{background:var(--panel);border:1px solid var(--border-soft);border-radius:var(--radius);
  display:flex;flex-direction:column;overflow:hidden}
.lane-head{display:flex;align-items:center;gap:9px;padding:15px 18px;
  border-bottom:1px solid var(--border-soft)}
.lane-head h2{font-size:13px;font-weight:600;margin:0;text-transform:uppercase;letter-spacing:.6px}
.lane-head .dot{width:8px;height:8px;border-radius:50%}
.lane.in .dot{background:var(--in)} .lane.un .dot{background:var(--un)} .lane.done .dot{background:var(--done)}
.lane-head .pill{margin-left:auto;background:var(--panel-2);border:1px solid var(--border);
  border-radius:20px;font-size:12px;padding:1px 10px;color:var(--muted);font-variant-numeric:tabular-nums}
.lane-body{padding:12px;display:flex;flex-direction:column;gap:10px;
  max-height:calc(100vh - 220px);overflow-y:auto}

/* ---- task cards ---- */
.task{background:var(--panel-2);border:1px solid var(--border-soft);border-radius:var(--radius-sm);
  padding:13px 14px;transition:border-color .15s}
.task:hover{border-color:var(--border)}
.task-title{font-weight:550;font-size:13.5px;line-height:1.4;margin-bottom:9px;word-break:break-word}
.task-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}
.state{font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;text-transform:lowercase}
.state.in{color:var(--in);background:rgba(201,138,75,.13)}
.state.un{color:var(--un);background:rgba(205,111,90,.13)}
.state.done{color:var(--done);background:rgba(138,154,107,.15)}
.repo{font-family:var(--mono);font-size:11px;color:var(--muted)}
.task-foot{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;color:var(--faint)}
.kind{border:1px solid var(--border);border-radius:5px;padding:1px 7px;color:var(--muted)}
.ago{color:var(--faint)}
.pr{margin-left:auto;font-weight:600}
.pr:hover{text-decoration:underline}

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
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;650&display=swap" />
<style>
` + DASHBOARD_STYLE + String.raw`
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">🔄</div>
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
    <div class="board" id="board"></div>
  </main>
</div>
<script>
` + DASHBOARD_SCRIPT + String.raw`
</script>
</body>
</html>`;


