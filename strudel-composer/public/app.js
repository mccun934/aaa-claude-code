const $ = (sel) => document.querySelector(sel);
const editorEl = $('#editor');
const badge = $('#badge');
const versionsEl = $('#versions');
const analysis = $('#analysis');
const analysisBody = $('#analysis-body');

const versions = [];
let lastReported = null; // editor code last sent to the server

const editor = async () => {
  while (!editorEl.editor) await new Promise((r) => setTimeout(r, 50));
  return editorEl.editor;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ------------------------------------------------------------ terminal

const term = new window.Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  scrollback: 5000,
  theme: { background: '#0f1115', foreground: '#e6e8ec', cursor: '#7ee0b5', selectionBackground: '#2a3a4f' },
});
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('#terminal'));
fit.fit();

let ws = null;
let retry = 0;
const connDot = $('#conn');
const send = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

async function connect() {
  const { token } = await fetch('/api/terminal-token').then((r) => r.json());
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/terminal?token=${token}`);
  ws.onopen = () => {
    retry = 0;
    connDot.className = 'dot on';
    term.reset(); // the server replays scrollback on attach
    send({ type: 'resize', cols: term.cols, rows: term.rows });
    term.focus();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'output') term.write(msg.data);
    else if (msg.type === 'reset') term.reset();
    else if (msg.type === 'exit') term.write(`\r\n\x1b[2m[process exited with code ${msg.exitCode}; press Restart]\x1b[0m\r\n`);
  };
  ws.onclose = () => {
    connDot.className = 'dot off';
    setTimeout(() => connect().catch(() => {}), Math.min(10_000, 500 * 2 ** retry++));
  };
}
term.onData((data) => send({ type: 'input', data }));
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
new ResizeObserver(() => fit.fit()).observe($('#terminal'));
$('#restart').onclick = () => {
  if (confirm('Restart the terminal? This ends the current Claude Code session.')) send({ type: 'restart' });
};
connect().catch((err) => term.write(`Could not connect to the terminal: ${err.message}\r\n`));

// ------------------------------------------------------------ songs

function setBadge(score, pass) {
  badge.hidden = false;
  badge.textContent = `musicality ${score}`;
  badge.className = `badge ${pass ? 'pass' : 'fail'}`;
}

function showAnalysis(ev) {
  analysis.hidden = false;
  const bars = Object.entries(ev.subscores ?? {})
    .map(([k, v]) => `<span>${k}</span><div class="bar"><span class="${v < 0.6 ? 'low' : ''}" style="width:${Math.round(v * 100)}%"></span></div><span>${Math.round(v * 100)}</span>`)
    .join('');
  const imgs = Object.entries(ev.images ?? {})
    .map(([name, src]) => `<div class="muted">${name === 'pianoRoll' ? 'Piano roll' : 'Spectrogram'}</div><img alt="${name}" src="${src}">`)
    .join('');
  analysisBody.innerHTML = `
    <div><strong>${ev.title ? `${escapeHtml(ev.title)}: ` : ''}score ${ev.score}</strong> ${ev.pass ? '(pass)' : '(below pass mark)'}</div>
    <div class="bars">${bars}</div>
    ${ev.issues?.length ? `<ul>${ev.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
    ${imgs}`;
}

// Browsers only allow audio after a user gesture on the page.
let audioUnlocked = false;
const unlock = () => {
  audioUnlocked = true;
  $('#audio-hint').hidden = true;
};
window.addEventListener('pointerdown', unlock, { once: true, capture: true });
window.addEventListener('keydown', unlock, { once: true, capture: true });

async function loadSong(song, { play = true } = {}) {
  const ed = await editor();
  ed.setCode(song.code);
  lastReported = null; // make sure the server learns about the new code
  if (!play) return;
  if (!audioUnlocked) {
    $('#audio-hint').hidden = false;
    return;
  }
  try {
    await ed.evaluate();
  } catch (err) {
    console.error(err);
  }
}

function addVersion(song) {
  versions.push(song);
  const opt = document.createElement('option');
  opt.value = String(versions.length - 1);
  opt.textContent = `v${versions.length}: ${song.title} (${song.score})`;
  versionsEl.append(opt);
  versionsEl.value = opt.value;
}

function onSong(song, { play = true } = {}) {
  addVersion(song);
  setBadge(song.score, song.pass);
  showAnalysis(song);
  loadSong(song, { play });
}

const events = new EventSource('/api/events');
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'song') onSong(ev);
};

// Restore the last published song after a reload (without auto-playing).
fetch('/api/song')
  .then((r) => r.json())
  .then((song) => song && onSong(song, { play: false }))
  .catch(() => {});

// Report editor contents so Claude can build on the user's own edits.
setInterval(async () => {
  const code = (await editor()).code;
  if (code === lastReported) return;
  lastReported = code;
  fetch('/api/editor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => {
    lastReported = null;
  });
}, 1500);

// ------------------------------------------------------------ editor toolbar

$('#play').onclick = async () => (await editor()).evaluate();
$('#stop').onclick = async () => (await editor()).stop();
versionsEl.onchange = () => {
  const v = versions[Number(versionsEl.value)];
  if (v) {
    loadSong(v);
    setBadge(v.score, v.pass);
    showAnalysis(v);
  }
};
$('#score').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Scoring…';
  try {
    const res = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: (await editor()).code }),
    });
    const ev = await res.json();
    if (!res.ok) throw new Error(ev.error);
    setBadge(ev.score, ev.pass);
    showAnalysis(ev);
    analysis.open = true;
  } catch (err) {
    alert(`Scoring failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Score my edits';
  }
};

// Long pattern lines are unreadable on phones without wrapping.
editor().then((ed) => ed.setLineWrappingEnabled(window.matchMedia('(max-width: 800px)').matches));

fetch('/api/status')
  .then((r) => r.json())
  .then((s) => {
    $('#status').textContent = `${s.knowledge.docs} doc sections · ${s.knowledge.functions} functions · ${s.knowledge.examples} examples · pass mark ${s.passScore}`;
  })
  .catch(() => {});
