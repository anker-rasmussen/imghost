use std::fmt::Write as _;

use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::storage;
use crate::AppState;

const RECENT_LIMIT: i64 = 10;

pub(crate) async fn index(State(state): State<AppState>) -> Response {
    let (count, total_bytes, last_at) = storage::stats_summary(&state.pool)
        .await
        .unwrap_or((0, 0, None));
    let recent = storage::recent_anonymized(&state.pool, RECENT_LIMIT)
        .await
        .unwrap_or_default();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let uptime_secs = state.started_at.elapsed().as_secs();

    let html = render(count, total_bytes, last_at, &recent, now, uptime_secs);

    let mut resp = (StatusCode::OK, html).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    // Edge cache for 5 minutes, serve stale up to 10 more while revalidating.
    // This is the load wall: origin gets one query per cache miss, not per visitor.
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300, s-maxage=300, stale-while-revalidate=600"),
    );
    h.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        ),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    resp
}

fn render(
    count: i64,
    total_bytes: i64,
    last_at: Option<i64>,
    recent: &[storage::RecentEntry],
    rendered_at: i64,
    uptime_secs: u64,
) -> String {
    let recent_json = recent_to_json(recent);

    let mut out = String::with_capacity(8192);
    out.push_str(HEAD);

    let last_at_js = last_at.map_or_else(|| "null".to_string(), |v| v.to_string());

    let _ = write!(
        out,
        r"<script>
const SNAPSHOT = {{
  count: {count},
  bytes: {total_bytes},
  lastAt: {last_at_js},
  renderedAt: {rendered_at},
  uptimeAtRender: {uptime_secs},
  recent: {recent_json}
}};
</script>"
    );

    out.push_str(BODY_AND_SCRIPT);
    out
}

