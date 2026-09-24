// Drives index.html in jsdom with a stubbed Plotly (no real rendering).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const pako = require('pako');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

function makePage() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="https:[^>]+><\/script>/g, '')
    .replace(/<link[^>]+>/g, '')
    .replace('<script src="src/core.js"></script>', '<script>' + fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8') + '</script>')
    .replace('<script src="src/app.js"></script>', '<script>' + fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8') + '</script>');
  const plots = [], blobs = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.pako = pako; w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.Plotly = { react(el, traces, layout) { plots.push({ traces, layout }); el.on = (ev, fn) => { el._click = fn; }; } };
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
const text = (pg, id) => pg.d.getElementById(id).textContent.replace(/\s+/g, ' ').trim();

test('loads a MAT file, compares versions and exports', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  assert.match(text(pg, 'valTitle'), /^Valid/);
  assert.equal(pg.d.getElementById('valList').hidden, true, 'checks start collapsed when the file is valid');
  pg.d.getElementById('valToggle').click();
  assert.equal(pg.d.getElementById('valList').hidden, false, 'and open on click');
  assert.equal(pg.d.getElementById('analysis').hidden, false);
  assert.equal(pg.d.getElementById('advDetails').open, false, 'advanced options start closed');
  assert.equal(pg.d.getElementById('chanSel').value, '1', 'defaults to column 2 like the lab code');
  const last = pg.plots.at(-1);
  const lab = last.traces[1].x.length, fixed = last.traces[2].x.length;
  assert.ok(lab > fixed, 'Coza drops the tied duplicate');
  assert.equal(pg.d.getElementById('algoSel').value, 'coza');
  assert.deepEqual([...pg.d.getElementById('algoSel').options].map(o => o.textContent), ['Coza']);
  assert.equal(text(pg, 'legAlgo'), 'Coza');
  assert.equal(pg.d.querySelector('#metricsTable th.col-algo').textContent, 'Coza');
  assert.equal(pg.d.getElementById('stepsDetails').open, false, 'steps table starts collapsed');
  assert.match(text(pg, 'stepsTitle'), new RegExp(fixed + ' Coza, ' + lab + ' lab code'));

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

  $('noteList').querySelector('button').click();
  assert.equal($('noteList').hidden, true);
  assert.equal(pg.plots.at(-1).layout.annotations.length, 0);
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
