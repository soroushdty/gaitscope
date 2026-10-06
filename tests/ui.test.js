// Drives index.html in jsdom with a stubbed Plotly (no real rendering).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const pako = require('pako');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

// Errors thrown inside the page (event handlers, animation frames) fail the test that caused them.
const pageErrors = [];
test.afterEach(() => assert.deepEqual(pageErrors.splice(0), [], 'uncaught error in the page'));

function makePage() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="https:[^>]+><\/script>/g, '')
    .replace(/<link[^>]+>/g, '')
    .replace('<script src="src/core.js"></script>', '<script>' + fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8') + '</script>')
    .replace('<script src="src/app.js"></script>', '<script>' + fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8') + '</script>');
  const plots = [], blobs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push((e.detail && e.detail.stack) || e.message));
  const dom = new JSDOM(html, { virtualConsole: vc, runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.pako = pako; w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.Plotly = { react(el, traces, layout, config) { plots.push({ traces, layout, config }); el.on = (ev, fn) => { el._click = fn; }; } };
    w.URL.createObjectURL = b => { blobs.push(b); return 'blob:x'; }; w.URL.revokeObjectURL = () => {};
  } });
  return { w: dom.window, d: dom.window.document, plots, blobs };
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
// Plot trace order (src/app.js renderPlot): hidden traces stay in place so these never move.
const TR = { signal: 0, guide: 1, guide2: 2, lab: 3, algo: 4, algoIv: 5, labIv: 6 };
const text = (pg, id) => pg.d.getElementById(id).textContent.replace(/\s+/g, ' ').trim();

test('loads a MAT file, compares versions and exports', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  assert.match(text(pg, 'valTitle'), /^Valid/);
  assert.equal(pg.d.getElementById('subtitle').hidden, true, 'subtitle goes once a file is loaded');
  const cfg = pg.plots.at(-1).config;
  assert.equal(cfg.displayModeBar, 'hover');
  assert.ok(['zoomIn2d', 'zoomOut2d'].every(b => cfg.modeBarButtonsToRemove.includes(b)), 'no +/- zoom buttons');
  assert.equal(pg.d.querySelector('#fileChip strong').title, 'walk.mat', 'full name in a tooltip');
  assert.equal(pg.d.getElementById('valList').hidden, true, 'checks start collapsed when the file is valid');
  pg.d.getElementById('valToggle').click();
  assert.equal(pg.d.getElementById('valList').hidden, false, 'and open on click');
  assert.equal(pg.d.getElementById('analysis').hidden, false);
  assert.equal(pg.d.getElementById('advDetails').open, false, 'advanced options start closed');
  assert.equal(pg.d.getElementById('chanSel').value, '1', 'defaults to column 2 like the lab code');
  const last = pg.plots.at(-1);
  const lab = last.traces[TR.lab].x.length, fixed = last.traces[TR.algo].x.length;
  assert.ok(lab > fixed, 'Coza drops the tied duplicate');
  assert.equal(last.traces[TR.guide].visible, false, 'Coza draws no guide lines');
  assert.equal(text(pg, 'legGuides'), '');
  assert.equal(pg.d.getElementById('fxTies'), null, 'tied peaks are always counted once, no option');
  assert.equal(pg.d.getElementById('rIn'), null, 'weak-peak cut-off is fixed at 40%, no slider');
  assert.match(text(pg, 'valList'), /counts? \d+ peaks? twice.*Coza counts each once/);
  assert.equal(pg.d.getElementById('algoSel').value, 'coza');
  assert.deepEqual([...pg.d.getElementById('algoSel').options].map(o => o.textContent), ['Coza', 'Threshold peaks', 'Peak-to-valley']);
  assert.equal(text(pg, 'legAlgo'), 'Coza');
  assert.ok(!/Signal/.test(pg.d.querySelector('.legend').textContent), 'the signal line needs no legend entry');
  assert.equal(text(pg, 'legH'), 'Threshold h = 1');
  assert.equal(text(pg, 'algoDesc'), 'The lab detector with its bugs fixed.', 'one line under the dropdown');
  assert.match(text(pg, 'algoDetail'), /tied peaks are counted once/, 'the full list is under How detection works');
  assert.equal(pg.d.querySelector('#metricsTable th.col-algo').textContent, 'Coza');
  const names = [...pg.d.querySelectorAll('#metricsTable td .tip')];
  assert.equal(names.length, 7);
  assert.ok(names.every(n => n.title.length > 20), 'every metric explains itself in a tooltip');
  assert.equal(pg.d.querySelectorAll('#metricsTable small').length, 0, 'no grey explanations under the values');
  assert.ok([...pg.d.querySelectorAll('#metricsTable td')].filter(td => td.textContent.startsWith('—')).every(td => td.textContent === '—'));
  assert.equal(pg.d.getElementById('stepsDetails').open, false, 'steps table starts collapsed');
  assert.match(text(pg, 'stepsTitle'), new RegExp(fixed + ' Coza, ' + lab + ' lab code'));

  // the lab code's w (samples) no longer moves Coza, which has its own window in seconds
  assert.match(text(pg, 'cwOut'), /^0\.30 s \(30 samples\)$/);
  const wIn = pg.d.getElementById('wIn');
  wIn.value = '150'; wIn.dispatchEvent(new pg.w.Event('input'));
  await sleep(40);
  assert.equal(pg.plots.at(-1).traces[TR.algo].x.length, fixed, 'Coza unchanged by the lab w');
  assert.notEqual(pg.plots.at(-1).traces[TR.lab].x.length, lab, 'the lab code follows w');
  const cw = pg.d.getElementById('cwIn');
  cw.value = '0.6'; cw.dispatchEvent(new pg.w.Event('input'));
  await sleep(40);
  assert.match(text(pg, 'cwOut'), /^0\.60 s \(60 samples\)$/);
  const hNum = pg.d.getElementById('hNum');
  hNum.value = '0.35'; hNum.dispatchEvent(new pg.w.Event('input'));
  await sleep(40);
  assert.equal(text(pg, 'legH'), 'Threshold h = 0.35');
  pg.d.getElementById('resetParams').click();
  assert.equal(wIn.value, '30'); assert.equal(cw.value, '0.3');

  // export uses a download link outside Claude
  let saved = null;
  pg.w.HTMLAnchorElement.prototype.click = function () { saved = this.download; };
  pg.d.getElementById('expSteps').click();
  assert.equal(saved, 'walk_steps.csv');
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

  pg.w.HTMLAnchorElement.prototype.click = function () {};
  $('expMetrics').click();
  const csv = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  assert.match(csv, /note_time_s,note\n3\.250,turned <around>\n/);
  assert.match(csv, /\ncoza_window_s,0\.3\ncoza_window_samples,30\nfix_weak_peaks,"on, 40%"\n/, 'the algorithm lists its own settings');

  $('noteList').querySelector('button').click();
  assert.equal($('noteList').hidden, true);
  assert.equal(pg.plots.at(-1).layout.annotations.length, 0);
});

