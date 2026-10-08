// Turns the exported API-format workflow + mapping.json + the user's choices into the final prompt graph.

function bad(message) {
  return new Error(message);
}

const PLACEHOLDER = 'REPLACE_ME';

/**
 * A mapping target points at a node either by ID ({ "node": "173" }) or, more robustly, by what it is
 * ({ "find": { "class_type": "RandomNoise" } } or { "find": { "title": "Your Prompt Here" } }).
 * Selectors keep working if the template renumbers its nodes in a later version.
 */
export function resolveNode(wf, target, label) {
  if (!target) throw bad(`mapping.json: "${label}" is missing.`);

  if (target.find) {
    const { class_type: type, title } = target.find;
    const ids = Object.keys(wf).filter(
      (id) => (!type || wf[id].class_type === type) && (!title || wf[id]._meta?.title === title)
    );
    if (ids.length === 1) return ids[0];
    throw bad(
      ids.length
        ? `mapping.json: "${label}" matches ${ids.length} nodes (${ids.join(', ')}). Make the selector more specific or use a node ID.`
        : `mapping.json: no node matches ${JSON.stringify(target.find)} for "${label}". The workflow may have changed.`
    );
  }

  if (!target.node || target.node === PLACEHOLDER) {
    throw bad(`mapping.json: "${label}" still has node "${PLACEHOLDER}". Run "npm run inspect" to find the right node ID.`);
  }
  if (!wf[target.node]) throw bad(`mapping.json: node "${target.node}" (${label}) does not exist in workflow_api.json.`);
  return String(target.node);
}

function setInput(wf, target, value, label) {
  const id = resolveNode(wf, target, label);
  wf[id].inputs = wf[id].inputs || {};
  wf[id].inputs[target.input] = value;
}

const isConfigured = (slot) => slot && (slot.find || (slot.node && slot.node !== PLACEHOLDER));

/** Fill slots in order with the given values; unused slots are neutralised. */
function fillSlots(wf, slots, values, label, setUsed, setUnused) {
  const usable = (slots || []).filter(isConfigured);
  if (values.length > usable.length) {
    throw bad(`You selected ${values.length} ${label} but the workflow only has ${usable.length} slot(s). Add more slots in mapping.json.`);
  }
  usable.forEach((slot, i) => {
    const id = resolveNode(wf, slot, label);
    if (i < values.length) setUsed(slot, values[i], id);
    else setUnused?.(slot, id);
  });
}

/**
 * input: { prompt, negativePrompt, durationSec, seed, loras:[{name,strength}], refMods:[{name,strength}],
 *          images:[name], videos:[name] }
 */
export function buildWorkflow(template, mapping, input) {
  if (!template || !Object.keys(template).length) {
    throw bad('public/config/workflow_api.json is empty. Export your workflow from ComfyUI with "Export (API)" and paste it there.');
  }
  const wf = structuredClone(template);
  const loras = input.loras || [];
  const refMods = input.refMods || [];

  setInput(wf, mapping.prompt, input.prompt, 'prompt');
  if (mapping.negativePrompt && input.negativePrompt !== undefined) {
    setInput(wf, mapping.negativePrompt, input.negativePrompt, 'negativePrompt');
  }

  if (mapping.seed) {
    const seed = Number.isFinite(input.seed) ? input.seed : Math.floor(Math.random() * 2 ** 48);
    setInput(wf, mapping.seed, seed, 'seed');
  }

  if (mapping.duration && input.durationSec) {
    const d = mapping.duration;
    const value =
      d.unit === 'frames' ? Math.round(input.durationSec * (d.fps || 24)) + (d.frameOffset ?? 0) : input.durationSec;
    setInput(wf, d, value, 'duration');
  }

  if (mapping.aspectRatio && input.aspectRatio) {
    setInput(wf, mapping.aspectRatio, input.aspectRatio, 'aspectRatio');
  }

  /* LoRAs: one "Power Lora Loader (rgthree)" node holding lora_1, lora_2, ... */
  if (mapping.powerLora) {
    const p = mapping.powerLora;
    const inputs = wf[resolveNode(wf, p, 'powerLora')].inputs;
    const max = p.max ?? 8;
    if (loras.length > max) throw bad(`Maximum ${max} LoRAs.`);
    const original = inputs.lora_1;
    for (const key of Object.keys(inputs)) if (/^lora_\d+$/.test(key)) delete inputs[key];
    if (loras.length) {
      loras.forEach((l, i) => {
        inputs[`lora_${i + 1}`] = { on: true, lora: l.name, strength: l.strength };
      });
    } else if (original) {
      inputs.lora_1 = { ...original, on: false }; // no LoRA chosen: leave the template's switched-off placeholder
    }
  }

  /* LoRAs: one separate loader node per LoRA (other workflows) */
  if (mapping.loras) {
    const max = mapping.loras.max ?? mapping.loras.slots.length;
    if (loras.length > max) throw bad(`Maximum ${max} LoRAs.`);
    fillSlots(
      wf,
      mapping.loras.slots,
      loras,
      'LoRAs',
      (slot, l, id) => {
        wf[id].inputs[slot.nameInput || 'lora_name'] = l.name;
        wf[id].inputs[slot.strengthInput || 'strength_model'] = l.strength;
        if (slot.clipStrengthInput) wf[id].inputs[slot.clipStrengthInput] = l.strength;
      },
      (slot, id) => {
        // Unused slot: zero strength = no effect, keeps the graph wiring intact.
        wf[id].inputs[slot.strengthInput || 'strength_model'] = 0;
        if (slot.clipStrengthInput) wf[id].inputs[slot.clipStrengthInput] = 0;
      }
    );
  }

  /* RefMods: one loader node with numbered slots (mod_1/strength_1, mod_2/strength_2, ...) */
  if (mapping.refMods) {
    const r = mapping.refMods;
    const inputs = wf[resolveNode(wf, r, 'refMods')].inputs;
    const slots = r.slots ?? 8;
    if (refMods.length > slots) throw bad(`Maximum ${slots} RefMods.`);
    const key = (template, n) => template.replace('{n}', n);
    for (let n = 1; n <= slots; n++) {
      const chosen = refMods[n - 1];
      inputs[key(r.modInput || 'mod_{n}', n)] = chosen ? chosen.name : r.none ?? '(none)';
      if (chosen) {
        inputs[key(r.strengthInput || 'strength_{n}', n)] = chosen.strength;
        if (r.copiesInput && chosen.copies != null) inputs[key(r.copiesInput, n)] = chosen.copies;
      }
    }
  }

  /* Uploaded reference files (image / video loader nodes) */
  const refs = [
    ['referenceImages', input.images || [], 'reference images'],
    ['referenceVideos', input.videos || [], 'reference videos'],
  ];
  for (const [mapKey, files, label] of refs) {
    if (!mapping[mapKey]) {
      if (files.length) throw bad(`This workflow has no ${label} inputs configured.`);
      continue;
    }
    fillSlots(
      wf,
      mapping[mapKey].slots,
      files,
      label,
      (slot, file, id) => {
        wf[id].inputs[slot.input] = file;
        if (slot.enabledInput) wf[id].inputs[slot.enabledInput] = true;
      },
      (slot, id) => {
        if (slot.enabledInput) wf[id].inputs[slot.enabledInput] = false;
      }
    );
  }

  return wf;
}
