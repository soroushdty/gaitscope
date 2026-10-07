// Drives index.html in jsdom with a stubbed Plotly (no real rendering).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const pako = require('pako');
const Core = require('../src/core.js');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

// Errors thrown inside the page (event handlers, animation frames) fail the test that caused them.
const pageErrors = [];
test.afterEach(() => assert.deepEqual(pageErrors.splice(0), [], 'uncaught error in the page'));

function makePage(opts = {}) {
  // scripts go in with replacer functions, so '$&' and the like in their code stay as written
  const inline = f => () => '<script>' + fs.readFileSync(path.join(ROOT, 'src', f), 'utf8') + '</script>';
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="https:[^>]+><\/script>/g, '')
    .replace(/<link[^>]+>/g, '')
    .replace('<script src="src/core.js"></script>', inline('core.js'))
    .replace('<script src="src/record.js"></script>', inline('record.js'))
    .replace('<script src="src/app.js"></script>', inline('app.js'));
  const plots = [], spectra = [], blobs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push((e.detail && e.detail.stack) || e.message));
  const dom = new JSDOM(html, { virtualConsole: vc, runScripts: 'dangerously', pretendToBeVisual: true, url: opts.url, beforeParse(w) {
    if (opts.insecure) Object.defineProperty(w, 'isSecureContext', { value: false });
    if (opts.storage) Object.defineProperty(w, 'localStorage', { value: opts.storage, configurable: true }); // a stand-in, or one that throws
    w.pako = pako; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder; // browsers have both; jsdom neither
    if (opts.hdf5 !== false) w.hdf5 = require('jsfive'); // the page loads it from jsDelivr when a v7.3 file arrives
    w.matchMedia = q => ({ matches: !!(opts.coarse && /pointer: coarse/.test(q)), addEventListener() {} }); // coarse: a phone
    if (opts.wakeLock) { // the Screen Wake Lock; opts.wakeLock.grant = false refuses it
      const wl = opts.wakeLock; wl.requests = 0;
      Object.defineProperty(w.navigator, 'wakeLock', { configurable: true, value: { request: async () => {
        wl.requests++;
        if (wl.grant === false) throw new Error('NotAllowedError');
        const s = new w.EventTarget(); s.release = async () => { s.dispatchEvent(new w.Event('release')); }; wl.sentinel = s; return s;
      } } });
    }
    if (opts.motion) { // the devicemotion API; permission: iPhone's prompt answer
      w.DeviceMotionEvent = function () {};
      if (opts.permission) w.DeviceMotionEvent.requestPermission = async () => opts.permission;
    }
    // the main plot and the spectrum are recorded separately
    w.Plotly = { react(el, traces, layout, config) { (el.id === 'specPlot' ? spectra : plots).push({ traces, layout, config }); el.on = (ev, fn) => { el._click = fn; }; } };
    w.URL.createObjectURL = b => { blobs.push(b); return 'blob:x'; }; w.URL.revokeObjectURL = () => {};
  } });
  return { w: dom.window, d: dom.window.document, plots, spectra, blobs };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function upload(pg, file) {
  const buf = fs.readFileSync(file);
  const f = new pg.w.File([buf], path.basename(file));
  if (!f.arrayBuffer) f.arrayBuffer = async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const input = pg.d.getElementById('fileIn');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new pg.w.Event('change'));
  await sleep(60);
}
// Plot traces carry meta {role, uid} (src/app.js renderPlot); an indicator's traces are named
// after it ("Coza", "Threshold peaks: Smoothed (3 Hz)").
// copied into this realm's arrays, so deepEqual compares contents, not the page's Array prototype
const traces = (pg, role) => [...pg.plots.at(-1).traces].filter(t => t.meta && t.meta.role === role);
const trace = (pg, role, name) => traces(pg, role).find(t => name === undefined || t.name === name);
const markers = (pg, name) => trace(pg, 'markers', name);
const samples = (pg, name) => markers(pg, name).customdata.map(c => c[0]).join();
// indicators: rows in the Step detectors and Envelopes lists, driven by name
const indRow = (pg, name) => [...pg.d.querySelectorAll('.ind')].find(li => li.querySelector('.ind-name').textContent === name);
const indNames = (pg, list) => [...pg.d.querySelectorAll('#' + list + ' .ind-name')].map(b => b.textContent);
async function addInd(pg, kind, type) {
  const sel = pg.d.getElementById(kind === 'detector' ? 'detAdd' : 'envAdd');
  sel.value = type; sel.dispatchEvent(new pg.w.Event('change')); await sleep(40);
}
async function setParam(pg, name, key, value) {
  const el = indRow(pg, name).querySelector('[data-key="' + key + '"]:not([data-mirror])');
  if (el.type === 'checkbox') { el.checked = value; el.dispatchEvent(new pg.w.Event('change', { bubbles: true })); }
  else { el.value = String(value); el.dispatchEvent(new pg.w.Event('input', { bubbles: true })); }
  await sleep(40);
}
const paramOut = (pg, name, key) => indRow(pg, name).querySelector('output[for$="_' + key + '"]').textContent;
async function act(pg, name, action) { indRow(pg, name).querySelector('[data-act="' + action + '"]').click(); await sleep(40); }
async function setSource(pg, name, v) { const s = indRow(pg, name).querySelector('[data-act="source"]'); s.value = v; s.dispatchEvent(new pg.w.Event('change', { bubbles: true })); await sleep(40); }
const heads = pg => [...pg.d.querySelectorAll('#metricsTable th')].map(th => th.textContent);
const metric = (pg, name) => { const r = [...pg.d.querySelectorAll('#metricsTable tbody tr')].find(tr => tr.cells[0].textContent === name); return r ? [...r.cells].slice(1).map(c => c.textContent) : null; };
async function exportCsv(pg, which) {
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  pg.d.getElementById(which || 'expMetrics').click();
  return new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
}
const C_mean = a => Array.from(a).reduce((x, y) => x + y, 0) / a.length;
const text = (pg, id) => pg.d.getElementById(id).textContent.replace(/\s+/g, ' ').trim();

test('loads a MAT file and compares Coza with Coza (modified), side by side', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  assert.match(text(pg, 'valTitle'), /^Valid/);
  assert.equal($('subtitle').hidden, true, 'subtitle goes once a file is loaded');
  const cfg = pg.plots.at(-1).config;
  assert.equal(cfg.displayModeBar, 'hover');
  assert.ok(['zoomIn2d', 'zoomOut2d'].every(b => cfg.modeBarButtonsToRemove.includes(b)), 'no +/- zoom buttons');
  assert.equal(pg.d.querySelector('#fileChip strong').title, 'walk.mat', 'full name in a tooltip');
  assert.equal($('valList').hidden, true, 'checks start collapsed when the file is valid');
  $('valToggle').click();
  assert.equal($('valList').hidden, false, 'and open on click');
  assert.equal($('analysis').hidden, false);
  assert.equal($('advDetails').open, false, 'advanced options start closed');
  assert.equal($('chanSel').value, '1', 'defaults to column 2, like the .m file');
  // the page opens with the two Cozas, as indicators
  assert.deepEqual(indNames(pg, 'detList'), ['Coza', 'Coza (modified)']);
  assert.equal($('envList').hidden, true);
  assert.deepEqual([...$('detAdd').options].map(o => o.textContent), ['Add a step detector…', 'Coza', 'Coza (modified)', 'Threshold peaks', 'Peak-to-valley', 'Zero-crossing']);
  assert.deepEqual([...$('envAdd').options].map(o => o.textContent), ['Add an envelope or band…', 'Sliding window', 'Peak-trough', 'Dynamic threshold', 'Mean ± k·SD', 'Hilbert envelope', 'Percentile band']);
  assert.equal(indRow(pg, 'Coza').querySelector('.ind-sum').textContent, 'w 30 · h 1');
  assert.equal(indRow(pg, 'Coza (modified)').querySelector('.ind-sum').textContent, 'h 1 · window 0.30 s · weak peaks dropped');
  assert.ok(!/lab code/i.test(pg.d.body.textContent), 'no "lab code" anywhere on the page');
  assert.ok(!/Lab 1/.test(pg.d.body.innerHTML) && pg.d.body.innerHTML.includes('BME 598/494 (Dr. Aurel Coza)'), 'the course by code and instructor, never "Lab 1" (#78)');
  const lab = markers(pg, 'Coza').x.length, fixed = markers(pg, 'Coza (modified)').x.length;
  assert.equal(lab - fixed, 1, 'Coza counts the tied peak twice');
  assert.notEqual(markers(pg, 'Coza').marker.symbol, markers(pg, 'Coza (modified)').marker.symbol);
  const colorVar = name => indRow(pg, name).style.getPropertyValue('--ic'); // jsdom can't resolve the colours themselves
  assert.notEqual(colorVar('Coza'), colorVar('Coza (modified)'));
  assert.equal(traces(pg, 'guide').length, 0, 'neither draws guide lines');
  assert.equal(pg.plots.at(-1).layout.shapes.length, 2, 'an h line for each');
  assert.deepEqual([...$('legInd').children].map(c => c.textContent), ['Coza', 'Coza h = 1', 'Coza (modified)', 'Coza (modified) h = 1']);
  assert.match(text(pg, 'valList'), /Coza counts 1 peak twice.*Coza \(modified\) counts each once/);
  assert.deepEqual(heads(pg), ['Metric', 'Coza', 'Coza (modified)']);
  const names = [...pg.d.querySelectorAll('#metricsTable td .tip')];
  assert.equal(names.length, 11, '7 shared rows and Coza’s 4');
  assert.ok(names.every(n => n.title.length > 20), 'every metric explains itself in a tooltip');
  assert.deepEqual(metric(pg, 'Steps'), [String(lab), String(fixed)]);
  assert.deepEqual(metric(pg, 'Pace (Coza’s formula)').slice(1), ['—'], 'Coza’s formulas are Coza’s');
  assert.equal($('cozaNote').hidden, false);
  assert.equal($('stepsDetails').open, false, 'steps table starts collapsed');
  assert.equal(text(pg, 'stepsTitle'), 'All steps (' + lab + ' Coza, ' + fixed + ' Coza (modified))');
  assert.match($('stepsTable').textContent, /dropped: weak peak|—/);

  // each has its own settings: Coza's w (samples) doesn't move Coza (modified), whose window is in seconds
  await act(pg, 'Coza', 'open');
  assert.equal(indRow(pg, 'Coza').querySelector('.ind-body').hidden, false);
  assert.equal(paramOut(pg, 'Coza', 'w'), '30 samples (0.30 s)');
  await setParam(pg, 'Coza', 'w', 150);
  assert.equal(indRow(pg, 'Coza').querySelector('.ind-sum').textContent, 'w 150 · h 1');
  assert.notEqual(markers(pg, 'Coza').x.length, lab, 'Coza follows its w');
  assert.equal(markers(pg, 'Coza (modified)').x.length, fixed, 'Coza (modified) doesn’t');
  await act(pg, 'Coza (modified)', 'open');
  assert.equal(paramOut(pg, 'Coza (modified)', 'cozaWindow'), '0.30 s (30 samples)');
  await setParam(pg, 'Coza (modified)', 'h', 0.35);
  assert.match(text(pg, 'legInd'), /Coza \(modified\) h = 0\.35/);
  assert.equal(indRow(pg, 'Coza (modified)').querySelector('input[type=range][data-key="h"]').value, '0.35', 'box and slider together');
  await act(pg, 'Coza', 'reset');
  assert.equal(markers(pg, 'Coza').x.length, lab, 'Default settings');

  // the steps export: a column per detector
  let saved = null;
  pg.w.HTMLAnchorElement.prototype.click = function () { saved = this.download; };
  $('expSteps').click();
  assert.equal(saved, 'walk_steps.csv');
  const csv = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  assert.match(csv, /^time_s,sample_matlab,value,coza,coza_modified\n/);
  assert.match(csv, /\n[\d.]+,\d+,[-\d.]+,step,step\n/, 'found by both');
  assert.match(csv, /\n[\d.]+,450,[-\d.]+,step,\n/, 'the tied peak: Coza only');
  assert.match(csv, /\n[\d.]+,\d+,[-\d.]+,,weak peak\n/, 'dropped by Coza (modified)');
});