test('the interval strip is off by default and can be turned on', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  let { traces, layout } = pg.plots.at(-1);
  assert.equal($('showIntervals').checked, false);
  assert.equal(traces[TR.algoIv].visible, false); assert.equal(traces[TR.labIv].visible, false);
  assert.deepEqual([...layout.yaxis.domain], [0, 1], 'the signal takes the full height');
  assert.equal(layout.yaxis2.visible, false); assert.equal(layout.xaxis.anchor, 'y');
  $('showIntervals').checked = true; $('showIntervals').dispatchEvent(new pg.w.Event('change'));
  ({ traces, layout } = pg.plots.at(-1));
  assert.equal(traces[TR.algoIv].visible, true); assert.equal(traces[TR.labIv].visible, true);
  assert.deepEqual([...layout.yaxis.domain], [0.3, 1]);
  assert.equal(layout.yaxis2.visible, true); assert.equal(layout.xaxis.anchor, 'y2');
  assert.match($('plot').getAttribute('aria-label'), /time between steps/);
});

test('the lab code comparison can be hidden', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  const heads = () => [...pg.d.querySelectorAll('#metricsTable th')].map(th => th.textContent);
  assert.deepEqual(heads(), ['Metric', 'Lab code', 'Coza']);
  assert.match(text(pg, 'valList'), /Lab code counts 1 peak twice/);
  $('showLab').checked = false; $('showLab').dispatchEvent(new pg.w.Event('change'));
  const last = pg.plots.at(-1);
  assert.equal(last.traces[TR.lab].visible, false, 'lab markers hidden');
  assert.equal(last.traces[TR.labIv].visible, false, 'lab interval triangles hidden');
  assert.equal(last.traces[TR.algo].visible, undefined, 'Coza still drawn');
  assert.deepEqual(heads(), ['Metric', 'Coza']);
  assert.ok(!/Pace \(lab formula\)/.test(text(pg, 'metricsTable')), 'lab-only rows go too');
  assert.equal($('labNote').hidden, true);
  assert.equal($('legLab').hidden, true);
  assert.equal($('wCtl').hidden, true, 'the lab window slider goes with it');
  assert.equal($('hCtl').hidden, false, 'Coza still uses h');
  assert.equal(last.layout.shapes.length, 1, 'so the h line stays');
  assert.ok(!/Lab code/.test(text(pg, 'valList')), 'lab-only checks hidden');
  $('showLab').checked = true; $('showLab').dispatchEvent(new pg.w.Event('change'));
  assert.deepEqual(heads(), ['Metric', 'Lab code', 'Coza']);
  assert.equal(pg.plots.at(-1).traces[TR.lab].visible, true);
});

