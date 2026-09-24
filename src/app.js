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
    edits: { added: new Set(), removed: new Set(), history: [] },
    plotReady: false,
  };

  /* ---------------------------------------------------------- utilities */
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
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
    $('fxStride').checked = false;
    showPass = false;
    S.fileChecks = []; S.mat = null; S.ds = null; S.dsChecks = []; S.ch = null; S.res = null;
    clearEdits(true);
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
    $('chanSel').innerHTML = opts.map(o => '<option value="' + o.key + '">' + esc(o.label) + '</option>').join('');
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
    clearEdits(true);
    const fsManual = Number($('fsIn').value) || 100;
    const ch = C.prepareChannel(S.ds, key === 'computed' ? 'computed' : Number(key), fsManual);
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
    chip.innerHTML = '<strong>' + esc(S.file.name) + '</strong>' + (S.file.size ? '<br>' + (S.file.size < 1048576 ? (S.file.size / 1024).toFixed(1) + ' KB' : (S.file.size / 1048576).toFixed(1) + ' MB') : '');
  }

  function setControlsEnabled(on) {
    for (const id of ['algoSel', 'wIn', 'hIn', 'hNum', 'fxTies', 'fxWeak', 'rIn', 'fxStride', 'editMode', 'snap', 'resetParams']) $(id).disabled = !on;
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
    updateWOut();
  }
  function syncH(v) { $('hNum').value = String(v); $('hIn').value = String(v); }
  function updateWOut() {
    const w = Number($('wIn').value);
    $('wOut').textContent = w + ' samples' + (S.ch ? ' (' + fmt(w / S.ch.fs, 2) + ' s)' : '');
  }
  function resetParams(run) {
    $('wIn').value = '30'; syncH(1); updateWOut();
    if (run !== false && S.ch) { clearEdits(true); recompute(); }
  }
  function selectedAlgo() { return C.ALGORITHMS.find(a => a.id === $('algoSel').value) || C.ALGORITHMS[0]; }
  function showAlgo() {
    const a = selectedAlgo();
    $('algoDesc').textContent = a.summary;
    $('legAlgo').textContent = a.name;
    for (const el of document.querySelectorAll('.algo-opts')) el.hidden = el.dataset.algo !== a.id;
  }
  function params() {
    return {
      w: Number($('wIn').value), h: Number($('hNum').value),
      ties: $('fxTies').checked, weak: $('fxWeak').checked, weakRatio: Number($('rIn').value) / 100,
      stride: $('fxStride').checked,
    };
  }

  /* ------------------------------------------------------------ compute */
  function recompute() {
    if (!S.ch) return;
    const p = params();
    const { A, t } = S.ch;
    const origIdx = C.detectOriginal(A, p.w, p.h);
    const orig = C.originalMetrics(origIdx, p.w);
    const algo = selectedAlgo();
    const fx = algo.detect(A, t, p);
    const autoSet = new Set(fx.idx);
    // manual edits relative to the algorithm's automatic set
    const finalSet = new Set(fx.idx.filter(i => !S.edits.removed.has(i)));
    for (const i of S.edits.added) finalSet.add(i);
    const finalIdx = Array.from(finalSet).sort((a, b) => a - b);
    const algM = algo.metrics(finalIdx, t, p);
    const weakSet = new Set(fx.weakDropped);
    S.res = { p, algo, origIdx, orig, fx, autoSet, finalIdx, finalSet, algM, weakSet };
    render();
  }

  function derivedChecks() {
    const out = [];
    if (!S.res) return out;
    const { p, orig, origIdx, fx, finalIdx } = S.res;
    if (!origIdx.length) {
      out.push({ level: 'warn', title: 'No steps found at h = ' + p.h, detail: 'No sample rises above the threshold as a window peak. If the data is in g, walking peaks can stay below 1; lower h or check the units.' });
    }
    if (orig.tiedPairs) {
      out.push({ level: 'warn', title: 'Lab code counts ' + orig.tiedPairs + ' peak' + (orig.tiedPairs > 1 ? 's' : '') + ' twice', detail: 'Two nearby samples share the same peak value (the data is rounded), so the original rule marks both. This adds intervals of a sample or two that inflate its variability and shift its asymmetry.' + (p.ties ? ' ' + S.res.algo.name + ' counts each once.' : '') });
    }
    if (p.weak && fx.weakDropped.length) {
      out.push({ level: 'info', title: fx.weakDropped.length + ' weak peak' + (fx.weakDropped.length > 1 ? 's' : '') + ' dropped', detail: 'At ' + fx.weakDropped.map(i => fmt(S.ch.t[i], 2) + ' s').join(', ') + '. These rise less than ' + Math.round(p.weakRatio * 100) + '% as far above h as a typical peak, which usually means starting or stopping rather than a step.' });
    }
    if (finalIdx.length >= 3 && !p.stride) {
      const iv = S.res.algM.stepInterval;
      if (iv > 0.85 && iv < 1.6) out.push({ level: 'info', title: 'Peaks may be strides', detail: 'Peaks are ' + fmt(iv, 2) + ' s apart, slow for single steps (usually 0.45 to 0.7 s). If the phone was on one leg, each peak is a left-plus-right stride; turn on "Each peak is a stride" under Advanced.' });
    }
    return out;
  }

  /* ------------------------------------------------------------- render */
  function render() {
    renderValidation(derivedChecks());
    renderPlot();
    renderMetrics();
    renderSteps();
    updateEditUi();
    updateExportButtons();
  }

  let valOpenedByUser = null, showPass = false, lastExtra = [];
  function renderValidation(extra) {
    const all = S.fileChecks.concat(S.dsChecks || [], S.chChecks || [], extra || []);
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

  function renderPlot() {
    if (typeof Plotly === 'undefined') {
      $('plot').innerHTML = '<p class="note" style="padding:20px">The plotting library did not load. Check your internet connection and reload the page.</p>';
      return;
    }
    const { A, t } = S.ch;
    const { p, origIdx, autoSet, finalIdx, fx } = S.res;
    const colors = { signal: cssVar('--signal'), orig: cssVar('--orig'), algo: cssVar('--algo'), added: cssVar('--added'),
      removed: cssVar('--removed'), ink: cssVar('--ink'), muted: cssVar('--muted'), line: cssVar('--line'), surface: cssVar('--surface') };
    let mn = Infinity, mx = -Infinity; for (const v of A) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const lift = (mx - mn) * 0.06;
    const autoFinal = finalIdx.filter(i => autoSet.has(i));
    const added = finalIdx.filter(i => !autoSet.has(i));
    const removed = Array.from(S.edits.removed).filter(i => autoSet.has(i));
    const col = S.chanKey === 'computed' ? null : S.ds.columns[Number(S.chanKey)];
    const unit = col && col.sensor ? col.sensor.unit : '';
    const hov = (name) => '<b>' + name + '</b><br>%{x:.3f} s<br>value %{customdata[1]:.3f}<br>sample %{customdata[0]} (MATLAB)<extra></extra>';
    const cd = idx => idx.map(i => [i + 1, A[i]]);
    const mid = idx => { const x = [], y = [], wd = []; for (let k = 1; k < idx.length; k++) { const a = t[idx[k - 1]], b = t[idx[k]]; x.push((a + b) / 2); y.push(b - a); wd.push((b - a) * 0.86); } return { x, y, wd }; };
    const oi = mid(origIdx), fi = mid(finalIdx);

    const traces = [
      { x: t, y: A, type: 'scatter', mode: 'lines', line: { color: colors.signal, width: 1.3 }, name: 'Signal',
        hovertemplate: '%{x:.3f} s<br>%{y:.3f}<extra></extra>' },
      { x: origIdx.map(i => t[i]), y: origIdx.map(i => A[i] + lift), customdata: cd(origIdx), type: 'scatter', mode: 'markers', name: 'Lab code',
        marker: { symbol: 'triangle-down', size: 10, color: colors.orig, line: { color: colors.surface, width: 1 } }, hovertemplate: hov('Lab code step') },
      { x: autoFinal.map(i => t[i]), y: autoFinal.map(i => A[i]), customdata: cd(autoFinal), type: 'scatter', mode: 'markers', name: S.res.algo.name,
        marker: { symbol: 'circle', size: 9, color: colors.algo, line: { color: colors.surface, width: 1.2 } }, hovertemplate: hov(S.res.algo.name + ' step') },
      { x: added.map(i => t[i]), y: added.map(i => A[i]), customdata: cd(added), type: 'scatter', mode: 'markers', name: 'Added',
        marker: { symbol: 'diamond', size: 11, color: colors.added, line: { color: colors.surface, width: 1.2 } }, hovertemplate: hov('Added by you') },
      { x: removed.map(i => t[i]), y: removed.map(i => A[i]), customdata: cd(removed), type: 'scatter', mode: 'markers', name: 'Removed',
        marker: { symbol: 'x-thin-open', size: 11, color: colors.removed, line: { color: colors.removed, width: 2.2 } }, hovertemplate: hov('Removed by you (click to restore)') },
      { x: fi.x, y: fi.y, width: fi.wd, type: 'bar', name: S.res.algo.name + ' interval', xaxis: 'x', yaxis: 'y2', marker: { color: colors.algo, opacity: 0.55 },
        hovertemplate: esc(S.res.algo.name) + ': %{y:.3f} s between peaks<extra></extra>' },
      { x: oi.x, y: oi.y, type: 'scatter', mode: 'markers', name: 'Lab interval', xaxis: 'x', yaxis: 'y2',
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
      xaxis: { title: { text: 'Time (s)' }, range: [t[0], tMax], gridcolor: colors.line, zeroline: false, linecolor: colors.line, anchor: 'y2' },
      yaxis: { domain: [0.3, 1], title: { text: (col ? col.label : 'magnitude (computed)') + (unit ? ' (' + unit + ')' : '') }, gridcolor: colors.line, zerolinecolor: colors.line, automargin: true },
      yaxis2: { domain: [0, 0.22], title: { text: 'Interval (s)' }, gridcolor: colors.line, zeroline: false, rangemode: 'tozero', automargin: true },
      shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: p.h, y1: p.h, line: { color: colors.muted, width: 1.2, dash: 'dash' } }],
    };
    const config = { responsive: true, displaylogo: false, scrollZoom: false,
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'] };
    const el = $('plot');
    Plotly.react(el, traces, layout, config);
    if (!el.__bound) { el.on('plotly_click', onPlotClick); el.__bound = true; }
    const name = S.file.demo ? 'Synthetic walk' : (S.varName ? S.varName : S.file.name);
    $('plotTitle').textContent = name + ', ' + (col ? col.label : 'computed magnitude');
  }

  /* ------------------------------------------------------------- edits */
  function onPlotClick(ev) {
    if (!$('editMode').checked || !S.res || !ev.points || !ev.points.length) return;
    // prefer marker hits over the line
    const pts = ev.points.slice().sort((a, b) => (a.curveNumber === 0) - (b.curveNumber === 0));
    const pt = pts[0];
    const { A, t } = S.ch;
    if (pt.curveNumber === 2 || pt.curveNumber === 3) {
      const i = pt.customdata[0] - 1;
      if (S.edits.added.has(i)) { S.edits.added.delete(i); S.edits.history.push({ type: 'unadd', i }); }
      else { S.edits.removed.add(i); S.edits.history.push({ type: 'remove', i }); }
      recompute(); return;
    }
    if (pt.curveNumber === 4) {
      const i = pt.customdata[0] - 1;
      S.edits.removed.delete(i); S.edits.history.push({ type: 'restore', i });
      recompute(); return;
    }
    if (pt.curveNumber === 0 || pt.curveNumber === 1) {
      let i = pt.curveNumber === 0 ? pt.pointIndex : pt.customdata[0] - 1;
      if (pt.curveNumber === 0 && $('snap').checked) {
        const r = Math.max(1, Math.round(0.15 * S.ch.fs));
        let best = i;
        for (let k = Math.max(0, i - r); k <= Math.min(A.length - 1, i + r); k++) if (A[k] > A[best]) best = k;
        i = best;
      }
      if (S.res.finalSet.has(i)) { toast('There is already a step at ' + fmt(t[i], 2) + ' s.'); return; }
      if (S.edits.removed.has(i)) { S.edits.removed.delete(i); S.edits.history.push({ type: 'restore', i }); }
      else { S.edits.added.add(i); S.edits.history.push({ type: 'add', i }); }
      recompute();
    }
  }
  function undoEdit() {
    const h = S.edits.history.pop();
    if (!h) return;
    if (h.type === 'add') S.edits.added.delete(h.i);
    else if (h.type === 'unadd') S.edits.added.add(h.i);
    else if (h.type === 'remove') S.edits.removed.delete(h.i);
    else if (h.type === 'restore') S.edits.removed.add(h.i);
    recompute();
  }
  function clearEdits(silent) {
    const had = S.edits.added.size + S.edits.removed.size;
    S.edits = { added: new Set(), removed: new Set(), history: [] };
    if (!silent) { recompute(); if (had) toast('Manual edits cleared.'); }
    updateEditUi();
  }
  function updateEditUi() {
    const a = S.edits.added.size, r = S.edits.removed.size;
    $('editCount').textContent = a + r ? [a ? a + ' added' : '', r ? r + ' removed' : ''].filter(Boolean).join(', ') : 'No edits yet';
    $('undoEdit').disabled = !S.edits.history.length;
    $('clearEdits').disabled = !(a + r);
    const on = $('editMode').checked && !!S.ch;
    $('editBanner').hidden = !on;
    $('plotCard').classList.toggle('editing', on);
    // the edit markers only need a legend entry once they can appear
    $('legAdded').hidden = !(on || a); $('legRemoved').hidden = !(on || r);
  }

  /* ------------------------------------------------------------ tables */
  function renderMetrics() {
    const { orig, algM, p } = S.res;
    const f = (v, d, u) => Number.isFinite(v) ? v.toFixed(d) + (u ? ' ' + u : '') : '—';
    const rows = [
      ['Steps', String(orig.steps), p.stride ? algM.steps + '<small>' + algM.peaks + ' strides × 2</small>' : String(algM.steps), ''],
      ['Average step duration', f(orig.avgStepDuration, 3, 's') + '<small>samples ÷ 100</small>', f(algM.stepInterval, 3, 's') + '<small>from timestamps</small>', ''],
      ['Cadence', '—<small>not computed</small>', f(algM.cadence, 1, 'steps/min'), ''],
      ['Pace (lab formula)', f(orig.pace, 2) + '<small>duration × 60, labelled steps/min</small>', '—<small>replaced by cadence</small>', ''],
      [p.stride ? 'Stride-time variability' : 'Step-time variability', f(orig.variabilitySamples, 1, 'samples') + '<small>SD of intervals</small>', f(algM.variabilityMs, 0, 'ms') + (Number.isFinite(algM.cv) ? '<small>SD, CV ' + algM.cv.toFixed(1) + '%</small>' : ''), ''],
      ['Gait asymmetry', f(orig.asymmetry, 3) + '<small>even ÷ odd intervals</small>', p.stride ? '—<small>needs single steps</small>' : f(algM.asymmetry, 3) + '<small>1.000 = symmetric</small>', ''],
      ['Walking span', '—', f(algM.span, 1, 's') + '<small>first to last step</small>', ''],
    ];
    $('metricsTable').innerHTML = '<thead><tr><th>Metric</th><th class="num col-orig">Lab code</th><th class="num col-algo">' + esc(S.res.algo.name) + (S.edits.added.size + S.edits.removed.size ? ' + edits' : '') + '</th></tr></thead><tbody>' +
      rows.map(r => {
        const differs = r[1].split('<')[0] !== r[2].split('<')[0] && !r[1].startsWith('—') && !r[2].startsWith('—');
        return '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td><td class="num' + (differs ? ' diff' : '') + '">' + r[2] + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function stepRows() {
    const { origIdx, finalSet, autoSet, weakSet } = S.res;
    const origSet = new Set(origIdx);
    const all = Array.from(new Set(origIdx.concat(Array.from(finalSet)).concat(Array.from(S.edits.removed)))).sort((a, b) => a - b);
    let prevOrig = -10;
    return all.map(i => {
      const inO = origSet.has(i), inF = finalSet.has(i);
      let why;
      if (inF) why = autoSet.has(i) ? 'kept' : 'added by you';
      else if (S.edits.removed.has(i)) why = 'removed by you';
      else if (weakSet.has(i)) why = 'weak peak';
      else if (inO && i - prevOrig <= S.res.p.w) why = 'tied peak';
      else why = 'not a ' + S.res.algo.name + ' peak';
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
      shown.map(r => '<tr class="' + (r.inF ? (r.why === 'added by you' ? 'manual' : '') : 'only-orig') + '"><td class="num">' + fmt(t[r.i], 3) + '</td><td class="num">' + (r.i + 1) + '</td><td class="num">' + fmt(A[r.i], 2) + '</td><td>' + (r.inO ? 'yes' : '—') + '</td><td>' + (r.inF ? (r.why === 'kept' ? 'yes' : r.why) : 'dropped: ' + r.why) + '</td></tr>').join('') +
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
    const col = S.chanKey === 'computed' ? 'magnitude (computed)' : S.ds.columns[Number(S.chanKey)].label;
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
      csvRow(['fix_tied_peaks', p.ties ? 'on' : 'off']),
      csvRow(['fix_weak_peaks', p.weak ? 'on, ' + Math.round(p.weakRatio * 100) + '%' : 'off']),
      csvRow(['each_peak_is_stride', p.stride ? 'yes' : 'no']),
      csvRow(['manual_added', S.edits.added.size]),
      csvRow(['manual_removed', S.edits.removed.size]),
    ];
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
  $('hIn').addEventListener('input', e => { $('hNum').value = e.target.value; schedule(); });
  $('hNum').addEventListener('input', e => { const v = Number(e.target.value); if (Number.isFinite(v) && e.target.value !== '') { $('hIn').value = String(v); schedule(); } });
  $('rIn').addEventListener('input', e => { $('rOut').textContent = e.target.value + '%'; schedule(); });
  for (const id of ['fxTies', 'fxWeak', 'fxStride']) $(id).addEventListener('change', schedule);
  $('fxWeak').addEventListener('change', e => { $('rIn').disabled = !e.target.checked || !S.ch; });
  $('algoSel').innerHTML = C.ALGORITHMS.map(a => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('');
  $('algoSel').addEventListener('change', () => { showAlgo(); clearEdits(true); schedule(); });
  showAlgo();
  $('resetParams').addEventListener('click', () => resetParams(true));
  $('editMode').addEventListener('change', updateEditUi);
  $('undoEdit').addEventListener('click', undoEdit);
  $('clearEdits').addEventListener('click', () => clearEdits(false));
  $('expSteps').addEventListener('click', exportSteps);
  $('expMetrics').addEventListener('click', exportMetrics);
  $('valToggle').addEventListener('click', () => { const open = $('valToggle').getAttribute('aria-expanded') !== 'true'; valOpenedByUser = open; setValOpen(open); });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const rerenderTheme = () => { if (S.ch && S.res) renderPlot(); };
  if (mq.addEventListener) mq.addEventListener('change', rerenderTheme);
  new MutationObserver(rerenderTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setControlsEnabled(false);
})();
