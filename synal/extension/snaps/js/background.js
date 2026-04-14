// Snaps by Synal — background.js v1.0.1
// Retry queue, tab graph, orchestration handoff

const RETRY_LIMIT  = 3;
const RETRY_DELAY  = 30_000; // 30s
const BRIDGE_URL   = 'https://zdgnab3py0.execute-api.ap-southeast-2.amazonaws.com/prod/lambda/invoke';
const BRIDGE_KEY   = 'bk_tOH8P5WD3mxBKfICa4yI56vJhpuYOynfdf1d_GfvdK4';

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SNAP_FAIL')  handleRetryQueue(msg.envelope, msg.error);
  if (msg.type === 'SNAP_OK')    recordSuccess(msg.trace_id);
  if (msg.type === 'OPEN_PANEL') openSidePanel();
  if (msg.type === 'GET_CONTEXT') respondWithContext(sendResponse);
  return true;
});

// --- Context provider ---
async function respondWithContext(sendResponse) {
  const tabs    = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll();
  sendResponse({
    tab_count:    tabs.length,
    window_count: windows.length,
    tabs: tabs.slice(0, 20).map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }))
  });
}

// --- Retry queue ---
async function handleRetryQueue(envelope, error) {
  const { retryQueue = [] } = await chrome.storage.local.get('retryQueue');
  const existing = retryQueue.find(r => r.envelope?.payload?.idempotency_key === envelope?.payload?.idempotency_key);
  if (existing) {
    existing.attempts = (existing.attempts || 0) + 1;
    existing.last_error = error;
    existing.next_retry = Date.now() + RETRY_DELAY;
  } else {
    retryQueue.push({ envelope, attempts: 1, last_error: error, next_retry: Date.now() + RETRY_DELAY, created: Date.now() });
  }
  await chrome.storage.local.set({ retryQueue });
  scheduleRetry();
}

function scheduleRetry() {
  chrome.alarms.create('synal_retry', { delayInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'synal_retry') return;
  const { retryQueue = [] } = await chrome.storage.local.get('retryQueue');
  const now = Date.now();
  const due = retryQueue.filter(r => r.next_retry <= now && r.attempts <= RETRY_LIMIT);

  for (const item of due) {
    try {
      const res = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_KEY },
        body:   JSON.stringify(item.envelope)
      });
      if (res.ok) {
        // Remove from queue
        const updated = retryQueue.filter(r => r !== item);
        await chrome.storage.local.set({ retryQueue: updated });
        await recordSuccess(item.envelope?.payload?.trace_id);
      } else {
        item.attempts++;
        item.next_retry = now + RETRY_DELAY * item.attempts;
      }
    } catch {
      item.attempts++;
      item.next_retry = now + RETRY_DELAY * item.attempts;
    }
  }

  // Drop exhausted
  const cleaned = retryQueue.filter(r => r.attempts <= RETRY_LIMIT);
  await chrome.storage.local.set({ retryQueue: cleaned });
});

async function recordSuccess(trace_id) {
  const { tasks = [] } = await chrome.storage.local.get('tasks');
  tasks.unshift({ trace_id, event_type: 'BROWSER_SNAP', status: 'DONE', timestamp_utc: new Date().toISOString() });
  await chrome.storage.local.set({ tasks: tasks.slice(0, 50) });
}

// --- Side panel ---
async function openSidePanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

// --- Context menu ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'synal_snap_selection',
    title:    'Snap selection → Synal',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id:       'synal_snap_page',
    title:    'Snap page → Synal',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const envelope = {
    function_name: 'synal-task-intake',
    payload: {
      event_type:      info.menuItemId === 'synal_snap_selection' ? 'SELECTION_SNAP' : 'PAGE_SNAP',
      signal_family:   'research',
      source:          'context_menu',
      actor:           'browser_user',
      context: { page_url: tab.url, page_title: tab.title },
      payload: {
        captured_text: info.selectionText || '',
        page_url:      tab.url,
        page_title:    tab.title,
        timestamp:     new Date().toISOString()
      },
      trace_id:        crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      timestamp_utc:   new Date().toISOString(),
      version:         '2.1'
    }
  };

  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_KEY },
      body: JSON.stringify(envelope)
    });
    if (res.ok) await recordSuccess(envelope.payload.trace_id);
    else        await handleRetryQueue(envelope, `HTTP ${res.status}`);
  } catch (err) {
    await handleRetryQueue(envelope, err.message);
  }
});
