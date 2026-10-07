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

test('Coza (modified) keeps Walking.mat\'s counts with the rhythm check (#81)', { skip: !fs.existsSync(path.join(DATA, 'Walking.mat')) && 'data/Walking.mat not present' }, () => {
  const { ds } = loadMatDataset(path.join(DATA, 'Walking.mat'));
  const def = C.ALGORITHMS.find(a => a.id === 'coza');
  const counts = [2, 3, 4, 5].map(col => { const ch = C.prepareChannel(ds, col - 1); return def.detect(ch.A, ch.t, Object.assign({ fs: ch.fs }, C.defaultParams(def))).idx.length; });
  assert.deepEqual(counts, [12, 12, 18, 23], 'the same as with height alone; the stop bump on column 2 is still dropped');
});

/* ------------------------------------------------------- fixed version */
// #81: a weak peak is dropped only when it is also out of rhythm
test('a weak peak on the rhythm is kept; one out of rhythm is dropped', () => {
  const fs = 100, t = Array.from({ length: 1200 }, (_, i) => i / fs), A = new Array(1200).fill(0);
  const bump = (at, height) => { for (let i = -10; i <= 10; i++) A[at + i] = Math.max(A[at + i], height * Math.cos(i / 10 * Math.PI / 2)); };
  for (const at of [100, 200, 300, 400, 500, 600, 700, 800, 900]) bump(at, 10);  // a step every 1 s
  bump(1000, 2);  // a faint last step, on the rhythm
  bump(140, 2);   // a faint bump 0.4 s after a step: out of rhythm
  const on = C.detectCoza(A, 30, 1, { ties: true, weak: true, weakRatio: C.WEAK_RATIO, rhythmRatio: C.RHYTHM_RATIO, t });
  assert.deepEqual(on.weakDropped, [140]); assert.ok(on.idx.includes(1000), 'the faint step on the rhythm stays');
  const heightOnly = C.detectCoza(A, 30, 1, { ties: true, weak: true, weakRatio: C.WEAK_RATIO, t });
  assert.deepEqual(heightOnly.weakDropped, [140, 1000], 'without the rhythm check, both go (the old rule)');
});
test('the synthetic walk knows its true count, and Coza (modified) finds it (#81)', () => {
  const d = C.demoWalk(), t = d.cols[0], A = d.cols[1];
  assert.equal(d.steps, 17, 'cycles of the noise-free recipe, faint first and last included');
  const run = id => { const def = C.ALGORITHMS.find(a => a.id === id); return def.detect(A, t, Object.assign({ fs: 1 / C.median(Array.from(t).slice(1).map((v, i) => v - t[i])) }, C.defaultParams(def))).idx.length; };
  assert.equal(run('coza'), 17); assert.equal(run('coza_original'), 17);
});
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

/* ------------------------------------------------- signal helpers */
const sine = (n, fs, f, amp = 1, off = 0) => Float64Array.from({ length: n }, (_, i) => off + amp * Math.sin(2 * Math.PI * f * i / fs));
const rangeOf = (a, lo, hi) => { let mx = -Infinity, mn = Infinity; for (let i = lo; i < hi; i++) { mx = Math.max(mx, a[i]); mn = Math.min(mn, a[i]); } return (mx - mn) / 2; };

test('lowpass keeps slow motion, removes fast noise and does not shift peaks', () => {
  const fs = 100, n = 2000;
  // forwards + backwards: gain |H|^2 = 1 / (1 + (f/fc)^4)
  const slow = C.lowpass(sine(n, fs, 1), fs, 3);
  assert.ok(close(rangeOf(slow, 500, 1500), 1 / (1 + (1 / 3) ** 4), 2e-3), '1 Hz passes');
  assert.ok(close(rangeOf(C.lowpass(sine(n, fs, 3), fs, 3), 500, 1500), 0.5, 2e-3), 'half gain at the cut-off');
  assert.ok(rangeOf(C.lowpass(sine(n, fs, 20), fs, 3), 500, 1500) < 1e-3, '20 Hz is removed');
  // zero phase: the 1 Hz peaks stay at samples 25, 125, ...
  for (let k = 5; k < 15; k++) {
    let best = k * 100 + 25 - 10;
    for (let i = best; i <= k * 100 + 35; i++) if (slow[i] > slow[best]) best = i;
    assert.equal(best, k * 100 + 25);
  }
  // starts settled: an offset signal does not ring at the ends
  const off = C.lowpass(sine(n, fs, 1, 0.1, 9.81), fs, 3);
  assert.ok(Math.abs(off[0] - 9.81) < 0.02 && Math.abs(off[n - 1] - 9.81) < 0.02);
  assert.deepEqual(C.lowpass(Float64Array.of(1, 2, 3), 100, 60), Float64Array.of(1, 2, 3), 'cut-off above fs/2: unchanged');
});

// Same input as filter_input() in scripts/make_fixtures.py.
const filterInput = fs => Float64Array.from({ length: Math.round(fs * 2) }, (_, i) => {
  const t = i / fs;
  return 1 + Math.sin(2 * Math.PI * 1.8 * t) + 0.3 * Math.sin(2 * Math.PI * 17 * t + 0.4) + 0.1 * Math.sin(2 * Math.PI * 0.2 * t);
});
// Frequency response of a cascade of sections at f Hz.
function sosResponse(sos, f, fs) {
  const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  let re = 1, im = 0;
  for (const [b0, b1, b2, a0, a1, a2] of sos) {
    const nr = b0 + b1 * c1 + b2 * c2, ni = b1 * s1 + b2 * s2, dr = a0 + a1 * c1 + a2 * c2, di = a1 * s1 + a2 * s2;
    const d = dr * dr + di * di, qr = (nr * dr + ni * di) / d, qi = (ni * dr - nr * di) / d;
    [re, im] = [re * qr - im * qi, re * qi + im * qr];
  }
  return [re, im];
}

test('Butterworth, Bessel, Chebyshev I/II and elliptic match scipy: design and zero-phase output', () => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(FIX, 'filters.json'), 'utf8'));
  assert.equal(cases.length, 150);
  for (const c of cases) {
    const label = JSON.stringify(c.spec);
    const { sos } = C.designFilter(c.spec);
    assert.equal(sos.length, Math.ceil(c.spec.order * (c.spec.highpass ? 2 : 1) / 2), label + ': sections');
    c.freqs.forEach((f, i) => {
      const [re, im] = sosResponse(sos, f, c.spec.fs);
      assert.ok(Math.hypot(re - c.h_re[i], im - c.h_im[i]) < 1e-9, label + ' response at ' + f + ' Hz');
    });
    const y = C.sosfiltfilt(sos, filterInput(c.spec.fs));
    c.y_every_8.forEach((v, i) => assert.ok(Math.abs(y[i * 8] - v) < 1e-9, label + ' output at sample ' + i * 8));
  }
});

// Same as spiky_input() in scripts/make_fixtures.py.
const spikyInput = fs => { const x = filterInput(fs); for (let i = 7; i < x.length; i += 53) x[i] += 2.5; return x; };

test('moving average, median, Savitzky–Golay, wavelet and notch match scipy/PyWavelets, edges included', () => {
  const { other } = JSON.parse(fs.readFileSync(path.join(FIX, 'filters.json'), 'utf8'));
  assert.deepEqual([...new Set(other.map(c => c.filter))], ['movavg', 'median', 'savgol', 'wavelet', 'notch']);
  for (const c of other) {
    const y = C.FILTERS.find(f => f.id === c.filter).apply(spikyInput(c.fs), c.fs, c.p);
    c.idx.forEach((i, k) => assert.ok(Math.abs(y[i] - c.y[k]) < 1e-9, c.filter + ' ' + JSON.stringify(c.p) + ' at ' + c.fs + ' Hz, sample ' + i));
  }
});

test('the notch removes one frequency and keeps the walk', () => {
  const fs = 460, t = Float64Array.from({ length: 2300 }, (_, i) => i / fs);
  const walk = t.map(v => Math.sin(2 * Math.PI * 1.8 * v)), A = t.map((v, i) => walk[i] + 0.5 * Math.sin(2 * Math.PI * 50 * v));
  const y = C.FILTERS.find(f => f.id === 'notch').apply(A, fs, { notchFreq: 50, notchQ: 30 });
  // a narrow notch (Q 30) rings for a few hundred ms at each end; past the first and last second the hum is gone
  assert.ok(Math.max(...Array.from(y.slice(460, -460), (v, i) => Math.abs(v - walk[i + 460]))) < 0.002);
  assert.ok(Math.abs(y[100] - walk[100]) > 0.01, 'the ringing near the start is real');
  assert.throws(() => C.notchSos(30, 30, 57), /under 28\.5 Hz/);
});

test('db4 wavelet transforms match PyWavelets forwards and back', () => {
  const { dwt: ref } = JSON.parse(fs.readFileSync(path.join(FIX, 'filters.json'), 'utf8'));
  for (const k of ['decLo', 'decHi', 'recLo', 'recHi']) {
    const want = ref[k.replace(/([A-Z])/, '_$1').toLowerCase()];
    C.DB4[k].forEach((v, j) => assert.ok(Math.abs(v - want[j]) < 1e-15, k + '[' + j + ']'));
  }
  for (const c of ref.cases) {
    const { cA, cD } = C.dwt(fftInput(c.n));
    assert.equal(cA.length, c.cA.length, 'n = ' + c.n);
    c.cA.forEach((v, k) => assert.ok(Math.abs(cA[k] - v) < 1e-12 && Math.abs(cD[k] - c.cD[k]) < 1e-12, 'dwt, n = ' + c.n + ', ' + k));
    const back = C.idwt(Float64Array.from(c.cA), Float64Array.from(c.cD));
    assert.equal(back.length, c.back.length);
    c.back.forEach((v, k) => assert.ok(Math.abs(back[k] - v) < 1e-12, 'idwt, n = ' + c.n + ', ' + k));
  }
  assert.throws(() => C.waveletDenoise(new Float64Array(50), 4, 1), /too short for 4 wavelet levels: at most 2/);
});

test('wavelet denoising keeps heel strikes better than a low-pass that removes as much noise', () => {
  const fs = 460, t = Float64Array.from({ length: 4600 }, (_, i) => i / fs);
  let seed = 9; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  // 2 Hz sway with a sharp 20 ms heel-strike spike each step, plus white noise
  const clean = t.map(v => { const ph = (v * 2) % 1; return 0.5 * Math.sin(2 * Math.PI * 2 * v) + (ph < 0.02 ? 2 * (1 - Math.abs(ph - 0.01) / 0.01) : 0); });
  const A = clean.map(v => v + 0.52 * rnd());
  const err = y => Math.sqrt(C.mean(Array.from(y, (v, i) => (v - clean[i]) ** 2)));
  const spike = y => C.mean(Array.from({ length: 18 }, (_, k) => { const c = Math.round(((k + 1) / 2 + 0.01) * fs); return Math.max(...y.slice(c - 5, c + 6)); }));
  const wv = C.waveletDenoise(A, 4, 0.5);
  assert.ok(err(wv) < 0.6 * err(A), 'removes noise');
  for (const fLow of [10, 20, 40]) {
    const bw = C.FILTERS.find(f => f.id === 'butter').apply(A, fs, { fOrder: 4, fLow, fHigh: 0 });
    assert.ok(err(wv) < err(bw) && spike(wv) > spike(bw), 'beats a ' + fLow + ' Hz low-pass on both');
  }
});

test('Savitzky–Golay weights are exact even for long windows of high order', () => {
  // scipy loses precision here (1.5e-10), so the reference is exact rational arithmetic
  const { savgol_exact: ex } = JSON.parse(fs.readFileSync(path.join(FIX, 'filters.json'), 'utf8'));
  const h = (ex.window - 1) / 2;
  ex.weights.forEach((wt, j) => {
    const x = new Float64Array(ex.window); x[j] = 1;
    assert.ok(Math.abs(C.savgol(x, ex.window, ex.order)[h] - wt) < 1e-15, 'weight ' + j);
  });
});

test('the median filter removes short spikes and keeps real peaks at their height', () => {
  const fs = 460, t = Float64Array.from({ length: 2300 }, (_, i) => i / fs);
  const walk = t.map(v => Math.sin(2 * Math.PI * 1.8 * v));
  const A = walk.slice();
  for (let i = 100; i < A.length; i += 230) for (let k = 0; k < 5; k++) A[i + k] += 3; // 11 ms knocks
  const med = C.FILTERS.find(f => f.id === 'median').apply(A, fs, { medWindow: 0.05 });
  // spikes of 3 are gone; what is left is the median of a steep slope shifting by a sample or two
  assert.ok(Math.max(...Array.from(med, (v, i) => Math.abs(v - walk[i]))) < 0.2, 'spikes gone');
  assert.ok(Math.max(...med) > 0.99, 'peak height kept');
  const avg = C.FILTERS.find(f => f.id === 'movavg').apply(A, fs, { maWindow: 0.05 });
  assert.ok(Math.max(...Array.from(avg, (v, i) => Math.abs(v - walk[i]))) > 0.5, 'an average only spreads them');
});

