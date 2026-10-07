# CLAUDE.md

Context for Claude Code sessions on this repository.

## What this is

**GaitScope**, live at https://soroushdianaty.com/gaitscope/ (GitHub Pages from `main`, so
a merge deploys it). It began as a class project for BME 598/494 (Dr. Aurel Coza), Fall 2026, which
provides a MATLAB step-detection script (`LabStepDet_2025.m`) and a sample recording
(`Walking.mat`). The instructor allows
students to skip MATLAB and use an AI tool to run the code instead. This repo holds:

1. `python/lab_step_det.py`: a faithful Python port of the MATLAB script.
2. A static browser dashboard (`index.html` + `src/`) that validates an uploaded
   `.mat`, Physics Toolbox `.csv` or phyphox `.zip` file (or records a walk on a phone) and
   runs step detectors on it. Detectors and envelopes are chart indicators: any number on
   the plot at once, each with its own settings, colour and source signal. The page opens
   with **Coza** (the detector from BME 598/494 (Dr. Aurel Coza), as written) and **Coza (modified)** (fixed by
   the owner, Dr. Soroush Dianaty). Also: filters, resampling, notes pinned to the plot,
   and export as CSV, zipped CSV, MATLAB .mat, NumPy .npz or JSON (which reopens an
   analysis).

The project's name is GaitScope (page title, heading, README, packages); "step detector"
names a feature, not the project. Export files keep the lowercase ids `gaitscope-export`
and `gaitscope dashboard` so older exports reopen.