test('notes are pinned to the plot, listed, exported and deleted, without changing steps', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  const stepsBefore = text(pg, 'stepsTitle');
  $('plot')._click({ points: [{ x: 3.25, curveNumber: 0 }] });
  assert.equal($('noteForm').hidden, true, 'clicks do nothing until note mode is on');

  $('noteMode').checked = true; $('noteMode').dispatchEvent(new pg.w.Event('change'));
  assert.equal($('noteHint').hidden, false);
  $('plot')._click({ points: [{ x: 3.25, curveNumber: 0 }] });
  assert.equal($('noteForm').hidden, false);
  assert.equal(text(pg, 'noteAt'), 'Note at 3.25 s');
  $('noteText').value = '  turned <around>  ';
  $('noteForm').dispatchEvent(new pg.w.Event('submit', { cancelable: true }));
  assert.equal($('noteForm').hidden, true);
  assert.match(text(pg, 'noteList'), /3\.25 s\s*turned <around>/);
  assert.equal($('legNotes').hidden, false);
  const lay = pg.plots.at(-1).layout;
  assert.equal(lay.annotations.length, 1);
  assert.equal(lay.annotations[0].text, 'turned &lt;around&gt;', 'note text is escaped for Plotly');
  assert.ok(lay.shapes.some(s => s.x0 === 3.25 && s.yref === 'paper'));
  assert.equal(text(pg, 'stepsTitle'), stepsBefore, 'notes never change the steps');

  // an empty note is not added; Cancel closes the form
  $('plot')._click({ points: [{ x: 5, curveNumber: 0 }] });
  $('noteText').value = '   ';
  $('noteForm').dispatchEvent(new pg.w.Event('submit', { cancelable: true }));
  assert.equal($('noteForm').hidden, false);
  $('noteCancel').click();
  assert.equal($('noteForm').hidden, true);
  assert.equal($('noteList').children.length, 1);

  const csv = await exportCsv(pg);
  assert.match(csv, /note_plot,note_kind,note_x,note_y,note\nsignal,time,3\.250,,turned <around>\n/);
  assert.match(csv, /\ncoza,Coza: w 30 · h 1 \(filtered\)\ncoza_modified,Coza \(modified\): h 1 · window 0\.30 s · weak peaks dropped \(filtered\)\n/, 'each detector with its settings');

  $('noteList').querySelector('button').click();
  assert.equal($('noteList').hidden, true);
  assert.equal(pg.plots.at(-1).layout.annotations.length, 0);
});

test('the interval strip is off by default and can be turned on', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  let { layout } = pg.plots.at(-1);
  assert.equal($('showIntervals').checked, false);
  assert.equal(traces(pg, 'intervals').length, 0);
  assert.deepEqual([...layout.yaxis.domain], [0, 1], 'the signal takes the full height');
  assert.equal(layout.yaxis2.visible, false); assert.equal(layout.xaxis.anchor, 'y');
  $('showIntervals').checked = true; $('showIntervals').dispatchEvent(new pg.w.Event('change'));
  ({ layout } = pg.plots.at(-1));
  assert.deepEqual(traces(pg, 'intervals').map(t => t.name), ['Coza interval', 'Coza (modified) interval'], 'one per detector');
  assert.ok(traces(pg, 'intervals').every(t => t.yaxis === 'y2'));
  // the spectrum's rhythm over time sits in the same strip: column 2 repeats about every 1.1 s
  const rh = trace(pg, 'rhythm');
  assert.equal(rh.yaxis, 'y2');
  const periods = rh.y.filter(v => v !== null);
  assert.ok(periods.length > 10 && periods.every(v => v > 1 && v < 1.25), 'about 1.1 s: ' + periods.slice(0, 3));
  assert.deepEqual([...layout.yaxis.domain], [0.3, 1]);
  assert.equal(layout.yaxis2.visible, true); assert.equal(layout.xaxis.anchor, 'y2');
  assert.match($('plot').getAttribute('aria-label'), /time between steps/);
});

test('indicators can be hidden, removed, added again and repeated with their own settings', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  await act(pg, 'Coza', 'eye');
  assert.equal(markers(pg, 'Coza'), undefined, 'hidden: off the plot');
  assert.ok(indRow(pg, 'Coza').classList.contains('off')); assert.equal(indRow(pg, 'Coza').querySelector('[data-act=eye]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(heads(pg), ['Metric', 'Coza (modified)'], 'and out of the metrics');
  assert.equal(metric(pg, 'Pace (Coza’s formula)'), null, 'Coza’s own rows go with it');
  assert.equal($('cozaNote').hidden, true);
  assert.doesNotMatch(text(pg, 'valList'), /counts 1 peak twice/, 'checks about it go too');
  assert.equal(pg.plots.at(-1).layout.shapes.length, 1);
  await act(pg, 'Coza', 'eye');
  assert.deepEqual(heads(pg), ['Metric', 'Coza', 'Coza (modified)']);

  await act(pg, 'Coza', 'remove');
  await act(pg, 'Coza (modified)', 'remove');
  assert.deepEqual(indNames(pg, 'detList'), []);
  assert.equal($('detNone').hidden, false);
  assert.match(text(pg, 'valList'), /No step detector on the plot/);
  assert.deepEqual(heads(pg), ['Metric']);
  assert.equal(traces(pg, 'markers').length, 0);

  // the same detector twice, with different settings: numbered, coloured apart
  await addInd(pg, 'detector', 'coza_original');
  await addInd(pg, 'detector', 'coza_original');
  assert.deepEqual(indNames(pg, 'detList'), ['Coza 1', 'Coza 2']);
  assert.equal(indRow(pg, 'Coza 2').querySelector('.ind-body').hidden, false, 'a new one opens its settings');
  await setParam(pg, 'Coza 2', 'w', 150);
  assert.notEqual(samples(pg, 'Coza 1'), samples(pg, 'Coza 2'));
  assert.notEqual(indRow(pg, 'Coza 1').style.getPropertyValue('--ic'), indRow(pg, 'Coza 2').style.getPropertyValue('--ic'));
  assert.deepEqual(heads(pg), ['Metric', 'Coza 1', 'Coza 2']);
  const csv = await exportCsv(pg, 'expSteps');
  assert.match(csv, /^time_s,sample_matlab,value,coza,coza_2\n/);
});

test('Coza is the rule in LabStepDet_2025.m, with its own w and h, tied peaks kept', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const C = pg.w.StepCore, sig = () => Float64Array.from(trace(pg, 'signal').y);
  const want = (w, h) => C.detectOriginal(sig(), w, h).map(i => i + 1).join();
  assert.equal(samples(pg, 'Coza'), want(30, 1));
  await act(pg, 'Coza', 'open');
  const body = indRow(pg, 'Coza').querySelector('.ind-body');
  assert.match(body.textContent, /exactly as written, bugs included/);
  assert.match(body.querySelector('.howto').textContent, /tied peaks count twice and the stop bump counts as a step/);
  assert.deepEqual([...body.querySelectorAll('[data-key]:not([data-mirror])')].map(e => e.dataset.key), ['w', 'h']);
  await setParam(pg, 'Coza', 'w', 50); assert.equal(samples(pg, 'Coza'), want(50, 1));
  await setParam(pg, 'Coza', 'h', 2); assert.equal(samples(pg, 'Coza'), want(50, 2));
  assert.doesNotMatch(text(pg, 'valList'), /Coza drops/, 'no weak-peak removal');
});

test('Threshold peaks draws its smoothed signal and threshold, and does not use h', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  await addInd(pg, 'detector', 'threshold');
  assert.deepEqual(indNames(pg, 'detList'), ['Coza', 'Coza (modified)', 'Threshold peaks']);
  const smooth = trace(pg, 'guide', 'Threshold peaks: Smoothed (3 Hz)'), level = traces(pg, 'guide').find(t => /^Threshold peaks: Mean \+ k·SD = /.test(t.name));
  assert.ok(smooth && level); assert.equal(level.line.dash, 'dash');
  assert.match(text(pg, 'legInd'), /Threshold peaks: Mean \+ k·SD = -?\d+\.\d\d/, 'not confused with h');
  const m = markers(pg, 'Threshold peaks');
  assert.ok(m.x.length >= 10, 'finds the walk');
  assert.ok(m.y.every((y, k) => Math.abs(y - 2 * ((Math.max(...trace(pg, 'signal').y) - Math.min(...trace(pg, 'signal').y)) * 0.06) - smooth.y[m.customdata[k][0] - 1]) < 1e-9), 'markers sit on the smoothed signal, stacked above the other two');
  assert.equal(pg.plots.at(-1).layout.shapes.length, 2, 'no h line of its own');
  assert.ok(!/Threshold peaks h =/.test(text(pg, 'legInd')));
  assert.deepEqual([...indRow(pg, 'Threshold peaks').querySelectorAll('[data-key]')].map(e => e.dataset.key), ['tpCutoff', 'tpK', 'tpMinInterval']);
  const before = level.y[0];
  await setParam(pg, 'Threshold peaks', 'tpK', 1.5);
  assert.equal(paramOut(pg, 'Threshold peaks', 'tpK'), '1.50 SD');
  assert.ok(traces(pg, 'guide').find(t => /^Threshold peaks: Mean/.test(t.name)).y[0] > before, 'threshold moves with k');
  await act(pg, 'Threshold peaks', 'reset');
  assert.equal(paramOut(pg, 'Threshold peaks', 'tpK'), '0.50 SD');
  const csv = await exportCsv(pg);
  assert.match(csv, /^metric,unit,coza,coza_modified,threshold\n/);
  assert.match(csv, /\nthreshold,Threshold peaks: cut-off 3\.0 Hz · k 0\.50 SD · min 0\.25 s \(filtered\)\n/);
});

test('Peak-to-valley draws its dynamic threshold and has its own options', async () => {
  const pg = makePage();
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  await addInd(pg, 'detector', 'peakvalley');
  const dyn = trace(pg, 'guide', 'Peak-to-valley: Dynamic threshold');
  assert.equal(dyn.y.length, trace(pg, 'signal').y.length, 'one threshold value per sample');
  assert.equal(paramOut(pg, 'Peak-to-valley', 'pvSwing'), '40%');
  const n = markers(pg, 'Peak-to-valley').x.length;
  assert.ok(n >= 14 && n <= 17, n + ' steps on the demo walk');
  await setParam(pg, 'Peak-to-valley', 'pvSwing', 100);
  assert.equal(paramOut(pg, 'Peak-to-valley', 'pvSwing'), '100%');
  assert.ok(markers(pg, 'Peak-to-valley').x.length < n, 'a higher minimum swing keeps fewer steps');
});

