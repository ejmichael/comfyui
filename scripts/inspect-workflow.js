// Lists every node in public/config/workflow_api.json and suggests mapping.json values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const configDir = process.env.CONFIG_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'config');
const file = path.join(configDir, 'workflow_api.json');
const wf = JSON.parse(readFileSync(file, 'utf8'));
const ids = Object.keys(wf);

if (!ids.length) {
  console.log('workflow_api.json is empty. Export from ComfyUI with "Export (API)" and paste it into public/config/workflow_api.json');
  process.exit(0);
}

const short = (v) => (typeof v === 'string' ? (v.length > 50 ? v.slice(0, 47) + '...' : v) : JSON.stringify(v));

console.log(`\n${ids.length} nodes\n`);
for (const id of ids) {
  const n = wf[id];
  const title = n._meta?.title ? `  "${n._meta.title}"` : '';
  console.log(`[${id}] ${n.class_type}${title}`);
  for (const [k, v] of Object.entries(n.inputs || {})) {
    if (Array.isArray(v)) continue; // links to other nodes
    console.log(`      ${k}: ${short(v)}`);
  }
}

const by = (re) => ids.filter((id) => re.test(wf[id].class_type) || re.test(wf[id]._meta?.title || ''));
const lines = [];
const list = (label, found) => lines.push(`${label.padEnd(18)} ${found.length ? found.join(', ') : '(none found)'}`);

list('Text encoders', by(/text.*encode|prompt/i));
list('Seed / sampler', by(/sampler|seed|noise/i));
list('LoRA loaders', by(/lora/i));
list('Image loaders', by(/load.?image/i));
list('Video loaders', by(/load.?video|vhs_loadvideo/i));
list('Length / frames', ids.filter((id) => 'length' in (wf[id].inputs || {}) || 'frames' in (wf[id].inputs || {}) || 'num_frames' in (wf[id].inputs || {})));
list('Video outputs', by(/video.?combine|save.?video|vhs_videocombine|save.?animated/i));

console.log('\n--- Suggested candidates (verify in the list above) ---');
console.log(lines.join('\n'));
console.log('\nNext: copy the right IDs / input names into public/config/mapping.json\n');
