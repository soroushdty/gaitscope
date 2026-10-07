# Export formats

The dashboard's **Export…** menu and the Python port's `--export FILE` write one content
model in several formats. This page describes that model (format version 2) and how each
format stores it. The code is `buildExport` and the `export*` writers in `src/core.js`, and
`export_model` / `write_export` in `python/lab_step_det.py`.

## Formats

| Format | File | For | Opens with |
|---|---|---|---|
| CSV, separate files | `<name>_metrics.csv` (metrics, then the settings, each indicator as a line, and notes), `<name>_steps.csv` | Excel | anything |
| CSV, one zip | `<name>_gaitscope.zip` with `about.csv`, `settings.csv`, `params.csv`, `spectrum.csv`, `indicators.csv`, `signals.csv`, `recorded.csv`, `steps.csv`, `metrics.csv`, `notes.csv` | Excel, R, anything | unzip, then any CSV reader |
| MATLAB | `<name>_gaitscope.mat` (v5) | MATLAB, Octave | `load('x_gaitscope.mat')`, then `gaitscope.steps.time_s` etc.; in MATLAB, `struct2table(gaitscope.steps)` gives a table (Octave has no tables) |
| NumPy | `<name>_gaitscope.npz` | Python | `np.load('x_gaitscope.npz', allow_pickle=False)` |
| JSON | `<name>_gaitscope.json` | reopening in the dashboard; web tools | the dashboard (drop it in like a recording), `json.load`, `jsonlite::fromJSON` |

