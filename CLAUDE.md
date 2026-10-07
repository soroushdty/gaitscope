# CLAUDE.md

Context for Claude Code sessions on this repository.

## What this is

A class project for *Wearable Devices for Sport, Health, and Wellness* (ASU, Fall 2026,
instructor Aurel). Lab 1 provides a MATLAB step-detection script
(`LabStepDet_2025.m`) and a sample recording (`Walking.mat`). The instructor allows
students to skip MATLAB and use an AI tool to run the code instead. This repo holds:

1. `python/lab_step_det.py`: a faithful Python port of the MATLAB script.
2. A static browser dashboard (`index.html` + `src/`) that validates an uploaded
   `.mat`, Physics Toolbox `.csv` or phyphox `.zip` file (or records a walk on a phone), runs the lab algorithm, and compares it with
   a corrected version. Features: interactive sliders, filter and algorithm dropdowns, envelopes, notes pinned to the plot,
   export as CSV, zipped CSV, MATLAB .mat, NumPy .npz or JSON (which reopens an analysis).

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
- **The dashboard stays a static page** (GitHub Pages) with no build step. Its own scripts
  are `src/core.js`, `src/record.js` and `src/app.js`; `tests/ui.test.js` inlines all three. The only
  external scripts are pako (inflating compressed MAT files) and plotly.js-basic, loaded
  with the page, and jsfive (MATLAB v7.3 / HDF5, `HDF5_URL` in `src/app.js`), loaded only
  when a v7.3 file is opened. All three are pinned on jsDelivr.
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
sudo apt install --no-install-recommends octave   # dev only (~80 MB): parity script + Octave export test
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
  files, structs, int16, and transposed matrices. It rejects v4 with re-save
  instructions. MATLAB v7.3 (HDF5) is read through jsfive (#48), plus our patch for
  compact storage, which jsfive lacks and MATLAB uses for every small array. All 250
  numeric arrays in ten real MATLAB v7.3 files (from the GPL `mat7.3` project, not
  committed) match h5py.
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
- Resampling (#52), in the dashboard (Detection → Resample) and in Python
  (`--resample-method linear|pchip`, `--antialias`), gives the same samples in both ports
  (`tests/fixtures/resample.json`): linear is bit-exact, pchip within 4e-16, anti-aliased
  within 2e-13. A CSV resampled to 100 or 50 Hz gives the lab code the same steps in both.
  Anti-aliasing is off by default. Measured on the owner's 460 Hz recordings, under 0.05%
  of the power is above 50 Hz and no lab-code step count changed; the filter only moved
  one peak (table in `docs/algorithm.md`). Rendered in headless Chromium without errors.
- phyphox exports (#15): the zip (`Raw Data.csv` + `meta/device.csv` + `meta/time.csv`)
  is read in the browser by `parseZip` (central directory + pako `inflateRaw`, no new
  library) and in Python by `zipfile`. Checked on a real export (phyphox 1.2.1, Pixel 9a,
  "Acceleration with g", 17.3 s, ~460 Hz) in Node and in headless Chromium with the CDN
  pako. Headers `Acceleration x` (m/s², with gravity) and `Linear Acceleration x`
  (without); `Absolute acceleration` takes x's sensor. phyphox's experiment time leaves
  out pauses, so a paused recording is spliced with no gap; both ports warn with the join
  times. On the real export, `--col 4 --resample 100 --to-g` gives 25 steps about 0.67 s
  apart. The dashboard can resample (#52) but has no g conversion (only Python's `--to-g`).
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
- Envelopes (#13, #38) are views only; a UI test checks steps, metrics and exports stay
  identical for each. The smooth peak-trough joins match scipy's `PchipInterpolator`
  (`tests/fixtures/envelopes.json`). RMS, moving SD and mean ± k·SD from #38 are one
  envelope (mean ± k·SD; k = 1 is the RMS band).
- The frequency-domain features (#36) match numpy/scipy/PyWavelets within 1e-12
  (`tests/fixtures/spectral.json`, the `dwt` and wavelet cases in `filters.json`).
  PyWavelets is a dev dependency, used only by `make_fixtures.py`. On `Walking.mat` the
  spectrum agrees with Coza's cadence within 1/min. Column 2's strongest rhythm is
  52.7/min, the magnitude's twice that, which supports "column 2's peaks are strides".
- The browser recorder (#51) was driven in jsdom with dispatched `devicemotion` events and
  in headless Chromium at 390 px with emulated accelerometer, linear-acceleration and
  gyroscope sensors (CDP `Emulation.setSensorOverrideEnabled`): about 60 Hz, wake lock
  granted, the recording loads and its download reads back to the same numbers. Not yet
  run on a real phone.
- Exports (#53): one model (`docs/export.md`, `format_version` 1) written as JSON, MAT v5,
  NPZ and zipped CSV without new libraries (stored zip entries, uncompressed MAT: the page
  loads only pako's inflate). Each reads back with independent readers: parseMat, scipy
  `loadmat`, `np.load(allow_pickle=False)`, zipfile, csv. The Python port's `--export` of
  walk.mat column 2 matches the dashboard's model exactly, except the metrics, which agree
  to 1e-12 because numpy sums pairwise. A JSON export reopened in a fresh page gives the same
  steps, metrics, step table and notes (UI test). GNU Octave 11.1 (installed 2026-10-07)
  loads the `.mat` with the same numbers and text; that test runs when `octave-cli` exists
  and is skipped in CI. Octave has no `struct2table`, and its `jsondecode` can be 1 ulp off.
  The parity script still gives 15 / 12 / 21 identical steps under Octave 11.1.
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
      intended? Are the peaks steps or strides? (The spectrum now suggests strides; see
      `docs/algorithm.md`.)
- [ ] Record walks with a known step count (e.g. 20 steps counted by hand, phone in the
      hand and in a pocket) to rank the algorithms (#11, decision 4). The dashboard's
      recorder (#51) saves the count and position in the CSV and compares them.
- [ ] #51 on the owner's Pixel 9a: 20 counted steps in the hand and in a front pocket, next
      to a Physics Toolbox recording of the same walk. Check that the axes and signs match,
      note the rate, and lock the screen mid-recording.
- [ ] #51 on an iPhone (no device yet): the same checks, plus the permission prompt and
      whether Safari inverts the axis signs.
- [ ] Maybe: a median "despike" step before another filter (#37 kept one filter at a time).
- [x] GitHub Pages is enabled (main / root), with Enforce HTTPS on (2026-10-06), so
      http:// redirects to https://, which the recorder's motion sensors need.
- [ ] Maybe: batch processing of several files, overlaying x/y/z channels.
- [ ] Maybe: files with no time column still default to 100 Hz (`fsIn`); asking for the rate
      might be better (#52, "related").

## Code map

| File | Key parts |
|---|---|
| `src/core.js` | `parseMat` (MAT v5 reader), `isMat73` + `parseMat73` (v7.3 through jsfive, passed in) + `patchCompactStorage`, `matCandidates`, `matToColumns`, `parseCsv` (+ `phyphoxMetaFile`: rejects a lone phyphox meta file), `isZip` + `parseZip` + `readPhyphoxZip` (phyphox zip → data CSV text + metadata checks), `recordingCsv` + `recordingChecks` (#51: devicemotion samples → CSV in g / m/s² / rad/s with `# key: value` metadata; `parseCsv` returns those as `meta`), `buildDataset` (roles and units), `prepareChannel` (cleaning and sampling checks; also takes 'computed', 'vertical', 'horizontal'), `gravitySplit` (vertical/horizontal from x, y, z by gravity's direction, #35), `datasetRate`, `windowExtreme` (O(n) sliding max/min), `detectOriginal`, `originalMetrics`, `designFilter` (Butterworth / Bessel / Chebyshev I / II / elliptic as second-order sections, like scipy `iirfilter`; prototypes `besselPoles` (Aberth `polyRoots`), `ellipPrototype` (cephes-style `ellipj`, AGM `ellipK`, Carlson `carlsonRF`)), `sosfiltfilt` (zero-phase, like scipy), `lowpass` (algorithms' internal 2nd-order Butterworth), `labRateCheck` (the 100 Hz check, `id: 'labRate'`), `resampleChannel` (#52: even grid at a chosen or the median rate, `mergeRepeats`, optional Chebyshev I anti-aliasing `ANTIALIAS`) + `interpLinear` (numpy.interp operation for operation), `dynamicThreshold`, `detectCoza`, `detectThresholdPeaks`, `detectPeakToValley`, `detectZeroCrossing`, `timingMetrics` (metrics for every algorithm), `WEAK_RATIO`, `windowSamples` (seconds → samples), `ALGORITHMS` (algorithm registry: tagline, summary, usesH, detect → idx/markY/guides, settings for the export), `FILTERS` (each entry: apply on even samples, label; settings rows under Advanced list it in `data-only`) + `applyFilter` (filter for the algorithm only) / `filterEvenly` / `evenGrid` (uneven timing onto an even grid, shared with the FFT features), `oddWindow` (seconds → odd samples), `movingAverage`, `movingMedian`, `savgol`, `notchSos`, `dwt` / `idwt` / `waveletDenoise` (db4, like PyWavelets), `filterLabel`, `interpAt`, frequency domain (#36): `fft` / `ifft` (radix-2 or Bluestein, like numpy), `spectrogram` / `welch` (like scipy), `spectrum` + `dominantFrequency` (`GAIT_BAND` 0.5–3.5 Hz, clear at 5× the median), `rhythmOverTime`, `filterGain` (|H|² of the selected filter), `hilbert`, `harmonicRatio`, `ENVELOPES` (sliding, peak-trough with optional smooth joins, dynamic threshold, mean ± k·SD, percentile band; view only; `midName` labels a midline), `localExtrema`, `halfWindow`, `movingMeanSd`, `movingPercentiles`, `pchip` (monotone cubic, like scipy `PchipInterpolator`), `demoWalk` |
| export (#53) | `core.js`: `VERSION` (= package.json, pyproject.toml, the port; tested), `stepStatus` (also the app's step table), `metricRows`, `buildExport` (the model), `exportJson` / `parseExportJson`, `exportMat`, `exportNpz` (+ `npyBytes`), `exportCsvZip`, `zipStore` + `crc32`; column types by name (`TEXT_COLUMNS`, `BOOL_COLUMNS`). `app.js`: `#expMenu` (`expFmt`, `showExport`, `exportSettings`, `exportModel`, `exportAs`; CSV separate files = the old `exportMetrics` / `exportSteps`, unchanged), `loadExportJson` + `restoreParams`. Python: `export_model`, `write_export`, `--export` |
| `src/record.js` | `StepRecorder.init(onDone)`, `available()` (motion API + coarse pointer); phases countdown → recording → done/error on `#recOverlay` (`data-phase`); `onMotion` (samples `{ts, g, a, r}`), `onVisibility` (hidden → stop, keep data), hold-to-stop (`HOLD_MS`; Enter stops at once), `NO_SENSOR_MS`, wake lock; `finish` → `recordingCsv` → `onDone({csv, name, checks, position})` |
| `src/app.js` | state `S`, `loadRecording` (a recording → `loadCsv`; `S.recording` for Download), `S.counted` (from `# steps_counted:`; compared in `derivedChecks`), loading (`handleFile`, `loadHdf5` (jsfive on demand), `loadMat`, `loadZip`, `loadCsv`, `setDataset`, `selectChannel`), resampling (`rsOptions`, `applyResample`: `S.chRaw` is the prepared channel, `S.ch` what everything downstream uses, `S.rs` the `resampleChannel` result; its checks replace the `labRate` one), `COMPUTED` + `chanInfo()` (labels and units of computed signals), `recompute` (also the spectrum, rhythm over time and harmonic ratio), `renderSpectrum` (Spectrum panel; the UI tests' Plotly stub keeps it apart from the main plot), `derivedChecks`, `renderValidation`, `renderPlot` (traces: 0–1 envelope band, 2 the signal the lab code gets (resampled when Resample is on; faded when filtered), 3 filtered signal, 4 envelope midline, 5–6 algorithm guide lines, 7 lab markers, 8 algorithm markers, 9–10 interval strip, 11 spectrum rhythm period in the strip, 12 the recording before resampling (`zorder: -1`); hidden traces use `visible: false` so indices stay fixed; notes are shapes + annotations), `showLab()` (checks with `lab: true` hide with it), `hUsed()` (h control and line only for the lab code or algorithms with `usesH`), options under Advanced (`#advSec input[data-param]` → `params()`: numbers, or true/false for checkboxes; reset to their HTML default), `showFilter()`, `showEnv()` (envelopes are a view: they redraw the plot, never recompute steps), notes (`onPlotClick`, `addNote`, `renderNotes`), export |
| `python/lab_step_det.py` | `detect_steps`, `gait_metrics`, `load_csv` (Physics Toolbox / phyphox CSV → Walking.mat layout), `load_phyphox` (zip → `load_csv` + metadata), `load_mat`, `sampling_rate`, `rate_warning`, `resample` (linear / pchip, `antialias`; repeats averaged), `gaps`, `to_g` (`--to-g`), CLI |
