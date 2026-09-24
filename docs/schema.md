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

All checks live in `src/core.js` (`parseMat`, `matCandidates`, `parseCsv`,
`buildDataset`, `prepareChannel`) and in `derivedChecks()` in `src/app.js`.

## 1. File

| Check | Level | Why |
|---|---|---|
| Size ≤ 50 MB, not empty | error | Keeps the browser responsive. |
| MAT v5–v7 (MATLAB or Octave, compressed or not) | — | The format MATLAB writes by default. |
| MAT v7.3 (HDF5) | error | Browsers need a large WebAssembly HDF5 library to read it. Fix: `save('f.mat','-v7')`. |
| MAT v4 | error | Obsolete. Fix: re-save with `-v7`. |
| Text file named `.mat` | warn / error | Read as CSV if it parses; otherwise told to rename it. |
| Random or corrupted bytes, truncated blocks | error | Detected from the header and element sizes. |
| CSV lines starting with `#` | skipped | Newer Physics Toolbox exports start with metadata lines (`# sensor:g_force`, `# Requested Sample Rate: …`). |

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
| **x, y, z** | CSV: Physics Toolbox names (`gFx`, `ax`, `wx`, …) or `x`, `acc_x`, …; MAT: the three columns after time. |
| **Magnitude** | CSV: `TgF`, `aT`, `total`, `magnitude`, …; MAT: a column that equals √(x²+y²+z²) within rounding. |
| **Other** | Kept with generic names and still selectable. |

If x, y and z are known but no magnitude column exists, a computed magnitude is offered.
MAT columns keep their MATLAB numbers in labels ("x (column 2)") so they map directly
onto `Walking(:,2)` in the lab code.

## 5. Units

The lab threshold `h = 1` is in the signal's own units, so units matter most of all:
in g, walking peaks can stay below 1 and the lab code would report almost no steps
without any error.

* **Physics Toolbox CSV:** read from the column names. `gF*` → g, including gravity;
  `a*` → m/s², gravity removed; `w*` → rad/s (gyroscope, warned as "not an acceleration
  signal"); `B*`/`m*` → µT (magnetometer).
* **Everything else:** inferred from the quietest one-second stretch of the magnitude.
  If its mean is much larger than its noise, gravity is present: about 1 means g,
  about 9.8 means m/s², anything else is flagged as unclear. If the mean is about the
  size of the noise, gravity has been removed (linear acceleration, probably m/s²).
  The course `Walking.mat` reads as gravity-removed.

## 6. Sampling

| Check | Level | Why |
|---|---|---|
| Rate measured as 1 / median interval | pass | Phone apps do not sample evenly. |
| Rate more than 5% away from 100 Hz | warn | The lab code divides by 100, so its durations are off by that much. |
| Rate below 10 Hz | warn | Too slow to resolve steps. |
| Repeated timestamps | warn | Common when sensors are interleaved. |
| Gaps longer than 5× the median interval | warn | Steps inside a gap cannot be detected. |
| Small backwards jumps | warn, rows sorted | Interleaved multi-sensor rows. |
| Backwards jump over max(1 s, 20× median interval) | error | Usually two recordings joined in one file. |
| No time column | info | Time comes from a sampling rate the user sets (default 100 Hz). |

## 7. Channel values

| Check | Level | Why |
|---|---|---|
| Blank or non-numeric cells, with a time column | info / warn, rows skipped | Multi-record exports leave other sensors' cells blank. Timestamps keep the timing right, so skipping is safe. |
| Missing values, no time column, ≤ 1% | warn, interpolated | Dropping rows would shift the timing. |
| Missing values, no time column, > 1% | error | Too many to fill in honestly. |
| Constant signal | error | No peaks exist. |
| Runs at the extreme value | warn | Possible sensor clipping. |
| Recording shorter than 3 s | warn | Too few steps for meaningful metrics. |
| Non-acceleration sensor | warn | Peaks may exist, but `h = 1` has no physical meaning. |

## 8. After detection

| Check | Level |
|---|---|
| No steps above `h` | warn: suggests checking units or lowering `h`. |
| Lab code counts tied peaks twice | warn: explains the effect on variability and asymmetry. |
| Weak peaks dropped by the fixed version | info: lists their times. |
| Peaks 0.85–1.6 s apart | info: suggests they may be strides rather than steps. |
