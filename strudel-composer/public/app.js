const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const input = $('#input');
const sendBtn = $('#send');
const editorEl = $('#editor');
const badge = $('#badge');
const versionsEl = $('#versions');
const analysis = $('#analysis');
const analysisBody = $('#analysis-body');

let sessionId = null;
let busy = false;
const versions = [];

const editor = async () => {
  while (!editorEl.editor) await new Promise((r) => setTimeout(r, 50));
  return editorEl.editor;
};

// ------------------------------------------------------------ helpers

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Minimal markdown: fenced code, inline code, bold, paragraphs, bullet lists.
function renderMarkdown(text) {
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g);
  return parts
    .map((part, i) => {
      if (i % 2) return `<pre><code>${escapeHtml(part.trimEnd())}</code></pre>`;
      return part
        .trim()
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((block) => {
          const html = escapeHtml(block)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
          if (/^\s*[-*] /m.test(block) && block.split('\n').every((l) => /^\s*[-*] /.test(l))) {
            return `<ul>${html.split('\n').map((l) => `<li>${l.replace(/^\s*[-*] /, '')}</li>`).join('')}</ul>`;
          }
          return `<p>${html.replace(/\n/g, '<br>')}</p>`;
        })
        .join('');
    })
    .join('');
}

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, html) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (html !== undefined) el.innerHTML = html;
  messagesEl.append(el);
  scrollDown();
  return el;
}

const TOOL_LABELS = {
  search_docs: (i) => `searched docs: “${i.query}”`,
  lookup_function: (i) => `looked up ${i.name}()`,
  search_examples: (i) => `searched examples: “${i.query}”`,
  find_sounds: (i) => `browsed sounds: “${i.query}”`,
  test_pattern: () => 'rendering & scoring a draft…',
  listen: () => 'listening to the render…',
  publish_song: (i) => `publishing “${i.title}”…`,
};

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
  const verdict = ev.verdict && !ev.verdict.error
    ? `<div class="verdict"><strong>Critic ${ev.verdict.overall}/10</strong>: ${escapeHtml(ev.verdict.summary)}<ul>${ev.verdict.fixes.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>`
    : '';
  const imgs = Object.entries(ev.images ?? {})
    .map(([name, src]) => `<div class="muted">${name === 'pianoRoll' ? 'Piano roll' : 'Spectrogram'}</div><img alt="${name}" src="${src}">`)
    .join('');
  analysisBody.innerHTML = `
    <div><strong>Score ${ev.score}</strong> ${ev.pass ? '(pass)' : '(below pass mark)'}</div>
    <div class="bars">${bars}</div>
    ${ev.issues?.length ? `<ul>${ev.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
    ${verdict}${imgs}`;
}

async function loadSong(song, { play = true } = {}) {
  const ed = await editor();
  ed.setCode(song.code);
  if (play) {
    try {
      await ed.evaluate();
    } catch (err) {
      console.error(err);
    }
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

// ------------------------------------------------------------ chat

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;
  addMessage('user', escapeHtml(text));
  const bubble = addMessage('assistant');
  const activity = document.createElement('div');
  activity.className = 'activity';
  let textEl = null;
  let textBuf = '';
  let thinkingEl = null;
  const step = (label) => {
    const el = document.createElement('div');
    el.className = 'step';
    el.textContent = `· ${label}`;
    activity.append(el);
    if (!activity.isConnected) bubble.append(activity);
    scrollDown();
    return el;
  };
  let lastStep = null;

  const ed = await editor();
  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message: text, editorCode: ed.code }),
    });
  } catch (err) {
    bubble.innerHTML = `<p class="error">Network error: ${escapeHtml(err.message)}</p>`;
    busy = false;
    sendBtn.disabled = false;
    return;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    bubble.innerHTML = `<p class="error">${escapeHtml(err.error || res.statusText)}</p>`;
    busy = false;
    sendBtn.disabled = false;
    return;
  }

  const handle = async (ev) => {
    switch (ev.type) {
      case 'session':
        sessionId = ev.sessionId;
        break;
      case 'thinking':
        if (!thinkingEl) {
          thinkingEl = document.createElement('details');
          thinkingEl.className = 'thinking';
          thinkingEl.innerHTML = '<summary>thinking…</summary><div></div>';
          bubble.append(thinkingEl);
        }
        thinkingEl.querySelector('div').textContent += ev.delta;
        break;
      case 'text':
        if (!textEl) {
          textEl = document.createElement('div');
          bubble.append(textEl);
          textBuf = '';
        }
        textBuf += ev.delta;
        textEl.innerHTML = renderMarkdown(textBuf);
        scrollDown();
        break;
      case 'tool':
        textEl = null; // text after a tool call starts a new block
        thinkingEl = null;
        lastStep = step(TOOL_LABELS[ev.name]?.(ev.input) ?? ev.name);
        break;
      case 'status':
        step(ev.text);
        break;
      case 'evaluation': {
        const target = lastStep ?? step(ev.tool);
        target.innerHTML += ` → <span class="score" style="color:${ev.pass ? 'var(--accent)' : 'var(--warn)'}">${ev.score}</span>${ev.verdict?.overall !== undefined ? ` · critic ${ev.verdict.overall}/10` : ''}`;
        showAnalysis(ev);
        break;
      }
      case 'song': {
        setBadge(ev.score, !ev.warning);
        addVersion(ev);
        const card = document.createElement('div');
        card.className = 'song-card';
        card.innerHTML = `<span>🎵 <strong>${escapeHtml(ev.title)}</strong> · musicality ${ev.score}${ev.warning ? ` · <span class="error">${escapeHtml(ev.warning)}</span>` : ''}</span>`;
        const btn = document.createElement('button');
        btn.textContent = 'Load & play';
        btn.onclick = () => loadSong(ev);
        card.append(btn);
        bubble.append(card);
        await loadSong(ev);
        break;
      }
      case 'error':
        bubble.insertAdjacentHTML('beforeend', `<p class="error">${escapeHtml(ev.message)}</p>`);
        break;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (chunk.startsWith('data: ')) await handle(JSON.parse(chunk.slice(6)));
    }
  }
  busy = false;
  sendBtn.disabled = false;
  input.focus();
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  send(text);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
document.querySelectorAll('.suggestions button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));

// ------------------------------------------------------------ editor toolbar

$('#play').onclick = async () => (await editor()).evaluate();
$('#stop').onclick = async () => (await editor()).stop();
versionsEl.onchange = () => {
  const v = versions[Number(versionsEl.value)];
  if (v) {
    loadSong(v);
    setBadge(v.score, !v.warning);
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
    $('#status').textContent = `${s.model} · ${s.knowledge.docs} doc sections · ${s.knowledge.functions} functions · ${s.knowledge.examples} examples${s.apiKey ? '' : ' · ⚠ ANTHROPIC_API_KEY not set'}`;
  })
  .catch(() => {});
