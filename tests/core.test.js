// Run with: npm test   (Node 18+)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pako = require('pako');
const C = require('../src/core.js');

const FIX = path.join(__dirname, 'fixtures');
const DATA = path.join(__dirname, '..', 'data');
const inflate = u8 => pako.inflate(u8);
const readU8 = p => new Uint8Array(fs.readFileSync(p));

function loadMatDataset(file) {
  const parsed = C.parseMat(readU8(file), inflate);
  const { cands, notes } = C.matCandidates(parsed.variables);
  const ok = cands.filter(c => c.ok);
  if (!ok.length) return { parsed, cands, notes, ds: null };
  const { cols, transposed } = C.matToColumns(ok[0]);
  const ds = C.buildDataset(cols.map((_, k) => 'Column ' + (k + 1)), cols, 'mat');
  return { parsed, cands, notes, ds, transposed };
}
function loadCsvDataset(file) {
  const p = C.parseCsv(fs.readFileSync(file, 'utf8'));
  return { p, ds: C.buildDataset(p.names, p.cols, 'csv') };
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/* ------------------------------------------------ JS port == Python port */
test('original algorithm matches the Python port on the synthetic walk', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8')).columns;
  const { ds } = loadMatDataset(path.join(FIX, 'walk.mat'));
  for (const col of ['2', '3', '4']) {
    const ch = C.prepareChannel(ds, Number(col) - 1);
    const idx = C.detectOriginal(ch.A, 30, 1);
    const m = C.originalMetrics(idx, 30);
    const e = expected[col];
    assert.deepEqual(idx.map(i => i + 1), e.step_indices_matlab, 'indices, column ' + col);
    assert.ok(close(m.avgStepDuration, e.AverageStepDuration), 'AverageStepDuration, column ' + col);
    assert.ok(close(m.pace, e.Pace), 'Pace, column ' + col);
    assert.ok(close(m.variabilitySamples, e.VariabilitySteps), 'VariabilitySteps, column ' + col);
    assert.ok(close(m.asymmetry, e.GaitAsymmetry), 'GaitAsymmetry, column ' + col);
  }
});

/* ------------------------------------ JS port == MATLAB (Octave) reference */
// Reference values from running the course's LabStepDet_2025.m in GNU Octave on Walking.mat.
// Walking.mat is course material and is not committed; drop it into data/ to run this test.
const OCTAVE_WALKING = {
  2: { steps: 15, avg: 0.9542857143, pace: 57.25714286, variability: 42.39505466, asym: 1.234113712,
       idx: [234, 361, 471, 472, 584, 698, 812, 928, 1036, 1037, 1150, 1264, 1379, 1504, 1570] },
  3: { steps: 12, avg: 1.144545455, pace: 68.67272727, variability: 8.801859308, asym: 1.00877193 },
  4: { steps: 21, avg: 0.6955, pace: 41.73, variability: 37.12209585, asym: 1.214968153 },
};
test('original algorithm matches MATLAB/Octave on the course Walking.mat', { skip: !fs.existsSync(path.join(DATA, 'Walking.mat')) && 'data/Walking.mat not present' }, () => {
  const { ds } = loadMatDataset(path.join(DATA, 'Walking.mat'));
  for (const [col, r] of Object.entries(OCTAVE_WALKING)) {
    const ch = C.prepareChannel(ds, Number(col) - 1);
    const idx = C.detectOriginal(ch.A, 30, 1);
    const m = C.originalMetrics(idx, 30);
    assert.equal(m.steps, r.steps);
    if (r.idx) assert.deepEqual(idx.map(i => i + 1), r.idx);
    assert.ok(close(m.avgStepDuration, r.avg, 1e-8));
    assert.ok(close(m.pace, r.pace, 1e-8));
    assert.ok(close(m.variabilitySamples, r.variability, 1e-8));
    assert.ok(close(m.asymmetry, r.asym, 1e-8));
  }
});

/* ------------------------------------------------------- fixed version */
test('fixed version removes tied duplicates and the stop artefact', () => {
  const { ds } = loadMatDataset(path.join(FIX, 'walk.mat'));
  const ch = C.prepareChannel(ds, 1);
  const orig = C.detectOriginal(ch.A, 30, 1);
  const noTies = C.detectCoza(ch.A, 30, 1, { ties: true, weak: false });
  const d = noTies.idx.slice(1).map((v, k) => v - noTies.idx[k]);
  assert.ok(d.every(v => v > 30), 'no two fixed steps inside one window');
  assert.ok(noTies.idx.length < orig.length, 'tie fix removes duplicates');
  assert.ok(noTies.idx.every(i => orig.includes(i)), 'tie fix only removes, never adds');
});

