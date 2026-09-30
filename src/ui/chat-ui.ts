/**
 * Self-contained chat UI generator.
 *
 * Emits a single HTML file (inline CSS + JS, no external assets) that drives a pushed EpicStaff
 * flow through its run-session API. It authenticates with `Authorization: ApiKey <key>` and
 * `X-Organization-Id` — both are CORS-allowed request headers on the backend, so the page works
 * cross-origin from `file://` or any local static server against the EpicStaff API with no
 * backend changes.
 *
 * The browser script is intentionally written with plain string concatenation (no template
 * literals / no `${}`) so the whole page can live in one TS template literal with a single
 * `${configJson}` injection point.
 */
export interface ChatUiConfig {
  /** Base API URL ending in `/api/` (e.g. http://localhost:8000/api/). */
  apiUrl: string;
  /** Backend graph id to run. */
  graphId: number;
  /** Human-readable graph/bot name shown in the header. */
  graphName: string;
  /** Active organization id sent as X-Organization-Id. */
  orgId: number;
  /** API key to prefill (stored client-side in localStorage). Leave blank to prompt the user. */
  apiKey?: string;
  /** Header title (defaults to graphName). */
  title?: string;
  /** Header subtitle / one-line description. */
  subtitle?: string;
  /** Dotted path of the variable that receives the user's message (default "chat.message"). */
  inputPath?: string;
  /** Dotted path of the variable holding the reply in the final state (default "reply"). */
  replyPath?: string;
  /**
   * Variables sent fresh on every turn, before the user's message is written in. Reset downstream
   * fields here (e.g. {extraction:{}, quote:{}, reply:null}) so a persistent-variables graph can't
   * carry a previous turn's answer into an ambiguous new one.
   */
  resetVariables?: Record<string, unknown>;
  /** Greeting bubble shown before the first user message. */
  welcome?: string;
}

interface ResolvedChatUiConfig extends Required<Omit<ChatUiConfig, 'apiKey'>> {
  apiKey: string;
}

