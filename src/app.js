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
    notes: [],         // [{t, text}] pinned by the user; never change the steps
    noteT: null,       // time of the note being written
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
  function resetAll() {
    $('posSel').value = 'hand'; updatePosHint();
    showPass = false;
    S.fileChecks = []; S.mat = null; S.ds = null; S.dsChecks = []; S.ch = null; S.res = null;
    S.notes = []; closeNoteForm();
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
      if (ext === 'mat' && !isText) loadMat(buf);
      else if (isText) loadCsv(new TextDecoder('utf-8').decode(buf), ext === 'mat');
      else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
        return fatal('This file has a text extension but contains binary data.', 'If it is a MATLAB file, rename it to .mat.');
      } else loadMat(buf);
    } catch (e) {
      if (e instanceof C.InputError) return fatal(e.message, e.fix);
      console.error(e);
      return fatal('The file could not be read: ' + e.message, 'If it opens in MATLAB, re-save it with save(\'file.mat\',\'-v7\') or export it as CSV.');
    }
  }

  function loadDemo() {
    resetAll();
    S.file = { name: 'Synthetic walk (demo)', size: 0, demo: true };
    showFileChip();
    $('empty').hidden = true; $('work').hidden = false;
    revealWork();
    $('varRow').hidden = true;
    S.varName = null;
    const d = C.demoWalk();
    S.fileChecks = [{ level: 'info', title: 'Demo data', detail: 'A generated 22 s walk sampled near 100 Hz with irregular timing and values rounded to 0.01, like a phone recording.' }];
    setDataset(d.names, d.cols, 'csv');
  }

  function loadMat(buf) {
    if (typeof pako === 'undefined') throw new C.InputError('The decompression library did not load.', 'Check your internet connection and reload the page.');
    const parsed = C.parseMat(buf, u8 => pako.inflate(u8));
    const { cands, notes } = C.matCandidates(parsed.variables);
    S.mat = { cands, notes };
    S.fileChecks.push({ level: 'pass', title: 'MATLAB file read', detail: parsed.variables.length + ' variable' + (parsed.variables.length === 1 ? '' : 's') + ' found: ' + (parsed.variables.map(v => v.name + ' (' + v.cls + (v.dims.length ? ', ' + v.dims.join('×') : v.className ? ' ' + v.className : '') + ')').join(', ') || 'none') + '.' });
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

  function loadCsv(text, wasMat) {
    const p = C.parseCsv(text);
    S.varName = null;
    const pre = [];
    if (wasMat) pre.push({ level: 'warn', title: 'Text file with a .mat extension', detail: 'The file contains text, so it was read as CSV.' });
    pre.push({ level: 'pass', title: 'CSV read', detail: (p.hasHeader ? 'Header row found. ' : 'No header row. ') + 'Separated by ' + ({ ',': 'commas', ';': 'semicolons', '\t': 'tabs' }[p.delim] || 'commas') + (p.decimalComma ? ' with decimal commas' : '') + (p.clockTime ? '; clock times converted to seconds' : '') + '.' });
    if (p.dropped.length) pre.push({ level: 'info', title: 'Text columns skipped', detail: p.dropped.join(', ') + ' contain mostly non-numeric values.' });
    if (!p.cols.length) throw new C.InputError('No numeric columns found in the CSV.', 'Export the sensor data as numbers, one column per channel.');
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
    S.ch = ch.fatal ? null : ch;
    S.chChecks = ch.checks;
    if (ch.fatal) {
      $('analysis').hidden = true;
      setControlsEnabled(false);
      renderValidation([]);
      return;
    }
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
    S.ds = null; S.ch = null; S.dsChecks = []; S.chChecks = [];
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
    chip.innerHTML = '<strong title="' + esc(S.file.name) + '">' + esc(S.file.name) + '</strong>' + (S.file.size ? '<br>' + (S.file.size < 1048576 ? (S.file.size / 1024).toFixed(1) + ' KB' : (S.file.size / 1048576).toFixed(1) + ' MB') : '');
  }

  function setControlsEnabled(on) {
    for (const b of document.querySelectorAll('[data-preset]')) b.disabled = !on;
    for (const id of ['filterSel', 'envSel', 'algoSel', 'showLab', 'wIn', 'hIn', 'hNum', 'fxWeak', 'posSel', 'showIntervals', 'noteMode', 'resetParams']) $(id).disabled = !on;
    for (const el of optionInputs()) el.disabled = !on;
    updateExportButtons();
  }

  /* ----------------------------------------------------------- controls */
  function configureSliders() {
    const A = S.ch.A;
    const wMax = Math.max(1, Math.min(300, Math.floor((A.length - 1) / 2) - 1));
    const w = $('wIn');
    w.max = String(wMax);
    if (Number(w.value) > wMax) w.value = String(Math.min(30, wMax));
    const lo = Math.min(S.ch.min, 0), hi = S.ch.max;
    const step = niceStep(hi - lo || 1);
    const h = $('hIn');
    h.min = String(Math.floor(lo / step) * step);
    h.max = String(Math.ceil(hi / step) * step);
    h.step = String(step);
    $('hNum').step = String(step);
    syncH(Number($('hNum').value));
    // the low-pass cut-off must stay below half the sampling rate (largest 0.5 Hz step under it)
    const fLow = $('fLowIn');
    fLow.max = String(Math.max(0.5, Math.min(20, (Math.ceil(S.ch.fs / 2 / 0.5) - 1) * 0.5)));
    if (Number(fLow.value) > Number(fLow.max)) fLow.value = fLow.max;
    const notch = $('notchFIn');
    notch.max = String(Math.max(1, Math.min(100, (Math.ceil(S.ch.fs / 2 / 0.5) - 1) * 0.5)));
    if (Number(notch.value) > Number(notch.max)) notch.value = notch.max;
    for (const el of optionInputs()) updateOptionOut(el);
    updateWOut(); updateCwOut();
  }
  function syncH(v) { $('hNum').value = String(v); $('hIn').value = String(v); }
  function updateWOut() {
    const w = Number($('wIn').value);
    $('wOut').textContent = w + ' samples' + (S.ch ? ' (' + fmt(w / S.ch.fs, 2) + ' s)' : '');
  }
  function updateCwOut() {
    const s = Number($('cwIn').value);
    $('cwOut').textContent = fmt(s, 2) + ' s' + (S.ch ? ' (' + C.windowSamples(s, S.ch.fs, S.ch.A.length) + ' samples)' : '');
  }
  // Each algorithm's sliders under Advanced carry data-param (their key in params()). An
  // <output for=…> with data-unit shows the value with data-dec decimals.
  // data-zero: text shown for 0 (e.g. "off"); data-unit="order": "4th order".
  const optionInputs = () => document.querySelectorAll('#advSec input[data-param]');
  const ordinal = n => n + ([, 'st', 'nd', 'rd'][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] || 'th');
  function updateOptionOut(el) {
    const out = document.querySelector('output[for="' + el.id + '"][data-unit]');
    if (!out) return;
    const v = Number(el.value), u = out.dataset.unit;
    out.textContent = v === 0 && out.dataset.zero ? out.dataset.zero : u === 'order' ? ordinal(v) + ' order'
      : fmt(v, Number(out.dataset.dec || 0)) + (u === '%' ? '%' : u ? ' ' + u : '');
  }
  function resetParams(run) {
    $('wIn').value = '30'; syncH(1);
    for (const el of optionInputs()) { el.value = el.defaultValue; updateOptionOut(el); }
    updateWOut(); updateCwOut();
    if (run !== false && S.ch) recompute();
  }
  function updatePosHint() {
    $('posHint').textContent = $('posSel').value === 'leg' ? 'Each peak is a stride: a left plus a right step.' : 'Each peak is one step.';
  }
  function showFilter() {
    const f = $('filterSel').value;
    $('filterDesc').textContent = C.FILTERS.find(x => x.id === f).tagline;
    $('filterOpts').hidden = f === 'none';
    for (const el of $('filterOpts').querySelectorAll('[data-only]')) el.hidden = !el.dataset.only.split(' ').includes(f);
  }
  // Envelopes are a view: changing one redraws the plot and never recomputes the steps.
  function showEnv() {
    const e = $('envSel').value;
    for (const el of document.querySelectorAll('.env-opts')) el.hidden = !el.dataset.env.split(' ').includes(e);
  }
  function selectedAlgo() { return C.ALGORITHMS.find(a => a.id === $('algoSel').value) || C.ALGORITHMS[0]; }
  function showAlgo() {
    const a = selectedAlgo();
    $('algoDesc').textContent = a.tagline;
    $('algoDetail').textContent = a.summary;
    $('legAlgo').textContent = a.name;
    for (const el of document.querySelectorAll('.algo-opts')) el.hidden = el.dataset.algo !== a.id;
    showH();
  }
  // h only matters to the lab code and to algorithms that use it
  const hUsed = () => showLab() || selectedAlgo().usesH;
  function showH() { $('hCtl').hidden = $('legHItem').hidden = !hUsed(); }
  function params() {
    const p = {
      w: Number($('wIn').value), h: Number($('hNum').value), fs: S.ch ? S.ch.fs : 100,
      weak: $('fxWeak').checked,
      filter: $('filterSel').value,
      stride: $('posSel').value === 'leg', // a peak per stride: left plus right step
    };
    for (const el of optionInputs()) p[el.dataset.param] = Number(el.value);
    return p;
  }

  /* ------------------------------------------------------------ compute */
  function recompute() {
    if (!S.ch) return;
    const p = params();
    const { A, t } = S.ch;
    const origIdx = C.detectOriginal(A, p.w, p.h);
    const orig = C.originalMetrics(origIdx, p.w);
    const algo = selectedAlgo();
    // the filter feeds the algorithm only; the lab code above stays on the recorded signal
    const filt = C.applyFilter(A, t, S.ch.fs, p);
    const fx = algo.detect(filt.A, t, p);
    const finalIdx = fx.idx, finalSet = new Set(finalIdx);
    const algM = C.timingMetrics(finalIdx, t, { stride: p.stride });
    const weakSet = new Set(fx.weakDropped);
    S.res = { p, algo, filt, origIdx, orig, fx, finalIdx, finalSet, algM, weakSet };
    render();
  }

  const showLab = () => $('showLab').checked;

  function derivedChecks() {
    const out = [];
    if (!S.res) return out;
    const { p, orig, origIdx, fx, finalIdx, filt } = S.res;
    out.push(...filt.checks);
    if (filt.applied && p.fHigh > 0 && S.res.algo.usesH) {
      out.push({ level: 'info', title: 'h applies to the filtered signal', detail: 'The band-pass centres the signal on zero, so ' + S.res.algo.name + ' compares h = ' + p.h + ' with the filtered values. The lab code still uses the recorded signal.' });
    }
    if (!origIdx.length) {
      const both = S.res.algo.usesH;
      out.push({ level: 'warn', lab: !both, title: (both ? 'No steps found' : 'Lab code finds no steps') + ' at h = ' + p.h, detail: 'No sample rises above the threshold as a window peak. If the data is in g, walking peaks can stay below 1; lower h or check the units.' });
    }
    if (!finalIdx.length && !S.res.algo.usesH) {
      out.push({ level: 'warn', title: S.res.algo.name + ' finds no steps', detail: 'Check its settings under Advanced, and that the signal shows walking.' });
    }
    if (orig.tiedPairs) {
      out.push({ level: 'warn', lab: true, title: 'Lab code counts ' + orig.tiedPairs + ' peak' + (orig.tiedPairs > 1 ? 's' : '') + ' twice', detail: 'Two nearby samples share the same peak value (the data is rounded), so the original rule marks both. This adds intervals of a sample or two that inflate its variability and shift its asymmetry.' + (S.res.algo.id === 'coza' ? ' Coza counts each once.' : '') });
    }
    if (p.weak && fx.weakDropped && fx.weakDropped.length) {
      out.push({ level: 'info', title: fx.weakDropped.length + ' weak peak' + (fx.weakDropped.length > 1 ? 's' : '') + ' dropped', detail: 'At ' + fx.weakDropped.map(i => fmt(S.ch.t[i], 2) + ' s').join(', ') + '. These rise less than ' + Math.round(C.WEAK_RATIO * 100) + '% as far above h as a typical peak, which usually means starting or stopping rather than a step.' });
    }
    if (finalIdx.length >= 3 && !p.stride) {
      const iv = S.res.algM.stepInterval;
      if (iv > 0.85 && iv < 1.6) out.push({ level: 'info', title: 'Steps may be strides', detail: 'Detected steps are ' + fmt(iv, 2) + ' s apart, slow for single steps (usually 0.45 to 0.7 s). If the phone was on one leg, each peak is a left-plus-right stride; set Phone position to "One leg" under Recording.' });
    }
    return out;
  }

  /* ------------------------------------------------------------- render */
  function render() {
    renderValidation(derivedChecks());
    renderPlot();
    renderMetrics();
    renderSteps();
    renderNotes();
    updateExportButtons();
  }

  let valOpenedByUser = null, showPass = false, lastExtra = [];
  function renderValidation(extra) {
    // checks about the lab code only matter while it is compared
    const all = S.fileChecks.concat(S.dsChecks || [], S.chChecks || [], extra || []).filter(c => !c.lab || showLab());
    const count = lv => all.filter(c => c.level === lv).length;
    const e = count('error'), w = count('warn');
    const dot = $('valDot');
    let title, color;
    if (e) { title = 'File can\u2019t be analysed'; color = 'var(--err)'; }
    else if (w) { title = 'Valid, with ' + w + ' warning' + (w > 1 ? 's' : ''); color = 'var(--warn)'; }
    else { title = 'Valid input'; color = 'var(--ok)'; }
    dot.style.background = color;
    $('valTitle').textContent = title;
    const parts = [];
    if (S.ds) parts.push(S.ch ? S.ch.A.length + ' samples, ' + fmt(S.ch.t[S.ch.t.length - 1] - S.ch.t[0], 1) + ' s at ' + fmt(S.ch.fs, S.ch.fs >= 100 ? 0 : 1) + ' Hz' : S.ds.n + ' rows');
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

  function renderGuideLegend() {
    const sw = dash => '<svg width="18" height="10"><path d="M1 5 H17" stroke="var(--algo)" stroke-width="1.5"' + (dash ? ' stroke-dasharray="3 2"' : '') + '/></svg>';
    $('legGuides').innerHTML = (S.res.fx.guides || []).map(g => '<span>' + sw(g.dash) + esc(g.name) + '</span>').join('');
  }

  function renderPlot() {
    $('legH').textContent = 'Threshold h = ' + +S.res.p.h.toFixed(4);
    renderGuideLegend();
    $('legFilter').hidden = !S.res.filt.applied;
    if (typeof Plotly === 'undefined') {
      $('plot').innerHTML = '<p class="note" style="padding:20px">The plotting library did not load. Check your internet connection and reload the page.</p>';
      return;
    }
    const { A, t } = S.ch;
    const { p, origIdx, finalIdx, fx, filt } = S.res;
    const markY = fx.markY || filt.A;
    const colors = { signal: cssVar('--signal'), orig: cssVar('--orig'), algo: cssVar('--algo'), note: cssVar('--note'),
      ink: cssVar('--ink'), muted: cssVar('--muted'), line: cssVar('--line'), surface: cssVar('--surface') };
    let mn = Infinity, mx = -Infinity; for (const v of A) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const lift = (mx - mn) * 0.06;
    const { label: chLabel, unit } = chanInfo();
    const hov = (name) => '<b>' + name + '</b><br>%{x:.3f} s<br>value %{customdata[1]:.3f}<br>sample %{customdata[0]} (MATLAB)<extra></extra>';
    const cd = idx => idx.map(i => [i + 1, A[i]]);
    const mid = idx => { const x = [], y = [], wd = []; for (let k = 1; k < idx.length; k++) { const a = t[idx[k - 1]], b = t[idx[k]]; x.push((a + b) / 2); y.push(b - a); wd.push((b - a) * 0.86); } return { x, y, wd }; };
    const oi = mid(origIdx), fi = mid(finalIdx);
    const iv = $('showIntervals').checked; // interval strip under the signal, off by default
    // envelope around the signal the algorithm sees (filtered when a filter is on)
    const envDef = C.ENVELOPES.find(e => e.id === $('envSel').value);
    const env = envDef && envDef.compute ? envDef.compute(filt.A, t, p) : {};
    const band = !!(env.upper && env.lower), envFill = withAlpha(cssVar('--env'), 0.16);
    $('legEnv').hidden = !band; $('legEnvMid').hidden = !env.mid;
    if (band) $('legEnvText').textContent = envDef.label(p);
    if (env.mid) $('legEnvMidText').textContent = envDef.midName;

    // 5–6: the algorithm's guide lines (e.g. the smoothed signal and its threshold), under the markers
    const guides = fx.guides || [];
    const guide = g => {
      const gd = guides[g], level = gd && typeof gd.y === 'number';
      return { x: !gd ? [] : level ? [t[0], t[t.length - 1]] : t, y: !gd ? [] : level ? [gd.y, gd.y] : gd.y, type: 'scatter', mode: 'lines', name: gd ? gd.name : '', visible: !!gd,
        line: { color: colors.algo, width: gd && gd.dash ? 1.2 : 1.5, dash: gd && gd.dash ? 'dash' : 'solid' }, opacity: 0.85,
        hovertemplate: gd ? esc(gd.name) + '<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' : '' };
    };
    const traces = [
      // 0–1: envelope band (lower, then upper filled down to it), under everything else
      { x: band ? t : [], y: band ? env.lower : [], type: 'scatter', mode: 'lines', name: 'Envelope lower', visible: band, line: { color: cssVar('--env'), width: 0.8 },
        hovertemplate: 'Envelope lower<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' },
      { x: band ? t : [], y: band ? env.upper : [], type: 'scatter', mode: 'lines', name: 'Envelope upper', visible: band, line: { color: cssVar('--env'), width: 0.8 },
        fill: 'tonexty', fillcolor: envFill, hovertemplate: 'Envelope upper<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' },
      // 2: the recorded signal, faded when 3, the filtered signal the algorithm sees, is drawn on it
      { x: t, y: A, type: 'scatter', mode: 'lines', line: { color: colors.signal, width: 1.3 }, opacity: filt.applied ? 0.35 : 1, name: 'Signal',
        hovertemplate: (filt.applied ? 'Recorded<br>' : '') + '%{x:.3f} s<br>%{y:.3f}<extra></extra>' },
      { x: filt.applied ? t : [], y: filt.applied ? filt.A : [], type: 'scatter', mode: 'lines', line: { color: colors.signal, width: 1.6 }, name: 'Filtered', visible: filt.applied,
        hovertemplate: 'Filtered<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' },
      // 4: envelope midline (dynamic threshold)
      { x: env.mid ? t : [], y: env.mid || [], type: 'scatter', mode: 'lines', name: env.mid ? envDef.midName : '', visible: !!env.mid, line: { color: cssVar('--env'), width: 1.6 },
        hovertemplate: env.mid ? esc(envDef.midName) + '<br>%{x:.3f} s<br>%{y:.3f}<extra></extra>' : '' },
      guide(0), guide(1),
      { x: origIdx.map(i => t[i]), y: origIdx.map(i => A[i] + lift), customdata: cd(origIdx), type: 'scatter', mode: 'markers', name: 'Lab code', visible: showLab(),
        marker: { symbol: 'triangle-down', size: 10, color: colors.orig, line: { color: colors.surface, width: 1 } }, hovertemplate: hov('Lab code step') },
      { x: finalIdx.map(i => t[i]), y: finalIdx.map(i => markY[i]), customdata: cd(finalIdx), type: 'scatter', mode: 'markers', name: S.res.algo.name,
        marker: { symbol: 'circle', size: 9, color: colors.algo, line: { color: colors.surface, width: 1.2 } }, hovertemplate: hov(S.res.algo.name + ' step') },
      { x: fi.x, y: fi.y, width: fi.wd, type: 'bar', name: S.res.algo.name + ' interval', xaxis: 'x', yaxis: 'y2', visible: iv, marker: { color: colors.algo, opacity: 0.55 },
        hovertemplate: esc(S.res.algo.name) + ': %{y:.3f} s between steps<extra></extra>' },
      { x: oi.x, y: oi.y, type: 'scatter', mode: 'markers', name: 'Lab interval', xaxis: 'x', yaxis: 'y2', visible: iv && showLab(),
        marker: { symbol: 'triangle-down', size: 7, color: colors.orig }, hovertemplate: 'Lab code: %{y:.3f} s between peaks<extra></extra>' },
    ];
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
      shapes: (hUsed() ? [{ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: p.h, y1: p.h, line: { color: colors.muted, width: 1.2, dash: 'dash' } }] : [])
        .concat(S.notes.map(n => ({ type: 'line', xref: 'x', x0: n.t, x1: n.t, yref: 'paper', y0: 0, y1: 1, line: { color: colors.note, width: 1.3, dash: 'dot' } }))),
      // labels in the right quarter extend leftwards so they don't run off the plot or under the toolbar
      annotations: S.notes.map(n => ({ x: n.t, xref: 'x', y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false,
        xanchor: n.t > t[0] + 0.75 * (tMax - t[0]) ? 'right' : 'left',
        text: esc(n.text), font: { color: colors.note, size: 12 }, bgcolor: colors.surface })),
    };
    if (S.notes.length) layout.margin.t = 26; // room for the note labels
    // Toolbar only while the pointer is over the plot (always shown on touch screens, which can't hover).
    // Drag zooms and reset (or double-click) zooms out, so the +/- buttons go.
    const config = { responsive: true, displaylogo: false, scrollZoom: false, displayModeBar: 'hover',
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'zoomIn2d', 'zoomOut2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'] };
    const el = $('plot');
    el.setAttribute('aria-label', 'Signal with detected steps' + (iv ? ' and the time between steps' : ''));
    Plotly.react(el, traces, layout, config);
    if (!el.__bound) { el.on('plotly_click', onPlotClick); el.__bound = true; }
    const name = S.file.demo ? 'Synthetic walk' : (S.varName ? S.varName : S.file.name);
    $('plotTitle').textContent = name + ', ' + chLabel;
  }

  /* ------------------------------------------------------------- notes */
  function onPlotClick(ev) {
    if (!$('noteMode').checked || !S.ch || !ev.points || !ev.points.length) return;
    openNoteForm(ev.points[0].x);
  }
  function openNoteForm(t) {
    S.noteT = t;
    $('noteAt').textContent = 'Note at ' + fmt(t, 2) + ' s';
    $('noteText').value = '';
    $('noteForm').hidden = false; $('noteHint').hidden = true;
    $('noteText').focus();
  }
  function closeNoteForm() {
    S.noteT = null;
    $('noteForm').hidden = true;
    updateNoteUi();
  }
  function addNote(e) {
    e.preventDefault();
    const text = $('noteText').value.trim();
    if (!text || S.noteT === null) { $('noteText').focus(); return; }
    S.notes.push({ t: S.noteT, text });
    S.notes.sort((a, b) => a.t - b.t);
    closeNoteForm();
    renderNotes(); renderPlot();
  }
  function deleteNote(i) {
    S.notes.splice(i, 1);
    renderNotes(); renderPlot();
  }
  function renderNotes() {
    $('noteList').innerHTML = S.notes.map((n, i) => '<li><b>' + fmt(n.t, 2) + ' s</b>' + esc(n.text) +
      '<button type="button" data-i="' + i + '" aria-label="Delete note at ' + fmt(n.t, 2) + ' s" title="Delete note">×</button></li>').join('');
    $('noteList').hidden = !S.notes.length;
    $('legNotes').hidden = !S.notes.length;
  }
  function updateNoteUi() {
    const on = $('noteMode').checked && !!S.ch;
    $('noteHint').hidden = !on || !$('noteForm').hidden;
    $('plotCard').classList.toggle('noting', on);
  }

  /* ------------------------------------------------------------ tables */
  function renderMetrics() {
    const { orig, algM, p } = S.res;
    const name = S.res.algo.name;
    const f = (v, d, u) => Number.isFinite(v) ? v.toFixed(d) + (u ? ' ' + u : '') : '—';
    // tip: how each value is computed, shown as a tooltip on the metric name
    const rows = [
      { name: 'Steps', tip: 'Steps detected. With Phone position set to One leg, ' + name + ' counts each one as two steps (a stride).',
        lab: String(orig.steps), algo: p.stride ? algM.steps + '<small>' + algM.peaks + ' strides × 2</small>' : String(algM.steps) },
      { name: 'Average step duration', tip: 'Mean time between detected steps. Lab code: samples ÷ 100, which assumes 100 Hz. ' + name + ': from the timestamps.',
        lab: f(orig.avgStepDuration, 3, 's'), algo: f(algM.stepInterval, 3, 's') },
      { name: 'Cadence', tip: 'Steps per minute: 60 ÷ average step duration. The lab code does not compute it.',
        lab: '—', algo: f(algM.cadence, 1, 'steps/min') },
      { name: 'Pace (lab formula)', labOnly: true, tip: 'The lab code\u2019s Pace is average step duration × 60. Its comment calls it steps/min, but that would be 60 ÷ duration, so ' + name + ' reports cadence instead.',
        lab: f(orig.pace, 2), algo: '—' },
      { name: p.stride ? 'Stride-time variability' : 'Step-time variability', tip: 'Standard deviation of the intervals between detected steps (N−1, like MATLAB). Lab code: in samples. ' + name + ': in ms, with the coefficient of variation (CV = SD ÷ mean interval).',
        lab: f(orig.variabilitySamples, 1, 'samples'), algo: f(algM.variabilityMs, 0, 'ms') + (Number.isFinite(algM.cv) ? ', CV ' + algM.cv.toFixed(1) + '%' : '') },
      { name: 'Gait asymmetry', tip: 'Mean of the even intervals ÷ mean of the odd intervals; 1.000 is symmetric.' + (p.stride ? ' Not reported for strides, because it needs single steps.' : ''),
        lab: f(orig.asymmetry, 3), algo: p.stride ? '—' : f(algM.asymmetry, 3) },
      { name: 'Walking span', tip: 'Time from the first to the last ' + name + ' step.', lab: '—', algo: f(algM.span, 1, 's') },
    ];
    const lab = showLab();
    $('labNote').hidden = !lab;
    $('labFilterNote').hidden = !S.res.filt.applied;
    const plain = v => v.split('<')[0];
    $('metricsTable').innerHTML = '<thead><tr><th>Metric</th>' + (lab ? '<th class="num col-orig">Lab code</th>' : '') + '<th class="num col-algo">' + esc(name) + '</th></tr></thead><tbody>' +
      rows.filter(r => lab || !r.labOnly).map(r => {
        const differs = lab && plain(r.lab) !== plain(r.algo) && r.lab !== '—' && r.algo !== '—';
        return '<tr><td><span class="tip" tabindex="0" title="' + esc(r.tip) + '">' + r.name + '</span></td>' + (lab ? '<td class="num">' + r.lab + '</td>' : '') +
          '<td class="num' + (differs ? ' diff' : '') + '">' + r.algo + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function stepRows() {
    const { origIdx, finalSet, weakSet } = S.res;
    const origSet = new Set(origIdx);
    const all = Array.from(new Set(origIdx.concat(Array.from(finalSet)))).sort((a, b) => a - b);
    let prevOrig = -10;
    return all.map(i => {
      const inO = origSet.has(i), inF = finalSet.has(i);
      let why;
      if (inF) why = 'kept';
      else if (weakSet.has(i)) why = 'weak peak';
      else if (inO && i - prevOrig <= S.res.p.w) why = 'tied peak';
      else why = 'not found by ' + S.res.algo.name;
      if (inO) prevOrig = i;
      return { i, inO, inF, why };
    });
  }

  function renderSteps() {
    const { A, t } = S.ch;
    const rows = stepRows();
    const nF = S.res.finalIdx.length;
    $('stepsTitle').textContent = 'All steps (' + nF + ' ' + S.res.algo.name + ', ' + S.res.origIdx.length + ' lab code)';
    const shown = rows.slice(0, 1500);
    $('stepsTable').innerHTML = '<thead><tr><th class="num">Time (s)</th><th class="num">Sample</th><th class="num">Value</th><th>Lab code</th><th>' + esc(S.res.algo.name) + '</th></tr></thead><tbody>' +
      shown.map(r => '<tr class="' + (r.inF ? '' : 'only-orig') + '"><td class="num">' + fmt(t[r.i], 3) + '</td><td class="num">' + (r.i + 1) + '</td><td class="num">' + fmt(A[r.i], 2) + '</td><td>' + (r.inO ? 'yes' : '—') + '</td><td>' + (r.inF ? 'yes' : 'dropped: ' + r.why) + '</td></tr>').join('') +
      (rows.length > shown.length ? '<tr><td colspan="5">' + (rows.length - shown.length) + ' more rows in the export</td></tr>' : '') + '</tbody>';
  }

  /* ------------------------------------------------------------- export */
  function updateExportButtons() {
    const can = !!(S.ch && S.res);
    $('expSteps').disabled = !can; $('expMetrics').disabled = !can;
  }
  const csvCell = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csvRow = arr => arr.map(csvCell).join(',');
  function baseName() { return (S.file.name || 'recording').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'recording'; }

  function exportSteps() {
    const { A, t } = S.ch;
    const id = S.res.algo.id;
    const lines = [csvRow(['time_s', 'sample_matlab', 'value', 'in_lab_code', 'in_' + id, id + '_status'])];
    for (const r of stepRows()) lines.push(csvRow([t[r.i].toFixed(4), r.i + 1, A[r.i], r.inO ? 'yes' : 'no', r.inF ? 'yes' : 'no', r.why]));
    save(baseName() + '_steps.csv', lines.join('\n') + '\n');
  }
  function exportMetrics() {
    const { orig, algM, p } = S.res;
    const n = v => Number.isFinite(v) ? +v.toFixed(6) : '';
    const col = chanInfo().label;
    const id = S.res.algo.id;
    const L = [csvRow(['metric', 'lab_code', id, 'unit_lab_code', 'unit_' + id]),
      csvRow(['steps', orig.steps, algM.steps, 'count', 'count']),
      csvRow(['average_step_duration', n(orig.avgStepDuration), n(algM.stepInterval), 's (samples/100)', 's (timestamps)']),
      csvRow(['cadence', '', n(algM.cadence), '', 'steps/min']),
      csvRow(['pace_lab_formula', n(orig.pace), '', 'duration*60', '']),
      csvRow([p.stride ? 'stride_time_variability' : 'step_time_variability', n(orig.variabilitySamples), n(algM.variabilityMs), 'samples (SD)', 'ms (SD)']),
      csvRow(['coefficient_of_variation', '', n(algM.cv), '', '%']),
      csvRow(['gait_asymmetry', n(orig.asymmetry), p.stride ? '' : n(algM.asymmetry), 'even/odd intervals', 'even/odd intervals']),
      '',
      csvRow(['setting', 'value']),
      csvRow(['algorithm', S.res.algo.name]),
      csvRow(['file', S.file.name]),
      csvRow(['variable', S.varName || '']),
      csvRow(['signal', col]),
      csvRow(['window_w_samples', p.w]),
      csvRow(['threshold_h', p.h]),
      csvRow(['sampling_rate_hz', n(S.ch.fs)]),
      csvRow(['filter', C.filterLabel(p) + (S.res.filt.applied ? '' : p.filter !== 'none' ? ' (not applied)' : '')]),
      csvRow(['filter_resampled', S.res.filt.resampled ? 'yes' : 'no']),
      ...S.res.algo.settings(p, S.res.fx).map(csvRow),
      csvRow(['phone_position', p.stride ? 'one leg (each peak is a stride)' : 'hand or waist (each peak is a step)']),
    ];
    if (S.notes.length) L.push('', csvRow(['note_time_s', 'note']), ...S.notes.map(n => csvRow([n.t.toFixed(3), n.text])));
    save(baseName() + '_metrics.csv', L.join('\n') + '\n');
  }
  function save(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
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
  $('demoBtn').addEventListener('click', loadDemo);
  $('emptyDemo').addEventListener('click', loadDemo);
  $('emptyPick').addEventListener('click', () => $('fileIn').click());
  $('varSel').addEventListener('change', e => selectMatVar(Number(e.target.value)));
  $('chanSel').addEventListener('change', e => selectChannel(e.target.value));
  $('fsIn').addEventListener('change', () => { if (S.ds && !S.ds.t) selectChannel(S.chanKey); });
  $('wIn').addEventListener('input', () => { updateWOut(); schedule(); });
  for (const el of optionInputs()) el.addEventListener('input', () => { updateOptionOut(el); if (el.id === 'cwIn') updateCwOut(); schedule(); });
  $('hIn').addEventListener('input', e => { $('hNum').value = e.target.value; schedule(); });
  $('hNum').addEventListener('input', e => { const v = Number(e.target.value); if (Number.isFinite(v) && e.target.value !== '') { $('hIn').value = String(v); schedule(); } });
  for (const id of ['fxWeak', 'posSel']) $(id).addEventListener('change', schedule);
  $('posSel').addEventListener('change', updatePosHint);
  $('envSel').innerHTML = C.ENVELOPES.map(e => '<option value="' + esc(e.id) + '"' + (e.tagline ? ' title="' + esc(e.tagline) + '"' : '') + '>' + esc(e.name) + '</option>').join('');
  $('envSel').addEventListener('change', () => { showEnv(); if (S.ch && S.res) renderPlot(); });
  showEnv();
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
  $('algoSel').innerHTML = C.ALGORITHMS.map(a => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('');
  $('algoSel').addEventListener('change', () => { showAlgo(); schedule(); });
  $('showLab').addEventListener('change', () => { $('legLab').hidden = $('wCtl').hidden = !showLab(); showH(); if (S.ch && S.res) render(); });
  showAlgo();
  $('showIntervals').addEventListener('change', () => { if (S.ch && S.res) renderPlot(); });
  $('noteMode').addEventListener('change', () => { if (!$('noteMode').checked) closeNoteForm(); else updateNoteUi(); });
  $('noteForm').addEventListener('submit', addNote);
  $('noteCancel').addEventListener('click', closeNoteForm);
  $('noteText').addEventListener('keydown', e => { if (e.key === 'Escape') closeNoteForm(); });
  $('noteList').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) deleteNote(Number(b.dataset.i)); });
  $('resetParams').addEventListener('click', () => resetParams(true));
  $('expSteps').addEventListener('click', exportSteps);
  $('expMetrics').addEventListener('click', exportMetrics);
  $('valToggle').addEventListener('click', () => { const open = $('valToggle').getAttribute('aria-expanded') !== 'true'; valOpenedByUser = open; setValOpen(open); });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const rerenderTheme = () => { if (S.ch && S.res) renderPlot(); };
  if (mq.addEventListener) mq.addEventListener('change', rerenderTheme);
  new MutationObserver(rerenderTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setControlsEnabled(false);
})();
