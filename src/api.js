// Browser-side replacement for the old Node server: same function names the UI already uses.
import * as comfy from './lib/comfy.js';
import { buildWorkflow, resolveNode } from './lib/workflow.js';

export { viewUrl, downloadFile, subscribe } from './lib/comfy.js';

const URL_KEY = 'comfy_studio_url';

const readSavedUrl = () => {
  try {
    return localStorage.getItem(URL_KEY) || '';
  } catch {
    return '';
  }
};

// Start from the saved address, falling back to an optional build-time default (VITE_COMFY_URL).
comfy.setBase(readSavedUrl() || import.meta.env.VITE_COMFY_URL || '');
comfy.connectSocket();

/* ----------------------- static config files ----------------------- */

async function loadJson(file) {
  let res;
  try {
    res = await fetch(`${import.meta.env.BASE_URL}config/${file}`, { cache: 'no-store' });
  } catch {
    throw new Error(`Couldn’t load config/${file}.`);
  }
  if (!res.ok) throw new Error(`Couldn’t load config/${file} (status ${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new Error(`config/${file} isn’t valid JSON.`);
  }
}

export async function getConfig() {
  const m = await loadJson('mapping.json');

  // The workflow's own prompt is a good starting point (this template expects a structured prompt).
  let defaultPrompt = '';
  try {
    const wf = await loadJson('workflow_api.json');
    const value = wf[resolveNode(wf, m.prompt, 'prompt')]?.inputs?.[m.prompt.input];
    if (typeof value === 'string') defaultPrompt = value;
  } catch {
    /* workflow not filled in yet: Generate will explain */
  }

  return {
    title: m.title || 'Comfy Studio',
    defaultPrompt,
    duration: {
      options: m.duration?.options || [5],
      default: m.duration?.default || m.duration?.options?.[0] || 5,
    },
    hasNegativePrompt: !!m.negativePrompt,
    hasAspectRatio: !!m.aspectRatio,
    defaultAspectRatio: m.aspectRatio?.default || '',
    maxLoras: m.powerLora ? m.powerLora.max ?? 8 : m.loras ? m.loras.max ?? m.loras.slots.length : 0,
    maxRefMods: m.refMods ? m.refMods.slots ?? 8 : 0,
    maxImages: m.referenceImages?.slots?.length || 0,
    maxVideos: m.referenceVideos?.slots?.length || 0,
  };
}

/* ------------------------- ComfyUI address ------------------------- */

/** Accepts whatever gets pasted ("abc-8188.proxy.runpod.net", a full URL with a path, ...) and returns a clean origin. */
export function normalizeUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Paste your ComfyUI address first.');

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|\d{1,3}(\.\d{1,3}){3})/i.test(value);
    value = (local ? 'http://' : 'https://') + value;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('That doesn’t look like a valid address.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The address must start with http:// or https://');
  return url.origin;
}

export const getSettings = async () => ({ comfyUrl: comfy.getBase() });

/** Only saves an address that actually answers like ComfyUI. */
export async function saveSettings(input) {
  const url = normalizeUrl(input);
  await comfy.ping(url);
  try {
    localStorage.setItem(URL_KEY, url);
  } catch {
    /* storage unavailable: the address still works for this session */
  }
  comfy.setBase(url);
  comfy.connectSocket();
  return { comfyUrl: url };
}

/* ------------------------------- calls ------------------------------ */

export const getHealth = () => comfy.ping();
export const getLoras = () => comfy.listLoras();

/** Names of the RefMods saved on the pod (the dropdown choices of the RefMods loader node). */
export async function getRefMods() {
  const [wf, m] = await Promise.all([loadJson('workflow_api.json'), loadJson('mapping.json')]);
  if (!m.refMods) return [];
  const nodeClass = wf[resolveNode(wf, m.refMods, 'refMods')].class_type;
  const slotInput = (m.refMods.modInput || 'mod_{n}').replace('{n}', 1);
  const none = m.refMods.none ?? '(none)';
  return (await comfy.listComboOptions(nodeClass, slotInput)).filter((n) => n !== none);
}

/** Screen shapes the pod's resolution node offers (e.g. "16:9 (Widescreen)", "9:16 (Portrait Widescreen)"). */
export async function getAspectRatios() {
  const [wf, m] = await Promise.all([loadJson('workflow_api.json'), loadJson('mapping.json')]);
  if (!m.aspectRatio) return [];
  const nodeClass = wf[resolveNode(wf, m.aspectRatio, 'aspectRatio')].class_type;
  return comfy.listComboOptions(nodeClass, m.aspectRatio.input);
}
export const uploadFile = (file) => comfy.uploadFile(file);
export const cancel = (id) => comfy.cancel(id);

export async function generate(body) {
  const { prompt, negativePrompt, durationSec, aspectRatio, seed, loras = [], refMods = [], images = [], videos = [] } = body;
  if (!prompt || !String(prompt).trim()) throw new Error('Prompt is required');

  const [template, mapping] = await Promise.all([loadJson('workflow_api.json'), loadJson('mapping.json')]);
  const workflow = buildWorkflow(template, mapping, {
    prompt: String(prompt).trim(),
    negativePrompt,
    durationSec: Number(durationSec) || mapping.duration?.default,
    aspectRatio: aspectRatio || undefined,
    seed: seed === '' || seed == null ? undefined : Number(seed),
    loras: loras.map((l) => ({ name: l.name, strength: Number(l.strength ?? 1) })),
    refMods: refMods.map((r) => ({ name: r.name, strength: Number(r.strength ?? 1) })),
    images,
    videos,
  });

  const queued = await comfy.queuePrompt(workflow);
  return { promptId: queued.prompt_id };
}
