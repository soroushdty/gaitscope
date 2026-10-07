(function () {
  'use strict';
  const C = window.StepCore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fmt = C.fmt;

  const S = {
    file: null,        // {name, size, kind}
    fileChecks: [],    // file-level checks
    mat: null,         // {cands, notes}
    ds: null,          // dataset
    dsChecks: [],
    chanKey: null,
    ch: null,          // prepared channel
    res: null,         // detection results
    notes: [],         // [{plot, kind, x, y, text}] pinned by the user (C.noteOf, #80); never change the steps
    noteDraft: null,   // the note being written: {plot, kind, x, y}
    plotReady: false,
  };

  /* ---------------------------------------------------------- utilities */
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function withAlpha(hex, a) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? 'rgba(' + [1, 2, 3].map(k => parseInt(m[k], 16)).join(',') + ',' + a + ')' : hex;
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function niceStep(range) {
    const raw = range / 200, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function decimalsFor(step) { return Math.max(0, Math.min(4, -Math.floor(Math.log10(step)))); }

  /* ------------------------------------------------------------ loading */
  function showRs() {
    const m = $('rsSel').value;
    $('rsRateRow').hidden = m !== 'rate';
    $('rsOpts').hidden = m === 'off';
    $('rsDesc').textContent = { off: 'Samples are used as recorded.', even: 'An even grid at the recording\u2019s own rate: steadies phone timing without changing the rate.',
      rate: 'Everything after this step, Coza included, gets samples at this rate.' }[m];
  }

  function resetAll() {
    $('posSel').value = 'hand'; updatePosHint();
    showPass = false;
    S.fileChecks = []; S.mat = null; S.ds = null; S.dsChecks = []; S.ch = null; S.chRaw = null; S.rs = null; S.res = null;
    S.notes = []; closeNoteForm();
    S.recording = null; $('saveRec').hidden = true; S.counted = null; S.countedBy = null; // 'hand' or 'demo'
    dropPlainUndo();
    S.recordingSaved = false; S.clean = null; // see Home
    demoSeq++; // a demo still being fetched is no longer wanted
  }

  async function handleFile(file) {
    resetAll();
    S.file = { name: file.name, size: file.size };
    showFileChip();
    $('empty').hidden = true; $('work').hidden = false;
    revealWork();
    if (file.size > C.MAX_BYTES) {
      return fatal('The file is ' + (file.size / 1048576).toFixed(0) + ' MB, over the 50 MB limit.', 'Trim the recording or export only the channels you need.');
    }
    if (file.size === 0) return fatal('The file is empty.', 'Check that the export or download finished.');
    let buf;
    try { buf = new Uint8Array(await file.arrayBuffer()); }
    catch (e) { return fatal('The browser could not read this file.', 'Try choosing it again.'); }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isText = C.looksLikeText(buf);
    try {
      // MATLAB v7.3 (HDF5): fetch the HDF5 reader first, the only time it is needed
      if (!isText && C.isZip(buf)) loadZip(buf);
      else if (!isText && C.isMat73(buf)) loadMat(buf, await loadHdf5().catch(() => null));
      else if (ext === 'mat' && !isText) loadMat(buf);
      else if (isText) {
        const text = new TextDecoder('utf-8').decode(buf);
        if (ext === 'json' || /^\s*\{/.test(text)) loadExportJson(text); else loadCsv(text, ext === 'mat');
      }
      else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
        return fatal('This file has a text extension but contains binary data.', 'If it is a MATLAB file, rename it to .mat.');
      } else if (ext === 'zip') {
        return fatal('This file is named .zip but is not a zip archive.', 'Export it again, or upload the CSV or MAT file itself.');
      } else loadMat(buf);
      if (S.ch) markClean();
    } catch (e) {
      if (e instanceof C.InputError) return fatal(e.message, e.fix);
      console.error(e);
      return fatal('The file could not be read: ' + e.message, 'If it opens in MATLAB, re-save it with save(\'file.mat\',\'-v7\') or export it as CSV.');
    }
  }

  /* Demo walks: two of the owner's phone recordings, bundled in demo/ and fetched when picked,
     and the synthetic walk (core.js demoWalk). A recording loads like an uploaded file, with the
     steps counted by hand; the synthetic walk carries its true count. */
  const DEMOS = {
    hand: { file: 'demo/walk-hand.csv', title: 'Hand walk',
      about: 'Recorded with this page on a Pixel 9a (Firefox) on 2026-10-07 by Dr. Soroush Dianaty: the phone held flat, in portrait, at the chest just below the breastbone, for exactly 10 steps. The last step brings the feet together, then comes a pause while Stop is held. The plot opens on the total (TgF), which doesn’t depend on how the phone is held.' },
    pocket: { file: 'demo/walk-pocket.csv', title: 'Pocket walk',
      about: 'Recorded with this page on a Pixel 9a (Firefox) on 2026-10-07 by Dr. Soroush Dianaty: the phone in the right front trouser pocket for exactly 28 steps. The first 2 s are the phone going into the pocket, and the last 4 s taking it out and holding Stop; detectors count some of that as steps. The plot opens on the total (TgF), which doesn’t depend on how the phone sits in the pocket.' },
    // no step count: nothing to score the detectors against (#91)
    noisy: { file: 'demo/walk-noisy.csv', title: 'Noisy walk',
      about: 'Recorded with this page on a Pixel 9a (Firefox) on 2026-10-07 by Dr. Soroush Dianaty, changing how the phone was held: flat in front (0–5.5 s), at the side with the arm swinging (6.5–14 s), flat in front again (15.5–22 s), in the left hand at the side (23–26 s), then flat and nearly still at chest level. Each change shows as a jump in the separate axes, and the detectors disagree with each other. The steps weren’t counted, so there is nothing to score them against; the spectrum’s walking rhythm, about 99 steps a minute, suggests about 70. The plot opens on the total (TgF).' },
  };
  let demoSeq = 0;
  function loadDemo(id) {
    for (const m of document.querySelectorAll('.demo-menu')) m.open = false;
    return DEMOS[id] ? loadRecordedDemo(DEMOS[id]) : loadSynthetic();
  }
  async function loadRecordedDemo(demo) {
    resetAll();
    const seq = demoSeq;
    S.file = { name: demo.title + ' (demo)', size: 0, demo: true, title: demo.title };
    showFileChip();
    $('empty').hidden = true; $('work').hidden = false;
    revealWork();
    let text;
    try {
      const r = await fetch(demo.file);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    } catch (e) {
      if (seq === demoSeq) fatal('The demo recording could not be loaded (' + e.message + ').', 'Check the internet connection and pick it again. If the page was opened as a file on this computer, serve its folder instead (python3 -m http.server) and open it from there.');
      return;
    }
    if (seq !== demoSeq) return; // another file or demo was opened meanwhile
    S.file.size = text.length; showFileChip();
    S.fileChecks = [{ level: 'info', title: 'Demo recording', detail: demo.about }];
    try { loadCsv(text); } catch (e) {
      if (e instanceof C.InputError) return fatal(e.message, e.fix);
      throw e;
    }
    if (S.ch) markClean();
  }

  function loadSynthetic() {
    resetAll();
    S.file = { name: 'Synthetic walk (demo)', size: 0, demo: true, title: 'Synthetic walk' };
    showFileChip();
    $('empty').hidden = true; $('work').hidden = false;
    revealWork();
    $('varRow').hidden = true;
    S.varName = null;
    const d = C.demoWalk();
    S.counted = d.steps; S.countedBy = 'demo'; // its true count, to score each detector against
    S.fileChecks = [{ level: 'info', title: 'Demo data', detail: 'A generated 22 s walk sampled near 100 Hz with irregular timing and values rounded to 0.01, like a phone recording.' }];
    setDataset(d.names, d.cols, 'csv');
    markClean();
  }

  // jsfive reads HDF5 (MATLAB v7.3) in plain JavaScript; pinned like the other two libraries
  const HDF5_URL = 'https://cdn.jsdelivr.net/npm/jsfive@0.4.2/dist/browser/hdf5.js';
  let hdf5Loading = null;
  function loadHdf5() {
    if (window.hdf5) return Promise.resolve(window.hdf5);
    return hdf5Loading || (hdf5Loading = new Promise((resolve, reject) => {
      const s = document.createElement('script'), fail = () => { hdf5Loading = null; s.remove(); reject(new Error('jsfive did not load')); };
      const timer = setTimeout(fail, 20000);
      s.src = HDF5_URL;
      s.onload = () => { clearTimeout(timer); window.hdf5 ? resolve(window.hdf5) : fail(); };
      s.onerror = () => { clearTimeout(timer); fail(); };
      document.head.appendChild(s);
    }));
  }

  // hdf5 given (even null): the file is MATLAB v7.3; otherwise a v5–v7 MAT-file
  function loadMat(buf, hdf5) {
    let parsed;
    if (hdf5 !== undefined) parsed = C.parseMat73(buf, hdf5);
    else {
      if (typeof pako === 'undefined') throw new C.InputError('The decompression library did not load.', 'Check your internet connection and reload the page.');
      parsed = C.parseMat(buf, u8 => pako.inflate(u8));
    }
    const { cands, notes } = C.matCandidates(parsed.variables);
    S.mat = { cands, notes };
    S.fileChecks.push({ level: 'pass', title: parsed.v73 ? 'MATLAB v7.3 file read' : 'MATLAB file read', detail: (parsed.v73 ? 'HDF5 format, read with jsfive. ' : '') + parsed.variables.length + ' variable' + (parsed.variables.length === 1 ? '' : 's') + ' found: ' + (parsed.variables.map(v => v.name + ' (' + v.cls + (v.dims.length ? ', ' + v.dims.join('×') : v.className ? ' ' + v.className : '') + ')').join(', ') || 'none') + '.' });
    for (const n of notes) S.fileChecks.push({ level: 'warn', title: 'Skipped ' + n.path, detail: n.reason, fix: n.fix });
    for (const c of cands.filter(c => !c.ok)) S.fileChecks.push({ level: 'info', title: 'Skipped ' + c.path, detail: '"' + c.path + '" ' + c.reason + '.' });
    const ok = cands.filter(c => c.ok);
    if (!ok.length) {
      const fixes = notes.map(n => n.fix).filter(Boolean);
      return fatal('No usable numeric data found in this file.', fixes[0] || 'Save your samples as a numeric matrix with samples down the rows, e.g. save(\'file.mat\',\'A\',\'-v7\').', true);
    }
    const sel = $('varSel');
    sel.innerHTML = ok.map((c, i) => '<option value="' + i + '">' + esc(c.path) + ' (' + c.dims.join('×') + ', ' + c.cls + ')</option>').join('');
    // prefer the largest matrix
    let best = 0;
    ok.forEach((c, i) => { if (c.dims[0] * c.dims[1] > ok[best].dims[0] * ok[best].dims[1]) best = i; });
    sel.value = String(best);
    $('varRow').hidden = ok.length < 2;
    selectMatVar(best);
  }

  function selectMatVar(i) {
    const cand = S.mat.cands.filter(c => c.ok)[i];
    const { cols, transposed, origDims } = C.matToColumns(cand);
    const extra = [];
    if (transposed) extra.push({ level: 'warn', title: 'Matrix rotated', detail: '"' + cand.path + '" is stored as ' + origDims.join('×') + '. It was read as ' + cols[0].length + ' samples × ' + cols.length + ' channel' + (cols.length > 1 ? 's' : '') + ', since samples should run down the rows.' });
    S.varName = cand.path;
    setDataset(cols.map((_, k) => 'Column ' + (k + 1)), cols, 'mat', extra);
  }

  // a phyphox export: the data CSV inside, with the phone and recording details as checks
  function loadZip(buf) {
    if (typeof pako === 'undefined') throw new C.InputError('The decompression library did not load.', 'Check your internet connection and reload the page.');
    const z = C.readPhyphoxZip(buf, u8 => pako.inflateRaw(u8));
    S.fileChecks.push(...z.checks);
    loadCsv(z.text);
  }

  // a walk recorded in the browser (#51): loaded through the CSV path, like an upload
  function loadRecording(r) {
    resetAll();
    S.file = { name: r.name, size: r.csv.length };
    showFileChip();
    $('empty').hidden = true; $('work').hidden = false;
    revealWork();
    S.fileChecks = r.checks.slice();
    try { loadCsv(r.csv); } catch (e) {
      if (e instanceof C.InputError) return fatal(e.message, e.fix);
      throw e;
    }
    S.recording = r;
    $('saveRec').hidden = false;
    if (S.ch) markClean();
  }

  /* A JSON export (#53) reopened: its signal at its times, then every control and the notes
     as they were, so the same steps and metrics come out. */
  function loadExportJson(text) {
    const m = C.parseExportJson(text), a = m.about, st = m.settings || {};
    S.varName = null;
    $('varRow').hidden = true;
    $('rsSel').value = 'off'; showRs(); // the exported signal is the analysed one, already resampled if it was
    S.fileChecks.push({ level: 'info', title: 'GaitScope export reopened', detail: 'Exported ' + (a.exported || '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC') + ' by the ' + a.generator.replace('gaitscope ', '') + ' (version ' + a.version + ') from "' + a.file + '"' +
      (a.variable ? ', variable ' + a.variable : '') + ', signal ' + a.signal + '. The signal is loaded as it was analysed' + (/Hz/.test(st.resample || '') ? ' (already resampled: ' + st.resample + ')' : '') + ', and the settings and notes are restored.' });
    const known = Number(st.steps_counted_by_hand) > 0 ? ['hand', st.steps_counted_by_hand] : Number(st.steps_in_synthetic_walk) > 0 ? ['demo', st.steps_in_synthetic_walk] : [null, null];
    S.countedBy = known[0]; S.counted = known[1] === null ? null : Number(known[1]);
    setDataset(['time', a.signal_name || a.signal || 'signal'], [m.signals.time_s, m.signals.signal], 'csv');
    if (!S.ch) return;
    S.notes = C.exportNotes(m);
    restoreExport(m);
  }
  // Every control and indicator from an export. Format 1 (before indicators) had the course
  // code always on, one algorithm and at most one envelope; they become Coza, that algorithm
  // and that envelope.
  function restoreExport(m) {
    const pr = m.params || {};
    const pick = (id, v) => { if (v !== undefined && [...$(id).options].some(o => o.value === String(v))) $(id).value = String(v); };
    pick('filterSel', pr.filter); pick('posSel', pr.phone_position); pick('wholeSel', pr.freqWhole); pick('timeSel', pr.freqTime); showMethodTags();
    for (const el of optionInputs()) {
      const v = pr[el.dataset.param];
      if (v === undefined || v === null) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
      updateOptionOut(el);
    }
    S.ind = [];
    const own = (kind, type) => { const def = registry(kind).find(d => d.id === type); return def ? Object.fromEntries((def.params || []).filter(q => pr[q.key] !== undefined).map(q => [q.key, pr[q.key]])) : {}; };
    if (m.indicators && m.indicators.id) {
      m.indicators.id.forEach((id, k) => {
        let p = {};
        try { p = JSON.parse(m.indicators.params[k]); } catch (e) { /* defaults */ }
        addIndicator(m.indicators.kind[k], m.indicators.type[k], p, { color: '--' + m.indicators.color[k], source: m.indicators.source[k] });
      });
    } else {
      if (pr.show_lab !== false) addIndicator('detector', 'coza_original', { w: pr.w, h: pr.h }, { source: 'recorded' });
      if (pr.algorithm) addIndicator('detector', pr.algorithm, own('detector', pr.algorithm));
      if (pr.envelope && pr.envelope !== 'none') addIndicator('envelope', pr.envelope, own('envelope', pr.envelope));
    }
    showFilter(); updatePosHint();
    configureSliders();
    recompute();
  }

  function loadCsv(text, wasMat) {
    const p = C.parseCsv(text);
    S.varName = null;
    const pre = [];
    if (wasMat) pre.push({ level: 'warn', title: 'Text file with a .mat extension', detail: 'The file contains text, so it was read as CSV.' });
    pre.push({ level: 'pass', title: 'CSV read', detail: (p.hasHeader ? 'Header row found. ' : 'No header row. ') + 'Separated by ' + ({ ',': 'commas', ';': 'semicolons', '\t': 'tabs' }[p.delim] || 'commas') + (p.decimalComma ? ' with decimal commas' : '') + (p.clockTime ? '; clock times converted to seconds' : '') + '.' });
    if (p.dropped.length) pre.push({ level: 'info', title: 'Text columns skipped', detail: p.dropped.join(', ') + ' contain mostly non-numeric values.' });
    if (!p.cols.length) throw new C.InputError('No numeric columns found in the CSV.', 'Export the sensor data as numbers, one column per channel.');
    // a recording made in the browser says how it was made, and may say where the phone was
    const m = p.meta;
    if (/^gaitscope/.test(m.recorder || '')) {
      const said = [m.steps_counted ? m.steps_counted + ' steps counted by hand' : '', m.phone_position ? 'phone in the ' + m.phone_position.replace('front pocket', 'front trouser pocket').replace('back pocket', 'back trouser pocket').replace('other', 'phone somewhere else').replace(/^phone in the phone /, '') : ''].filter(Boolean);
      pre.push({ level: 'info', title: 'Recorded in the browser', detail: 'From the phone\u2019s motion sensors (devicemotion)' + (m.started ? ', started ' + m.started.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '') +
        (m.sample_rate_hz ? ', about ' + m.sample_rate_hz + ' Hz, every sample at its own time' : '') + '. x, y, z are in g with gravity, like Physics Toolbox\u2019s G-Force Meter; the ax and wx columns are linear acceleration (m/s²) and rotation (rad/s).' +
        (said.length ? ' Recorded with: ' + said.join(', ') + '.' : '') +
        (Number(m.trimmed_end_s) > 0 ? ' The last ' + C.fmt(Number(m.trimmed_end_s), 1) + ' s, from just before Stop was touched, was left out.' : '') });
    }
    S.counted = /^\d+$/.test(m.steps_counted || '') && Number(m.steps_counted) > 0 ? Number(m.steps_counted) : null;
    S.countedBy = S.counted ? 'hand' : null;
    // iPhone and iPad give acceleration reversed; the recorder flips it since #96 and says so
    if (/^gaitscope/.test(m.recorder || '') && /^flipped/.test(m.acceleration_sign || '')) {
      pre.push({ level: 'info', title: 'Acceleration flipped to Android\u2019s directions', detail: 'Recorded on an iPhone or iPad, whose browsers give acceleration with the opposite sign from Android and Physics Toolbox (an iPad lying screen up read \u22120.98 g on z, 2026-10-07). The recorder flipped x, y and z, with and without gravity, so lying screen up reads +1 g on z here too. The rotation rate is as the browser gave it, which already matches Android\u2019s (an iPad turned left while lying flat gave a positive rate about z).' });
    } else if (/^gaitscope/.test(m.recorder || '') && /iPhone|iPad|iPod/.test(m.device || '')) {
      pre.push({ level: 'warn', title: 'Acceleration signs reversed (iPhone or iPad)', detail: 'Recorded on an iPhone or iPad before the recorder flipped the signs: Apple\u2019s browsers give acceleration with the opposite sign from Android and Physics Toolbox, so lying screen up reads \u22121 g on z instead of +1, and x and y are reversed too. The total, vertical and horizontal don\u2019t depend on the sign.', fix: 'Use the total or the vertical, or record again with the current page. On a single axis, h needs the opposite sign.' });
    }
    if (m.phone_position === 'front pocket') $('posSel').value = 'leg';
    else if (m.phone_position === 'hand') $('posSel').value = 'hand';
    updatePosHint();
    $('varRow').hidden = true;
    S.fileChecks = S.fileChecks.concat(pre);
    setDataset(p.names, p.cols, 'csv');
  }

  function setDataset(names, cols, source, extraChecks) {
    try {
      S.ds = C.buildDataset(names, cols, source);
    } catch (e) {
      if (e instanceof C.InputError) return fatal(e.message, e.fix);
      throw e;
    }
    S.dsChecks = (extraChecks || []).concat(S.ds.checks);
    const opts = [];
    S.ds.columns.forEach((c, k) => { if (c.role !== 'time') opts.push({ key: String(k), label: c.label }); });
    if (S.ds.x && S.ds.y && S.ds.z && !S.ds.mag) opts.push({ key: 'computed', label: 'magnitude (computed from x, y, z)' });
    if (S.ds.x && S.ds.y && S.ds.z) {
      // vertical and horizontal need gravity in the recording; without it they stay listed, disabled, with the reason
      const gs = C.gravitySplit(S.ds, Number($('fsIn').value) || 100);
      opts.push(gs.ok ? { key: 'vertical', label: 'vertical (along gravity, computed)' } : { key: 'vertical', label: 'vertical: not available, ' + gs.reason, disabled: true });
      if (gs.ok) opts.push({ key: 'horizontal', label: 'horizontal (across gravity, computed)' });
    }
    $('chanSel').innerHTML = opts.map(o => '<option value="' + o.key + '"' + (o.disabled ? ' disabled' : '') + '>' + esc(o.label) + '</option>').join('');
    let def = opts[0].key;
    if (source === 'mat') { const c2 = S.ds.columns.find(c => c.matCol === 2 && c.role !== 'time'); if (c2) def = String(c2.index); }
    // A phone's own acceleration export (Physics Toolbox, phyphox, the recorder) opens on its
    // total: one axis depends on how the phone is held, and for a phone held flat x is the
    // sideways sway, where Coza finds nothing at h = 1 (owner's decision, 2026-10-07).
    else if (S.ds.mag && S.ds.mag.sensor && S.ds.mag.sensor.accel) def = String(S.ds.mag.index);
    $('chanSel').value = def;
    $('dataControls').hidden = false;
    $('fsRow').hidden = !!S.ds.t;
    resetParams(false);
    selectChannel(def);
  }

  function selectChannel(key) {
    S.chanKey = key;
    const fsManual = Number($('fsIn').value) || 100;
    const ch = C.prepareChannel(S.ds, COMPUTED[key] ? key : Number(key), fsManual);
    S.chRaw = ch.fatal ? null : ch;
    S.chRawChecks = ch.checks;
    if (ch.fatal) {
      S.ch = null; S.rs = null; S.chChecks = ch.checks;
      $('analysis').hidden = true;
      setControlsEnabled(false);
      renderValidation([]);
      return;
    }
    applyResample();
  }

  /* Resample (#52): the recorded channel S.chRaw, put on an even grid when the user asks.
     S.ch is what everything downstream uses: the filter, the step detectors,
     the spectrum and the exports. Settings that can't be used leave S.ch = S.chRaw. */
  function rsOptions() {
    const rate = $('rsRate').value.trim();
    return { mode: $('rsSel').value, rate: rate === '' ? NaN : Number(rate), method: $('rsMethod').value, antialias: $('rsAA').checked };
  }
  function applyResample() {
    if (!S.chRaw) return;
    const o = rsOptions();
    S.rs = o.mode === 'off' ? null : C.resampleChannel(S.chRaw, o);
    const on = !!(S.rs && S.rs.applied);
    S.ch = on ? S.rs : S.chRaw;
    // the 100 Hz check is about what Coza receives, so the resampled one replaces it
    S.chChecks = (on ? S.chRawChecks.filter(c => c.id !== 'labRate') : S.chRawChecks).concat(S.rs ? S.rs.checks : []);
    configureSliders();
    $('analysis').hidden = false;
    setControlsEnabled(true);
    S.plotReady = false;
    recompute();
  }

  // Signals computed from x, y, z rather than read from a column (keys in the Signal select).
  const COMPUTED = { computed: 'magnitude (computed)', vertical: 'vertical (computed)', horizontal: 'horizontal (computed)' };
  function chanInfo() {
    if (COMPUTED[S.chanKey]) return { label: COMPUTED[S.chanKey], unit: S.ds.x.sensor ? S.ds.x.sensor.unit : '' };
    const col = S.ds.columns[Number(S.chanKey)];
    return { label: col.label, unit: col.sensor ? col.sensor.unit : '' };
  }

  function fatal(msg, fix, keepFileChecks) {
    if (!keepFileChecks) S.fileChecks = [];
    S.fileChecks.push({ level: 'error', title: msg, detail: '', fix });
    S.ds = null; S.ch = null; S.chRaw = null; S.rs = null; S.dsChecks = []; S.chChecks = [];
    $('dataControls').hidden = true;
    $('analysis').hidden = true;
    setControlsEnabled(false);
    renderValidation([]);
  }

  function revealWork() {
    requestAnimationFrame(() => {
      const r = $('work').getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight * 0.6) $('work').scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  }
  function showFileChip() {
    const chip = $('fileChip');
    chip.hidden = false;
    $('subtitle').hidden = true; // the empty state explains this; once a file is in, the plot needs the room
    $('homeBtn').hidden = false;
    chip.innerHTML = '<strong title="' + esc(S.file.name) + '">' + esc(S.file.name) + '</strong>' + (S.file.size ? '<br>' + (S.file.size < 1048576 ? (S.file.size / 1024).toFixed(1) + ' KB' : (S.file.size / 1048576).toFixed(1) + ' MB') : '');
  }

  function setControlsEnabled(on) {
    for (const b of document.querySelectorAll('[data-preset]')) b.disabled = !on;
    for (const b of document.querySelectorAll('[data-rs-rate]')) b.disabled = !on;
    // the indicator lists stay usable without a recording, so a set can be prepared first
    for (const id of ['rsSel', 'rsRate', 'rsMethod', 'rsAA', 'filterSel', 'posSel', 'showIntervals', 'noteMode', 'specNoteMode', 'resetParams', 'plainBtn']) $(id).disabled = !on;
    for (const el of optionInputs()) el.disabled = !on;
    updateExportButtons();
  }

  /* ----------------------------------------------------------- controls */
  function configureSliders() {
    // the low-pass cut-off must stay below half the sampling rate (largest 0.5 Hz step under it)
    const fLow = $('fLowIn');
    fLow.max = String(Math.max(0.5, Math.min(20, (Math.ceil(S.ch.fs / 2 / 0.5) - 1) * 0.5)));
    if (Number(fLow.value) > Number(fLow.max)) fLow.value = fLow.max;
    const notch = $('notchFIn');
    notch.max = String(Math.max(1, Math.min(100, (Math.ceil(S.ch.fs / 2 / 0.5) - 1) * 0.5)));
    if (Number(notch.value) > Number(notch.max)) notch.value = notch.max;
    for (const el of optionInputs()) updateOptionOut(el);
    renderIndicators(); // h's slider spans the signal; windows show their length in samples
  }
  // The page-wide options under Advanced (filter) and in Frequency domain (spectrum) carry data-param (their key in
  // params()). An <output for=…> with data-unit shows the value with data-dec decimals.
  // data-zero: text shown for 0 (e.g. "off"); data-unit="order": "4th order"; "ordinal": "10th".
  // the page-wide options: Advanced (filter) and the Frequency domain section's settings (#101)
  const optionInputs = scope => document.querySelectorAll(scope === 'adv' ? '#advSec input[data-param]' : scope === 'freq' ? '#freqSec input[data-param]' : '#advSec input[data-param], #freqSec input[data-param]');
  const ordinal = n => n + ([, 'st', 'nd', 'rd'][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] || 'th');
  function updateOptionOut(el) {
    const out = document.querySelector('output[for="' + el.id + '"][data-unit]');
    if (!out) return;
    const v = Number(el.value), u = out.dataset.unit;
    out.textContent = v === 0 && out.dataset.zero ? out.dataset.zero : u === 'order' ? ordinal(v) + ' order' : u === 'ordinal' ? ordinal(v)
      : fmt(v, Number(out.dataset.dec || 0)) + (u === '%' ? '%' : u ? ' ' + u : '');
  }
  function resetParams(run, scope) {
    for (const el of optionInputs(scope)) { if (el.type === 'checkbox') el.checked = el.defaultChecked; else el.value = el.defaultValue; updateOptionOut(el); }
    if (run !== false && S.ch) recompute();
  }
  function updatePosHint() {
    $('posHint').textContent = $('posSel').value === 'leg' ? 'Each peak is a stride: a left plus a right step.' : 'Each peak is one step.';
  }
  function showFilter() {
    const f = $('filterSel').value;
    const def = C.FILTERS.find(x => x.id === f);
    $('filterDesc').textContent = def.tagline;
    $('filterCredit').innerHTML = def.credit.length ? creditHtml(def.credit) : '';
    $('filterCredit').hidden = !def.credit.length;
    $('filterOpts').hidden = f === 'none';
    for (const el of $('filterOpts').querySelectorAll('[data-only]')) el.hidden = !el.dataset.only.split(' ').includes(f);
  }
  // page-wide settings; each indicator adds its own (indParams)
  function params() {
    const p = { fs: S.ch ? S.ch.fs : 100, filter: $('filterSel').value, stride: $('posSel').value === 'leg', // stride: a peak per stride
      freqWhole: $('wholeSel').value, freqTime: $('timeSel').value }; // the Frequency domain views (#101)
    for (const el of optionInputs()) p[el.dataset.param] = el.type === 'checkbox' ? el.checked : Number(el.value);
    return p;
  }

  /* --------------------------------------------------------- indicators */
  // Step detectors and envelopes on the plot, like a chart's indicators: any number of each,
  // in any mix, each with its own settings (built from its schema in core.js), colour and
  // source signal. S.ind: [{uid, kind: 'detector' | 'envelope', type, p, color, visible,
  // source: 'filtered' | 'recorded', open}].
  const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
  const SYMBOLS = ['triangle-down', 'circle', 'square', 'diamond', 'cross', 'star'];
  let uidSeq = 0;
  const registry = kind => (kind === 'detector' ? C.ALGORITHMS : C.ENVELOPES);
  const defOf = ind => registry(ind.kind).find(d => d.id === ind.type);
  function addIndicator(kind, type, p, opts) {
    const def = registry(kind).find(d => d.id === type);
    if (!def) return null;
    opts = opts || {};
    const used = new Set(S.ind.map(i => i.color));
    const ind = { uid: ++uidSeq, kind, type, p: Object.assign(C.defaultParams(def), p || {}), visible: opts.visible !== false, open: false,
      color: PALETTE.includes(opts.color) ? opts.color : PALETTE.find(c => !used.has(c)) || PALETTE[S.ind.length % PALETTE.length],
      source: opts.source === 'recorded' ? 'recorded' : 'filtered' };
    S.ind.push(ind);
    return ind;
  }
  // what the page opens with: the course's Coza and its modified version, side by side
  function defaultIndicators() { S.ind = []; addIndicator('detector', 'coza_original'); addIndicator('detector', 'coza'); }
  // "Coza", or "Coza 2" for a second one of the same kind
  function labelOf(ind) {
    const same = S.ind.filter(i => i.kind === ind.kind && i.type === ind.type);
    return defOf(ind).name + (same.length > 1 ? ' ' + (same.indexOf(ind) + 1) : '');
  }
  const detectors = () => S.ind.filter(i => i.kind === 'detector');
  const shown = kind => S.ind.filter(i => i.kind === kind && i.visible);
  const colorOf = ind => cssVar(ind.color);
  const symbolOf = ind => SYMBOLS[detectors().indexOf(ind) % SYMBOLS.length];
  function paramText(q, v) {
    if (q.type === 'number') return String(+Number(v).toFixed(4));
    if (q.unit === 'ordinal') return ordinal(v);
    if (q.unit === 'samples') return v + ' samples' + (S.ch ? ' (' + fmt(v / S.ch.fs, 2) + ' s)' : '');
    const base = fmt(v, q.dec || 0) + (q.unit === '%' ? '%' : q.unit ? ' ' + q.unit : '');
    return q.samples && S.ch ? base + ' (' + C.windowSamples(v, S.ch.fs, S.ch.A.length) + ' samples)' : base;
  }
  function paramControl(ind, q) {
    const id = 'ind' + ind.uid + '_' + q.key, v = ind.p[q.key], hint = q.hint ? '<small>' + esc(q.hint) + '</small>' : '';
    if (q.type === 'bool') return '<label class="check"><input type="checkbox" id="' + id + '" data-key="' + q.key + '"' + (v ? ' checked' : '') + '><span>' + esc(q.label) + '</span>' + hint + '</label>';
    if (q.type === 'number') {
      // a number box with a slider spanning the signal, as h always had
      let lo = -5, hi = 15, step = 0.05;
      if (S.ch) { step = niceStep((S.ch.max - Math.min(S.ch.min, 0)) || 1); lo = Math.floor(Math.min(S.ch.min, 0) / step) * step; hi = Math.ceil(S.ch.max / step) * step; }
      return '<div class="ctl"><div class="ctl-head"><label for="' + id + '">' + esc(q.label) + '</label><input type="number" id="' + id + '" data-key="' + q.key + '" step="' + step + '" value="' + v + '"></div>' +
        '<input type="range" data-key="' + q.key + '" data-mirror="1" min="' + lo + '" max="' + hi + '" step="' + step + '" value="' + v + '" aria-label="' + esc(q.label) + '">' + (q.hint ? '<p class="hint">' + esc(q.hint) + '</p>' : '') + '</div>';
    }
    let max = q.max;
    if (q.unit === 'samples' && S.ch) max = Math.max(1, Math.min(q.max, Math.floor((S.ch.A.length - 1) / 2) - 1));
    return '<div class="ctl"><div class="ctl-head"><label for="' + id + '">' + esc(q.label) + '</label><output for="' + id + '">' + esc(paramText(q, v)) + '</output></div>' +
      '<input type="range" id="' + id + '" data-key="' + q.key + '" min="' + q.min + '" max="' + max + '" step="' + q.step + '" value="' + Math.min(v, max) + '">' + (q.hint ? '<p class="hint">' + esc(q.hint) + '</p>' : '') + '</div>';
  }
  function indicatorItem(ind) {
    const def = defOf(ind), name = labelOf(ind), eye = ind.visible ? 'Hide' : 'Show';
    return '<li class="ind' + (ind.visible ? '' : ' off') + '" data-uid="' + ind.uid + '" style="--ic: var(' + ind.color + ')">' +
      '<div class="ind-head"><span class="sw' + (ind.kind === 'envelope' ? ' band' : '') + '" aria-hidden="true"></span>' +
      '<button class="ind-name" type="button" data-act="open" aria-expanded="' + ind.open + '">' + esc(name) + '</button>' +
      '<span class="ind-sum">' + esc(C.paramSummary(def, ind.p)) + '</span>' +
      '<button class="ind-btn" type="button" data-act="eye" aria-pressed="' + !ind.visible + '" title="' + eye + ' ' + esc(name) + '" aria-label="' + eye + ' ' + esc(name) + '">' + (ind.visible ? '◉' : '○') + '</button>' +
      '<button class="ind-btn" type="button" data-act="remove" title="Remove ' + esc(name) + '" aria-label="Remove ' + esc(name) + '">×</button></div>' +
      '<div class="ind-body"' + (ind.open ? '' : ' hidden') + '><p class="hint">' + esc(def.tagline || '') + '</p>' +
      '<label class="field">Signal<select data-act="source"><option value="filtered"' + (ind.source === 'filtered' ? ' selected' : '') + '>Filtered</option><option value="recorded"' + (ind.source === 'recorded' ? ' selected' : '') + '>Unfiltered</option></select></label>' +
      (def.params || []).map(q => paramControl(ind, q)).join('') +
      (def.summary ? '<details class="howto"><summary>How it works</summary><p>' + esc(def.summary) + '</p></details>' : '') +
      (def.credit && def.credit.length ? '<p class="hint credit">' + creditHtml(def.credit) + '</p>' : '') +
      '<p class="hint"><button class="link" type="button" data-act="reset">Default settings</button></p></div></li>';
  }
  // "Credit: Savitzky & Golay, 1964", linked to the DOI (#63). Names only, no emails.
  function creditHtml(list) {
    return 'Credit: ' + list.map(c => {
      const href = c.doi ? 'https://doi.org/' + c.doi : c.url;
      return (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(c.text) + '</a>' : esc(c.text)) + (c.note ? ' (' + esc(c.note) + ')' : '');
    }).join('; ');
  }
  function renderIndicators() {
    for (const [kind, list] of [['detector', 'detList'], ['envelope', 'envList']]) {
      const items = S.ind.filter(i => i.kind === kind);
      $(list).innerHTML = items.map(indicatorItem).join('');
      $(list).hidden = !items.length;
    }
    $('detNone').hidden = detectors().length > 0;
  }
  function indOf(el) { const li = el.closest('.ind'); return li ? S.ind.find(i => i.uid === Number(li.dataset.uid)) : null; }
  function onIndicatorInput(e) {
    const el = e.target, ind = indOf(el);
    if (!ind || !el.dataset.key) return;
    const q = defOf(ind).params.find(x => x.key === el.dataset.key);
    let v = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (q.type === 'number' && (el.value === '' || !Number.isFinite(v))) return;
    ind.p[q.key] = v;
    const li = el.closest('.ind');
    if (q.type === 'number') for (const x of li.querySelectorAll('[data-key="' + q.key + '"]')) if (x !== el) x.value = String(v); // box and slider together
    const out = li.querySelector('output[for="ind' + ind.uid + '_' + q.key + '"]');
    if (out) out.textContent = paramText(q, v);
    li.querySelector('.ind-sum').textContent = C.paramSummary(defOf(ind), ind.p);
    refresh(ind);
  }
  function onIndicatorClick(e) {
    const btn = e.target.closest('[data-act]'), ind = btn && indOf(btn);
    if (!ind || btn.tagName === 'SELECT') return;
    const act = btn.dataset.act;
    if (act === 'open') ind.open = !ind.open;
    else if (act === 'eye') ind.visible = !ind.visible;
    else if (act === 'remove') S.ind.splice(S.ind.indexOf(ind), 1);
    else if (act === 'reset') ind.p = C.defaultParams(defOf(ind));
    else return;
    renderIndicators();
    if (act !== 'open') refresh(ind);
  }
  function onIndicatorSource(e) {
    const ind = e.target.dataset.act === 'source' && indOf(e.target);
    if (!ind) return;
    ind.source = e.target.value;
    refresh(ind);
  }
  // an envelope is a view, so it only redraws; a detector changes steps and metrics
  function refresh(ind) { if (!S.ch || !S.res) return; if (ind && ind.kind === 'envelope') { computeEnvelopes(); renderPlot(); } else schedule(); }
  function onAdd(kind, sel) {
    if (!sel.value) return;
    const ind = addIndicator(kind, sel.value);
    sel.value = '';
    ind.open = true;
    renderIndicators();
    refresh(ind);
  }

  /* Signal only (#79): take away every step detector and envelope, the filter, resampling and
     the step-interval strip, to see just the signal. Notes stay. Undo puts it all back, until
     anything else is changed. */
  let plainSaved = null;
  function signalOnly() {
    if (!S.ch) return;
    plainSaved = { ind: S.ind.slice(), filter: $('filterSel').value, rs: $('rsSel').value, iv: $('showIntervals').checked };
    S.ind = []; renderIndicators();
    $('filterSel').value = 'none'; showFilter();
    $('showIntervals').checked = false;
    const rsWasOn = $('rsSel').value !== 'off';
    $('rsSel').value = 'off'; showRs();
    if (rsWasOn) applyResample(); else recompute();
    $('plainUndo').hidden = false;
  }
  function undoSignalOnly() {
    const s = plainSaved;
    if (!s || !S.ch) return;
    dropPlainUndo();
    S.ind = s.ind; renderIndicators();
    $('filterSel').value = s.filter; showFilter();
    $('showIntervals').checked = s.iv;
    const rsChanged = $('rsSel').value !== s.rs;
    $('rsSel').value = s.rs; showRs();
    if (rsChanged) applyResample(); else recompute();
  }
  function dropPlainUndo() { plainSaved = null; $('plainUndo').hidden = true; }

  /* ------------------------------------------------------------ compute */
  // the source signal an indicator runs on
  const sourceOf = ind => (ind.source === 'recorded' || !S.res.filt.applied ? S.ch.A : S.res.filt.A);
  const indParams = (ind, g) => Object.assign({}, g, ind.p);
  function recompute() {
    if (!S.ch) return;
    const g = params();
    const { A, t } = S.ch;
    // the filter and spectra depend only on the channel and their own settings, so moving a
    // detector's setting reuses them (slow on long recordings). The filter feeds every
    // indicator whose source is "Filtered".
    const filtKey = JSON.stringify([S.chanKey, g.filter, g.fOrder, g.fLow, g.fHigh, g.fRipple, g.fAtten, g.maWindow, g.medWindow, g.sgWindow, g.sgOrder, g.wLevel, g.wScale, g.notchFreq, g.notchQ]);
    if (!S.cache || S.cache.ch !== S.ch || S.cache.filtKey !== filtKey) S.cache = { ch: S.ch, filtKey, filt: C.applyFilter(A, t, S.ch.fs, g), det: new Map() };
    const filt = S.cache.filt;
    if (S.cache.specSeg !== g.specSeg) Object.assign(S.cache, { specSeg: g.specSeg, spec: C.spectrum(filt.A, t, g), specRaw: filt.applied ? C.spectrum(A, t, g) : null });
    if (S.cache.specWin !== g.specWin) {
      const rhythm = C.rhythmOverTime(filt.A, t, g);
      Object.assign(S.cache, { specWin: g.specWin, rhythm, rhythmSteps: C.spectralSteps(filt.A, t, g, rhythm) });
    }
    const { spec, specRaw, rhythm, rhythmSteps } = S.cache;
    const specCadence = spec.peak.clear ? spec.peak.freq * 60 * (g.stride ? 2 : 1) : NaN;
    // steps from the rhythm, without detecting any (#98); a cycle is a stride with One leg, as for specCadence
    const specSteps = rhythmSteps && Object.assign({}, rhythmSteps, { steps: rhythmSteps.steps * (g.stride ? 2 : 1) });
    S.res = { g, filt, spec, specRaw, rhythm, specCadence, specSteps, dets: [], envs: [] };
    // every detector, shown or not, so hiding one keeps its results for the export
    for (const ind of detectors()) {
      const p = indParams(ind, g), src = sourceOf(ind), key = JSON.stringify([ind.type, ind.p, ind.source, g.stride]);
      let r = S.cache.det.get(ind.uid);
      if (!r || r.key !== key) {
        const def = defOf(ind), fx = def.detect(src, t, p), idx = fx.idx;
        r = { key, ind, def, fx, idx, weak: fx.weakDropped || [], p, metrics: C.timingMetrics(idx, t, { stride: g.stride }),
          // on the recorded signal: a low-pass filter would remove the very harmonics it compares
          hr: C.harmonicRatio(A, t, idx, g.stride),
          // Coza's own outputs, with the .m file's formulas
          script: ind.type === 'coza_original' ? C.originalMetrics(idx, p.w) : null };
        S.cache.det.set(ind.uid, r);
      }
      r.ind = ind; r.label = labelOf(ind); r.src = src;
      S.res.dets.push(r);
    }
    computeEnvelopes();
    render();
  }
  function computeEnvelopes() {
    const g = S.res.g;
    S.res.envs = shown('envelope').map(ind => {
      const def = defOf(ind), env = def.compute(sourceOf(ind), S.ch.t, indParams(ind, g));
      return { ind, def, label: labelOf(ind), env };
    });
  }
  const shownDets = () => S.res.dets.filter(d => d.ind.visible);
  const usesH = d => (d.def.params || []).some(q => q.key === 'h');
  // checks that only matter while a given detector is on the plot (c.needs: its type)
  const needed = c => !c.needs || shownDets().some(d => d.ind.type === c.needs);

  function derivedChecks() {
    const out = [];
    if (!S.res) return out;
    const { g, filt, spec, specCadence } = S.res, dets = shownDets();
    out.push(...filt.checks);
    const hFiltered = dets.filter(d => usesH(d) && d.src !== S.ch.A);
    if (filt.applied && g.fHigh > 0 && hFiltered.length) {
      out.push({ level: 'info', title: 'h applies to the filtered signal', detail: 'The band-pass centres the signal on zero, so ' + hFiltered.map(d => d.label).join(' and ') + ' compare' + (hFiltered.length === 1 ? 's' : '') + ' h with the filtered values.' });
    }
    if (!S.res.dets.length) out.push({ level: 'info', title: 'No step detector on the plot', detail: 'Add one under Step detectors to see steps and metrics.' });
    for (const d of dets) {
      if (!d.idx.length) {
        out.push(usesH(d)
          ? { level: 'warn', title: d.label + ' finds no steps at h = ' + d.p.h, detail: 'No sample rises above the threshold as a window peak. If the data is in g, walking peaks can stay below 1; lower h (under Step detectors) or check the units.' }
          : { level: 'warn', title: d.label + ' finds no steps', detail: 'Check its settings under Step detectors, and that the signal shows walking.' });
      }
      if (d.script && d.script.tiedPairs) {
        const n = d.script.tiedPairs;
        out.push({ level: 'warn', needs: 'coza_original', title: d.label + ' counts ' + n + ' peak' + (n > 1 ? 's' : '') + ' twice', detail: 'Two nearby samples share the same peak value (the data is rounded), so Coza’s rule marks both. This adds intervals of a sample or two that inflate its variability and shift its asymmetry. ' + (dets.some(x => x.ind.type === 'coza') ? 'Coza (modified) counts each once.' : 'Add Coza (modified) under Step detectors to see each counted once.') });
      }
      if (d.weak.length) {
        out.push({ level: 'info', title: d.label + ' drops ' + d.weak.length + ' weak peak' + (d.weak.length > 1 ? 's' : ''), detail: 'At ' + d.weak.map(i => fmt(S.ch.t[i], 2) + ' s').join(', ') + '. These rise less than ' + Math.round(C.WEAK_RATIO * 100) + '% as far above h as a typical peak and come out of rhythm (closer than ' + Math.round(C.RHYTHM_RATIO * 100) + '% of the usual gap to a neighbouring peak), which usually means starting or stopping rather than a step.' });
      }
    }
    if (!spec.peak.clear) {
      out.push({ level: 'info', title: 'No clear walking rhythm in the spectrum', detail: 'No frequency between ' + C.GAIT_BAND[0] + ' and ' + C.GAIT_BAND[1] + ' Hz stands well above the rest (at least 5× the median), so there is no spectral cadence to compare with. Short or irregular walks, or mostly standing, do this.' });
    } else {
      const off = dets.filter(d => d.idx.length >= 3 && Number.isFinite(d.metrics.cadence) && (Math.abs(specCadence / d.metrics.cadence - 2) < 0.2 || Math.abs(specCadence / d.metrics.cadence - 0.5) < 0.05));
      if (off.length) out.push({ level: 'info', title: 'Spectrum and steps differ by a factor of 2', detail: 'The spectrum’s main rhythm gives ' + fmt(specCadence, 0) + ' steps/min; ' + off.map(d => d.label + ' gives ' + fmt(d.metrics.cadence, 0)).join(', ') + '. One of them is counting strides (left plus right step) rather than steps. With the phone on one leg the strongest rhythm is usually the stride; at the waist, the step.' });
    }
    // a known step count (counted by hand, or the synthetic walk's own): how close each detector comes
    const pct = (f, n) => { const off = (f - n) / n * 100; return (off > 0 ? '+' : off < 0 ? '\u2212' : '\u00b1') + fmt(Math.abs(off), 0) + '%'; };
    if (S.counted && dets.length) {
      const n = S.counted, demo = S.countedBy === 'demo';
      out.push({ level: 'info', title: demo ? 'The synthetic walk has ' + n + ' steps' : 'You counted ' + n + ' steps', detail: dets.map(d => {
        const f = d.metrics.steps, off = (f - n) / n * 100;
        return d.label + ' finds ' + f + (f === n ? ' (exactly right)' : ' (' + (off > 0 ? '+' : '') + fmt(off, 0) + '%)');
      }).join('; ') + (S.res.specSteps ? '; from the rhythm, without detecting steps, about ' + Math.round(S.res.specSteps.steps) + ' (' + pct(S.res.specSteps.steps, n) + ')' : '') + '.' + (g.stride ? ' Each peak counts as 2 steps (Phone position: one leg).' : '') + (demo
        ? ' One peak of x per step, with the phone in the hand. The walk fades in and out, so its first and last steps are faint; on y, z and the magnitude a step can make several bumps.'
        : ' Hand counts usually include the first and last step, which detectors can miss at the start and stop.') });
    }
    const slow = g.stride ? [] : dets.filter(d => d.idx.length >= 3 && d.metrics.stepInterval > 0.85 && d.metrics.stepInterval < 1.6);
    // a careful walk can be this slow too: the owner's 10 counted steps at the chest took 0.97 s each
    if (slow.length) out.push({ level: 'info', title: 'Steps may be strides, or the walk was slow', detail: slow.map(d => d.label + '’s steps are ' + fmt(d.metrics.stepInterval, 2) + ' s apart').join('; ') + ', slow for single steps (usually 0.45 to 0.7 s). Either the walk was slow (a careful walk can take a second per step), or each peak is a stride, a left plus a right step. Only for strides, set Phone position to "One leg" under Recording.' });
    return out;
  }

  /* ------------------------------------------------------------- render */
  function render() {
    renderValidation(derivedChecks());
    renderPlot();
    renderFreq();
    renderMetrics();
    renderSteps();
    renderNotes();
    updateExportButtons();
  }

  let valOpenedByUser = null, showPass = false, lastExtra = [];
  function renderValidation(extra) {
    const all = S.fileChecks.concat(S.dsChecks || [], S.chChecks || [], extra || []).filter(c => !S.res || needed(c));
    const count = lv => all.filter(c => c.level === lv).length;
    const e = count('error'), w = count('warn');
    const dot = $('valDot');
    let title, color;
    if (e) { title = 'File can’t be analysed'; color = 'var(--err)'; }
    else if (w) { title = 'Valid, with ' + w + ' warning' + (w > 1 ? 's' : ''); color = 'var(--warn)'; }
    else { title = 'Valid input'; color = 'var(--ok)'; }
    dot.style.background = color;
    $('valTitle').textContent = title;
    const parts = [];
    if (S.ds) parts.push(S.ch ? S.ch.A.length + ' samples, ' + fmt(S.ch.t[S.ch.t.length - 1] - S.ch.t[0], 1) + ' s at ' + fmt(S.ch.fs, S.ch.fs >= 100 ? 0 : 1) + ' Hz' + (S.rs && S.rs.applied ? ' (resampled)' : '') : S.ds.n + ' rows');
    parts.push(all.length + ' check' + (all.length === 1 ? '' : 's'));
    $('valSub').textContent = parts.join(', ');
    const order = { error: 0, warn: 1, info: 2, pass: 3 };
    const icon = { error: '!', warn: '!', info: 'i', pass: '✓' };
    const sorted = all.slice().sort((a, b) => order[a.level] - order[b.level]);
    const passN = sorted.filter(c => c.level === 'pass').length;
    const visible = showPass ? sorted : sorted.filter(c => c.level !== 'pass');
    $('valList').innerHTML = visible.map(c => '<li class="val-item lv-' + c.level + '"><span class="ic" aria-hidden="true">' + icon[c.level] + '</span><div><b>' + esc(c.title) + '</b>' +
      (c.detail ? '<p>' + esc(c.detail) + '</p>' : '') + (c.fix ? '<p class="fix">To fix: ' + codeify(c.fix) + '</p>' : '') + '</div></li>').join('') +
      (passN ? '<li><button class="link" type="button" id="passToggle">' + (showPass ? 'Hide passed checks' : 'Show ' + passN + ' passed check' + (passN > 1 ? 's' : '')) + '</button></li>' : '');
    const pt = $('passToggle');
    if (pt) pt.addEventListener('click', () => { showPass = !showPass; renderValidation(lastExtra); });
    lastExtra = extra;
    // collapsed to its one-line summary unless the file can't be analysed
    const expand = e > 0 || (valOpenedByUser !== null ? valOpenedByUser : false);
    setValOpen(expand);
  }
  function codeify(s) { return esc(s).replace(/([A-Za-z_][\w.]*\([^)]*\);?(?:\s*save\([^)]*\);?)?)/g, '<code>$1</code>'); }
  function setValOpen(open) { $('valToggle').setAttribute('aria-expanded', String(open)); $('valList').hidden = !open; }

  // the legend: every shown indicator, its guide lines and thresholds
  function renderLegend() {
    const sym = (d, c) => {
      const shape = { 'triangle-down': 'M1 1 H11 L6 10 Z', circle: 'M6 1 A5 5 0 1 0 6.01 1 Z', square: 'M1.5 1.5 H10.5 V10.5 H1.5 Z', diamond: 'M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z',
        cross: 'M4 1 H8 V4 H11 V8 H8 V11 H4 V8 H1 V4 H4 Z', star: 'M6 0.5 L7.6 4.4 L11.7 4.6 L8.5 7.2 L9.6 11.3 L6 9 L2.4 11.3 L3.5 7.2 L0.3 4.6 L4.4 4.4 Z' }[symbolOf(d.ind)];
      return '<svg width="12" height="12"><path d="' + shape + '" fill="' + c + '"/></svg>';
    };
    const line = (c, dash, w) => '<svg width="18" height="10"><path d="M1 5 H17" stroke="' + c + '" stroke-width="' + (w || 1.5) + '"' + (dash ? ' stroke-dasharray="3 2"' : '') + '/></svg>';
    const parts = [];
    for (const d of shownDets()) {
      const c = colorOf(d.ind);
      parts.push('<span>' + sym(d, c) + esc(d.label) + '</span>');
      for (const gd of d.fx.guides || []) parts.push('<span>' + line(c, gd.dash) + esc(d.label + ': ' + gd.name) + '</span>');
      if (usesH(d)) parts.push('<span>' + line(c, true, 1.2) + esc(d.label + ' h = ' + +Number(d.p.h).toFixed(4)) + '</span>');
    }
    for (const e of S.res.envs) {
      const c = colorOf(e.ind);
      if (e.env.upper && e.env.lower) parts.push('<span><svg width="18" height="10"><rect x="1" y="1" width="16" height="8" fill="' + c + '" opacity=".18" stroke="' + c + '" stroke-width="1"/></svg>' + esc(e.label + ' (' + C.paramSummary(e.def, e.ind.p) + ')').replace(' ()', '') + '</span>');
      if (e.env.mid) parts.push('<span>' + line(c) + esc(e.label + ': ' + (e.def.midName || 'midline')) + '</span>');
    }
    $('legInd').innerHTML = parts.join('');
  }

  function renderPlot() {
    renderLegend();
    const resampled = !!(S.rs && S.rs.applied), filt = S.res.filt;
    $('legFilter').hidden = !filt.applied;
    $('legFilterBase').textContent = resampled ? 'Resampled' : 'Recorded';
    $('legResample').hidden = !resampled;
    if (typeof Plotly === 'undefined') {
      $('plot').innerHTML = '<p class="note" style="padding:20px">The plotting library did not load. Check your internet connection and reload the page.</p>';
      return;
    }
    const { A, t } = S.ch;
    const colors = { signal: cssVar('--signal'), note: cssVar('--note'), muted: cssVar('--muted'), line: cssVar('--line'), surface: cssVar('--surface') };
    let mn = Infinity, mx = -Infinity; for (const v of A) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const lift = (mx - mn) * 0.06;
    const { label: chLabel, unit } = chanInfo();
    const iv = $('showIntervals').checked; // interval strip under the signal, off by default
    const hov = name => '<b>' + esc(name) + '</b><br>%{x:.3f} s<br>value %{customdata[1]:.3f}<br>sample %{customdata[0]} (MATLAB)<extra></extra>';
    const traces = [];
    const add = (meta, tr) => traces.push(Object.assign({ type: 'scatter', meta }, tr));
    // envelopes first, under the signal: each a lower line, an upper line filled down to it, and a midline
    for (const e of S.res.envs) {
      const c = colorOf(e.ind), name = e.label;
      if (e.env.upper && e.env.lower) {
        add({ role: 'envLower', uid: e.ind.uid }, { x: t, y: e.env.lower, mode: 'lines', name: name + ' lower', line: { color: c, width: 0.8 }, hovertemplate: esc(name) + ' lower<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' });
        add({ role: 'envUpper', uid: e.ind.uid }, { x: t, y: e.env.upper, mode: 'lines', name: name + ' upper', line: { color: c, width: 0.8 }, fill: 'tonexty', fillcolor: withAlpha(c, 0.14), hovertemplate: esc(name) + ' upper<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' });
      }
      if (e.env.mid) add({ role: 'envMid', uid: e.ind.uid }, { x: t, y: e.env.mid, mode: 'lines', name: name + ': ' + (e.def.midName || 'midline'), line: { color: c, width: 1.6 }, hovertemplate: esc(name) + '<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' });
    }
    // the recording before resampling, under everything (zorder)
    if (resampled) add({ role: 'recorded' }, { x: S.chRaw.t, y: S.chRaw.A, mode: 'lines', name: 'Recorded', zorder: -1, line: { color: colors.muted, width: 1 }, opacity: 0.6, hovertemplate: 'Recorded, before resampling<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' });
    // the signal, faded when the filtered signal is drawn on it
    add({ role: 'signal' }, { x: t, y: A, mode: 'lines', line: { color: colors.signal, width: 1.3 }, opacity: filt.applied ? 0.35 : 1, name: resampled ? 'Resampled' : 'Signal',
      hovertemplate: (resampled ? 'Resampled<br>' : filt.applied ? 'Recorded<br>' : '') + '%{x:.3f} s<br>%{y:.3f}<extra></extra>' });
    if (filt.applied) add({ role: 'filtered' }, { x: t, y: filt.A, mode: 'lines', line: { color: colors.signal, width: 1.6 }, name: 'Filtered', hovertemplate: 'Filtered<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' });
    const dets = shownDets();
    // each detector's guide lines (e.g. its smoothed signal and threshold), under the markers
    for (const d of dets) for (const gd of d.fx.guides || []) {
      const level = typeof gd.y === 'number';
      add({ role: 'guide', uid: d.ind.uid }, { x: level ? [t[0], t[t.length - 1]] : t, y: level ? [gd.y, gd.y] : gd.y, mode: 'lines', name: d.label + ': ' + gd.name,
        line: { color: colorOf(d.ind), width: gd.dash ? 1.2 : 1.5, dash: gd.dash ? 'dash' : 'solid' }, opacity: 0.85, hovertemplate: esc(d.label + ': ' + gd.name) + '<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' });
    }
    // markers: each detector a symbol and colour, stacked a little above the last so equal steps don't hide each other
    dets.forEach((d, k) => {
      const markY = d.fx.markY || d.src;
      add({ role: 'markers', uid: d.ind.uid }, { x: d.idx.map(i => t[i]), y: d.idx.map(i => markY[i] + k * lift), customdata: d.idx.map(i => [i + 1, d.src[i]]), mode: 'markers', name: d.label,
        marker: { symbol: symbolOf(d.ind), size: 9, color: colorOf(d.ind), line: { color: colors.surface, width: 1 } }, hovertemplate: hov(d.label + ' step') });
    });
    // the interval strip: time between steps, at the midpoint, per detector
    if (iv) {
      for (const d of dets) {
        const x = [], y = [];
        for (let k = 1; k < d.idx.length; k++) { const a = t[d.idx[k - 1]], b = t[d.idx[k]]; x.push((a + b) / 2); y.push(b - a); }
        add({ role: 'intervals', uid: d.ind.uid }, { x, y, xaxis: 'x', yaxis: 'y2', mode: 'lines+markers', name: d.label + ' interval', line: { color: colorOf(d.ind), width: 1 },
          marker: { symbol: symbolOf(d.ind), size: 6, color: colorOf(d.ind) }, hovertemplate: esc(d.label) + ': %{y:.3f} s between steps<extra></extra>' });
      }
      // the period of the spectrum's main rhythm over time (gaps where no clear peak), with the
      // Frequency domain section open (#101: closed, the time view keeps only the numbers)
      if ($('freqSec').open) add({ role: 'rhythm' }, { x: Array.from(S.res.rhythm.t), y: Array.from(S.res.rhythm.freq, f => Number.isFinite(f) ? 1 / f : null), mode: 'lines', name: 'Spectrum rhythm',
        xaxis: 'x', yaxis: 'y2', connectgaps: false, line: { color: colors.signal, width: 1.6 },
        hovertemplate: 'Spectrum: main rhythm every %{y:.3f} s (%{customdata:.0f}/min)<extra></extra>', customdata: Array.from(S.res.rhythm.freq, f => f * 60) });
    }
    const tMax = t[t.length - 1];
    const layout = {
      uirevision: S.file.name + '|' + (S.varName || '') + '|' + S.chanKey,
      margin: { l: 58, r: 14, t: 8, b: 44 },
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: cssVar('--font') || 'sans-serif', color: colors.muted, size: 12 },
      showlegend: false, hovermode: 'closest', dragmode: 'zoom', bargap: 0,
      hoverlabel: { font: { family: cssVar('--font') || 'sans-serif' } },
      xaxis: { title: { text: 'Time (s)' }, range: [t[0], tMax], gridcolor: colors.line, zeroline: false, linecolor: colors.line, anchor: iv ? 'y2' : 'y' },
      yaxis: { domain: iv ? [0.3, 1] : [0, 1], title: { text: chLabel + (unit ? ' (' + unit + ')' : '') }, gridcolor: colors.line, zerolinecolor: colors.line, automargin: true },
      yaxis2: { visible: iv, domain: [0, 0.22], title: { text: 'Interval (s)' }, gridcolor: colors.line, zeroline: false, rangemode: 'tozero', automargin: true },
      // each threshold-based detector's h, dashed in its colour
      shapes: dets.filter(usesH).map(d => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: d.p.h, y1: d.p.h, line: { color: colorOf(d.ind), width: 1.2, dash: 'dash' } })),
      annotations: [],
    };
    const drawn = drawNotes('signal', layout, [t[0], tMax], v => v, colors);
    if (drawn.times) layout.margin.t = 26; // room for the labels of time notes
    // Toolbar only while the pointer is over the plot (always shown on touch screens, which can't hover).
    // Drag zooms and reset (or double-click) zooms out, so the +/- buttons go.
    const config = { responsive: true, displaylogo: false, scrollZoom: false, displayModeBar: 'hover',
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'zoomIn2d', 'zoomOut2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'] };
    const el = $('plot');
    el.setAttribute('aria-label', 'Signal with detected steps' + (iv ? ' and the time between steps' : ''));
    Plotly.react(el, traces, layout, config);
    if (!el.__bound) { el.on('plotly_click', ev => onNoteClick('signal', ev)); el.__bound = true; }
    const name = S.file.demo ? S.file.title : (S.varName ? S.varName : S.file.name);
    $('plotTitle').textContent = name + ', ' + chLabel;
  }

  // Spectrum panel: power of the signal the algorithm sees (and of the recording, faded, when a
  // filter changed it), the filter's gain on a second axis, and the dominant walking frequency.
  /* The Frequency domain section (#101): closed by default, with a one-line summary; open, its
     two views (whole recording, over time) are drawn with the chosen methods. The views never
     change steps or metrics. */
  const methodOf = sel => C.TRANSFORMS.find(d => d.id === $(sel).value) || C.TRANSFORMS.find(d => d.kind === (sel === 'wholeSel' ? 'whole' : 'time'));
  // each method's settings, as range controls with data-param (so params() reads them and the
  // Frequency domain Reset resets them); called before the option listeners are attached
  function fillMethods() {
    for (const [sel, kind, box] of [['wholeSel', 'whole', 'wholeParams'], ['timeSel', 'time', 'timeParams']]) {
      const defs = C.TRANSFORMS.filter(d => d.kind === kind);
      $(sel).innerHTML = defs.map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('');
      $(box).innerHTML = defs.filter(d => d.params.length).map(d => '<div class="method-params" data-method="' + d.id + '">' + d.params.map(q => {
        const id = 'm_' + q.key;
        return '<div class="ctl"><div class="ctl-head"><label for="' + id + '">' + esc(q.label) + '</label><output for="' + id + '" data-unit="' + esc(q.unit || '') + '" data-dec="' + (q.dec || 0) + '">' + fmt(q.default, q.dec || 0) + (q.unit ? ' ' + esc(q.unit) : '') + '</output></div>' +
          '<input type="range" id="' + id + '" data-param="' + q.key + '" min="' + q.min + '" max="' + q.max + '" step="' + q.step + '" value="' + q.default + '">' + (q.hint ? '<p class="hint">' + esc(q.hint) + '</p>' : '') + '</div>';
      }).join('') + '</div>').join('');
    }
    showMethodTags();
  }
  function showMethodTags() {
    for (const [sel, tag, box] of [['wholeSel', 'wholeTag', 'wholeParams'], ['timeSel', 'timeTag', 'timeParams']]) {
      const d = methodOf(sel);
      $(tag).innerHTML = esc(d.tagline) + (d.credit.length ? ' <span class="credit">' + creditHtml(d.credit) + '</span>' : '');
      for (const el of $(box).querySelectorAll('.method-params')) el.hidden = el.dataset.method !== d.id;
    }
  }
  function renderFreq() {
    const pk = S.res.spec.peak, sp = S.res.specSteps;
    $('freqSum').textContent = (pk.clear ? 'Main rhythm ' + fmt(pk.freq, 2) + ' Hz (' + fmt(pk.freq * 60, 0) + '/min)' : 'No clear walking rhythm') +
      (sp ? ' \u00b7 about ' + Math.round(sp.steps) + ' steps from the rhythm' : '');
    if (!$('freqSec').open) return; // drawn when opened
    renderSpectrum();
    renderSpectrogram();
  }
  function renderSpectrum() {
    if (typeof Plotly === 'undefined') return;
    const { specRaw: raw0, g: p } = S.res, def = methodOf('wholeSel');
    const spec = def.compute(S.res.filt.A, S.ch.t, p, { spec: S.res.spec }), specRaw = def.id === 'welch' ? raw0 : null;
    const colors = { signal: cssVar('--signal'), algo: cssVar('--algo'), muted: cssVar('--muted'), line: cssVar('--line') };
    const top = Math.min(spec.fs / 2, 10), log = $('specLog').checked;
    const cut = r => { let k = 0; while (k < r.f.length && r.f[k] <= Math.min(spec.fs / 2, 25)) k++; return { f: Array.from(r.f.subarray(0, k)), psd: Array.from(r.psd.subarray(0, k)) }; };
    const sp = cut(spec), raw = specRaw ? cut(specRaw) : null;
    const gain = C.filterGain(p, spec.fs, sp.f);
    const unit = chanInfo().unit;
    const traces = [
      { x: raw ? raw.f : [], y: raw ? raw.psd : [], type: 'scatter', mode: 'lines', name: 'Recorded', visible: !!raw, opacity: 0.35, line: { color: colors.signal, width: 1.2 }, meta: { role: 'specRecorded' },
        hovertemplate: 'Recorded<br>%{x:.2f} Hz<br>%{y:.3g}<extra></extra>' },
      { x: sp.f, y: sp.psd, type: 'scatter', mode: 'lines', name: raw ? 'Filtered' : 'Signal', line: { color: colors.signal, width: 1.6 }, meta: { role: 'spectrum' },
        hovertemplate: '%{x:.2f} Hz (%{customdata:.0f}/min)<br>%{y:.3g}<extra></extra>', customdata: sp.f.map(v => v * 60) },
      { x: gain ? sp.f : [], y: gain || [], type: 'scatter', mode: 'lines', name: 'Filter gain', visible: !!gain, yaxis: 'y2', line: { color: colors.algo, width: 1.3, dash: 'dash' }, meta: { role: 'gain' },
        hovertemplate: 'Filter keeps %{y:.2f} of the swing at %{x:.2f} Hz<extra></extra>' },
    ];
    const pk = spec.peak, fsUnit = unit ? ' (' + unit + ')²/Hz' : '';
    const layout = {
      uirevision: S.file.name + '|' + S.chanKey,
      margin: { l: 58, r: gain ? 50 : 14, t: 8, b: 44 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: cssVar('--font') || 'sans-serif', color: colors.muted, size: 12 }, showlegend: false, hovermode: 'closest',
      xaxis: { title: { text: 'Frequency (Hz)' }, range: [0, top], gridcolor: colors.line, zeroline: false },
      yaxis: { title: { text: 'Power' + fsUnit }, type: log ? 'log' : 'linear', gridcolor: colors.line, zeroline: false, automargin: true, exponentformat: 'power' },
      yaxis2: { overlaying: 'y', side: 'right', range: [0, 1.05], visible: !!gain, title: { text: 'Filter gain' }, showgrid: false, zeroline: false },
      shapes: pk.clear ? [{ type: 'line', xref: 'x', x0: pk.freq, x1: pk.freq, yref: 'paper', y0: 0, y1: 1, line: { color: colors.algo, width: 1.2, dash: 'dot' } }] : [],
      annotations: pk.clear ? [{ x: pk.freq, xref: 'x', y: 1, yref: 'paper', yanchor: 'top', xanchor: 'left', showarrow: false, bgcolor: cssVar('--surface'),
        text: fmt(pk.freq, 2) + ' Hz = ' + fmt(pk.freq * 60, 0) + '/min', font: { color: colors.algo, size: 12 } }] : [],
    };
    const config = { responsive: true, displaylogo: false, displayModeBar: 'hover', modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'zoomIn2d', 'zoomOut2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'] };
    const drawn = drawNotes('spectrum', layout, [0, top], v => (log ? (v > 0 ? Math.log10(v) : null) : v), { note: cssVar('--note'), surface: cssVar('--surface') });
    if (drawn.times) layout.margin.t = 26;
    const sel = $('specPlot');
    Plotly.react(sel, traces, layout, config);
    if (!sel.__bound) { sel.on('plotly_click', ev => onNoteClick('spectrum', ev)); sel.__bound = true; }
    $('specNote').textContent = (pk.clear ? 'The strongest rhythm between ' + C.GAIT_BAND[0] + ' and ' + C.GAIT_BAND[1] + ' Hz is ' + fmt(pk.freq, 2) + ' Hz: ' + fmt(pk.freq * 60, 0) + ' per minute' + (p.stride ? ', counted as strides (One leg), so ' + fmt(pk.freq * 120, 0) + ' steps/min. ' : '. ') : 'No clear walking rhythm between ' + C.GAIT_BAND[0] + ' and ' + C.GAIT_BAND[1] + ' Hz. ') +
      'Welch\u2019s method, ' + fmt(spec.segment, 1) + ' s segments' + (spec.resampled ? ', on an even ' + fmt(spec.fs, 1) + ' Hz grid' : '') + '. ' +
      (gain ? 'The dashed line is the filter\u2019s gain: the share of each frequency\u2019s swing it keeps.' : p.filter === 'median' ? 'The median filter isn\u2019t linear, so it has no fixed gain to draw.' : '');
  }

  /* The spectrogram (#98): the rhythm-over-time spectra as a picture on Plotly's axes, since
     the basic bundle the page loads has no heatmap. Time runs across, lined up with the signal
     plot; frequency goes up to 5 Hz; the colour's strength is the power, from SPECTRO_DB below
     the strongest walking rhythm (blank) up to it. The main rhythm is drawn on top as a line. */
  const hexRgb = h => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || '') || /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(h || '');
    return m ? m.slice(1, 4).map(v => parseInt(v.length === 1 ? v + v : v, 16)) : [61, 95, 130];
  };
  function renderSpectrogram() {
    if (typeof Plotly === 'undefined') return;
    const el = $('spectroPlot'), { t } = S.ch, def = methodOf('timeSel');
    const colors = { signal: cssVar('--signal'), algo: cssVar('--algo'), muted: cssVar('--muted'), line: cssVar('--line') };
    // the CWT and DWT are slower than the rest, so a result is kept until the signal, the
    // filter (S.cache is new then), the method or its settings change
    const key = JSON.stringify([def.id, S.res.g.specWin, def.params.map(q => S.res.g[q.key])]);
    S.cache.views = S.cache.views || new Map();
    if (!S.cache.views.has(key)) S.cache.views.set(key, def.compute(S.res.filt.A, t, S.res.g, { rhythm: S.res.rhythm }));
    const res = S.cache.views.get(key), im = res && C.gridImage(res.grid, hexRgb(colors.signal));
    el.hidden = !im;
    if (!im) { $('spectroNote').textContent = def.id === 'stft' ? 'The recording is shorter than one ' + fmt(S.res.rhythm.window, 0) + ' s window (Rhythm-over-time window, above), so there is no picture.' : 'The recording is too short for this method (it needs a few seconds).'; return; }
    const ln = res.line, fMax = im.fMax;
    const traces = ln ? [{ x: Array.from(ln.t), y: Array.from(ln.f, f => (Number.isFinite(f) ? f : null)), type: 'scatter', mode: 'lines', name: 'Main rhythm', connectgaps: false,
      line: { color: colors.algo, width: 1.6 }, meta: { role: 'rhythmLine' }, customdata: Array.from(ln.f, f => f * 60),
      hovertemplate: '%{x:.1f} s: main rhythm %{y:.2f} Hz (%{customdata:.0f}/min)<extra></extra>' }] : [];
    if (res.coi) { // the cone of influence: within the wavelet's e-folding time of either end
      const fs = []; for (let f = C.GAIT_BAND[0] / 2; f <= fMax; f += 0.05) fs.push(f);
      for (const [side, edge] of [['start', f => res.coi.from + res.coi.efold(f)], ['end', f => res.coi.to - res.coi.efold(f)]]) {
        traces.push({ x: fs.map(edge), y: fs, type: 'scatter', mode: 'lines', name: 'Edge effects (' + side + ')', hoverinfo: 'skip', meta: { role: 'coi' },
          line: { color: colors.muted, width: 1, dash: 'dash' } });
      }
    }
    const bandShapes = (res.bands || []).filter(b => b.lo < fMax).map(b => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: Math.min(b.hi, fMax), y1: Math.min(b.hi, fMax), line: { color: colors.muted, width: 1, dash: 'dot' } }));
    const bandNotes = (res.bands || []).filter(b => b.lo < fMax && Math.min(b.hi, fMax) - b.lo >= 0.4).map(b => ({ // room for a label xref: 'paper', x: 1, xanchor: 'right', yref: 'y', y: (b.lo + Math.min(b.hi, fMax)) / 2, showarrow: false,
      text: 'level ' + b.level + ': ' + fmt(b.lo, 2) + '\u2013' + fmt(b.hi, 2) + ' Hz', font: { color: colors.muted, size: 11 } }));
    const layout = {
      uirevision: S.file.name + '|' + S.chanKey, margin: { l: 58, r: 14, t: 8, b: 44 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: cssVar('--font') || 'sans-serif', color: colors.muted, size: 12 }, showlegend: false, hovermode: 'closest',
      xaxis: { title: { text: 'Time (s)' }, range: [t[0], t[t.length - 1]], gridcolor: colors.line, zeroline: false },
      yaxis: { title: { text: 'Frequency (Hz)' }, range: [0, im.fMax], gridcolor: colors.line, zeroline: false },
      images: [{ source: 'data:image/png;base64,' + C.base64(C.pngBytes(im.width, im.height, im.rgba)), xref: 'x', yref: 'y', x: im.x0, y: im.fMax,
        sizex: im.x1 - im.x0, sizey: im.fMax, sizing: 'stretch', xanchor: 'left', yanchor: 'top', layer: 'below' }],
      shapes: bandShapes, annotations: bandNotes,
    };
    const config = { responsive: true, displaylogo: false, displayModeBar: 'hover', modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'zoomIn2d', 'zoomOut2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'] };
    Plotly.react(el, traces, layout, config);
    const scale = 'blank at ' + C.SPECTRO_DB + ' dB below the strongest walking rhythm, full colour at it.', stride = ' A steady walk makes one bright band; a band at half its height is the stride (left plus right step), which swinging the phone or a sideways signal brings out.';
    $('spectroNote').textContent = def.id === 'cwt' ? 'Wavelet power at each frequency along the recording, divided by the scale so equally strong swings look alike at any frequency, in ' + fmt(res.grid.hop, 1) + ' s steps: ' + scale + ' The line is the strongest walking rhythm at each moment. Outside the dashed lines the wavelet runs past the ends of the recording, so the picture there is weaker than it should be.' + stride
      : def.id === 'dwt' ? 'Each band\u2019s power along the recording, in ' + fmt(res.grid.hop, 1) + ' s steps: ' + scale + ' The bands halve in frequency going down (dotted lines). Where they fall depends on the sampling rate: here ' + fmt(res.bands[0].hi * 2, 0) + ' Hz, after the signal is reduced to its walking band. When the step and the stride land in neighbouring bands, they show as separate blocks.'
      : 'How strongly each rhythm shows along the recording, in ' + fmt(res.window, 0) + ' s windows every ' + fmt(res.hop, 1) + ' s (Rhythm-over-time window, above): ' + scale + ' The line is the main walking rhythm, as in the Step intervals strip.' + stride;
  }

  /* ------------------------------------------------------------- notes */
  /* Notes (#80) on the signal and on the spectrum, each with its own tools: Add notes, the
     kind (a time or frequency, a level, or a point) and Snap to the curve (a level or point
     takes the curve's value at the clicked time or frequency, instead of exactly where the
     click was). Notes are a view only: they never change the steps. */
  const NOTE_UI = {
    signal: { plot: 'plot', card: 'plotCard', mode: 'noteMode', opts: 'noteOpts', kind: 'noteKind', snap: 'noteSnap', form: 'noteForm', at: 'noteAt', text: 'noteText', cancel: 'noteCancel', hint: 'noteHint', list: 'noteList',
      roles: ['signal', 'filtered'], hint0: 'Click the plot where the note belongs.' },
    spectrum: { plot: 'specPlot', card: 'specCard', mode: 'specNoteMode', opts: 'specNoteOpts', kind: 'specNoteKind', snap: 'specNoteSnap', form: 'specNoteForm', at: 'specNoteAt', text: 'specNoteText', cancel: 'specNoteCancel', hint: 'specNoteHint', list: 'specNoteList',
      roles: ['spectrum'], hint0: 'Click the spectrum where the note belongs.' },
  };
  const NOTE_HINT = { level: 'Click at the height the note marks.', point: 'Click the point the note marks.' };
  // where the pointer was, in data units (for Snap off), from Plotly's axes; null if unknown
  function cursorAt(gd, e) {
    const fl = gd && gd._fullLayout, drag = gd && gd.querySelector && (gd.querySelector('.nsewdrag[data-subplot="xy"]') || gd.querySelector('.nsewdrag'));
    if (!fl || !fl.xaxis || !fl.yaxis || !e || !drag) return null;
    const r = drag.getBoundingClientRect(), lin = (ax, px) => { const l = ax.p2l(px); return ax.type === 'log' ? Math.pow(10, l) : l; };
    return { x: lin(fl.xaxis, e.clientX - r.left), y: lin(fl.yaxis, e.clientY - r.top) };
  }
  function onNoteClick(plot, ev) {
    const u = NOTE_UI[plot];
    if (!$(u.mode).checked || !S.ch || !ev.points || !ev.points.length) return;
    const kind = $(u.kind).value;
    // Plotly's clicked point of the main curve (nearest to the click on the plot); a click on a
    // marker or the gain line has none, and takes the curve's value at that time instead
    const pt = ev.points.find(p => p.data && p.data.meta && u.roles.includes(p.data.meta.role)) || (ev.points[0].data ? null : ev.points[0]);
    const at = pt || ev.points[0], cur = cursorAt($(u.plot), ev.event), snap = $(u.snap).checked;
    let x, y = NaN;
    if (kind === 'time') x = cur ? (snap ? curve(plot).xs[nearest(plot, cur.x)] : cur.x) : at.x; // the clicked time, not the nearest point's
    else if (snap || !cur) { x = at.x; y = pt ? pt.y : curve(plot).ys[nearest(plot, at.x)]; }
    else { x = cur.x; y = cur.y; }
    if (!Number.isFinite(x) && kind !== 'level') return;
    if (kind !== 'time' && !Number.isFinite(y)) return;
    openNoteForm(plot, { kind, x, y });
  }
  // the drawn curve (the filtered signal when there is one, or the spectrum) and its sample nearest to x
  const curve = plot => (plot === 'signal' ? { xs: S.ch.t, ys: S.res.filt.applied ? S.res.filt.A : S.ch.A } : { xs: S.res.spec.f, ys: S.res.spec.psd });
  function nearest(plot, x) {
    const xs = curve(plot).xs;
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid; else hi = mid; }
    return Math.abs(xs[hi] - x) < Math.abs(xs[lo] - x) ? hi : lo;
  }
  function noteWhere(n) {
    const xu = n.plot === 'signal' ? ' s' : ' Hz', yv = v => (n.plot === 'signal' ? fmt(v, 2) + (chanInfo().unit ? ' ' + chanInfo().unit : '') : 'power ' + String(+v.toPrecision(3)));
    return n.kind === 'time' ? fmt(n.x, 2) + xu : n.kind === 'level' ? 'level ' + yv(n.y) : fmt(n.x, 2) + xu + ', ' + yv(n.y);
  }
  // a spectrum note in the walking band, in everyday units, worded by Phone position (owner's decision on #80)
  function noteRate(n) {
    if (n.plot !== 'spectrum' || n.kind === 'level' || !(n.x >= C.GAIT_BAND[0] && n.x <= C.GAIT_BAND[1])) return '';
    const leg = $('posSel').value === 'leg';
    return 'every ' + fmt(1 / n.x, 2) + ' s, ' + fmt(n.x * 60 * (leg ? 2 : 1), 0) + ' steps/min' + (leg ? ' (one leg: each repeat is a stride)' : '');
  }
  function openNoteForm(plot, draft) {
    closeNoteForm();
    const u = NOTE_UI[plot];
    S.noteDraft = Object.assign({ plot }, draft);
    const where = noteWhere(C.noteOf(S.noteDraft));
    $(u.at).textContent = 'Note at ' + where;
    $(u.text).value = '';
    $(u.form).hidden = false; $(u.hint).hidden = true;
    $(u.text).focus();
  }
  function closeNoteForm(plot) {
    if (!plot || (S.noteDraft && S.noteDraft.plot === plot)) S.noteDraft = null;
    for (const p of plot ? [plot] : Object.keys(NOTE_UI)) $(NOTE_UI[p].form).hidden = true;
    updateNoteUi();
  }
  function addNote(e, plot) {
    e.preventDefault();
    const u = NOTE_UI[plot], text = $(u.text).value.trim();
    if (!text || !S.noteDraft || S.noteDraft.plot !== plot) { $(u.text).focus(); return; }
    S.notes.push(C.noteOf(Object.assign({}, S.noteDraft, { text })));
    S.notes.sort((a, b) => (a.plot === b.plot ? (Number.isFinite(a.x) ? a.x : -Infinity) - (Number.isFinite(b.x) ? b.x : -Infinity) : a.plot < b.plot ? 1 : -1));
    closeNoteForm(plot);
    renderNotes(); redrawNotes(plot);
  }
  function deleteNote(i) {
    const n = S.notes.splice(i, 1)[0];
    renderNotes(); if (n) redrawNotes(n.plot);
  }
  function redrawNotes(plot) { if (!S.ch || !S.res) return; if (plot !== 'spectrum') renderPlot(); else if ($('freqSec').open) renderSpectrum(); }
  function renderNotes() {
    for (const plot of Object.keys(NOTE_UI)) {
      const u = NOTE_UI[plot], list = S.notes.map((n, i) => [n, i]).filter(([n]) => n.plot === plot);
      $(u.list).innerHTML = list.map(([n, i]) => {
        const rate = noteRate(n);
        return '<li><b>' + esc(noteWhere(n)) + '</b>' + (rate ? '<span class="extra">' + esc(rate) + '</span>' : '') + esc(n.text) +
          '<button type="button" data-i="' + i + '" aria-label="Delete note at ' + esc(noteWhere(n)) + '" title="Delete note">×</button></li>';
      }).join('');
      $(u.list).hidden = !list.length;
    }
    $('legNotes').hidden = !S.notes.some(n => n.plot === 'signal');
  }
  function updateNoteUi() {
    for (const plot of Object.keys(NOTE_UI)) {
      const u = NOTE_UI[plot], on = $(u.mode).checked && !!S.ch;
      $(u.opts).hidden = !on;
      $(u.hint).textContent = NOTE_HINT[$(u.kind).value] || u.hint0;
      $(u.hint).hidden = !on || !$(u.form).hidden;
      $(u.card).classList.toggle('noting', on);
    }
  }
  /* A plot's notes as Plotly shapes and annotations: a time as a dotted vertical line labelled
     at the top, a level as a dotted horizontal line labelled at the right, a point as a dot
     with its label above. ymap turns a value into the axis' units (log10 on a log axis; null
     when it can't be drawn there). */
  function drawNotes(plot, layout, xr, ymap, colors) {
    let times = 0;
    const line = { color: colors.note, width: 1.3, dash: 'dot' }, font = { color: colors.note, size: 12 };
    for (const n of S.notes.filter(nt => nt.plot === plot)) {
      if (n.kind === 'time') {
        times++;
        layout.shapes.push({ type: 'line', xref: 'x', x0: n.x, x1: n.x, yref: 'paper', y0: 0, y1: 1, line });
        // labels in the right quarter extend leftwards so they don't run off the plot or under the toolbar
        layout.annotations.push({ x: n.x, xref: 'x', y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false, xanchor: n.x > xr[0] + 0.75 * (xr[1] - xr[0]) ? 'right' : 'left',
          text: esc(n.text), font, bgcolor: colors.surface });
        continue;
      }
      const y = ymap(n.y);
      if (y === null || !Number.isFinite(y)) continue;
      if (n.kind === 'level') {
        layout.shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: y, y1: y, line });
        layout.annotations.push({ x: 1, xref: 'paper', xanchor: 'right', y, yref: 'y', yanchor: 'bottom', showarrow: false, text: esc(n.text), font, bgcolor: colors.surface });
      } else {
        layout.annotations.push({ x: n.x, xref: 'x', y, yref: 'y', showarrow: true, arrowhead: 6, arrowsize: 1, arrowcolor: colors.note, ax: 0, ay: -26,
          text: esc(n.text), font, bgcolor: colors.surface });
      }
    }
    return { times };
  }

  /* ------------------------------------------------------------ tables */
  /* ------------------------------------------------------------ metrics */
  // One column per shown detector. The timing rows apply to all of them; the rows marked
  // "Coza's formula" reproduce the .m file's outputs and appear when a Coza is shown.
  function renderMetrics() {
    const dets = shownDets(), g = S.res.g;
    const f = (v, d, u) => Number.isFinite(v) ? v.toFixed(d) + (u ? ' ' + u : '') : '—';
    // the last column: steps from the rhythm, without detecting any (#98)
    const sp = S.res.specSteps, spDur = sp ? sp.end - sp.start : NaN;
    const rows = [
      { name: 'Steps', tip: 'Steps detected. With Phone position set to One leg, each peak counts as two steps (a stride).',
        v: d => (g.stride ? d.metrics.steps + '<small>' + d.metrics.peaks + ' strides × 2</small>' : String(d.metrics.steps)),
        s: () => (sp ? '≈ ' + Math.round(sp.steps) + '<small>' + fmt(sp.steps, 1) + ' over ' + fmt(sp.start, 1) + '–' + fmt(sp.end, 1) + ' s</small>' : '—') },
      { name: 'Average step duration', tip: 'Mean time between detected steps, from the timestamps.', v: d => f(d.metrics.stepInterval, 3, 's'), s: () => f(spDur / (sp && sp.steps), 3, 's') },
      { name: 'Cadence', tip: 'Steps per minute: 60 ÷ average step duration.', v: d => f(d.metrics.cadence, 1, 'steps/min'), s: () => f(60 * (sp && sp.steps) / spDur, 1, 'steps/min') },
      { name: g.stride ? 'Stride-time variability' : 'Step-time variability', tip: 'Standard deviation of the intervals between detected steps (N−1, like MATLAB), in ms, with the coefficient of variation (CV = SD ÷ mean interval).',
        v: d => f(d.metrics.variabilityMs, 0, 'ms') + (Number.isFinite(d.metrics.cv) ? ', CV ' + d.metrics.cv.toFixed(1) + '%' : '') },
      { name: 'Gait asymmetry', tip: 'Mean of the even intervals ÷ mean of the odd intervals; 1.000 is symmetric.' + (g.stride ? ' Not reported for strides, because it needs single steps.' : ''),
        v: d => (g.stride ? '—' : f(d.metrics.asymmetry, 3)) },
      { name: 'Walking span', tip: 'Time from the first to the last step.', v: d => f(d.metrics.span, 1, 's'), s: () => f(spDur, 1, 's') },
      { name: 'Harmonic ratio', tip: 'Gait symmetry from the shape of each stride (two steps, or one peak-to-peak on One leg): the amplitudes of harmonics 1–20 of the stride frequency, even over odd, averaged over the strides. Identical left and right steps make only even harmonics, so higher means more alike (for the vertical or forward direction; side to side it inverts). Computed on the recorded signal, since a low-pass filter would remove the harmonics.',
        v: d => f(d.hr.ratio, 2) },
    ];
    const coza = dets.some(d => d.script);
    if (coza) {
      rows.push(
        { name: 'Average step duration (Coza’s formula)', tip: 'mean(diff(Step1)) / 100, as in LabStepDet_2025.m: sample intervals ÷ 100, which assumes 100 Hz.', v: d => (d.script ? f(d.script.avgStepDuration, 3, 's') : '—') },
        { name: 'Pace (Coza’s formula)', tip: 'AverageStepDuration × 60, as in the .m file. Its comment calls it steps/min, but that would be 60 ÷ duration, which is the Cadence row.', v: d => (d.script ? f(d.script.pace, 2) : '—') },
        { name: 'Step variability (Coza’s formula)', tip: 'std(diff(Step1)): the standard deviation of the intervals in samples (N−1).', v: d => (d.script ? f(d.script.variabilitySamples, 1, 'samples') : '—') },
        { name: 'Gait asymmetry (Coza’s formula)', tip: 'mean(d(2:2:end)) / mean(d(1:2:end)) on the intervals in samples.', v: d => (d.script ? f(d.script.asymmetry, 3) : '—') });
    }
    $('cozaNote').hidden = !coza;
    const spTip = 'Without detecting any steps: the walking rhythm in windows of ' + fmt(g.specWin || 4, 0) + ' s (Rhythm-over-time window, in Frequency domain) added up over the walk, one cycle per step' + (g.stride ? ' (× 2 with One leg)' : '') + '. The walk is the stretch where the rhythm is clear, its ends moved to where the walking swing starts and stops. An estimate: best on a steady walk, rougher when the phone is handled at the ends.';
    $('metricsTable').innerHTML = '<thead><tr><th>Metric</th>' + dets.map(d => '<th class="num" style="color: var(' + d.ind.color + ')">' + esc(d.label) + '</th>').join('') +
      '<th class="num spec-col"><span class="tip" tabindex="0" title="' + esc(spTip) + '">From the rhythm</span></th></tr></thead><tbody>' +
      rows.map(r => '<tr><td><span class="tip" tabindex="0" title="' + esc(r.tip) + '">' + r.name + '</span></td>' + dets.map(d => '<td class="num">' + r.v(d) + '</td>').join('') +
        '<td class="num spec-col">' + (r.s ? r.s() : '—') + '</td></tr>').join('') + '</tbody>';
    const pk = S.res.spec.peak;
    $('specCadNote').textContent = (pk.clear ? 'From the spectrum, without detecting steps: ' + fmt(S.res.specCadence, 1) + ' steps/min (60 × the strongest walking frequency' + (g.stride ? ', × 2 for strides' : '') + ', resolution about ' + fmt(60 / S.res.spec.segment, 1) + '/min).' : 'The spectrum has no clear walking rhythm to compare with.') +
      (sp ? ' “From the rhythm” adds the rhythm up window by window over ' + fmt(sp.start, 1) + '–' + fmt(sp.end, 1) + ' s, so it follows changes of pace: about ' + Math.round(sp.steps) + ' steps.' : ' The rhythm is clear in too little of the recording to count steps from it.');
  }

  function stepRows() { return C.stepTable(shownDets().map(d => ({ id: d.ind.uid, idx: d.idx, weak: d.weak }))); }
  function renderSteps() {
    const { A, t } = S.ch, dets = shownDets(), st = stepRows();
    $('stepsTitle').textContent = 'All steps (' + (dets.map(d => d.idx.length + ' ' + d.label).join(', ') || 'no detector') + ')';
    const cell = s => (s === 'step' ? 'yes' : s ? 'dropped: ' + s : '—');
    const shownRows = st.rows.slice(0, 1500);
    $('stepsTable').innerHTML = '<thead><tr><th class="num">Time (s)</th><th class="num">Sample</th><th class="num">Value</th>' + dets.map(d => '<th>' + esc(d.label) + '</th>').join('') + '</tr></thead><tbody>' +
      shownRows.map((i, k) => '<tr><td class="num">' + fmt(t[i], 3) + '</td><td class="num">' + (i + 1) + '</td><td class="num">' + fmt(A[i], 2) + '</td>' +
        dets.map(d => '<td>' + cell(st.status[d.ind.uid][k]) + '</td>').join('') + '</tr>').join('') +
      (st.rows.length > shownRows.length ? '<tr><td colspan="' + (3 + dets.length) + '">' + (st.rows.length - shownRows.length) + ' more rows in the export</td></tr>' : '') + '</tbody>';
  }

  /* ------------------------------------------------------------- export */
  function updateExportButtons() {
    const can = !!(S.ch && S.res);
    $('expSteps').disabled = !can; $('expMetrics').disabled = !can; $('expGo').disabled = !can;
  }
  const csvCell = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csvRow = arr => arr.map(csvCell).join(',');
  function baseName() { return (S.file.name || 'recording').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'recording'; }

  // "CSV, separate files": the steps and the metrics tables of the export model, with the
  // settings and notes after the metrics
  function exportSteps() { save(baseName() + '_steps.csv', C.tableCsv(exportModel({ signals: false }).steps)); }
  function exportMetrics() {
    const m = exportModel({ signals: false });
    const L = [C.tableCsv(m.metrics).trimEnd(), '', csvRow(['setting', 'value'])];
    for (const [k, v] of Object.entries(m.settings)) L.push(csvRow([k, v]));
    // each indicator in a line, as the sidebar lists it (its exact params are in the zip and JSON exports)
    m.indicators.id.forEach((id, k) => {
      const def = registry(m.indicators.kind[k]).find(d => d.id === m.indicators.type[k]), sum = C.paramSummary(def, JSON.parse(m.indicators.params[k]));
      L.push(csvRow([id, m.indicators.name[k] + (sum ? ': ' + sum : '') + ' (' + (m.indicators.source[k] === 'recorded' ? 'unfiltered' : 'filtered') + ')']));
    });
    if (S.notes.length) L.push('', csvRow(['note_plot', 'note_kind', 'note_x', 'note_y', 'note']),
      ...S.notes.map(n => csvRow([n.plot, n.kind, Number.isFinite(n.x) ? n.x.toFixed(3) : '', Number.isFinite(n.y) ? String(+n.y.toPrecision(6)) : '', n.text])));
    save(baseName() + '_metrics.csv', L.join('\n') + '\n');
  }
  /* Export… (#53): one model (C.buildExport) in the chosen format; docs/export.md */
  const EXPORT_FORMATS = {
    csv: 'Metrics and steps as two CSV files, one column per step detector. Opens in Excel.',
    zip: 'Every table as its own CSV file (signals, steps, metrics, indicators, notes, settings), in one zip.',
    mat: 'One struct, gaitscope, for MATLAB or Octave: load the file, then use gaitscope.steps.time_s and so on. In MATLAB, struct2table(gaitscope.steps) makes a table.',
    npz: 'For Python: np.load(file, allow_pickle=False); each column is an array, e.g. z["steps/sample_matlab"].',
    json: 'Everything, including every indicator and its settings. Drop it on the dashboard to reopen this analysis.',
  };
  function showExport() {
    const f = $('expFmt').value;
    $('expDesc').textContent = EXPORT_FORMATS[f];
    $('expCsv').hidden = f !== 'csv'; $('expParts').hidden = f === 'csv';
    // JSON needs the signal to reopen
    $('expSignals').disabled = f === 'json' || !S.ch; if (f === 'json') $('expSignals').checked = true;
    if (S.ch) $('expSignalsInfo').textContent = S.ch.A.length.toLocaleString('en-US') + ' rows: time, the signal' + (S.res && S.res.filt.applied ? ', the filtered signal' : '') +
      (S.rs && S.rs.applied ? ', and the recording before resampling (' + S.chRaw.A.length.toLocaleString('en-US') + ' rows)' : '') + '.' + (f === 'json' ? ' Always in JSON, which needs it to reopen.' : '');
  }
  function exportSettings() {
    const { g, filt } = S.res;
    const s = { signal: chanInfo().label, sampling_rate_hz: S.ch.fs, recorded_rate_hz: S.chRaw.fs,
      resample: !S.rs ? 'off' : !S.rs.applied ? 'off (not applied)' : fmt(S.rs.fs, 2) + ' Hz, ' + S.rs.method + (S.rs.antialias ? ', anti-aliased' : ''),
      filter: C.filterLabel(g) + (filt.applied ? '' : g.filter !== 'none' ? ' (not applied)' : ''), filter_resampled: !!filt.resampled,
      spectrum_segment_s: S.res.spec.segment, phone_position: g.stride ? 'one leg (each peak is a stride)' : 'hand or waist (each peak is a step)' };
    if (S.counted) s[S.countedBy === 'demo' ? 'steps_in_synthetic_walk' : 'steps_counted_by_hand'] = S.counted;
    return s;
  }
  // what is shown is what is exported: the shown detectors and envelopes
  function exportModel(parts) {
    const { g, filt } = S.res, dets = shownDets(), envs = S.res.envs, info = chanInfo();
    const inds = dets.map(d => d.ind).concat(envs.map(e => e.ind)), ids = C.indicatorIds(inds);
    const idOf = new Map(inds.map((ind, k) => [ind.uid, ids[k]]));
    const settingsOf = ind => { const d = dets.find(x => x.ind === ind); return d && d.def.settings ? Object.fromEntries(d.def.settings(d.p, d.fx)) : {}; };
    // the methods shown now: changing one only redraws its view, so S.res.g can be behind
    const params = Object.assign({}, g, { phone_position: $('posSel').value, freqWhole: $('wholeSel').value, freqTime: $('timeSel').value });
    delete params.fs; delete params.stride; // derived from the signal and from phone_position
    return C.buildExport({
      about: { file: S.file.name, variable: S.varName || '', signal: info.label, signal_name: COMPUTED[S.chanKey] ? '' : S.ds.columns[Number(S.chanKey)].name, unit: info.unit },
      settings: exportSettings(), params,
      spectrum: { dominant_hz: S.res.spec.peak.clear ? S.res.spec.peak.freq : NaN, cadence_steps_min: S.res.specCadence, segment_s: S.res.spec.segment,
        rhythm_steps: S.res.specSteps ? S.res.specSteps.steps : NaN, rhythm_from_s: S.res.specSteps ? S.res.specSteps.start : NaN, rhythm_to_s: S.res.specSteps ? S.res.specSteps.end : NaN },
      t: S.ch.t, A: S.ch.A, filtered: filt.applied ? filt.A : null, recorded: S.rs && S.rs.applied ? { t: S.chRaw.t, A: S.chRaw.A } : null,
      indicators: inds.map(ind => ({ id: idOf.get(ind.uid), kind: ind.kind, type: ind.type, name: labelOf(ind), source: ind.source, color: ind.color.slice(2), params: ind.p, settings: settingsOf(ind) })),
      detectors: dets.map(d => ({ id: idOf.get(d.ind.uid), type: d.ind.type, idx: d.idx, weak: d.weak, metrics: d.metrics, hr: d.hr, script: d.script })),
      envelopes: envs.map(e => ({ id: idOf.get(e.ind.uid), upper: e.env.upper, lower: e.env.lower, mid: e.env.mid })),
      stride: g.stride, notes: S.notes, parts,
    });
  }
  function exportAs(fmt) {
    const model = exportModel({ signals: fmt === 'json' || $('expSignals').checked, envelope: $('expEnvelope').checked });
    const name = baseName() + '_gaitscope.' + fmt;
    if (fmt === 'json') { save(name, C.exportJson(model), 'application/json'); markClean(); S.recordingSaved = true; } // it reopens all of this
    else if (fmt === 'mat') save(name, C.exportMat(model), 'application/octet-stream');
    else if (fmt === 'npz') save(name, C.exportNpz(model), 'application/octet-stream');
    else save(name, C.exportCsvZip(model), 'application/zip');
    $('expMenu').open = false;
  }

  /* Home (#79): back to the start screen, as if the page had just opened. Nothing is kept in
     the browser, so when something would be lost it first offers to save it all as one JSON
     export, which reopens this analysis: Export, Discard or Cancel. Lost means notes, a phone
     recording not yet downloaded, or detectors and settings changed since the file loaded
     (the channel choice doesn't count: it is quick to pick again). A JSON export counts as
     saving everything. */
  function setupSig() {
    return JSON.stringify({ ind: S.ind.map(i => [i.kind, i.type, i.p, i.source, i.visible]), filter: $('filterSel').value,
      opts: Array.from(optionInputs(), el => (el.type === 'checkbox' ? el.checked : el.value)),
      rs: ['rsSel', 'rsRate', 'rsMethod'].map(id => $(id).value).concat($('rsAA').checked), pos: $('posSel').value });
  }
  function markClean() { S.clean = { setup: setupSig(), notes: JSON.stringify(S.notes) }; }
  function unsaved() {
    const out = [];
    if (S.notes.length && (!S.clean || JSON.stringify(S.notes) !== S.clean.notes)) out.push(S.notes.length === 1 ? 'a note' : S.notes.length + ' notes');
    if (S.recording && !S.recordingSaved) out.push('a phone recording that hasn\u2019t been downloaded');
    if (S.clean && setupSig() !== S.clean.setup) out.push('changed detectors or settings');
    return out;
  }
  function onHome() {
    const lost = S.file ? unsaved() : [];
    if (!lost.length) return goHome();
    const list = lost.length === 1 ? lost[0] : lost.slice(0, -1).join(', ') + ' and ' + lost.at(-1);
    $('homeText').textContent = 'You have ' + list + '. Nothing is kept in the browser, so going home loses ' + (lost.length > 1 ? 'them' : 'it') +
      (S.ch ? '. Export saves everything as one JSON file, which reopens this analysis when you drop it on the page.' : '.');
    $('homeExport').hidden = !S.ch;
    $('homeDialog').hidden = false;
    (S.ch ? $('homeExport') : $('homeDiscard')).focus();
  }
  function cancelHome() { $('homeDialog').hidden = true; $('homeBtn').focus(); }
  function goHome() {
    $('homeDialog').hidden = true;
    resetAll();
    S.file = null; S.varName = null; S.chanKey = null; S.cache = null; S.plotReady = false;
    if (window.Plotly && window.Plotly.purge) { window.Plotly.purge($('plot')); window.Plotly.purge($('specPlot')); }
    // the controls as the page opens them
    defaultIndicators(); renderIndicators();
    $('filterSel').value = 'none'; showFilter();
    $('rsSel').value = 'off'; $('rsRate').value = ''; $('rsMethod').value = 'linear'; $('rsAA').checked = false; showRs();
    resetParams(false);
    for (const id of ['showIntervals', 'noteMode', 'specNoteMode', 'specLog']) $(id).checked = false;
    $('freqSec').open = false; $('wholeSel').selectedIndex = 0; $('timeSel').selectedIndex = 0; showMethodTags();
    for (const id of ['noteSnap', 'specNoteSnap']) $(id).checked = true;
    for (const id of ['noteKind', 'specNoteKind']) $(id).value = 'time';
    renderNotes(); updateNoteUi();
    $('fsIn').value = '100'; $('expMenu').open = false;
    valOpenedByUser = null;
    $('fileChip').hidden = true; $('fileChip').innerHTML = ''; $('subtitle').hidden = false; $('homeBtn').hidden = true;
    $('dataControls').hidden = true; $('analysis').hidden = true; $('work').hidden = true; $('empty').hidden = false;
    setControlsEnabled(false);
    (document.scrollingElement || document.documentElement).scrollTop = 0; // back to the top
  }

  function save(filename, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type: type || 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Exported ' + filename);
  }

  /* ------------------------------------------------------------- events */
  let raf = 0;
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(recompute); }
  $('fileIn').addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) handleFile(f); });
  for (const b of document.querySelectorAll('[data-demo]')) b.addEventListener('click', () => loadDemo(b.dataset.demo));
  window.StepRecorder.init(loadRecording);
  $('saveRec').addEventListener('click', () => { if (S.recording) { save(S.recording.name, S.recording.csv); S.recordingSaved = true; } });
  $('homeBtn').addEventListener('click', onHome);
  $('homeExport').addEventListener('click', () => { exportAs('json'); goHome(); });
  $('homeDiscard').addEventListener('click', goHome);
  $('homeCancel').addEventListener('click', cancelHome);
  $('homeDialog').addEventListener('keydown', e => { if (e.key === 'Escape') cancelHome(); });
  $('emptyPick').addEventListener('click', () => $('fileIn').click());
  $('varSel').addEventListener('change', e => selectMatVar(Number(e.target.value)));
  $('chanSel').addEventListener('change', e => selectChannel(e.target.value));
  $('fsIn').addEventListener('change', () => { if (S.ds && !S.ds.t) selectChannel(S.chanKey); });
  // resampling redoes everything downstream, so it runs on change (not on every keystroke)
  for (const id of ['rsSel', 'rsRate', 'rsMethod', 'rsAA']) $(id).addEventListener('change', () => { showRs(); applyResample(); });
  $('rsRate').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyResample(); } });
  for (const b of document.querySelectorAll('[data-rs-rate]')) b.addEventListener('click', () => { $('rsRate').value = b.dataset.rsRate; applyResample(); });
  showRs();
  fillMethods(); // the methods' own settings exist before the listeners below are attached
  for (const el of optionInputs()) el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => { updateOptionOut(el); schedule(); });
  $('posSel').addEventListener('change', () => { updatePosHint(); schedule(); });
  // indicators: one listener per list, for every item's controls
  for (const id of ['detList', 'envList']) {
    $(id).addEventListener('input', onIndicatorInput);
    $(id).addEventListener('change', e => { if (e.target.type === 'checkbox') onIndicatorInput(e); else onIndicatorSource(e); });
    $(id).addEventListener('click', onIndicatorClick);
  }
  const addOptions = (list, what) => '<option value="">Add ' + what + '\u2026</option>' + list.map(d => '<option value="' + esc(d.id) + '"' + (d.tagline ? ' title="' + esc(d.tagline) + '"' : '') + '>' + esc(d.name) + '</option>').join('');
  $('detAdd').innerHTML = addOptions(C.ALGORITHMS, 'a step detector');
  $('envAdd').innerHTML = addOptions(C.ENVELOPES, 'an envelope or band');
  $('detAdd').addEventListener('change', e => onAdd('detector', e.target));
  $('envAdd').addEventListener('change', e => onAdd('envelope', e.target));
  defaultIndicators();
  renderIndicators();
  $('filterSel').innerHTML = C.FILTERS.map(f => '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>').join('');
  $('filterSel').addEventListener('change', () => { showFilter(); schedule(); });
  // presets set the order and band of whichever IIR filter is selected
  for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => {
    const [hp, lp] = b.dataset.preset.split(' ');
    $('fOrderIn').value = '4'; $('fHighIn').value = hp; $('fLowIn').value = lp;
    for (const el of ['fOrderIn', 'fHighIn', 'fLowIn']) updateOptionOut($(el));
    schedule();
  });
  showFilter();
  $('showIntervals').addEventListener('change', () => { dropPlainUndo(); if (S.ch && S.res) renderPlot(); });
  $('plainBtn').addEventListener('click', signalOnly);
  $('plainUndo').addEventListener('click', undoSignalOnly);
  // any other change to the set-up ends the Undo (opening an indicator's settings doesn't)
  const aside = document.querySelector('aside');
  for (const ev of ['input', 'change']) aside.addEventListener(ev, dropPlainUndo, true);
  aside.addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.act !== 'open') dropPlainUndo(); }, true);
  $('specLog').addEventListener('change', () => { if (S.ch && S.res) renderSpectrum(); });
  for (const plot of Object.keys(NOTE_UI)) {
    const u = NOTE_UI[plot];
    $(u.mode).addEventListener('change', () => { if (!$(u.mode).checked) closeNoteForm(plot); else updateNoteUi(); });
    $(u.kind).addEventListener('change', updateNoteUi);
    $(u.form).addEventListener('submit', e => addNote(e, plot));
    $(u.cancel).addEventListener('click', () => closeNoteForm(plot));
    $(u.text).addEventListener('keydown', e => { if (e.key === 'Escape') closeNoteForm(plot); });
    $(u.list).addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) deleteNote(Number(b.dataset.i)); });
  }
  // a spectrum note's rate follows Phone position
  $('posSel').addEventListener('change', renderNotes);
  $('resetParams').addEventListener('click', () => resetParams(true, 'adv'));
  // the Frequency domain section (#101): views only, so a method change redraws just its view
  $('freqSec').addEventListener('toggle', () => { if (!S.ch || !S.res) return; renderFreq(); if ($('showIntervals').checked) renderPlot(); });
  $('wholeSel').addEventListener('change', () => { showMethodTags(); if (S.ch && S.res && $('freqSec').open) renderSpectrum(); });
  $('timeSel').addEventListener('change', () => { showMethodTags(); if (S.ch && S.res && $('freqSec').open) renderSpectrogram(); });
  $('resetFreq').addEventListener('click', () => { $('wholeSel').selectedIndex = 0; $('timeSel').selectedIndex = 0; showMethodTags(); resetParams(true, 'freq'); });
  $('expSteps').addEventListener('click', exportSteps);
  $('expFmt').addEventListener('change', showExport);
  $('expMenu').addEventListener('toggle', showExport);
  $('expGo').addEventListener('click', () => exportAs($('expFmt').value));
  showExport();
  $('expMetrics').addEventListener('click', exportMetrics);
  $('valToggle').addEventListener('click', () => { const open = $('valToggle').getAttribute('aria-expanded') !== 'true'; valOpenedByUser = open; setValOpen(open); });
  /* Theme (#79): System, Light or Dark, remembered for this viewer only. System leaves
     data-theme off, so the CSS follows the system setting; the plots redraw on any change
     (the observer below). Storage can be blocked (private windows), so every use is guarded. */
  const THEMES = ['system', 'light', 'dark'], THEME_KEY = 'gaitscope-theme';
  const THEME_NAME = { system: 'System', light: 'Light', dark: 'Dark' };
  // drawn, not font glyphs: the page font has no half circle, sun or moon
  const svgIcon = body => '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  const THEME_ICON = {
    system: svgIcon('<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>'),
    light: svgIcon('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/>'),
    dark: svgIcon('<path d="M13.5 9.6A5.8 5.8 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z"/>'),
  };
  function storedTheme() { try { const v = window.localStorage.getItem(THEME_KEY); return THEMES.includes(v) ? v : 'system'; } catch (e) { return 'system'; } }
  function applyTheme(v) {
    if (v === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v);
    const b = $('themeBtn'), next = THEMES[(THEMES.indexOf(v) + 1) % THEMES.length];
    b.dataset.theme = v;
    b.innerHTML = THEME_ICON[v] + THEME_NAME[v];
    b.title = 'Theme: ' + THEME_NAME[v] + '. Click for ' + THEME_NAME[next] + '.';
    b.setAttribute('aria-label', b.title);
  }
  $('themeBtn').addEventListener('click', () => {
    const v = THEMES[(THEMES.indexOf($('themeBtn').dataset.theme) + 1) % THEMES.length];
    applyTheme(v);
    try { window.localStorage.setItem(THEME_KEY, v); } catch (e) { /* not remembered, still applied */ }
  });
  applyTheme(storedTheme());
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const rerenderTheme = () => { if (S.ch && S.res) { renderPlot(); renderFreq(); } };
  if (mq.addEventListener) mq.addEventListener('change', rerenderTheme);
  new MutationObserver(rerenderTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setControlsEnabled(false);
})();
