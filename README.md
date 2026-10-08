# Comfy Studio · MiniMax H3 RefMod

A minimal, mobile-friendly page for running the **MiniMax - RefMod** workflow on your RunPod ComfyUI: prompt, duration (4–15 s), screen shape (16:9, 9:16…), multiple LoRAs (with strength) and multiple RefMods (with strength).

There is **no server**. The page talks straight to your pod, so you can run it on your computer or host it anywhere that serves static files (Render, Netlify, GitHub Pages…).

## Daily use

1. Start your pod on RunPod (Hearmeman's `comfyui-minimax-template`).
2. When it shows **Ready**, copy the ComfyUI link (Connect → port 8188), e.g. `https://abc123xyz-8188.proxy.runpod.net`.
3. Open the app, tap the **⚙** gear, paste the link, **Save & connect**. The address is remembered in your browser; you only change it when you start a new pod.
4. Write the prompt, choose duration, add LoRAs / RefMods, **Generate**.

The prompt box starts filled with the prompt from the workflow, and **Reset to template** brings it back. The LoRA and RefMod lists are read live from the pod, so anything you add on the pod appears after you reconnect.

## Run it on your computer

Needs Node 18+.

```
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173). On your phone, use the `Network` address it prints, if you are on the same Wi‑Fi.

## Deploy on Render

1. Put this folder in a GitHub repo (`node_modules` is already ignored).
2. Render → **New → Static Site** → pick the repo.
3. Build command: `npm install && npm run build`
4. Publish directory: `dist`
5. Environment variable: `NODE_VERSION` = `22`

Every `git push` redeploys. Your pod address is stored in each browser, so it never ends up in the repo. Optional: set `VITE_COMFY_URL` at build time to pre-fill a default address.

## CORS (browser access to the pod)

The page calls the pod from the browser, so ComfyUI must be started with `--enable-cors-header`. The Hearmeman template already does this. If connecting fails even though the pod is Ready, check on the pod (web terminal):

```
grep -n enable-cors /comfyui-runtime/src/start.sh
```

Do not press **Save** in RunPod's *Edit Pod* dialog on a running pod: it resets the pod and wipes the container disk.

Extra ComfyUI flags can be given with the `COMFY_EXTRA_ARGS` environment variable (e.g. `--max-upload-size 500`; the default upload limit is 100 MB).

## How the workflow is wired

- `public/config/workflow_api.json`: the workflow exported with **Workflow → Export (API)**.
- `public/config/mapping.json`: says which node each control changes. Nodes are found by title or class (not just ID), so re-exporting the workflow after small edits keeps working.

| Control | Node | Input |
| --- | --- | --- |
| Prompt | "Your Prompt Here" | `value` |
| Duration | "Float (duration)" | `value` (seconds) |
| Screen shape | `ResolutionSelector` | `aspect_ratio` (options read live from the pod) |
| Seed | `RandomNoise` | `noise_seed` |
| LoRAs | `Power Lora Loader (rgthree)` | `lora_1…lora_8` |
| RefMods | `MiniMaxH3RefModsLoader` | `mod_n` / `strength_n` (8 slots) |

Unused RefMod slots are set to `(none)`. If no LoRA is chosen, the loader gets one disabled entry.

To use a different workflow: export it in API format, replace `workflow_api.json`, then run `npm run inspect` to list its nodes and get a suggested `mapping.json`.

## Troubleshooting

- **"Can't reach ComfyUI"**: pod not Ready yet, wrong link, or you pasted an old pod's link.
- **Red error on Generate**: the message names the node ComfyUI rejected (for example a missing model). Open the same workflow in ComfyUI to see it in context.
- **Empty RefMod list**: no RefMods saved on the pod yet.