test('Threshold peaks draws its smoothed signal and threshold, and does not use h', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  const $ = id => pg.d.getElementById(id);
  const algo = $('algoSel');
  algo.value = 'threshold'; algo.dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  let last = pg.plots.at(-1);
  assert.equal(text(pg, 'legAlgo'), 'Threshold peaks');
  assert.match(text(pg, 'algoDesc'), /mean \+ k·SD/);
  assert.equal($('advDetails').querySelector('[data-algo="coza"]').hidden, true, 'Coza options hide');
  assert.equal($('advDetails').querySelector('[data-algo="threshold"]').hidden, false);
  assert.equal(last.traces[TR.guide].visible, true); assert.equal(last.traces[TR.guide].name, 'Smoothed (3 Hz)');
  assert.equal(last.traces[TR.guide2].line.dash, 'dash');
  assert.match(text(pg, 'legGuides'), /^Smoothed \(3 Hz\)Mean \+ k·SD = -?\d+\.\d\d$/, 'not confused with h');
  const smooth = last.traces[TR.guide].y, markers = last.traces[TR.algo];
  assert.ok(markers.x.length >= 10, 'finds the walk');
  assert.ok(markers.y.every((y, k) => y === smooth[markers.customdata[k][0] - 1]), 'markers sit on the smoothed signal');
  assert.equal($('hCtl').hidden, false, 'h still shown while the lab code is compared');

  $('showLab').checked = false; $('showLab').dispatchEvent(new pg.w.Event('change'));
  last = pg.plots.at(-1);
  assert.equal($('hCtl').hidden, true, 'h hides when nothing uses it');
  assert.equal($('legHItem').hidden, true);
  assert.equal(last.layout.shapes.length, 0, 'no h line');

  const k = $('tpKIn');
  k.value = '1.5'; k.dispatchEvent(new pg.w.Event('input'));
  await sleep(40);
  assert.equal(text(pg, 'tpKOut'), '1.50 SD');
  assert.ok(pg.plots.at(-1).traces[TR.guide2].y[0] > last.traces[TR.guide2].y[0], 'threshold moves with k');
  $('resetParams').click();
  assert.equal(k.value, '0.5'); assert.equal(text(pg, 'tpKOut'), '0.50 SD');

  pg.w.HTMLAnchorElement.prototype.click = function () {};
  $('expMetrics').click();
  const csv = await new Promise(res => { const r = new pg.w.FileReader(); r.onload = () => res(r.result); r.readAsText(pg.blobs.at(-1)); });
  assert.match(csv, /^metric,lab_code,threshold,/);
  assert.match(csv, /\nalgorithm,Threshold peaks\n/);
  assert.match(csv, /\nlowpass_cutoff_hz,3\nthreshold_k,0\.5\nthreshold_value,-?[\d.]+\nmin_interval_s,0\.25\n/);
  assert.ok(!/coza_window/.test(csv));
});

test('Peak-to-valley draws its dynamic threshold and has its own options', async () => {
  const pg = makePage();
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  const $ = id => pg.d.getElementById(id);
  $('algoSel').value = 'peakvalley'; $('algoSel').dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  const last = pg.plots.at(-1);
  assert.equal(last.traces[TR.guide2].name, 'Dynamic threshold');
  assert.equal(last.traces[TR.guide2].y.length, last.traces[TR.signal].y.length, 'one threshold value per sample');
  assert.equal($('advDetails').querySelector('[data-algo="peakvalley"]').hidden, false);
  assert.equal(text(pg, 'pvSwingOut'), '40%');
  const n = last.traces[TR.algo].x.length;
  assert.ok(n >= 14 && n <= 17, n + ' steps on the demo walk');
  const sw = $('pvSwingIn');
  sw.value = '100'; sw.dispatchEvent(new pg.w.Event('input'));
  await sleep(40);
  assert.equal(text(pg, 'pvSwingOut'), '100%');
  assert.ok(pg.plots.at(-1).traces[TR.algo].x.length < n, 'a higher minimum swing keeps fewer steps');
});

test('the demo walk drops its start and stop bumps as weak peaks', async () => {
  const pg = makePage();
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  assert.match(text(pg, 'valList'), /2 weak peaks dropped.*less than 40% as far above h/);
  const last = pg.plots.at(-1);
  assert.equal(last.traces[TR.lab].x.length - last.traces[TR.algo].x.length, 2);

  // Phone position: on one leg, each peak is a stride (2 steps)
  const pos = pg.d.getElementById('posSel');
  assert.equal(pos.value, 'hand');
  const steps = () => pg.d.querySelector('#metricsTable tbody tr td:nth-child(3)').textContent;
  assert.equal(steps(), '15');
  pos.value = 'leg'; pos.dispatchEvent(new pg.w.Event('change'));
  await sleep(40);
  assert.match(steps(), /^30\s*15 strides × 2$/);
  assert.match(text(pg, 'posHint'), /stride/);
  pg.d.getElementById('demoBtn').click();
  await sleep(40);
  assert.equal(pos.value, 'hand', 'a new recording starts as hand or waist');
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
