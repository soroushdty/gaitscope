# Input schema

The dashboard accepts any reasonable accelerometer recording, not just the course's
`Walking.mat`, and refuses anything that would make the step detector silently wrong.

Every check has one of four levels:

| Level | Meaning |
|---|---|
| **error** | The file or channel cannot be analysed. The message says how to fix it. |
| **warn** | Analysis runs, but a result may be misleading. |
| **info** | Something was inferred or adjusted; worth knowing. |
| **pass** | A check that succeeded (hidden behind "Show passed checks"). |

**Rule of thumb:** be strict where bad input produces wrong numbers with no visible sign,
and lenient where a person looking at the plot can judge for themselves.

All checks live in `src/core.js` (`parseMat`, `matCandidates`, `parseCsv`, `readPhyphoxZip`,
`buildDataset`, `prepareChannel`) and in `derivedChecks()` in `src/app.js`.

## 1. File

| Check | Level | Why |
|---|---|---|
| Size ≤ 50 MB, not empty | error | Keeps the browser responsive. |
| MAT v5–v7 (MATLAB or Octave, compressed or not) | — | The format MATLAB writes by default. |
| MAT v7.3 (HDF5) | pass, read with jsfive | The 41 KB reader loads from jsDelivr only when such a file is opened. Numeric matrices and structs are read; cell, char, logical, empty, sparse, complex and object variables get the same notes as in v5 files. Small arrays in compact storage, which jsfive alone can't read, are decoded by `patchCompactStorage`. |
| MAT v7.3: the reader didn't load | error | Fix: check the connection and reload, or `save('f.mat','-v7')`, or export CSV. |
| MAT v7.3: no HDF5 data after the header, or HDF5 the reader can't open | error | Fix: re-save or re-download; or `save('f.mat','-v7')`, or export CSV. |
| MAT v7.3: one variable can't be decoded | note on that variable | The other variables are still offered. Fix: `save('f.mat','-v7')` or CSV. |
| MAT v4 | error | Obsolete. Fix: re-save with `-v7`. |
| Text file named `.mat` | warn / error | Read as CSV if it parses; otherwise told to rename it. |
| Random or corrupted bytes, truncated blocks | error | Detected from the header and element sizes. |
| CSV lines starting with `#` | skipped as data, kept as metadata | Newer Physics Toolbox exports start with metadata lines (`# sensor:g_force`, `# Requested Sample Rate: …`), and so do the dashboard's own recordings (`# steps_counted: 20`). `# key: value` lines are kept in `parseCsv`'s `meta`. |
| phyphox `meta/time.csv` or `meta/device.csv` uploaded on its own | error | They hold start/pause times or the phone's details, not samples; `time.csv` would otherwise be read as a two-row recording. Fix: upload the whole zip, or `Raw Data.csv`. |
| Zip file (phyphox export) | pass, read in the browser | The zip's directory is parsed in `core.js` and entries are inflated with pako, which is already loaded. `Raw Data.csv` is read (else the largest CSV outside `meta/`; other CSVs are listed as unused). `meta/device.csv` and `meta/time.csv` give the phone, phyphox version, sensor chip, start time and length. |
| phyphox recording paused and resumed | warn | phyphox's experiment time leaves out pauses, so the stretches are joined with no gap; the message gives the join times. A step across a join can be missed or doubled. |
| Zip with no CSV (e.g. an Excel export), damaged or truncated, password-protected, ZIP64, or an unknown compression method | error | Fix: export again as CSV (comma, decimal point), or unzip and upload the CSV. |
| File named `.zip` that isn't a zip | error | Fix: export again, or upload the CSV or MAT file itself. |
| GaitScope JSON export (#53) | info, reopened | Its signal loads at its own times with Resample off (it is already the analysed signal), and every control and note is restored, so the same steps and metrics come out. See `docs/export.md`. |
| JSON that isn't a GaitScope export, can't be parsed, has no signals, or has a newer `format_version` | error | Fix: export again from the dashboard (with Signals ticked), or reload the page for a newer version. |

### Recording in the browser (#51)

On a phone, **Record a walk** captures the motion sensors through the browser's
`devicemotion` event (`src/record.js`). The samples become CSV text (`recordingCsv` in
`src/core.js`) and load through the same path as an uploaded file, so every check below
runs unchanged. Nothing is resampled; the dashboard's Resample step does that afterwards.
Columns: `gFx`, `gFy`, `gFz`, `TgF` in g with gravity (accelerationIncludingGravity ÷
9.80665, like Physics Toolbox's G-Force Meter), `ax`…`aT` in m/s² without gravity, and
`wx`…`wz` in rad/s, when the browser gives them. Metadata lines record the start time,
device, rate, how it stopped, and the two optional answers (`steps_counted`,
`phone_position`).

| Check | Level | Why / fix |
|---|---|---|
| Page not on https | error + link | Browsers only give motion data to secure pages. GitHub Pages serves the dashboard over http as well unless "Enforce HTTPS" is on, so the message links to the same page over https. |
| No motion API | error | Fix: Chrome on Android or Safari on iPhone. On computers (no touch screen) the button is hidden and a hint says to use a phone. |
| iPhone: motion access refused | error | Safari asks once per visit. Fix: close the tab, reopen and tap Allow; or clear Safari's website data. On Android: Chrome's Site settings → Motion sensors. |
| No data within 2.5 s | error | No sensor (a computer). Fix: open the page on a phone. |
| Recording under 3 s or 20 samples | error | Too short to analyse. Fix: record at least 10 s with the screen on. |
| Screen locked or page hidden while recording | warn + fix | The phone stops sending data; what was captured is kept and loaded. A full-screen overlay (hold for a second to stop) keeps pocket touches from changing anything, and the Screen Wake Lock keeps the screen on where the browser allows it. |
| Recorded in the browser | info | Says when, at what rate, and the counted steps and phone position if given. A front-pocket recording sets Phone position to *One leg*. |
| Stopped at the 30-minute limit | info | |
| Recorded on an iPhone | info | Safari has been reported (W3C list, 2014) to give acceleration with the opposite sign from Android and the spec; not yet checked on a current iPhone, so nothing is flipped. Magnitude, vertical and horizontal don't depend on the sign. |

## 2. Variables (MAT)

Variable names are never hard-coded. Every numeric variable is a candidate; one-level
struct fields are searched too (`rec.acc`). With several candidates the largest is
selected and the rest are offered in a dropdown.

| Variable | Level | Why / fix |
|---|---|---|
| Real numeric 2-D matrix (double, single, int*, uint*) | accepted | Integers are converted to double. |
| Logical, complex, empty, N-D, fewer than 20 samples | skipped (info) | Not a sensor recording. |
| Both dimensions > 40 (e.g. 64×64) | skipped (info) | Looks like an image or table of results, not samples × channels. |
| MATLAB `table` / `timetable` / `string` objects | warn + fix | Only MATLAB can decode them. Fix: `A = table2array(T)`. |
| Cell arrays, sparse matrices | warn + fix | `cell2mat`, `full`. |
| No usable candidate | error | Lists the fix for whatever was found. |

## 3. Orientation

Samples must run down the rows. A matrix wider than it is tall (5×1642) is rotated
automatically, with a warning, because that is almost always a transposed recording.

## 4. Column roles

| Role | How it is found |
|---|---|
| **Time** | CSV: a header named `time`, `t`, `elapsed`, `timestamp`. MAT or headerless CSV: the first column, if it increases in more than 95% of steps and never decreases. Shifted to start at 0. Values that look like milliseconds are converted to seconds. Physics Toolbox clock times (`13:05:10:006`) are converted to elapsed seconds. |
| **x, y, z** | CSV: Physics Toolbox names (`gFx`, `ax`, `wx`, …), phyphox names (`Acceleration x`, `Linear Acceleration x`) or `x`, `acc_x`, …, optionally followed by a unit in brackets (`ax (m/s^2)`); MAT: the three columns after time. |
| **Magnitude** | CSV: `TgF`, `aT`, `Absolute acceleration`, `total`, `magnitude`, …; MAT: a column that equals √(x²+y²+z²) within rounding. |
| **Other** | Kept with generic names and still selectable. |

If x, y and z are known but no magnitude column exists, a computed magnitude is offered.
MAT columns keep their MATLAB numbers in labels ("x (column 2)") so they map directly
onto `Walking(:,2)` in Coza's `.m` file.

## 5. Units

Coza's threshold `h = 1` is in the signal's own units, so units matter most of all:
in g, walking peaks can stay below 1 and Coza would report almost no steps without any
error.

* **Physics Toolbox CSV:** read from the column names. `gF*` → g, including gravity;
  `a*` → m/s², gravity removed; `w*` → rad/s (gyroscope, warned as "not an acceleration
  signal"); `B*`/`m*` → µT (magnetometer).
* **phyphox CSV:** also from the column names, all in m/s². `Acceleration x/y/z`
  ("Acceleration with g") includes gravity, so a still phone reads about 9.8 and `h = 1`
  is far below the resting level of the axis pointing up; `Linear Acceleration x/y/z`
  ("Acceleration without g") has gravity removed. `Absolute acceleration` takes the
  sensor of the x, y, z columns beside it.
* **Everything else:** inferred from the quietest one-second stretch of the magnitude.
  If its mean is much larger than its noise, gravity is present: about 1 means g,
  about 9.8 means m/s², anything else is flagged as unclear. If the mean is about the
  size of the noise, gravity has been removed (linear acceleration, probably m/s²).
  The course `Walking.mat` reads as gravity-removed.

## 6. Sampling

| Check | Level | Why |
|---|---|---|
| Rate measured as 1 / median interval | pass | Phone apps do not sample evenly. |
| Rate more than 5% away from 100 Hz | warn, while a Coza is on the plot | Coza divides by 100 and counts its window `w` in samples, so its durations are off by that much. With Resample on, the rate checked is the one Coza receives after resampling. |
| Rate below 10 Hz | warn | Too slow to resolve steps. |
| Repeated timestamps | warn | Common when sensors are interleaved. |
| Gaps longer than 5× the median interval | warn | Steps inside a gap cannot be detected. |
| Small backwards jumps | warn, rows sorted | Interleaved multi-sensor rows. |
| Backwards jump over max(1 s, 20× median interval) | error | Usually two recordings joined in one file. |
| No time column | info | Time comes from a sampling rate the user sets (default 100 Hz). |

### Resample (#52)

Off by default; no rate is built in. When on, the channel is put on an even grid before
anything else (filter, step detectors, envelopes, spectrum, exports), and the plot shows the
recording faded behind it. All checks come from `resampleChannel` in `src/core.js`.

| Check | Level | Why |
|---|---|---|
| Resampled to *N* Hz | info | Says from which rate, how many samples, the method (linear or pchip) and the anti-aliasing low-pass if it ran. |
| "To a rate" with no rate typed | warn + fix, not applied | Fix: type a rate. |
| Grid over 2,000,000 samples, or under 20 | warn + fix, not applied | Fix: a lower or a higher rate. |
| Going up in rate | info | Upsampling only draws lines or curves between samples; it adds no information. |
| Going down without anti-aliasing | info + fix | Anything above half the new rate folds back in as aliasing. Fix: turn on Anti-aliasing under Advanced. |
| Anti-aliasing on a recording with long gaps | warn + fix | The filter runs as if evenly sampled, which blurs its cut-off (as for the other filters). |
| Repeated timestamps | info | Averaged into one sample first, since interpolation needs one value per time. |
| Gaps over 5× the median interval | warn + fix | They are bridged with made-up values, so steps found there are not real. Fix: trim or split the recording. |

## 7. Channel values

| Check | Level | Why |
|---|---|---|
| Blank or non-numeric cells, with a time column | info / warn, rows skipped | Multi-record exports leave other sensors' cells blank. Timestamps keep the timing right, so skipping is safe. |
| Missing values, no time column, ≤ 1% | warn, interpolated | Dropping rows would shift the timing. |
| Missing values, no time column, > 1% | error | Too many to fill in honestly. |
| Constant signal | error | No peaks exist. |
| Runs at the extreme value lasting ≥ 3 samples and ≥ 20 ms | warn | Possible sensor clipping. The 20 ms floor stops values rounded to 0.01 from triggering it at high sampling rates. |
| Recording shorter than 3 s | warn | Too few steps for meaningful metrics. |
| Non-acceleration sensor | warn | Peaks may exist, but `h = 1` has no physical meaning. |
| Vertical or horizontal signal selected | info | Says how it was computed (x, y, z low-passed at 0.3 Hz give gravity's direction; vertical has gravity subtracted) and, for vertical, that `h` belongs near 0.1 g or 1 m/s² rather than 1. |
| Vertical or horizontal without gravity in the recording | error + fix (the options are disabled with the reason, so only reachable directly) | Linear Accelerometer exports and other gravity-removed files have no "down" to project onto. Fix: pick another signal, or record with the G-Force Meter. |

## 8. Filter

Only when a filter other than None is selected. The filter feeds every step detector and
envelope whose Source is Filtered (the default); one set to Unfiltered keeps the recorded
signal.

| Check | Level | Why |
|---|---|---|
| Settings can't be used (cut-off or notch frequency at or above half the sampling rate, high-pass not below low-pass, ripple or attenuation ≤ 0, elliptic attenuation not above its ripple, smoothing window under 3 samples (Savitzky–Golay: order + 2) or longer than the recording) | warn + fix, filter not applied | The message gives the allowed range or the shortest usable window. The low-pass and notch sliders already stop below half the sampling rate. |
| Timestamps vary by more than 1% | info, resampled | IIR filters need even spacing, so the signal is interpolated onto an even grid at the median rate, filtered, and read back at the original timestamps. |
| An even grid would be over 4× the recording (long gaps) | warn + fix, filtered as if even | Resampling across long gaps would make a huge grid; the cut-off is blurred instead. |
| High-pass on, with a detector that uses `h` on the filtered signal | info | The band-pass centres the signal on zero, so `h` means something else. Names the detectors. |

## 9. After detection

| Check | Level |
|---|---|
| No step detector on the plot | info: points to Add a step detector. |
| A detector with `h` finds no steps | warn, per detector: suggests checking units or lowering its `h`. |
| A detector without `h` finds no steps | warn, per detector: points to its settings. |
| Coza counts tied peaks twice | warn, per Coza on the plot: explains the effect on variability and asymmetry, and that Coza (modified) counts each once. |
| Weak peaks dropped by Coza (modified) | info: lists their times. They are under 40% of a typical peak's strength and out of rhythm (a gap to a neighbouring peak under 75% of the usual one, #81). |
| Steps 0.85–1.6 s apart | info: suggests they may be strides rather than steps, and to set Phone position to *One leg*. |
| The file says how many steps were counted by hand (`# steps_counted:` from the recorder) | info: each shown detector's step count against it, as a difference and a percentage; with Phone position *One leg*, each peak counts as 2 steps. The count is also in the metrics export (`steps_counted_by_hand`). |
| The synthetic walk (its true count, from its recipe; #81) | info: "The synthetic walk has 17 steps", with each detector's count against it, as for a hand count. Exported as `steps_in_synthetic_walk`. |
| No clear walking peak in the spectrum (nothing in 0.5–3.5 Hz at least 5× the band's median) | info: there is no spectral cadence to compare with; short or irregular walks, or mostly standing, do this. |
| Spectral cadence about 2× or ½ a detector's cadence | info: names the detectors; one side counts strides rather than steps; explains which is usual for the phone position. |