test('smoothing windows are odd, in seconds, and refuse sizes that do not fit', () => {
  assert.equal(C.oddWindow(0.1, 100, 1000, 3), 11); assert.equal(C.oddWindow(0.1, 460, 1000, 3), 47); assert.equal(C.oddWindow(0.05, 100, 1000, 3), 7, 'halves round up');
  assert.throws(() => C.oddWindow(0.01, 57, 1000, 3), /needs at least 3\. Lengthen it to 0\.053 s/);
  assert.throws(() => C.oddWindow(1, 100, 50, 3), /longer than the recording/);
});

test('filter design refuses impossible settings with a fix', () => {
  const base = { type: 'butter', order: 4, fs: 50, lowpass: 3, highpass: 0 };
  const bad = [[{ lowpass: 25 }, /below half the sampling rate: under 25\.0 Hz/], [{ highpass: 3 }, /high-pass cut-off must be below the low-pass/],
    [{ order: 0 }, /order/], [{ type: 'cheby1', rp: 0 }, /ripple/], [{ type: 'cheby2', rs: 0 }, /attenuation/], [{ type: 'ellip', rp: 1, rs: 1 }, /attenuation must be larger than the passband ripple/], [{ lowpass: 0 }, /low-pass cut-off must be above 0/]];
  for (const [chg, rx] of bad) assert.throws(() => C.designFilter(Object.assign({}, base, chg)), e => e instanceof RangeError && rx.test(e.message), JSON.stringify(chg));
});

test('dynamicThreshold matches brute force', () => {
  const A = Float64Array.from({ length: 200 }, (_, i) => Math.sin(i / 5) * 4 + (i % 7));
  const dt = C.dynamicThreshold(A, 6);
  for (let i = 0; i < A.length; i++) {
    const w = A.slice(Math.max(0, i - 6), Math.min(A.length, i + 7));
    assert.equal(dt.upper[i], Math.max(...w)); assert.equal(dt.lower[i], Math.min(...w));
    assert.equal(dt.mid[i], (Math.max(...w) + Math.min(...w)) / 2);
  }
});

/* ----------------------------------------- algorithms on a known walk */
// Rest, then n steps as one sine cycle each with uneven timing, then rest; noise on top.
// Step k rises through the baseline at rise[k] and peaks a quarter cycle later at peak[k].
function knownWalk({ fs = 100, n = 20, amp = 2, offset = 0, noise = 0.3, rest = 2 } = {}) {
  const iv = Array.from({ length: n }, (_, k) => 0.5 + 0.06 * Math.sin(1.7 * k));
  const rise = [], peak = [];
  let t0 = rest;
  for (const d of iv) { rise.push(t0); peak.push(t0 + d / 4); t0 += d; }
  const end = t0, N = Math.round((end + rest) * fs);
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const t = Float64Array.from({ length: N }, (_, i) => i / fs);
  const A = t.map(v => {
    let x = 0;
    if (v >= rest && v < end) { let k = 0; while (k + 1 < n && rise[k + 1] <= v) k++; x = amp * Math.sin(2 * Math.PI * (v - rise[k]) / iv[k]); }
    return offset + x + noise * rnd();
  });
  return { A, t, fs, rise, peak };
}
const matchTimes = (idx, t, want, tol) => idx.length === want.length && idx.every((i, k) => Math.abs(t[i] - want[k]) < tol);

test('Threshold peaks finds every step of a known walk, at 100 Hz and 460 Hz, with or without gravity', () => {
  for (const cfg of [{}, { fs: 460 }, { offset: 9.81, amp: 1, noise: 0.2 }, { fs: 57 }]) {
    const w = knownWalk(cfg);
    const r = C.detectThresholdPeaks(w.A, w.t, w.fs, { cutoff: 3, k: 0.5, minInterval: 0.25 });
    assert.ok(matchTimes(r.idx, w.t, w.peak, 0.04), JSON.stringify(cfg) + ': ' + r.idx.length + ' peaks');
  }
});

test('Threshold peaks keeps the taller of two peaks inside the minimum interval', () => {
  const t = Float64Array.from({ length: 300 }, (_, i) => i / 100);
  const A = t.map(v => Math.exp(-((v - 1) ** 2) / 0.002) + 2 * Math.exp(-((v - 1.15) ** 2) / 0.002) + Math.exp(-((v - 2) ** 2) / 0.002));
  const r = C.detectThresholdPeaks(A, t, 100, { cutoff: 20, k: 0, minInterval: 0.25 });
  assert.deepEqual(r.idx.map(i => t[i].toFixed(2)), ['1.15', '2.00']);
  const all = C.detectThresholdPeaks(A, t, 100, { cutoff: 20, k: 0, minInterval: 0.1 });
  assert.equal(all.idx.length, 3);
});

test('Peak-to-valley finds every step of a known walk, at 100 Hz and 460 Hz, with or without gravity', () => {
  for (const cfg of [{}, { fs: 460 }, { offset: 9.81, amp: 1, noise: 0.2 }, { fs: 57 }]) {
    const w = knownWalk(cfg);
    const r = C.detectPeakToValley(w.A, w.t, w.fs, { window: 1, minSwing: 0.4, minInterval: 0.25 });
    assert.ok(matchTimes(r.idx, w.t, w.peak, 0.04), JSON.stringify(cfg) + ': ' + r.idx.length + ' steps');
    assert.ok(r.candidates > r.idx.length, 'standing still makes small swings, which are dropped');
  }
});

test('Peak-to-valley drops small swings and keeps the larger of two close steps', () => {
  const t = Float64Array.from({ length: 600 }, (_, i) => i / 100);
  const bump = (c, a) => v => a * Math.exp(-((v - c) ** 2) / 0.002);
  const parts = [bump(1, 2), bump(2, 2), bump(3, 0.3), bump(4, 2), bump(4.2, 2.6), bump(5, 2)];
  const A = t.map(v => parts.reduce((x, f) => x + f(v), 0));
  const at = r => r.idx.map(i => t[i].toFixed(2));
  const r = C.detectPeakToValley(A, t, 100, { window: 1, minSwing: 0.4, minInterval: 0.25 });
  assert.deepEqual(at(r), ['1.00', '2.00', '4.20', '5.00'], 'the 0.3 bump goes; 4.2 (larger) replaces 4.0');
  const all = C.detectPeakToValley(A, t, 100, { window: 1, minSwing: 0.1, minInterval: 0.1 });
  assert.deepEqual(at(all), ['1.00', '2.00', '3.00', '4.00', '4.20', '5.00']);
});

test('Zero-crossing finds every step of a known walk, at 100 Hz and 460 Hz, with or without gravity', () => {
  for (const cfg of [{}, { fs: 460 }, { offset: 9.81, amp: 1, noise: 0.2 }, { fs: 57 }]) {
    const w = knownWalk(cfg);
    const r = C.detectZeroCrossing(w.A, w.t, w.fs, { cutoff: 3, minInterval: 0.25 });
    assert.ok(matchTimes(r.idx.slice(1), w.t, w.rise.slice(1), 0.04), JSON.stringify(cfg) + ': ' + r.idx.length + ' crossings');
    // the first rise starts abruptly from rest, which the filter smears out a little earlier
    assert.ok(Math.abs(w.t[r.idx[0]] - w.rise[0]) < 0.1);
  }
});

test('Zero-crossing ignores noise near zero and crossings inside the minimum interval', () => {
  const fs = 100, t = Float64Array.from({ length: 1000 }, (_, i) => i / fs);
  // 1 Hz walk with a fast ripple on top: the ripple crosses zero many times per cycle
  const A = t.map(v => Math.sin(2 * Math.PI * v) + 0.4 * Math.sin(2 * Math.PI * 9 * v));
  const unfiltered = C.detectZeroCrossing(A, t, fs, { cutoff: 50, minInterval: 0.1 });
  assert.ok(unfiltered.idx.length >= 9 && unfiltered.idx.length <= 11, 'hysteresis alone: one per cycle, ' + unfiltered.idx.length);
  const r = C.detectZeroCrossing(A, t, fs, { cutoff: 3, minInterval: 0.25 });
  assert.ok(r.idx.length >= 9 && r.idx.length <= 11, r.idx.length + ' crossings');
  // 2 Hz with a 0.6 s minimum interval: every other crossing is too soon
  const fast = t.map(v => Math.sin(2 * Math.PI * 2 * v));
  const n2 = C.detectZeroCrossing(fast, t, fs, { cutoff: 5, minInterval: 0.25 }).idx.length;
  const n6 = C.detectZeroCrossing(fast, t, fs, { cutoff: 5, minInterval: 0.6 }).idx.length;
  assert.ok(n2 >= 19 && Math.abs(n6 - n2 / 2) <= 1, n2 + ' vs ' + n6);
});

const FP = { filter: 'butter', fOrder: 4, fLow: 3, fHigh: 0, fRipple: 0.5, fAtten: 40 };
// Robustness checks skip the original Coza: it is the lab rule as written (window in samples,
// tied peaks twice, stop bump kept), and those bugs are what it is there to show.
const FIXED_ALGOS = C.ALGORITHMS.filter(a => a.id !== 'coza_original');
const ALGO_P = { h: 1, w: 30, weak: true, cozaWindow: 0.3, tpCutoff: 3, tpK: 0.5, tpMinInterval: 0.25, pvWindow: 1, pvSwing: 40, pvMinInterval: 0.25, zcCutoff: 3, zcMinInterval: 0.25 };

test('a filtered noisy walk gives the same steps as the clean walk, for every algorithm and filter', () => {
  const clean = knownWalk({ fs: 460, noise: 0 });
  // 25 Hz vibration plus a 60 Hz hum, both larger than the noise the algorithms are tuned for
  const noisy = clean.A.map((v, i) => v + 1.2 * Math.sin(2 * Math.PI * 25 * clean.t[i]) + 0.8 * Math.sin(2 * Math.PI * 60 * clean.t[i] + 1));
  const p = Object.assign({ fs: 460 }, ALGO_P);
  for (const filter of ['butter', 'bessel', 'cheby1', 'cheby2', 'ellip']) {
    // gentle roll-offs (Bessel) and stopband-edge cut-offs (Chebyshev II) need a higher cut-off to leave the walk alone
    const f = C.applyFilter(noisy, clean.t, 460, Object.assign({}, FP, { filter, fLow: filter === 'cheby2' || filter === 'bessel' ? 8 : 4 }));
    assert.equal(f.applied, true); assert.equal(f.resampled, false, 'evenly sampled: no resampling');
    for (const a of FIXED_ALGOS) {
      const want = a.detect(clean.A, clean.t, p).idx.map(i => clean.t[i]);
      const got = a.detect(f.A, clean.t, p).idx.map(i => clean.t[i]);
      assert.equal(got.length, want.length, filter + ', ' + a.id);
      got.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 0.03, filter + ', ' + a.id + ', step ' + k));
    }
  }
  assert.notEqual(C.detectOriginal(noisy, 30, 1).length, C.detectOriginal(clean.A, 30, 1).length, 'the noise does change Coza without a filter');
});

test('uneven timestamps are resampled for the filter and read back at the original times', () => {
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const t = new Float64Array(3000);
  for (let i = 1; i < t.length; i++) t[i] = t[i - 1] + (1 + 0.6 * rnd()) / 460; // ±30% timing jitter, like a phone
  const slow = t.map(v => Math.sin(2 * Math.PI * v));
  const A = t.map((v, i) => slow[i] + 0.5 * Math.sin(2 * Math.PI * 40 * v));
  const f = C.applyFilter(A, t, 460, FP);
  assert.equal(f.resampled, true);
  assert.equal(f.A.length, A.length, 'one value per recorded sample');
  assert.match(f.checks[0].title, /Resampled/); assert.match(f.checks[0].detail, /even 4\d\d\.\d Hz grid/);
  // what remains is mostly the straight-line interpolation of the 40 Hz part onto the grid
  const err = Math.max(...Array.from(f.A, (v, i) => i > 200 && i < A.length - 200 ? Math.abs(v - slow[i]) : 0));
  assert.ok(err < 0.02, 'the 40 Hz part is gone and the 1 Hz part kept: ' + err);
  const even = C.sosfiltfilt(C.designFilter({ type: 'butter', order: 4, fs: 460, lowpass: 3 }).sos, A);
  const errEven = Math.max(...Array.from(even, (v, i) => i > 200 && i < A.length - 200 ? Math.abs(v - slow[i]) : 0));
  assert.ok(errEven > 2 * err, 'treating the samples as even is worse: ' + errEven);
});