test('Zero-crossing marks crossings of its baseline and exports its settings', async () => {
  const pg = makePage();
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  await addInd(pg, 'detector', 'zerocross');
  const base = trace(pg, 'guide', 'Zero-crossing: Baseline (0.3 Hz)').y, sm = trace(pg, 'guide', 'Zero-crossing: Smoothed (3 Hz)').y;
  const m = markers(pg, 'Zero-crossing');
  assert.ok(m.x.length >= 14 && m.x.length <= 17, m.x.length + ' steps on the demo walk');
  for (const [s1] of m.customdata) assert.ok(sm[s1 - 2] < base[s1 - 2] && sm[s1 - 1] >= base[s1 - 1], 'each marker is an upward crossing');
  assert.match(text(pg, 'stepsTitle'), /Zero-crossing/);
  const $ = id => pg.d.getElementById(id);
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  $('expFmt').value = 'zip'; $('expFmt').dispatchEvent(new pg.w.Event('change'));
  $('expGo').click(); await sleep(20);
  const bytes = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.readAsArrayBuffer(pg.blobs.at(-1)); });
  const ind = new TextDecoder().decode(Core.parseZip(bytes).find(e => e.name === 'indicators.csv').read());
  assert.match(ind, /zerocross,detector,zerocross,Zero-crossing,filtered,c3,"\{""zcCutoff"":3,""zcMinInterval"":0\.25\}","\{""lowpass_cutoff_hz"":3,""baseline_cutoff_hz"":0\.3,""hysteresis_sd"":0\.3,""hysteresis_value"":[\d.]+,""min_interval_s"":0\.25\}"/);
});

test('a filter feeds the indicators that take the filtered signal, drawn over the faded recording', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  assert.deepEqual([...$('filterSel').options].map(o => o.textContent), ['None', 'Butterworth', 'Bessel', 'Chebyshev I', 'Chebyshev II', 'Elliptic', 'Moving average', 'Median', 'Savitzky–Golay', 'Wavelet (Daubechies-4)', 'Notch']);
  assert.equal($('filterSel').value, 'none', 'off by default');
  assert.equal($('filterOpts').hidden, true);
  assert.equal(trace(pg, 'filtered'), undefined); assert.equal(trace(pg, 'signal').opacity, 1);
  const cozaBefore = samples(pg, 'Coza');
  // the walk fixture runs at about 100 Hz: the low-pass slider stops below 50 Hz
  assert.equal($('fLowIn').max, '20');
  await setSource(pg, 'Coza', 'recorded');

  $('filterSel').value = 'cheby1'; $('filterSel').dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  assert.match(text(pg, 'filterDesc'), /ripple in the passband/);
  assert.equal($('filterOpts').hidden, false);
  assert.equal($('fRippleIn').closest('.ctl').hidden, false, 'ripple shown');
  assert.equal($('fAttenIn').closest('.ctl').hidden, true, 'attenuation hidden');
  assert.equal(text(pg, 'fOrderOut'), '4th order'); assert.equal(text(pg, 'fHighOut'), 'off');
  assert.ok(trace(pg, 'filtered')); assert.equal(trace(pg, 'signal').opacity, 0.35);
  assert.equal($('legFilter').hidden, false);
  assert.equal(samples(pg, 'Coza'), cozaBefore, 'Coza, set to Unfiltered, still runs on the recorded signal');
  const filtered = trace(pg, 'filtered').y, m = markers(pg, 'Coza (modified)');
  assert.ok(m.customdata.every(([s1, v]) => v === filtered[s1 - 1]), 'Coza (modified) runs on the filtered signal');
  assert.match(text(pg, 'valList'), /Resampled for filtering.*even \d+\.\d Hz grid/, 'the fixture has phone-like timing');

  const hp = $('fHighIn');
  hp.value = '0.3'; hp.dispatchEvent(new pg.w.Event('input'));
  await sleep(40);
  assert.equal(text(pg, 'fHighOut'), '0.30 Hz');
  assert.match(text(pg, 'valList'), /h applies to the filtered signal.*Coza \(modified\) compares h with the filtered values/);

  const csv = await exportCsv(pg);
  assert.match(csv, /\nfilter,"Chebyshev I, 4th order, 0\.3–3\.0 Hz band-pass, 0\.5 dB ripple"\nfilter_resampled,true\n/);
  assert.match(csv, /\ncoza,Coza: w 30 · h 1 \(unfiltered\)\n/);

  $('resetParams').click();
  assert.equal(hp.value, '0'); assert.equal(text(pg, 'fHighOut'), 'off');
});

test('every filter shows only its own settings, and presets set an IIR band-pass', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'ptb_gforce.csv'));
  const $ = id => pg.d.getElementById(id);
  const visible = () => [...$('filterOpts').querySelectorAll('input[data-param]')].filter(el => !el.closest('[data-only]').hidden).map(el => el.dataset.param);
  const want = { butter: ['fOrder', 'fLow', 'fHigh'], bessel: ['fOrder', 'fLow', 'fHigh'], cheby1: ['fOrder', 'fLow', 'fHigh', 'fRipple'],
    cheby2: ['fOrder', 'fLow', 'fHigh', 'fAtten'], ellip: ['fOrder', 'fLow', 'fHigh', 'fRipple', 'fAtten'], movavg: ['maWindow'], median: ['medWindow'],
    savgol: ['sgWindow', 'sgOrder'], wavelet: ['wLevel', 'wScale'], notch: ['notchFreq', 'notchQ'] };
  let n = 0;
  for (const [id, params] of Object.entries(want)) {
    $('filterSel').value = id; $('filterSel').dispatchEvent(new pg.w.Event('change'));
    await sleep(30);
    assert.deepEqual(visible().sort(), params.slice().sort(), id);
    assert.ok(trace(pg, 'filtered'), id + ' applied with its defaults');
    assert.equal(pg.d.querySelector('.presets').hidden, !['butter', 'bessel', 'cheby1', 'cheby2', 'ellip'].includes(id), id + ': presets for IIR only');
    n++;
  }
  assert.equal(n, $('filterSel').options.length - 1, 'every filter but None checked');
  assert.equal(text(pg, 'sgOrderOut'), '3', 'no trailing unit');

  $('filterSel').value = 'bessel'; $('filterSel').dispatchEvent(new pg.w.Event('change'));
  $('fOrderIn').value = '2'; $('fOrderIn').dispatchEvent(new pg.w.Event('input'));
  pg.d.querySelector('[data-preset="0.5 3"]').click();
  await sleep(40);
  assert.equal($('filterSel').value, 'bessel', 'the type stays');
  assert.equal(text(pg, 'fOrderOut'), '4th order'); assert.equal(text(pg, 'fHighOut'), '0.50 Hz'); assert.equal(text(pg, 'fLowOut'), '3.0 Hz');
  assert.match(await exportCsv(pg), /\nfilter,"Bessel, 4th order, 0\.5–3\.0 Hz band-pass"\n/);
});

test('impossible filter settings are reported, not applied', async () => {
  const pg = makePage();
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  const $ = id => pg.d.getElementById(id);
  $('filterSel').value = 'butter'; $('filterSel').dispatchEvent(new pg.w.Event('change'));
  const lp = $('fLowIn'), hp = $('fHighIn');
  lp.value = '0.5'; lp.dispatchEvent(new pg.w.Event('input'));
  hp.value = '0.8'; hp.dispatchEvent(new pg.w.Event('input'));
  await sleep(40);
  assert.match(text(pg, 'valList'), /Filter not applied.*high-pass cut-off must be below the low-pass.*To fix: Change the filter settings under Advanced/);
  assert.equal(trace(pg, 'filtered'), undefined);
  assert.equal($('legFilter').hidden, true);
});

test('resampling feeds everything downstream, shows the recording behind it, and off changes nothing', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'ptb_gforce.csv'));
  const $ = id => pg.d.getElementById(id);
  const change = async (id, v) => { if (v !== undefined) { if ($(id).type === 'checkbox') $(id).checked = v; else $(id).value = v; } $(id).dispatchEvent(new pg.w.Event('change')); await sleep(40); };
  const snapshot = async () => ({ coza: samples(pg, 'Coza'), mod: samples(pg, 'Coza (modified)'), metrics: $('metricsTable').innerHTML, stepsTable: $('stepsTable').innerHTML, csv: await exportCsv(pg) });
  await change('chanSel', '2'); // gFy: carries gravity, so Coza finds steps at h = 1
  assert.equal($('rsSel').value, 'off', 'no rate is built in');
  assert.equal($('rsRateRow').hidden, true); assert.equal($('rsOpts').hidden, true);
  const off = await snapshot();
  assert.ok(off.coza.split(',').length > 5 && off.mod.split(',').length > 5);
  assert.match(off.csv, /\nresample,off\n/);
  assert.equal(trace(pg, 'recorded'), undefined);

  await change('rsSel', 'rate');
  assert.equal($('rsRateRow').hidden, false); assert.equal($('rsRate').value, '', 'the rate starts empty');
  assert.match(text(pg, 'valList'), /Resampling not applied.*No rate is set.*Type a rate/);
  assert.equal((await snapshot()).coza, off.coza, 'no rate: nothing changes');

  await change('rsRate', '50');
  const rec = trace(pg, 'recorded');
  assert.equal(rec.zorder, -1);
  assert.equal(rec.y.length, 1800, 'every recorded row, behind the resampled signal');
  const sig = trace(pg, 'signal');
  assert.ok(Math.abs(sig.x[1] - sig.x[0] - 0.02) < 1e-12, 'the signal is on a 50 Hz grid');
  assert.ok(sig.y.length < rec.y.length * 0.55);
  assert.equal($('legResample').hidden, false);
  assert.match(text(pg, 'valList'), /Resampled to 50\.0 Hz.*straight lines between samples \(like MATLAB interp1\)/);
  assert.match(text(pg, 'valList'), /Coza assumes 100 Hz.*the 50\.0 Hz it receives after resampling/);
  assert.match(text(pg, 'valList'), /No anti-aliasing.*folds back/);
  await act(pg, 'Coza', 'open'); await act(pg, 'Coza (modified)', 'open');
  assert.equal(paramOut(pg, 'Coza', 'w'), '30 samples (0.60 s)', 'Coza’s window counts samples on the new grid');
  assert.equal(paramOut(pg, 'Coza (modified)', 'cozaWindow'), '0.30 s (15 samples)', 'Coza (modified)’s stays 0.3 s');
  assert.match(await exportCsv(pg), /\nsampling_rate_hz,50\nrecorded_rate_hz,[\d.]+\nresample,"50\.00 Hz, linear"\n/);

  await change('rsMethod', 'pchip'); await change('rsAA', true);
  assert.match(text(pg, 'valList'), /Resampled to 50\.0 Hz.*monotone cubic.*Low-passed at 20\.0 Hz first/);
  assert.doesNotMatch(text(pg, 'valList'), /No anti-aliasing/);
  assert.match(await exportCsv(pg), /\nresample,"50\.00 Hz, pchip, anti-aliased"\n/);

  // the preset, then a filter on top: the filter's base line is the resampled signal
  $('rsAA').checked = false; $('rsMethod').value = 'linear';
  pg.d.querySelector('[data-rs-rate="100"]').click(); await sleep(40);
  assert.equal($('rsRate').value, '100');
  assert.doesNotMatch(text(pg, 'valList'), /Coza assumes 100 Hz/);
  await change('filterSel', 'butter');
  assert.equal(text(pg, 'legFilterBase'), 'Resampled');
  assert.doesNotMatch(text(pg, 'valList'), /Resampled for filtering/, 'the grid is already even');
  await change('filterSel', 'none');

  await change('rsSel', 'even');
  assert.equal($('rsRateRow').hidden, true);
  assert.match(text(pg, 'valList'), /Resampled to 1\d\d Hz/);

  await change('rsSel', 'off');
  await act(pg, 'Coza', 'open'); await act(pg, 'Coza (modified)', 'open'); // closed again, as in the snapshot
  assert.deepEqual(await snapshot(), off, 'off again: steps, metrics and exports as before');
  assert.equal(trace(pg, 'recorded'), undefined); assert.equal($('legResample').hidden, true);
});

