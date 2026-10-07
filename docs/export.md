# Export formats

The dashboard's **Export…** menu and the Python port's `--export FILE` write one content
model in several formats. This page describes that model (format version 1) and how each
format stores it. The code is `buildExport` and the `export*` writers in `src/core.js`, and
`export_model` / `write_export` in `python/lab_step_det.py`.

## Formats

| Format | File | For | Opens with |
|---|---|---|---|
| CSV, separate files | `<name>_metrics.csv`, `<name>_steps.csv` | Excel; the layout from before #53, unchanged | anything |
| CSV, one zip | `<name>_gaitscope.zip` with `about.csv`, `settings.csv`, `params.csv`, `signals.csv`, `recorded.csv`, `steps.csv`, `metrics.csv`, `notes.csv` | Excel, R, anything | unzip, then any CSV reader |
| MATLAB | `<name>_gaitscope.mat` (v5) | MATLAB, Octave | `load('x_gaitscope.mat')`, then `struct2table(gaitscope.steps)` |
| NumPy | `<name>_gaitscope.npz` | Python | `np.load('x_gaitscope.npz', allow_pickle=False)` |
| JSON | `<name>_gaitscope.json` | reopening in the dashboard; web tools | the dashboard (drop it in like a recording), `json.load`, `jsonlite::fromJSON` |

The dashboard writes the files without compression. It loads only pako's inflate, so
`.mat` is uncompressed (like scipy's `savemat` default), and `.zip` and `.npz` entries are
stored (`.npz` is uncompressed anyway, as with `np.savez`).

Pickle is deliberately not offered. Loading a pickle can run arbitrary code, and nothing
outside Python reads it. `.npz` holds the same arrays safely.

## The model

Seven parts. `about`, `settings` and `params` are records (key → value). The others are
tables: columns of equal length.

**Sample numbers are 1-based everywhere**, like MATLAB and the lab code's output, and the
column says so: `sample_matlab`. Sample 1 is the first sample of the analysed signal.
Times are in seconds from the first sample of the recording.

### about

| Key | Meaning |
|---|---|
| `format` | always `gaitscope-export` |
| `format_version` | `1`; a later layout gets a higher number, and readers refuse versions newer than they know |
| `generator` | `gaitscope dashboard` or `gaitscope python port` |
| `version` | gaitscope's version (`package.json`, `pyproject.toml`) |
| `exported` | export time, ISO 8601 in UTC |
| `sample_numbers`, `time` | the two conventions above, in words |
| `file`, `variable` | the source file, and the MAT variable (empty for CSV) |
| `signal` | the analysed signal as the dashboard labels it, e.g. `x (column 2)`, `vertical (computed)` |
| `signal_name` | its column name in the file (e.g. `gFy (g)`), which sets its units on reopening |
| `unit` | its unit, when known (`g`, `m/s²`, …) |

### settings

What produced the result, readable as is. The dashboard writes `algorithm`, `algorithm_id`,
the algorithm's own settings (as in the metrics CSV, e.g. `coza_window_s`), `filter`,
`filter_resampled`, `envelope`, `resample`, `sampling_rate_hz`, `recorded_rate_hz`,
`window_w_samples`, `threshold_h`, `spectrum_segment_s`, `phone_position` and, for a
recording with a hand count (#51), `steps_counted_by_hand`. The Python port writes
`algorithm` (`lab code`), `window_w_samples`, `threshold_h`, `resample`, `to_g` and
`sampling_rate_hz`.

### params

The dashboard's controls as they were, keyed as in the page (`w`, `h`, `filter`,
`algorithm`, `envelope`, `fOrder`, `cozaWindow`, …). Reopening a JSON export sets them back.
Empty from the Python port.

### signals (table)

One row per analysed sample. Present unless Signals was unticked.

| Column | Meaning |
|---|---|
| `time_s` | time of the sample (s) |
| `signal` | the signal the lab code gets: the recorded channel, resampled when Resample is on (#52) |
| `filtered` | what the algorithm gets, when a filter is on |
| `envelope_lower`, `envelope_upper`, `envelope_mid` | the envelope shown on the plot, when Envelope is ticked (a view; it never changes steps) |

### recorded (table)

Only when the signal was resampled: the channel before resampling, `time_s` and `value`.

### steps (table)

Every peak either version marked, in time order.

| Column | Meaning |
|---|---|
| `time_s`, `sample_matlab`, `value` | where the peak is, and the signal's value there |
| `in_lab_code` | true if the lab code marked it |
| `in_algorithm` | true if the selected algorithm kept it (dashboard only) |
| `algorithm_status` | `kept`, `weak peak`, `tied peak` (the lab code's double count), or `not found by <algorithm>` (dashboard only) |

### metrics (table)

One row per metric. NaN (empty in CSV, `null` in JSON) where a version doesn't compute it.

| Column | Meaning |
|---|---|
| `metric` | `steps`, `average_step_duration`, `cadence`, `pace_lab_formula`, `step_time_variability` (`stride_time_variability` with Phone position *One leg*), `coefficient_of_variation`, `gait_asymmetry`, `cadence_spectrum`, `harmonic_ratio` |
| `lab_code`, `unit_lab_code` | the lab code's value and unit (its durations are samples ÷ 100) |
| `algorithm`, `unit_algorithm` | the selected algorithm's value and unit, from the timestamps (dashboard only) |

### notes (table)

`time_s` and `text` of the notes pinned to the plot. Empty from the Python port.

## How each format stores it

* **JSON:** the model as one object, one line per part. NaN and infinities become `null`.
  Numbers are written in full, so they read back exactly.
* **CSV zip:** a records file has `key,value` rows (a nested value as JSON text), and a table
  file has one header row of column names. Numbers are written in full; true/false are
  `true`/`false`; NaN is an empty cell. Text with commas or quotes is quoted, as usual in CSV.
* **MATLAB:** one struct, `gaitscope`, with a field per part. A record becomes a struct of
  scalars, text and logicals; a table becomes a struct of n×1 columns. Numbers are
  `double`, true/false columns are `logical`, and text columns are cell arrays of `char`.
  `struct2table(gaitscope.steps)` gives a table. Characters beyond U+FFFF (emoji) become
  U+FFFD, since MATLAB's `char` holds them as two characters and scipy can't read them back.
* **NumPy:** `about`, `settings` and `params` are 0-d text arrays holding JSON
  (`json.loads(str(z['settings']))`). Each table column is its own array, named
  `table/column` (`z['steps/sample_matlab']`): `float64`, `bool`, or fixed-width unicode
  text (`<U…`). Nothing needs pickling.

## Reopening an analysis

Drop a JSON export onto the dashboard like any recording. It loads `signals.signal` at
`signals.time_s` as the channel (Resample is set to off, since the signal is already the
analysed one). It sets every control from `params` and restores the notes, so the lab code
and the algorithm find the same steps and metrics as when it was exported.
