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
  const plots = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.pako = pako; w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.Plotly = { react(el, traces, layout) { plots.push({ traces, layout }); el.on = (ev, fn) => { el._click = fn; }; } };
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  } });
  return { w: dom.window, d: dom.window.document, plots };
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

test('loads a MAT file, compares versions, edits and exports', async () => {
  const pg = makePage();
  await upload(pg, path.join(FIX, 'walk.mat'));
  assert.match(text(pg, 'valTitle'), /^Valid/);
  assert.equal(pg.d.getElementById('valList').hidden, true, 'checks start collapsed when the file is valid');
  pg.d.getElementById('valToggle').click();
  assert.equal(pg.d.getElementById('valList').hidden, false, 'and open on click');
  assert.equal(pg.d.getElementById('analysis').hidden, false);
  assert.equal(pg.d.getElementById('advDetails').open, false, 'advanced options start closed');
  assert.equal(pg.d.getElementById('snap').checked, true);
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

  // remove one fixed step, add one, undo
  assert.equal(pg.d.getElementById('legAdded').hidden, true, 'edit legend hidden until editing');
  pg.d.getElementById('editMode').checked = true;
  pg.d.getElementById('editMode').dispatchEvent(new pg.w.Event('change'));
  const cd = pg.plots.at(-1).traces[2].customdata[2];
  pg.d.getElementById('plot')._click({ points: [{ curveNumber: 2, customdata: cd }] });
  await sleep(20);
  assert.equal(text(pg, 'editCount'), '1 removed');
  assert.equal(pg.d.getElementById('legRemoved').hidden, false);
  pg.d.getElementById('plot')._click({ points: [{ curveNumber: 0, pointIndex: 5 }] });
  await sleep(20);
  assert.equal(text(pg, 'editCount'), '1 added, 1 removed');
  pg.d.getElementById('undoEdit').click();
  await sleep(20);
  assert.equal(text(pg, 'editCount'), '1 removed');

  // export uses a download link outside Claude
  let saved = null;
  pg.w.HTMLAnchorElement.prototype.click = function () { saved = this.download; };
  pg.d.getElementById('expSteps').click();
  assert.equal(saved, 'walk_steps.csv');
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