test('envelopes are drawn around the signal, several at once, and never change steps or metrics', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  const metricsCsv = async () => (await exportCsv(pg)).split('\n\n')[0];
  const snapshot = async () => ({ coza: samples(pg, 'Coza'), mod: samples(pg, 'Coza (modified)'), metrics: $('metricsTable').innerHTML, stepsTable: $('stepsTable').innerHTML, csv: await metricsCsv() });
  const before = await snapshot();
  for (const id of ['sliding', 'peaktrough', 'meansd', 'hilbert', 'percentile', 'dynamic']) {
    await addInd(pg, 'envelope', id);
    const name = indNames(pg, 'envList')[0];
    const lo = trace(pg, 'envLower').y, up = trace(pg, 'envUpper'), sig = trace(pg, 'signal').y;
    assert.equal(up.fill, 'tonexty', id + ': shaded band');
    assert.ok(Array.from(sig).every((v, i) => up.y[i] >= lo[i]), id + ': upper above lower');
    if (id === 'sliding' || id === 'dynamic') assert.ok(Array.from(sig).every((v, i) => lo[i] <= v && v <= up.y[i]), id + ': the signal stays inside');
    const mid = { dynamic: 'Dynamic threshold (envelope)', meansd: 'Moving mean' }[id];
    assert.equal(traces(pg, 'envMid').length, mid ? 1 : 0, id + ': midline only where the envelope has one');
    if (mid) { assert.equal(trace(pg, 'envMid').name, name + ': ' + mid); assert.match(text(pg, 'legInd'), new RegExp(name.replace(/[±·()]/g, '.') + ': ' + mid.replace(/[()]/g, '.'))); }
    assert.deepEqual(await snapshot(), before, id + ': a view only');
    assert.equal(pg.plots.at(-1).layout.shapes.length, 2, id + ': the h lines stay');
    await act(pg, name, 'remove');
  }
  assert.equal($('envList').hidden, true);

  // two at once, each in its own colour, each with its settings
  await addInd(pg, 'envelope', 'sliding'); await addInd(pg, 'envelope', 'meansd');
  assert.deepEqual(indNames(pg, 'envList'), ['Sliding window', 'Mean ± k·SD']);
  assert.equal(traces(pg, 'envUpper').length, 2);
  assert.notEqual(indRow(pg, 'Sliding window').style.getPropertyValue('--ic'), indRow(pg, 'Mean ± k·SD').style.getPropertyValue('--ic'));
  assert.match(text(pg, 'legInd'), /Sliding window \(window 1\.0 s\).*Mean ± k·SD \(window 1\.0 s · k 1\.00 SD\)/);
  await setParam(pg, 'Sliding window', 'envWindow', 2);
  assert.match(text(pg, 'legInd'), /Sliding window \(window 2\.0 s\)/);
  assert.equal(samples(pg, 'Coza (modified)'), before.mod, 'steps unchanged by the window');
  await act(pg, 'Mean ± k·SD', 'remove');

  // peak-trough: the smooth-joins checkbox changes the line, not the steps
  await addInd(pg, 'envelope', 'peaktrough');
  const straight = Array.from(traces(pg, 'envUpper')[1].y);
  await setParam(pg, 'Peak-trough', 'envSmooth', true);
  assert.notDeepEqual(Array.from(traces(pg, 'envUpper')[1].y), straight);
  assert.equal(indRow(pg, 'Peak-trough').querySelector('.ind-sum').textContent, 'window 0.30 s · smooth');
  await act(pg, 'Peak-trough', 'reset');
  assert.equal(indRow(pg, 'Peak-trough').querySelector('[data-key="envSmooth"]').checked, false, 'Default settings turns it off');
  await act(pg, 'Peak-trough', 'remove');

  // with a filter on, an envelope on the filtered signal follows it; set to Unfiltered, the recording
  $('filterSel').value = 'butter'; $('filterSel').dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  let f = trace(pg, 'filtered').y, hi = trace(pg, 'envUpper').y;
  assert.ok(Array.from(f).every((v, i) => v <= hi[i]));
  assert.ok(Array.from(trace(pg, 'signal').y).some((v, i) => v > hi[i]), 'not the recorded signal');
  await setSource(pg, 'Sliding window', 'recorded');
  hi = trace(pg, 'envUpper').y;
  assert.ok(Array.from(trace(pg, 'signal').y).every((v, i) => v <= hi[i]), 'now the recorded signal');
  await act(pg, 'Sliding window', 'eye');
  assert.equal(traces(pg, 'envUpper').length, 0);
});

test('the spectrum panel shows the walking rhythm, the filter gain and a cadence cross-check', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  let sp = pg.spectra.at(-1);
  assert.ok(sp, 'drawn with the main plot');
  assert.equal(sp.traces[0].visible, false, 'no faded recording without a filter');
  assert.equal(sp.traces[2].visible, false, 'no filter gain without a filter');
  assert.match(sp.layout.annotations[0].text, /^0\.9\d Hz = 5\d\/min$/, 'the stride-rate peak of column 2');
  assert.equal(sp.layout.yaxis.type, 'linear');
  assert.match(text(pg, 'specCadNote'), /^From the spectrum, without detecting steps: 5\d\.\d steps\/min \(60 × the strongest walking frequency, resolution about [\d.]+\/min\)\.$/);
  assert.match(text(pg, 'specNote'), /strongest rhythm .* 0\.9\d Hz: 5\d per minute/);
  assert.ok(metric(pg, 'Harmonic ratio').every(v => /^\d+\.\d\d$/.test(v)), 'for each detector');

  $('specLog').checked = true; $('specLog').dispatchEvent(new pg.w.Event('change'));
  assert.equal(pg.spectra.at(-1).layout.yaxis.type, 'log');

  $('filterSel').value = 'butter'; $('filterSel').dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  sp = pg.spectra.at(-1);
  assert.equal(sp.traces[0].visible, true, 'recording faded behind the filtered spectrum');
  assert.equal(sp.traces[2].visible, true); assert.equal(sp.traces[2].yaxis, 'y2');
  const g = sp.traces[2].y, f = sp.traces[2].x;
  assert.ok(g[f.findIndex(v => v >= 1)] > 0.95 && g[f.findIndex(v => v >= 8)] < 0.05, 'keeps 1 Hz, removes 8 Hz');
  $('filterSel').value = 'median'; $('filterSel').dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  assert.equal(pg.spectra.at(-1).traces[2].visible, false); assert.match(text(pg, 'specNote'), /isn’t linear/);

  // magnitude: two bumps per stride, so the spectrum's rhythm is twice the detectors' peak rate
  $('filterSel').value = 'none'; $('filterSel').dispatchEvent(new pg.w.Event('change'));
  $('chanSel').value = '4'; $('chanSel').dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  assert.match(text(pg, 'valList'), /Spectrum and steps differ by a factor of 2.*Coza \(modified\) gives/);
  const csv = await exportCsv(pg);
  assert.match(csv, /\nharmonic_ratio,even\/odd harmonics per stride,[\d.]+,[\d.]+\n/);
  assert.match(csv, /\nspectrum_segment_s,(7\.99|8\.00)\d*\n/, '8 s, as a whole number of samples');
});

test('moving a detector setting reuses the filter and spectra; their own settings recompute them', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id), C = pg.w.StepCore, calls = { spectrum: 0, rhythmOverTime: 0, applyFilter: 0 };
  for (const k of Object.keys(calls)) { const f = C[k]; C[k] = (...a) => { calls[k]++; return f(...a); }; }
  await act(pg, 'Coza (modified)', 'open');
  await setParam(pg, 'Coza (modified)', 'h', 0.5);
  await setParam(pg, 'Coza (modified)', 'cozaWindow', 0.4);
  assert.deepEqual(calls, { spectrum: 0, rhythmOverTime: 0, applyFilter: 0 }, 'cached');
  const input = (id, v) => { $(id).value = v; $(id).dispatchEvent(new pg.w.Event('input')); };
  input('specSegIn', '6'); await sleep(40);
  assert.equal(calls.spectrum, 1); assert.equal(calls.rhythmOverTime, 0);
  $('filterSel').value = 'butter'; $('filterSel').dispatchEvent(new pg.w.Event('change')); await sleep(40);
  assert.equal(calls.applyFilter, 1); assert.equal(calls.spectrum, 3, 'filtered and recorded spectra'); assert.equal(calls.rhythmOverTime, 1);
});

test('the demo walk: its 17 steps, faint first and last ones included, and each detector scored against them (#81)', async () => {
  const pg = makePage();
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  assert.equal(markers(pg, 'Coza').x.length, 17); assert.equal(markers(pg, 'Coza (modified)').x.length, 17, 'faint steps on the rhythm are kept');
  assert.doesNotMatch(text(pg, 'valList'), /drops \d+ weak peak/);
  assert.match(text(pg, 'valList'), /The synthetic walk has 17 steps ?Coza finds 17 \(exactly right\); Coza \(modified\) finds 17 \(exactly right\)\..*first and last steps are faint/);
  // its true count goes into the export's settings, not as a hand count
  const st = await exportCsv(pg);
  assert.match(st, /steps_in_synthetic_walk,17/); assert.doesNotMatch(st, /counted_by_hand/);

  // Phone position: on one leg, each peak is a stride (2 steps)
  const pos = pg.d.getElementById('posSel');
  assert.equal(pos.value, 'hand');
  assert.equal(metric(pg, 'Steps')[1], '17');
  pos.value = 'leg'; pos.dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  assert.match(metric(pg, 'Steps')[1], /^34\s*17 strides × 2$/);
  assert.match(text(pg, 'posHint'), /stride/);
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  assert.equal(pos.value, 'hand', 'a new recording starts as hand or waist');
});

test('vertical and horizontal signals appear for recordings with gravity, disabled with the reason otherwise', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'ptb_gforce.csv'));
  const $ = id => pg.d.getElementById(id);
  const opt = key => [...$('chanSel').options].find(o => o.value === key);
  assert.equal(opt('vertical').textContent, 'vertical (along gravity, computed)'); assert.equal(opt('vertical').disabled, false);
  assert.equal(opt('horizontal').disabled, false);
  $('chanSel').value = 'vertical'; $('chanSel').dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  assert.match(text(pg, 'plotTitle'), /, vertical \(computed\)$/);
  assert.equal(pg.plots.at(-1).layout.yaxis.title.text, 'vertical (computed) (g)');
  assert.ok(Math.abs(C_mean(trace(pg, 'signal').y)) < 0.05, 'gravity subtracted: centred near 0 g');
  $('valToggle').click();
  assert.match(text(pg, 'valList'), /Vertical acceleration from the direction of gravity/);
  assert.match(await exportCsv(pg), /\nsignal,vertical \(computed\)\n/);

  await upload(pg, path.join(FIX, 'walk.mat'));
  assert.equal(opt('vertical').disabled, true);
  assert.equal(opt('vertical').textContent, 'vertical: not available, no steady gravity in x, y, z (it looks removed)');
  assert.equal(opt('horizontal'), undefined);
});

