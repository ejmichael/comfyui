// Talks to ComfyUI straight from the browser (no backend).
// Requires ComfyUI to be started with --enable-cors-header so the browser is allowed to call it.

/** crypto.randomUUID only exists on https / localhost; opening the dev server by network IP (http) needs a fallback. */
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const clientId = uuid();

let base = '';
export const getBase = () => base;
export function setBase(url) {
  base = String(url || '').replace(/\/+$/, '');
}

const NETWORK_HELP =
  'Can’t reach ComfyUI. Check the address and that the pod is running. If it is, ComfyUI may be blocking browser access: start it with --enable-cors-header (see the README).';

/** Turn ComfyUI's validation error JSON into one readable sentence. */
function readableError(text) {
  try {
    const j = JSON.parse(text);
    const parts = [];
    if (j.error?.message) parts.push(j.error.message);
    const first = Object.entries(j.node_errors || {})[0];
    if (first) {
      const [id, n] = first;
      const e = n.errors?.[0];
      parts.push(`Node ${id} (${n.class_type})${e ? `: ${e.message}${e.details ? ` – ${e.details}` : ''}` : ''}`);
    }
    return parts.join('. ');
  } catch {
    return '';
  }
}

async function call(path, opts = {}, baseUrl = base) {
  if (!baseUrl) throw new Error('Set your ComfyUI address first (tap the ⚙ gear).');
  let res;
  try {
    res = await fetch(baseUrl + path, opts);
  } catch (e) {
    const err = new Error(e?.name === 'TimeoutError' ? 'No response after 8 seconds. Check the address and that the pod is running.' : NETWORK_HELP);
    err.network = true;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(readableError(text) || `ComfyUI answered with status ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function ping(baseUrl = base) {
  const res = await call('/system_stats', { signal: AbortSignal.timeout(8000) }, baseUrl);
  try {
    return await res.json();
  } catch {
    throw new Error('That address responded, but it doesn’t look like ComfyUI.');
  }
}

export async function listLoras() {
  const names = await (await call('/models/loras')).json();
  return Array.isArray(names) ? names : [];
}

/** The choices a node offers for a dropdown input (e.g. the saved RefMods), read live from the pod. */
export async function listComboOptions(nodeClass, input) {
  const data = await (await call(`/object_info/${encodeURIComponent(nodeClass)}`)).json();
  const def = data?.[nodeClass]?.input;
  const spec = def?.required?.[input] ?? def?.optional?.[input];
  if (!spec) return [];
  if (Array.isArray(spec[0])) return spec[0]; // classic format: [[a, b, c], {...}]
  if (spec[0] === 'COMBO') return spec[1]?.options || []; // newer format: ["COMBO", { options: [...] }]
  return [];
}

export async function uploadFile(file) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_');
  const form = new FormData();
  form.append('image', file, `${Date.now()}_${safe}`);
  form.append('overwrite', 'true');
  return (await call('/upload/image', { method: 'POST', body: form })).json(); // { name, subfolder, type }
}

export async function queuePrompt(workflow) {
  const res = await call('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  return res.json(); // { prompt_id, number, node_errors }
}

export async function getHistory(promptId) {
  const data = await (await call(`/history/${encodeURIComponent(promptId)}`)).json();
  return data[promptId] || null;
}

export async function cancel(promptId) {
  const json = { 'Content-Type': 'application/json' };
  await call('/queue', { method: 'POST', headers: json, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
  await call('/interrupt', { method: 'POST' }).catch(() => {});
}

export function viewUrl(o) {
  const q = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output' });
  return `${base}/view?${q}`;
}

/** Cross-origin links ignore the `download` attribute, so fetch the file and save the blob. */
export async function downloadFile(o) {
  try {
    const blob = await (await call(`/view?${viewUrl(o).split('?')[1]}`)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = o.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch {
    window.open(viewUrl(o), '_blank');
  }
}

/** Pull every downloadable file (video / gif / image) out of a history entry. */
export function extractOutputs(entry) {
  const found = [];
  for (const nodeOut of Object.values(entry?.outputs || {})) {
    for (const key of ['videos', 'gifs', 'images']) {
      for (const item of nodeOut[key] || []) {
        if (item.type === 'temp' && key === 'images') continue; // skip previews
        found.push({
          filename: item.filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
          kind: key === 'images' ? 'image' : 'video',
        });
      }
    }
  }
  return found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* Live progress: a websocket for the percentage, history polling for  */
/* the result (so a dropped connection never loses a finished job).    */
/* ------------------------------------------------------------------ */

const listeners = new Map(); // promptId -> Set<fn>
let ws;
let wsGen = 0;
let wsTimer;
let wsDelay = 2000;

const emit = (id, evt) => listeners.get(id)?.forEach((fn) => fn(evt));

function dispatch(msg) {
  const d = msg.data || {};
  const id = d.prompt_id;
  if (!id || !listeners.has(id)) return;
  switch (msg.type) {
    case 'execution_start':
      emit(id, { type: 'running' });
      break;
    case 'progress':
      emit(id, { type: 'progress', value: d.value, max: d.max });
      break;
    case 'executing':
      emit(id, d.node === null ? { type: 'check' } : { type: 'node' });
      break;
    case 'execution_success':
      emit(id, { type: 'check' });
      break;
    case 'execution_error':
      emit(id, { type: 'error', message: d.exception_message || 'Execution failed' });
      break;
    case 'execution_interrupted':
      emit(id, { type: 'error', message: 'Cancelled' });
      break;
    default:
  }
}

/** (Re)connects the progress websocket to the current address. Safe to call again after the address changes. */
export function connectSocket() {
  clearTimeout(wsTimer);
  const gen = ++wsGen;
  if (ws) {
    const old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try {
      old.close();
    } catch {
      /* already closed */
    }
  }
  if (!base) return;
  try {
    ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
  } catch {
    return;
  }
  ws.onopen = () => {
    wsDelay = 2000;
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return; // binary preview frames
    try {
      dispatch(JSON.parse(e.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onclose = () => {
    if (gen !== wsGen) return;
    wsTimer = setTimeout(connectSocket, wsDelay);
    wsDelay = Math.min(wsDelay * 1.5, 15000);
  };
}

function errorFromStatus(entry) {
  const msg = (entry.status?.messages || []).find((m) => m[0] === 'execution_error');
  return msg?.[1]?.exception_message || 'Execution failed';
}

/** Calls onEvent with {type: queued|running|progress|node|done|error}. Returns an unsubscribe function. */
export function subscribe(promptId, onEvent) {
  let finished = false;
  let timer;

  const stop = () => {
    finished = true;
    clearInterval(timer);
    const set = listeners.get(promptId);
    set?.delete(handler); // eslint-disable-line no-use-before-define
    if (set && !set.size) listeners.delete(promptId);
  };
  const finish = (evt) => {
    if (finished) return;
    onEvent(evt);
    stop();
  };

  const check = async () => {
    if (finished) return;
    try {
      const entry = await getHistory(promptId);
      if (!entry || finished) return;
      if (entry.status?.status_str === 'error') return finish({ type: 'error', message: errorFromStatus(entry) });
      const outputs = extractOutputs(entry);
      if (entry.status?.completed || outputs.length) finish({ type: 'done', outputs });
    } catch {
      /* transient network error: the next poll will retry */
    }
  };

  function handler(evt) {
    if (finished) return;
    if (evt.type === 'check') check();
    else if (evt.type === 'error') finish(evt);
    else onEvent(evt);
  }

  if (!listeners.has(promptId)) listeners.set(promptId, new Set());
  listeners.get(promptId).add(handler);
  timer = setInterval(check, 2000);
  onEvent({ type: 'queued' });
  check();
  return stop;
}