The dashboard writes the files without compression. It loads only pako's inflate, so
`.mat` is uncompressed (like scipy's `savemat` default), and `.zip` and `.npz` entries are
stored (`.npz` is uncompressed anyway, as with `np.savez`).

Pickle is deliberately not offered. Loading a pickle can run arbitrary code, and nothing
outside Python reads it. `.npz` holds the same arrays safely.

## The model

Nine parts. `about`, `settings`, `params` and `spectrum` are records (key → value). The
others are tables: columns of equal length. What is exported is what is shown: the step
detectors and envelopes on the plot, not hidden ones.

**Sample numbers are 1-based everywhere**, like MATLAB and Coza's `.m` output, and the
column says so: `sample_matlab`. Sample 1 is the first sample of the analysed signal.
Times are in seconds from the first sample of the recording.

Each indicator (step detector or envelope) has a short **id** that works as a MATLAB field
name: `coza` (Coza), `coza_modified` (Coza (modified)), `threshold`, `peakvalley`,
`zerocross`, `sliding`, `meansd`, …, with `_2`, `_3` for a second and third of the same
kind. The ids name the columns of `steps` and `metrics` and the envelope columns of
`signals`.

### about

| Key | Meaning |
|---|---|
| `format` | always `gaitscope-export` |
| `format_version` | `2` (indicators). Version 1 had one algorithm next to the course code. Readers refuse versions newer than they know, and the dashboard reopens version 1 as Coza plus that algorithm. |
| `generator` | `gaitscope dashboard` or `gaitscope python port` |
| `version` | gaitscope's version (`package.json`, `pyproject.toml`) |
| `exported` | export time, ISO 8601 in UTC |
| `sample_numbers`, `time` | the two conventions above, in words |
| `file`, `variable` | the source file, and the MAT variable (empty for CSV) |
| `signal` | the analysed signal as the dashboard labels it, e.g. `x (column 2)`, `vertical (computed)` |
| `signal_name` | its column name in the file (e.g. `gFy (g)`), which sets its units on reopening |
| `unit` | its unit, when known (`g`, `m/s²`, …) |

### settings

What produced the result, readable as is: `signal`, `sampling_rate_hz`,
`recorded_rate_hz`, `resample`, `filter`, `filter_resampled`, `spectrum_segment_s`,
`phone_position` and, for a recording with a hand count (#51), `steps_counted_by_hand`, or for
the synthetic walk its true count, `steps_in_synthetic_walk` (#81).
The Python port writes `resample`, `to_g` and `sampling_rate_hz`.

### params

The page-wide controls as they were, keyed as in the page (`filter`, `fOrder`, `fLow`, …,
`specSeg`, `phone_position`). Reopening a JSON export sets them back. Empty from the
Python port.

### spectrum

`dominant_hz` (the strongest walking frequency, NaN if none is clear), `cadence_steps_min`
(60 × that, × 2 with Phone position *One leg*) and `segment_s` (Welch's segment length).
Dashboard only.

### indicators (table)

One row per step detector and envelope on the plot.

| Column | Meaning |
|---|---|
| `id` | the short id above |
| `kind` | `detector` or `envelope` |
| `type` | which one: `coza_original` (Coza), `coza` (Coza (modified)), `threshold`, …, `sliding`, … |
| `name` | as the page labels it (`Coza`, `Coza 2`, …) |
| `source` | `filtered` or `recorded` (Unfiltered) |
| `color` | its colour slot, `c1`…`c6` |
| `params` | its settings as JSON text, e.g. `{"w":30,"h":1}` |
| `settings` | what a detector derived from them, as JSON text, e.g. `{"coza_window_samples":30}` |
| `credit` | who made it, as one line: `Surname et al., Year (what for) https://doi.org/…`, several joined with `; `; empty when none is needed (see `docs/algorithm.md`, Credits) |

### signals (table)

One row per analysed sample. Present unless Signals was unticked.

| Column | Meaning |
|---|---|
| `time_s` | time of the sample (s) |
| `signal` | the analysed signal: the recorded channel, resampled when Resample is on (#52) |
| `filtered` | the filtered signal, when a filter is on |
| `<id>_lower`, `<id>_upper`, `<id>_mid` | each envelope, when Envelopes is ticked (a view; it never changes steps) |

### recorded (table)

Only when the signal was resampled: the channel before resampling, `time_s` and `value`.

### steps (table)

Every sample any detector marked, or dropped as a weak peak, in time order.

| Column | Meaning |
|---|---|
| `time_s`, `sample_matlab`, `value` | where the peak is, and the signal's value there |
| `<id>` (one per detector) | `step` if that detector counts it, `weak peak` if it found and dropped it (Coza (modified)), empty otherwise. Coza's tied peaks are two `step` rows a sample or two apart, with Coza (modified) empty on the second. |

### metrics (table)

One row per metric, one column per detector. NaN (empty in CSV, `null` in JSON) where a
detector has no value.

| Column | Meaning |
|---|---|
| `metric` | `steps`, `peaks`, `step_interval`, `cadence`, `step_time_variability` (`stride_time_variability` with Phone position *One leg*), `coefficient_of_variation`, `gait_asymmetry`, `walking_span`, `harmonic_ratio`, then Coza's own outputs from the `.m` file: `coza_average_step_duration` (samples ÷ 100), `coza_pace` (duration × 60), `coza_variability` (samples), `coza_gait_asymmetry` (sample intervals) |
| `unit` | the row's unit |
| `<id>` (one per detector) | that detector's value. The `coza_` rows have values only for Coza; the others come from the timestamps for every detector. The Python port has no harmonic ratio (NaN). |

### notes (table)

`time_s` and `text` of the notes pinned to the plot. Empty from the Python port.

## How each format stores it

* **JSON:** the model as one object, one line per part. NaN and infinities become `null`.
  Numbers are written in full, so they read back exactly in JavaScript, Python and R. Octave's
  `jsondecode` (11.1) can be one unit off in the last binary digit; in Octave, use the `.mat`.
* **CSV zip:** a records file has `key,value` rows (a nested value as JSON text), and a table
  file has one header row of column names. Numbers are written in full; true/false are
  `true`/`false`; NaN is an empty cell. Text with commas or quotes is quoted, as usual in CSV.
* **MATLAB:** one struct, `gaitscope`, with a field per part. A record becomes a struct of
  scalars, text and logicals; a table becomes a struct of n×1 columns. Numbers are
  `double`, true/false columns are `logical`, and text columns are cell arrays of `char`.
  In MATLAB, `struct2table(gaitscope.steps)` gives a table; Octave has no table type, so use
  the fields (`gaitscope.steps.time_s`). Checked by loading it in GNU Octave 11.1
  (`tests/core.test.js`, run when `octave-cli` is installed). Characters beyond U+FFFF (emoji) become
  U+FFFD, since MATLAB's `char` holds them as two characters and scipy can't read them back.
* **NumPy:** `about`, `settings`, `params` and `spectrum` are 0-d text arrays holding JSON
  (`json.loads(str(z['settings']))`). Each table column is its own array, named
  `table/column` (`z['steps/sample_matlab']`, `z['metrics/coza']`): `float64`, `bool`, or
  fixed-width unicode text (`<U…`). Nothing needs pickling.

## Reopening an analysis

Drop a JSON export onto the dashboard like any recording. It loads `signals.signal` at
`signals.time_s` as the channel (Resample is set to off, since the signal is already the
analysed one). It sets every control from `params`, puts the indicators back from
`indicators` (type, settings, source, colour), and restores the notes, so every detector
finds the same steps and metrics as when it was exported.
