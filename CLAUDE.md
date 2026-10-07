# CLAUDE.md

Context for Claude Code sessions on this repository.

## What this is

A class project for *Wearable Devices for Sport, Health, and Wellness* (ASU, Fall 2026,
instructor Aurel). Lab 1 provides a MATLAB step-detection script
(`LabStepDet_2025.m`) and a sample recording (`Walking.mat`). The instructor allows
students to skip MATLAB and use an AI tool to run the code instead. This repo holds:

1. `python/lab_step_det.py`: a faithful Python port of the MATLAB script.
2. A static browser dashboard (`index.html` + `src/`) that validates an uploaded
   `.mat` or Physics Toolbox `.csv` file, runs the lab algorithm, and compares it with
   a corrected version. Features: interactive sliders, filter and algorithm dropdowns, envelopes, notes pinned to the plot,
   CSV export.

The owner does not know MATLAB and works in Python. Explain MATLAB-specific
behaviour when it matters.

## Hard rules

- **Never commit or push to `main`.** Every change goes new branch → atomic commits →
  PR → Rebase and merge, as described in `CONTRIBUTING.md`. Each commit must pass both
  test suites on its own.
- **The "original" algorithm must stay bit-exact with MATLAB.** This covers
  `detect_steps`/`gait_metrics` in Python and `detectOriginal`/`originalMetrics` in
  JS. That includes its quirks: 1-based indices in the output, loop bounds
  `w+1 … length-w`, `/100` for seconds, the `Pace = duration*60` formula, and
  N−1 `std`. Improvements go into our own algorithms, never into the original. Each
  one is an entry in `ALGORITHMS` in `src/core.js`; the first is **Coza** (`detectCoza`),
  the lab detector with its bugs fixed. All of them share `timingMetrics`.
- **`src/core.js` has no DOM access.** It is shared by the browser and by the
  Node tests (UMD-style export at the bottom).
- **Never commit course files.** `data/` is git-ignored except its README. Test
  fixtures are synthetic (`scripts/make_fixtures.py`).
- **The dashboard stays a static page** (GitHub Pages) with no build step. The only
  external scripts are pako (inflating compressed MAT files) and plotly.js-basic, both
  pinned on jsDelivr.
- **Every validation message says what went wrong and how to fix it.** See
  `docs/schema.md`; update that document when checks change.

- **Python dependencies are managed with uv only.** They live in `pyproject.toml` and
  are locked in `uv.lock`; the environment is the git-ignored `.venv/` (`uv sync`).
  Add packages with `uv add <pkg>` (or `uv add --dev`) and commit both files. Never
  `pip install` into the system Python or a venv outside the repo. Minimum Python: 3.12.

## Commands

```bash
npm install && npm test          # Node tests: core + jsdom UI (tests/*.test.js)
uv sync                          # .venv from pyproject.toml + uv.lock; never the system Python
uv run pytest                    # Python port tests
uv run python scripts/make_fixtures.py  # regenerate fixtures + expected.json after port changes
bash scripts/octave_parity.sh    # needs data/LabStepDet_2025.m, data/Walking.mat, octave-cli
python3 -m http.server 8000      # serve the dashboard locally
```

Run both test suites before committing. The Walking.mat parity tests are skipped
unless the course file is present in `data/`.

## Verified so far

- The Python port, the JS port and Octave running the original `.m` agree exactly on
  `Walking.mat`, columns 2, 3 and 4. Results: 15 / 12 / 21 steps; column 2 gives
  AverageStepDuration 0.954286, Pace 57.257, VariabilitySteps 42.395,
  GaitAsymmetry 1.234114.
- The MAT reader handles MATLAB and Octave v5/v6/v7, compressed and uncompressed
  files, structs, int16, and transposed matrices. It rejects v4 and v7.3 (HDF5) with
  re-save instructions.
- The dashboard was rendered in headless Chromium in light, dark and mobile layouts.
  Two traps with headless screenshots: the window can't be narrower than 500 px (a
  "390 px" shot is a cropped 500 px layout; render the page in a 390 px iframe instead),
  and it reports no hover, so Plotly's hover-only toolbar shows permanently.
- Real Physics Toolbox exports from the owner's phone (2026-09-23, G-Force Meter at
  ~460 Hz and Linear Accelerometer at ~57 Hz) load correctly. Newer exports start with
  `# key: value` metadata lines and put units in headers (`ax (m/s^2)`); both are handled.
  At 460 Hz the lab code (`w = 30` samples = ±65 ms, TgF rounded to 0.01) finds 193
  "steps" in 6.6 s, so it only makes sense near 100 Hz.
- Free Physics Toolbox can't set the sample rate (a Pro feature), so phone recordings
  come in at ~460 Hz. `lab_step_det.py --resample 100` interpolates to 100 Hz before
  the lab code (MATLAB `interp1`); Coza's window is in seconds, so it needs no resampling.