test('a filter that cannot be built leaves the signal alone and says what to change', () => {
  const t = Float64Array.from({ length: 500 }, (_, i) => i / 50), A = t.map(v => Math.sin(v));
  assert.equal(C.applyFilter(A, t, 50, { filter: 'none' }).A, A);
  const r = C.applyFilter(A, t, 50, Object.assign({}, FP, { fLow: 30 }));
  assert.equal(r.applied, false); assert.equal(r.A, A);
  assert.equal(r.checks[0].title, 'Filter not applied');
  assert.match(r.checks[0].detail, /under 25\.0 Hz/); assert.match(r.checks[0].fix, /Advanced/);
  assert.equal(C.filterLabel(Object.assign({}, FP, { filter: 'cheby2', fOrder: 2, fHigh: 0.3 })), 'Chebyshev II, 2nd order, 0.3\u20133.0 Hz band-pass, 40 dB stopband');
  assert.equal(C.filterLabel({ filter: 'none' }), 'none');
});

/* ------------------------------------------------ frequency domain (#36) */
const SPEC = JSON.parse(fs.readFileSync(path.join(FIX, 'spectral.json'), 'utf8'));
// Same as fft_input() in scripts/make_fixtures.py.
const fftInput = n => Float64Array.from({ length: n }, (_, k) => Math.sin(0.37 * k) + 0.5 * Math.cos(1.9 * k + 0.3) + 0.01 * k);

test('the FFT matches numpy.fft for powers of two and other lengths, and inverts', () => {
  for (const c of SPEC.fft) {
    const x = fftInput(c.n), X = C.fft(x);
    const scale = Math.max(1, ...c.re.map(Math.abs), ...c.im.map(Math.abs));
    for (let k = 0; k < c.n; k++) assert.ok(Math.abs(X.re[k] - c.re[k]) < 1e-12 * scale && Math.abs(X.im[k] - c.im[k]) < 1e-12 * scale, 'n = ' + c.n + ', bin ' + k);
    const back = C.ifft(X.re, X.im);
    for (let k = 0; k < c.n; k++) assert.ok(Math.abs(back.re[k] - x[k]) < 1e-12 * scale && Math.abs(back.im[k]) < 1e-12 * scale, 'inverse, n = ' + c.n);
  }
});

test('the Hilbert envelope matches scipy.signal.hilbert and follows a changing amplitude', () => {
  for (const c of SPEC.hilbert) {
    const x = filterInput(c.fs), mu = C.mean(x), z = C.hilbert(x.map(v => v - mu));
    c.re.forEach((v, k) => assert.ok(Math.abs(z.re[k] - v) < 1e-12 && Math.abs(z.im[k] - c.im[k]) < 1e-12, c.fs + ' Hz, sample ' + k));
  }
  // a 2 Hz swing whose amplitude grows from 1 to 3, on a 9.81 offset: the band is 9.81 ± the amplitude
  const t = Float64Array.from({ length: 1000 }, (_, i) => i / 100), amp = v => 1 + v / 5;
  const A = t.map(v => 9.81 + amp(v) * Math.sin(2 * Math.PI * 2 * v));
  const e = C.ENVELOPES.find(x => x.id === 'hilbert').compute(A, t, {});
  for (let i = 200; i < 800; i += 10) assert.ok(Math.abs(e.upper[i] - (C.mean(A) + amp(t[i]))) < 0.05, 'upper at ' + t[i] + ' s');
});

test('Welch spectrum matches scipy.signal.welch', () => {
  for (const c of SPEC.welch) {
    const x = Float64Array.from({ length: Math.round(c.fs * 10) }, (_, i) => { const t = i / c.fs; return 1 + Math.sin(2 * Math.PI * 1.8 * t) + 0.3 * Math.sin(2 * Math.PI * 17 * t + 0.4) + 0.1 * Math.sin(2 * Math.PI * 0.2 * t); });
    const r = C.welch(x, c.fs, { nperseg: c.nperseg, nfft: c.nfft });
    assert.equal(r.psd.length, c.psd.length);
    const top = Math.max(...c.psd);
    c.psd.forEach((v, k) => { assert.ok(Math.abs(r.psd[k] - v) < 1e-12 * top, c.fs + ' Hz, nfft ' + c.nfft + ', bin ' + k); assert.ok(Math.abs(r.f[k] - c.f[k]) < 1e-12); });
  }
});

test('the spectrogram matches scipy.signal.spectrogram, and follows a walk that speeds up', () => {
  for (const c of SPEC.spectrogram) {
    const x = Float64Array.from({ length: Math.round(c.fs * 10) }, (_, i) => { const t = i / c.fs; return 1 + Math.sin(2 * Math.PI * 1.8 * t) + 0.3 * Math.sin(2 * Math.PI * 17 * t + 0.4) + 0.1 * Math.sin(2 * Math.PI * 0.2 * t); });
    const r = C.spectrogram(x, c.fs, { nperseg: c.nperseg, noverlap: c.noverlap, nfft: c.nfft });
    assert.equal(r.S.length, c.S.length, c.fs + ' Hz: segments');
    r.t.forEach((v, k) => assert.ok(Math.abs(v - c.t[k]) < 1e-12));
    const top = Math.max(...c.S.flat());
    c.S.forEach((col, s) => col.forEach((v, k) => assert.ok(Math.abs(r.S[s][k] - v) < 1e-12 * top, c.fs + ' Hz, segment ' + s + ', bin ' + k)));
  }
  // cadence rising steadily from 90 to 130 steps/min over 30 s
  const fs = 100, t = Float64Array.from({ length: 3000 }, (_, i) => i / fs);
  let ph = 0; const A = t.map(v => { ph += 2 * Math.PI * (1.5 + v / 45) / fs; return Math.sin(ph); });
  const r = C.rhythmOverTime(A, t, { specWin: 4 });
  assert.ok(r.t.length > 40);
  r.t.forEach((tc, k) => assert.ok(Math.abs(r.freq[k] - (1.5 + tc / 45)) < 0.06, 'at ' + tc + ' s: ' + r.freq[k]));
  // at 460 Hz it works on a decimated copy (about 20 Hz) and gives the same rhythm
  const t4 = Float64Array.from({ length: 13800 }, (_, i) => i / 460);
  let ph4 = 0; const A4 = t4.map(v => { ph4 += 2 * Math.PI * (1.5 + v / 45) / 460; return Math.sin(ph4) + 0.3 * Math.sin(2 * Math.PI * 60 * v); });
  const r4 = C.rhythmOverTime(A4, t4, { specWin: 4 });
  r4.t.forEach((tc, k) => assert.ok(Math.abs(r4.freq[k] - (1.5 + tc / 45)) < 0.06, '460 Hz, at ' + tc + ' s: ' + r4.freq[k]));
});

test('the spectrum finds the cadence of a known walk, and the stride rate of a one-leg walk', () => {
  for (const fsr of [57, 100, 460]) {
    const w = knownWalk({ fs: fsr, n: 40 });
    const sp = C.spectrum(w.A, w.t, { specSeg: 8 });
    const iv = w.rise.slice(1).map((v, k) => v - w.rise[k]), cadence = 60 / C.mean(iv);
    assert.ok(sp.peak.clear, fsr + ' Hz: clear peak');
    // resolution is about 60 / 8 s = 7.5 steps/min, but a steady walk lands much closer (0.4 here)
    assert.ok(Math.abs(sp.peak.freq * 60 - cadence) < 1, fsr + ' Hz: ' + sp.peak.freq * 60 + ' vs ' + cadence + ' steps/min');
  }
  // phone on one leg: each stride (1 Hz) has one big swing; the steps (2 Hz) are a weaker harmonic
  const t = Float64Array.from({ length: 2000 }, (_, i) => i / 100), A = t.map(v => Math.sin(2 * Math.PI * v) + 0.3 * Math.sin(4 * Math.PI * v + 1));
  const sp = C.spectrum(A, t, { specSeg: 8 });
  assert.ok(Math.abs(sp.peak.freq - 1) < 0.02, 'main peak at the stride rate, half the step rate');
  // standing still: no clear peak
  const still = t.map((v, i) => 0.01 * Math.sin(i * 12.9898) * 43758.5453 % 1);
  assert.equal(C.spectrum(still, t, { specSeg: 8 }).peak.clear, false);
});

test('filter gain is the response as applied, and matches what the filter does to a sine', () => {
  const fs = 100, t = Float64Array.from({ length: 4000 }, (_, i) => i / fs);
  const cases = [Object.assign({}, FP, { filter: 'butter' }), Object.assign({}, FP, { filter: 'cheby1' }), Object.assign({}, FP, { filter: 'ellip' }),
    { filter: 'notch', notchFreq: 10, notchQ: 5 }, { filter: 'movavg', maWindow: 0.1 }, { filter: 'savgol', sgWindow: 0.3, sgOrder: 3 }];
  for (const p of cases) for (const fr of [1, 2.5, 4, 8, 10]) {
    const g = C.filterGain(p, fs, [fr])[0];
    const y = C.FILTERS.find(f => f.id === p.filter).apply(t.map(v => Math.sin(2 * Math.PI * fr * v)), fs, p);
    let amp = 0; for (let i = 1000; i < 3000; i++) amp = Math.max(amp, Math.abs(y[i]));
    assert.ok(Math.abs(amp - g) < 0.01, p.filter + ' at ' + fr + ' Hz: gain ' + g + ', measured ' + amp);
  }
  assert.equal(C.filterGain({ filter: 'median', medWindow: 0.05 }, fs, [1]), null, 'not linear');
  assert.equal(C.filterGain({ filter: 'none' }, fs, [1]), null);
  assert.equal(C.filterGain(Object.assign({}, FP, { fLow: 80 }), fs, [1]), null, 'settings that cannot be used');
});

test('harmonic ratio: even over odd harmonics per stride, falling as the steps differ', () => {
  const fs = 100, T = 1.1, t = Float64Array.from({ length: 2200 }, (_, i) => i / fs);
  // exact case: 2nd harmonic of amplitude 1 and 1st of amplitude c gives even/odd = 1/c
  const c = 0.25, A = t.map(v => Math.cos(2 * Math.PI * 2 * v / T) + c * Math.cos(2 * Math.PI * v / T));
  const strides = Array.from({ length: 19 }, (_, k) => Math.round(k * T * fs)); // one detection per stride
  const r = C.harmonicRatio(A, t, strides, true);
  assert.equal(r.strides, 18); assert.ok(Math.abs(r.ratio - 1 / c) < 1e-3, 'ratio ' + r.ratio);
  // steps detected (two per stride): same strides from every other step
  const steps = Array.from({ length: 37 }, (_, k) => Math.round(k * T / 2 * fs));
  assert.ok(Math.abs(C.harmonicRatio(A, t, steps, false).ratio - 1 / c) < 1e-3);
  // a walk whose left and right steps differ more and more
  const walk = a => t.map(v => { const ph = (v % T) / T; return (ph < 0.5 ? 1 : a) * Math.sin(2 * Math.PI * 2 * ph) ** 2; });
  const hr = [1, 0.8, 0.5].map(a => C.harmonicRatio(walk(a), t, steps, false).ratio);
  assert.ok(hr[0] > 1e6, 'identical steps: no odd harmonics');
  assert.ok(hr[1] > hr[2] && hr[2] > 1, 'more asymmetry, lower ratio: ' + hr.slice(1));
  assert.ok(Number.isNaN(C.harmonicRatio(A, t, [0, 50], false).ratio), 'fewer than one stride');
});

/* ------------------------------------------------------- envelopes */
const ENV_P = { fs: 100, envWindow: 1, envPeakWindow: 0.3 };
const env = id => C.ENVELOPES.find(e => e.id === id);

test('sliding-window envelope is the running max and min over the window', () => {
  const t = Float64Array.from({ length: 400 }, (_, i) => i / 100), A = t.map(v => Math.sin(5 * v) * (1 + v) + ((v * 100) % 7) / 10);
  const { upper, lower } = env('sliding').compute(A, t, ENV_P);
  for (let i = 0; i < A.length; i++) {
    const w = A.slice(Math.max(0, i - 50), Math.min(A.length, i + 51));
    assert.equal(upper[i], Math.max(...w)); assert.equal(lower[i], Math.min(...w));
  }
});