test('reads a MATLAB v7.3 file like the v5 one', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk_v73.mat'));
  assert.match(text(pg, 'valTitle'), /^Valid/);
  pg.d.getElementById('valToggle').click();
  pg.d.getElementById('passToggle').click();
  assert.match(text(pg, 'valList'), /MATLAB v7\.3 file read.*HDF5 format, read with jsfive\. 1 variable found: Walking \(double, 1800×5\)/);
  const v73 = samples(pg, 'Coza');
  const ref = makePage();
  await upload(ref, path.join(FIX, 'walk.mat'));
  assert.equal(v73, samples(ref, 'Coza'), 'the same steps as walk.mat');

  await upload(pg, path.join(FIX, 'walk_v73_mixed.mat'));
  assert.deepEqual([...pg.d.getElementById('varSel').options].map(o => o.textContent), ['A (25×5, double)', 'rec.acc (1800×3, int16)']);
  assert.match(text(pg, 'valList'), /"labels" is a cell array/);
});

test('reads a phyphox zip and lists what its metadata says', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'phyphox.zip'));
  assert.doesNotMatch(text(pg, 'valTitle'), /can’t be analysed/);
  const opts = [...pg.d.getElementById('chanSel').options].map(o => o.textContent);
  assert.deepEqual(opts.slice(0, 4), ['x (Acceleration x)', 'y (Acceleration y)', 'z (Acceleration z)', 'magnitude (Absolute acceleration)']);
  assert.ok(opts.includes('vertical (along gravity, computed)'), 'phyphox "Acceleration" keeps gravity');
  assert.match(text(pg, 'valList'), /Recording paused 1 time/);
  pg.d.getElementById('passToggle').click();
  assert.match(text(pg, 'valList'), /phyphox export read.*Google Pixel 9a/);
  assert.match(text(pg, 'valList'), /Units: m\/s².*Includes gravity/);

  await upload(pg, path.join(FIX, 'bad_phyphox_excel.zip'));
  assert.match(text(pg, 'valTitle'), /can’t be analysed/);
  assert.match(text(pg, 'valList'), /Excel export.*Export data → CSV/);
});

test('shows a fix for an unreadable file', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'bad_v73.mat'));
  assert.match(text(pg, 'valTitle'), /can’t be analysed/);
  assert.equal(pg.d.getElementById('valList').hidden, false, 'errors are always shown');
  assert.equal(pg.d.getElementById('analysis').hidden, true);
  assert.match(text(pg, 'valList'), /save\('myfile\.mat','-v7'\)/);
});

test('reads a Physics Toolbox CSV', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'ptb_multi_record.csv'));
  assert.match(text(pg, 'valTitle'), /^Valid/);
  const opts = [...pg.d.getElementById('chanSel').options].map(o => o.textContent);
  assert.ok(opts.includes('x (gFx)') && opts.includes('wx (gyroscope)'));
});

test('steps about a second apart: strides, or a slow walk', async () => {
  const pg = makePage();
  pg.d.getElementById('demoBtn').click(); await sleep(40); // its peaks are about 1.1 s apart
  assert.match(text(pg, 'valList'), /Steps may be strides, or the walk was slow ?Coza’s steps are 1\.\d\d s apart.*Either the walk was slow \(a careful walk can take a second per step\), or each peak is a stride, a left plus a right step\. Only for strides, set Phone position to "One leg"/);
  pg.d.getElementById('posSel').value = 'leg'; pg.d.getElementById('posSel').dispatchEvent(new pg.w.Event('change')); await sleep(60);
  assert.doesNotMatch(text(pg, 'valList'), /Steps may be strides/, 'not once they count as strides');
});

test('a phone export opens on its total; a MAT file on column 2; the synthetic walk on x', async () => {
  const pg = makePage();
  const opened = () => pg.d.getElementById('chanSel').selectedOptions[0].textContent;
  const seen = {};
  for (const f of ['ptb_gforce.csv', 'ptb_linacc_semicolon.csv', 'recorder.csv', 'phyphox.zip', 'walk.mat', 'plain_noheader.csv']) { await upload(pg, path.join(FIX, f)); seen[f] = opened(); }
  pg.d.getElementById('demoBtn').click(); await sleep(40); seen.synthetic = opened();
  assert.deepEqual(seen, { 'ptb_gforce.csv': 'magnitude (TgF)', 'ptb_linacc_semicolon.csv': 'magnitude (aT)', 'recorder.csv': 'magnitude (TgF)',
    'phyphox.zip': 'magnitude (Absolute acceleration)', 'walk.mat': 'x (column 2)', 'plain_noheader.csv': seen['plain_noheader.csv'], synthetic: 'x' });
  assert.doesNotMatch(seen['plain_noheader.csv'], /magnitude/, 'no sensor named: the first signal, as before');
});

/* ------------------------------------------------- browser recorder (#51) */
// devicemotion events: ~60 Hz with uneven timing, gravity on y, a 0.9 Hz walk
function motionSamples(seconds) {
  const out = []; let ts = 5000.25, k = 0;
  while ((ts - 5000.25) / 1000 < seconds) {
    const t = (ts - 5000.25) / 1000, walk = t > 2 && t < seconds - 2 ? 1 : 0;
    const a = [walk * 3 * Math.sin(2 * Math.PI * 0.9 * t), walk * 9 * Math.max(0, Math.sin(2 * Math.PI * 0.9 * t)) ** 3, walk * Math.cos(2 * Math.PI * 1.8 * t)];
    out.push({ ts, g: [a[0], a[1] + 9.81, a[2]], a, r: [10, 20, 30] });
    ts += 1000 / 60 * (1 + 0.3 * Math.sin(k++ * 1.7));
  }
  return out;
}
function sendMotion(pg, samples) {
  for (const s of samples) {
    const e = new pg.w.Event('devicemotion');
    Object.defineProperty(e, 'timeStamp', { value: s.ts });
    e.accelerationIncludingGravity = { x: s.g[0], y: s.g[1], z: s.g[2] };
    e.acceleration = { x: s.a[0], y: s.a[1], z: s.a[2] };
    e.rotationRate = { alpha: s.r[0], beta: s.r[1], gamma: s.r[2] };
    pg.w.dispatchEvent(e);
  }
}
async function startRecording(pg) {
  pg.d.getElementById('recBtn').click(); await sleep(20);
  assert.equal(pg.d.getElementById('recOverlay').dataset.phase, 'countdown');
  pg.d.getElementById('recBox').click(); await sleep(20); // tap to start now
  assert.equal(pg.d.getElementById('recOverlay').dataset.phase, 'recording');
}
const submitRecording = async pg => { pg.d.getElementById('recForm').dispatchEvent(new pg.w.Event('submit', { cancelable: true })); await sleep(80); };

test('records a walk from motion events, loads it like a file, and downloads what was captured', async () => {
  const pg = makePage({ coarse: true, motion: true });
  const $ = id => pg.d.getElementById(id);
  assert.equal($('recBtn').hidden, false); assert.equal($('emptyRec').hidden, false); assert.equal($('recHint').hidden, true);
  await startRecording(pg);
  assert.equal($('recStop').hidden, false);
  const samples = motionSamples(20);
  sendMotion(pg, samples);
  await sleep(300);
  assert.match(text(pg, 'recInfo'), new RegExp('^' + samples.length + ' samples, about 6\\d Hz\\. This browser can’t keep the screen on'));
  $('recStop').dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal($('recOverlay').dataset.phase, 'done');
  assert.equal($('recForm').hidden, false); assert.equal(text(pg, 'recBig'), '0:19');
  $('recSteps').value = '14'; $('recPos').value = 'front pocket';
  await submitRecording(pg);

  assert.equal($('recOverlay').hidden, true);
  assert.match($('fileChip').textContent, /^recording_\d{8}-\d{6}\.csv/);
  assert.match(text(pg, 'valTitle'), /^Valid/);
  assert.match(text(pg, 'valList'), /Recorded in the browser.*about 6\d\.\d Hz, every sample at its own time.*Recorded with: 14 steps counted by hand, phone in the front trouser pocket\./);
  assert.match(text(pg, 'valList'), /Coza assumes 100 Hz/, 'the recording is not resampled');
  assert.equal($('posSel').value, 'leg', 'front pocket: each peak is a stride');
  const opts = [...$('chanSel').options].map(o => o.textContent);
  assert.ok(['x (gFx)', 'y (gFy)', 'z (gFz)', 'magnitude (TgF)', 'ax (linear accelerometer)', 'wx (gyroscope)', 'vertical (along gravity, computed)'].every(o => opts.includes(o)), opts.join(' | '));
  $('chanSel').value = '2'; $('chanSel').dispatchEvent(new pg.w.Event('change')); await sleep(40); // gFy carries gravity
  assert.ok(markers(pg, 'Coza (modified)').x.length >= 6, 'the walk is found');
  const peaks = markers(pg, 'Coza (modified)').x.length, cozaPeaks = markers(pg, 'Coza').x.length;
  assert.match(text(pg, 'valList'), new RegExp('You counted 14 steps ?Coza finds ' + 2 * cozaPeaks + ' \\([-+]\\d+%\\); Coza \\(modified\\) finds ' + 2 * peaks + '.*Each peak counts as 2 steps \\(Phone position: one leg\\)\\.'));

  assert.equal($('saveRec').hidden, false);
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  $('saveRec').click();
  const csv = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  $('expMetrics').click();
  const metrics = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  assert.match(metrics, /\nsteps_counted_by_hand,14\n/);
  $('saveRec').click();
  const csv2 = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  assert.equal(csv2, csv, 'the same recording each time');
  const p = Core.parseCsv(csv);
  assert.equal(p.meta.steps_counted, '14'); assert.equal(p.meta.phone_position, 'front pocket'); assert.equal(p.meta.stopped, 'user');
  assert.equal(p.meta.samples, String(samples.length));
  samples.forEach((s, i) => { assert.equal(p.cols[0][i], (s.ts - samples[0].ts) / 1000); assert.equal(p.cols[2][i], s.g[1] / Core.STANDARD_GRAVITY); });

  await upload(pg, path.join(FIX, 'walk.mat'));
  assert.equal($('saveRec').hidden, true, 'only for a recording');
  assert.doesNotMatch(text(pg, 'valList'), /You counted/);
  assert.doesNotMatch(text(pg, 'valList'), /iPhone/);
  const iphone = fs.readFileSync(path.join(FIX, 'recorder.csv'), 'utf8').replace(/# device: .*/, '# device: Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari/604.1');
  const tmp = path.join(require('os').tmpdir(), 'gaitscope_iphone_recording.csv');
  fs.writeFileSync(tmp, iphone);
  await upload(pg, tmp); fs.unlinkSync(tmp);
  assert.match(text(pg, 'valList'), /iPhone axis signs not yet checked.*don’t depend on the sign/);
  await upload(pg, path.join(FIX, 'recorder.csv')); // a saved recording, uploaded again
  assert.match(text(pg, 'valList'), /Recorded in the browser.*Recorded with: 12 steps counted by hand, phone in the hand\..*You counted 12 steps ?Coza finds \d+.*; Coza \(modified\) finds \d+/);
});

test('recorder: hold to stop, too short, page hidden mid-recording', async () => {
  const pg = makePage({ coarse: true, motion: true });
  const $ = id => pg.d.getElementById(id);
  await startRecording(pg);
  sendMotion(pg, motionSamples(1));
  $('recStop').dispatchEvent(new pg.w.Event('pointerdown')); await sleep(300); $('recStop').dispatchEvent(new pg.w.Event('pointerup'));
  await sleep(900);
  assert.equal($('recOverlay').dataset.phase, 'recording', 'a short touch does not stop it');
  $('recStop').dispatchEvent(new pg.w.Event('pointerdown')); await sleep(1100);
  assert.equal($('recOverlay').dataset.phase, 'error');
  assert.match(text(pg, 'recErrText'), /^Only \d+ samples over [01]\.\d s were captured\.$/);
  assert.match(text(pg, 'recErrFix'), /at least 10 s/);
  $('recClose').click();
  assert.equal($('recOverlay').hidden, true);

  await startRecording(pg);
  sendMotion(pg, motionSamples(8));
  Object.defineProperty(pg.d, 'hidden', { value: true, configurable: true });
  pg.d.dispatchEvent(new pg.w.Event('visibilitychange'));
  assert.equal($('recOverlay').dataset.phase, 'done');
  assert.match(text(pg, 'recInfo'), /stopped early because the screen locked/);
  await submitRecording(pg);
  assert.match(text(pg, 'valList'), /Recording stopped early.*after [78]\.\d s/);
});

test('recorder: a hold that stops cuts the touch out; a touch let go early cuts nothing', async () => {
  const pg = makePage({ coarse: true, motion: true });
  const $ = id => pg.d.getElementById(id);
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  const saved = async () => { $('saveRec').click(); return Core.parseCsv(await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); })); };
  await startRecording(pg);
  const all = motionSamples(14), at = s => (s.ts - all[0].ts) / 1000;
  const part = (a, b) => all.filter(s => at(s) >= a && at(s) < b);
  sendMotion(pg, part(0, 10));
  $('recStop').dispatchEvent(new pg.w.Event('pointerdown'));
  sendMotion(pg, part(10, 10.5)); // brushing the button: let go before the hold completes
  await sleep(200); $('recStop').dispatchEvent(new pg.w.Event('pointerup'));
  await sleep(900);
  assert.equal($('recOverlay').dataset.phase, 'recording');
  sendMotion(pg, part(10.5, 12));
  $('recStop').dispatchEvent(new pg.w.Event('pointerdown'));
  sendMotion(pg, part(12, 14)); // during the hold
  await sleep(1100);
  assert.equal($('recOverlay').dataset.phase, 'done');
  // kept: everything up to 0.3 s before the finger came down, the brushed part included
  const kept = all.filter(s => at(s) < 12 && s.ts <= part(10.5, 12).at(-1).ts - 300);
  const cut = (all.at(-1).ts - kept.at(-1).ts) / 1000;
  assert.ok(at(kept.at(-1)) > 11.6 && at(kept.at(-1)) < 11.75 && cut > 2.2 && cut < 2.45, at(kept.at(-1)) + ' ' + cut);
  assert.match(text(pg, 'recInfo'), new RegExp('^' + kept.length + ' samples at about 6\\d Hz\\. The last ' + cut.toFixed(1).replace('.', '\\.') + ' s, from just before you touched Stop, was left out\\.$'));
  $('recSteps').value = '10';
  await submitRecording(pg);
  assert.match(text(pg, 'valList'), new RegExp('Recorded with: 10 steps counted by hand\\. The last ' + cut.toFixed(1).replace('.', '\\.') + ' s, from just before Stop was touched, was left out\\.'));
  let p = await saved();
  assert.equal(p.meta.samples, String(kept.length)); assert.equal(p.meta.trimmed_end_s, cut.toFixed(2)); assert.equal(p.meta.stopped, 'user');
  assert.deepEqual([...p.cols[0]], kept.map(s => (s.ts - kept[0].ts) / 1000));

  // Enter stops at once and cuts nothing: no finger on the phone
  await startRecording(pg);
  const five = motionSamples(5);
  sendMotion(pg, five);
  $('recStop').dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.doesNotMatch(text(pg, 'recInfo'), /left out/);
  await submitRecording(pg);
  assert.doesNotMatch(text(pg, 'valList'), /left out/);
  p = await saved();
  assert.equal(p.meta.samples, String(five.length)); assert.equal(p.meta.trimmed_end_s, undefined);
});

