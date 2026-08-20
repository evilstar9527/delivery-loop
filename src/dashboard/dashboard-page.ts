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

// Brand mark: a 72px metallic ring, inlined as a data URI so the board stays
// self-contained (no external image request). Replaces the earlier emoji.
const DASHBOARD_LOGO = 'data:image/png;base64,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';

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
.brand .logo{width:38px;height:38px;flex:0 0 38px;display:block;
  filter:drop-shadow(0 2px 8px rgba(120,130,220,.35))}
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
    <div class="board" id="board"></div>
  </main>
</div>
<script>
` + DASHBOARD_SCRIPT + String.raw`
</script>
</body>
</html>`;