test('windowExtreme matches a brute-force sliding max/min', () => {
  const A = Float64Array.from({ length: 300 }, (_, i) => Math.round(Math.sin(i / 7) * 10 + Math.cos(i / 3) * 3));
  for (const [b, a] of [[5, 5], [30, 30], [4, -1], [0, 0]]) {
    const M = C.windowExtreme(A, b, a, true), N = C.windowExtreme(A, b, a, false);
    for (let i = 0; i < A.length; i++) {
      let mx = -Infinity, mn = Infinity;
      for (let j = Math.max(0, i - b); j <= Math.min(A.length - 1, i + a); j++) { mx = Math.max(mx, A[j]); mn = Math.min(mn, A[j]); }
      assert.equal(M[i], mx); assert.equal(N[i], mn);
    }
  }
});

test('fixed metrics use timestamps and report cadence', () => {
  const t = Float64Array.from({ length: 1000 }, (_, i) => i * 0.02); // 50 Hz
  const idx = [0, 25, 50, 75, 100]; // every 0.5 s
  const m = C.cozaMetrics(idx, t, { stride: false });
  assert.ok(close(m.stepInterval, 0.5)); assert.ok(close(m.cadence, 120));
  const s = C.cozaMetrics(idx, t, { stride: true });
  assert.equal(s.steps, 10); assert.ok(close(s.cadence, 240)); assert.ok(Number.isNaN(s.asymmetry));
});

/* -------------------------------------------------- accepted MAT files */
test('accepts MAT variants and reads the lab layout', () => {
  for (const f of ['walk.mat', 'walk_uncompressed.mat', 'walk_multi.mat', 'walk_struct.mat', 'walk_transposed.mat']) {
    const { ds, transposed } = loadMatDataset(path.join(FIX, f));
    assert.ok(ds, f);
    assert.ok(ds.t, f + ': time column');
    assert.equal(ds.x.matCol, 2, f + ': x = column 2');
    assert.equal(ds.mag.matCol, 5, f + ': magnitude = column 5');
    assert.equal(transposed, f === 'walk_transposed.mat', f + ': orientation');
  }
});

test('struct fields are searched and non-data variables are skipped', () => {
  const s = loadMatDataset(path.join(FIX, 'walk_struct.mat'));
  assert.deepEqual(s.cands.filter(c => c.ok).map(c => c.path), ['rec.acc']);
  const m = loadMatDataset(path.join(FIX, 'walk_multi.mat'));
  assert.deepEqual(m.cands.filter(c => c.ok).map(c => c.path), ['Walking']);
  assert.match(m.cands.find(c => c.path === 'flags').reason, /true\/false/);
});

test('int16 data without a time column uses the manual sampling rate', () => {
  const { ds } = loadMatDataset(path.join(FIX, 'walk_int16.mat'));
  assert.equal(ds.t, null);
  const ch = C.prepareChannel(ds, 0, 50);
  assert.equal(ch.fs, 50);
});

test('a few missing values are interpolated when there is no time column', () => {
  const { ds } = loadMatDataset(path.join(FIX, 'walk_nan.mat'));
  const ch = C.prepareChannel(ds, 0);
  assert.equal(ch.fatal, false);
  assert.ok(ch.checks.some(c => /filled in/.test(c.title)));
  assert.ok(ch.A.every(Number.isFinite));
});

/* -------------------------------------------------- rejected MAT files */
const rejects = {
  'bad_v73.mat': /v7\.3/,
  'bad_v4.mat': /v4/,
  'bad_random.mat': /does not look like/,
  'bad_text_as.mat': /plain text/,
};
for (const [f, rx] of Object.entries(rejects)) {
  test('rejects ' + f + ' with a fix', () => {
    assert.throws(() => C.parseMat(readU8(path.join(FIX, f)), inflate), e => e instanceof C.InputError && rx.test(e.message) && e.fix.length > 0);
  });
}
test('rejects complex, cell and square matrices as data', () => {
  assert.match(loadMatDataset(path.join(FIX, 'bad_complex.mat')).cands[0].reason, /complex/);
  assert.match(loadMatDataset(path.join(FIX, 'bad_cell.mat')).notes[0].fix, /cell2mat/);
  assert.match(loadMatDataset(path.join(FIX, 'bad_square.mat')).cands[0].reason, /samples × a few channels/);
});
test('flags a flat signal as unusable', () => {
  const { ds } = loadMatDataset(path.join(FIX, 'bad_flat.mat'));
  const ch = C.prepareChannel(ds, 0);
  assert.equal(ch.fatal, true);
  assert.ok(ch.checks.some(c => c.level === 'error' && /Flat/.test(c.title)));
});

