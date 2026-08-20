// Self-contained operator board served at GET /dashboard. No external assets:
// a strict deployment blocks CDNs, so all CSS/JS is inline. Data is fetched
// client-side from /v1/dashboard/overview with the operations Bearer token.

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

let timer = null;
function token() { return $('token').value.trim(); }

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (isErr ? ' err' : '');
}

async function load() {
  const tok = token();
  if (!tok) { setStatus('enter a token', true); return; }
  setStatus('loading…', false);
  try {
    const res = await fetch('/v1/dashboard/overview', {
      headers: { authorization: 'Bearer ' + tok },
      cache: 'no-store',
    });
    if (res.status === 401) { setStatus('unauthorized — check token', true); return; }
    if (!res.ok) { setStatus('error ' + res.status, true); return; }
    const data = await res.json();
    render(data);
    if ($('remember').checked) { try { localStorage.setItem('dl_ops_token', tok); } catch (e) {} }
    setStatus('updated ' + new Date().toLocaleTimeString(), false);
  } catch (e) {
    setStatus('network error', true);
  }
}

function render(data) {
  const counts = data.laneCounts || {};
  $('summary').innerHTML = LANES.map((l) =>
    '<div class="card ' + l.cls + '"><div class="n">' + (counts[l.key] || 0) +
    '</div><div class="l">' + l.label + '</div></div>'
  ).join('');

  const byLane = { in_progress: [], unfinished: [], completed: [] };
  for (const t of (data.tasks || [])) (byLane[t.lane] || byLane.in_progress).push(t);

  $('board').innerHTML = LANES.map((l) => {
    const items = byLane[l.key] || [];
    const body = items.length
      ? items.map(taskCard).join('')
      : '<div class="empty">No tasks</div>';
    return '<div class="lane ' + l.cls + '"><h2><span class="dot"></span>' + l.label +
      '<span class="cnt">' + items.length + '</span></h2>' + body + '</div>';
  }).join('');

  const sb = data.activeSandboxes || [];
  $('sandboxes').innerHTML = sb.length ? sandboxTable(sb)
    : '<div class="empty">No sandboxes are running right now.</div>';

  $('clock').textContent = 'snapshot ' + new Date(data.generatedAt).toLocaleTimeString();
}

function taskCard(t) {
  const pr = t.prNumber
    ? ' · <a href="' + esc(t.prUrl) + '" target="_blank" rel="noopener">PR #' + esc(t.prNumber) + '</a>'
    : '';
  return '<div class="task">' +
    '<div class="t">' + esc(t.title) + '</div>' +
    '<div class="meta">' +
      '<span class="st ' + laneCls(t.lane) + '">' + esc(t.state) + '</span>' +
      '<span class="badge repo">' + esc(t.repository) + '</span>' +
      '<span class="badge">' + esc(t.intentKind) + '</span>' +
      '<span>' + rel(t.updatedAt) + pr + '</span>' +
    '</div></div>';
}

function sandboxTable(rows) {
  return '<div style="overflow-x:auto"><table><thead><tr>' +
    '<th>Sandbox</th><th>Role</th><th>Repository</th><th>Task</th><th>Started</th>' +
    '</tr></thead><tbody>' +
    rows.map((s) =>
      '<tr>' +
      '<td class="mono">' + esc(s.sandboxId) + '</td>' +
      '<td><span class="role ' + esc(s.role) + '">' + esc(s.role) + '</span></td>' +
      '<td class="mono">' + esc(s.repository) + '</td>' +
      '<td>' + esc(s.taskTitle) + '</td>' +
      '<td>' + rel(s.startedAt || s.updatedAt) + '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table></div>';
}

function toggleAuto() {
  if (timer) {
    clearInterval(timer); timer = null; $('auto').textContent = 'Auto: off';
  } else {
    timer = setInterval(load, 10000); $('auto').textContent = 'Auto: 10s'; load();
  }
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

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Delivery Loop Board</title>
<style>
:root{
  --bg:#0f1115; --panel:#171a21; --panel-2:#1f2530; --border:#2a2f3a;
  --text:#e6e9ef; --muted:#98a2b3; --accent:#6b9bff;
  --in:#4676e5; --un:#d75644; --done:#6bae3f; --live:#eb933e;
  --radius:10px; --gap:14px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header{position:sticky;top:0;z-index:5;background:rgba(15,17,21,.92);
  backdrop-filter:blur(6px);border-bottom:1px solid var(--border);
  padding:14px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
.spacer{flex:1}
.token-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input[type=password],input[type=text]{background:var(--panel-2);border:1px solid var(--border);
  color:var(--text);border-radius:8px;padding:7px 10px;min-width:240px;font-size:13px}
button{background:var(--panel-2);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--in);border-color:var(--in);color:#fff}
.status{font-size:12px;color:var(--muted)}
.status.err{color:var(--un)}
main{padding:20px;max-width:1400px;margin:0 auto}
.summary{display:flex;gap:var(--gap);margin-bottom:20px;flex-wrap:wrap}
.summary .card{flex:1;min-width:150px;background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius);padding:14px 16px}
.summary .n{font-size:28px;font-weight:700;line-height:1}
.summary .l{font-size:12px;color:var(--muted);margin-top:6px;text-transform:uppercase;letter-spacing:.5px}
.card.in .n{color:var(--in)} .card.un .n{color:var(--un)} .card.done .n{color:var(--done)}
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--gap);align-items:start}
@media (max-width:900px){.board{grid-template-columns:1fr}}
.lane{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);
  padding:12px;min-height:120px}