fn recent_to_json(recent: &[storage::RecentEntry]) -> String {
    let mut s = String::from("[");
    for (i, r) in recent.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let _ = write!(
            s,
            r#"{{"mime":"{}","size":{},"at":{}}}"#,
            json_escape(&r.mime),
            r.size_bytes,
            r.uploaded_at
        );
    }
    s.push(']');
    s
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str(r#"\""#),
            '\\' => out.push_str(r"\\"),
            '\n' => out.push_str(r"\n"),
            '\r' => out.push_str(r"\r"),
            '\t' => out.push_str(r"\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

const HEAD: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>imghost</title>
<meta name="description" content="a screenshot host for one. /i/&lt;id&gt;.&lt;ext&gt; only, everything else is gated.">
<meta name="color-scheme" content="dark">
<style>
:root {
  --bg: #050805;
  --fg: #7cf17c;
  --fg-dim: #4ea84e;
  --fg-bright: #c8ffd0;
  --accent: #ffb454;
  --danger: #ff6b6b;
  --glow: 0 0 1px currentColor, 0 0 6px rgba(124, 241, 124, 0.35);
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  overflow: hidden;
}
body::before {
  /* scanlines */
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,0) 0px,
      rgba(0,0,0,0) 2px,
      rgba(0,0,0,0.18) 3px,
      rgba(0,0,0,0) 4px
    );
  z-index: 3;
  mix-blend-mode: multiply;
}
body::after {
  /* vignette + crt curvature hint */
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse at center,
      rgba(0,0,0,0) 55%,
      rgba(0,0,0,0.55) 100%);
  z-index: 4;
}
#screen {
  position: fixed;
  inset: 0;
  padding: 1.6rem clamp(1rem, 4vw, 3rem);
  overflow-y: auto;
  text-shadow: var(--glow);
  animation: flicker 7s infinite steps(1);
  scrollbar-width: thin;
  scrollbar-color: var(--fg-dim) transparent;
}
#screen::-webkit-scrollbar { width: 8px; }
#screen::-webkit-scrollbar-thumb { background: var(--fg-dim); border-radius: 4px; }
@keyframes flicker {
  0%, 96%, 100% { opacity: 1; }
  97% { opacity: 0.92; }
  98% { opacity: 1; }
  99% { opacity: 0.97; }
}
.line { white-space: pre-wrap; word-break: break-word; }
.dim { color: var(--fg-dim); }
.bright { color: var(--fg-bright); }
.warn { color: var(--accent); }
.err { color: var(--danger); }
.row { display: flex; gap: .8em; }
.row > .k { color: var(--fg-dim); min-width: 7.5em; }
.row > .v { color: var(--fg-bright); }
.prompt { display: flex; align-items: baseline; gap: .4em; }
.prompt .ps1 { color: var(--accent); }
.prompt input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: 0;
  color: var(--fg-bright);
  font: inherit;
  text-shadow: var(--glow);
  caret-color: var(--fg-bright);
}
.prompt input:focus { outline: none; }
.caret { display: inline-block; width: .55em; height: 1em; background: var(--fg); margin-left: 1px; vertical-align: -2px; animation: blink 1.05s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
hr.sep { border: 0; border-top: 1px dashed var(--fg-dim); margin: .8em 0; opacity: .5; }
table.recent { border-collapse: collapse; margin-top: .3em; }
table.recent td { padding: 0 1em 0 0; }
table.recent td.t { color: var(--fg-dim); }
.banner { color: var(--fg-bright); white-space: pre; line-height: 1.05; }
.hint { color: var(--fg-dim); }
a, a:visited { color: var(--accent); }
@media (max-width: 520px) {
  #screen { font-size: 12px; padding: 1rem; }
  .row > .k { min-width: 6em; }
}
</style>
"#;

const BODY_AND_SCRIPT: &str = r#"</head>
<body>
<div id="screen" tabindex="0" aria-label="imghost terminal">
  <div id="out"></div>
  <div id="prompt" class="prompt" hidden>
    <span class="ps1">visitor@aigf:~$</span>
    <input id="input" type="text" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="terminal input">
  </div>
</div>
<script>
(() => {
  const out = document.getElementById('out');
  const promptEl = document.getElementById('prompt');
  const input = document.getElementById('input');
  const screen = document.getElementById('screen');
  const history = [];
  let histIdx = -1;
  let typing = false;
  let typeQueue = Promise.resolve();

  const fmtBytes = (b) => {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
    return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  const fmtDuration = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h || d) parts.push(h + 'h');
    if (m || h || d) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  };

  const fmtAgo = (unixSec) => {
    if (unixSec == null) return 'never';
    const now = Math.floor(Date.now() / 1000);
    const s = Math.max(0, now - Number(unixSec));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };

  const liveUptimeSec = () => {
    const drift = Math.floor(Date.now() / 1000) - SNAPSHOT.renderedAt;
    return SNAPSHOT.uptimeAtRender + Math.max(0, drift);
  };

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const append = (html) => {
    const el = document.createElement('div');
    el.className = 'line';
    el.innerHTML = html;
    out.appendChild(el);
    screen.scrollTop = screen.scrollHeight;
    return el;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const typeLine = (text, opts = {}) => {
    const cls = opts.cls || '';
    const speed = opts.speed != null ? opts.speed : 14;
    typeQueue = typeQueue.then(async () => {
      typing = true;
      const el = document.createElement('div');
      el.className = 'line ' + cls;
      out.appendChild(el);
      for (let i = 0; i < text.length; i++) {
        el.textContent += text[i];
        screen.scrollTop = screen.scrollHeight;
        if (speed > 0) await sleep(speed + Math.random() * 8);
      }
      typing = false;
    });
    return typeQueue;
  };

  const printRaw = (html, cls = '') => {
    typeQueue = typeQueue.then(() => {
      append(cls ? `<span class="${cls}">${html}</span>` : html);
    });
    return typeQueue;
  };

  // ----------- boot sequence -----------
  const banner = [
    ' _                 _               _   ',
    '(_)_ __ ___   __ _| |__   ___  ___| |_ ',
    '| | \'_ ` _ \\ / _` | \'_ \\ / _ \\/ __| __|',
    '| | | | | | | (_| | | | | (_) \\__ \\ |_ ',
    '|_|_| |_| |_|\\__, |_| |_|\\___/|___/\\__|',
    '             |___/                     ',
  ].join('\n');

  async function boot() {
    typeQueue = typeQueue.then(() => {
      append(`<span class="banner">${escapeHtml(banner)}</span>`);
    });
    await typeLine('booting imghost...', { speed: 18 });
    await typeLine('  cloudflare tunnel  ........  OK', { cls: 'dim', speed: 6 });
    await typeLine('  origin (rust + axum) ......  OK', { cls: 'dim', speed: 6 });
    await typeLine('  sqlite (wal, immutable cdn)  OK', { cls: 'dim', speed: 6 });
    await typeLine('  cf access (upload, admin) .  OK', { cls: 'dim', speed: 6 });
    typeQueue = typeQueue.then(() => append('<hr class="sep">'));
    await typeLine(`uploads served    ${SNAPSHOT.count.toLocaleString()}`, { cls: 'bright', speed: 8 });
    await typeLine(`bytes on disk     ${fmtBytes(SNAPSHOT.bytes)}`, { cls: 'bright', speed: 8 });
    await typeLine(`last upload       ${fmtAgo(SNAPSHOT.lastAt)}`, { cls: 'bright', speed: 8 });
    await typeLine(`origin uptime     ${fmtDuration(liveUptimeSec())}`, { cls: 'bright', speed: 8 });
    typeQueue = typeQueue.then(() => append('<hr class="sep">'));
    await typeLine(`type 'help' for commands. (snapshot from ${fmtAgo(SNAPSHOT.renderedAt)} — page is edge-cached, refresh for fresh)`, { cls: 'hint', speed: 6 });
    typeQueue = typeQueue.then(() => {
      promptEl.hidden = false;
      input.focus();
    });
  }

  // ----------- commands -----------
  const COMMANDS = {
    help: () => {
      const rows = [
        ['help',    'this list'],
        ['stats',   'live origin stats (from page snapshot)'],
        ['recent',  'last ' + SNAPSHOT.recent.length + ' uploads, anonymized'],
        ['whoami',  'what your browser tells me, locally'],
        ['about',   'what is this'],
        ['clear',   'clear screen'],
      ];
      for (const [k, v] of rows) {
        append(`<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`);
      }
    },
    stats: () => {
      const rows = [
        ['uploads',     SNAPSHOT.count.toLocaleString()],
        ['bytes',       fmtBytes(SNAPSHOT.bytes)],
        ['last upload', fmtAgo(SNAPSHOT.lastAt)],
        ['uptime',      fmtDuration(liveUptimeSec())],
        ['snapshot',    fmtAgo(SNAPSHOT.renderedAt) + ' (cache-control max-age=300)'],
      ];
      for (const [k, v] of rows) {
        append(`<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`);
      }
    },
    recent: () => {
      if (!SNAPSHOT.recent.length) { append('<span class="dim">no uploads yet.</span>'); return; }
      let html = '<table class="recent"><tbody>';
      for (const r of SNAPSHOT.recent) {
        html += `<tr><td class="t">${escapeHtml(fmtAgo(r.at))}</td><td>${escapeHtml(fmtBytes(r.size))}</td><td class="dim">${escapeHtml(r.mime)}</td></tr>`;
      }
      html += '</tbody></table>';
      append(html);
      append('<span class="dim">(no ids — public landing only sees timestamp / size / mime)</span>');
    },
    whoami: () => {
      const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'unknown';
      const lang = navigator.language || 'unknown';
      const langs = (navigator.languages || []).join(', ') || lang;
      const ua = navigator.userAgent || 'unknown';
      const viewportSz = `${window.innerWidth}x${window.innerHeight} (dpr ${window.devicePixelRatio || 1})`;
      const platform = navigator.platform || 'unknown';
      const rows = [
        ['timezone',  tz],
        ['language',  langs],
        ['platform',  platform],
        ['viewport',  viewportSz],
        ['user-agent', ua],
      ];
      for (const [k, v] of rows) {
        append(`<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`);
      }
      append('<span class="dim">(all read locally in your browser — nothing here is sent to or logged by the server)</span>');
    },
    about: () => {
      const lines = [
        'imghost is a personal screenshot host.',
        'one human uploads (cf-access service token), one human admins (cf-access idp).',
        'everyone else can see only what gets shared as /i/&lt;id&gt;.&lt;ext&gt;.',
        'this page is the only public html — no listing, no search, no api.',
        'source: <a href="https://github.com/anker-rasmussen/imghost" target="_blank" rel="noopener noreferrer">github.com/anker-rasmussen/imghost</a> (MIT)',
      ];
      for (const l of lines) append(l);
    },
    clear: () => { out.innerHTML = ''; },
  };

  // aliases
  COMMANDS['?'] = COMMANDS.help;
  COMMANDS['ls'] = () => append('<span class="dim">nothing to list. try </span><span class="bright">recent</span><span class="dim">.</span>');
  COMMANDS['cat'] = () => append('<span class="dim">no.</span>');
  COMMANDS['rm'] = () => append('<span class="err">permission denied.</span>');
  COMMANDS['sudo'] = () => append('<span class="err">visitor is not in the sudoers file. this incident will (not) be reported.</span>');
  COMMANDS['exit'] = () => append('<span class="dim">there is no exit. only the prompt.</span>');

  function run(line) {
    const trimmed = line.trim();
    append(`<span class="prompt"><span class="ps1">visitor@aigf:~$</span> <span class="bright">${escapeHtml(trimmed)}</span></span>`);
    if (!trimmed) return;
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const fn = COMMANDS[cmd.toLowerCase()];
    if (fn) {
      try { fn(rest); }
      catch (e) { append(`<span class="err">error: ${escapeHtml(String(e))}</span>`); }
    } else {
      append(`<span class="err">unknown command:</span> ${escapeHtml(cmd)} <span class="dim">(try 'help')</span>`);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (typing) return;
    if (e.key === 'Enter') {
      const v = input.value;
      if (v.trim()) { history.push(v); histIdx = history.length; }
      input.value = '';
      run(v);
      screen.scrollTop = screen.scrollHeight;
    } else if (e.key === 'ArrowUp') {
      if (histIdx > 0) { histIdx--; input.value = history[histIdx]; }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (histIdx < history.length - 1) { histIdx++; input.value = history[histIdx]; }
      else { histIdx = history.length; input.value = ''; }
      e.preventDefault();
    } else if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
      out.innerHTML = '';
      e.preventDefault();
    }
  });

  // keep focus on the input when the user clicks the screen
  screen.addEventListener('click', (e) => {
    if (window.getSelection().toString()) return;
    input.focus();
  });

  boot();
})();
</script>
</body>
</html>
"#;
