/* Edivora — audio editor: multitrack timeline, cut / copy / paste / trim / split, clip gain and fades,
 * recording, effects (amplify, normalize, fades, EQ, filters, noise reduction, speed, tempo, pitch,
 * echo, reverb, compressor, vocal remover, silence removal…), tone and noise generators, WAV and MP3 export.
 */
'use strict';
(function () {
  const $ = PE.$,
    h = PE.h,
    icon = PE.icon;
  const A = (PE.aud = { name: 'audio', label: 'Audio', ext: '.mp3', accepts: ['audio', 'video'], dropText: 'Drop audio (or video) to add it as a new track' });
  PE.mm.register(A);

  const B = new Map(); // buffer id -> AudioBuffer (never changed; edits make new buffers)
  let P = null; // project { tracks: [...], master }
  let sel = { tracks: [], t0: 0, t1: 0, clip: null };
  let ph = 0; // playhead (seconds)
  let pps = 60; // pixels per second
  let scrollX = 0,
    scrollY = 0;
  let els = null,
    tool = 'select',
    snap = true,
    loop = false,
    panelTab = 'edit';
  let clipboard = null;
  const COLORS = ['#3b6cf6', '#e0533d', '#17a673', '#c27c0e', '#9b4dd8', '#d8418f', '#1597b5', '#6b7a8f'];
  const RULER = 26;
  const TH = () => (window.innerWidth < 860 ? 78 : 96);
  const EPS = 1e-6;
  let bufSeq = 1,
    idSeq = 1;
  const nid = (p) => p + Date.now().toString(36) + (idSeq++).toString(36);
  const rate = () => PE.audioCtx().sampleRate;
  const dB = (g) => 20 * Math.log10(Math.max(1e-6, g));
  const fromDb = (d) => Math.pow(10, d / 20);

  function addBuffer(buf) {
    const id = 'a' + bufSeq++;
    B.set(id, buf);
    return id;
  }

  /* =========================================================
   *  history
   * ========================================================= */
  const H = { stack: [], idx: -1 };
  function commit() {
    const snap = JSON.stringify(P);
    if (H.stack[H.idx] === snap) return;
    H.stack.length = H.idx + 1;
    H.stack.push(snap);
    if (H.stack.length > 80) H.stack.shift();
    H.idx = H.stack.length - 1;
    PE.app.dirty = true;
    gc();
    PE.ui.updateHistoryButtons();
  }
  function gc() {
    const keep = new Set();
    for (const s of H.stack) for (const m of s.matchAll(/"buf":"(a\d+)"/g)) keep.add(m[1]);
    if (clipboard) for (const t of clipboard.tracks) for (const c of t) keep.add(c.buf);
    for (const id of [...B.keys()]) if (!keep.has(id)) B.delete(id);
  }
  function restore(i) {
    stop();
    H.idx = i;
    P = JSON.parse(H.stack[i]);
    sel.tracks = sel.tracks.filter((id) => P.tracks.some((t) => t.id === id));
    if (sel.clip && !findClip(sel.clip)) sel.clip = null;
    refreshAll();
    PE.ui.updateHistoryButtons();
  }
  A.undo = () => H.idx > 0 && restore(H.idx - 1);
  A.redo = () => H.idx < H.stack.length - 1 && restore(H.idx + 1);
  A.canUndo = () => H.idx > 0;
  A.canRedo = () => H.idx < H.stack.length - 1;

  /* =========================================================
   *  model helpers
   * ========================================================= */
  const trackOf = (id) => P.tracks.find((t) => t.id === id);
  function findClip(id) {
    for (const t of P.tracks) for (const c of t.clips) if (c.id === id) return { t, c };
    return null;
  }
  const clipEnd = (c) => c.start + c.len;
  function duration() {
    let d = 0;
    for (const t of P.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
    return d;
  }
  const hasRange = () => sel.t1 - sel.t0 > 0.0005;
  function selTracks() {
    let ts = P.tracks.filter((t) => sel.tracks.includes(t.id));
    if (!ts.length && sel.clip) {
      const f = findClip(sel.clip);
      if (f) ts = [f.t];
    }
    return ts;
  }
  function newTrack(name) {
    const t = { id: nid('t'), name: name || 'Track ' + (P.tracks.length + 1), vol: 1, pan: 0, mute: false, solo: false, color: COLORS[P.tracks.length % COLORS.length], clips: [] };
    P.tracks.push(t);
    return t;
  }
  function addClip(t, bufId, start, name) {
    const buf = B.get(bufId);
    const c = { id: nid('c'), buf: bufId, off: 0, len: buf.duration, start: Math.max(0, start), gain: 1, fi: 0, fo: 0, name: name || '' };
    t.clips.push(c);
    t.clips.sort((a, b) => a.start - b.start);
    return c;
  }
  function fixFades(c) {
    c.fi = PE.clamp(c.fi || 0, 0, c.len);
    c.fo = PE.clamp(c.fo || 0, 0, c.len);
    if (c.fi + c.fo > c.len) {
      const k = c.len / (c.fi + c.fo);
      c.fi *= k;
      c.fo *= k;
    }
  }
  /** split a clip at a time; returns the right part */
  function splitClip(t, c, at) {
    if (at <= c.start + 0.0005 || at >= clipEnd(c) - 0.0005) return null;
    const c2 = Object.assign({}, c, { id: nid('c'), off: c.off + (at - c.start), len: clipEnd(c) - at, start: at, fi: 0 });
    c.len = at - c.start;
    c.fo = 0;
    fixFades(c);
    fixFades(c2);
    t.clips.splice(t.clips.indexOf(c) + 1, 0, c2);
    return c2;
  }
  function splitAt(t, at) {
    for (const c of t.clips.slice()) if (at > c.start && at < clipEnd(c)) splitClip(t, c, at);
  }
  /** clips of a track inside [t0, t1], split at the edges */
  function piecesIn(t, t0, t1) {
    splitAt(t, t0);
    splitAt(t, t1);
    return t.clips.filter((c) => c.start >= t0 - 0.0006 && clipEnd(c) <= t1 + 0.0006);
  }
  function removeRange(t, t0, t1, ripple) {
    const gone = piecesIn(t, t0, t1);
    t.clips = t.clips.filter((c) => !gone.includes(c));
    if (ripple) for (const c of t.clips) if (c.start >= t1 - 0.0006) c.start = Math.max(0, c.start - (t1 - t0));
  }
  /** samples of part of a buffer as a new AudioBuffer */
  function slice(buf, off, len) {
    const r = buf.sampleRate;
    const a = Math.max(0, Math.round(off * r)),
      n = Math.max(1, Math.min(buf.length - a, Math.round(len * r)));
    const out = PE.newBuffer(buf.numberOfChannels, n, r);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) out.getChannelData(ch).set(buf.getChannelData(ch).subarray(a, a + n));
    return out;
  }

  /* =========================================================
   *  open / close
   * ========================================================= */
  A.open = async function (files, o = {}) {
    build();
    A.active = true;
    document.body.classList.add('mode-audio');
    P = { tracks: [], master: 1 };
    sel = { tracks: [], t0: 0, t1: 0, clip: null };
    ph = 0;
    scrollX = scrollY = 0;
    B.clear();
    H.stack = [];
    H.idx = -1;
    await PE.raf();
    if (files.length) {
      await importFiles(files, 0, true);
      PE.app.setFileName(files[0].name.replace(/\.[^.]+$/, '') + '.mp3');
    }
    commit();
    PE.app.dirty = false;
    refreshAll();
    zoomFit();
    if (o.record) setTimeout(() => record(), 200);
  };
  A.close = function () {
    stop();
    stopRecording(true);
    A.active = false;
    document.body.classList.remove('mode-audio');
    P = null;
    B.clear();
    H.stack = [];
    H.idx = -1;
  };
  A.addFiles = async function (files) {
    await importFiles(files, ph, false);
    commit();
    refreshAll();
  };
  async function importFiles(files, at, first) {
    let i = 0;
    for (const f of files) {
      if (!/^(audio|video)$/.test(PE.kindOf(f))) continue;
      PE.ui.busy(true, 'Reading ' + f.name, 0.2 + (0.7 * i++) / files.length);
      let buf;
      try {
        buf = await PE.decodeAudio(await PE.readFile(f));
      } catch (e) {
        PE.ui.busy(false);
        PE.toast(`“${f.name}” has no sound this browser can read.`, 'error', 6000);
        continue;
      }
      const name = f.name.replace(/\.[^.]+$/, '');
      const t = newTrack(name);
      addClip(t, addBuffer(buf), first ? 0 : at, name);
      sel.tracks = [t.id];
    }
    PE.ui.busy(false);
  }

  /* =========================================================
   *  DOM
   * ========================================================= */
  function build() {
    if (els) return;
    const view = $('#aud-view');
    const bar = h('div', { class: 'abar', role: 'toolbar', 'aria-label': 'Transport' });
    const tb = (id, ic, title, fn, cls) => h('button', { class: 'icon-btn ' + (cls || ''), 'data-a': id, title, 'aria-label': title, html: icon(ic), onclick: fn });
    const time = h('div', { class: 'atime', title: 'Playhead / length' }, [h('b', {}, '0:00.000'), h('span', {}, '/ 0:00.000')]);
    const meter = h('canvas', { class: 'ameter', width: 90, height: 14, 'aria-hidden': 'true' });
    const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: 1, class: 'avol', 'aria-label': 'Master volume', title: 'Master volume' });
    vol.addEventListener('input', () => {
      P.master = +vol.value;
      if (PB.master) PB.master.gain.value = P.master;
    });
    bar.append(
      h('div', { class: 'agrp' }, [tb('start', 'skip-back', 'Go to start (Home)', () => seek(0)), tb('play', 'play', 'Play / pause (Space)', togglePlay, 'aplay'), tb('stop', 'stop', 'Stop', () => (stop(), seek(sel.t1 > sel.t0 ? sel.t0 : ph))), tb('rec', 'record', 'Record (R)', () => (rec ? stopRecording() : record()), 'arec'), tb('end', 'skip-fwd', 'Go to end (End)', () => seek(duration()))]),
      time,
      h('div', { class: 'agrp' }, [tb('loop', 'loop', 'Loop the selection (L)', () => ((loop = !loop), syncBar())), tb('snap', 'magnet', 'Snap to clips and playhead', () => ((snap = !snap), syncBar())), tb('select', 'text', 'Select a range (drag across the waveform)', () => setTool('select')), tb('move', 'move', 'Move clips (drag anywhere on a clip)', () => setTool('move'))]),
      h('div', { class: 'agrp hide-narrow' }, [tb('split', 'split', 'Split at the playhead (S)', splitHere), tb('cut', 'scissors', 'Cut (Ctrl+X)', cut), tb('copy', 'copy', 'Copy (Ctrl+C)', copy), tb('paste', 'file-plus', 'Paste at the playhead (Ctrl+V)', paste), tb('del', 'trash', 'Delete (Del)', del)]),
      h('div', { class: 'agrp aright' }, [h('span', { class: 'hide-narrow', html: icon('volume') }), vol, meter])
    );
    const heads = h('div', { class: 'aheads' });
    const headsIn = h('div', { class: 'aheads-in' });
    heads.append(h('div', { class: 'aheads-top', style: { height: RULER + 'px' } }), headsIn);
    const lanes = h('div', { class: 'alanes', tabindex: '-1' });
    const cv = h('canvas', { class: 'acv' });
    const empty = h('div', { class: 'aempty' }, [
      h('div', { html: icon('wave', 'xl') }),
      h('strong', {}, 'Add some sound'),
      h('span', {}, 'Drop audio or video files here, record from your microphone, or generate a tone.'),
      h('div', { class: 'mbtns' }, [btn('Add audio…', 'upload', importPicker, 'primary'), btn('Record', 'mic', () => record()), btn('Generate', 'wave', () => ((panelTab = 'gen'), refreshPanel()))]),
    ]);
    lanes.append(cv, empty);
    const hs = h('div', { class: 'ahscroll' }, [h('div', { class: 'ahscroll-in' })]);
    const tl = h('div', { class: 'atl' }, [heads, h('div', { class: 'alanes-col' }, [lanes, hs])]);
    const col = h('div', { class: 'acol' }, [bar, tl]);
    const panel = h('aside', { class: 'mpanel', 'aria-label': 'Audio settings' });
    const tabs = h('div', { class: 'mtabs', role: 'tablist' });
    for (const [k, l] of [
      ['edit', 'Edit'],
      ['fx', 'Effects'],
      ['gen', 'Generate'],
    ])
      tabs.appendChild(h('button', { role: 'tab', 'data-tab': k, onclick: () => ((panelTab = k), refreshPanel()) }, l));
    const body = h('div', { class: 'mpanel-body' });
    panel.append(h('button', { class: 'sheet-handle only-narrow', 'aria-label': 'Collapse panel', html: '<i></i>', onclick: () => (document.body.classList.toggle('mpanel-min'), setTimeout(resize, 50)) }), tabs, body);
    view.append(col, panel);
    els = { view, bar, time, meter, vol, heads, headsIn, lanes, cv, empty, hs, panel, tabs, body };
    hs.addEventListener('scroll', () => {
      if (hs._lock) return;
      scrollX = hs.scrollLeft;
      draw();
    });
    lanes.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    lanes.addEventListener('wheel', onWheel, { passive: false });
    lanes.addEventListener('dblclick', onDbl);
    new ResizeObserver(() => A.active && resize()).observe(lanes);
    window.addEventListener('resize', () => A.active && resize());
  }
  function btn(label, ic, fn, cls) {
    return h('button', { class: 'btn ' + (cls || ''), type: 'button', html: (ic ? icon(ic) : '') + '<span>' + PE.esc(label) + '</span>', onclick: fn });
  }
  function setTool(t) {
    tool = t;
    syncBar();
  }
  function syncBar() {
    if (!els) return;
    const on = (k, v) => {
      const b = els.bar.querySelector(`[data-a="${k}"]`);
      if (b) {
        b.classList.toggle('on', !!v);
        b.setAttribute('aria-pressed', v ? 'true' : 'false');
      }
    };
    on('loop', loop);
    on('snap', snap);
    on('select', tool === 'select');
    on('move', tool === 'move');
    on('rec', !!rec);
    els.bar.querySelector('[data-a="play"]').innerHTML = icon(PB.playing ? 'pause' : 'play');
    els.lanes.setAttribute('data-tool', tool);
  }
  function refreshAll() {
    if (!els || !P) return;
    els.empty.hidden = P.tracks.length > 0 || !!rec;
    refreshHeads();
    refreshPanel();
    syncBar();
    resize();
    if (!PB.playing && !rec) meterClear();
  }
  A.refresh = refreshAll;

  /* ---------- track headers ---------- */
  function refreshHeads() {
    const host = els.headsIn;
    host.innerHTML = '';
    const th = TH();
    for (const t of P.tracks) {
      const vol = h('input', { type: 'range', min: 0, max: 2, step: 0.01, value: t.vol, 'aria-label': 'Volume of ' + t.name, title: 'Volume' });
      vol.addEventListener('input', () => {
        t.vol = +vol.value;
        out.textContent = fmtDb(t.vol);
        liveTrack(t);
        draw();
      });
      vol.addEventListener('change', commit);
      vol.addEventListener('dblclick', () => ((vol.value = 1), (t.vol = 1), (out.textContent = fmtDb(1)), liveTrack(t), commit()));
      const out = h('output', {}, fmtDb(t.vol));
      const pan = h('input', { type: 'range', min: -1, max: 1, step: 0.05, value: t.pan, class: 'apan', 'aria-label': 'Pan of ' + t.name, title: 'Left / right (double-click to centre)' });
      pan.addEventListener('input', () => ((t.pan = +pan.value), liveTrack(t)));
      pan.addEventListener('change', commit);
      pan.addEventListener('dblclick', () => ((pan.value = 0), (t.pan = 0), liveTrack(t), commit()));
      const tog = (k, label, title) =>
        h(
          'button',
          {
            class: 'atog' + (t[k] ? ' on ' + k : ''),
            title,
            'aria-pressed': t[k] ? 'true' : 'false',
            onclick: (e) => {
              e.stopPropagation();
              t[k] = !t[k];
              commit();
              refreshHeads();
              for (const x of P.tracks) liveTrack(x);
              draw();
            },
          },
          label
        );
      const row = h('div', { class: 'ahead' + (sel.tracks.includes(t.id) ? ' on' : ''), style: { height: th + 'px', '--tc': t.color }, 'data-id': t.id }, [
        h('div', { class: 'ah-top' }, [
          h('button', { class: 'ah-name', title: 'Rename (double-click)', ondblclick: () => renameTrack(t) }, t.name),
          tog('mute', 'M', 'Mute'),
          tog('solo', 'S', 'Solo: hear only this track'),
          h('button', {
            class: 'icon-btn sm ah-more',
            'aria-label': 'Track options',
            html: icon('more'),
            onclick: (e) => {
              e.stopPropagation();
              trackMenu(e.currentTarget, t);
            },
          }),
        ]),
        h('label', { class: 'ah-vol' }, [h('span', { html: icon('volume') }), vol, out]),
        h('label', { class: 'ah-pan' }, [h('span', {}, 'L'), pan, h('span', {}, 'R')]),
      ]);
      row.addEventListener('pointerdown', (e) => {
        if (e.target.closest('input,button')) return;
        selectTrack(t, e.shiftKey || PE.mod(e));
      });
      host.appendChild(row);
    }
    if (P.tracks.length)
      host.appendChild(
        h('button', {
          class: 'btn sm ghost ah-add',
          html: icon('plus') + '<span>Add track</span>',
          onclick: () => {
            const t = newTrack();
            sel.tracks = [t.id];
            commit();
            refreshAll();
          },
        })
      );
    host.style.transform = `translateY(${-scrollY}px)`;
  }
  const fmtDb = (g) => (g <= 0.001 ? '−∞' : (dB(g) >= 0 ? '+' : '') + dB(g).toFixed(1)) + ' dB';
  function selectTrack(t, add) {
    if (add) sel.tracks = sel.tracks.includes(t.id) ? sel.tracks.filter((x) => x !== t.id) : sel.tracks.concat(t.id);
    else sel.tracks = [t.id];
    sel.clip = null;
    refreshHeads();
    refreshPanel();
    draw();
  }
  async function renameTrack(t) {
    const n = await PE.ui.prompt('Rename track', 'Name', t.name);
    if (n && n.trim()) {
      t.name = n.trim();
      commit();
      refreshHeads();
      draw();
    }
  }
  function trackMenu(anchor, t) {
    const i = P.tracks.indexOf(t);
    PE.ui.menu(anchor, [
      { label: 'Rename…', icon: 'edit', onClick: () => renameTrack(t) },
      { label: 'Select whole track', icon: 'wave', onClick: () => ((sel.tracks = [t.id]), (sel.t0 = 0), (sel.t1 = duration()), (sel.clip = null), refreshAll()) },
      { label: 'Duplicate track', icon: 'copy', onClick: () => dupTrack(t) },
      { label: 'Move up', icon: 'up', disabled: i === 0, onClick: () => moveTrack(t, -1) },
      { label: 'Move down', icon: 'down', disabled: i === P.tracks.length - 1, onClick: () => moveTrack(t, 1) },
      { label: 'Export this track…', icon: 'download', onClick: () => exportDialog({ only: t.id }) },
      '-',
      { label: 'Delete track', icon: 'trash', onClick: () => deleteTrack(t) },
    ]);
  }
  function dupTrack(t) {
    const c = JSON.parse(JSON.stringify(t));
    c.id = nid('t');
    c.name = t.name + ' copy';
    c.color = COLORS[P.tracks.length % COLORS.length];
    for (const x of c.clips) x.id = nid('c');
    P.tracks.splice(P.tracks.indexOf(t) + 1, 0, c);
    commit();
    refreshAll();
  }
  function moveTrack(t, d) {
    const i = P.tracks.indexOf(t);
    P.tracks.splice(i, 1);
    P.tracks.splice(PE.clamp(i + d, 0, P.tracks.length), 0, t);
    commit();
    refreshAll();
  }
  function deleteTrack(t) {
    stop();
    P.tracks = P.tracks.filter((x) => x !== t);
    sel.tracks = sel.tracks.filter((x) => x !== t.id);
    if (sel.clip && !findClip(sel.clip)) sel.clip = null;
    commit();
    refreshAll();
  }

  /* =========================================================
   *  timeline drawing
   * ========================================================= */
  let W = 0,
    Hh = 0,
    dpr = 1;
  const base = document.createElement('canvas');
  let baseDirty = true;
  function resize() {
    if (!els || !A.active) return;
    const r = els.lanes.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(10, r.width);
    Hh = Math.max(10, r.height);
    els.cv.width = base.width = Math.round(W * dpr);
    els.cv.height = base.height = Math.round(Hh * dpr);
    els.cv.style.width = W + 'px';
    els.cv.style.height = Hh + 'px';
    clampScroll();
    draw();
  }
  function totalH() {
    return P.tracks.length * TH();
  }
  function contentW() {
    return Math.max(duration() + 10, (W / pps) * 1.0) * pps;
  }
  function clampScroll() {
    scrollX = PE.clamp(scrollX, 0, Math.max(0, contentW() - W));
    scrollY = PE.clamp(scrollY, 0, Math.max(0, totalH() + 50 - (Hh - RULER)));
    const inner = els.hs.firstChild;
    inner.style.width = contentW() + 'px';
    els.hs._lock = true;
    els.hs.scrollLeft = scrollX;
    els.hs._lock = false;
    els.headsIn.style.transform = `translateY(${-scrollY}px)`;
  }
  const tx = (t) => t * pps - scrollX;
  const xt = (x) => (x + scrollX) / pps;
  const trackY = (i) => RULER + i * TH() - scrollY;
  function trackAtY(y) {
    const i = Math.floor((y - RULER + scrollY) / TH());
    return i >= 0 && i < P.tracks.length ? i : -1;
  }
  function cssVar(n) {
    return getComputedStyle(els.view).getPropertyValue(n).trim();
  }
  function draw() {
    baseDirty = true;
    frame();
  }
  let rqf = 0;
  function frame() {
    cancelAnimationFrame(rqf);
    rqf = requestAnimationFrame(paint);
  }
  function paint() {
    if (!els || !P || !A.active) return;
    if (baseDirty) {
      drawBase();
      baseDirty = false;
    }
    const ctx = els.cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.cv.width, els.cv.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // recording in progress
    if (rec && rec.track) {
      const i = P.tracks.indexOf(rec.track);
      const y = trackY(i);
      const x0 = tx(rec.at),
        x1 = tx(rec.at + rec.elapsed());
      ctx.fillStyle = 'rgba(220,40,50,.25)';
      ctx.fillRect(x0, y + 4, Math.max(2, x1 - x0), TH() - 8);
      ctx.strokeStyle = '#dc2832';
      ctx.strokeRect(x0 + 0.5, y + 4.5, Math.max(2, x1 - x0), TH() - 9);
      if (rec.levels) {
        ctx.fillStyle = '#dc2832';
        const mid = y + TH() / 2;
        rec.levels.forEach((v, k) => {
          const x = x0 + (k * 0.05) * pps;
          if (x > -2 && x < W) ctx.fillRect(x, mid - v * (TH() / 2 - 8), Math.max(1, 0.05 * pps - 1), v * (TH() - 16));
        });
      }
    }
    // playhead
    const x = tx(ph);
    if (x >= -2 && x <= W + 2) {
      ctx.fillStyle = '#e5484d';
      ctx.fillRect(Math.round(x) - 0.5, 0, 1.5, Hh);
      ctx.beginPath();
      ctx.moveTo(x - 6, 0);
      ctx.lineTo(x + 6, 0);
      ctx.lineTo(x, 8);
      ctx.closePath();
      ctx.fill();
    }
    if (snapLine != null) {
      ctx.fillStyle = '#f5a623';
      ctx.fillRect(Math.round(tx(snapLine)), RULER, 1, Hh);
    }
    els.time.firstChild.textContent = PE.fmtTime(ph, 3);
    els.time.lastChild.textContent = '/ ' + PE.fmtTime(duration(), 3);
  }
  function rulerStep() {
    const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (const s of steps) if (s * pps >= 70) return s;
    return 3600;
  }
  function drawBase() {
    const ctx = base.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = cssVar('--desk') || '#dde2e8',
      panel = cssVar('--panel') || '#f6f7f9',
      line = cssVar('--line') || '#d3d9e0',
      ink2 = cssVar('--ink-2') || '#4a5563',
      surface = cssVar('--surface') || '#fff',
      accent = cssVar('--accent') || '#1f3fcf';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, Hh);
    const th = TH();
    // lanes
    P.tracks.forEach((t, i) => {
      const y = trackY(i);
      if (y > Hh || y + th < RULER) return;
      ctx.fillStyle = sel.tracks.includes(t.id) ? mix(surface, accent, 0.06) : i % 2 ? mix(bg, surface, 0.35) : mix(bg, surface, 0.55);
      ctx.fillRect(0, y, W, th);
      ctx.fillStyle = line;
      ctx.fillRect(0, y + th - 1, W, 1);
    });
    // time grid
    const step = rulerStep();
    const t0 = Math.floor(xt(0) / step) * step;
    ctx.fillStyle = line;
    for (let t = t0; tx(t) < W; t += step) ctx.fillRect(Math.round(tx(t)), RULER, 1, Hh);
    // clips
    P.tracks.forEach((t, i) => {
      const y = trackY(i);
      if (y > Hh || y + th < RULER) return;
      const muted = t.mute || (P.tracks.some((x) => x.solo) && !t.solo);
      for (const c of t.clips) drawClip(ctx, t, c, y, th, muted, surface, ink2);
    });
    // selection range
    if (hasRange()) {
      const x0 = tx(sel.t0),
        x1 = tx(sel.t1);
      const ts = selTracks();
      ctx.fillStyle = 'rgba(80,120,255,.22)';
      if (!ts.length) ctx.fillRect(x0, RULER, x1 - x0, Hh);
      for (const t of ts) {
        const y = trackY(P.tracks.indexOf(t));
        ctx.fillRect(x0, y, x1 - x0, th - 1);
      }
      ctx.fillStyle = accent;
      ctx.fillRect(Math.round(x0), RULER, 1, Hh);
      ctx.fillRect(Math.round(x1), RULER, 1, Hh);
    }
    // ruler
    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, W, RULER);
    ctx.fillStyle = line;
    ctx.fillRect(0, RULER - 1, W, 1);
    ctx.fillStyle = ink2;
    ctx.font = '11px ' + (cssVar('--font-ui') || 'system-ui');
    ctx.textBaseline = 'top';
    for (let t = Math.max(0, t0); tx(t) < W; t += step) {
      const x = Math.round(tx(t));
      ctx.fillRect(x, RULER - 9, 1, 8);
      ctx.fillText(fmtRuler(t, step), x + 3, 5);
      for (let k = 1; k < 5; k++) ctx.fillRect(Math.round(tx(t + (k * step) / 5)), RULER - 4, 1, 3);
    }
    if (hasRange()) {
      ctx.fillStyle = 'rgba(80,120,255,.35)';
      ctx.fillRect(tx(sel.t0), 0, tx(sel.t1) - tx(sel.t0), RULER - 1);
    }
  }
  function fmtRuler(t, step) {
    if (step < 0.01) return PE.fmtTime(t, 3);
    if (step < 1) return PE.fmtTime(t, step < 0.1 ? 2 : 1);
    return PE.fmtTime(t, 0);
  }
  function mix(a, b, k) {
    const pa = parseColor(a),
      pb = parseColor(b);
    if (!pa || !pb) return a;
    return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * k)).join(',')})`;
  }
  function parseColor(c) {
    c = (c || '').trim();
    let m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = c.match(/rgba?\(([^)]+)\)/);
    if (m) return m[1].split(',').slice(0, 3).map(Number);
    return null;
  }
  function env(c, tau) {
    let g = c.gain;
    if (c.fi && tau < c.fi) g *= tau / c.fi;
    if (c.fo && tau > c.len - c.fo) g *= Math.max(0, (c.len - tau) / c.fo);
    return g;
  }
  function drawClip(ctx, t, c, y, th, muted, surface, ink2) {
    const x0 = tx(c.start),
      x1 = tx(clipEnd(c));
    if (x1 < 0 || x0 > W) return;
    const on = sel.clip === c.id;
    const top = y + 3,
      hh = th - 7;
    ctx.save();
    ctx.globalAlpha = muted ? 0.45 : 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x0, top, Math.max(1, x1 - x0), hh, 5) : ctx.rect(x0, top, x1 - x0, hh);
    ctx.fillStyle = hexA(t.color, 0.16);
    ctx.fill();
    ctx.lineWidth = on ? 2 : 1;
    ctx.strokeStyle = on ? t.color : hexA(t.color, 0.55);
    ctx.stroke();
    ctx.clip();
    // name bar
    ctx.fillStyle = hexA(t.color, on ? 0.9 : 0.6);
    ctx.fillRect(x0, top, x1 - x0, 16);
    ctx.fillStyle = '#fff';
    ctx.font = '600 10.5px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const label = (c.name || t.name) + (c.gain !== 1 ? `  ${dB(c.gain) >= 0 ? '+' : ''}${dB(c.gain).toFixed(1)} dB` : '');
    ctx.fillText(label, Math.max(x0, 0) + 6, top + 8.5);
    // waveform
    const buf = B.get(c.buf);
    if (buf) {
      const mid = top + 16 + (hh - 16) / 2,
        amp = (hh - 20) / 2;
      const r = buf.sampleRate;
      const spp = r / pps;
      ctx.fillStyle = t.color;
      const xa = Math.max(0, Math.floor(x0)),
        xb = Math.min(W, Math.ceil(x1));
      const chans = [];
      for (let k = 0; k < buf.numberOfChannels; k++) chans.push(buf.getChannelData(k));
      if (spp < 2) {
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        const s0 = Math.max(0, Math.floor((c.off + (xt(xa) - c.start)) * r)),
          s1 = Math.min(buf.length, Math.ceil((c.off + (xt(xb) - c.start)) * r) + 1);
        for (let s = s0; s < s1; s++) {
          const tt = s / r - c.off + c.start;
          const v = chans[0][s] * env(c, tt - c.start);
          const x = tx(tt);
          s === s0 ? ctx.moveTo(x, mid - v * amp) : ctx.lineTo(x, mid - v * amp);
        }
        ctx.stroke();
        if (spp < 0.15) {
          ctx.fillStyle = t.color;
          for (let s = s0; s < s1; s++) {
            const tt = s / r - c.off + c.start;
            ctx.fillRect(tx(tt) - 1.5, mid - chans[0][s] * env(c, tt - c.start) * amp - 1.5, 3, 3);
          }
        }
      } else {
        const pk = spp >= 4096 ? PE.peaks(buf, 4096) : spp >= 256 ? PE.peaks(buf, 256) : null;
        for (let x = xa; x < xb; x++) {
          const tt = xt(x);
          const tau = tt - c.start;
          const sA = (c.off + tau) * r,
            sB = sA + spp;
          let lo = 0,
            hi = 0;
          if (pk) {
            const ia = Math.max(0, Math.floor(sA / pk.spp)),
              ib = Math.min(pk.mn.length, Math.ceil(sB / pk.spp));
            for (let i = ia; i < ib; i++) {
              if (pk.mn[i] < lo) lo = pk.mn[i];
              if (pk.mx[i] > hi) hi = pk.mx[i];
            }
          } else {
            const ia = Math.max(0, Math.floor(sA)),
              ib = Math.min(buf.length, Math.ceil(sB));
            for (const d of chans)
              for (let i = ia; i < ib; i++) {
                const v = d[i];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
              }
          }
          const g = env(c, tau);
          const a = Math.min(1.05, hi * g),
            b = Math.max(-1.05, lo * g);
          ctx.fillRect(x, mid - a * amp, 1, Math.max(1, (a - b) * amp));
        }
      }
      ctx.fillStyle = hexA(t.color, 0.35);
      ctx.fillRect(x0, mid, x1 - x0, 1);
    }
    // fades
    ctx.strokeStyle = hexA('#000000', 0.45);
    ctx.lineWidth = 1;
    if (c.fi) {
      ctx.beginPath();
      ctx.moveTo(x0, top + hh);
      ctx.lineTo(tx(c.start + c.fi), top + 16);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.beginPath();
      ctx.moveTo(x0, top + 16);
      ctx.lineTo(tx(c.start + c.fi), top + 16);
      ctx.lineTo(x0, top + hh);
      ctx.fill();
    }
    if (c.fo) {
      ctx.beginPath();
      ctx.moveTo(tx(clipEnd(c) - c.fo), top + 16);
      ctx.lineTo(x1, top + hh);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.beginPath();
      ctx.moveTo(tx(clipEnd(c) - c.fo), top + 16);
      ctx.lineTo(x1, top + 16);
      ctx.lineTo(x1, top + hh);
      ctx.fill();
    }
    ctx.restore();
    if (on) {
      // fade handles
      for (const fx of [tx(c.start + c.fi), tx(clipEnd(c) - c.fo)]) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(PE.clamp(fx, x0 + 5, x1 - 5), top + 16, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  function hexA(hex, a) {
    const p = parseColor(hex) || [0, 0, 0];
    return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
  }

  /* =========================================================
   *  zoom & scroll
   * ========================================================= */
  function setPps(v, anchorX) {
    const ax = anchorX == null ? (tx(ph) >= 0 && tx(ph) <= W ? tx(ph) : W / 2) : anchorX;
    const t = xt(ax);
    pps = PE.clamp(v, 0.5, 20000);
    scrollX = t * pps - ax;
    clampScroll();
    draw();
    if (PE.mm.cur === A) $('#btn-zoom').textContent = fmtZoom();
  }
  const fmtZoom = () => (pps >= 100 ? Math.round(pps) + ' px/s' : pps >= 10 ? pps.toFixed(0) + ' px/s' : pps.toFixed(1) + ' px/s');
  function zoomFit() {
    const d = duration() || 30;
    pps = PE.clamp((Math.max(100, W || 800) - 24) / d, 0.5, 20000);
    scrollX = 0;
    if (els) {
      clampScroll();
      draw();
    }
    if (PE.mm.cur === A) $('#btn-zoom').textContent = fmtZoom();
  }
  A.zoomIn = () => setPps(pps * 1.5);
  A.zoomOut = () => setPps(pps / 1.5);
  A.fit = zoomFit;
  A.zoomMenu = (anchor) =>
    PE.ui.menu(anchor, [
      { label: 'Fit project', icon: 'fit', onClick: zoomFit },
      { label: 'Zoom to selection', icon: 'zoom-in', disabled: !hasRange(), onClick: () => zoomTo(sel.t0, sel.t1) },
      '-',
      { label: 'Zoom in', icon: 'plus', onClick: A.zoomIn },
      { label: 'Zoom out', icon: 'minus', onClick: A.zoomOut },
    ]);
  function zoomTo(a, b) {
    pps = PE.clamp((W - 40) / Math.max(0.001, b - a), 0.5, 20000);
    scrollX = a * pps - 20;
    clampScroll();
    draw();
    $('#btn-zoom').textContent = fmtZoom();
  }
  function onWheel(e) {
    if (!P) return;
    e.preventDefault();
    const r = els.lanes.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) return setPps(pps * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) scrollX += e.shiftKey ? e.deltaY : e.deltaX;
    else if (totalH() + RULER > Hh) scrollY += e.deltaY;
    else scrollX += e.deltaY;
    clampScroll();
    draw();
  }

  /* =========================================================
   *  pointer interaction
   * ========================================================= */
  let drag = null,
    snapLine = null;
  const pointers = new Map();
  let pinch = null;
  function local(e) {
    const r = els.lanes.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function hitClip(x, y) {
    const i = trackAtY(y);
    if (i < 0) return null;
    const t = P.tracks[i];
    const top = trackY(i) + 3;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const edge = touch ? 12 : 6;
    for (let k = t.clips.length - 1; k >= 0; k--) {
      const c = t.clips[k];
      const x0 = tx(c.start),
        x1 = tx(clipEnd(c));
      if (x < x0 - (sel.clip === c.id ? edge : 0) || x > x1 + (sel.clip === c.id ? edge : 0)) continue;
      let part = 'body';
      if (sel.clip === c.id && Math.abs(y - (top + 16)) < (touch ? 14 : 8)) {
        const fi = PE.clamp(tx(c.start + c.fi), x0 + 5, x1 - 5),
          fo = PE.clamp(tx(clipEnd(c) - c.fo), x0 + 5, x1 - 5);
        if (Math.abs(x - fi) < (touch ? 14 : 8)) part = 'fadeIn';
        else if (Math.abs(x - fo) < (touch ? 14 : 8)) part = 'fadeOut';
      }
      if (part === 'body') {
        if (x - x0 < edge && x1 - x0 > edge * 3) part = 'trimL';
        else if (x1 - x < edge && x1 - x0 > edge * 3) part = 'trimR';
        else if (y < top + 18 || tool === 'move') part = 'move';
      }
      return { t, c, part, i };
    }
    return { t, c: null, part: 'lane', i };
  }
  function snapT(t, ignore) {
    snapLine = null;
    if (!snap) return t;
    const lim = 8 / pps;
    let best = null,
      bd = lim;
    const cands = [0, ph];
    if (hasRange()) cands.push(sel.t0, sel.t1);
    for (const tr of P.tracks)
      for (const c of tr.clips) {
        if (ignore && ignore.includes(c.id)) continue;
        cands.push(c.start, clipEnd(c));
      }
    for (const v of cands)
      if (Math.abs(v - t) < bd) {
        bd = Math.abs(v - t);
        best = v;
      }
    if (best != null) {
      snapLine = best;
      return best;
    }
    return t;
  }
  function onDown(e) {
    if (!A.active || !P) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.abs(a.x - b.x) || 1, pps, cx: (a.x + b.x) / 2, y: (a.y + b.y) / 2, sx: scrollX, sy: scrollY };
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      drag = { kind: 'pan', x: e.clientX, y: e.clientY, sx: scrollX, sy: scrollY };
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    els.lanes.focus({ preventScroll: true });
    const [x, y] = local(e);
    const t = Math.max(0, xt(x));
    if (y < RULER) {
      drag = { kind: 'seek' };
      seek(snapT(t));
      return;
    }
    const hit = hitClip(x, y);
    if (!hit) {
      drag = { kind: 'range', t0: t, i0: -1, moved: false, x, y };
      return;
    }
    const { c, part } = hit;
    if (c && part !== 'body' && part !== 'lane') {
      sel.clip = c.id;
      if (!sel.tracks.includes(hit.t.id)) sel.tracks = [hit.t.id];
      drag = { kind: part, c, t: hit.t, ti: hit.i, x, y, t0: t, c0: Object.assign({}, c), moved: false };
      refreshHeads();
      refreshPanel();
      draw();
      return;
    }
    // range selection (or a click to place the playhead)
    if (e.shiftKey && hasRange()) {
      if (t < sel.t0) sel.t0 = t;
      else sel.t1 = t;
      draw();
      return;
    }
    drag = { kind: 'range', t0: snapT(t), i0: hit.i, moved: false, x, y, clip: c };
  }
  function onMove(e) {
    if (!A.active || !P) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.abs(a.x - b.x) || 1;
      const r = els.lanes.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - r.left;
      const tAt = (pinch.cx - r.left + pinch.sx) / pinch.pps;
      pps = PE.clamp(pinch.pps * (d / pinch.d), 0.5, 20000);
      scrollX = tAt * pps - cx;
      scrollY = pinch.sy - ((a.y + b.y) / 2 - pinch.y);
      clampScroll();
      draw();
      return;
    }
    if (!drag) {
      // cursor feedback
      if (e.target === els.cv) {
        const [x, y] = local(e);
        const hit = y >= RULER ? hitClip(x, y) : null;
        els.cv.style.cursor = !hit || !hit.c ? (y < RULER ? 'pointer' : 'text') : hit.part === 'trimL' || hit.part === 'trimR' ? 'ew-resize' : hit.part === 'move' ? 'grab' : hit.part.startsWith('fade') ? 'ew-resize' : 'text';
      }
      return;
    }
    const [x, y] = local(e);
    const t = Math.max(0, xt(x));
    if (drag.kind === 'pan') {
      scrollX = drag.sx - (e.clientX - drag.x);
      scrollY = drag.sy - (e.clientY - drag.y);
      clampScroll();
      draw();
      return;
    }
    if (drag.kind === 'seek') {
      seek(snapT(t));
      return;
    }
    autoScroll(x);
    if (drag.kind === 'range') {
      if (!drag.moved && Math.abs(x - drag.x) < 3 && Math.abs(y - drag.y) < 3) return;
      drag.moved = true;
      const t1 = snapT(t);
      sel.t0 = Math.min(drag.t0, t1);
      sel.t1 = Math.max(drag.t0, t1);
      sel.clip = null;
      const i1 = trackAtY(y);
      if (drag.i0 >= 0) {
        const a = Math.min(drag.i0, i1 < 0 ? (y < RULER ? 0 : P.tracks.length - 1) : i1),
          b = Math.max(drag.i0, i1 < 0 ? (y < RULER ? 0 : P.tracks.length - 1) : i1);
        sel.tracks = P.tracks.slice(a, b + 1).map((x) => x.id);
      }
      draw();
      return;
    }
    const c = drag.c,
      c0 = drag.c0;
    const dt = t - drag.t0;
    if (!drag.moved && Math.abs(x - drag.x) < 3 && Math.abs(y - drag.y) < 3) return;
    drag.moved = true;
    if (drag.kind === 'move') {
      let ns = Math.max(0, c0.start + dt);
      const a = snapT(ns, [c.id]);
      if (snapLine != null) ns = a;
      else {
        const b = snapT(ns + c.len, [c.id]);
        if (snapLine != null) ns = b - c.len;
      }
      c.start = Math.max(0, ns);
      // move to another track
      const i = trackAtY(y);
      if (i >= 0 && P.tracks[i] !== drag.t) {
        drag.t.clips = drag.t.clips.filter((x) => x !== c);
        drag.t = P.tracks[i];
        drag.t.clips.push(c);
        sel.tracks = [drag.t.id];
        refreshHeads();
      }
      drag.t.clips.sort((a, b) => a.start - b.start);
    } else if (drag.kind === 'trimL') {
      const buf = B.get(c.buf);
      let ns = snapT(c0.start + dt, [c.id]);
      ns = PE.clamp(ns, Math.max(0, c0.start - c0.off), clipEnd(c0) - 0.01);
      void buf;
      c.off = c0.off + (ns - c0.start);
      c.start = ns;
      c.len = clipEnd(c0) - ns;
      fixFades(c);
    } else if (drag.kind === 'trimR') {
      const buf = B.get(c.buf);
      let ne = snapT(clipEnd(c0) + dt, [c.id]);
      ne = PE.clamp(ne, c0.start + 0.01, c0.start + (buf.duration - c0.off));
      c.len = ne - c0.start;
      fixFades(c);
    } else if (drag.kind === 'fadeIn') {
      c.fi = PE.clamp(t - c.start, 0, c.len - c.fo);
    } else if (drag.kind === 'fadeOut') {
      c.fo = PE.clamp(clipEnd(c) - t, 0, c.len - c.fi);
    }
    draw();
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (!drag || !P) return;
    const d = drag;
    drag = null;
    snapLine = null;
    stopAutoScroll();
    if (d.kind === 'range' && !d.moved) {
      // a click: playhead here, select the clip / track
      const t = Math.max(0, xt(d.x));
      sel.t0 = sel.t1 = 0;
      sel.clip = d.clip ? d.clip.id : null;
      if (d.i0 >= 0) sel.tracks = [P.tracks[d.i0].id];
      seek(snap ? snapT(t) : t);
      snapLine = null;
      refreshHeads();
      refreshPanel();
      draw();
      return;
    }
    if (d.kind === 'range') {
      refreshHeads();
      refreshPanel();
      draw();
      return;
    }
    if (d.kind === 'seek' || d.kind === 'pan') return draw();
    if (d.moved) {
      commit();
      if (PB.playing) play(curTime());
    }
    refreshPanel();
    draw();
  }
  let asTimer = 0;
  function autoScroll(x) {
    stopAutoScroll();
    const edge = 30;
    if (x > W - edge || x < edge) {
      asTimer = setInterval(() => {
        scrollX += x > W - edge ? 12 : -12;
        clampScroll();
        draw();
      }, 30);
    }
  }
  function stopAutoScroll() {
    clearInterval(asTimer);
  }
  function onDbl(e) {
    const [x, y] = local(e);
    if (y < RULER) return;
    const hit = hitClip(x, y);
    if (hit && hit.c) {
      // select the whole clip as a range
      sel.t0 = hit.c.start;
      sel.t1 = clipEnd(hit.c);
      sel.tracks = [hit.t.id];
      sel.clip = hit.c.id;
      refreshPanel();
      draw();
    }
  }

  /* =========================================================
   *  playback
   * ========================================================= */
  const PB = { playing: false, nodes: {}, srcs: [], master: null, analyser: null, when: 0, from: 0, raf: 0, loopT: 0 };
  function audible(t) {
    const solo = P.tracks.some((x) => x.solo);
    return !t.mute && (!solo || t.solo);
  }
  /** connect every clip to ctx starting at project time `from` (ends at `to`) */
  function schedule(ctx, dest, from, to, when, only) {
    const nodes = {},
      srcs = [];
    for (const t of P.tracks) {
      if (only && t.id !== only) continue;
      const g = ctx.createGain();
      g.gain.value = (only ? !t.mute : audible(t)) ? t.vol : 0;
      let out = g;
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = t.pan;
        g.connect(p);
        out = p;
        nodes[t.id] = { g, p };
      } else nodes[t.id] = { g };
      out.connect(dest);
      for (const c of t.clips) {
        const end = clipEnd(c);
        if (end <= from || c.start >= to) continue;
        const buf = B.get(c.buf);
        if (!buf) continue;
        const s = ctx.createBufferSource();
        s.buffer = buf;
        const cg = ctx.createGain();
        s.connect(cg);
        cg.connect(g);
        const a = Math.max(from, c.start),
          b = Math.min(to, end);
        const at = when + (a - from);
        const tau0 = a - c.start,
          tau1 = b - c.start;
        const gp = cg.gain;
        gp.setValueAtTime(env(c, tau0), at);
        let last = tau0;
        if (c.fi && tau0 < c.fi) {
          const e = Math.min(c.fi, tau1);
          gp.linearRampToValueAtTime(env(c, e), at + (e - tau0));
          last = e;
        }
        if (c.fo && tau1 > c.len - c.fo) {
          const fs = Math.max(last, c.len - c.fo);
          if (fs > last) gp.setValueAtTime(env(c, fs), at + (fs - tau0));
          gp.linearRampToValueAtTime(env(c, tau1), at + (tau1 - tau0));
        }
        s.start(at, c.off + tau0, tau1 - tau0);
        srcs.push(s);
      }
    }
    return { nodes, srcs };
  }
  function play(from) {
    if (!P) return;
    stop(true);
    const ctx = PE.audioCtx();
    const end = loop && hasRange() ? sel.t1 : duration();
    if (from == null) from = ph;
    if (loop && hasRange() && (from < sel.t0 || from >= sel.t1 - 0.01)) from = sel.t0;
    if (from >= end - 0.01) from = loop && hasRange() ? sel.t0 : 0;
    PB.master = ctx.createGain();
    PB.master.gain.value = P.master;
    PB.analyser = ctx.createAnalyser();
    PB.analyser.fftSize = 1024;
    PB.master.connect(PB.analyser);
    PB.analyser.connect(ctx.destination);
    PB.when = ctx.currentTime + 0.06;
    PB.from = from;
    PB.end = end;
    const r = schedule(ctx, PB.master, from, end, PB.when);
    PB.nodes = r.nodes;
    PB.srcs = r.srcs;
    PB.playing = true;
    syncBar();
    tick();
  }
  function curTime() {
    if (!PB.playing) return ph;
    return PB.from + Math.max(0, PE.audioCtx().currentTime - PB.when);
  }
  function tick() {
    cancelAnimationFrame(PB.raf);
    if (!PB.playing) return;
    const t = curTime();
    if (t >= PB.end) {
      if (loop && hasRange()) return play(sel.t0);
      if (rec) {
        // keep the clock running while recording past the end
      } else {
        stop();
        ph = PB.end;
        frame();
        return;
      }
    }
    ph = t;
    // follow the playhead
    const x = tx(ph);
    if (x > W - 20 || x < 0) {
      scrollX = ph * pps - 20;
      clampScroll();
      baseDirty = true;
    }
    meter();
    paint();
    PB.raf = requestAnimationFrame(tick);
  }
  function stop(keep) {
    if (PB.playing) {
      for (const s of PB.srcs)
        try {
          s.stop();
        } catch (e) {}
      try {
        PB.master.disconnect();
      } catch (e) {}
    }
    const was = PB.playing;
    PB.playing = false;
    PB.srcs = [];
    cancelAnimationFrame(PB.raf);
    if (!keep && was) {
      ph = PE.clamp(ph, 0, Math.max(duration(), ph));
      meterClear();
    }
    if (els) syncBar();
    if (els) frame();
  }
  function togglePlay() {
    if (PB.playing) {
      ph = curTime();
      stop();
    } else play(ph);
  }
  A.togglePlay = togglePlay;
  function seek(t) {
    ph = Math.max(0, t);
    if (PB.playing) play(ph);
    else frame();
  }
  function liveTrack(t) {
    const n = PB.nodes[t.id];
    if (!n || !PB.playing) return;
    n.g.gain.value = audible(t) ? t.vol : 0;
    if (n.p) n.p.pan.value = t.pan;
  }
  const mbuf = new Float32Array(1024);
  function meter() {
    if (!PB.analyser || !els) return;
    PB.analyser.getFloatTimeDomainData(mbuf);
    let pk = 0;
    for (let i = 0; i < mbuf.length; i++) pk = Math.max(pk, Math.abs(mbuf[i]));
    drawMeter(pk);
  }
  function drawMeter(pk) {
    const c = els.meter.getContext('2d');
    const w = els.meter.width,
      hh = els.meter.height;
    c.clearRect(0, 0, w, hh);
    c.fillStyle = 'rgba(128,128,128,.25)';
    c.fillRect(0, 0, w, hh);
    const db = Math.max(-60, dB(pk));
    const f = (db + 60) / 60;
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#2fb36d');
    g.addColorStop(0.75, '#e2c23b');
    g.addColorStop(1, '#e5484d');
    c.fillStyle = g;
    c.fillRect(0, 0, w * f, hh);
  }
  function meterClear() {
    if (els) drawMeter(0);
  }

  /* =========================================================
   *  recording
   * ========================================================= */
  let rec = null;
  async function record() {
    if (rec) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder)
      return PE.toast('This browser can’t record audio.', 'error');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      return PE.toast('Microphone access was blocked. Allow it in the browser’s address bar and try again.', 'error', 7000);
    }
    stop();
    const t = newTrack('Recording ' + (P.tracks.filter((x) => /^Recording/.test(x.name)).length + 1));
    t.color = '#dc2832';
    sel.tracks = [t.id];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = PE.audioCtx();
    const srcNode = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    srcNode.connect(an);
    const at = ph;
    const t0 = performance.now();
    rec = { mr, stream, track: t, at, chunks, an, levels: [], elapsed: () => (performance.now() - t0) / 1000 };
    // play the other tracks while recording (overdub)
    if (P.tracks.some((x) => x.clips.length) && at < duration() - 0.05) play(at);
    mr.start(250);
    const buf = new Float32Array(2048);
    let next = 0;
    const lv = () => {
      if (!rec) return;
      const el = rec.elapsed();
      while (next * 0.05 <= el) {
        an.getFloatTimeDomainData(buf);
        let pk = 0;
        for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
        rec.levels.push(Math.min(1, pk));
        next++;
      }
      drawMeter(rec.levels[rec.levels.length - 1] || 0);
      ph = at + el;
      if (tx(ph) > W - 20) {
        scrollX = ph * pps - W / 2;
        clampScroll();
        baseDirty = true;
      }
      paint();
      rec.raf = requestAnimationFrame(lv);
    };
    lv();
    els.empty.hidden = true;
    refreshHeads();
    syncBar();
    PE.toast('Recording… press R or the record button again to stop.', 'info', 4000);
  }
  async function stopRecording(discard) {
    if (!rec) return;
    const r = rec;
    rec = null;
    cancelAnimationFrame(r.raf);
    const done = new Promise((res) => (r.mr.onstop = res));
    try {
      r.mr.stop();
    } catch (e) {}
    await done;
    r.stream.getTracks().forEach((t) => t.stop());
    stop();
    if (discard || !P) return;
    try {
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
      const buf = await PE.decodeAudio(new Uint8Array(await blob.arrayBuffer()));
      addClip(r.track, addBuffer(buf), r.at, r.track.name);
      ph = r.at + buf.duration;
      commit();
      PE.toast('Recording added (' + PE.fmtTime(buf.duration, 1) + ').', 'ok');
    } catch (e) {
      console.error(e);
      P.tracks = P.tracks.filter((x) => x !== r.track);
      PE.toast('The recording could not be read.', 'error');
    }
    refreshAll();
  }

  /* =========================================================
   *  editing commands
   * ========================================================= */
  function targetTracks() {
    const ts = selTracks();
    return ts.length ? ts : P.tracks;
  }
  function splitHere() {
    let n = 0;
    const f = sel.clip && findClip(sel.clip);
    const ts = f ? [f.t] : targetTracks();
    for (const t of ts)
      for (const c of t.clips.slice())
        if (ph > c.start && ph < clipEnd(c)) {
          splitClip(t, c, ph);
          n++;
        }
    if (!n) return PE.toast('Put the playhead over a clip to split it.', 'warn');
    commit();
    draw();
  }
  function copyData(cutToo) {
    if (hasRange()) {
      const ts = targetTracks();
      const data = { dur: sel.t1 - sel.t0, tracks: [] };
      for (const t of ts) {
        const ps = piecesIn(t, sel.t0, sel.t1);
        data.tracks.push(ps.map((c) => ({ buf: c.buf, off: c.off, len: c.len, rel: c.start - sel.t0, gain: c.gain, fi: c.fi, fo: c.fo, name: c.name })));
        if (cutToo) removeRange(t, sel.t0, sel.t1, true);
      }
      return data;
    }
    const f = sel.clip && findClip(sel.clip);
    if (f) {
      const c = f.c;
      if (cutToo) f.t.clips = f.t.clips.filter((x) => x !== c);
      return { dur: c.len, tracks: [[{ buf: c.buf, off: c.off, len: c.len, rel: 0, gain: c.gain, fi: c.fi, fo: c.fo, name: c.name }]] };
    }
    return null;
  }
  function copy() {
    const d = copyData(false);
    if (!d) return PE.toast('Select part of a track (drag across it) or a clip first.', 'warn');
    // splitting for the copy is not a real change
    clipboard = d;
    if (H.stack[H.idx] !== JSON.stringify(P)) {
      P = JSON.parse(H.stack[H.idx]);
    }
    PE.toast('Copied ' + PE.fmtTime(d.dur, 2) + '.', 'ok');
    draw();
  }
  function cut() {
    const d = copyData(true);
    if (!d) return PE.toast('Select part of a track (drag across it) or a clip first.', 'warn');
    clipboard = d;
    if (hasRange()) sel.t1 = sel.t0;
    sel.clip = null;
    ph = d && hasRange() ? sel.t0 : ph;
    commit();
    refreshAll();
  }
  function paste() {
    if (!clipboard) return PE.toast('Nothing copied yet.', 'warn');
    const at = hasRange() ? sel.t0 : ph;
    if (hasRange()) for (const t of targetTracks()) removeRange(t, sel.t0, sel.t1, true);
    let i0 = selTracks().length ? P.tracks.indexOf(selTracks()[0]) : 0;
    if (i0 < 0) i0 = 0;
    clipboard.tracks.forEach((cs, k) => {
      const t = P.tracks[i0 + k] || newTrack();
      splitAt(t, at);
      for (const c of t.clips) if (c.start >= at - 0.0006) c.start += clipboard.dur;
      for (const c of cs) t.clips.push(Object.assign({}, c, { id: nid('c'), start: at + c.rel }));
      t.clips.sort((a, b) => a.start - b.start);
    });
    sel.t0 = at;
    sel.t1 = at + clipboard.dur;
    sel.clip = null;
    commit();
    refreshAll();
  }
  function del() {
    if (hasRange()) {
      for (const t of targetTracks()) removeRange(t, sel.t0, sel.t1, true);
      ph = sel.t0;
      sel.t1 = sel.t0;
      commit();
      return refreshAll();
    }
    const f = sel.clip && findClip(sel.clip);
    if (f) {
      f.t.clips = f.t.clips.filter((x) => x !== f.c);
      sel.clip = null;
      commit();
      return refreshAll();
    }
    PE.toast('Select part of a track or a clip to delete.', 'warn');
  }
  function silence() {
    if (!hasRange()) return PE.toast('Drag across the part you want to silence.', 'warn');
    for (const t of targetTracks()) removeRange(t, sel.t0, sel.t1, false);
    commit();
    draw();
  }
  function keepOnly() {
    if (!hasRange()) return PE.toast('Drag across the part you want to keep.', 'warn');
    const a = sel.t0,
      b = sel.t1;
    for (const t of P.tracks) {
      piecesIn(t, a, b);
      t.clips = t.clips.filter((c) => c.start >= a - 0.0006 && clipEnd(c) <= b + 0.0006);
      for (const c of t.clips) c.start -= a;
    }
    sel.t0 = 0;
    sel.t1 = b - a;
    ph = 0;
    scrollX = 0;
    commit();
    zoomFit();
    refreshAll();
  }
  function duplicate() {
    const f = sel.clip && findClip(sel.clip);
    if (f) {
      const c = Object.assign({}, f.c, { id: nid('c'), start: clipEnd(f.c) });
      for (const x of f.t.clips) if (x.start >= clipEnd(f.c) - 0.0006) x.start += f.c.len;
      f.t.clips.push(c);
      f.t.clips.sort((a, b) => a.start - b.start);
      sel.clip = c.id;
      commit();
      return refreshAll();
    }
    if (hasRange()) {
      const d = copyData(false);
      const save = clipboard;
      clipboard = d;
      const t0 = sel.t0;
      sel.t0 = sel.t1;
      sel.t1 = sel.t0; // paste at the end of the selection
      ph = sel.t0;
      paste();
      clipboard = save;
      void t0;
      return;
    }
    PE.toast('Select a clip or a range to duplicate.', 'warn');
  }
  function selectAll() {
    sel.tracks = P.tracks.map((t) => t.id);
    sel.t0 = 0;
    sel.t1 = duration();
    sel.clip = null;
    refreshAll();
  }

  /* =========================================================
   *  DSP
   * ========================================================= */
  function bufFrom(chans, r) {
    const out = PE.newBuffer(chans.length, chans[0].length, r);
    chans.forEach((d, i) => out.getChannelData(i).set(d));
    return out;
  }
  const chansOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  /** run a Web Audio graph over a buffer offline */
  async function offline(buf, build, extra = 0, ch) {
    const r = buf.sampleRate;
    const oc = new OfflineAudioContext(ch || buf.numberOfChannels, buf.length + Math.round(extra * r), r);
    const s = oc.createBufferSource();
    s.buffer = buf;
    const out = build(oc, s);
    out.connect(oc.destination);
    s.start();
    return oc.startRendering();
  }
  /** in-place radix-2 FFT */
  function makeFFT(n) {
    const lev = Math.log2(n) | 0;
    const cos = new Float64Array(n / 2),
      sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i,
        y = 0;
      for (let j = 0; j < lev; j++) {
        y = (y << 1) | (x & 1);
        x >>>= 1;
      }
      rev[i] = y;
    }
    return function (re, im, inv) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2,
          step = n / size;
        for (let i = 0; i < n; i += size)
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tr = re[l] * cos[k] + (inv ? -1 : 1) * im[l] * sin[k];
            const ti = -(inv ? -1 : 1) * re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tr;
            im[l] = im[j] - ti;
            re[j] += tr;
            im[j] += ti;
          }
      }
      if (inv)
        for (let i = 0; i < n; i++) {
          re[i] /= n;
          im[i] /= n;
        }
    };
  }
  /** spectral-gating noise reduction */
  async function denoise(buf, p, prog, profile) {
    const N = 2048,
      hop = 512;
    const fft = makeFFT(N);
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const floor = fromDb(-p.amount);
    const K = p.sens;
    const out = [];
    const bins = N / 2 + 1;
    const spectra = (d) => {
      // magnitude frames for the noise estimate
      const frames = [];
      const re = new Float64Array(N),
        im = new Float64Array(N);
      for (let pos = 0; pos + N <= d.length; pos += hop * 2) {
        for (let i = 0; i < N; i++) {
          re[i] = d[pos + i] * win[i];
          im[i] = 0;
        }
        fft(re, im, false);
        const m = new Float32Array(bins);
        let e = 0;
        for (let k = 0; k < bins; k++) {
          m[k] = Math.hypot(re[k], im[k]);
          e += m[k];
        }
        frames.push({ m, e });
      }
      return frames;
    };
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      // noise profile: given, or the quietest tenth of the clip
      let noise = new Float32Array(bins);
      const src = profile ? (profile.numberOfChannels > ch ? profile.getChannelData(ch) : profile.getChannelData(0)) : d;
      const fr = spectra(src);
      if (fr.length) {
        const q = profile ? fr : fr.slice().sort((a, b) => a.e - b.e).slice(0, Math.max(1, Math.round(fr.length * 0.1)));
        for (const f of q) for (let k = 0; k < bins; k++) noise[k] += f.m[k] / q.length;
      }
      const o = new Float32Array(d.length);
      const norm = new Float32Array(d.length);
      const re = new Float64Array(N),
        im = new Float64Array(N);
      const gPrev = new Float32Array(bins).fill(1);
      const total = Math.ceil(d.length / hop);
      let n = 0;
      for (let pos = -N + hop; pos < d.length; pos += hop) {
        for (let i = 0; i < N; i++) {
          const s = pos + i;
          re[i] = s >= 0 && s < d.length ? d[s] * win[i] : 0;
          im[i] = 0;
        }
        fft(re, im, false);
        for (let k = 0; k < bins; k++) {
          const mag = Math.hypot(re[k], im[k]) + 1e-12;
          let g = mag > K * noise[k] ? 1 : floor;
          // smooth: fast attack, slower release
          g = g > gPrev[k] ? gPrev[k] + (g - gPrev[k]) * 0.6 : gPrev[k] + (g - gPrev[k]) * 0.35;
          gPrev[k] = g;
        }
        for (let k = 0; k < bins; k++) {
          // average with neighbours to avoid “musical noise”
          const g = (gPrev[Math.max(0, k - 1)] + 2 * gPrev[k] + gPrev[Math.min(bins - 1, k + 1)]) / 4;
          re[k] *= g;
          im[k] *= g;
          if (k > 0 && k < N / 2) {
            re[N - k] = re[k];
            im[N - k] = -im[k];
          }
        }
        fft(re, im, true);
        for (let i = 0; i < N; i++) {
          const s = pos + i;
          if (s < 0 || s >= d.length) continue;
          o[s] += re[i] * win[i];
          norm[s] += win[i] * win[i];
        }
        if (++n % 200 === 0) {
          prog && prog((ch + n / total) / buf.numberOfChannels);
          await yieldUI();
        }
      }
      for (let i = 0; i < o.length; i++) o[i] = norm[i] > 1e-6 ? o[i] / norm[i] : 0;
      out.push(o);
    }
    return bufFrom(out, buf.sampleRate);
  }
  /** WSOLA time stretch: factor > 1 = faster / shorter, pitch unchanged */
  async function stretch(buf, factor, prog) {
    const r = buf.sampleRate;
    const win = Math.round(r * 0.06) & ~1,
      Hs = win / 2,
      Ha = Hs * factor;
    const tol = Math.round(r * 0.012);
    const n = buf.length;
    const outLen = Math.ceil(n / factor) + win;
    const chans = chansOf(buf);
    const mono = new Float32Array(n);
    for (const d of chans) for (let i = 0; i < n; i++) mono[i] += d[i] / chans.length;
    const w = new Float32Array(win);
    for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
    const outs = chans.map(() => new Float32Array(outLen));
    const norm = new Float32Array(outLen);
    const frames = Math.floor((n - win) / Ha) + 1;
    let prev = 0;
    const L = win / 2,
      D = 4;
    for (let k = 0; k < frames; k++) {
      const nominal = Math.round(k * Ha);
      let best = nominal;
      if (k > 0) {
        const nat = prev + Hs; // where the previous frame naturally continues
        let bc = -Infinity;
        const lo = Math.max(0, nominal - tol),
          hi = Math.min(n - win, nominal + tol);
        for (let x = lo; x <= hi; x += 2) {
          let c = 0;
          for (let i = 0; i < L; i += D) c += mono[nat + i] * mono[x + i];
          if (c > bc) {
            bc = c;
            best = x;
          }
        }
      }
      best = PE.clamp(best, 0, n - win);
      const op = k * Hs;
      for (let ci = 0; ci < chans.length; ci++) {
        const d = chans[ci],
          o = outs[ci];
        for (let i = 0; i < win && op + i < outLen; i++) o[op + i] += d[best + i] * w[i];
      }
      for (let i = 0; i < win && op + i < outLen; i++) norm[op + i] += w[i];
      prev = best;
      if (k % 400 === 0) {
        prog && prog(k / frames);
        await yieldUI();
      }
    }
    const len = Math.max(1, Math.round(n / factor));
    const res = outs.map((o) => {
      const a = new Float32Array(len);
      for (let i = 0; i < len; i++) a[i] = norm[i] > 0.05 ? o[i] / norm[i] : o[i];
      return a;
    });
    return bufFrom(res, r);
  }
  /** change playback rate (pitch and length change together) */
  async function respeed(buf, k) {
    const r = buf.sampleRate;
    const oc = new OfflineAudioContext(buf.numberOfChannels, Math.max(1, Math.ceil(buf.length / k)), r);
    const s = oc.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = k;
    s.connect(oc.destination);
    s.start();
    return oc.startRendering();
  }
  function impulse(r, secs, decay) {
    const n = Math.round(r * secs);
    const L = new Float32Array(n),
      R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const e = Math.pow(1 - i / n, decay);
      L[i] = (Math.random() * 2 - 1) * e;
      R[i] = (Math.random() * 2 - 1) * e;
    }
    return bufFrom([L, R], r);
  }
  function mapChans(buf, fn) {
    return bufFrom(chansOf(buf).map((d, ci) => fn(d, ci)), buf.sampleRate);
  }
  function peakOf(buf) {
    let p = 0;
    for (const d of chansOf(buf)) for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
    return p;
  }

  /** every effect: params, and how to run it on a piece of audio */
  const FX = [
    {
      k: 'amplify',
      name: 'Volume (amplify)',
      ic: 'volume',
      params: [{ k: 'db', label: 'Change', min: -24, max: 24, step: 0.5, def: 3, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' }],
      run: (b, p) => mapChans(b, (d) => d.map((v) => v * fromDb(p.db))),
    },
    {
      k: 'normalize',
      name: 'Normalize',
      ic: 'wave',
      desc: 'Makes the loudest point reach the level you choose.',
      params: [{ k: 'db', label: 'Peak level', min: -12, max: 0, step: 0.5, def: -1, fmt: (v) => v + ' dB' }],
      run: (b, p) => {
        const pk = peakOf(b);
        const g = pk > 0 ? fromDb(p.db) / pk : 1;
        return mapChans(b, (d) => d.map((v) => v * g));
      },
    },
    {
      k: 'fadein',
      name: 'Fade in',
      ic: 'up',
      params: [{ k: 'curve', label: 'Curve', type: 'seg', opts: [['lin', 'Linear'], ['exp', 'Smooth']], def: 'exp' }],
      run: (b, p) => mapChans(b, (d) => d.map((v, i) => v * curve(i / d.length, p.curve))),
    },
    {
      k: 'fadeout',
      name: 'Fade out',
      ic: 'down',
      params: [{ k: 'curve', label: 'Curve', type: 'seg', opts: [['lin', 'Linear'], ['exp', 'Smooth']], def: 'exp' }],
      run: (b, p) => mapChans(b, (d) => d.map((v, i) => v * curve(1 - i / d.length, p.curve))),
    },
    {
      k: 'denoise',
      name: 'Noise reduction',
      ic: 'magic',
      desc: 'Removes steady background noise (hiss, hum, fans). For best results first select a few seconds of noise only and press “Use selection as noise sample”.',
      params: [
        { k: 'amount', label: 'Reduction', min: 3, max: 36, step: 1, def: 15, fmt: (v) => v + ' dB' },
        { k: 'sens', label: 'Sensitivity', min: 1, max: 4, step: 0.1, def: 2, fmt: (v) => v.toFixed(1) },
      ],
      run: (b, p, prog) => denoise(b, p, prog, noiseProfile),
      extra: () => [
        h('div', { class: 'mbtns' }, [
          btn(noiseProfile ? 'Noise sample set ✓ (replace)' : 'Use selection as noise sample', 'wave', captureNoise),
          noiseProfile ? btn('Clear sample', 'close', () => ((noiseProfile = null), refreshPanel())) : null,
        ]),
      ],
    },
    {
      k: 'eq',
      name: 'Equalizer',
      ic: 'sliders',
      params: [
        { k: 'bass', label: 'Bass (100 Hz)', min: -15, max: 15, step: 0.5, def: 4, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
        { k: 'low', label: 'Low mids (400 Hz)', min: -15, max: 15, step: 0.5, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
        { k: 'mid', label: 'Mids (1.5 kHz)', min: -15, max: 15, step: 0.5, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
        { k: 'pres', label: 'Presence (4 kHz)', min: -15, max: 15, step: 0.5, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
        { k: 'treble', label: 'Treble (10 kHz)', min: -15, max: 15, step: 0.5, def: 2, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
      ],
      presets: [
        ['Flat', { bass: 0, low: 0, mid: 0, pres: 0, treble: 0 }],
        ['Bass boost', { bass: 8, low: 2, mid: 0, pres: 0, treble: 0 }],
        ['Voice', { bass: -6, low: -2, mid: 2, pres: 4, treble: 1 }],
        ['Bright', { bass: 0, low: -1, mid: 0, pres: 3, treble: 6 }],
        ['Warm', { bass: 3, low: 2, mid: 0, pres: -2, treble: -3 }],
        ['Radio', { bass: -15, low: -3, mid: 6, pres: 4, treble: -15 }],
      ],
      run: (b, p) =>
        offline(b, (oc, s) => {
          let n = s;
          for (const [type, f, g, q] of [
            ['lowshelf', 100, p.bass],
            ['peaking', 400, p.low, 1],
            ['peaking', 1500, p.mid, 1],
            ['peaking', 4000, p.pres, 1],
            ['highshelf', 10000, p.treble],
          ]) {
            const bq = oc.createBiquadFilter();
            bq.type = type;
            bq.frequency.value = f;
            bq.gain.value = g;
            if (q) bq.Q.value = q;
            n.connect(bq);
            n = bq;
          }
          return n;
        }),
    },
    {
      k: 'filter',
      name: 'High / low cut',
      ic: 'sliders',
      desc: 'High-pass removes rumble below the cut-off; low-pass removes hiss above it.',
      params: [
        { k: 'hp', label: 'Cut below (high-pass)', min: 0, max: 1000, step: 10, def: 80, fmt: (v) => (v ? v + ' Hz' : 'off') },
        { k: 'lp', label: 'Cut above (low-pass)', min: 1000, max: 22000, step: 100, def: 22000, fmt: (v) => (v >= 22000 ? 'off' : (v / 1000).toFixed(1) + ' kHz') },
      ],
      run: (b, p) =>
        offline(b, (oc, s) => {
          let n = s;
          if (p.hp > 0) {
            for (let i = 0; i < 2; i++) {
              const f = oc.createBiquadFilter();
              f.type = 'highpass';
              f.frequency.value = p.hp;
              n.connect(f);
              n = f;
            }
          }
          if (p.lp < 22000) {
            for (let i = 0; i < 2; i++) {
              const f = oc.createBiquadFilter();
              f.type = 'lowpass';
              f.frequency.value = Math.min(p.lp, b.sampleRate / 2 - 100);
              n.connect(f);
              n = f;
            }
          }
          return n;
        }),
    },
    {
      k: 'voice',
      name: 'Voice clean-up',
      ic: 'mic',
      desc: 'One click for speech: removes rumble, evens out the level, adds clarity and normalizes.',
      params: [{ k: 'strength', label: 'Strength', min: 0.2, max: 1, step: 0.05, def: 0.7, fmt: (v) => Math.round(v * 100) + '%' }],
      run: async (b, p) => {
        let out = await offline(b, (oc, s) => {
          const hp = oc.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 85;
          const mud = oc.createBiquadFilter();
          mud.type = 'peaking';
          mud.frequency.value = 300;
          mud.Q.value = 1;
          mud.gain.value = -3 * p.strength;
          const pres = oc.createBiquadFilter();
          pres.type = 'peaking';
          pres.frequency.value = 3500;
          pres.Q.value = 0.9;
          pres.gain.value = 4 * p.strength;
          const comp = oc.createDynamicsCompressor();
          comp.threshold.value = -18 - 10 * p.strength;
          comp.ratio.value = 2 + 4 * p.strength;
          comp.attack.value = 0.005;
          comp.release.value = 0.15;
          comp.knee.value = 8;
          s.connect(hp);
          hp.connect(mud);
          mud.connect(pres);
          pres.connect(comp);
          return comp;
        });
        const pk = peakOf(out);
        const g = pk > 0 ? fromDb(-1) / pk : 1;
        return mapChans(out, (d) => d.map((v) => v * g));
      },
    },
    {
      k: 'compressor',
      name: 'Compressor',
      ic: 'adjust',
      desc: 'Evens out loud and quiet parts.',
      params: [
        { k: 'thr', label: 'Threshold', min: -60, max: 0, step: 1, def: -24, fmt: (v) => v + ' dB' },
        { k: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, def: 4, fmt: (v) => v + ':1' },
        { k: 'makeup', label: 'Make-up gain', min: 0, max: 24, step: 0.5, def: 6, fmt: (v) => '+' + v + ' dB' },
      ],
      run: (b, p) =>
        offline(b, (oc, s) => {
          const c = oc.createDynamicsCompressor();
          c.threshold.value = p.thr;
          c.ratio.value = p.ratio;
          c.attack.value = 0.003;
          c.release.value = 0.25;
          const g = oc.createGain();
          g.gain.value = fromDb(p.makeup);
          s.connect(c);
          c.connect(g);
          return g;
        }),
    },
    {
      k: 'speed',
      name: 'Speed',
      ic: 'speed',
      desc: 'Faster or slower, and the pitch changes with it (like a record player).',
      params: [{ k: 'k', label: 'Speed', min: 0.25, max: 4, step: 0.05, def: 1.25, fmt: (v) => v.toFixed(2) + '×' }],
      run: (b, p) => respeed(b, p.k),
    },
    {
      k: 'tempo',
      name: 'Tempo',
      ic: 'speed',
      desc: 'Faster or slower without changing the pitch.',
      params: [{ k: 'k', label: 'Tempo', min: 0.5, max: 2, step: 0.05, def: 1.1, fmt: (v) => v.toFixed(2) + '×' }],
      run: (b, p, prog) => stretch(b, p.k, prog),
    },
    {
      k: 'pitch',
      name: 'Pitch',
      ic: 'music',
      desc: 'Higher or lower without changing the length.',
      params: [{ k: 'st', label: 'Semitones', min: -12, max: 12, step: 1, def: 2, fmt: (v) => (v > 0 ? '+' : '') + v }],
      run: async (b, p, prog) => {
        const k = Math.pow(2, p.st / 12);
        const s = await stretch(b, 1 / k, prog);
        const out = await respeed(s, k);
        return out.length > b.length ? slice(out, 0, b.duration) : out;
      },
    },
    {
      k: 'echo',
      name: 'Echo',
      ic: 'loop',
      params: [
        { k: 'delay', label: 'Delay', min: 0.05, max: 1.5, step: 0.01, def: 0.3, fmt: (v) => Math.round(v * 1000) + ' ms' },
        { k: 'fb', label: 'Repeats', min: 0, max: 0.9, step: 0.05, def: 0.4, fmt: (v) => Math.round(v * 100) + '%' },
        { k: 'mix', label: 'Mix', min: 0, max: 1, step: 0.05, def: 0.4, fmt: (v) => Math.round(v * 100) + '%' },
      ],
      tail: (p) => Math.min(8, (p.delay * Math.log(0.001)) / Math.log(Math.max(0.01, p.fb))),
      run: (b, p) =>
        offline(
          b,
          (oc, s) => {
            const dry = oc.createGain(),
              wet = oc.createGain(),
              d = oc.createDelay(2),
              fb = oc.createGain(),
              out = oc.createGain();
            d.delayTime.value = p.delay;
            fb.gain.value = p.fb;
            dry.gain.value = 1;
            wet.gain.value = p.mix;
            s.connect(dry);
            s.connect(d);
            d.connect(fb);
            fb.connect(d);
            d.connect(wet);
            dry.connect(out);
            wet.connect(out);
            return out;
          },
          0
        ),
    },
    {
      k: 'reverb',
      name: 'Reverb',
      ic: 'fx',
      params: [
        { k: 'size', label: 'Room size', min: 0.3, max: 6, step: 0.1, def: 1.8, fmt: (v) => v.toFixed(1) + ' s' },
        { k: 'mix', label: 'Mix', min: 0, max: 1, step: 0.05, def: 0.3, fmt: (v) => Math.round(v * 100) + '%' },
      ],
      run: (b, p) =>
        offline(
          b,
          (oc, s) => {
            const conv = oc.createConvolver();
            conv.buffer = impulse(b.sampleRate, p.size, 3);
            const dry = oc.createGain(),
              wet = oc.createGain(),
              out = oc.createGain();
            dry.gain.value = 1 - p.mix * 0.5;
            wet.gain.value = p.mix;
            s.connect(dry);
            s.connect(conv);
            conv.connect(wet);
            dry.connect(out);
            wet.connect(out);
            return out;
          },
          0,
          Math.max(2, b.numberOfChannels)
        ),
    },
    {
      k: 'vocals',
      name: 'Remove vocals (karaoke)',
      ic: 'mic',
      desc: 'Cancels sound that is in the middle of a stereo mix, usually the lead vocal. Needs stereo audio.',
      params: [{ k: 'keepBass', label: 'Keep bass below', min: 0, max: 300, step: 10, def: 150, fmt: (v) => (v ? v + ' Hz' : 'off') }],
      run: async (b, p) => {
        if (b.numberOfChannels < 2) throw new Error('This audio is mono, so the vocals can’t be separated.');
        const [L, R] = chansOf(b);
        const side = L.map((v, i) => (v - R[i]) * 0.5);
        let out = bufFrom([side, Float32Array.from(side, (v) => -v)], b.sampleRate);
        if (p.keepBass) {
          const bass = await offline(b, (oc, s) => {
            const f = oc.createBiquadFilter();
            f.type = 'lowpass';
            f.frequency.value = p.keepBass;
            s.connect(f);
            return f;
          });
          const bl = chansOf(bass);
          out = bufFrom(chansOf(out).map((d, i) => d.map((v, j) => v + bl[Math.min(i, bl.length - 1)][j])), b.sampleRate);
        }
        return out;
      },
    },
    {
      k: 'trimsilence',
      name: 'Remove silence',
      ic: 'scissors',
      desc: 'Shortens pauses that are quieter than the threshold.',
      params: [
        { k: 'thr', label: 'Threshold', min: -70, max: -20, step: 1, def: -45, fmt: (v) => v + ' dB' },
        { k: 'min', label: 'Shorten pauses longer than', min: 0.1, max: 3, step: 0.05, def: 0.5, fmt: (v) => v.toFixed(2) + ' s' },
        { k: 'keep', label: 'Leave', min: 0, max: 1, step: 0.05, def: 0.2, fmt: (v) => v.toFixed(2) + ' s' },
      ],
      run: (b, p) => {
        const r = b.sampleRate,
          chans = chansOf(b);
        const blk = Math.round(r * 0.01);
        const thr = fromDb(p.thr);
        const quiet = [];
        for (let i = 0; i < b.length; i += blk) {
          let pk = 0;
          for (const d of chans) for (let j = i; j < Math.min(b.length, i + blk); j++) pk = Math.max(pk, Math.abs(d[j]));
          quiet.push(pk < thr);
        }
        const keepRanges = [];
        let i = 0;
        while (i < quiet.length) {
          if (!quiet[i]) {
            const a = i;
            while (i < quiet.length && !quiet[i]) i++;
            keepRanges.push([a, i]);
          } else {
            const a = i;
            while (i < quiet.length && quiet[i]) i++;
            const lenS = ((i - a) * blk) / r;
            if (lenS <= p.min) keepRanges.push([a, i]);
            else {
              const k = Math.round((p.keep * r) / blk / 2);
              keepRanges.push([a, a + k], [i - k, i]);
            }
          }
        }
        let total = 0;
        for (const [a, c] of keepRanges) total += Math.min(b.length, c * blk) - a * blk;
        const outs = chans.map(() => new Float32Array(Math.max(1, total)));
        let o = 0;
        for (const [a, c] of keepRanges) {
          const s0 = a * blk,
            s1 = Math.min(b.length, c * blk);
          chans.forEach((d, ci) => outs[ci].set(d.subarray(s0, s1), o));
          o += s1 - s0;
        }
        return bufFrom(outs, r);
      },
    },
    { k: 'reverse', name: 'Reverse', ic: 'loop', params: [], run: (b) => mapChans(b, (d) => d.slice().reverse()) },
    {
      k: 'mono',
      name: 'Mono / stereo',
      ic: 'volume',
      params: [{ k: 'to', label: 'Make it', type: 'seg', opts: [['mono', 'Mono'], ['stereo', 'Stereo'], ['swap', 'Swap L/R']], def: 'mono' }],
      run: (b, p) => {
        const c = chansOf(b);
        if (p.to === 'swap') return c.length > 1 ? bufFrom([c[1], c[0]], b.sampleRate) : b;
        const m = new Float32Array(b.length);
        for (const d of c) for (let i = 0; i < m.length; i++) m[i] += d[i] / c.length;
        return p.to === 'mono' ? bufFrom([m], b.sampleRate) : bufFrom([m, m.slice()], b.sampleRate);
      },
    },
    {
      k: 'phone',
      name: 'Telephone',
      ic: 'mic',
      params: [],
      run: (b) =>
        offline(b, (oc, s) => {
          const a = oc.createBiquadFilter();
          a.type = 'highpass';
          a.frequency.value = 400;
          const c = oc.createBiquadFilter();
          c.type = 'lowpass';
          c.frequency.value = 3000;
          const ws = oc.createWaveShaper();
          const cv = new Float32Array(256);
          for (let i = 0; i < 256; i++) {
            const x = (i / 255) * 2 - 1;
            cv[i] = Math.tanh(x * 2.5);
          }
          ws.curve = cv;
          s.connect(a);
          a.connect(c);
          c.connect(ws);
          return ws;
        }),
    },
  ];
  PE.audioFx = FX;
  const curve = (x, k) => (k === 'exp' ? x * x * (3 - 2 * x) : x);
  let noiseProfile = null;
  function captureNoise() {
    if (!hasRange()) return PE.toast('First drag across a part with only background noise.', 'warn');
    const t = targetTracks()[0];
    const c = t && t.clips.find((x) => x.start <= sel.t0 + 0.001 && clipEnd(x) >= sel.t1 - 0.001);
    if (!c) return PE.toast('Select the noise inside one clip.', 'warn');
    noiseProfile = slice(B.get(c.buf), c.off + (sel.t0 - c.start), sel.t1 - sel.t0);
    PE.toast('Noise sample saved. Now select what to clean (or nothing for the whole clip) and press Apply.', 'ok', 6000);
    refreshPanel();
  }

  /** which pieces an effect applies to: the range on the selected tracks, else the selected clip, else the selected tracks */
  function fxTargets() {
    if (hasRange()) {
      const out = [];
      for (const t of targetTracks()) for (const c of piecesIn(t, sel.t0, sel.t1)) out.push({ t, c });
      return { what: 'the selection', list: out };
    }
    const f = sel.clip && findClip(sel.clip);
    if (f) return { what: '“' + (f.c.name || f.t.name) + '”', list: [f] };
    const ts = selTracks().length ? selTracks() : P.tracks.length === 1 ? P.tracks : [];
    const list = [];
    for (const t of ts) for (const c of t.clips) list.push({ t, c });
    return { what: ts.length === 1 ? 'track “' + ts[0].name + '”' : ts.length + ' tracks', list };
  }
  async function applyFx(fx, p) {
    stop();
    const tg = fxTargets();
    if (!tg.list.length) {
      // undo the edge splits
      P = JSON.parse(H.stack[H.idx]);
      return PE.toast('Select a track, a clip or a range first.', 'warn');
    }
    PE.ui.busy(true, fx.name + '…', 0.02);
    try {
      let k = 0;
      for (const { t, c } of tg.list) {
        const piece = slice(B.get(c.buf), c.off, c.len);
        let out = await fx.run(piece, p, (f) => PE.ui.busy(true, fx.name + '…', (k + f) / tg.list.length));
        if (out.sampleRate !== rate()) out = await PE.resample(out, rate());
        const d = out.duration - c.len;
        c.buf = addBuffer(out);
        c.off = 0;
        c.len = out.duration;
        fixFades(c);
        // longer or shorter: move what follows on the track
        if (Math.abs(d) > 0.0005) {
          for (const x of t.clips) if (x !== c && x.start >= c.start + c.len - d - 0.0006) x.start = Math.max(0, x.start + d);
          if (hasRange()) sel.t1 += d / Math.max(1, targetTracks().length);
        }
        k++;
      }
      commit();
      PE.toast(fx.name + ' applied to ' + tg.what + '.', 'ok');
    } catch (e) {
      console.error(e);
      P = JSON.parse(H.stack[H.idx]);
      PE.toast(e.message || 'The effect could not be applied.', 'error', 6000);
    } finally {
      PE.ui.busy(false);
      refreshAll();
    }
  }
  let previewSrc = null;
  async function previewFx(fx, p) {
    stopPreview();
    const tg = fxTargets();
    P = JSON.parse(H.stack[H.idx]); // the target lookup may have split clips
    if (!tg.list.length) return PE.toast('Select a track, a clip or a range first.', 'warn');
    stop();
    const { c } = tg.list[0];
    const buf = B.get(c.buf);
    const piece = slice(buf, c.off, Math.min(c.len, 12));
    PE.ui.busy(true, 'Preparing a preview', 0.3);
    try {
      const out = await fx.run(piece, p, null);
      const ctx = PE.audioCtx();
      previewSrc = ctx.createBufferSource();
      previewSrc.buffer = out;
      const g = ctx.createGain();
      g.gain.value = c.gain * P.master;
      previewSrc.connect(g);
      g.connect(ctx.destination);
      previewSrc.start();
      previewSrc.onended = () => (previewSrc = null);
      PE.toast('Previewing up to 12 seconds…', 'info', 2500);
    } catch (e) {
      PE.toast(e.message || 'Preview failed.', 'error');
    } finally {
      PE.ui.busy(false);
    }
  }
  function stopPreview() {
    if (previewSrc)
      try {
        previewSrc.stop();
      } catch (e) {}
    previewSrc = null;
  }

  /* =========================================================
   *  generators
   * ========================================================= */
  const gen = { kind: 'tone', freq: 440, wave: 'sine', dur: 3, amp: -12, noise: 'white' };
  function generate() {
    const r = rate();
    const n = Math.max(1, Math.round(gen.dur * r));
    const d = new Float32Array(n);
    const a = fromDb(gen.amp);
    if (gen.kind === 'tone') {
      for (let i = 0; i < n; i++) {
        const ph2 = (gen.freq * i) / r;
        const x = ph2 - Math.floor(ph2);
        d[i] = a * (gen.wave === 'sine' ? Math.sin(2 * Math.PI * x) : gen.wave === 'square' ? (x < 0.5 ? 1 : -1) * 0.7 : gen.wave === 'saw' ? (2 * x - 1) * 0.8 : (1 - 4 * Math.abs(x - 0.5)) * 1);
      }
      const ramp = Math.min(n / 2, Math.round(r * 0.005));
      for (let i = 0; i < ramp; i++) {
        d[i] *= i / ramp;
        d[n - 1 - i] *= i / ramp;
      }
    } else if (gen.kind === 'noise') {
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        last = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (gen.noise === 'pink') {
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.2965164;
          b2 = 0.57 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2 * a;
        } else if (gen.noise === 'brown') {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5 * a;
        } else d[i] = w * a;
      }
    }
    const buf = bufFrom([d, d.slice()], r);
    let t = selTracks()[0];
    if (!t) t = newTrack(gen.kind === 'silence' ? 'Silence' : gen.kind === 'tone' ? 'Tone' : 'Noise');
    // insert: make room at the playhead
    splitAt(t, ph);
    for (const c of t.clips) if (c.start >= ph - 0.0006) c.start += gen.dur;
    const c = addClip(t, addBuffer(buf), ph, gen.kind === 'tone' ? gen.freq + ' Hz ' + gen.wave : gen.kind === 'noise' ? gen.noise + ' noise' : 'silence');
    sel.tracks = [t.id];
    sel.clip = c.id;
    commit();
    refreshAll();
  }

  /* =========================================================
   *  panel
   * ========================================================= */
  function section(title, kids) {
    return h('section', { class: 'msec' }, [title ? h('h3', {}, title) : null].concat(kids));
  }
  function timeField(label, v, fn) {
    const inp = h('input', { class: 'field', value: PE.fmtTime(v, 3), 'aria-label': label });
    inp.addEventListener('change', () => {
      const t = parseTime(inp.value);
      if (t == null) inp.value = PE.fmtTime(v, 3);
      else fn(t);
    });
    return h('label', {}, [h('span', {}, label), inp]);
  }
  function parseTime(s) {
    s = String(s).trim();
    if (!s) return null;
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    let t = 0;
    for (const p of parts) t = t * 60 + p;
    return Math.max(0, t);
  }
  function refreshPanel() {
    if (!els || !P) return;
    els.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === panelTab));
    const body = els.body;
    const st = body.scrollTop;
    body.innerHTML = '';
    const parts = panelTab === 'fx' ? fxPanel() : panelTab === 'gen' ? genPanel() : editPanel();
    parts.filter(Boolean).forEach((p) => body.appendChild(p));
    body.scrollTop = st;
  }
  function editPanel() {
    const out = [];
    const range = hasRange();
    const geo = h('div', { class: 'mgeo atimes' }, [
      timeField('Start', range ? sel.t0 : ph, (t) => {
        sel.t0 = t;
        if (sel.t1 < t) sel.t1 = t;
        draw();
        refreshPanel();
      }),
      timeField('End', range ? sel.t1 : ph, (t) => {
        sel.t1 = Math.max(t, sel.t0);
        draw();
        refreshPanel();
      }),
      timeField('Length', range ? sel.t1 - sel.t0 : 0, (t) => {
        sel.t1 = sel.t0 + t;
        draw();
        refreshPanel();
      }),
    ]);
    out.push(
      section('Selection', [
        h('p', { class: 'p-note' }, range ? `${PE.fmtTime(sel.t1 - sel.t0, 3)} selected on ${selTracks().length ? selTracks().length + ' track' + (selTracks().length > 1 ? 's' : '') : 'all tracks'}.` : 'Drag across a track to select part of it. Shift-click extends; double-click selects a whole clip.'),
        geo,
        h('div', { class: 'mbtns' }, [
          btn('Cut', 'scissors', cut),
          btn('Copy', 'copy', copy),
          btn('Paste', 'file-plus', paste),
          btn('Delete', 'trash', del),
          btn('Silence', 'mute', silence),
          btn('Keep only this', 'crop', keepOnly),
          btn('Split', 'split', splitHere),
          btn('Duplicate', 'copy', duplicate),
          btn('Select all', 'wave', selectAll),
        ]),
      ])
    );
    const f = sel.clip && findClip(sel.clip);
    if (f) {
      const c = f.c;
      const upd = (fn, live) => {
        fn();
        draw();
        if (!live) commit();
      };
      out.push(
        section('Clip', [
          h('input', { class: 'field', value: c.name || '', placeholder: f.t.name, 'aria-label': 'Clip name', onchange: (e) => upd(() => (c.name = e.target.value)) }),
          h('p', { class: 'p-note' }, `Starts at ${PE.fmtTime(c.start, 3)}, ${PE.fmtTime(c.len, 3)} long.`),
          PE.slider('Clip volume', dB(c.gain), -30, 18, 0.5, (v, live) => upd(() => (c.gain = fromDb(v)), live), (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'),
          PE.slider('Fade in', c.fi, 0, Math.min(30, c.len), 0.05, (v, live) => upd(() => ((c.fi = v), fixFades(c)), live), (v) => v.toFixed(2) + ' s'),
          PE.slider('Fade out', c.fo, 0, Math.min(30, c.len), 0.05, (v, live) => upd(() => ((c.fo = v), fixFades(c)), live), (v) => v.toFixed(2) + ' s'),
          h('div', { class: 'mbtns' }, [
            btn('Move to playhead', 'right', () => upd(() => (c.start = ph))),
            btn('Move to start', 'skip-back', () => upd(() => (c.start = 0))),
            btn('Duplicate', 'copy', duplicate),
            btn('Delete', 'trash', del, 'danger'),
          ]),
          h('p', { class: 'p-note' }, 'Drag the coloured bar to move, the edges to trim and the round handles to fade.'),
        ])
      );
    }
    const ts = selTracks();
    if (ts.length === 1) {
      const t = ts[0];
      out.push(
        section('Track', [
          h('div', { class: 'mrow' }, [h('input', { class: 'field', value: t.name, 'aria-label': 'Track name', onchange: (e) => ((t.name = e.target.value || t.name), commit(), refreshHeads(), draw()) })]),
          h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Colour'), PE.ui.controls.colors(t.color, (col) => col && ((t.color = col), commit(), refreshHeads(), draw()), { palette: COLORS })]),
          h('div', { class: 'mbtns' }, [btn('Duplicate track', 'copy', () => dupTrack(t)), btn('Export track', 'download', () => exportDialog({ only: t.id })), btn('Delete track', 'trash', () => deleteTrack(t), 'danger')]),
        ])
      );
    }
    out.push(
      section('Project', [
        h('p', { class: 'p-note' }, `${P.tracks.length} track${P.tracks.length === 1 ? '' : 's'} · ${PE.fmtTime(duration(), 2)} · ${rate()} Hz`),
        h('div', { class: 'mbtns' }, [btn('Add audio…', 'upload', importPicker), btn('Record', 'mic', () => record()), btn('Mix down to one track', 'layers', mixdownToTrack)]),
      ])
    );
    return out;
  }
  const fxState = {};
  let openFx = null;
  function fxPanel() {
    const tg = fxTargets();
    P = JSON.parse(H.stack[H.idx]); // looking up targets may split clips; don't keep that
    const list = h('div', { class: 'fxlist' });
    for (const fx of FX) {
      const st = fxState[fx.k] || (fxState[fx.k] = Object.fromEntries(fx.params.map((p) => [p.k, p.def])));
      const open = openFx === fx.k;
      const head = h('button', { class: 'fxhead' + (open ? ' on' : ''), 'aria-expanded': open ? 'true' : 'false', html: icon(fx.ic) + '<span>' + PE.esc(fx.name) + '</span>' + icon(open ? 'up' : 'down', 'caret'), onclick: () => ((openFx = open ? null : fx.k), refreshPanel()) });
      const item = h('div', { class: 'fxitem' + (open ? ' on' : '') }, [head]);
      if (open) {
        const kids = [];
        if (fx.desc) kids.push(h('p', { class: 'p-note' }, fx.desc));
        if (fx.presets) kids.push(h('div', { class: 'chips' }, fx.presets.map(([n, v]) => h('button', { class: 'chip', onclick: () => (Object.assign(st, v), refreshPanel()) }, n))));
        for (const p of fx.params) {
          if (p.type === 'seg') kids.push(h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, p.label), PE.ui.controls.seg(p.opts.map(([v, t]) => ({ v, text: t })), st[p.k], (v) => (st[p.k] = v))]));
          else kids.push(PE.slider(p.label, st[p.k], p.min, p.max, p.step, (v) => (st[p.k] = v), p.fmt));
        }
        if (fx.extra) kids.push(...fx.extra());
        kids.push(h('div', { class: 'mbtns' }, [btn('Apply', 'check', () => applyFx(fx, Object.assign({}, st)), 'primary'), btn('Preview', 'play', () => previewFx(fx, Object.assign({}, st))), previewSrc ? btn('Stop', 'stop', () => (stopPreview(), refreshPanel())) : null]));
        item.appendChild(h('div', { class: 'fxbody' }, kids));
      }
      list.appendChild(item);
    }
    return [section('Effects', [h('p', { class: 'p-note' }, tg.list.length ? 'Applies to ' + tg.what + '.' : 'Select a track, a clip or drag across part of a track first.'), list])];
  }
  function genPanel() {
    const kids = [
      PE.ui.controls.seg(
        [
          { v: 'tone', text: 'Tone' },
          { v: 'noise', text: 'Noise' },
          { v: 'silence', text: 'Silence' },
        ],
        gen.kind,
        (v) => ((gen.kind = v), refreshPanel())
      ),
    ];
    if (gen.kind === 'tone') {
      kids.push(
        PE.slider('Frequency', gen.freq, 20, 4000, 1, (v) => (gen.freq = v), (v) => v + ' Hz'),
        h('div', { class: 'mrow' }, [
          h('span', { class: 'mlbl' }, 'Wave'),
          PE.ui.controls.seg(
            ['sine', 'square', 'saw', 'triangle'].map((v) => ({ v, text: v[0].toUpperCase() + v.slice(1) })),
            gen.wave,
            (v) => (gen.wave = v)
          ),
        ])
      );
    }
    if (gen.kind === 'noise')
      kids.push(
        h('div', { class: 'mrow' }, [
          h('span', { class: 'mlbl' }, 'Colour'),
          PE.ui.controls.seg(
            ['white', 'pink', 'brown'].map((v) => ({ v, text: v[0].toUpperCase() + v.slice(1) })),
            gen.noise,
            (v) => (gen.noise = v)
          ),
        ])
      );
    if (gen.kind !== 'silence') kids.push(PE.slider('Level', gen.amp, -48, 0, 1, (v) => (gen.amp = v), (v) => v + ' dB'));
    kids.push(PE.slider('Length', gen.dur, 0.1, 60, 0.1, (v) => (gen.dur = v), (v) => v.toFixed(1) + ' s'));
    kids.push(btn('Insert at the playhead', 'plus', generate, 'primary'));
    kids.push(h('p', { class: 'p-note' }, 'Goes into the selected track (a new track if none is selected); what comes after moves along to make room.'));
    return [section('Generate', kids), section('Record', [h('p', { class: 'p-note' }, 'Records from your microphone onto a new track at the playhead, while the other tracks play.'), btn(rec ? 'Stop recording' : 'Start recording', 'mic', () => (rec ? stopRecording() : record()), rec ? 'danger' : '')])];
  }
  async function importPicker() {
    const files = await PE.pickFiles('audio/*,video/*,.m4a,.flac,.opus', true);
    if (files.length) A.addFiles(files);
  }
  async function mixdownToTrack() {
    if (!P.tracks.length) return;
    PE.ui.busy(true, 'Mixing', 0.4);
    try {
      const buf = await render(0, duration());
      const t = { id: nid('t'), name: 'Mix', vol: 1, pan: 0, mute: false, solo: false, color: COLORS[0], clips: [] };
      for (const x of P.tracks) x.mute = true;
      P.tracks.unshift(t);
      addClip(t, addBuffer(buf), 0, 'Mix');
      sel.tracks = [t.id];
      commit();
      PE.toast('Mixed into a new track. The original tracks are muted, not deleted.', 'ok', 5000);
    } finally {
      PE.ui.busy(false);
      refreshAll();
    }
  }

  /* =========================================================
   *  export
   * ========================================================= */
  async function render(a, b, o = {}) {
    const r = o.rate || rate();
    const len = Math.max(1, Math.ceil((b - a) * r));
    const oc = new OfflineAudioContext(o.channels || 2, len, r);
    const m = oc.createGain();
    m.gain.value = o.only ? 1 : P.master;
    m.connect(oc.destination);
    schedule(oc, m, a, b, 0, o.only);
    return oc.startRendering();
  }
  A.renderMix = render;
  function exportDialog(o = {}) {
    if (!P.tracks.some((t) => t.clips.length)) return PE.toast('There is no audio to save yet.', 'warn');
    let fmt = o.fmt || 'mp3',
      kbps = 192,
      bits = 16,
      part = hasRange() && !o.only ? 'sel' : 'all',
      ch = 2,
      sr = 0;
    const q = h('div');
    const fill = () => {
      q.innerHTML = '';
      if (fmt === 'mp3')
        q.appendChild(
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Quality'),
            PE.ui.controls.seg(
              [128, 192, 256, 320].map((v) => ({ v, text: v + 'k' })),
              kbps,
              (v) => (kbps = v)
            ),
          ])
        );
      else
        q.appendChild(
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Bit depth'),
            PE.ui.controls.seg(
              [
                { v: 16, text: '16-bit' },
                { v: 24, text: '24-bit' },
                { v: 32, text: '32-bit float' },
              ],
              bits,
              (v) => (bits = v)
            ),
          ])
        );
    };
    fill();
    const body = [
      h('div', { class: 'mrow' }, [
        h('span', { class: 'mlbl' }, 'Format'),
        PE.ui.controls.seg(
          [
            { v: 'mp3', text: 'MP3' },
            { v: 'wav', text: 'WAV' },
          ],
          fmt,
          (v) => ((fmt = v), fill())
        ),
      ]),
      q,
      h('div', { class: 'mrow' }, [
        h('span', { class: 'mlbl' }, 'Channels'),
        PE.ui.controls.seg(
          [
            { v: 2, text: 'Stereo' },
            { v: 1, text: 'Mono' },
          ],
          ch,
          (v) => (ch = v)
        ),
      ]),
      h('div', { class: 'mrow' }, [
        h('span', { class: 'mlbl' }, 'Sample rate'),
        PE.ui.controls.seg(
          [
            { v: 0, text: 'Project (' + rate() / 1000 + ' kHz)' },
            { v: 44100, text: '44.1 kHz' },
            { v: 48000, text: '48 kHz' },
          ].filter((x, i, arr) => i === 0 || x.v !== rate()),
          sr,
          (v) => (sr = v)
        ),
      ]),
    ];
    if (hasRange() && !o.only)
      body.push(
        h('div', { class: 'mrow' }, [
          h('span', { class: 'mlbl' }, 'Part'),
          PE.ui.controls.seg(
            [
              { v: 'all', text: 'Everything' },
              { v: 'sel', text: 'Selection (' + PE.fmtTime(sel.t1 - sel.t0, 1) + ')' },
            ],
            part,
            (v) => (part = v)
          ),
        ])
      );
    if (o.only) body.unshift(h('p', { class: 'p-note' }, 'Only the track “' + trackOf(o.only).name + '” is saved.'));
    PE.ui.dialog({
      title: 'Download audio',
      body,
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Download',
          primary: true,
          onClick: async () => {
            stop();
            PE.ui.busy(true, 'Mixing the tracks', 0.05);
            try {
              const a = part === 'sel' ? sel.t0 : 0,
                b = part === 'sel' ? sel.t1 : duration();
              const buf = await render(a, b, { channels: ch, rate: sr || rate(), only: o.only });
              let bytes, mime, ext;
              if (fmt === 'mp3') {
                PE.ui.busy(true, 'Encoding MP3', 0.2);
                bytes = await PE.encodeMp3(buf, kbps, (f) => PE.ui.busy(true, 'Encoding MP3', 0.2 + f * 0.8));
                mime = 'audio/mpeg';
                ext = 'mp3';
              } else {
                bytes = PE.encodeWav(buf, bits);
                mime = 'audio/wav';
                ext = 'wav';
              }
              const base = PE.app.fileName.replace(/\.[^.]+$/, '') + (o.only ? ' - ' + trackOf(o.only).name : '') + (part === 'sel' ? ' (selection)' : '');
              PE.download2(bytes, base + '.' + ext, mime);
              if (!o.only && part === 'all') {
                PE.app.dirty = false;
                PE.ui.updateHistoryButtons();
              }
              PE.toast(`Downloaded ${base}.${ext} (${PE.fmtBytes(bytes.length)})`, 'ok');
            } catch (e) {
              console.error(e);
              PE.toast('Could not save the audio: ' + (e.message || e), 'error', 7000);
            } finally {
              PE.ui.busy(false);
            }
          },
        },
      ],
    });
  }
  A.download = () => exportDialog();
  A.downloadMenu = (anchor) =>
    PE.ui.menu(anchor, [
      { label: 'MP3', icon: 'music', kbd: PE.isMac ? '⌘S' : 'Ctrl+S', onClick: () => exportDialog({ fmt: 'mp3' }) },
      { label: 'WAV (lossless)', icon: 'wave', onClick: () => exportDialog({ fmt: 'wav' }) },
      '-',
      { label: 'Use in the video editor', icon: 'video', onClick: toVideo },
    ]);
  async function toVideo() {
    if (!P.tracks.some((t) => t.clips.length)) return PE.toast('There is no audio yet.', 'warn');
    PE.ui.busy(true, 'Mixing', 0.3);
    const buf = await render(0, duration());
    const bytes = PE.encodeWav(buf, 16);
    PE.ui.busy(false);
    const name = PE.app.fileName.replace(/\.[^.]+$/, '') + '.wav';
    PE.app.dirty = false;
    PE.app.openMedia('video', [new File([bytes], name, { type: 'audio/wav' })], { force: true });
  }
  A.moreItems = () => [
    { label: 'New audio project', icon: 'music', onClick: () => PE.app.newAudio() },
    { label: 'Add audio or video as a track…', icon: 'upload', onClick: importPicker },
    { label: 'Record', icon: 'mic', onClick: () => record() },
    '-',
    { label: 'Select all', icon: 'wave', kbd: PE.isMac ? '⌘A' : 'Ctrl+A', onClick: selectAll },
    { label: 'Keep only the selection', icon: 'crop', disabled: !hasRange(), onClick: keepOnly },
    { label: 'Mix down to one track', icon: 'layers', disabled: !P || !P.tracks.length, onClick: mixdownToTrack },
    { label: 'Effects…', icon: 'fx', onClick: () => ((panelTab = 'fx'), document.body.classList.remove('mpanel-min'), refreshPanel()) },
  ];
  A.shortcuts = (k) => [
    ['Play / pause', 'Space'],
    ['Go to start / end', 'Home / End'],
    ['Move the playhead', '← / → (Shift: 5 s)'],
    ['Record', 'R'],
    ['Split at the playhead', 'S'],
    ['Loop the selection', 'L'],
    ['Cut / Copy / Paste', `${k}X / ${k}C / ${k}V`],
    ['Delete the selection or clip', 'Delete'],
    ['Duplicate', `${k}D`],
    ['Select all', `${k}A`],
    ['Undo / Redo', `${k}Z / ${k}Shift+Z`],
    ['Zoom', `${k}+ / ${k}− or ${k}+wheel`],
    ['Fit the project', `${k}0`],
    ['Download', `${k}S`],
  ];

  /* =========================================================
   *  keyboard
   * ========================================================= */
  A.onKey = function (e) {
    if (e.type !== 'keydown' || !P) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) && !(t.type === 'range' && e.key === ' ')) return;
    const mod = PE.mod(e);
    const k = e.key.toLowerCase();
    const go = (fn) => (e.preventDefault(), fn(), true);
    if (mod && k === 'z') return go(() => (e.shiftKey ? A.redo() : A.undo()));
    if (mod && k === 'y') return go(A.redo);
    if (mod && k === 'x') return go(cut);
    if (mod && k === 'c') return go(copy);
    if (mod && k === 'v') return go(paste);
    if (mod && k === 'd') return go(duplicate);
    if (mod && k === 'a') return go(selectAll);
    if (mod && (k === '=' || k === '+')) return go(A.zoomIn);
    if (mod && k === '-') return go(A.zoomOut);
    if (mod && k === '0') return go(zoomFit);
    if (mod) return;
    if (k === ' ') return go(togglePlay);
    if (k === 'home') return go(() => seek(0));
    if (k === 'end') return go(() => seek(duration()));
    if (k === 'arrowleft' || k === 'arrowright') return go(() => seek(ph + (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 5 : 1)));
    if (k === 'delete' || k === 'backspace') return go(del);
    if (k === 's') return go(splitHere);
    if (k === 'r') return go(() => (rec ? stopRecording() : record()));
    if (k === 'l') return go(() => ((loop = !loop), syncBar()));
    if (k === 'escape') return go(() => ((sel.t0 = sel.t1 = 0), (sel.clip = null), refreshPanel(), draw()));
  };
})();