function resolveConfig(config: ChatUiConfig): ResolvedChatUiConfig {
  return {
    apiUrl: config.apiUrl,
    graphId: config.graphId,
    graphName: config.graphName,
    orgId: config.orgId,
    apiKey: config.apiKey ?? '',
    title: config.title ?? config.graphName,
    subtitle: config.subtitle ?? 'EpicStaff chat agent',
    inputPath: config.inputPath ?? 'chat.message',
    replyPath: config.replyPath ?? 'reply',
    resetVariables: config.resetVariables ?? {},
    welcome: config.welcome ?? 'Hi! How can I help you today?',
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderChatUi(config: ChatUiConfig): string {
  const resolved = resolveConfig(config);
  // Escape "</" so an embedded string can never close the <script> element early.
  const configJson = JSON.stringify(resolved).replace(/<\//g, '<\\/');
  const title = escapeHtml(resolved.title);
  const subtitle = escapeHtml(resolved.subtitle);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root {
    --bg: #f5f6f8; --panel: #ffffff; --text: #1a1c1f; --muted: #6b7280;
    --border: #e4e7ec; --accent: #4f46e5; --accent-text: #ffffff;
    --user-bg: #4f46e5; --user-text: #ffffff; --bot-bg: #f0f1f4; --bot-text: #1a1c1f;
    --error: #b42318; --error-bg: #fef3f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --panel: #171a21; --text: #e6e8ec; --muted: #9aa2b1;
      --border: #262b35; --accent: #7c74ff; --accent-text: #0f1115;
      --user-bg: #7c74ff; --user-text: #0f1115; --bot-bg: #222732; --bot-text: #e6e8ec;
      --error: #ff8a80; --error-bg: #2a1a1a;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); display: flex; justify-content: center;
  }
  .app { width: 100%; max-width: 720px; height: 100vh; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  header .avatar { width: 38px; height: 38px; border-radius: 50%; background: var(--accent); color: var(--accent-text); display: flex; align-items: center; justify-content: center; font-weight: 700; flex: 0 0 auto; }
  header .titles { flex: 1 1 auto; min-width: 0; }
  header .titles h1 { font-size: 15px; margin: 0; line-height: 1.2; }
  header .titles p { font-size: 12px; margin: 2px 0 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header button.gear { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; padding: 6px; border-radius: 8px; }
  header button.gear:hover { background: var(--bot-bg); }
  #messages { flex: 1 1 auto; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
  .row { display: flex; }
  .row.user { justify-content: flex-end; }
  .bubble { max-width: 78%; padding: 10px 14px; border-radius: 16px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
  .row.user .bubble { background: var(--user-bg); color: var(--user-text); border-bottom-right-radius: 4px; }
  .row.bot .bubble { background: var(--bot-bg); color: var(--bot-text); border-bottom-left-radius: 4px; }
  .row.error .bubble { background: var(--error-bg); color: var(--error); font-size: 13px; }
  .typing .bubble { display: inline-flex; gap: 4px; }
  .typing .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); opacity: 0.5; animation: blink 1.2s infinite; }
  .typing .dot:nth-child(2) { animation-delay: 0.2s; }
  .typing .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
  form#composer { display: flex; gap: 10px; padding: 14px 16px; border-top: 1px solid var(--border); }
  #input { flex: 1 1 auto; resize: none; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; font: inherit; font-size: 14px; background: var(--bg); color: var(--text); max-height: 120px; }
  #input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button.send { background: var(--accent); color: var(--accent-text); border: none; border-radius: 12px; padding: 0 18px; font-weight: 600; cursor: pointer; }
  button.send:disabled { opacity: 0.5; cursor: default; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: none; align-items: center; justify-content: center; padding: 20px; }
  .modal-backdrop.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; width: 100%; max-width: 420px; padding: 20px; }
  .modal h2 { margin: 0 0 14px; font-size: 16px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .field input { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px; background: var(--bg); color: var(--text); }
  .modal .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .modal .actions button { border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .modal .actions button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
</style>
</head>
<body>
  <div class="app">
    <header>
      <div class="avatar" id="avatar">ES</div>
      <div class="titles"><h1>${title}</h1><p>${subtitle}</p></div>
      <button class="gear" id="open-settings" title="Settings" aria-label="Settings">&#9881;</button>
    </header>
    <div id="messages"></div>
    <form id="composer">
      <textarea id="input" rows="1" placeholder="Type your message..." autocomplete="off"></textarea>
      <button type="submit" class="send" id="send">Send</button>
    </form>
  </div>

  <div class="modal-backdrop" id="settings">
    <div class="modal">
      <h2>Connection settings</h2>
      <div class="field"><label>API base URL</label><input id="s-apiUrl" type="text" /></div>
      <div class="field"><label>API key</label><input id="s-apiKey" type="password" placeholder="ApiKey value" /></div>
      <div class="field"><label>Organization id</label><input id="s-orgId" type="number" /></div>
      <div class="field"><label>Graph id</label><input id="s-graphId" type="number" /></div>
      <div class="actions">
        <button type="button" id="s-cancel">Cancel</button>
        <button type="button" class="primary" id="s-save">Save</button>
      </div>
    </div>
  </div>

<script>
var ES_CONFIG = ${configJson};
</script>
<script>
(function () {
  var DEFAULTS = ES_CONFIG;
  var LS_KEY = 'es_chat_ui:' + DEFAULTS.graphId;

  function loadSettings() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { saved = {}; }
    return {
      apiUrl: saved.apiUrl || DEFAULTS.apiUrl,
      apiKey: saved.apiKey || DEFAULTS.apiKey || '',
      orgId: saved.orgId != null ? saved.orgId : DEFAULTS.orgId,
      graphId: saved.graphId != null ? saved.graphId : DEFAULTS.graphId
    };
  }
  function saveSettings(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }

  var settings = loadSettings();

  var messagesEl = document.getElementById('messages');
  var formEl = document.getElementById('composer');
  var inputEl = document.getElementById('input');
  var sendEl = document.getElementById('send');
  var modalEl = document.getElementById('settings');

  DEFAULTS.title = DEFAULTS.title || DEFAULTS.graphName;
  document.getElementById('avatar').textContent = (DEFAULTS.title || 'ES').slice(0, 2).toUpperCase();

  function headers() {
    return { 'Authorization': 'ApiKey ' + settings.apiKey, 'X-Organization-Id': String(settings.orgId) };
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  function getPath(obj, path) {
    var parts = path.split('.'); var cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }

  function addMessage(role, text) {
    var row = document.createElement('div');
    row.className = 'row ' + role;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return row;
  }

  function addTyping() {
    var row = document.createElement('div');
    row.className = 'row bot typing';
    row.id = 'typing';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function removeTyping() {
    var t = document.getElementById('typing');
    if (t) t.parentNode.removeChild(t);
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function runTurn(text) {
    var vars = JSON.parse(JSON.stringify(DEFAULTS.resetVariables || {}));
    setPath(vars, DEFAULTS.inputPath, text);
    var fd = new FormData();
    fd.append('graph_id', String(settings.graphId));
    fd.append('variables', JSON.stringify(vars));
    return fetch(settings.apiUrl + 'run-session/', { method: 'POST', headers: headers(), body: fd })
      .then(function (r) { if (!r.ok) throw new Error('run-session failed (' + r.status + ')'); return r.json(); })
      .then(function (d) { return poll(d.session_id); });
  }

  function poll(sessionId) {
    var terminal = { end: 1, error: 1, stop: 1, expired: 1 };
    function step() {
      return fetch(settings.apiUrl + 'sessions/' + sessionId + '/get-updates/', { headers: headers() })
        .then(function (r) { return r.json(); })
        .then(function (u) {
          if (terminal[u.status]) return u.status;
          return delay(800).then(step);
        });
    }
    return step().then(function (status) { return fetchReply(sessionId, status); });
  }

  function fetchReply(sessionId, status) {
    return fetch(settings.apiUrl + 'graph-session-messages/?session_id=' + sessionId + '&limit=500', { headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var results = d.results || [];
        var finalVars = null, lastAgent = null;
        for (var i = 0; i < results.length; i++) {
          var md = results[i].message_data || {};
          if (md.state && md.state.variables) finalVars = md.state.variables;
          if (md.message_type === 'agent_node_stream' && md.event === 'task_finish' && md.data && md.data.message) lastAgent = md.data.message;
        }
        var reply = finalVars ? getPath(finalVars, DEFAULTS.replyPath) : null;
        if (typeof reply !== 'string' || !reply) reply = lastAgent;
        if (status === 'error' && !reply) reply = 'The flow ended with an error. Open the session in EpicStaff to see details.';
        return reply || 'No reply was produced by the flow.';
      });
  }

  function submit() {
    var text = inputEl.value.trim();
    if (!text) return;
    if (!settings.apiKey) { openSettings(); return; }
    addMessage('user', text);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendEl.disabled = true;
    addTyping();
    runTurn(text)
      .then(function (reply) { removeTyping(); addMessage('bot', reply); })
      .catch(function (err) { removeTyping(); addMessage('error', String((err && err.message) || err)); })
      .then(function () { sendEl.disabled = false; inputEl.focus(); });
  }

  formEl.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  function openSettings() {
    document.getElementById('s-apiUrl').value = settings.apiUrl;
    document.getElementById('s-apiKey').value = settings.apiKey;
    document.getElementById('s-orgId').value = settings.orgId;
    document.getElementById('s-graphId').value = settings.graphId;
    modalEl.classList.add('open');
  }
  function closeSettings() { modalEl.classList.remove('open'); }

  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('s-cancel').addEventListener('click', closeSettings);
  document.getElementById('s-save').addEventListener('click', function () {
    settings = {
      apiUrl: document.getElementById('s-apiUrl').value.trim() || DEFAULTS.apiUrl,
      apiKey: document.getElementById('s-apiKey').value.trim(),
      orgId: Number(document.getElementById('s-orgId').value) || DEFAULTS.orgId,
      graphId: Number(document.getElementById('s-graphId').value) || DEFAULTS.graphId
    };
    if (settings.apiUrl.charAt(settings.apiUrl.length - 1) !== '/') settings.apiUrl += '/';
    saveSettings(settings);
    closeSettings();
  });
  modalEl.addEventListener('click', function (e) { if (e.target === modalEl) closeSettings(); });

  if (DEFAULTS.welcome) addMessage('bot', DEFAULTS.welcome);
  if (!settings.apiKey) openSettings();
  inputEl.focus();
})();
</script>
</body>
</html>
`;
}
