import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import { uuid } from './lib/comfy.js';
import { Duration, AspectRatio, ChipPicker, RefDrop, Result, History, Settings } from './components.jsx';

const HISTORY_KEY = 'comfy_studio_history';

const loadHistory = () => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
};
const saveHistory = (items) => {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 24)));
  } catch {
    /* storage unavailable */
  }
};

export default function App() {
  const [config, setConfig] = useState(null);
  const [loras, setLoras] = useState([]);
  const [refmodList, setRefmodList] = useState([]);
  const [aspectList, setAspectList] = useState([]);
  const [aspect, setAspect] = useState('');
  const [online, setOnline] = useState(null);
  const [bootError, setBootError] = useState('');

  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [seed, setSeed] = useState('');
  const [duration, setDuration] = useState(5);
  const [selectedLoras, setSelectedLoras] = useState([]);
  const [selectedRefMods, setSelectedRefMods] = useState([]);
  const [refs, setRefs] = useState([]);

  const [job, setJob] = useState({ status: 'idle', progress: null, id: null, error: '' });
  const [history, setHistory] = useState(loadHistory);
  const [active, setActive] = useState(null);
  const stop = useRef(null);

  const [comfyUrl, setComfyUrl] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  /* Check the ComfyUI connection and (re)load the LoRA and RefMod lists. */
  const refreshConnection = useCallback(async () => {
    try {
      await api.getHealth();
      setOnline(true);
    } catch {
      setOnline(false);
      return;
    }
    api.getLoras().then(setLoras).catch(() => setLoras([]));
    api.getRefMods().then(setRefmodList).catch(() => setRefmodList([]));
    api.getAspectRatios().then(setAspectList).catch(() => setAspectList([]));
  }, []);

  const onSaved = (s) => {
    setComfyUrl(s.comfyUrl);
    setShowSettings(false);
    setOnline(null);
    refreshConnection();
  };

  /* ---- boot ---- */
  useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setConfig(c);
        setDuration(c.duration.default);
        setAspect(c.defaultAspectRatio);
        setPrompt((p) => p || c.defaultPrompt || '');
      })
      .catch((e) => setBootError(e.message));
    api
      .getSettings()
      .then((s) => {
        setComfyUrl(s.comfyUrl);
        if (!s.comfyUrl) setShowSettings(true); // first run: ask for the pod address straight away
      })
      .catch(() => {});
    refreshConnection();
    return () => stop.current?.();
  }, [refreshConnection]);

  /* ---- references ---- */
  const addRefs = useCallback(
    (files) => {
      const next = files.map((file) => ({
        id: uuid(),
        file,
        kind: file.type.startsWith('video/') ? 'video' : 'image',
        preview: URL.createObjectURL(file),
        status: 'uploading',
        serverName: null,
        error: '',
      }));
      setRefs((cur) => {
        const out = [...cur];
        for (const r of next) {
          const limit = r.kind === 'video' ? config?.maxVideos : config?.maxImages;
          if (out.filter((x) => x.kind === r.kind).length < (limit || 0)) out.push(r);
        }
        return out;
      });
      next.forEach(async (r) => {
        try {
          const res = await api.uploadFile(r.file);
          const name = res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
          setRefs((cur) => cur.map((x) => (x.id === r.id ? { ...x, status: 'ready', serverName: name } : x)));
        } catch (e) {
          setRefs((cur) => cur.map((x) => (x.id === r.id ? { ...x, status: 'error', error: e.message } : x)));
        }
      });
    },
    [config]
  );
  const removeRef = (id) => setRefs((cur) => cur.filter((r) => r.id !== id));

  /* ---- generate ---- */
  const busy = job.status === 'queued' || job.status === 'running';
  const uploading = refs.some((r) => r.status === 'uploading');
  const canGo = prompt.trim() && !busy && !uploading && config;

  const finish = (id, outputs) => {
    const item = { id, prompt: prompt.trim(), outputs, ts: Date.now() };
    setActive(item);
    setHistory((h) => {
      const next = [item, ...h.filter((x) => x.id !== id)];
      saveHistory(next);
      return next;
    });
  };

  const run = async () => {
    setJob({ status: 'queued', progress: null, id: null, error: '' });
    try {
      const { promptId } = await api.generate({
        prompt,
        negativePrompt: config.hasNegativePrompt ? negative : undefined,
        durationSec: duration,
        aspectRatio: aspect,
        seed: seed === '' ? undefined : Number(seed),
        loras: selectedLoras,
        refMods: selectedRefMods,
        images: refs.filter((r) => r.kind === 'image' && r.status === 'ready').map((r) => r.serverName),
        videos: refs.filter((r) => r.kind === 'video' && r.status === 'ready').map((r) => r.serverName),
      });
      setJob({ status: 'queued', progress: null, id: promptId, error: '' });

      stop.current?.();
      stop.current = api.subscribe(promptId, (evt) => {
        if (evt.type === 'running' || evt.type === 'node') {
          setJob((j) => ({ ...j, status: 'running' }));
        } else if (evt.type === 'progress') {
          setJob((j) => ({ ...j, status: 'running', progress: evt.max ? evt.value / evt.max : null }));
        } else if (evt.type === 'done') {
          stop.current?.();
          setJob({ status: 'idle', progress: null, id: null, error: '' });
          finish(promptId, evt.outputs);
        } else if (evt.type === 'error') {
          stop.current?.();
          setJob({ status: 'error', progress: null, id: null, error: evt.message });
        }
      });
    } catch (e) {
      setJob({ status: 'error', progress: null, id: null, error: e.message });
    }
  };

  const cancel = async () => {
    if (job.id) await api.cancel(job.id).catch(() => {});
    stop.current?.();
    setJob({ status: 'idle', progress: null, id: null, error: '' });
  };

  /* ---- render ---- */
  if (bootError) {
    return (
      <main className="wrap">
        <p className="banner error">Couldn’t reach the server: {bootError}</p>
      </main>
    );
  }
  if (!config) return <main className="wrap"><p className="muted">Loading…</p></main>;

  const pct = job.progress != null ? Math.round(job.progress * 100) : null;

  return (
    <main className="wrap">
      <header>
        <h1>{config.title}</h1>
        <span className={`dot ${online === null ? '' : online ? 'ok' : 'bad'}`} title={online ? 'ComfyUI connected' : online === false ? 'ComfyUI unreachable' : 'Checking…'} />
        <button type="button" className="icon gear" onClick={() => setShowSettings(true)} aria-label="ComfyUI address" title={comfyUrl || 'ComfyUI address'}>
          ⚙
        </button>
      </header>

      {online === false && comfyUrl && (
        <p className="banner error">
          ComfyUI isn’t reachable. Is your pod running?{' '}
          <button type="button" className="link" onClick={() => setShowSettings(true)}>
            Update address
          </button>
        </p>
      )}

      {showSettings && <Settings initialUrl={comfyUrl} onClose={() => setShowSettings(false)} onSaved={onSaved} />}

      <section className="card">
        <div className="field">
          <label className="label-row">
            Prompt
            {config.defaultPrompt && prompt !== config.defaultPrompt && (
              <button type="button" className="link" onClick={() => setPrompt(config.defaultPrompt)}>
                Reset to template
              </button>
            )}
          </label>
          <textarea
            rows={8}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the video you want…"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canGo) run();
            }}
          />
        </div>

        <div className="field">
          <label>Duration</label>
          <Duration options={config.duration.options} value={duration} onChange={setDuration} />
        </div>

        {config.hasAspectRatio && (
          <div className="field">
            <label>Screen shape</label>
            <AspectRatio
              options={aspectList.includes(aspect) || !aspect ? aspectList : [aspect, ...aspectList]}
              value={aspect}
              onChange={setAspect}
            />
          </div>
        )}

        {config.maxLoras > 0 && (
          <div className="field">
            <label>LoRAs</label>
            <ChipPicker noun="LoRA" available={loras} selected={selectedLoras} max={config.maxLoras} onChange={setSelectedLoras} />
          </div>
        )}

        {config.maxRefMods > 0 && (
          <div className="field">
            <label>RefMods</label>
            <ChipPicker
              noun="RefMod"
              emptyText="No RefMods saved on the pod yet"
              available={refmodList}
              selected={selectedRefMods}
              max={config.maxRefMods}
              onChange={setSelectedRefMods}
            />
          </div>
        )}

        {(config.maxImages > 0 || config.maxVideos > 0) && (
          <div className="field">
            <label>References</label>
            <RefDrop refs={refs} maxImages={config.maxImages} maxVideos={config.maxVideos} onAdd={addRefs} onRemove={removeRef} />
          </div>
        )}

        <details className="adv">
          <summary>Advanced</summary>
          {config.hasNegativePrompt && (
            <div className="field">
              <label>Negative prompt</label>
              <textarea rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="What to avoid…" />
            </div>
          )}
          <div className="field">
            <label>Seed</label>
            <input className="text" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} placeholder="Random" />
          </div>
        </details>
      </section>

      {job.status === 'error' && <p className="banner error">{job.error}</p>}

      <div className="actions">
        {busy ? (
          <>
            <div className="bar" role="progressbar" aria-valuenow={pct ?? undefined}>
              <i style={{ width: pct != null ? `${pct}%` : '35%' }} className={pct == null ? 'indet' : ''} />
            </div>
            <span className="status">{job.status === 'queued' ? 'In queue…' : pct != null ? `Generating ${pct}%` : 'Generating…'}</span>
            <button type="button" className="ghost" onClick={cancel}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="go" disabled={!canGo} onClick={run}>
            {uploading ? 'Uploading references…' : 'Generate'}
          </button>
        )}
      </div>

      {active && <Result item={active} />}
      <History items={history} activeId={active?.id} onPick={setActive} />
    </main>
  );
}