test('recorder: iPhone permission refused, and a computer without a sensor', async () => {
  const pg = makePage({ coarse: true, motion: true, permission: 'denied' });
  const $ = id => pg.d.getElementById(id);
  $('recBtn').click(); await sleep(20);
  assert.equal($('recOverlay').dataset.phase, 'error');
  assert.match(text(pg, 'recErrText'), /Motion access was not allowed/);
  assert.match(text(pg, 'recErrFix'), /close this tab, open the page again and tap Allow/);

  const desk = makePage({ motion: true });
  assert.equal(desk.d.getElementById('recBtn').hidden, true, 'no touch screen: no button');
  assert.equal(desk.d.getElementById('recHint').hidden, false);
  const quiet = makePage({ coarse: true, motion: true });
  quiet.d.getElementById('recBtn').click(); await sleep(2600);
  assert.equal(quiet.d.getElementById('recOverlay').dataset.phase, 'error');
  assert.match(text(quiet, 'recErrText'), /No motion sensor is sending data/);
});

test('recorder on an http page: says why and links to the same page over https', async () => {
  const pg = makePage({ coarse: true, motion: true, insecure: true, url: 'http://example.org/gaitscope/?x=1' });
  pg.d.getElementById('recBtn').click(); await sleep(20);
  assert.equal(pg.d.getElementById('recOverlay').dataset.phase, 'error');
  assert.match(text(pg, 'recErrText'), /need a secure \(https:\/\/\) page, and this one was opened over http/);
  const a = pg.d.getElementById('recErrLink');
  assert.equal(a.hidden, false); assert.equal(a.href, 'https://example.org/gaitscope/?x=1');
});

/* ---------------------------------------------------------------- export (#53) */
const blobBytes = (pg, b) => new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.readAsArrayBuffer(b); });
async function uploadText(pg, name, text) {
  const f = new pg.w.File([text], name), buf = Buffer.from(text);
  if (!f.arrayBuffer) f.arrayBuffer = async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const input = pg.d.getElementById('fileIn');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new pg.w.Event('change'));
  await sleep(80);
}

test('Export… writes zip, MATLAB, NumPy and JSON; a JSON export reopens to the same steps and metrics', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  const change = async (id, v) => { if ($(id).type === 'checkbox') $(id).checked = v; else $(id).value = v; $(id).dispatchEvent(new pg.w.Event('change')); await sleep(40); };
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  // a non-default analysis: filter, Coza window, phone on one leg, an envelope, a note
  await change('filterSel', 'butter');
  await act(pg, 'Coza (modified)', 'open'); await setParam(pg, 'Coza (modified)', 'cozaWindow', 0.4);
  await setSource(pg, 'Coza', 'recorded');
  await addInd(pg, 'detector', 'threshold'); await act(pg, 'Threshold peaks', 'eye'); // hidden: not exported
  await change('posSel', 'leg'); await addInd(pg, 'envelope', 'sliding');
  $('noteMode').checked = true; $('noteMode').dispatchEvent(new pg.w.Event('change'));
  pg.d.getElementById('plot')._click({ points: [{ x: 4.5 }] }); await sleep(20);
  $('noteText').value = 'turned ✓'; $('noteForm').dispatchEvent(new pg.w.Event('submit', { cancelable: true })); await sleep(60);
  const snap = p => ({ coza: samples(p, 'Coza'), mod: samples(p, 'Coza (modified)'), metrics: p.d.getElementById('metricsTable').innerHTML,
    stepsTable: p.d.getElementById('stepsTable').innerHTML, notes: p.d.getElementById('noteList').textContent, env: trace(p, 'envUpper').y.join() });
  const before = snap(pg);
  assert.match(before.notes, /turned ✓/);

  assert.equal($('expFmt').value, 'csv'); assert.equal($('expCsv').hidden, false); assert.equal($('expParts').hidden, true);
  const files = {};
  for (const fmt of ['zip', 'mat', 'npz', 'json']) {
    await change('expFmt', fmt);
    assert.equal($('expParts').hidden, false); assert.equal($('expCsv').hidden, true);
    if (fmt === 'mat') { $('expEnvelope').checked = true; }
    $('expGo').click(); await sleep(20);
    const b = pg.blobs.at(-1);
    files[fmt] = await blobBytes(pg, b);
    assert.ok(files[fmt].length > 1000, fmt);
  }
  assert.match($('expSignalsInfo').textContent, /^\d[\d,]* rows: time, the signal, the filtered signal\. Always in JSON/);
  assert.equal($('expSignals').disabled, true, 'JSON always has the signal');
  const g = Core.parseMat(files.mat).variables[0].fields;
  assert.deepEqual(Object.keys(g.signals.fields), ['time_s', 'signal', 'filtered', 'sliding_lower', 'sliding_upper']);
  assert.equal(Core.parseZip(files.npz).some(e => e.name === 'steps/coza_modified.npy'), true);
  assert.deepEqual(Core.parseZip(files.zip).map(e => e.name), ['about.csv', 'settings.csv', 'params.csv', 'spectrum.csv', 'indicators.csv', 'signals.csv', 'steps.csv', 'metrics.csv', 'notes.csv']);
  const json = new TextDecoder().decode(files.json), model = Core.parseExportJson(json);
  assert.equal(model.about.file, 'walk.mat'); assert.equal(model.about.variable, 'Walking'); assert.equal(model.about.signal_name, 'Column 2');
  assert.equal(model.settings.filter.startsWith('Butterworth'), true);
  assert.equal(model.params.phone_position, 'leg'); assert.equal(model.params.filter, 'butter');
  assert.deepEqual(Array.from(model.indicators.type), ['coza_original', 'coza', 'sliding'], 'what is shown is exported');
  assert.deepEqual(Array.from(model.indicators.source), ['recorded', 'filtered', 'filtered']);
  assert.equal(JSON.parse(model.indicators.params[1]).cozaWindow, 0.4);
  assert.equal(JSON.parse(model.indicators.settings[1]).coza_window_samples, 40);
  assert.deepEqual(Array.from(model.notes.text), ['turned ✓']);
  assert.equal(model.metrics.metric[4], 'stride_time_variability');

  // reopen in a fresh page
  const pg2 = makePage();
  await uploadText(pg2, 'walk_gaitscope.json', json);
  const $2 = id => pg2.d.getElementById(id);
  assert.match(text(pg2, 'valList'), /GaitScope export reopened.*by the dashboard \(version 0\.1\.0\) from "walk\.mat", variable Walking, signal x \(column 2\)/);
  assert.equal($2('filterSel').value, 'butter'); assert.equal($2('posSel').value, 'leg');
  assert.deepEqual(indNames(pg2, 'detList'), ['Coza', 'Coza (modified)']); assert.deepEqual(indNames(pg2, 'envList'), ['Sliding window']);
  assert.equal(indRow(pg2, 'Coza').querySelector('[data-act=source]').value, 'recorded');
  assert.equal(indRow(pg2, 'Coza (modified)').querySelector('.ind-sum').textContent, 'h 1 · window 0.40 s · weak peaks dropped');
  assert.deepEqual(snap(pg2), before, 'same steps, metrics, step table, notes and envelope');

  await uploadText(pg2, 'other.json', '{"name": "not ours"}');
  assert.match(text(pg2, 'valList'), /not a GaitScope export.*Export… → JSON/);
});

