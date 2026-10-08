import React, { useEffect, useMemo, useRef, useState } from 'react';
import { viewUrl, downloadFile, saveSettings } from './api.js';

const label = (name) => name.split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|bin|refmod)$/i, '');

/* ----------------------------- Duration ----------------------------- */

export function Duration({ options, value, onChange }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Duration">
      {options.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          className={value === s ? 'on' : ''}
          onClick={() => onChange(s)}
        >
          {s}s
        </button>
      ))}
    </div>
  );
}

/* ---------------------------- Screen shape --------------------------- */

/** "16:9 (Widescreen)" -> ratio "16:9" + hint "Widescreen" */
const splitAspect = (name) => {
  const m = String(name).match(/^\s*([^(]+?)\s*(?:\((.*)\))?\s*$/);
  return { ratio: m?.[1] || name, hint: m?.[2] || '' };
};

export function AspectRatio({ options, value, onChange }) {
  return (
    <div className="seg wrap-seg" role="radiogroup" aria-label="Screen shape">
      {options.map((o) => {
        const { ratio, hint } = splitAspect(o);
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            className={value === o ? 'on' : ''}
            title={o}
            onClick={() => onChange(o)}
          >
            <b>{ratio}</b>
            {hint && <small>{hint}</small>}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ LoRAs ------------------------------- */

/** Multi-select list with a strength slider per item. Used for both LoRAs and RefMods. */
export function ChipPicker({ noun = 'LoRA', emptyText, available, selected, max, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const options = useMemo(() => {
    const taken = new Set(selected.map((s) => s.name));
    const needle = q.trim().toLowerCase();
    return available.filter((n) => !taken.has(n) && n.toLowerCase().includes(needle));
  }, [available, selected, q]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const add = (name) => {
    onChange([...selected, { name, strength: 1 }]);
    setQ('');
    setOpen(false); // one tap per LoRA; the chip shows up right above the button
  };
  const update = (name, strength) => onChange(selected.map((s) => (s.name === name ? { ...s, strength } : s)));
  const remove = (name) => onChange(selected.filter((s) => s.name !== name));

  return (
    <div className="lora">
      {selected.map((l) => (
        <div className="lora-row" key={l.name}>
          <span className="lora-name" title={l.name}>
            {label(l.name)}
          </span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={l.strength}
            onChange={(e) => update(l.name, Number(e.target.value))}
            aria-label={`${label(l.name)} strength`}
          />
          <span className="lora-val">{l.strength.toFixed(2)}</span>
          <button type="button" className="icon" onClick={() => remove(l.name)} aria-label={`Remove ${noun}`}>
            ×
          </button>
        </div>
      ))}

      {selected.length < max && (
        <div className="lora-add">
          <button type="button" className="ghost" onClick={() => setOpen((o) => !o)}>
            + Add {noun}
          </button>
          {open && (
            <>
              <div className="scrim" onClick={() => setOpen(false)} />
              <div className="pop">
                <input
                  autoFocus
                  placeholder={available.length ? `Search ${noun}s…` : emptyText || `No ${noun}s found on the pod`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <ul>
                  {options.slice(0, 60).map((n) => (
                    <li key={n}>
                      <button type="button" onClick={() => add(n)}>
                        {label(n)}
                      </button>
                    </li>
                  ))}
                  {!options.length && <li className="empty">Nothing matches</li>}
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------- Reference uploads ------------------------- */

export function RefDrop({ refs, maxImages, maxVideos, onAdd, onRemove }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const images = refs.filter((r) => r.kind === 'image').length;
  const videos = refs.filter((r) => r.kind === 'video').length;

  const take = (fileList) => {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    onAdd(files);
  };

  const hint = [maxImages ? `${images}/${maxImages} images` : null, maxVideos ? `${videos}/${maxVideos} videos` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div>
      <div
        className={`drop ${over ? 'over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' ? input.current?.click() : null)}
      >
        <span>Drop images or videos, or tap to browse</span>
        <small>{hint}</small>
        <input
          ref={input}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {refs.length > 0 && (
        <div className="thumbs">
          {refs.map((r) => (
            <div className={`thumb ${r.status}`} key={r.id}>
              {r.kind === 'image' ? <img src={r.preview} alt="" /> : <video src={r.preview} muted playsInline />}
              {r.status === 'uploading' && <div className="spin" />}
              {r.status === 'error' && <div className="err" title={r.error}>!</div>}
              <button type="button" className="x" onClick={() => onRemove(r.id)} aria-label="Remove reference">
                ×
              </button>
              <span className="badge">{r.kind === 'video' ? 'VID' : 'IMG'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Result ------------------------------ */

export function Result({ item }) {
  const video = item.outputs.find((o) => o.kind === 'video');
  const image = !video && item.outputs.find((o) => o.kind === 'image');
  const main = video || image;
  if (!main) return null;

  return (
    <section className="result">
      {video ? (
        <video src={viewUrl(video)} controls autoPlay loop playsInline />
      ) : (
        <img src={viewUrl(image)} alt="Result" />
      )}
      <div className="result-bar">
        <p title={item.prompt}>{item.prompt}</p>
        <button type="button" className="ghost" onClick={() => downloadFile(main)}>
          Download
        </button>
      </div>
    </section>
  );
}

/* ----------------------------- Settings ----------------------------- */

export function Settings({ initialUrl, onClose, onSaved }) {
  const [url, setUrl] = useState(initialUrl || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      /* clipboard blocked by the browser: paste into the field by hand */
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      onSaved(await saveSettings(url));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="ComfyUI address">
      <div className="scrim dim" onClick={onClose} />
      <form className="sheet" onSubmit={save}>
        <h2>ComfyUI address</h2>
        <p className="muted small">
          Paste the URL of your pod’s ComfyUI. On RunPod it looks like <code>https://abc123xyz-8188.proxy.runpod.net</code>. It’s saved, so you only change it when you start a new pod.
        </p>
        <div className="row">
          <input
            className="text"
            autoFocus
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://…-8188.proxy.runpod.net"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" className="ghost" onClick={paste}>
            Paste
          </button>
        </div>
        {error && <p className="banner error">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="go slim" disabled={!url.trim() || busy}>
            {busy ? 'Connecting…' : 'Save & connect'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function History({ items, activeId, onPick }) {
  if (!items.length) return null;
  return (
    <section className="history">
      <h3>Recent</h3>
      <div className="strip">
        {items.map((h) => {
          const v = h.outputs.find((o) => o.kind === 'video');
          const img = h.outputs.find((o) => o.kind === 'image');
          return (
            <button key={h.id} type="button" className={h.id === activeId ? 'on' : ''} onClick={() => onPick(h)} title={h.prompt}>
              {v ? <video src={viewUrl(v)} muted preload="metadata" /> : img ? <img src={viewUrl(img)} alt="" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