- phyphox exports (zip with `Raw Data.csv` + `meta/`) are not supported yet: issue #15.
- Threshold peaks, Peak-to-valley and Zero-crossing (#11) all find the same 12 steps
  as Coza on `Walking.mat` column 2. They disagree on the other channels and on the phone
  recordings, which have no known step count (table in `docs/algorithm.md`).
  `lowpass` matches scipy's `filtfilt(butter(2, …))` to 1e-13.
- The signal filters (#12, #37) match scipy within 1e-9 (`tests/fixtures/filters.json`):
  Butterworth, Bessel, Chebyshev I and II and elliptic (`iirfilter` + `sosfiltfilt`,
  orders 2–6, at 57, 100 and 460 Hz), moving average and median (`scipy.ndimage`,
  `mode='nearest'`), Savitzky–Golay (`savgol_filter`, `mode='interp'`) and notch
  (`iirnotch`). scipy's own Savitzky–Golay weights lose precision on long, high-order
  windows (1.5e-10 at 231 samples, order 5), so that case is checked against exact rational
  weights instead. The lab code never sees the filtered signal.
- Vertical / horizontal acceleration (#35) works on the G-Force export (gravity 0.98 g,
  steady); `Walking.mat` and Linear Accelerometer files have gravity removed, so the
  options are disabled there. Vertical rests at 0, so `h` needs to be about 0.1 g.

## Findings about the lab code (see docs/algorithm.md)

- Tied peaks (values rounded to 0.01) are counted twice. `Walking.mat` column 2 has
  this at samples 471/472 and 1036/1037.
- The stop bump at about 15.6 s is counted as a step.
- The `Pace` comment says steps/min, but the formula gives duration × 60. Cadence would
  be 60 / duration.
- Clean peaks about 1.14 s apart suggest each peak is a stride (phone on one leg).
  This hasn't been confirmed with the instructor.

## Open items

- [ ] Ask the instructor: is a Python version acceptable for submissions? Is "Pace"
      intended? Are the peaks steps or strides?
- [ ] Record walks with a known step count (e.g. 20 steps counted by hand, phone in the
      hand and in a pocket) to rank the algorithms (#11, decision 4).
- [ ] #36: frequency domain (spectrum, cadence from the spectrum, spectrogram, Hilbert
      envelope, wavelet denoising, harmonic ratio). The spectrum would also settle
      steps vs. strides.
- [ ] #38: more envelopes (RMS / SD, mean ± k·SD, percentile, smooth peak-trough).
- [ ] Maybe: a median "despike" step before another filter (#37 kept one filter at a time).
- [ ] #15: phyphox exports.
- [x] GitHub Pages is enabled (main / root).
- [ ] Maybe: support MAT v7.3 via h5wasm (large WebAssembly download; probably not
      worth it), batch processing of several files, overlaying x/y/z channels.

## Code map

| File | Key parts |
|---|---|
| `src/core.js` | `parseMat` (MAT v5 reader), `matCandidates`, `matToColumns`, `parseCsv`, `buildDataset` (roles and units), `prepareChannel` (cleaning and sampling checks; also takes 'computed', 'vertical', 'horizontal'), `gravitySplit` (vertical/horizontal from x, y, z by gravity's direction, #35), `datasetRate`, `windowExtreme` (O(n) sliding max/min), `detectOriginal`, `originalMetrics`, `designFilter` (Butterworth / Bessel / Chebyshev I / II / elliptic as second-order sections, like scipy `iirfilter`; prototypes `besselPoles` (Aberth `polyRoots`), `ellipPrototype` (cephes-style `ellipj`, AGM `ellipK`, Carlson `carlsonRF`)), `sosfiltfilt` (zero-phase, like scipy), `lowpass` (algorithms' internal 2nd-order Butterworth), `dynamicThreshold`, `detectCoza`, `detectThresholdPeaks`, `detectPeakToValley`, `detectZeroCrossing`, `timingMetrics` (metrics for every algorithm), `WEAK_RATIO`, `windowSamples` (seconds → samples), `ALGORITHMS` (algorithm registry: tagline, summary, usesH, detect → idx/markY/guides, settings for the export), `FILTERS` (each entry: apply on even samples, label; settings rows under Advanced list it in `data-only`) + `applyFilter` (filter for the algorithm only; resamples uneven timing onto an even grid), `oddWindow` (seconds → odd samples), `movingAverage`, `movingMedian`, `savgol`, `notchSos`, `filterLabel`, `interpAt`, `ENVELOPES` (sliding, peak-trough, dynamic threshold; view only), `localExtrema`, `halfWindow`, `demoWalk` |
| `src/app.js` | state `S`, loading (`handleFile`, `loadMat`, `loadCsv`, `setDataset`, `selectChannel`), `COMPUTED` + `chanInfo()` (labels and units of computed signals), `recompute`, `derivedChecks`, `renderValidation`, `renderPlot` (traces: 0–1 envelope band, 2 recorded signal (faded when filtered), 3 filtered signal, 4 envelope midline, 5–6 algorithm guide lines, 7 lab markers, 8 algorithm markers, 9–10 interval strip; hidden traces use `visible: false` so indices stay fixed; notes are shapes + annotations), `showLab()` (checks with `lab: true` hide with it), `hUsed()` (h control and line only for the lab code or algorithms with `usesH`), options under Advanced (`#advSec input[data-param]` → `params()`, reset to their HTML `value`), `showFilter()`, `showEnv()` (envelopes are a view: they redraw the plot, never recompute steps), notes (`onPlotClick`, `addNote`, `renderNotes`), export |
| `python/lab_step_det.py` | `detect_steps`, `gait_metrics`, `load_csv` (Physics Toolbox CSV → Walking.mat layout), `sampling_rate`, `resample`, CLI |