test('credits show under each indicator\'s settings and under the filter, with no emails (#63)', async () => {
  const pg = makePage(), $ = id => pg.d.getElementById(id), C = pg.w.StepCore;
  $('demoBtn').click(); await sleep(40);
  for (const a of C.ALGORITHMS.slice(2)) await addInd(pg, 'detector', a.id);
  for (const e of C.ENVELOPES) await addInd(pg, 'envelope', e.id);
  const credit = name => indRow(pg, name).querySelector('.credit');
  assert.equal(credit('Coza').textContent, 'Credit: Dr. Aurel Coza (BME 598/494; LabStepDet_2025.m)');
  assert.match(credit('Coza (modified)').textContent, /modified by Dr\. Soroush Dianaty \(tied peaks counted once/);
  const link = credit('Threshold peaks').querySelector('a');
  assert.equal(link.textContent, 'Brajdic & Harle, 2013'); assert.equal(link.href, 'https://doi.org/10.1145/2493432.2493449');
  assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener');
  assert.deepEqual([...credit('Hilbert envelope').querySelectorAll('a')].map(a => a.textContent), ['Gabor, 1946', 'Marple, 1999']);
  assert.equal(credit('Sliding window'), null, 'nothing shown when none is needed');
  // the filter's credit, under its description
  assert.equal($('filterCredit').hidden, true, 'no filter, no credit');
  $('filterSel').value = 'savgol'; $('filterSel').dispatchEvent(new pg.w.Event('change')); await sleep(40);
  assert.equal($('filterCredit').hidden, false);
  assert.equal($('filterCredit').querySelector('a').href, 'https://doi.org/10.1021/ac60214a047');
  $('filterSel').value = 'movavg'; $('filterSel').dispatchEvent(new pg.w.Event('change')); await sleep(40);
  assert.equal($('filterCredit').hidden, true);
  // names only: no email address anywhere in the page, hidden panels included. The domain
  // must start with a letter, so pinned scripts (pako@2.1.0) don't count.
  const EMAIL = /[\w.+-]+@[a-z][\w-]*(\.[a-z][\w-]*)*\.[a-z]{2,}\b/i;
  assert.ok(EMAIL.test('Neil Zhao [neil.zhao@analog.com]') && !EMAIL.test('npm/pako@2.1.0/dist'), 'the pattern itself');
  for (const f of C.FILTERS) {
    $('filterSel').value = f.id; $('filterSel').dispatchEvent(new pg.w.Event('change')); await sleep(20);
    assert.ok(!EMAIL.test(pg.d.documentElement.outerHTML), 'no email address with the ' + f.id + ' filter');
  }
});

// #79: the theme button cycles System, Light, Dark and remembers the choice for this viewer
const memoryStorage = (init = {}) => { const m = Object.assign({}, init); return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, m }; };
test('the theme button cycles System, Light and Dark, redraws the plots and remembers the choice (#79)', async () => {
  const storage = memoryStorage(), pg = makePage({ storage }), $ = id => pg.d.getElementById(id), root = pg.d.documentElement;
  assert.equal($('themeBtn').textContent, 'System'); assert.ok($('themeBtn').querySelector('svg'), 'a drawn icon'); assert.equal(root.getAttribute('data-theme'), null, 'follows the system at first');
  $('demoBtn').click(); await sleep(40);
  const drawn = pg.plots.length;
  $('themeBtn').click(); await sleep(20);
  assert.equal(root.getAttribute('data-theme'), 'light'); assert.equal(storage.m['gaitscope-theme'], 'light');
  assert.ok(pg.plots.length > drawn, 'the plots redraw in the new colours');
  assert.match($('themeBtn').title, /Theme: Light\. Click for Dark\./);
  $('themeBtn').click(); assert.equal(root.getAttribute('data-theme'), 'dark'); assert.equal($('themeBtn').textContent, 'Dark');
  $('themeBtn').click(); assert.equal(root.getAttribute('data-theme'), null); assert.equal(storage.m['gaitscope-theme'], 'system');
  // a later visit starts with the remembered choice
  const pg2 = makePage({ storage: memoryStorage({ 'gaitscope-theme': 'dark' }) });
  assert.equal(pg2.d.documentElement.getAttribute('data-theme'), 'dark'); assert.equal(pg2.d.getElementById('themeBtn').dataset.theme, 'dark');
  // blocked storage (a private window): it still switches, it just isn't remembered
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const pg3 = makePage({ storage: blocked });
  pg3.d.getElementById('themeBtn').click();
  assert.equal(pg3.d.documentElement.getAttribute('data-theme'), 'light');
});

test('recorder: the countdown is a setting, remembered in the browser', async () => {
  const storage = memoryStorage(), pg = makePage({ coarse: true, motion: true, storage }), $ = id => pg.d.getElementById(id);
  assert.equal($('recCountRow').hidden, false); assert.equal($('recCount').value, '5');
  $('recCount').value = '3'; $('recCount').dispatchEvent(new pg.w.Event('change'));
  assert.equal(storage.m['gaitscope-countdown'], '3');
  $('recBtn').click(); await sleep(20);
  assert.equal(text(pg, 'recBig'), '3');
  assert.match(text(pg, 'recInfo'), /Don’t lock the screen: the recording stops when it locks\./);
  sendMotion(pg, motionSamples(0.1)); // the sensor answers during the countdown
  await sleep(3100);
  assert.equal($('recOverlay').dataset.phase, 'recording', 'starts when the countdown runs out');
  $('recStop').dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); // no timers left running
  const esc = p => p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape' }));
  const pg2 = makePage({ coarse: true, motion: true, storage: memoryStorage({ 'gaitscope-countdown': '15' }) });
  assert.equal(pg2.d.getElementById('recCount').value, '15');
  pg2.d.getElementById('recBtn').click(); await sleep(20);
  assert.equal(text(pg2, 'recBig'), '15');
  esc(pg2);
  assert.equal(makePage({ coarse: true, motion: true, storage: memoryStorage({ 'gaitscope-countdown': '7' }) }).d.getElementById('recCount').value, '5', 'not one of the choices');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const pg3 = makePage({ coarse: true, motion: true, storage: blocked });
  pg3.d.getElementById('recCount').value = '10'; pg3.d.getElementById('recCount').dispatchEvent(new pg3.w.Event('change'));
  pg3.d.getElementById('recBtn').click(); await sleep(20);
  assert.equal(text(pg3, 'recBig'), '10', 'used even when it cannot be remembered');
  esc(pg3);
  assert.equal(makePage().d.getElementById('recCountRow').hidden, true, 'not on a computer');
});