test('dynamic-threshold envelope is (max + min) / 2, the same threshold Peak-to-valley counts with', () => {
  const w = knownWalk({ fs: 460 });
  const d = env('dynamic').compute(w.A, w.t, Object.assign({}, ENV_P, { fs: 460 }));
  for (let i = 0; i < w.A.length; i += 13) assert.equal(d.mid[i], (d.upper[i] + d.lower[i]) / 2);
  // fed the signal Peak-to-valley smooths internally, it draws exactly that algorithm's threshold
  const pv = C.detectPeakToValley(w.A, w.t, 460, { window: 1, minSwing: 0.4, minInterval: 0.25 });
  assert.deepEqual(env('dynamic').compute(pv.smooth, w.t, Object.assign({}, ENV_P, { fs: 460 })).mid, pv.threshold);
});

test('mean ± k·SD envelope: moving mean and population SD, shortened at the ends, exact with a gravity offset', () => {
  const t = Float64Array.from({ length: 600 }, (_, i) => i / 100);
  const wiggle = t.map(v => Math.sin(7 * v) * 0.02 + ((v * 100) % 3) / 1000);
  const A = wiggle.map(v => 9.81 + v);
  const e = env('meansd').compute(A, t, Object.assign({}, ENV_P, { envK: 0.5 }));
  for (let i = 0; i < A.length; i += 7) {
    const w = Array.from(wiggle.slice(Math.max(0, i - 50), Math.min(A.length, i + 51))), m = w.reduce((a, b) => a + b) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length); // brute force on the offset-free values
    assert.ok(Math.abs(e.mid[i] - (9.81 + m)) < 1e-12, 'mean at ' + i);
    assert.ok(Math.abs((e.upper[i] - e.mid[i]) - 0.5 * sd) < 1e-12 && Math.abs((e.mid[i] - e.lower[i]) - 0.5 * sd) < 1e-12, 'k·SD at ' + i);
  }
  assert.equal(env('meansd').midName, 'Moving mean');
});

test('percentile band: q-th and (100 − q)-th percentile with linear interpolation, shortened at the ends', () => {
  const t = Float64Array.from({ length: 400 }, (_, i) => i / 100);
  const A = t.map((v, i) => Math.sin(5 * v) + (i % 37 === 0 ? 4 : 0)); // spikes
  const pct = (arr, q) => { const s = arr.slice().sort((a, b) => a - b), r = q / 100 * (s.length - 1), k = Math.floor(r); return k + 1 < s.length ? s[k] + (r - k) * (s[k + 1] - s[k]) : s[k]; };
  const e = env('percentile').compute(A, t, Object.assign({}, ENV_P, { envPct: 10 }));
  for (let i = 0; i < A.length; i++) {
    const w = Array.from(A.slice(Math.max(0, i - 50), Math.min(A.length, i + 51)));
    assert.ok(Math.abs(e.lower[i] - pct(w, 10)) < 1e-12 && Math.abs(e.upper[i] - pct(w, 90)) < 1e-12, 'at ' + i);
  }
  const slide = env('sliding').compute(A, t, ENV_P);
  assert.ok(Math.max(...e.upper) < 1.5 && Math.max(...slide.upper) > 4, 'spikes stretch the max/min band, not the percentile band');
});

test('smooth peak-trough joins match scipy PchipInterpolator and never overshoot', () => {
  const { pchip } = JSON.parse(fs.readFileSync(path.join(FIX, 'envelopes.json'), 'utf8'));
  for (const c of pchip) {
    const v = C.pchip(Float64Array.from(c.x), Float64Array.from(c.y), Float64Array.from(c.at));
    c.at.forEach((x, k) => assert.ok(Math.abs(v[k] - c.value[k]) < 1e-12, c.x.length + ' points, at ' + x));
    // between two points the curve stays within their values
    c.at.forEach((x, k) => { const j = c.x.findIndex((xx, q) => q + 1 < c.x.length && xx <= x && x <= c.x[q + 1]);
      assert.ok(v[k] >= Math.min(c.y[j], c.y[j + 1]) - 1e-12 && v[k] <= Math.max(c.y[j], c.y[j + 1]) + 1e-12); });
  }
  const t = Float64Array.from({ length: 1000 }, (_, i) => i / 100), A = t.map(v => (1 + v / 5) * Math.sin(2 * Math.PI * v));
  const sm = env('peaktrough').compute(A, t, Object.assign({}, ENV_P, { envSmooth: true }));
  const peaks = C.localExtrema(A, C.halfWindow(0.3, 100), true);
  for (const i of peaks) assert.ok(Math.abs(sm.upper[i] - A[i]) < 1e-12, 'passes through each peak');
  assert.equal(env('peaktrough').label({ envSmooth: true }), 'Envelope, peak-trough (smooth)');
});

test('peak-trough envelope joins peaks and troughs by straight lines', () => {
  const t = Float64Array.from({ length: 1000 }, (_, i) => i / 100);
  const amp = v => 1 + v / 5, A = t.map(v => amp(v) * Math.sin(2 * Math.PI * v));
  A[226] = A[225]; // a tied peak (rounded data): one point, not two
  const { upper, lower } = env('peaktrough').compute(A, t, ENV_P);
  const peaks = C.localExtrema(A, C.halfWindow(0.3, 100), true);
  assert.equal(peaks.length, 10); assert.equal(peaks[2], 225, 'the tie counts once, at its first sample');
  for (const i of peaks) assert.equal(upper[i], A[i]);
  for (let i = peaks[0]; i < peaks[9]; i += 17) assert.ok(Math.abs(upper[i] - amp(t[i])) < 0.02 && Math.abs(lower[i] + amp(t[i])) < 0.15);
  assert.equal(upper[0], upper[peaks[0]], 'held flat before the first peak');
  const flat = env('peaktrough').compute(new Float64Array(50), t.slice(0, 50), ENV_P);
  assert.equal(flat.upper, null, 'no peaks, no line');
});

/* ------------------------------------------- gravity direction (#35) */
// A known walk's vertical bounce plus forward sway, seen by a phone that tilts and turns
// slowly (as in a pocket): x, y, z = R(t)ᵀ · (forward, 0, g + bounce).
function tiltedWalk({ fs = 100, g = 9.81, noise = 0.05 } = {}) {
  const w = knownWalk({ fs, noise: 0, rest: 3 });
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const n = w.A.length, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = w.t[i], walking = w.A[i] !== 0;
    const f = walking ? 0.8 * Math.sin(2 * Math.PI * t / 0.5 + 0.7) : 0, up = g + w.A[i];
    const tilt = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.05 * t), yaw = 0.3 * t; // radians
    // world (f, 0, up) -> phone: undo yaw about vertical, then tilt about the phone's x axis
    const fx = Math.cos(yaw) * f, fy = -Math.sin(yaw) * f;
    x[i] = fx + noise * rnd();
    y[i] = Math.cos(tilt) * fy + Math.sin(tilt) * up + noise * rnd();
    z[i] = -Math.sin(tilt) * fy + Math.cos(tilt) * up + noise * rnd();
  }
  const ds = C.buildDataset(['time', 'x', 'y', 'z'], [w.t, x, y, z], 'csv');
  return { ds, bounce: w.A, w };
}

test('vertical acceleration recovers the bounce whatever the tilt, and finds the same steps', () => {
  const { ds, bounce, w } = tiltedWalk();
  const v = C.prepareChannel(ds, 'vertical');
  assert.equal(v.fatal, false);
  assert.match(v.checks[0].title, /Vertical acceleration from the direction of gravity/);
  assert.match(v.checks[0].detail, /\(9\.8\d on average\)/);
  let err = 0;
  for (let i = 200; i < v.A.length - 200; i++) err = Math.max(err, Math.abs(v.A[i] - bounce[i]));
  assert.ok(err < 0.25, 'vertical within 0.25 of the true bounce (amplitude 2): ' + err);
  const p = Object.assign({ fs: 100 }, ALGO_P);
  for (const a of FIXED_ALGOS) {
    const want = a.detect(bounce, w.t, p).idx.map(i => w.t[i]), got = a.detect(v.A, v.t, p).idx.map(i => v.t[i]);
    assert.equal(got.length, want.length, a.id);
    got.forEach((tt, k) => assert.ok(Math.abs(tt - want[k]) < 0.03, a.id + ' step ' + k));
  }
  // the tilt mixes the bounce into y and z, so a single axis is not the bounce
  const yIdx = ds.columns.findIndex(c => c.role === 'y');
  const yA = C.prepareChannel(ds, yIdx).A;
  assert.ok(Math.max(...Array.from(yA, (val, i) => Math.abs(val - C.mean(yA) - bounce[i]))) > 1, 'one axis alone is off');
  const h = C.prepareChannel(ds, 'horizontal');
  assert.ok(C.mean(Array.from(h.A.slice(500, 1500))) > 0.3 && C.mean(Array.from(h.A.slice(0, 200))) < 0.2, 'horizontal carries the forward sway');
});

test('vertical acceleration needs gravity, and says why when it is missing', () => {
  const linacc = C.gravitySplit(loadCsvDataset(path.join(FIX, 'ptb_linacc_semicolon.csv')).ds);
  assert.equal(linacc.ok, false); assert.match(linacc.reason, /gravity was removed in this recording \(Linear accelerometer\)/);
  assert.equal(C.gravitySplit(loadCsvDataset(path.join(FIX, 'ptb_gforce.csv')).ds).ok, true, 'G-Force keeps gravity');
  const walk = C.gravitySplit(loadMatDataset(path.join(FIX, 'walk.mat')).ds);
  assert.equal(walk.ok, false, 'no sensor name: measured'); assert.match(walk.reason, /no steady gravity/);
  assert.equal(C.gravitySplit(tiltedWalk().ds).ok, true, 'measured: steady 9.81 vector');
  assert.equal(C.gravitySplit(tiltedWalk({ g: 0 }).ds).ok, false, 'measured: nothing steady');
  const gyro = C.gravitySplit(C.buildDataset(['time', 'wx', 'wy', 'wz'], [Float64Array.from({ length: 50 }, (_, i) => i / 50), ...[1, 2, 3].map(k => Float64Array.from({ length: 50 }, (_, i) => Math.sin(i / k)))], 'csv'));
  assert.match(gyro.reason, /not acceleration/);
  const r = C.prepareChannel(loadMatDataset(path.join(FIX, 'walk.mat')).ds, 'vertical');
  assert.equal(r.fatal, true); assert.match(r.checks[0].fix, /G-Force Meter/);
});

test('Coza is LabStepDet_2025.m\'s rule exactly: same steps for any w and h, tied peaks kept', () => {
  const coza = C.ALGORITHMS.find(a => a.id === 'coza_original');
  assert.equal(C.ALGORITHMS[0], coza, 'listed first'); assert.equal(coza.name, 'Coza');
  assert.equal(C.ALGORITHMS.find(a => a.id === 'coza').name, 'Coza (modified)');
  const { ds } = loadMatDataset(path.join(FIX, 'walk.mat'));
  for (const col of [1, 2, 3]) {
    const ch = C.prepareChannel(ds, col);
    for (const [w, h] of [[30, 1], [10, 0.5], [80, 2], [1, -1]]) {
      const fx = coza.detect(ch.A, ch.t, { w, h, fs: ch.fs });
      assert.deepEqual(fx.idx, C.detectOriginal(ch.A, w, h), 'column ' + (col + 1) + ', w ' + w + ', h ' + h);
      assert.deepEqual(fx.weakDropped, []);
    }
  }
  const ch = C.prepareChannel(ds, 1), idx = coza.detect(ch.A, ch.t, { w: 30, h: 1 }).idx;
  assert.ok(C.originalMetrics(idx, 30).tiedPairs > 0, 'the tied duplicate is still there');
});
test('Coza window is in seconds, so it finds the same steps at 100 Hz and 460 Hz', () => {
  const d = C.demoWalk(), t = d.cols[0], x = d.cols[1];
  const t4 = Float64Array.from({ length: Math.floor((t[t.length - 1] - t[0]) * 460) }, (_, i) => t[0] + i / 460);
  const x4 = t4.map(v => { let k = 1; while (t[k] < v) k++; const f = (v - t[k - 1]) / (t[k] - t[k - 1]); return x[k - 1] + f * (x[k] - x[k - 1]); });
  const coza = C.ALGORITHMS.find(a => a.id === 'coza');
  const p = { h: 1, w: 30, cozaWindow: 0.3, weak: true };
  const r1 = coza.detect(x, t, Object.assign({}, p, { fs: 100 }));
  const r4 = coza.detect(x4, t4, Object.assign({}, p, { fs: 460 }));
  assert.equal(r1.w, 30); assert.equal(r4.w, 138);
  assert.equal(r4.idx.length, r1.idx.length);
  r1.idx.forEach((i, k) => assert.ok(Math.abs(t4[r4.idx[k]] - t[i]) < 0.02, 'step ' + k + ' at the same time'));
  assert.equal(C.windowSamples(0.3, 100, 20), 8, 'clamped to the signal length');
});