.lane h2{font-size:13px;margin:0 0 10px;display:flex;align-items:center;gap:8px;
  text-transform:uppercase;letter-spacing:.6px;color:var(--muted)}
.lane h2 .dot{width:9px;height:9px;border-radius:50%}
.lane.in h2 .dot{background:var(--in)} .lane.un h2 .dot{background:var(--un)}
.lane.done h2 .dot{background:var(--done)}
.lane h2 .cnt{margin-left:auto;background:var(--panel-2);border-radius:20px;padding:1px 9px;
  font-size:12px;color:var(--text)}
.task{background:var(--panel-2);border:1px solid var(--border);border-radius:8px;
  padding:10px 12px;margin-bottom:9px}
.task .t{font-weight:600;font-size:13px;margin-bottom:5px;word-break:break-word}
.task .meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--muted)}
.badge{border-radius:5px;padding:1px 7px;font-size:11px;border:1px solid var(--border);white-space:nowrap}
.repo{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.st{font-weight:600}
.st.in{color:var(--in)} .st.un{color:var(--un)} .st.done{color:var(--done)}
.empty{color:var(--muted);font-size:12px;font-style:italic;padding:8px 2px}
.sandboxes{margin-top:24px;background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius);padding:14px 16px}
.sandboxes h2{font-size:14px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.sandboxes .sub{font-size:12px;color:var(--muted);margin-bottom:12px}
.pulse{width:9px;height:9px;border-radius:50%;background:var(--live);
  box-shadow:0 0 0 0 rgba(235,147,62,.6);animation:pulse 1.8s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(235,147,62,.55)}70%{box-shadow:0 0 0 8px rgba(235,147,62,0)}
  100%{box-shadow:0 0 0 0 rgba(235,147,62,0)}}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.role{border-radius:5px;padding:1px 7px;font-size:11px;border:1px solid var(--border)}
.role.work{color:var(--in);border-color:var(--in)}
.role.publisher{color:var(--live);border-color:var(--live)}
.hidden{display:none}
</style>
</head>
<body>
<header>
  <h1>🔄 Delivery Loop Board</h1>
  <span id="clock" class="status"></span>
  <div class="spacer"></div>
  <div class="token-row">
    <input id="token" type="password" placeholder="OPERATIONS_TOKEN (Bearer)" autocomplete="off" />
    <label class="status"><input id="remember" type="checkbox" /> remember</label>
    <button id="load" class="primary">Load</button>
    <button id="auto">Auto: off</button>
    <span id="status" class="status"></span>
  </div>
</header>
<main>
  <section class="summary" id="summary"></section>
  <section class="board" id="board"></section>
  <section class="sandboxes">
    <h2><span class="pulse"></span> Active sandboxes → repositories</h2>
    <div class="sub">Sandboxes currently running (starting/running) and the repository each is modifying.</div>
    <div id="sandboxes"></div>
  </section>
</main>
<script>
` + DASHBOARD_SCRIPT + String.raw`
</script>
</body>
</html>`;
