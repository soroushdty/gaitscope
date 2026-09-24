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
   a corrected version. Features: interactive sliders, click-to-edit, CSV export.

The owner does not know MATLAB and works in Python. Explain MATLAB-specific
behaviour when it matters.

## Hard rules

- **The "original" algorithm must stay bit-exact with MATLAB.** This covers
  `detect_steps`/`gait_metrics` in Python and `detectOriginal`/`originalMetrics` in
  JS. That includes its quirks: 1-based indices in the output, loop bounds
  `w+1 … length-w`, `/100` for seconds, the `Pace = duration*60` formula, and
  N−1 `std`. Improvements go into the *fixed* version only (`detectFixed`,
  `fixedMetrics`).
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
- Real Physics Toolbox exports from the owner's phone (2026-09-23, G-Force Meter at
  ~460 Hz and Linear Accelerometer at ~57 Hz) load correctly. Newer exports start with
  `# key: value` metadata lines and put units in headers (`ax (m/s^2)`); both are handled.
  At 460 Hz the lab code (`w = 30` samples = ±65 ms, TgF rounded to 0.01) finds 193
  "steps" in 6.6 s, so it only makes sense near 100 Hz.

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
- [ ] Enable GitHub Pages (Settings → Pages → main / root).
- [ ] Maybe: support MAT v7.3 via h5wasm (large WebAssembly download; probably not
      worth it), batch processing of several files, overlaying x/y/z channels.

## Code map

| File | Key parts |
|---|---|
| `src/core.js` | `parseMat` (MAT v5 reader), `matCandidates`, `matToColumns`, `parseCsv`, `buildDataset` (roles and units), `prepareChannel` (cleaning and sampling checks), `windowExtreme` (O(n) sliding max/min), `detectOriginal`, `originalMetrics`, `detectFixed`, `fixedMetrics`, `demoWalk` |
| `src/app.js` | state `S`, loading (`handleFile`, `loadMat`, `loadCsv`, `setDataset`, `selectChannel`), `recompute`, `derivedChecks`, `renderValidation`, `renderPlot` (trace order matters for click handling: 0 signal, 1 lab markers, 2 fixed, 3 added, 4 removed, 5–6 interval strip), edits, export |
| `python/lab_step_det.py` | `detect_steps`, `gait_metrics`, CLI |