/* ---------------------------------------------------------------- CSV */
test('Physics Toolbox G-Force Meter export', () => {
  const { p, ds } = loadCsvDataset(path.join(FIX, 'ptb_gforce.csv'));
  assert.equal(p.delim, ',');
  assert.equal(ds.x.name, 'gFx'); assert.equal(ds.mag.name, 'TgF');
  assert.ok(ds.checks.some(c => c.title === 'Units: g'));
});
test('semicolon-separated export with decimal commas', () => {
  const { p, ds } = loadCsvDataset(path.join(FIX, 'ptb_linacc_semicolon.csv'));
  assert.equal(p.delim, ';'); assert.equal(p.decimalComma, true);
  assert.ok(ds.checks.some(c => c.title === 'Units: m/s²'));
  const ref = loadMatDataset(path.join(FIX, 'walk.mat')).ds;
  const a = C.prepareChannel(ds, 1), b = C.prepareChannel(ref, 1);
  assert.deepEqual(C.detectOriginal(a.A, 30, 1), C.detectOriginal(b.A, 30, 1));
});
test('newer export with # metadata lines and units in the headers', () => {
  const { p, ds } = loadCsvDataset(path.join(FIX, 'ptb_metadata_units.csv'));
  assert.equal(p.delim, ','); assert.equal(p.hasHeader, true);
  assert.equal(ds.x.name, 'ax (m/s^2)'); assert.equal(ds.mag.name, 'aT (m/s^2)');
  assert.equal(ds.x.label, 'x (ax)'); assert.equal(ds.mag.label, 'magnitude (aT)');
  assert.ok(ds.checks.some(c => c.title === 'Units: m/s²'));
  const ref = loadMatDataset(path.join(FIX, 'walk.mat')).ds;
  assert.deepEqual(C.detectOriginal(C.prepareChannel(ds, 1).A, 30, 1), C.detectOriginal(C.prepareChannel(ref, 1).A, 30, 1));
});
test('clipping: rounding plateaus at high rates are ignored, long plateaus are flagged', () => {
  const n = 4600, fs = 460;
  const t = Array.from({ length: n }, (_, i) => i / fs);
  // same peak held for 3 samples (6.5 ms, like TgF rounding at 460 Hz) vs 15 samples (33 ms)
  const plateau = len => t.map((v, i) => (i >= 2000 && i < 2000 + len ? 1.5 : 1 + 0.4 * Math.sin(2 * Math.PI * v)));
  const smooth = plateau(3), clipped = plateau(15);
  const check = sig => C.prepareChannel(C.buildDataset(['time', 'ax'], [Float64Array.from(t), Float64Array.from(sig)], 'csv'), 1)
    .checks.some(c => /clipping/.test(c.title));
  assert.equal(check(smooth), false);
  assert.equal(check(clipped), true);
});
test('clock-time export is converted to elapsed seconds', () => {
  const { p, ds } = loadCsvDataset(path.join(FIX, 'ptb_clock_time.csv'));
  assert.equal(p.clockTime, true);
  assert.ok(ds.t[0] === 0 && ds.t[ds.n - 1] > 10 && ds.t[ds.n - 1] < 30);
});
test('multi-record export: blank cells skipped per channel', () => {
  const { ds } = loadCsvDataset(path.join(FIX, 'ptb_multi_record.csv'));
  const ch = C.prepareChannel(ds, ds.columns.findIndex(c => c.name === 'gFx'));
  assert.equal(ch.A.length, ds.n / 2);
  assert.ok(ch.checks.some(c => /skipped/.test(c.title)));
  const gyro = C.prepareChannel(ds, ds.columns.findIndex(c => c.name === 'wx'));
  assert.ok(gyro.checks.some(c => c.title === 'Not an acceleration signal'));
});
test('headerless numeric CSV', () => {
  const { p, ds } = loadCsvDataset(path.join(FIX, 'plain_noheader.csv'));
  assert.equal(p.hasHeader, false); assert.ok(ds.t);
});
test('rejects joined recordings and empty exports', () => {
  assert.throws(() => loadCsvDataset(path.join(FIX, 'bad_backwards_time.csv')), /backwards/);
  assert.throws(() => loadCsvDataset(path.join(FIX, 'bad_empty.csv')), /fewer than 2 lines/);
});

test('unit inference from a quiet stretch', () => {
  const { ds } = loadMatDataset(path.join(FIX, 'walk.mat'));
  assert.ok(ds.checks.some(c => c.title === 'Units: gravity removed'));
});