test('timing metrics use timestamps and report cadence', () => {
  const t = Float64Array.from({ length: 1000 }, (_, i) => i * 0.02); // 50 Hz
  const idx = [0, 25, 50, 75, 100]; // every 0.5 s
  const m = C.timingMetrics(idx, t, { stride: false });
  assert.ok(close(m.stepInterval, 0.5)); assert.ok(close(m.cadence, 120));
  const s = C.timingMetrics(idx, t, { stride: true });
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

/* ------------------------------------------------- MAT v7.3 (HDF5) */
const hdf5 = require('jsfive');
const v73 = f => C.parseMat73(readU8(path.join(FIX, f)), hdf5);

test('MATLAB v7.3: the same walk as the v5 file, column for column and step for step', () => {
  assert.equal(C.isMat73(readU8(path.join(FIX, 'walk_v73.mat'))), true);
  assert.equal(C.isMat73(readU8(path.join(FIX, 'walk.mat'))), false);
  const r = v73('walk_v73.mat');
  assert.match(r.header, /^MATLAB 7\.3 MAT-file/);
  const { cands } = C.matCandidates(r.variables);
  assert.deepEqual(cands.map(c => [c.path, c.dims.join('×'), c.ok]), [['Walking', '1800×5', true]]);
  const a = C.matToColumns(cands[0]).cols, b = C.matToColumns(C.matCandidates(C.parseMat(readU8(path.join(FIX, 'walk.mat')), inflate).variables).cands[0]).cols;
  a.forEach((col, k) => assert.deepEqual(Array.from(col), Array.from(b[k]), 'column ' + (k + 1)));
  const ds = C.buildDataset(a.map((_, k) => 'Column ' + (k + 1)), a, 'mat');
  const ref = loadMatDataset(path.join(FIX, 'walk.mat')).ds;
  for (const col of [1, 2, 3]) assert.deepEqual(C.detectOriginal(C.prepareChannel(ds, col).A, 30, 1), C.detectOriginal(C.prepareChannel(ref, col).A, 30, 1));
});

test('MATLAB v7.3: small arrays in compact storage, structs, and a clear note for what is not data', () => {
  const r = v73('walk_v73_mixed.mat');
  const { cands, notes } = C.matCandidates(r.variables);
  const got = Object.fromEntries(cands.map(c => [c.path, c.ok ? c.dims.join('×') : c.reason]));
  assert.deepEqual(got, { A: '25×5', flags: 'contains true/false values, not measurements', nothing: 'is empty', 'rec.acc': '1800×3', 'rec.fs': 'is too small (1×1)', z: 'contains complex numbers' });
  assert.deepEqual(notes.map(n => n.reason), ['"labels" is a cell array, which is not searched.']);
  // A is the first 25 rows of the walk, read from compact storage (jsfive alone can't)
  const walk = C.matToColumns(C.matCandidates(C.parseMat(readU8(path.join(FIX, 'walk.mat')), inflate).variables).cands[0]).cols;
  C.matToColumns(cands.find(c => c.path === 'A')).cols.forEach((col, k) => assert.deepEqual(Array.from(col), Array.from(walk[k].slice(0, 25))));
  assert.deepEqual(Array.from(cands.find(c => c.path === 'rec.acc').var.data.slice(0, 3)), Array.from(walk[1].slice(0, 3), v => Math.trunc(v * 100)), 'int16 struct field');
});

test('MATLAB v7.3: says what to do when the reader is missing or the file is damaged', () => {
  const u8 = readU8(path.join(FIX, 'walk_v73.mat'));
  assert.throws(() => C.parseMat73(u8, undefined), e => e instanceof C.InputError && /did not load/.test(e.message) && /-v7/.test(e.fix));
  assert.throws(() => C.parseMat73(u8.slice(0, 600), hdf5), e => e instanceof C.InputError && /could not be read/.test(e.message) && /-v7/.test(e.fix));
  assert.throws(() => C.parseMat73(u8.slice(0, 512), hdf5), e => e instanceof C.InputError && /no HDF5 data/.test(e.message), 'header only');
  assert.throws(() => C.parseMat73(readU8(path.join(FIX, 'bad_v73.mat')), hdf5), e => e instanceof C.InputError && /could not be read \(File uses non-64-bit addressing\)/.test(e.message));
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
test('tab-separated export with decimal commas', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [i / 100, Math.sin(i / 5) + 0.25, -1.5, 2].map(v => String(v).replace('.', ',')).join('\t'));
  const p = C.parseCsv('time\tax\tay\taz\n' + rows.join('\n'));
  assert.equal(p.delim, '\t'); assert.equal(p.decimalComma, true);
  assert.deepEqual(p.names, ['time', 'ax', 'ay', 'az']);
  assert.equal(p.cols[0][3], 0.03); assert.equal(p.cols[1][0], 0.25); assert.equal(p.cols[2][7], -1.5);
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
test('phyphox export with gravity: quoted headers, scientific notation, m/s²', () => {
  const { p, ds } = loadCsvDataset(path.join(FIX, 'phyphox_accel.csv'));
  assert.equal(p.delim, ','); assert.equal(p.hasHeader, true);
  assert.equal(ds.t[0], 0);
  assert.equal(ds.x.name, 'Acceleration x (m/s^2)'); assert.equal(ds.z.name, 'Acceleration z (m/s^2)');
  assert.equal(ds.mag.name, 'Absolute acceleration (m/s^2)');
  assert.equal(ds.x.label, 'x (Acceleration x)'); assert.equal(ds.mag.label, 'magnitude (Absolute acceleration)');
  const units = ds.checks.find(c => c.title === 'Units: m/s²');
  assert.match(units.detail, /^Accelerometer data .*Includes gravity.*9\.8 m\/s²/);
  assert.equal(ds.mag.sensor.key, 'acc', 'the magnitude takes its sensor from x');
  assert.equal(C.gravitySplit(ds).ok, true);
  const ref = loadMatDataset(path.join(FIX, 'walk.mat')).ds;
  assert.deepEqual(C.detectOriginal(C.prepareChannel(ds, 1).A, 30, 1), C.detectOriginal(C.prepareChannel(ref, 1).A, 30, 1));
});
test('phyphox export without gravity: tab-separated, decimal commas', () => {
  const { p, ds } = loadCsvDataset(path.join(FIX, 'phyphox_linear_tab.csv'));
  assert.equal(p.delim, '\t'); assert.equal(p.decimalComma, true);
  assert.equal(ds.x.name, 'Linear Acceleration x (m/s^2)'); assert.equal(ds.mag.name, 'Absolute acceleration (m/s^2)');
  assert.equal(ds.mag.sensor.key, 'linacc');
  assert.match(ds.checks.find(c => c.title === 'Units: m/s²').detail, /Gravity is removed/);
  assert.equal(C.gravitySplit(ds).ok, false);
  const ref = loadMatDataset(path.join(FIX, 'walk.mat')).ds;
  for (const k of [1, 2, 3]) assert.deepEqual(C.prepareChannel(ds, k).A, C.prepareChannel(ref, k).A);
});
test('phyphox metadata files on their own say which file to upload instead', () => {
  assert.throws(() => loadCsvDataset(path.join(FIX, 'phyphox_time.csv')),
    e => /meta\/time\.csv/.test(e.message) && /Raw Data\.csv/.test(e.fix));
  assert.throws(() => C.parseCsv('"property","value"\n"version","1.2.1"\n"deviceModel","Pixel 9a"\n'),
    e => /meta\/device\.csv/.test(e.message) && /Raw Data\.csv/.test(e.fix));
});
test('phyphox zip: Raw Data.csv and the details in meta/', () => {
  const z = C.readPhyphoxZip(readU8(path.join(FIX, 'phyphox.zip')), u8 => pako.inflateRaw(u8));
  assert.equal(z.name, 'Raw Data.csv');
  assert.equal(z.text, fs.readFileSync(path.join(FIX, 'phyphox_accel.csv'), 'utf8'));
  assert.deepEqual(z.checks[0], { level: 'pass', title: 'phyphox export read', detail: '"Raw Data.csv" from the zip; recorded on Google Pixel 9a with phyphox 1.2.1, ' +
    'sensor: Test Accelerometer (Test Vendor), started 2026-09-21 07:13:20.000 UTC-07:00, 18.0 s of recording.' });
  assert.equal(z.checks[1].level, 'warn'); assert.equal(z.checks[1].title, 'Recording paused 1 time');
  assert.match(z.checks[1].detail, /joined with no gap at 9\.0 s\./);
  assert.deepEqual(C.parseZip(readU8(path.join(FIX, 'phyphox.zip'))).map(e => [e.name, e.size]),
    [['Raw Data.csv', z.text.length], ['meta/device.csv', 273], ['meta/time.csv', 351]]);
});
test('zip errors say what is wrong and how to fix it', () => {
  const zip = readU8(path.join(FIX, 'phyphox.zip')), inflateRaw = u8 => pako.inflateRaw(u8);
  const fails = (u8, msg, fix) => assert.throws(() => C.readPhyphoxZip(u8, inflateRaw), e => e instanceof C.InputError && msg.test(e.message) && fix.test(e.fix));
  fails(zip.slice(0, zip.length - 30), /incomplete or damaged/, /unzip it/);
  const scrambled = zip.slice(); scrambled.fill(7, 200, 900);
  fails(scrambled, /incomplete or damaged/, /unzip it/);
  fails(readU8(path.join(FIX, 'bad_phyphox_excel.zip')), /Excel export/, /CSV \(comma, decimal point\)/);
  assert.throws(() => C.readPhyphoxZip(zip), /decompressor did not load/);
  assert.equal(C.isZip(zip), true); assert.equal(C.isZip(readU8(path.join(FIX, 'walk.mat'))), false);
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

/* ------------------------------------------------------ resampling (#52) */
const RS = require('./fixtures/resample.json');
const chanOf = (t, a) => ({ t: Float64Array.from(t), A: Float64Array.from(a), fs: 1 / C.median(Array.from(t).slice(1).map((v, i) => v - t[i]).filter(d => d > 0)) });
test('resampling matches the Python port: linear bit for bit, pchip and anti-aliased within 1e-12', () => {
  for (const c of RS.cases) {
    const r = C.resampleChannel(chanOf(c.t, c.a), { mode: 'rate', rate: c.fs, method: c.method, antialias: c.antialias });
    const name = c.fs_in + ' → ' + c.fs + ' Hz, ' + c.method + (c.antialias ? ', anti-aliased' : '');
    assert.equal(r.applied, true, name); assert.equal(r.A.length, c.out.length, name);
    if (c.method === 'linear' && !c.antialias) assert.deepEqual(Array.from(r.A), c.out, name);
    else for (let i = 0; i < c.out.length; i++) assert.ok(close(r.A[i], c.out[i], 1e-12), name + ' at ' + i);
    assert.ok(r.checks.some(k => k.title === '3 repeated timestamps averaged'), name);
    assert.ok(Math.abs(r.t[1] - r.t[0] - 1 / c.fs) < 1e-12 && r.t[0] === c.t[0], 'grid starts at the first sample');
  }
});
test('Coza on a resampled CSV export: same samples and steps as the Python port', () => {
  const { ds } = loadCsvDataset(path.join(FIX, 'ptb_gforce.csv'));
  for (const c of RS.lab) {
    const r = C.resampleChannel(C.prepareChannel(ds, 1), { mode: 'rate', rate: c.fs, method: 'linear' });
    assert.deepEqual(Array.from(r.A), c.x, c.fs + ' Hz');
    assert.deepEqual(C.detectOriginal(r.A, 30, 0.2).map(i => i + 1), c.steps_x_matlab, c.fs + ' Hz');
    assert.equal(r.checks.some(k => k.id === 'cozaRate'), c.fs !== 100, 'the 100 Hz check is on what Coza receives');
  }
});
test('anti-aliasing removes a tone above the new Nyquist frequency; without it the tone folds back', () => {
  const fs = 460, n = 460 * 8, t = Float64Array.from({ length: n }, (_, i) => i / fs);
  const A = Float64Array.from(t, v => Math.sin(2 * Math.PI * 1.8 * v) + 0.5 * Math.sin(2 * Math.PI * 70 * v));
  const amp = (r, f) => { // amplitude of frequency f, away from the ends
    let re = 0, im = 0, m = 0;
    for (let i = 50; i < r.A.length - 50; i++) { re += r.A[i] * Math.cos(2 * Math.PI * f * r.t[i]); im += r.A[i] * Math.sin(2 * Math.PI * f * r.t[i]); m++; }
    return 2 * Math.hypot(re, im) / m;
  };
  const plain = C.resampleChannel({ t, A, fs }, { mode: 'rate', rate: 100, method: 'linear' });
  const aa = C.resampleChannel({ t, A, fs }, { mode: 'rate', rate: 100, method: 'linear', antialias: true });
  assert.ok(amp(plain, 30) > 0.3, '70 Hz shows up at 100 − 70 = 30 Hz');
  assert.ok(amp(aa, 30) < 0.005, 'and is gone after the low-pass');
  assert.ok(Math.abs(amp(aa, 1.8) - 1) < 0.02, 'the walking rhythm passes (the window holds 14.04 cycles, so a little leaks)');
  assert.ok(plain.checks.some(k => k.title === 'No anti-aliasing' && /folds back/.test(k.detail) && /Anti-aliasing/.test(k.fix)));
  assert.match(aa.checks[0].detail, /Low-passed at 40\.0 Hz first/);
});
test('resampling: even timing, upsampling, gaps and settings that cannot be used', () => {
  const t = Float64Array.from({ length: 600 }, (_, i) => i / 57 + (i % 3) * 0.004 + (i >= 300 ? 2 : 0)), A = Float64Array.from(t, v => Math.sin(v));
  const ch = { t, A, fs: 57 };
  const even = C.resampleChannel(ch, { mode: 'even', method: 'linear' });
  assert.equal(even.fs, 57); assert.match(even.checks[0].title, /^Resampled to 57\.0 Hz/);
  assert.ok(even.checks.some(k => k.title === 'Resampling fills 1 gap' && /2\.0\d s/.test(k.detail)));
  assert.ok(C.resampleChannel(ch, { mode: 'rate', rate: 100 }).checks.some(k => k.title === 'Upsampling adds no information'));
  for (const [rate, why] of [['', /No rate is set/], [5e5, /more than the page can handle/], [1, /only \d+ samples/]]) {
    const r = C.resampleChannel(ch, { mode: 'rate', rate, method: 'linear' });
    assert.equal(r.applied, false); assert.match(r.checks[0].detail, why); assert.ok(r.checks[0].fix);
  }
});
test('interpLinear is numpy.interp: ends held, exact at the samples', () => {
  assert.deepEqual(Array.from(C.interpLinear([0, 1, 3], [10, 20, 0], [-1, 0, 0.5, 1, 2, 3, 4])), [10, 10, 15, 20, 10, 0, 0]);
});

/* ------------------------------------------------- browser recording (#51) */
// devicemotion-like samples: ~60 Hz with uneven timing, gravity on y, a 0.9 Hz walk
function synthRecording(seconds = 20, opts = {}) {
  const out = []; let ts = 12345.678, k = 0;
  while ((ts - 12345.678) / 1000 < seconds) {
    const t = (ts - 12345.678) / 1000, walk = t > 2 && t < seconds - 2 ? 1 : 0;
    const a = [walk * 3 * Math.sin(2 * Math.PI * 0.9 * t), walk * 9 * Math.max(0, Math.sin(2 * Math.PI * 0.9 * t)) ** 3, walk * Math.cos(2 * Math.PI * 1.8 * t)];
    out.push({ ts, g: [a[0], a[1] + 9.81, a[2]], a: opts.noLinear ? null : a, r: opts.noRotation || (opts.someRotation && k % 2) ? null : [10 * a[2], 20 * a[0], 5 * a[1]] });
    ts += 1000 / 60 * (1 + 0.3 * Math.sin(k++ * 1.7));
  }
  return out;
}
test('a browser recording becomes CSV text that reads back to the same numbers', () => {
  const rec = synthRecording();
  const csv = C.recordingCsv(rec, { recorder: 'gaitscope (browser devicemotion)', steps_counted: 20, phone_position: 'front pocket', device: 'line\nbreak', empty: '' });
  const fixtureHead = fs.readFileSync(path.join(FIX, 'recorder.csv'), 'utf8').split('\n').find(l => !l.startsWith('#'));
  assert.equal(csv.split('\n').find(l => !l.startsWith('#')), fixtureHead, 'the layout the Python fixture (and so load_csv) is tested on');
  const p = C.parseCsv(csv);
  assert.deepEqual(p.meta, { recorder: 'gaitscope (browser devicemotion)', steps_counted: '20', phone_position: 'front pocket', device: 'line break' });
  assert.equal(p.cols[0].length, rec.length);
  rec.forEach((s, i) => {
    assert.equal(p.cols[0][i], (s.ts - rec[0].ts) / 1000, 'time: seconds from the first event, as captured');
    assert.equal(p.cols[1][i], s.g[0] / C.STANDARD_GRAVITY);
    assert.equal(p.cols[5][i], s.a[0]);
    assert.equal(p.cols[9][i], s.r[0] * (Math.PI / 180), 'wx from alpha (rotation about x, §6.3.2)');
    assert.equal(p.cols[10][i], s.r[1] * (Math.PI / 180), 'wy from beta (about y)');
    assert.equal(p.cols[11][i], s.r[2] * (Math.PI / 180), 'wz from gamma (about z)');
  });
  const ds = C.buildDataset(p.names, p.cols, 'csv');
  assert.equal(ds.x.name, 'gFx (g)'); assert.equal(ds.mag.name, 'TgF (g)');
  assert.ok(ds.checks.some(c => c.title === 'Units: g'));
  assert.equal(C.gravitySplit(ds).ok, true, 'vertical and horizontal work on the g columns');
  // the same steps and metrics as the same samples handed over directly
  const t = Float64Array.from(rec, s => (s.ts - rec[0].ts) / 1000), gy = Float64Array.from(rec, s => s.g[1] / C.STANDARD_GRAVITY);
  const direct = C.prepareChannel(C.buildDataset(['time', 'gFy'], [t, gy], 'csv'), 1), viaCsv = C.prepareChannel(ds, 2);
  assert.deepEqual(viaCsv.A, direct.A);
  assert.equal(viaCsv.fs, direct.fs);
  const p0 = { h: 1.2, weak: true, cozaWindow: 0.3, fs: viaCsv.fs }, coza = C.ALGORITHMS.find(a => a.id === 'coza');
  const a1 = coza.detect(viaCsv.A, viaCsv.t, p0).idx, a2 = coza.detect(direct.A, direct.t, p0).idx;
  assert.deepEqual(a1, a2); assert.ok(a1.length >= 12, 'the walk is found');
  assert.deepEqual(C.timingMetrics(a1, viaCsv.t, {}), C.timingMetrics(a2, direct.t, {}));
  assert.ok(viaCsv.fs > 55 && viaCsv.fs < 65);
});
test('a recording without linear acceleration or with gaps in rotation still reads', () => {
  const p = C.parseCsv(C.recordingCsv(synthRecording(5, { noLinear: true, someRotation: true }), {}));
  assert.deepEqual(p.names, ['time', 'gFx (g)', 'gFy (g)', 'gFz (g)', 'TgF (g)', 'wx (rad/s)', 'wy (rad/s)', 'wz (rad/s)']);
  assert.ok(Number.isNaN(p.cols[5][1]) && Number.isFinite(p.cols[5][0]), 'blank cells where a rotation rate was missing');
  assert.deepEqual(C.parseCsv(C.recordingCsv(synthRecording(5, { noLinear: true, noRotation: true }), {})).names, ['time', 'gFx (g)', 'gFy (g)', 'gFz (g)', 'TgF (g)']);
});
test('recording checks: too short, stopped by the screen locking, time limit', () => {
  const short = C.recordingChecks(synthRecording(2), 'user');
  assert.equal(short.ok, false); assert.match(short.checks[0].detail, /samples over 2\.0 s/); assert.match(short.checks[0].fix, /at least 10 s/);
  assert.match(C.recordingChecks([], 'hidden').checks[0].detail, /Only 0 samples were captured\. It stopped because the screen locked/);
  const hidden = C.recordingChecks(synthRecording(8), 'hidden');
  assert.equal(hidden.ok, true); assert.equal(hidden.checks[0].title, 'Recording stopped early'); assert.ok(hidden.checks[0].fix);
  assert.deepEqual(C.recordingChecks(synthRecording(8), 'user'), { ok: true, checks: [] });
});
test('CSV metadata lines are kept: Physics Toolbox and the recorder', () => {
  assert.deepEqual(loadCsvDataset(path.join(FIX, 'ptb_metadata_units.csv')).p.meta['Requested Sample Rate'], '50 Hz');
  const { p, ds } = loadCsvDataset(path.join(FIX, 'recorder.csv'));
  assert.equal(p.meta.steps_counted, '12'); assert.equal(p.meta.phone_position, 'hand');
  assert.equal(ds.x.name, 'gFx (g)');
});

/* ---------------------------------------------------------------- export (#53) */
// walk.mat column 2 through Coza and Coza (modified), as the dashboard would export it
function walkExport(extra = {}) {
  const { ds } = loadMatDataset(path.join(FIX, 'walk.mat'));
  const ch = C.prepareChannel(ds, 1);
  const run = type => { const def = C.ALGORITHMS.find(a => a.id === type); return def.detect(ch.A, ch.t, Object.assign({ fs: ch.fs }, C.defaultParams(def))); };
  const o = run('coza_original'), m = run('coza');
  const dets = [
    { id: 'coza', type: 'coza_original', idx: o.idx, weak: [], metrics: C.timingMetrics(o.idx, ch.t, {}), hr: { ratio: 2.25, strides: 6 }, script: C.originalMetrics(o.idx, 30) },
    { id: 'coza_modified', type: 'coza', idx: m.idx, weak: m.weakDropped, metrics: C.timingMetrics(m.idx, ch.t, {}), hr: { ratio: 2.5, strides: 6 }, script: null },
  ];
  return { ch, dets, model: C.buildExport(Object.assign({
    about: { file: 'walk.mat', variable: 'Walking', signal: 'x (column 2)', signal_name: 'Column 2', unit: '' },
    settings: { filter: 'none', filter_resampled: false, note: 'naïve "quote", ✓ 😀' }, params: { filter: 'none', phone_position: 'hand' },
    spectrum: { dominant_hz: 0.9, cadence_steps_min: 54.5, segment_s: 8 },
    t: ch.t, A: ch.A, filtered: Float64Array.from(ch.A, v => v / 2),
    indicators: [
      { id: 'coza', kind: 'detector', type: 'coza_original', name: 'Coza', source: 'recorded', color: 'c1', params: { w: 30, h: 1 }, settings: {} },
      { id: 'coza_modified', kind: 'detector', type: 'coza', name: 'Coza (modified)', source: 'filtered', color: 'c2', params: { h: 1, cozaWindow: 0.3, weak: true }, settings: { coza_window_samples: 30 } },
      { id: 'sliding', kind: 'envelope', type: 'sliding', name: 'Sliding window', source: 'filtered', color: 'c3', params: { envWindow: 1 } }],
    detectors: dets, envelopes: [{ id: 'sliding', lower: Float64Array.from(ch.A, v => v - 1), upper: Float64Array.from(ch.A, v => v + 1) }],
    stride: false, parts: { signals: true, envelope: true }, notes: [{ t: 3.25, text: 'turned "around", ✓' }],
  }, extra)) };
}
// equal numbers (0 and -0 alike: JSON and CSV write -0 as 0), NaN matching NaN
const sameNum = (a, b) => a.length === b.length && Array.from(a).every((v, i) => v === b[i] || (Number.isNaN(v) && Number.isNaN(b[i])));
// a minimal .npy reader for the tests: {descr, shape, values}
function readNpy(u8) {
  const hlen = u8[8] | (u8[9] << 8), header = String.fromCharCode(...u8.subarray(10, 10 + hlen));
  assert.equal((10 + hlen) % 64, 0, 'data starts on a 64-byte boundary'); assert.ok(header.endsWith('\n'));
  const descr = /'descr': '([^']+)'/.exec(header)[1], shape = /'shape': \(([^)]*)\)/.exec(header)[1].split(',').filter(Boolean).map(Number);
  const n = shape.length ? shape[0] : 1, buf = u8.slice(10 + hlen).buffer;
  let values;
  if (descr === '<f8') values = Array.from(new Float64Array(buf));
  else if (descr === '|b1') values = Array.from(new Uint8Array(buf), v => v === 1);
  else { const w = Number(descr.slice(2)), u = new Uint32Array(buf); values = Array.from({ length: n }, (_, i) => String.fromCodePoint(...Array.from(u.subarray(i * w, i * w + w)).filter(c => c))); }
  return { descr, shape, values };
}
test('export model: the parts, 1-based samples, a step column and a metrics column per detector', () => {
  const { ch, dets, model } = walkExport();
  assert.deepEqual(Object.keys(model), ['about', 'settings', 'params', 'spectrum', 'indicators', 'signals', 'steps', 'metrics', 'notes']);
  assert.equal(model.about.format, 'gaitscope-export'); assert.equal(model.about.format_version, 3); assert.equal(model.about.version, C.VERSION);
  assert.deepEqual(model.indicators.id, ['coza', 'coza_modified', 'sliding']);
  assert.deepEqual(JSON.parse(model.indicators.params[1]), { h: 1, cozaWindow: 0.3, weak: true }); assert.deepEqual(JSON.parse(model.indicators.settings[1]), { coza_window_samples: 30 });
  assert.deepEqual(Object.keys(model.signals), ['time_s', 'signal', 'filtered', 'sliding_lower', 'sliding_upper']);
  const s = model.steps;
  assert.deepEqual(Object.keys(s), ['time_s', 'sample_matlab', 'value', 'coza', 'coza_modified']);
  s.sample_matlab.forEach((k, j) => { assert.equal(s.time_s[j], ch.t[k - 1]); assert.equal(s.value[j], ch.A[k - 1]); });
  for (const d of dets) assert.deepEqual(s.sample_matlab.filter((_, j) => s[d.id][j] === 'step'), d.idx.map(i => i + 1), d.id);
  assert.deepEqual(s.coza.filter(v => v === 'step').length, C.detectOriginal(ch.A, 30, 1).length);
  assert.ok(s.coza_modified.includes(''), 'the tied duplicate: a step for Coza only');
  const row = name => model.metrics.metric.indexOf(name);
  assert.deepEqual(model.metrics.metric.slice(0, 4), ['steps', 'peaks', 'step_interval', 'cadence']);
  assert.equal(model.metrics.coza[row('steps')], dets[0].idx.length); assert.equal(model.metrics.coza_modified[row('steps')], dets[1].idx.length);
  assert.equal(model.metrics.coza[row('coza_pace')], dets[0].script.pace, 'Coza\'s own formulas');
  assert.ok(Number.isNaN(model.metrics.coza_modified[row('coza_pace')]), 'only for Coza');
  assert.equal(model.metrics.coza_modified[row('harmonic_ratio')], 2.5);
  assert.equal(walkExport({ parts: { signals: true, envelope: false } }).model.signals.sliding_lower, undefined, 'envelopes only when asked');
  assert.equal(walkExport({ parts: { signals: false } }).model.signals, undefined, 'signals can be left out');
});
test('stepTable and indicatorIds', () => {
  const st = C.stepTable([{ id: 'a', idx: [3, 10], weak: [] }, { id: 'b', idx: [10, 20], weak: [5] }]);
  assert.deepEqual(st.rows, [3, 5, 10, 20]);
  assert.deepEqual(st.status, { a: ['step', '', 'step', ''], b: ['', 'weak peak', 'step', 'step'] });
  assert.deepEqual(C.indicatorIds([{ type: 'coza_original' }, { type: 'coza' }, { type: 'threshold' }, { type: 'threshold' }, { type: 'coza_original' }]),
    ['coza', 'coza_modified', 'threshold', 'threshold_2', 'coza_2']);
});
test('JSON export reads back exactly, NaN included', () => {
  const { model } = walkExport();
  const back = C.parseExportJson(C.exportJson(model));
  for (const k of ['indicators', 'signals', 'steps', 'metrics', 'notes']) for (const c of Object.keys(model[k])) {
    const a = model[k][c], b = back[k][c];
    assert.ok(typeof a[0] === 'number' ? sameNum(a, b) : JSON.stringify(Array.from(a)) === JSON.stringify(Array.from(b)), k + '.' + c);
  }
  assert.ok(Number.isNaN(back.metrics.coza_modified[model.metrics.metric.indexOf('coza_pace')]), 'NaN, null in JSON, NaN again');
  assert.deepEqual(back.settings, model.settings); assert.deepEqual(back.params, model.params); assert.deepEqual(back.spectrum, model.spectrum);
  assert.throws(() => C.parseExportJson('{"a": 1}'), e => /not a GaitScope export/.test(e.message) && !!e.fix);
  assert.throws(() => C.parseExportJson('{"about": {"format": "gaitscope-export", "format_version": 99}}'), /format version 99, newer/);
  assert.throws(() => C.parseExportJson('{oops'), /could not be read/);
  assert.throws(() => C.parseExportJson(C.exportJson(walkExport({ parts: { signals: false } }).model)), e => /no signals/.test(e.message) && /Signals ticked/.test(e.fix));
});
test('MAT export reads back in the page\'s own MAT reader with the same numbers', () => {
  const { model } = walkExport();
  const parsed = C.parseMat(C.exportMat(model));
  assert.deepEqual(parsed.variables.map(v => v.name), ['gaitscope']);
  const g = parsed.variables[0].fields;
  assert.deepEqual(Object.keys(g), Object.keys(model));
  for (const [k, c] of [['signals', 'signal'], ['signals', 'sliding_upper'], ['steps', 'sample_matlab'], ['metrics', 'coza'], ['metrics', 'coza_modified'], ['notes', 'time_s']]) {
    assert.deepEqual(g[k].fields[c].dims, [model[k][c].length, 1], k + '.' + c + ' is a column');
    assert.ok(sameNum(g[k].fields[c].data, model[k][c]), k + '.' + c);
  }
  assert.equal(g.steps.fields.coza.cls, 'cell'); assert.equal(g.indicators.fields.params.cls, 'cell');
  assert.equal(g.settings.fields.filter_resampled.logical, true);
  assert.equal(g.about.fields.format_version.data[0], 3);
});
test('MAT export: struct field-name lengths are small data elements, as MATLAB writes them', () => {
  const mat = C.exportMat(walkExport().model), hex = Buffer.from(mat).toString('hex');
  assert.ok(hex.includes('0500040020000000'), 'miINT32, 4 bytes, value 32, in one 8-byte element');
  assert.ok(!hex.includes('050000000400000020000000'), 'not a full tag plus padding, which Octave misreads');
});
// Octave reads the file as a MATLAB user would; skipped when octave-cli isn't installed (CI)
const octave = (() => { try { require('child_process').execFileSync('octave-cli', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
test('MAT export loads in GNU Octave with the same numbers and text', { skip: !octave && 'octave-cli not installed' }, () => {
  const { model } = walkExport();
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaitscope-octave-'));
  try {
    fs.writeFileSync(path.join(dir, 'x.mat'), C.exportMat(model));
    const out = require('child_process').execFileSync('octave-cli', ['-q', '--eval', [
      'load x.mat; g = gaitscope;',
      "printf('%s\\n', strjoin(fieldnames(g)', ','));",
      "printf('%s %s %s\\n', class(g.signals.signal), class(g.settings.filter_resampled), class(g.steps.coza_modified));",
      "printf('%.17g\\n', g.signals.signal);", "printf('STATUS %s\\n', g.steps.coza_modified{:});",
      "printf('NOTE %s\\n', g.notes.text{1});", "printf('SET %s\\n', g.settings.note);",
    ].join(' ')], { cwd: dir, encoding: 'utf8' }).split('\n');
    assert.equal(out[0], Object.keys(model).join(','));
    assert.equal(out[1], 'double logical cell');
    const sig = out.slice(2, 2 + model.signals.signal.length).map(Number);
    assert.ok(sameNum(sig, model.signals.signal), 'every sample, to 17 digits');
    assert.deepEqual(out.filter(l => l.startsWith('STATUS')).map(l => l.slice(7)), model.steps.coza_modified);
    assert.equal(out.find(l => l.startsWith('NOTE ')), 'NOTE turned "around", ✓');
    assert.equal(out.find(l => l.startsWith('SET ')), 'SET naïve "quote", ✓ \uFFFD', 'beyond U+FFFF becomes U+FFFD');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('NPZ export: a zip of .npy arrays, numbers, true/false and text', () => {
  const { model } = walkExport();
  const entries = C.parseZip(C.exportNpz(model));
  const names = entries.map(e => e.name);
  assert.deepEqual(names.slice(0, 5), ['about.npy', 'settings.npy', 'params.npy', 'spectrum.npy', 'indicators/id.npy']);
  const get = n => readNpy(entries.find(e => e.name === n + '.npy').read());
  assert.ok(sameNum(get('signals/signal').values, model.signals.signal));
  const st = get('steps/coza_modified'); assert.match(st.descr, /^<U\d+$/); assert.deepEqual(st.values, model.steps.coza_modified);
  const settings = get('settings'); assert.deepEqual(settings.shape, []);
  assert.deepEqual(JSON.parse(settings.values[0]), model.settings, 'text beyond U+FFFF too');
  assert.deepEqual(get('notes/text').values, ['turned "around", ✓']);
});
test('CSV zip: one file per part, and the CSV reader reads it back', () => {
  const { model } = walkExport();
  const entries = C.parseZip(C.exportCsvZip(model));
  assert.deepEqual(entries.map(e => e.name), ['about.csv', 'settings.csv', 'params.csv', 'spectrum.csv', 'indicators.csv', 'signals.csv', 'steps.csv', 'metrics.csv', 'notes.csv']);
  const text = n => new TextDecoder().decode(entries.find(e => e.name === n).read());
  const sig = C.parseCsv(text('signals.csv'));
  assert.deepEqual(sig.names, Object.keys(model.signals));
  assert.ok(sameNum(sig.cols[1], model.signals.signal), 'full precision');
  assert.match(text('steps.csv'), /^time_s,sample_matlab,value,coza,coza_modified\n[\d.]+,\d+,[-\d.]+,step,(step|weak peak)?\n/);
  assert.match(text('notes.csv'), /^time_s,plot,kind,x,y,text\n3\.25,signal,time,3\.25,,"turned ""around"", ✓"\n$/);
  assert.match(text('settings.csv'), /^key,value\nfilter,none\nfilter_resampled,false\n/);
});
test('zip writer: CRC-32 and a central directory other tools accept', () => {
  assert.equal(C.crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'the standard check value');
  const z = C.zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/ü.txt', data: new Uint8Array(0) }]);
  const e = C.parseZip(z);
  assert.deepEqual(e.map(x => [x.name, x.size]), [['a.txt', 5], ['dir/ü.txt', 0]]);
  assert.equal(new TextDecoder().decode(e[0].read()), 'hello');
});
test('the Python port\'s export and the dashboard\'s agree on Coza (walk.mat, column 2)', () => {
  const py = C.parseExportJson(fs.readFileSync(path.join(FIX, 'export_python.json'), 'utf8'));
  const { model } = walkExport();
  assert.equal(py.about.generator, 'gaitscope python port'); assert.equal(py.about.version, model.about.version);
  assert.equal(py.about.format_version, model.about.format_version);
  assert.deepEqual(py.indicators.type, ['coza_original']); assert.deepEqual(JSON.parse(py.indicators.params[0]), { w: 30, h: 1 });
  assert.deepEqual(py.indicators.credit, [model.indicators.credit[model.indicators.type.indexOf('coza_original')]], 'the same credit for Coza');
  assert.ok(sameNum(py.signals.time_s, model.signals.time_s) && sameNum(py.signals.signal, model.signals.signal), 'same time base and signal');
  const rows = model.steps.coza.map((v, j) => (v === 'step' ? j : -1)).filter(j => j >= 0);
  for (const c of ['time_s', 'sample_matlab', 'value']) assert.ok(sameNum(py.steps[c], rows.map(j => model.steps[c][j])), 'steps.' + c);
  assert.deepEqual(py.metrics.metric, model.metrics.metric); assert.deepEqual(py.metrics.unit, model.metrics.unit);
  py.metrics.coza.forEach((v, k) => {
    const name = py.metrics.metric[k], w = model.metrics.coza[k];
    if (name === 'harmonic_ratio') return assert.ok(Number.isNaN(v), 'not in the Python port');
    assert.ok(Number.isNaN(v) ? Number.isNaN(w) : close(v, w, 1e-12), name);
  });
});
// #63: every method says who made it, as "Surname et al., Year" with a DOI link, names only
test('every detector, envelope and filter has a credit, with well-formed DOIs and no emails', () => {
  const all = [...C.ALGORITHMS, ...C.ENVELOPES, ...C.FILTERS];
  for (const d of all) {
    assert.ok(Array.isArray(d.credit), d.id + ' declares its credit (an empty list when none is needed)');
    for (const c of d.credit) {
      assert.ok(typeof c.text === 'string' && c.text.length > 2, d.id + ': text');
      if (c.doi) assert.match(c.doi, /^10\.\d{4,9}\/\S+$/, d.id + ': DOI');
      if (c.url) assert.match(c.url, /^https:\/\/\S+$/, d.id + ': URL');
      assert.ok(!(c.doi && c.url), d.id + ': a DOI or a URL, not both');
    }
    assert.ok(!/@/.test(JSON.stringify(d.credit)), d.id + ': no email addresses');
  }
  const credit = id => C.creditText(all.find(d => d.id === id).credit);
  assert.equal(credit('coza_original'), 'Dr. Aurel Coza (BME 598/494; LabStepDet_2025.m)', 'the course code and instructor (#78)');
  assert.match(credit('coza'), /modified by Dr\. Soroush Dianaty \(tied peaks counted once/);
  assert.equal(credit('savgol'), 'Savitzky & Golay, 1964 https://doi.org/10.1021/ac60214a047');
  assert.equal(credit('sliding'), '');
  assert.ok(C.FILTERS.filter(f => f.iir).every(f => /Likhterov & Kopeika, 2003/.test(C.creditText(f.credit))), 'zero-phase filtering');
});
test('docs/algorithm.md lists every DOI and URL the page credits', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'algorithm.md'), 'utf8');
  for (const d of [...C.ALGORITHMS, ...C.ENVELOPES, ...C.FILTERS, ...C.TRANSFORMS])
    for (const c of d.credit) for (const ref of [c.doi, c.url].filter(Boolean)) assert.ok(doc.includes(ref), d.id + ': ' + ref + ' is in docs/algorithm.md');
});
test('the export\'s indicators table credits each indicator', () => {
  const { model } = walkExport();
  assert.deepEqual(model.indicators.credit, ['coza_original', 'coza', 'sliding'].map(id => C.creditText([...C.ALGORITHMS, ...C.ENVELOPES].find(d => d.id === id).credit)));
  assert.match(model.indicators.credit[0], /^Dr\. Aurel Coza/);
  assert.equal(model.indicators.credit[2], '', 'the sliding window needs none');
});
// #80: notes at a time, a level or a point, on the signal or the spectrum (format 3)
test('notes of every kind go through a JSON export and back; format 2 notes reopen as times', () => {
  const notes = [{ plot: 'signal', kind: 'time', x: 3.25, text: 'turned' }, { plot: 'signal', kind: 'level', y: 2.5, text: 'resting' },
    { plot: 'signal', kind: 'point', x: 6.32, y: 9.81, text: 'a double count' }, { plot: 'spectrum', kind: 'time', x: 0.91, text: 'walking rhythm' },
    { plot: 'spectrum', kind: 'level', y: 12, text: 'noise floor' }, { plot: 'spectrum', kind: 'point', x: 1.82, y: 30.5, text: 'harmonic' }];
  const { model } = walkExport({ notes });
  assert.deepEqual(Array.from(model.notes.time_s, v => (Number.isNaN(v) ? null : v)), [3.25, null, 6.32, null, null, null], 'time_s only for times on the signal');
  const back = C.exportNotes(C.parseExportJson(C.exportJson(model)));
  assert.deepEqual(back, notes.map(C.noteOf));
  assert.ok(Number.isNaN(back[0].y) && Number.isNaN(back[1].x), 'what a kind doesn\'t use is NaN');
  // a format 2 export: time_s and text only
  const old = JSON.parse(C.exportJson(model)); old.about.format_version = 2; old.notes = { time_s: [1.5], text: ['old note'] };
  assert.deepEqual(C.exportNotes(C.parseExportJson(JSON.stringify(old))), [C.noteOf({ plot: 'signal', kind: 'time', x: 1.5, text: 'old note' })]);
  // the MAT and zip exports carry the new columns
  assert.deepEqual(Object.keys(C.parseMat(C.exportMat(model)).variables[0].fields.notes.fields), ['time_s', 'plot', 'kind', 'x', 'y', 'text']);
});

test('VERSION matches package.json', () => {
  assert.equal(C.VERSION, require('../package.json').version);
});

test('unit inference from a quiet stretch', () => {
  const { ds } = loadMatDataset(path.join(FIX, 'walk.mat'));
  assert.ok(ds.checks.some(c => c.title === 'Units: gravity removed'));
});

test('the sampling rate comes from the typical gaps: rounded times and dropped samples', () => {
  // a 57.4 Hz clock read in whole milliseconds, like Firefox on Android: gaps of 17 and 18 ms
  const ms = n => Float64Array.from({ length: n }, (_, k) => Math.round(k * 1000 / 57.4) / 1000);
  const t = ms(1200), A = Float64Array.from(t, v => Math.sin(2 * Math.PI * 1.6 * v));
  const ds = C.buildDataset(['time', 'gFz (g)'], [t, A], 'csv');
  const ch = C.prepareChannel(ds, 1);
  assert.ok(Math.abs(ch.fs - 57.4) < 0.01, String(ch.fs)); // the median gap (17 ms) would say 58.8
  assert.ok(Math.abs(C.datasetRate(ds) - 57.4) < 0.01);
  assert.ok(ch.checks.some(c => c.title === 'Sampling rate about 57.4 Hz'));
  // every 7th sample dropped and one 2 s pause: the rate stays the clock's, not the average
  const keep = [...t].filter((_, k) => k % 7 !== 3).map(v => (v > 10 ? v + 2 : v));
  const ds2 = C.buildDataset(['time', 'gFz (g)'], [Float64Array.from(keep), Float64Array.from(keep, v => Math.sin(v))], 'csv');
  assert.ok(Math.abs(C.prepareChannel(ds2, 1).fs - 57.4) < 0.05);
});

test('steps from the rhythm, without detecting steps (#98): still, walking, still; and a change of pace', () => {
  let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  // walking between `from` and `to` s, the rhythm given by freq(t); 1 cycle = 1 step
  const walk = (dur, from, to, freq) => {
    const fs = 60, n = Math.round(dur * fs), t = new Float64Array(n), A = new Float64Array(n);
    let ph = 0, cycles = 0;
    for (let i = 0; i < n; i++) {
      t[i] = i / fs + 0.002 * rnd();
      const on = t[i] >= from && t[i] < to;
      if (on) { ph += 2 * Math.PI * freq(t[i]) / fs; }
      A[i] = 1 + (on ? 0.25 * Math.sin(ph) + 0.08 * Math.sin(2 * ph + 0.5) : 0) + 0.01 * rnd();
      cycles = ph / (2 * Math.PI);
    }
    return { t, A, cycles };
  };
  const a = walk(40, 4, 34, () => 1.7); // 51 steps
  const ea = C.spectralSteps(a.A, a.t, { specWin: 4 });
  assert.ok(Math.abs(ea.steps - a.cycles) < 1, ea.steps + ' vs ' + a.cycles);
  assert.ok(Math.abs(ea.start - 4) < 0.5 && Math.abs(ea.end - 34) < 0.5, ea.start + '–' + ea.end);
  const b = walk(40, 4, 34, t => (t < 19 ? 1.5 : 2.0)); // 22.5 + 30 = 52.5 steps
  const eb = C.spectralSteps(b.A, b.t, { specWin: 4 });
  assert.ok(Math.abs(eb.steps - b.cycles) < 1.5, eb.steps + ' vs ' + b.cycles);
  // one average rate would say 1.75 Hz × 30 s; adding up the windows follows the pace instead
  const noise = walk(20, 99, 99, () => 1); // no walking at all
  assert.equal(C.spectralSteps(noise.A, noise.t, { specWin: 4 }), null);
});

test('the spectrogram picture (#98): a PNG that decodes back to its pixels, the bright row at the rhythm', () => {
  const zlib = require('zlib');
  // PNG: signature, IHDR, IDAT (zlib, stored blocks) and IEND, every CRC right; pixels round-trip
  const w = 300, h = 120, rgba = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 37 + (i >> 9)) & 255); // over one 65535-byte block
  const png = C.pngBytes(w, h, rgba), b = Buffer.from(png);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = []; let o = 8;
  while (o < b.length) { const n = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8); chunks.push({ type, data: b.subarray(o + 8, o + 8 + n) }); assert.equal(b.readUInt32BE(o + 8 + n), C.crc32(png.subarray(o + 4, o + 8 + n)), type + ' CRC'); o += 12 + n; }
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual([chunks[0].data.readUInt32BE(0), chunks[0].data.readUInt32BE(4), ...chunks[0].data.subarray(8)], [w, h, 8, 6, 0, 0, 0]);
  const raw = zlib.inflateSync(chunks[1].data); // checks the Adler-32 too
  for (let y = 0; y < h; y++) { assert.equal(raw[y * (w * 4 + 1)], 0, 'filter byte'); assert.deepEqual(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4))); }
  assert.equal(C.base64(png), b.toString('base64'));
  for (const n of [0, 1, 2, 3, 4]) assert.equal(C.base64(Uint8Array.from({ length: n }, (_, i) => 250 + i)), Buffer.from(Uint8Array.from({ length: n }, (_, i) => 250 + i)).toString('base64'));

  // a 1.6 Hz walk for 20 s: in every column the most opaque row holds 1.6 Hz
  const fs = 60, t = Float64Array.from({ length: 20 * fs }, (_, i) => i / fs), A = t.map(v => 1 + 0.3 * Math.sin(2 * Math.PI * 1.6 * v) + 0.05 * Math.sin(2 * Math.PI * 3.2 * v));
  const r = C.rhythmOverTime(A, t, { specWin: 4 }), im = C.spectrogramImage(r, [10, 20, 30]);
  assert.equal(im.height, 100); assert.equal(im.width, r.S.length); assert.equal(im.fMax, 5);
  assert.ok(Math.abs(im.x0 - (r.t[0] - r.hop / 2)) < 1e-9 && Math.abs(im.x1 - (r.t.at(-1) + r.hop / 2)) < 1e-9);
  for (let c = 0; c < im.width; c++) {
    let best = 0, row = -1;
    for (let y = 0; y < im.height; y++) { const a = im.rgba[(y * im.width + c) * 4 + 3]; if (a > best) { best = a; row = y; } }
    const f = (im.height - 1 - row + 0.5) * 0.05;
    assert.ok(Math.abs(f - 1.6) <= 0.05 && best === 255, c + ': ' + f + ' Hz, alpha ' + best);
    assert.deepEqual([...im.rgba.subarray((row * im.width + c) * 4, (row * im.width + c) * 4 + 3)], [10, 20, 30]);
  }
  // long recordings: at most maxCols columns, neighbours averaged
  const many = C.spectrogramImage(r, [0, 0, 0], { maxCols: 10 });
  assert.ok(many.width <= 10 && Math.abs(many.x0 - im.x0) < 1e-9);
  assert.equal(C.spectrogramImage({ t: new Float64Array(0), S: [], f: new Float64Array(0), hop: 0.5 }, [0, 0, 0]), null);
});

test('Frequency domain methods (#101): one registry, both kinds, each explained and credited', () => {
  for (const kind of ['whole', 'time']) assert.ok(C.TRANSFORMS.some(d => d.kind === kind), kind);
  assert.deepEqual(C.TRANSFORMS.map(d => d.id).slice(0, 2), ['welch', 'stft'], 'the defaults first');
  for (const d of C.TRANSFORMS) {
    assert.ok(d.name && d.tagline.length > 40 && Array.isArray(d.params) && Array.isArray(d.credit), d.id);
    assert.equal(new Set(C.TRANSFORMS.map(x => x.id)).size, C.TRANSFORMS.length);
  }
  // the defaults reuse what the page already computed, and agree with computing afresh
  const fs = 60, t = Float64Array.from({ length: 30 * fs }, (_, i) => i / fs), A = t.map(v => 1 + 0.3 * Math.sin(2 * Math.PI * 1.6 * v));
  const spec = C.spectrum(A, t, { specSeg: 8 }), rhythm = C.rhythmOverTime(A, t, { specWin: 4 });
  const welch = C.TRANSFORMS.find(d => d.id === 'welch'), stft = C.TRANSFORMS.find(d => d.id === 'stft');
  assert.equal(welch.compute(A, t, {}, { spec }), spec);
  assert.ok(Math.abs(welch.compute(A, t, { specSeg: 8 }).peak.freq - 1.6) < 0.02);
  const v = stft.compute(A, t, { specWin: 4 }, { rhythm });
  assert.equal(v.grid.P.length, rhythm.S.length); assert.equal(v.line.f, rhythm.freq);
  assert.deepEqual(C.gridImage(v.grid, [1, 2, 3]), C.spectrogramImage(rhythm, [1, 2, 3]));
});