test('recorder: says not to lock the screen, and asks again when the browser drops the screen-on lock (#86)', async () => {
  const wl = {}, pg = makePage({ coarse: true, motion: true, wakeLock: wl }), $ = id => pg.d.getElementById(id);
  await startRecording(pg);
  sendMotion(pg, motionSamples(4));
  await sleep(300);
  assert.equal(wl.requests, 1);
  assert.match(text(pg, 'recInfo'), /about 6\d Hz\. The screen stays on by itself; don’t lock it, or the recording stops\.$/);
  for (let k = 0; k < 3; k++) { wl.sentinel.dispatchEvent(new pg.w.Event('release')); await sleep(30); } // e.g. battery saver
  assert.equal(wl.requests, 4);
  await sleep(300);
  assert.match(text(pg, 'recInfo'), /The screen stays on by itself/);
  wl.sentinel.dispatchEvent(new pg.w.Event('release')); await sleep(300);
  assert.equal(wl.requests, 4, 'three times at most');
  assert.match(text(pg, 'recInfo'), /The browser stopped keeping the screen on \(battery saver\?\): make the screen timeout longer, and don’t lock it, or the recording stops\.$/);
  $('recStop').dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal($('recOverlay').dataset.phase, 'done');

  // our own release when the recording ends doesn't ask again
  const wl2 = {}, pg2 = makePage({ coarse: true, motion: true, wakeLock: wl2 });
  await startRecording(pg2);
  sendMotion(pg2, motionSamples(4)); await sleep(30);
  pg2.d.getElementById('recStop').dispatchEvent(new pg2.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(50);
  assert.equal(wl2.requests, 1);

  const wl3 = { grant: false }, pg3 = makePage({ coarse: true, motion: true, wakeLock: wl3 });
  await startRecording(pg3);
  sendMotion(pg3, motionSamples(4)); await sleep(300);
  assert.match(text(pg3, 'recInfo'), /This browser can’t keep the screen on: make the screen timeout longer, and don’t lock it, or the recording stops\.$/);
  pg3.d.getElementById('recStop').dispatchEvent(new pg3.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});

test('Signal only takes away the extras and keeps the notes; Undo puts them back (#79)', async () => {
  const pg = makePage(), $ = id => pg.d.getElementById(id);
  $('demoBtn').click(); await sleep(40);
  await addInd(pg, 'envelope', 'peaktrough');
  $('filterSel').value = 'butter'; $('filterSel').dispatchEvent(new pg.w.Event('change', { bubbles: true })); await sleep(40);
  $('rsSel').value = 'even'; $('rsSel').dispatchEvent(new pg.w.Event('change', { bubbles: true })); await sleep(40);
  $('showIntervals').checked = true; $('showIntervals').dispatchEvent(new pg.w.Event('change', { bubbles: true })); await sleep(20);
  $('noteMode').checked = true; $('noteMode').dispatchEvent(new pg.w.Event('change'));
  $('plot')._click({ points: [{ x: 5, curveNumber: 0 }] });
  $('noteText').value = 'stairs'; $('noteForm').dispatchEvent(new pg.w.Event('submit', { cancelable: true })); await sleep(20);
  const before = { det: indNames(pg, 'detList'), env: indNames(pg, 'envList'), steps: samples(pg, 'Coza (modified)') };

  $('plainBtn').click(); await sleep(40);
  assert.deepEqual(indNames(pg, 'detList'), []); assert.equal($('envList').hidden, true);
  assert.equal($('filterSel').value, 'none'); assert.equal($('rsSel').value, 'off'); assert.equal($('showIntervals').checked, false);
  const roles = new Set([...pg.plots.at(-1).traces].map(t => t.meta && t.meta.role));
  assert.deepEqual([...roles].filter(r => r !== 'signal'), [], 'only the signal is drawn');
  assert.match(text(pg, 'noteList'), /stairs/, 'notes stay');
  assert.equal($('plainUndo').hidden, false);

  $('plainUndo').click(); await sleep(40);
  assert.deepEqual(indNames(pg, 'detList'), before.det); assert.deepEqual(indNames(pg, 'envList'), before.env);
  assert.equal($('filterSel').value, 'butter'); assert.equal($('rsSel').value, 'even'); assert.equal($('showIntervals').checked, true);
  assert.equal(samples(pg, 'Coza (modified)'), before.steps, 'the same steps as before');
  assert.equal($('plainUndo').hidden, true);

  // any other change ends the chance to undo
  $('plainBtn').click(); await sleep(40);
  $('posSel').value = 'leg'; $('posSel').dispatchEvent(new pg.w.Event('change', { bubbles: true })); await sleep(20);
  assert.equal($('plainUndo').hidden, true);
});

// #79: Home goes back to the start screen; it asks first only when something would be lost
const addNoteAt = async (pg, x, words) => {
  const $ = id => pg.d.getElementById(id);
  $('noteMode').checked = true; $('noteMode').dispatchEvent(new pg.w.Event('change'));
  $('plot')._click({ points: [{ x, curveNumber: 0 }] });
  $('noteText').value = words; $('noteForm').dispatchEvent(new pg.w.Event('submit', { cancelable: true })); await sleep(20);
};
test('Home with nothing to lose goes straight to the start screen, as the page opens (#79)', async () => {
  const pg = makePage(), $ = id => pg.d.getElementById(id);
  assert.equal($('homeBtn').hidden, true, 'nothing to leave yet');
  $('demoBtn').click(); await sleep(40);
  assert.equal($('homeBtn').hidden, false);
  $('chanSel').value = '2'; $('chanSel').dispatchEvent(new pg.w.Event('change')); await sleep(40); // a channel choice doesn't count
  $('homeBtn').click(); await sleep(20);
  assert.equal($('homeDialog').hidden, true, 'no question');
  assert.equal($('empty').hidden, false); assert.equal($('work').hidden, true);
  assert.equal($('fileChip').hidden, true); assert.equal($('subtitle').hidden, false); assert.equal($('homeBtn').hidden, true);
  assert.deepEqual(indNames(pg, 'detList'), ['Coza', 'Coza (modified)']);
  // the next file gives what a fresh page gives
  await upload(pg, path.join(FIX, 'walk.mat'));
  const fresh = makePage(); await upload(fresh, path.join(FIX, 'walk.mat'));
  assert.equal(samples(pg, 'Coza (modified)'), samples(fresh, 'Coza (modified)'));
  assert.equal(text(pg, 'valList'), text(fresh, 'valList'));
});
test('Home asks Export, Discard or Cancel when notes or changed settings would be lost (#79)', async () => {
  const pg = makePage(), $ = id => pg.d.getElementById(id);
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  $('demoBtn').click(); await sleep(40);
  await addNoteAt(pg, 5, 'stairs');
  $('homeBtn').click();
  assert.equal($('homeDialog').hidden, false);
  assert.match(text(pg, 'homeText'), /^You have a note\. Nothing is kept in the browser, so going home loses it\. Export saves everything as one JSON file/);
  $('homeCancel').click();
  assert.equal($('homeDialog').hidden, true); assert.equal($('work').hidden, false, 'Cancel stays'); assert.match(text(pg, 'noteList'), /stairs/);

  await addInd(pg, 'envelope', 'hilbert');
  $('homeBtn').click();
  assert.match(text(pg, 'homeText'), /^You have a note and changed detectors or settings\. .*loses them/);
  const n = pg.blobs.length;
  $('homeExport').click(); await sleep(20);
  assert.equal(pg.blobs.length, n + 1, 'one file');
  const json = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  const m = Core.parseExportJson(json);
  assert.deepEqual(m.notes.text, ['stairs']); assert.ok(m.indicators.type.includes('hilbert')); assert.ok(m.signals.signal.length > 1000, 'with the signal, so it reopens');
  assert.equal($('empty').hidden, false, 'and home');

  // Discard goes home without a file
  $('demoBtn').click(); await sleep(40);
  await addNoteAt(pg, 3, 'turned');
  $('homeBtn').click(); const m2 = pg.blobs.length;
  $('homeDiscard').click(); await sleep(20);
  assert.equal(pg.blobs.length, m2); assert.equal($('empty').hidden, false);

  // after a JSON export from Export…, nothing is lost, so no question
  $('demoBtn').click(); await sleep(40);
  await addNoteAt(pg, 4, 'kept');
  $('expFmt').value = 'json'; $('expFmt').dispatchEvent(new pg.w.Event('change')); $('expGo').click(); await sleep(20);
  $('homeBtn').click();
  assert.equal($('homeDialog').hidden, true); assert.equal($('empty').hidden, false);
});
test('Home asks about a phone recording until it is downloaded (#79)', async () => {
  const pg = makePage({ coarse: true, motion: true }), $ = id => pg.d.getElementById(id);
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  await startRecording(pg);
  sendMotion(pg, motionSamples(12)); await sleep(200);
  $('recStop').dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await submitRecording(pg);
  $('homeBtn').click();
  assert.match(text(pg, 'homeText'), /^You have a phone recording that hasn’t been downloaded\./);
  $('homeDialog').dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('homeDialog').hidden, true, 'Escape cancels');
  $('saveRec').click();
  $('homeBtn').click();
  assert.equal($('homeDialog').hidden, true, 'downloaded: nothing to lose'); assert.equal($('empty').hidden, false);
});

// #80: notes at a time, a level or a point, on the signal and on the spectrum
const submitNote = async (pg, form, input, words) => { pg.d.getElementById(input).value = words; pg.d.getElementById(form).dispatchEvent(new pg.w.Event('submit', { cancelable: true })); await sleep(20); };
const setVal = (pg, id, v) => { const el = pg.d.getElementById(id); if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new pg.w.Event('change', { bubbles: true })); };
test('signal notes at a level or a point, snapped to the curve or exactly where clicked; steps never change (#80)', async () => {
  const pg = makePage(), $ = id => pg.d.getElementById(id);
  $('demoBtn').click(); await sleep(40);
  const steps = samples(pg, 'Coza (modified)');
  setVal(pg, 'noteMode', true);
  assert.equal($('noteOpts').hidden, false, 'the kind and Snap show in note mode');
  // a level, snapped: the value of the clicked point of the curve
  setVal(pg, 'noteKind', 'level');
  assert.match(text(pg, 'noteHint'), /height/);
  $('plot')._click({ points: [{ x: 5, y: 3.3, curveNumber: 0 }] });
  assert.equal(text(pg, 'noteAt'), 'Note at level 3.30');
  await submitNote(pg, 'noteForm', 'noteText', 'resting');
  let L = pg.plots.at(-1).layout;
  assert.ok(L.shapes.some(s => s.xref === 'paper' && s.y0 === 3.3 && s.y1 === 3.3 && s.line.dash === 'dot'), 'a dotted horizontal line');
  assert.ok(L.annotations.some(a => a.text === 'resting' && a.xref === 'paper' && a.y === 3.3));
  // a click on a detector's marker: Snap takes the curve's value at that time
  setVal(pg, 'noteKind', 'point');
  const mk = markers(pg, 'Coza'), i = 3, want = pg.w.StepCore.demoWalk().cols[1][mk.customdata[i][0] - 1];
  $('plot')._click({ points: [{ x: mk.x[i], y: 99, curveNumber: 5, data: { meta: { role: 'markers' } } }] });
  assert.equal(text(pg, 'noteAt'), 'Note at ' + mk.x[i].toFixed(2) + ' s, ' + want.toFixed(2));
  $('noteCancel').click();
  // Snap off: exactly where the pointer was, from the plot's axes
  setVal(pg, 'noteSnap', false);
  const gd = $('plot'), drag = pg.d.createElement('div');
  gd._fullLayout = { xaxis: { type: 'linear', p2l: px => px / 100 }, yaxis: { type: 'linear', p2l: px => 10 - px / 10 } };
  drag.className = 'nsewdrag'; drag.setAttribute('data-subplot', 'xy'); gd.appendChild(drag);
  $('plot')._click({ points: [{ x: 6.3, y: 9.8, curveNumber: 0 }], event: { clientX: 640, clientY: 20 } });
  assert.equal(text(pg, 'noteAt'), 'Note at 6.40 s, 8.00');
  await submitNote(pg, 'noteForm', 'noteText', 'here');
  L = pg.plots.at(-1).layout;
  assert.ok(L.annotations.some(a => a.text === 'here' && a.x === 6.4 && a.y === 8 && a.showarrow), 'a dot with its label');
  // a time note lands at the clicked time (not the nearest point's), rounded to a sample with Snap on
  setVal(pg, 'noteKind', 'time'); setVal(pg, 'noteSnap', true);
  $('plot')._click({ points: [{ x: 9.9, y: 0, curveNumber: 0 }], event: { clientX: 1234, clientY: 300 } });
  const t = Array.from(pg.w.StepCore.demoWalk().cols[0]), near = t.reduce((b, v) => (Math.abs(v - 12.34) < Math.abs(b - 12.34) ? v : b));
  assert.equal(text(pg, 'noteAt'), 'Note at ' + near.toFixed(2) + ' s');
  $('noteCancel').click();
  // and without the pointer's position, the clicked point's time, as before
  delete gd._fullLayout;
  $('plot')._click({ points: [{ x: 12.5, y: 0, curveNumber: 0 }] });
  await submitNote(pg, 'noteForm', 'noteText', 'turned');
  assert.match(text(pg, 'noteList'), /level 3\.30 ?resting.*6\.40 s, 8\.00 ?here.*12\.50 s ?turned/);
  assert.equal(samples(pg, 'Coza (modified)'), steps, 'notes never change the steps');
  // the export has each kind
  const csv = await exportCsv(pg);
  assert.match(csv, /note_plot,note_kind,note_x,note_y,note\nsignal,level,,3\.3,resting\nsignal,point,6\.400,8,here\nsignal,time,12\.500,,turned\n/);
});
test('spectrum notes: their own tools, the rate in everyday units in the walking band, a log axis, and a reopened export (#80)', async () => {
  const pg = makePage(), $ = id => pg.d.getElementById(id);
  pg.w.HTMLAnchorElement.prototype.click = function () {};
  $('demoBtn').click(); await sleep(40);
  assert.equal($('specNoteOpts').hidden, true);
  setVal(pg, 'specNoteMode', true);
  assert.equal($('specNoteOpts').hidden, false); assert.equal($('noteOpts').hidden, true, 'each plot has its own');
  $('specPlot')._click({ points: [{ x: 0.91, y: 150, curveNumber: 1 }] });
  assert.equal(text(pg, 'specNoteAt'), 'Note at 0.91 Hz');
  await submitNote(pg, 'specNoteForm', 'specNoteText', 'walking rhythm');
  assert.match(text(pg, 'specNoteList'), /^0\.91 Hz ?every 1\.10 s, 55 steps\/min ?walking rhythm/);
  assert.ok(pg.spectra.at(-1).layout.shapes.some(s => s.x0 === 0.91 && s.yref === 'paper' && s.line.dash === 'dot'), 'drawn on the spectrum');
  assert.ok(!pg.plots.at(-1).layout.annotations.some(a => a.text === 'walking rhythm'), 'and not on the signal (no mirroring)');
  assert.equal($('noteList').hidden, true);
  // the rate follows Phone position, and only in the walking band
  setVal(pg, 'posSel', 'leg'); await sleep(40);
  assert.match(text(pg, 'specNoteList'), /every 1\.10 s, 109 steps\/min \(one leg: each repeat is a stride\)/);
  setVal(pg, 'posSel', 'hand'); await sleep(40);
  setVal(pg, 'specNoteKind', 'point');
  $('specPlot')._click({ points: [{ x: 5, y: 0.4, curveNumber: 1, data: { meta: { role: 'spectrum' } } }] });
  await submitNote(pg, 'specNoteForm', 'specNoteText', 'noise');
  assert.match(text(pg, 'specNoteList'), /5\.00 Hz, power 0\.4 ?noise/); assert.doesNotMatch(text(pg, 'specNoteList'), /noise.*steps\/min|steps\/min ?noise/);
  // on a log axis, a point's height is in log10 units, as Plotly needs
  setVal(pg, 'specLog', true); await sleep(20);
  assert.ok(pg.spectra.at(-1).layout.annotations.some(a => a.text === 'noise' && Math.abs(a.y - Math.log10(0.4)) < 1e-12));
  // a JSON export reopens both
  $('expFmt').value = 'json'; $('expFmt').dispatchEvent(new pg.w.Event('change')); $('expGo').click(); await sleep(20);
  const json = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  const pg2 = makePage();
  await uploadText(pg2, 'demo_gaitscope.json', json);
  assert.match(text(pg2, 'specNoteList'), /0\.91 Hz.*walking rhythm.*5\.00 Hz, power 0\.4 ?noise/);
});
