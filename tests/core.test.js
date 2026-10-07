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

test('moving average, median, Savitzky–Golay and notch match scipy, edges included', () => {
  const { other } = JSON.parse(fs.readFileSync(path.join(FIX, 'filters.json'), 'utf8'));
  assert.deepEqual([...new Set(other.map(c => c.filter))], ['movavg', 'median', 'savgol', 'notch']);
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
    for (const a of C.ALGORITHMS) {
      const want = a.detect(clean.A, clean.t, p).idx.map(i => clean.t[i]);
      const got = a.detect(f.A, clean.t, p).idx.map(i => clean.t[i]);
      assert.equal(got.length, want.length, filter + ', ' + a.id);
      got.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 0.03, filter + ', ' + a.id + ', step ' + k));
    }
  }
  assert.notEqual(C.detectOriginal(noisy, 30, 1).length, C.detectOriginal(clean.A, 30, 1).length, 'the noise does change the unfiltered lab code');
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

test('Welch spectrum matches scipy.signal.welch', () => {
  for (const c of SPEC.welch) {
    const x = Float64Array.from({ length: Math.round(c.fs * 10) }, (_, i) => { const t = i / c.fs; return 1 + Math.sin(2 * Math.PI * 1.8 * t) + 0.3 * Math.sin(2 * Math.PI * 17 * t + 0.4) + 0.1 * Math.sin(2 * Math.PI * 0.2 * t); });
    const r = C.welch(x, c.fs, { nperseg: c.nperseg, nfft: c.nfft });
    assert.equal(r.psd.length, c.psd.length);
    const top = Math.max(...c.psd);
    c.psd.forEach((v, k) => { assert.ok(Math.abs(r.psd[k] - v) < 1e-12 * top, c.fs + ' Hz, nfft ' + c.nfft + ', bin ' + k); assert.ok(Math.abs(r.f[k] - c.f[k]) < 1e-12); });
  }
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
  for (const a of C.ALGORITHMS) {
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
