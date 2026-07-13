// Self-contained admin traffic dashboard served at GET /admin. The HTML shell is
// public (no data in it); the page prompts for the API_TOKEN (stored in
// localStorage) and fetches GET /api/visits/summary with a Bearer header, so the
// DATA stays token-gated (requireAdmin) while the page needs no server session.
// Plain HTML/CSS/JS, no framework or chart lib - "uncomplicated" by design. The
// embedded script deliberately avoids ${} template literals so this whole file
// can be one template string.

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Odds Pro - Traffic</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; background: #16151a; color: #e8e6ea; }
  header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 14px 20px; border-bottom: 1px solid #2b2930; position: sticky; top: 0; background: #16151a; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #9b98a3; margin: 22px 0 8px; }
  main { padding: 8px 20px 40px; max-width: 1100px; }
  .muted { color: #9b98a3; }
  input { background: #201f26; border: 1px solid #35333c; color: #e8e6ea; border-radius: 8px; padding: 7px 10px; font: inherit; }
  button { background: #17c9ba; color: #04201d; border: 0; border-radius: 8px; padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: #17c9ba; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: #201f26; border: 1px solid #2b2930; border-radius: 12px; padding: 14px; }
  .card .n { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .card .k { color: #9b98a3; font-size: 12px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #26242c; white-space: nowrap; }
  th { color: #9b98a3; font-weight: 600; }
  .bar { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .bar .lbl { width: 130px; overflow: hidden; text-overflow: ellipsis; }
  .bar .track { flex: 1; height: 10px; background: #26242c; border-radius: 5px; overflow: hidden; }
  .bar .fill { height: 100%; background: #17c9ba; }
  .bar .val { width: 46px; text-align: right; font-variant-numeric: tabular-nums; color: #c9c6d0; }
  .scroll { overflow-x: auto; border: 1px solid #2b2930; border-radius: 12px; }
  #err { color: #ff6b6b; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
</head>
<body>
<header>
  <h1>Odds Pro &middot; Traffic</h1>
  <span id="status" class="muted"></span>
  <span style="flex:1"></span>
  <div class="row">
    <input id="token" type="password" placeholder="API token" size="22" />
    <button id="load">Load</button>
    <button id="forget" class="ghost">Forget</button>
  </div>
</header>
<main>
  <div id="err"></div>
  <div id="content"></div>
</main>
<script>
(function () {
  var KEY = 'oddspro.admin.token';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); };

  function bars(items) {
    if (!items || !items.length) return '<div class="muted">No data yet.</div>';
    var max = items.reduce(function (m, it) { return Math.max(m, it.count); }, 0) || 1;
    return items.map(function (it) {
      var pct = Math.round(it.count / max * 100);
      return '<div class="bar"><div class="lbl" title="' + esc(it.name) + '">' + esc(it.name || '(none)') +
        '</div><div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
        '<div class="val">' + it.count + '</div></div>';
    }).join('');
  }

  function card(k, unique, views) {
    return '<div class="card"><div class="n">' + unique + '</div><div class="k">' + k +
      ' &middot; ' + views + ' views</div></div>';
  }

  function render(d) {
    var w = d.windows;
    var html = '';
    html += '<div class="cards">' +
      card('Today (unique)', w.today.unique, w.today.visits) +
      card('7 days', w.last7.unique, w.last7.visits) +
      card('30 days', w.last30.unique, w.last30.visits) +
      card('All time', w.all.unique, w.all.visits) + '</div>';

    html += '<h2>Daily (last 30 days)</h2><div class="scroll"><table><thead><tr>' +
      '<th>Day</th><th>Unique</th><th>Views</th></tr></thead><tbody>' +
      (d.series.length ? d.series.slice().reverse().map(function (s) {
        return '<tr><td>' + esc(s.day) + '</td><td>' + s.unique + '</td><td>' + s.visits + '</td></tr>';
      }).join('') : '<tr><td colspan="3" class="muted">No visits yet.</td></tr>') +
      '</tbody></table></div>';

    html += '<div class="grid2">';
    html += '<div><h2>Device</h2>' + bars(d.breakdowns.device) + '</div>';
    html += '<div><h2>Browser</h2>' + bars(d.breakdowns.browser) + '</div>';
    html += '<div><h2>OS</h2>' + bars(d.breakdowns.os) + '</div>';
    html += '<div><h2>Country</h2>' + bars(d.breakdowns.country) + '</div>';
    html += '</div>';

    html += '<h2>Top referrers</h2>' + bars(d.top_referers);

    html += '<h2>Recent visits</h2><div class="scroll"><table><thead><tr>' +
      '<th>Time (EAT)</th><th>IP</th><th>Device</th><th>Browser</th><th>OS</th>' +
      '<th>Country</th><th>Path</th><th>Referrer</th></tr></thead><tbody>' +
      d.recent.map(function (r) {
        return '<tr><td>' + esc(r.visited_at) + '</td><td>' + esc(r.ip) + '</td><td>' +
          esc(r.device_type) + '</td><td>' + esc(r.browser) + '</td><td>' + esc(r.os) + '</td><td>' +
          esc(r.country) + '</td><td>' + esc(r.path) + '</td><td>' + esc(r.referer) + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    html += '<p class="muted" style="margin-top:18px">Generated ' + esc(d.generated_at) +
      '. Geo (country/region) is resolved in a later pass.</p>';
    $('content').innerHTML = html;
  }

  function load() {
    var token = $('token').value.trim();
    $('err').textContent = '';
    if (!token) { $('err').textContent = 'Enter the API token.'; return; }
    localStorage.setItem(KEY, token);
    $('status').textContent = 'Loading...';
    fetch('/api/visits/summary', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function (res) {
        if (res.status === 401) throw new Error('Unauthorized - check the token.');
        if (res.status === 404) throw new Error('Admin not configured (set API_TOKEN on the server).');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (d) { $('status').textContent = ''; render(d); })
      .catch(function (e) { $('status').textContent = ''; $('err').textContent = e.message; });
  }

  $('load').onclick = load;
  $('forget').onclick = function () { localStorage.removeItem(KEY); $('token').value = ''; $('content').innerHTML = ''; $('status').textContent = 'Token cleared.'; };
  $('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });

  var saved = localStorage.getItem(KEY);
  if (saved) { $('token').value = saved; load(); }
})();
</script>
</body>
</html>`;
