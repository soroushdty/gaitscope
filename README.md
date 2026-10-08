# GaitScope

An interactive lab, in the browser, for learning how movement-sensor signals are
processed: record or load a walk from a phone's accelerometer, then filter it, look at its
spectrum, and compare step detectors side by side.

**[Open GaitScope](https://soroushdianaty.com/gaitscope/)**. There is nothing to install, and
your files never leave the browser.

GaitScope started in Fall 2026 as a lab of BME 598/494 *Wearable Devices for Sport,
Health, and Wellness* (ASU, Dr. Aurel Coza): a MATLAB step detector and a sample walk. It
is now a dashboard that
loads or records a walk, checks that the file is usable, and puts any number of step
detectors and envelopes on the plot side by side, with filters, a spectrum, gait metrics
and exports. A Python port of Coza's detector gives the same steps as MATLAB on the
course's sample walk.

## What it is, and what it isn't

- **It is a teaching and exploration tool.** It is for students and instructors who want
  to see what a filter, a spectrum or a step detector does to a real signal, and why two
  detectors disagree. Each method is implemented carefully and checked against reference
  libraries (see [How we know it computes what it says](#how-we-know-it-computes-what-it-says)).
- **It is not a validated gait-measurement instrument.** Step counts, cadence and the
  other metrics have been compared with hand-counted steps on a few walks by one person,
  nothing more. They have not been validated across people, devices or walking
  conditions, or against a reference system such as an instrumented walkway.
- **It is not for clinical use.** Don't use it to diagnose, monitor or make decisions
  about anyone's health.

## Status

- **Young.** Development started on 2026-09-23. The current version is 0.1.0; things
  still change from week to week.
- **Who builds it.** One maintainer, Soroush Dianaty, who directs the work and reviews
  every change. Almost all code, tests and documentation are written by Claude Code
  (Anthropic's AI coding assistant). Who did what is in
  [docs/contributions.md](docs/contributions.md).
- **Licence.** MIT for now. A move to AGPL-3.0 is planned in
  [#42](https://github.com/soroushdty/gaitscope/issues/42), waiting on the course
  instructor's permission for the Coza port.

![GaitScope with the synthetic walk: Coza and Coza (modified) on the plot, a peak-trough envelope, and the step intervals underneath](docs/screenshot.png)

## What it does

### Bring a walk

- **Upload** a MATLAB `.mat` file (MATLAB or Octave, v5 to v7.3, any variable name,
  structs searched), a [Physics Toolbox Sensor Suite](https://play.google.com/store/apps/details?id=com.chrystianvieyra.physicstoolboxsuite)
  CSV export (G-Force Meter, Linear Accelerometer, Gyroscope or Multi Record; comma or
  semicolon separated; elapsed or clock time), a [phyphox](https://phyphox.org) export zip
  ("Acceleration with g" or "without g"), or any CSV with numbers in columns.
- **Record a walk** on a phone with the browser's motion sensors, with no app to install.
  Tap Record, walk, then hold to stop. The page asks how many steps you counted and where
  the phone was, and compares your count with the detectors. The recording downloads as a
  CSV that both the dashboard and the Python port read. It needs https (the live page has
  it) and the screen on. It has been tested on a Pixel 9a (Chrome and Firefox) and an iPad
  Air, at about 60 samples per second; an iPhone is still to be checked
  ([#51](https://github.com/soroushdty/gaitscope/issues/51)).
- **Validation.** Every file is checked against an [input schema](docs/schema.md) before
  analysis. Each problem comes with a concrete fix, such as the exact MATLAB line to re-save
  a file in a format the page can read.

### Prepare the signal

- **Signal to analyse:** x, y, z or the magnitude. When the recording includes gravity,
  also the vertical (along gravity) and horizontal (across it) acceleration.
- **Resample** to a rate you choose, or just even out a phone's uneven timing, before
  anything else runs. This is linear (like MATLAB `interp1`) or monotone cubic, with an
  optional anti-aliasing low-pass. On the test cases, linear resampling matches the Python
  port's `--resample` bit for bit and the other two within 1e-12, so Coza finds the same
  steps in both.
- **Filter:** Butterworth, Bessel, Chebyshev I and II, and elliptic (low-pass or band-pass,
  order 2 to 6), moving average, median, Savitzky–Golay, wavelet denoising (Daubechies-4)
  and notch. On the test cases, each matches scipy (or PyWavelets) within 1e-9. Every
  detector and envelope can use either the filtered or the recorded signal.

### Detect steps

- **Step detectors and envelopes as chart indicators.** Put any number on the plot at
  once, in any mix, like indicators on a trading chart. Each has its own settings, colour,
  source signal, show/hide and remove, and gets its own metrics column.
  - **Coza:** the step detector from BME 598/494 *Wearable Devices for Sport, Health, and
    Wellness* (ASU, Dr. Aurel Coza), exactly as written, bugs included.
  - **Coza (modified):** the same detector with its bugs fixed. It counts tied peaks once,
    drops start/stop artefacts, uses real timestamps, and reports cadence.
  - **Threshold peaks, Peak-to-valley and Zero-crossing:** three textbook detectors.
  - **Envelopes and bands:** sliding window, peak-trough, dynamic threshold, mean ± k·SD,
    Hilbert envelope and percentile band. They are a view only and never change the steps.

  The page opens with Coza beside Coza (modified). How each one works, and what is wrong
  with Coza's code, is in [docs/algorithm.md](docs/algorithm.md).
- **Phone position:** hand or waist (each peak is a step) or one leg (each peak is a
  stride).

### Read the results

- **Metrics** for each detector: steps, average step duration, cadence, step-time
  variability, gait asymmetry, walking span and harmonic ratio. While a Coza is shown,
  rows marked "Coza's formula" reproduce the `.m` file's own outputs exactly.
- **Frequency domain**, in the side panel: the main rhythm and the steps from the rhythm in
  one line, the methods and their settings, and a switch for the charts (off by default),
  which appear under the metrics. Two views, each with a choice of method:
  - *Whole recording:* Welch's spectrum (like scipy), Lomb–Scargle on the samples' own
    uneven times, or the autocorrelation (how often the walk repeats: a step, then a
    stride). Walking shows as a peak, which gives a cadence with no step detection at all,
    to cross-check the detectors. With a filter on, Welch also shows what the filter
    removes.
  - *Over time:* the short-time Fourier spectrogram, a Morlet wavelet scalogram (CWT, with
    its cone of influence), octave wavelet bands (DWT) or the Hilbert–Huang spectrum (EMD
    modes read moment by moment), with the main rhythm drawn on top.
    A steady walk is one bright band; swinging the phone brings out a second band at half
    the height (the stride). On the test cases, the wavelets match PyWavelets and the EMD
    matches PyEMD.
  The views never change the steps or metrics.
- **Step intervals** under the plot: the time between steps for each detector, next to the
  spectrum's main rhythm over time.
- **Steps table:** every step any detector marked, and the weak peaks Coza (modified)
  dropped.
- **Notes on the plot and the spectrum.** Pin a short note at a time ("turned around"), at a
  level ("resting level") or at a point ("counted twice"). On the spectrum, pin one at a
  frequency, a level or a point ("walking rhythm"). "Snap to the curve" puts a level or point
  on the curve; turn it off to place it exactly where you click. A spectrum note between
  0.5 and 3.5 Hz also shows its rate in everyday units ("every 1.10 s, 55 steps/min",
  doubled for a phone on one leg). Notes are listed under each chart and exported; they
  never change the steps.
- **Export** in the format each tool wants: CSV files, a zip with one CSV per table,
  MATLAB `.mat` (a struct, for MATLAB or Octave), NumPy `.npz` (no pickle), or JSON, which
  reopens the whole analysis in GaitScope. Sample numbers are 1-based, as in MATLAB
  ([docs/export.md](docs/export.md)).

### Around the page

- **Home:** the button in the header goes back to the start screen. If there are notes, a
  phone recording not yet downloaded, or changed settings, it first offers to save them as
  one file (a JSON export that reopens the analysis): Export, Discard or Cancel.
- **Signal only:** one button above the plot takes away every detector and envelope, the
  filter, resampling and the step intervals, to look at just the signal. Notes stay, and
  Undo puts everything back.
- **Theme:** follows the system's light or dark setting; the button in the header switches
  between the two. A switch away from the system's setting is remembered in this browser
  only; switching back follows the system again.
- **GitHub** in the header links to this repository.

## How we know it computes what it says

There are three kinds of evidence, and each has a limit.

**1. Coza matches the original MATLAB script.** On the course's sample walk
(`Walking.mat`, columns 2, 3 and 4), the dashboard, the Python port and GNU Octave running
`LabStepDet_2025.m` give identical steps (15, 12 and 21) and metrics.
*Limit:* the course files are not in this repository, so this check runs only on a
machine that has them (`bash scripts/octave_parity.sh`), not in CI. CI checks the same
code against a synthetic walk.

**2. Each method agrees with an established library.** The test fixtures are generated by
the reference library (`scripts/make_fixtures.py`) and the Node tests compare against them
on every pull request, at these tolerances:

| Method | Reference | Fixture | Tolerance in the tests |
|---|---|---|---|
| Butterworth, Bessel, Chebyshev I and II, elliptic (orders 2–6, at 57, 100 and 460 Hz) | scipy `iirfilter` + `sosfiltfilt` | `filters.json` | 1e-9 |
| Moving average, median, Savitzky–Golay, wavelet denoising, notch | scipy, PyWavelets | `filters.json` | 1e-9 |
| Resampling | the Python port (numpy, scipy) | `resample.json` | linear bit for bit; cubic and anti-aliased 1e-12 |
| FFT, Welch, spectrogram | numpy, scipy | `spectral.json` | 1e-12 (relative) |
| Lomb–Scargle, autocorrelation | scipy, numpy | `periodicity.json` | 1e-12, 1e-13 |
| Morlet wavelet transform, Daubechies-4 bands | PyWavelets | `wavelets.json` | 1e-10 (relative), 1e-12 |
| Empirical mode decomposition | PyEMD | `emd.json` | 1e-9 |
| Smooth envelope joins | scipy `PchipInterpolator` | `envelopes.json` | 1e-12 |

Every export format is read back with an independent reader (scipy `loadmat`, numpy
`load`, Python's `zipfile` and `csv`, and Octave when installed).
*Limit:* agreement is shown on the test inputs (synthetic walks and test signals at the
rates listed). That is strong evidence the code computes the intended method, not proof
for every possible input.

**3. Real walks with hand-counted steps** ([#68](https://github.com/soroushdty/gaitscope/issues/68)).
On 2026-10-07 the maintainer recorded four walks with the dashboard and counted the steps:
10, 28 (phone in a front pocket) and 60 on a Pixel 9a, and 24 on an iPad, the others
with the phone held flat at the chest. Inside the walk, Coza (modified), Threshold peaks,
Peak-to-valley and Zero-crossing were within 2 of the count on the total acceleration and
within 1 on the vertical. Coza found 45 of 60 at the phone's own rate of about 60 Hz,
because its window is counted in samples and assumes 100 Hz; resampled to 100 Hz, it found
all 60.
*Limit:* one person, two devices, a normal pace, two phone positions. That is too little
to rank the detectors or to call any of them accurate (see
[What it is, and what it isn't](#what-it-is-and-what-it-isnt)).

## Roadmap

The plan lives in the [issues](https://github.com/soroushdty/gaitscope/issues). The main
open threads:

- **Licence and purpose:** AGPL-3.0 and the educational aim, after the instructor's
  permission ([#42](https://github.com/soroushdty/gaitscope/issues/42),
  [#67](https://github.com/soroushdty/gaitscope/issues/67)).
- **More counted walks:** a back pocket, slow and fast walks, other people, an iPhone
  ([#68](https://github.com/soroushdty/gaitscope/issues/68),
  [#51](https://github.com/soroushdty/gaitscope/issues/51)).
- **An optional tutor:** what it costs to run a language-model tutor in the browser, and
  whether small models are good enough (research in
  [PR #59](https://github.com/soroushdty/gaitscope/pull/59); a study write-up in
  [#111](https://github.com/soroushdty/gaitscope/issues/111)).
- **Your own detectors, envelopes and filters as plugins**
  ([#64](https://github.com/soroushdty/gaitscope/issues/64)).
- **Code structure:** splitting `src/core.js` into smaller files
  ([#110](https://github.com/soroushdty/gaitscope/issues/110)).

## Run it locally

GaitScope is a static page with no build step.

```bash
python3 -m http.server 8000     # or: npm run serve
# open http://localhost:8000
```

Opening `index.html` directly from disk also works. Plotly and pako load from the jsDelivr
CDN, so an internet connection is needed; jsfive, for MATLAB v7.3 files, loads only when
one is opened. The live copy is served by GitHub Pages from `main`.

## Python port

`python/lab_step_det.py` is a 1:1 translation of Coza's `LabStepDet_2025.m`. On
`Walking.mat` it gives the same steps and metrics as the original script running in GNU
Octave, and as the dashboard's Coza.

- **Files:** `.mat` files of any version (v5 to v7 with scipy, v7.3 with h5py), Physics
  Toolbox CSV exports, and phyphox zips (or the `Raw Data.csv` inside). Time, x, y and z
  are put in the Walking.mat layout, so `--col 2/3/4` picks x/y/z. A missing or
  non-numeric `--var` says which variables the file has.
- **phyphox:** prints the phone, sensor chip, start time and length from `meta/`, and warns
  if the recording was paused (phyphox's time leaves pauses out, so the stretches are joined
  with no gap). phyphox records in m/s², while Coza's `h = 1` assumes g: `--to-g` divides
  x, y and z by 9.80665 first.
- **Sampling rate:** Coza divides by 100 to get seconds and counts its window `w` in
  samples, so the port warns when the data is not within 5% of 100 Hz. The rate comes from
  the time column, after any `--resample`. The free Physics Toolbox records at about
  460 Hz. `--resample 100` linearly interpolates onto a 100 Hz grid first (MATLAB:
  `interp1(t, A, 0:0.01:t(end))`); `--resample-method pchip` uses a monotone cubic instead,
  and `--antialias` low-passes below the new Nyquist frequency first when going down in
  rate. The detector itself is unchanged.
- **Export:** `--export FILE` saves Coza's steps and metrics in the dashboard's export
  layout ([docs/export.md](docs/export.md)), as `.json`, `.mat`, `.npz` or a `.zip` of CSV
  files.

```bash
uv sync                          # once per clone: creates .venv from uv.lock (Python ≥ 3.12)
uv run python python/lab_step_det.py --file data/Walking.mat --col 2
uv run python python/lab_step_det.py --file data/g_force_....csv --col 2 --w 60
uv run python python/lab_step_det.py --file data/g_force_....csv --col 2 --w 60 --resample 100
uv run python python/lab_step_det.py --file "data/Data from phyphox.zip" --col 4 --resample 100 --to-g
uv run python python/lab_step_det.py --file data/Walking.mat --col 2 --export walking.mat   # or .json, .npz, .zip
uv run python python/plot_walking.py data/Walking.mat --out walking_steps.png
```

## Tests

```bash
npm install && npm test          # parsing, validation, algorithms, UI (jsdom)
uv run pytest                    # Python port
uv run python scripts/make_fixtures.py  # regenerate tests/fixtures after changing the port
bash scripts/octave_parity.sh    # original .m in GNU Octave vs the Python port
```

The filters, spectra, envelopes and resampling are checked against scipy, numpy and
PyWavelets, and the exports are read back with scipy, numpy, Python's `zipfile` and `csv`,
and Octave. All fixtures are generated from a synthetic walk. The course files
(`Walking.mat`, `LabStepDet_2025.m`) are **not** committed. If you put them in `data/`, the
MATLAB-parity tests run as well; otherwise they are skipped.

GNU Octave is only for these developer checks: the parity script, and a test that loads a
`.mat` export in Octave (skipped when Octave is missing, as in CI). Nobody needs it to use
the dashboard or the Python port, which write `.mat` files themselves. It isn't a Python
package, so it isn't in `pyproject.toml`; on Ubuntu or Debian, install the command-line
version (about 80 MB) with `sudo apt install --no-install-recommends octave`.

## Contributing

Changes go through a branch and a pull request with atomic commits. See
[CONTRIBUTING.md](CONTRIBUTING.md). Who did what, including the use of AI, is in
[docs/contributions.md](docs/contributions.md).

## Layout

```
index.html            the dashboard page
src/core.js           parsing, validation, filters, spectra, detectors, export (no DOM; also runs in Node)
src/app.js            dashboard UI: controls, indicators, Plotly figures, export
src/record.js         recording a walk with the phone's motion sensors
src/styles.css        light and dark themes
python/               Python port and plotting script
tests/                Node (jsdom) and pytest suites, generated fixtures
scripts/              fixture generator, Octave parity check
docs/                 input schema, algorithms, export formats, contributions
data/                 local course files (git-ignored)
```

## Credits and license

- **Coza** and the sample walk (`Walking.mat`) come from BME 598/494 *Wearable Devices
  for Sport, Health, and Wellness* (ASU, Dr. Aurel Coza). The page's demos are our own:
  three phone recordings (`demo/`) and a synthetic walk. The course files
  stay out of this repository.
- **Coza (modified):** Dr. Soroush Dianaty.
- **Everything else:** each detector, filter and envelope credits its authors on the page,
  with a DOI link, and in exports. The full list, including the spectrum and features, is
  under Credits in [docs/algorithm.md](docs/algorithm.md).

MIT License; see [LICENSE](LICENSE).

## Notes

- MATLAB v7.3 files (HDF5) are read with jsfive. Cell arrays, strings, sparse and complex
  data inside them are listed but not analysed.
- Files with no time column are assumed to be at 100 Hz; the rate can be changed on the
  page.
