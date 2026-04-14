// Snaps by Synal — popup.js v1.0.1
// Signal capture → bridge → task

const BRIDGE_URL = 'https://zdgnab3py0.execute-api.ap-southeast-2.amazonaws.com/prod/lambda/invoke';
const BRIDGE_KEY = 'bk_tOH8P5WD3mxBKfICa4yI56vJhpuYOynfdf1d_GfvdK4';
const LAMBDA_FN   = 'synal-task-intake';
const TIMEOUT_MS  = 8000;

// --- UI refs ---
const statusChip   = document.getElementById('statusChip');
const pageTitle    = document.getElementById('pageTitle');
const pageUrl      = document.getElementById('pageUrl');
const captureText  = document.getElementById('captureText');
const signalFamily = document.getElementById('signalFamily');
const snapBtn      = document.getElementById('snapBtn');
const syncText     = document.getElementById('syncText');
const syncDot      = document.querySelector('.sync-dot');
const tabCount     = document.getElementById('tabCount');
const navItems     = document.querySelectorAll('.nav-item');
const tabs         = document.querySelectorAll('.tab');

// --- Tab nav ---
navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(n => n.classList.remove('active'));
    tabs.forEach(t => t.classList.remove('active'));
    item.classList.add('active');
    const target = document.getElementById(`tab-${item.dataset.tab}`);
    if (target) target.classList.add('active');
    if (item.dataset.tab === 'tasks') loadTasks();
    if (item.dataset.tab === 'proof') loadProof();
  });
});

// --- Init ---
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  pageTitle.textContent = tab.title || 'Unknown page';
  pageUrl.textContent   = tab.url || '';

  // Try to get selected text from content script
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString().trim() || ''
    });
    const sel = result?.[0]?.result;
    if (sel) captureText.value = sel;
  } catch {}

  // Tab count
  const allTabs = await chrome.tabs.query({});
  tabCount.textContent = `${allTabs.length} tabs`;

  // Load sync status
  loadSyncStatus();
}

async function loadSyncStatus() {
  const { lastSync, lastStatus } = await chrome.storage.local.get(['lastSync', 'lastStatus']);
  if (lastSync) {
    const ago = Math.round((Date.now() - lastSync) / 1000);
    syncText.textContent = `${ago < 60 ? ago + 's' : Math.round(ago/60) + 'm'} ago`;
  }
  if (lastStatus === 'error') {
    syncDot.className = 'sync-dot error';
  }
}

// --- Snap ---
snapBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const scope = document.querySelector('input[name=scope]:checked')?.value || 'active_tab';

  const payload = buildEnvelope({
    event_type:    'BROWSER_SNAP',
    signal_family: signalFamily.value,
    source:        'synal_snaps_extension',
    context: {
      page_url:   tab.url,
      page_title: tab.title,
      scope
    },
    payload: {
      captured_text: captureText.value.trim(),
      page_url:      tab.url,
      page_title:    tab.title,
      timestamp:     new Date().toISOString()
    }
  });

  await invokeWithState(payload);
});

function buildEnvelope({ event_type, signal_family, source, context, payload }) {
  return {
    function_name: LAMBDA_FN,
    payload: {
      event_type,
      signal_family,
      source,
      actor:           'browser_user',
      context,
      payload,
      trace_id:        crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      timestamp_utc:   new Date().toISOString(),
      version:         '2.1'
    }
  };
}

async function invokeWithState(envelope) {
  setLoading(true);
  syncDot.className = 'sync-dot syncing';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    BRIDGE_KEY
      },
      body:   JSON.stringify(envelope),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    await chrome.storage.local.set({ lastSync: Date.now(), lastStatus: 'ok', lastResponse: JSON.stringify(data) });

    setStatus('DONE', 'done');
    syncDot.className   = 'sync-dot';
    syncText.textContent = 'Just now';
    captureText.value    = '';

    // Enqueue for retry chain
    chrome.runtime.sendMessage({ type: 'SNAP_OK', trace_id: envelope.payload.trace_id });

  } catch (err) {
    await chrome.storage.local.set({ lastSync: Date.now(), lastStatus: 'error' });
    setStatus('FAILED', 'error');
    syncDot.className = 'sync-dot error';

    // Queue for retry
    chrome.runtime.sendMessage({ type: 'SNAP_FAIL', envelope, error: err.message });
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  snapBtn.disabled = on;
  snapBtn.classList.toggle('loading', on);
  snapBtn.textContent = on ? 'Sending...' : 'Snap Signal';
  if (on) setStatus('RUNNING', 'running');
}

function setStatus(label, cls) {
  statusChip.textContent  = label;
  statusChip.className    = `status-chip ${cls}`;
  setTimeout(() => {
    statusChip.textContent = 'READY';
    statusChip.className   = 'status-chip';
  }, 3000);
}

async function loadTasks() {
  const { tasks = [] } = await chrome.storage.local.get('tasks');
  const list = document.getElementById('taskList');
  const empty = document.getElementById('tasksEmpty');
  if (!tasks.length) { empty.style.display = 'flex'; list.innerHTML = ''; return; }
  empty.style.display = 'none';
  list.innerHTML = tasks.slice(0, 10).map(t => `
    <div class="task-item">
      <div class="task-title">${t.title || t.event_type}</div>
      <div class="task-meta">
        <span class="chip chip-${(t.status||'queued').toLowerCase()}">${t.status || 'QUEUED'}</span>
        <span>${new Date(t.created_at || t.timestamp_utc).toLocaleTimeString()}</span>
      </div>
    </div>`).join('');
}

async function loadProof() {
  const { proofs = [] } = await chrome.storage.local.get('proofs');
  const list = document.getElementById('proofList');
  const empty = document.getElementById('proofEmpty');
  if (!proofs.length) { empty.style.display = 'flex'; list.innerHTML = ''; return; }
  empty.style.display = 'none';
  list.innerHTML = proofs.slice(0, 10).map(p => `
    <div class="proof-item">
      <div class="task-title">${p.claim || p.type}</div>
      <div class="task-meta">
        <span class="chip chip-done">PROVEN</span>
        <span>${new Date(p.timestamp_utc).toLocaleTimeString()}</span>
      </div>
    </div>`).join('');
}

document.getElementById('panelBtn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
  window.close();
});
document.getElementById('settingsBtn')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init();