The course is named "BME 598/494 (Dr. Aurel Coza)" everywhere, except the README, which uses
"BME 598/494 *Wearable Devices for Sport, Health, and Wellness* (ASU, Dr. Aurel Coza)". Never "Lab 1" (#78).

No "lab code" wording anywhere: Coza is a step detector like any other, credited to
Dr. Coza (names only on the page, no emails). `Walking.mat` is his sample signal; it
stays out of the repo, and the page's sample is our own synthetic walk.

The owner does not know MATLAB and works in Python. Explain MATLAB-specific
behaviour when it matters.

## Hard rules

- **Never commit or push to `main`.** Every change goes new branch → atomic commits →
  PR → Rebase and merge, as described in `CONTRIBUTING.md`. Each commit must pass both
  test suites on its own.
- **Coza (the original algorithm) must stay bit-exact with MATLAB.** This covers
  `detect_steps`/`gait_metrics` in Python and `detectOriginal`/`originalMetrics` in
  JS. That includes its quirks: 1-based indices in the output, loop bounds
  `w+1 … length-w`, `/100` for seconds, the `Pace = duration*60` formula, and
  N−1 `std`. Improvements go into our own detectors, never into Coza. Each detector is
  an entry in `ALGORITHMS` in `src/core.js` with a `params` schema the page builds its
  controls from. The first is **Coza** (`coza_original`: `detectOriginal` with its own
  `w` and `h`, nothing fixed; its `.m` outputs appear as the "Coza's formula" metric rows).
  Next is **Coza (modified)** (id `coza`, `detectCoza`), Coza's detector with its bugs
  fixed. All of them share `timingMetrics` for their metrics column.
- **`src/core.js` has no DOM access.** It is shared by the browser and by the
  Node tests (UMD-style export at the bottom).
- **Never commit course files.** `data/` is git-ignored except its README. Test
  fixtures are synthetic (`scripts/make_fixtures.py`).
- **The dashboard stays a static page** (GitHub Pages) with no build step. Its own scripts
  are `src/core.js`, `src/record.js` and `src/app.js`; `tests/ui.test.js` inlines all three. The only
  external scripts are pako (inflating compressed MAT files) and plotly.js-basic, loaded
  with the page, and jsfive (MATLAB v7.3 / HDF5, `HDF5_URL` in `src/app.js`), loaded only
  when a v7.3 file is opened. All three are pinned on jsDelivr.
- **Credits (#63): names only on the page, never emails.** A DOI goes into `CREDIT` /
  a `credit` list only after it was checked against Crossref (title, first author, year),
  and a source is credited for a method only after reading it. List it under Credits in
  `docs/algorithm.md` too (a test checks the DOIs are there).

- **Every validation message says what went wrong and how to fix it.** See
  `docs/schema.md`; update that document when checks change.

- **Keep the contribution record honest** (`docs/contributions.md`). In issues and PRs,
  say when an idea or recommendation comes from the session, and record the owner's
  decisions as theirs ("Decision (owner): …"). Update that page when roles change.

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
  At 460 Hz Coza (`w = 30` samples = ±65 ms, TgF rounded to 0.01) finds 193
  "steps" in 6.6 s, so it only makes sense near 100 Hz.
- Free Physics Toolbox can't set the sample rate (a Pro feature), so phone recordings
  come in at ~460 Hz. `lab_step_det.py --resample 100` interpolates to 100 Hz before
  Coza (MATLAB `interp1`); Coza (modified)'s window is in seconds, so it needs no resampling.
- Resampling (#52), in the dashboard (Detection → Resample) and in Python
  (`--resample-method linear|pchip`, `--antialias`), gives the same samples in both ports
  (`tests/fixtures/resample.json`): linear is bit-exact, pchip within 4e-16, anti-aliased
  within 2e-13. A CSV resampled to 100 or 50 Hz gives Coza the same steps in both.
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
  as Coza (modified) on `Walking.mat` column 2. They disagree on the other channels and on the phone
  recordings, which have no known step count (table in `docs/algorithm.md`).
  `lowpass` matches scipy's `filtfilt(butter(2, …))` to 1e-13.
- The signal filters (#12, #37) match scipy within 1e-9 (`tests/fixtures/filters.json`):
  Butterworth, Bessel, Chebyshev I and II and elliptic (`iirfilter` + `sosfiltfilt`,
  orders 2–6, at 57, 100 and 460 Hz), moving average and median (`scipy.ndimage`,
  `mode='nearest'`), Savitzky–Golay (`savgol_filter`, `mode='interp'`) and notch
  (`iirnotch`). scipy's own Savitzky–Golay weights lose precision on long, high-order
  windows (1.5e-10 at 231 samples, order 5), so that case is checked against exact rational
  weights instead. A detector or envelope set to Unfiltered never sees the filtered signal.
- Envelopes (#13, #38) are views only; a UI test checks steps, metrics and exports stay
  identical for each. The smooth peak-trough joins match scipy's `PchipInterpolator`
  (`tests/fixtures/envelopes.json`). RMS, moving SD and mean ± k·SD from #38 are one
  envelope (mean ± k·SD; k = 1 is the RMS band).
- The frequency-domain features (#36) match numpy/scipy/PyWavelets within 1e-12
  (`tests/fixtures/spectral.json`, the `dwt` and wavelet cases in `filters.json`).
  PyWavelets is a dev dependency, used only by `make_fixtures.py`. On `Walking.mat` the
  spectrum agrees with Coza (modified)'s cadence within 1/min. Column 2's strongest rhythm is
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

## Findings about Coza's code (see docs/algorithm.md)

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
- [ ] #51 on the owner's Pixel 9a (Firefox 157, 2026-10-07; files in `data/`): 57.4 Hz, even
      timing; face up reads +0.98 g on z (Android's direction). Walks of 10 steps (flat at the
      chest) and 28 (front pocket): inside the walk every detector is within one step on the
      vertical signal; the extras come from the ends. Locking the screen ends the recording and
      keeps what came before (#86). Still to do: a Physics Toolbox recording of the same walk.
- [ ] #51 on an iPhone (no device yet): the same checks, plus the permission prompt and
      whether Safari inverts the axis signs.
- [ ] Faint first and last steps (2026-10-07, owner's observation): the synthetic walk has
      17 cycles, the first and last at a third and a quarter of full height but on rhythm.
      Coza and Zero-crossing find 17; Peak-to-valley 16; Coza (modified) and Threshold
      peaks (k 0.5) 15, because their rules are amplitude-only. On `Walking.mat` column 2
      the dropped stop bump is also off rhythm (0.66 s vs 1.14 s). Proposed by the session:
      drop a faint peak only when it is also off rhythm. Owner to decide.
- [ ] Maybe: a median "despike" step before another filter (#37 kept one filter at a time).
- [x] GitHub Pages is enabled (main / root), with Enforce HTTPS on (2026-10-06), so
      http:// redirects to https://, which the recorder's motion sensors need.
- [ ] Maybe: batch processing of several files, overlaying x/y/z channels.
- [ ] Maybe: files with no time column still default to 100 Hz (`fsIn`); asking for the rate
      might be better (#52, "related").

## Code map

| File | Key parts |
|---|---|
| `src/core.js` | `parseMat` (MAT v5 reader), `isMat73` + `parseMat73` (v7.3 through jsfive, passed in) + `patchCompactStorage`, `matCandidates`, `matToColumns`, `parseCsv` (+ `phyphoxMetaFile`: rejects a lone phyphox meta file), `isZip` + `parseZip` + `readPhyphoxZip` (phyphox zip → data CSV text + metadata checks), `recordingCsv` + `recordingChecks` (#51: devicemotion samples → CSV in g / m/s² / rad/s with `# key: value` metadata; `parseCsv` returns those as `meta`), `buildDataset` (roles and units), `prepareChannel` (cleaning and sampling checks; also takes 'computed', 'vertical', 'horizontal'), `gravitySplit` (vertical/horizontal from x, y, z by gravity's direction, #35), `datasetRate` + `gapRate` (the rate: mean of the gaps within 0.5–1.5× the median, = Python `sampling_rate`; whole-ms times read right), `windowExtreme` (O(n) sliding max/min), `detectOriginal`, `originalMetrics`, `designFilter` (Butterworth / Bessel / Chebyshev I / II / elliptic as second-order sections, like scipy `iirfilter`; prototypes `besselPoles` (Aberth `polyRoots`), `ellipPrototype` (cephes-style `ellipj`, AGM `ellipK`, Carlson `carlsonRF`)), `sosfiltfilt` (zero-phase, like scipy), `lowpass` (algorithms' internal 2nd-order Butterworth), `cozaRateCheck` (the 100 Hz check, `id: 'cozaRate'`, `needs: 'coza_original'`), `resampleChannel` (#52: even grid at a chosen or the measured rate, `mergeRepeats`, optional Chebyshev I anti-aliasing `ANTIALIAS`) + `interpLinear` (numpy.interp operation for operation), `dynamicThreshold`, `detectCoza`, `detectThresholdPeaks`, `detectPeakToValley`, `detectZeroCrossing`, `timingMetrics` (metrics for every algorithm), `WEAK_RATIO`, `windowSamples` (seconds → samples), `CREDIT` + `creditText` (#63: each entry's `credit` list, `{text, doi|url, note}`; shown with its settings, in the export's indicators table), `ALGORITHMS` (detector registry: `coza_original` (Coza), `coza` (Coza (modified)), then the textbook three; tagline, summary, `params` schema (`P_H`, `P_W`; `defaultParams`, `paramSummary`), detect → idx/markY/guides, settings for the export), `FILTERS` (each entry: apply on even samples, label; settings rows under Advanced list it in `data-only`) + `applyFilter` (filter for the algorithm only) / `filterEvenly` / `evenGrid` (uneven timing onto an even grid, shared with the FFT features), `oddWindow` (seconds → odd samples), `movingAverage`, `movingMedian`, `savgol`, `notchSos`, `dwt` / `idwt` / `waveletDenoise` (db4, like PyWavelets), `filterLabel`, `interpAt`, frequency domain (#36): `fft` / `ifft` (radix-2 or Bluestein, like numpy), `spectrogram` / `welch` (like scipy), `spectrum` + `dominantFrequency` (`GAIT_BAND` 0.5–3.5 Hz, clear at 5× the median), `rhythmOverTime`, `filterGain` (|H|² of the selected filter), `hilbert`, `harmonicRatio`, `ENVELOPES` (sliding, peak-trough with optional smooth joins, dynamic threshold, mean ± k·SD, Hilbert, percentile band; each with a `params` schema; view only; `midName` labels a midline), `localExtrema`, `halfWindow`, `movingMeanSd`, `movingPercentiles`, `pchip` (monotone cubic, like scipy `PchipInterpolator`), `demoWalk` |
| export (#53) | `core.js`: `VERSION` (= package.json, pyproject.toml, the port; tested), `EXPORT_FORMAT_VERSION` 2, `stepTable` (rows any detector marked or dropped; also the app's step table), `metricRows` (a column per detector; `coza_` rows for Coza), `indicatorIds` (`coza`, `coza_modified`, `threshold_2`, …), `buildExport` (the model: indicators table, step/metric columns per detector), `exportJson` / `parseExportJson`, `exportMat`, `exportNpz` (+ `npyBytes`), `exportCsvZip`, `zipStore` + `crc32`; column types by name or by values (`columnKind`). `app.js`: `#expMenu` (`expFmt`, `showExport`, `exportSettings`, `exportModel`, `exportAs`), `loadExportJson` + `restoreExport`. Python: `export_model` (Coza only; `_timing` mirrors `timingMetrics`), `write_export`, `--export` |
| `src/record.js` | `StepRecorder.init(onDone)`, `available()` (motion API + coarse pointer); phases countdown → recording → done/error on `#recOverlay` (`data-phase`); `onMotion` (samples `{ts, g, a, r}`), `onVisibility` (hidden → stop, keep data), hold-to-stop (`HOLD_MS`; a completed hold cuts from `PRESS_MARGIN_MS` before the touch, `trimmed_end_s`; Enter stops at once), `NO_SENSOR_MS`, countdown setting (`#recCount`, `COUNTDOWNS`, localStorage `gaitscope-countdown`), wake lock (`keepAwake`: asks again up to `RELOCKS` times; `LOCK_ON`/`LOCK_OFF`/`LOCK_LOST` notes, #86); `finish` → `recordingCsv` → `onDone({csv, name, checks, position})` |
| `src/app.js` | theme (#79: `applyTheme`, `THEMES` System/Light/Dark on `data-theme`, remembered in `localStorage` `gaitscope-theme`, guarded), state `S` (`S.ind`: the indicators), `loadRecording` (a recording → `loadCsv`; `S.recording` for Download), `S.counted` (from `# steps_counted:`; compared in `derivedChecks`), loading (`handleFile`, `loadHdf5` (jsfive on demand), `loadMat`, `loadZip`, `loadCsv`, `loadExportJson` + `restoreExport` (format 2 indicators; format 1 → Coza + its algorithm), `setDataset` (opens on column 2 for MAT, the magnitude for a phone's acceleration export, else the first signal), `selectChannel`), resampling (`rsOptions`, `applyResample`: `S.chRaw` is the prepared channel, `S.ch` what everything downstream uses, `S.rs` the `resampleChannel` result; its checks replace the `cozaRate` one), `COMPUTED` + `chanInfo()`, indicators (`addIndicator`, `defaultIndicators` (Coza + Coza (modified)), `labelOf` ("Coza 2" for repeats), `renderIndicators` (rows built from each `params` schema by `paramControl`; delegated `onIndicatorInput`/`onIndicatorClick`/`onIndicatorSource`), `PALETTE` (`--c1`…`--c6`) + `SYMBOLS`, `source` filtered/recorded; envelopes only redraw (`computeEnvelopes`), detectors `schedule()` a recompute), `params()` (page-wide: filter, spectrum, phone position; `indParams` adds an indicator's own), `signalOnly` / `undoSignalOnly` (#79: Signal only keeps notes; Undo until any other change, `dropPlainUndo`), Home (#79: `onHome` → `#homeDialog` Export / Discard / Cancel when `unsaved()`: notes, an undownloaded recording, or `setupSig()` ≠ `S.clean` from `markClean()` at the end of each load or after a JSON export; `goHome` resets to the opening state), `recompute` (filter and spectra cached; per-detector results cached in `S.cache.det` by uid: `fx`, `idx`, `metrics`, `hr`, `script` = `originalMetrics` for Coza), `derivedChecks` (per detector; `needs: 'coza_original'` checks only while a Coza is shown), `renderValidation`, `renderLegend`, `renderPlot` (traces carry `meta: {role, uid}`: envLower/envUpper/envMid per envelope, recorded (zorder -1), signal, filtered, guide, markers (stacked, a symbol each), intervals, rhythm; one dashed `h` line per detector with `h`; notes are shapes + annotations), `renderSpectrum`, `renderMetrics` (a column per shown detector; "Coza's formula" rows when a Coza is shown; `specCadNote`), `renderSteps` (`C.stepTable`), notes (#80: `NOTE_UI` per chart (signal, spectrum), `onNoteClick` (kind time/level/point; Snap: the clicked curve point, else `cursorAt` from Plotly's axes; a time note takes the pointer's time), `drawNotes` (shapes/annotations; log10 on a log axis), `addNote`, `renderNotes`; notes are `C.noteOf` objects, export format 3), export (`exportSteps`/`exportMetrics` = CSV separate files from the model, `exportModel` → `C.buildExport` with shown indicators only, `exportAs`) |
| `python/lab_step_det.py` | `detect_steps`, `gait_metrics`, `load_csv` (Physics Toolbox / phyphox CSV → Walking.mat layout), `load_phyphox` (zip → `load_csv` + metadata), `load_mat`, `sampling_rate`, `rate_warning`, `resample` (linear / pchip, `antialias`; repeats averaged), `gaps`, `to_g` (`--to-g`), CLI |
