"""
Python port of LabStepDet_2025.m, the step detector from BME 598/494 (Dr. Aurel Coza).

Faithful 1:1 translation of the MATLAB script: same algorithm, same
parameters, same outputs. Verified against the original run in Octave on
Walking.mat (identical step indices and metrics for columns 2, 3 and 4).

Usage (from the repo root):
    uv run python python/lab_step_det.py                     # data/Walking.mat, column 2
    uv run python python/lab_step_det.py --col 4             # pick column 2, 3 or 4
    uv run python python/lab_step_det.py --file data/Lab1Data.mat --var Lab1Data
    uv run python python/lab_step_det.py --no-plot           # print results only
    uv run python python/lab_step_det.py --file data/g_force_....csv --col 3 --w 60
                                          # Physics Toolbox or phyphox CSV: --col 2/3/4 = x/y/z
    uv run python python/lab_step_det.py --file data/g_force_....csv --resample 100
                                          # phone recorded at ~460 Hz -> 100 Hz first
    uv run python python/lab_step_det.py --file data/g_force_....csv --resample 100 --antialias
                                          # ... low-passed below 50 Hz first (--resample-method pchip: cubic)
    uv run python python/lab_step_det.py --file "data/Data from phyphox.zip" --col 4 --resample 100 --to-g
                                          # phyphox export zip; m/s^2 -> g for h = 1

Requirements: numpy, scipy, matplotlib (pinned in uv.lock; install with `uv sync`)
"""
import argparse
import csv
import os
import re
import warnings
import zipfile

import numpy as np
from scipy.io import loadmat


def detect_steps(A, w=30, h=1):
    """A sample is a step if it is the maximum of the window
    [i-w, i+w] around it AND that maximum is above threshold h.

    Returns (step_values, step_indices). Indices are 1-based so they
    match MATLAB's Step1 exactly.
    """
    step_vals, step_idx = [], []
    # MATLAB: for i = (w+1):length(A)-w   (1-based)
    # Python: i runs w .. len(A)-w-1       (0-based), window A[i-w : i+w+1]
    for i in range(w, len(A) - w):
        window_max = A[i - w:i + w + 1].max()
        if A[i] == window_max and window_max > h:
            step_vals.append(A[i])
            step_idx.append(i + 1)  # store 1-based, like MATLAB
    return np.array(step_vals), np.array(step_idx)


def gait_metrics(step_idx, fs=100):
    """Same formulas as the MATLAB script (fs=100 is the '/100' there)."""
    inter_step_distance = np.diff(step_idx)                      # in samples
    average_step_duration = inter_step_distance.mean() / fs      # seconds
    pace = average_step_duration * 60                            # as in original (see note)
    variability_steps = inter_step_distance.std(ddof=1)          # MATLAB std uses N-1
    # MATLAB (2:2:end) -> Python [1::2];  (1:2:end) -> [0::2]
    gait_asymmetry = (inter_step_distance[1::2].mean()
                      / inter_step_distance[0::2].mean())
    return {
        "inter_step_distance": inter_step_distance,
        "AverageStepDuration": average_step_duration,
        "Pace": pace,
        "VariabilitySteps": variability_steps,
        "GaitAsymmetry": gait_asymmetry,
    }


# --- Physics Toolbox and phyphox CSV input (the MATLAB script only reads .mat)
# Same rules as parseCsv/buildDataset in src/core.js, for the layouts the app
# exports: '#' metadata lines, ',' or ';' or tab delimiters (decimal comma with ';' or tab),
# units in headers ('ax (m/s^2)'), clock times ('13:05:10:006') and blank cells
# where several sensors take turns.

AXIS_NAMES = {  # header (unit suffix removed, lowercase) -> axis
    # Physics Toolbox (gFx: g with gravity; ax: m/s^2 without), generic names, and phyphox
    # ('Acceleration x': m/s^2 with gravity; 'Linear Acceleration x': m/s^2 without)
    "x": {"gfx", "ax", "x", "acc_x", "accx", "acceleration x", "linear acceleration x"},
    "y": {"gfy", "ay", "y", "acc_y", "accy", "acceleration y", "linear acceleration y"},
    "z": {"gfz", "az", "z", "acc_z", "accz", "acceleration z", "linear acceleration z"},
}
TIME_NAMES = {"time", "t", "elapsed", "timestamp", "seconds", "sec"}
CLOCK = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})(?:[:.](\d+))?$")


def _number(tok, decimal_comma):
    """One CSV cell -> float. Blank -> NaN, clock time -> seconds, text -> None."""
    s = tok.strip().strip('"')
    if s == "":
        return np.nan
    c = CLOCK.match(s)
    if c:
        frac = int(c[4]) / 10 ** len(c[4]) if c[4] else 0.0
        return int(c[1]) * 3600 + int(c[2]) * 60 + int(c[3]) + frac
    if decimal_comma:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _phyphox_meta_file(header_line):
    """Name of the phyphox metadata file this header belongs to, else None."""
    h = "|".join(v.strip().strip('"').lower() for v in re.split(r"[,;\t]", header_line))
    if h.startswith("event|experiment time|system time"):
        return "meta/time.csv, which holds only the times the recording started and paused"
    if h == "property|value":
        return "meta/device.csv, which describes the phone and its sensors"
    return None


def load_csv(path, text=None):
    """Read a Physics Toolbox or phyphox CSV into the Walking.mat layout.

    Returns (W, names): W has columns [time, x, y, z] (time starts at 0 s), so
    MATLAB column 2/3/4 means x/y/z exactly as in Walking.mat. Rows where any
    of the four is blank are dropped. names are the CSV headers used.
    text: the file's contents, when they come from somewhere else (a zip); path then
    only names it in messages.
    """
    if text is None:
        with open(path, encoding="utf-8-sig") as f:
            text = f.read()
    lines = [ln for ln in text.lstrip("\ufeff").splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    if len(lines) < 2:
        raise ValueError(f"{path} has fewer than 2 lines of data. "
                         "Record for longer, or check that the export completed.")
    if meta := _phyphox_meta_file(lines[0]):
        raise ValueError(f"{path} is phyphox's {meta}, not the sensor data. "
                         "Use the whole zip that phyphox exported, or the 'Raw Data.csv' inside it.")

    # Delimiter: the one that splits the first lines into the same, largest number of fields.
    sample = lines[:12]
    delim, best = ",", 1
    for d in ("\t", ";", ","):
        counts = {len(ln.split(d)) for ln in sample}
        if len(counts) == 1 and (n := counts.pop()) > best:
            delim, best = d, n
    decimal_comma = delim in ";\t" and any(re.search(r"\d,\d", ln) for ln in sample[1:])

    first = lines[0].split(delim)
    has_header = sum(_number(t, decimal_comma) is None for t in first) > len(first) / 2
    if has_header:
        headers = [h.strip().strip('"') for h in first]
        body = lines[1:]
    else:
        headers = [f"Column {k + 1}" for k in range(len(first))]
        body = lines

    rows = []
    for ln in body:
        vals = [_number(t, decimal_comma) for t in ln.split(delim)]
        vals = [np.nan if v is None else v for v in vals]
        rows.append((vals + [np.nan] * len(headers))[:len(headers)])
    data = np.array(rows, dtype=float)

    if has_header:
        keys = [re.sub(r"\s*\(.*\)\s*$", "", h).lower() for h in headers]
        cols = {}
        for role, names in [("time", TIME_NAMES), *AXIS_NAMES.items()]:
            cols[role] = next((k for k, key in enumerate(keys) if key in names), None)
        missing = [r for r in ("time", "x", "y", "z") if cols[r] is None]
        if missing:
            raise ValueError(
                f"{path}: no {', '.join(missing)} column among the headers {headers}. "
                "Export the G-Force Meter (gFx, gFy, gFz) or Linear Accelerometer "
                "(ax, ay, az) from Physics Toolbox, or Acceleration with g / without g "
                "(Acceleration x, Linear Acceleration x, ...) from phyphox, with the time "
                "column included.")
        order = [cols["time"], cols["x"], cols["y"], cols["z"]]
    else:
        if data.shape[1] < 4:
            raise ValueError(f"{path} has no header and only {data.shape[1]} columns. "
                             "Expected time, x, y, z; export with the header row.")
        order = [0, 1, 2, 3]  # like Walking.mat: time first, then x, y, z

    W = data[:, order]
    W = W[~np.isnan(W).any(axis=1)]
    if len(W) < 2:
        raise ValueError(f"{path}: fewer than 2 rows have time, x, y and z all filled in. "
                         "Check that the accelerometer was turned on while recording.")
    W[:, 0] -= W[0, 0]
    return W, [headers[k] for k in order]


def _meta_rows(text):
    """Rows of a phyphox meta file (quoted CSV in whichever delimiter the export used)."""
    lines = [ln for ln in text.lstrip("\ufeff").splitlines() if ln.strip()]
    if not lines:
        return []
    m = re.match(r'^"[^"]*"([,;\t])', lines[0])
    return [[v.strip() for v in row] for row in csv.reader(lines, delimiter=m[1] if m else ",")]


def _meta_number(s):
    try:
        return float(s.replace(",", "."))
    except (AttributeError, ValueError):
        return float("nan")


def load_phyphox(path):
    """Read a phyphox export zip ("Export data -> CSV") into the Walking.mat layout.

    Returns (W, names, info) like load_csv, from the zip's "Raw Data.csv" (else its
    largest CSV outside meta/), plus info: what meta/device.csv and meta/time.csv say
    (phone, phyphox version, sensor chip, start time, length) and "joins", the experiment
    times at which the recording was resumed after a pause. phyphox's experiment time
    leaves out pauses, so the stretches follow each other with no gap in the data.
    """
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise ValueError(f"{path} is not a zip file, or it is incomplete or damaged. "
                         "Export it from phyphox again, or unzip it and pass the CSV inside.") from None
    with z:
        files = [i for i in z.infolist() if not i.is_dir()]
        base = lambda i: i.filename.rsplit("/", 1)[-1]
        is_meta = lambda i: re.search(r"(^|/)meta/", i.filename) is not None
        csvs = [i for i in files if re.search(r"\.(csv|txt|tsv)$", i.filename, re.I) and not is_meta(i)
                and not i.filename.startswith("__MACOSX/")]
        if not csvs:
            what = ("holds an Excel export, not a CSV" if any(re.search(r"\.xlsx?$", i.filename, re.I) for i in files)
                    else f"holds no CSV file (it has: {', '.join(base(i) for i in files) or 'nothing'})")
            raise ValueError(f"{path} {what}. In phyphox, choose Export data -> CSV (comma, "
                             "decimal point), or pass the CSV itself.")
        data = next((i for i in csvs if base(i) == "Raw Data.csv"), max(csvs, key=lambda i: i.file_size))
        read = lambda i: z.read(i).decode("utf-8-sig")
        try:
            text = read(data)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as e:  # bad CRC, encrypted, unknown method
            raise ValueError(f"{data.filename} in {path} could not be read ({e}). "
                             "Unzip it yourself and pass the CSV inside.") from None
        meta = {base(i): _meta_rows(read(i)) for i in files if is_meta(i) and base(i) in ("device.csv", "time.csv")}
    W, names = load_csv(f"{path}:{data.filename}", text)

    props = {r[0]: r[1] for r in meta.get("device.csv", [])[1:] if len(r) > 1 and r[1] != "null"}
    header = text.splitlines()[0].lower() if text else ""
    sensor = ("linear_acceleration" if "linear acceleration" in header else
              "accelerometer" if re.search(r"acceleration [xyz]", header) else
              "gyroscope" if "gyroscope" in header else "magnetic_field" if "magnetic" in header else None)
    events = [(r[0].upper(), _meta_number(r[1]), r[3] if len(r) > 3 else "")
              for r in meta.get("time.csv", [])[1:] if len(r) > 1]
    events = [e for e in events if not np.isnan(e[1])]
    starts = [e for e in events if e[0] == "START"]
    brand, model = props.get("deviceManufacturer") or props.get("deviceBrand"), props.get("deviceModel")
    if brand and model and not model.lower().startswith(brand.lower()):
        model = f"{brand} {model}"
    chip = props.get(f"{sensor} Name") if sensor else None
    if chip and props.get(f"{sensor} Vendor"):
        chip += f" ({props[f'{sensor} Vendor']})"
    info = {
        "data_file": data.filename,
        "unused": [base(i) for i in csvs if i is not data],
        "model": model,
        "version": props.get("version"),
        "sensor": chip,
        "start": starts[0][2] if starts and starts[0][2] else None,
        "length": events[-1][1] if events and events[-1][0] == "PAUSE" else None,  # pauses left out
        "joins": [e[1] for e in starts[1:]],
    }
    return W, names, info


MAT_NUMERIC = {"double", "single", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"}


def load_mat(path, var):
    """A numeric variable from a .mat file, rows and columns as in MATLAB.

    v5-v7 files go through scipy's loadmat. v7.3 files are HDF5 behind a 512-byte MATLAB
    header, which scipy can't read, so they go through h5py; MATLAB stores matrices
    column-major, so the HDF5 array is transposed back. MATLAB equivalent: load(path, var).
    """
    with open(path, "rb") as f:
        v73 = b"MATLAB 7.3" in f.read(116)
    if not v73:
        m = loadmat(path)
        names = [k for k in m if not k.startswith("__")]
        if var not in m:
            raise ValueError(f"{path} has no variable {var!r}. It has: {', '.join(names) or 'none'}. Pick one with --var.")
        return m[var]
    import h5py  # only needed for v7.3 files
    try:
        f = h5py.File(path, "r")
    except OSError as e:
        raise ValueError(f"{path} is a MATLAB v7.3 file that could not be read ({e}). "
                         "In MATLAB, re-save it with save('myfile.mat','-v7'), or export the data as CSV.") from None
    with f:
        names = [k for k in f if not k.startswith("#")]
        if var not in f:
            raise ValueError(f"{path} has no variable {var!r}. It has: {', '.join(names) or 'none'}. Pick one with --var.")
        d = f[var]
        cls = d.attrs.get("MATLAB_class", b"")
        cls = cls.decode() if isinstance(cls, bytes) else str(cls)
        if not isinstance(d, h5py.Dataset) or cls not in MAT_NUMERIC or "MATLAB_empty" in d.attrs or d.dtype.names:
            kind = "struct" if isinstance(d, h5py.Group) else ("empty" if "MATLAB_empty" in d.attrs else "complex" if d.dtype.names else cls or "unknown")
            raise ValueError(f"{var!r} in {path} is a MATLAB {kind} variable, not a numeric matrix. "
                             f"Pick a numeric one with --var (it has: {', '.join(names)}), or in MATLAB save the "
                             f"samples as a plain matrix: save('myfile.mat','A','-v7').")
        return np.asarray(d[()], dtype=float).T


def sampling_rate(t):
    """Sampling rate in Hz from a time column in seconds: the mean of the gaps within half to
    1.5 times the median gap, like gapRate in src/core.js. The median alone is off when times
    are rounded (Firefox on Android: whole milliseconds, so 58.8 Hz for a 57.4 Hz recording);
    a plain mean would count dropped samples and pauses. Summed in order, as core.js does, so
    both ports give the same number to the last bit."""
    dt = np.diff(t)
    dt = dt[dt > 0]
    md = np.median(dt)
    total, n = 0.0, 0
    for d in dt[(dt >= 0.5 * md) & (dt <= 1.5 * md)]:
        total += float(d)
        n += 1
    return n / total


def _median_rate(t):
    """1 / the median gap: the even grid's rate in _even_grid and core.js evenGrid."""
    dt = np.diff(t)
    return 1 / np.median(dt[dt > 0])


def _time_in_column_1(data):
    """True when column 1 is a strictly increasing time column (Walking.mat layout)."""
    return data.ndim == 2 and data.shape[1] >= 2 and len(data) >= 3 and bool(np.all(np.diff(data[:, 0]) > 0))


STANDARD_GRAVITY = 9.80665  # m/s^2 in 1 g


def to_g(data):
    """m/s^2 -> g: divide by 9.80665, leaving a time column 1 alone.

    The lab threshold h = 1 assumes g; phyphox and Physics Toolbox's Linear Accelerometer
    record m/s^2. MATLAB equivalent: W(:,2:end) = W(:,2:end) / 9.80665;
    """
    out = np.array(data, dtype=float)
    if _time_in_column_1(out):
        out[:, 1:] /= STANDARD_GRAVITY
    else:
        out /= STANDARD_GRAVITY
    return out


def rate_warning(data, w=30):
    """Warning text when the data reaching Coza's algorithm is not at about 100 Hz, else None.

    Coza's algorithm divides sample counts by 100 to get seconds and counts its window w in
    samples, so both are only right at 100 Hz. The rate is measured from column 1 when it
    is a strictly increasing time column (Walking.mat layout, CSV exports, resampled data);
    a single vector with no time column (e.g. Lab1Data) gives no warning, since its rate
    is unknown.
    """
    if not _time_in_column_1(data):
        return None
    fs = sampling_rate(data[:, 0])
    if abs(fs - 100) <= 0.05 * 100:
        return None
    return (f"Warning: the data reaching Coza's algorithm is at about {fs:.0f} Hz, but Coza's algorithm "
            f"assumes 100 Hz. It divides by 100 to get seconds, so its durations are off by "
            f"{abs(100 / fs - 1):.0%}, and its window w = {w} samples covers +/-{w / fs:.3g} s "
            f"instead of +/-{w / 100:.3g} s. Add --resample 100 to put the data on a 100 Hz grid first.")


# Anti-aliasing before going down in rate: scipy.signal.decimate's IIR filter, a Chebyshev
# type I low-pass of order 8 with 0.05 dB ripple at 0.8 x the new Nyquist frequency.
ANTIALIAS_ORDER, ANTIALIAS_RIPPLE, ANTIALIAS_FRACTION = 8, 0.05, 0.8
EVEN_JITTER = 0.01  # timing variation above which a filter needs an even grid (core.js RESAMPLE_JITTER)


def _merge_repeats(t, Y):
    """Samples that share a timestamp, averaged into one. Returns (t, Y, merged count).

    Interpolation needs one value per time (MATLAB interp1 refuses repeated points)."""
    keep = np.r_[True, np.diff(t) > 0]
    if keep.all():
        return t, Y, 0
    starts = np.flatnonzero(keep)
    counts = np.diff(np.r_[starts, len(t)])
    return t[starts], np.add.reduceat(Y, starts, axis=0) / counts[:, None], len(t) - len(starts)


def _even_grid(t, Y):
    """Y on an even grid at the median rate, like evenGrid in src/core.js: unchanged when the
    timing varies by under 1%, or when long gaps would make the grid over 4x the recording."""
    dt = np.diff(t)
    dt = dt[dt > 0]
    md = np.median(dt)
    if not dt.std(ddof=1) / md > EVEN_JITTER:
        return t, Y
    m = int(np.floor((t[-1] - t[0]) / md)) + 1
    if m > 4 * len(t):
        return t, Y
    tg = t[0] + np.arange(m) * md
    return tg, np.column_stack([np.interp(tg, t, Y[:, c]) for c in range(Y.shape[1])])


def resample(W, fs, method="linear", antialias=False):
    """Put every column of W (column 0 = time in s) on a uniform grid
    t = 0, 1/fs, 2/fs, ... by interpolation.

    For phone recordings that are not at the rate an analysis assumes (Coza's algorithm: 100 Hz).
    method: "linear" (MATLAB interp1, the default) or "pchip" (monotone cubic, MATLAB
    interp1(..., 'pchip')). Samples sharing a timestamp are averaged first.
    antialias: when going down in rate, low-pass the signal below the new Nyquist frequency
    first (as MATLAB resample and scipy decimate do), so faster motion can't fold back in as
    aliasing. The filter runs on an even grid at the recording's median rate.
    MATLAB equivalent (linear): t2 = (0:1/fs:t(end)-t(1))'; A2 = interp1(t-t(1), A, t2);
    The same steps as resampleChannel in src/core.js, which matches this bit for bit (linear).
    """
    t = W[:, 0] - W[0, 0]
    if np.any(np.diff(t) < 0):
        raise ValueError("The time column goes backwards, so the data cannot be resampled. "
                         "Check that the file holds a single recording.")
    if method not in ("linear", "pchip"):
        raise ValueError(f"Unknown resampling method {method!r}: use 'linear' or 'pchip'.")
    t, Y, _ = _merge_repeats(t, W[:, 1:])
    t2 = np.arange(int(np.floor(t[-1] * fs + 1e-9)) + 1) / fs
    if antialias and fs < _median_rate(t):
        from scipy.signal import cheby1, sosfiltfilt
        t, Y = _even_grid(t, Y)
        sos = cheby1(ANTIALIAS_ORDER, ANTIALIAS_RIPPLE, ANTIALIAS_FRACTION * fs / 2, fs=_median_rate(t), output="sos")
        Y = sosfiltfilt(sos, Y, axis=0)
    if method == "pchip":
        from scipy.interpolate import PchipInterpolator
        return np.column_stack([t2, PchipInterpolator(t, Y, axis=0)(t2)])
    return np.column_stack([t2] + [np.interp(t2, t, Y[:, c]) for c in range(Y.shape[1])])


def gaps(t, factor=5):
    """Gaps between samples longer than factor x the median interval: (count, longest in s)."""
    dt = np.diff(t)
    long = dt[dt > factor * np.median(dt[dt > 0])]
    return len(long), (long.max() if len(long) else 0.0)


# --- export (#53): the dashboard's content model, Coza only (docs/export.md) ---------------

VERSION = "0.1.0"  # as in package.json, pyproject.toml and src/core.js
EXPORT_FORMAT_VERSION = 3
TEXT_COLUMNS = {"metric", "unit", "text", "id", "kind", "type", "name", "source", "color", "params", "settings", "plot"}
TABLES = ("indicators", "signals", "recorded", "steps", "metrics", "notes")
# Coza's credit as the dashboard writes it in the indicators table (creditText in src/core.js, #63)
COZA_CREDIT = "Dr. Aurel Coza (BME 598/494; LabStepDet_2025.m)"
RECORDS = ("about", "settings", "params", "spectrum")


def _timing(t, idx):
    """timingMetrics in src/core.js (one step per peak): intervals from the timestamps."""
    d = np.diff(np.asarray(t, float)[idx - 1])
    m = lambda a: a.mean() if len(a) else np.nan
    interval = m(d)
    sd = d.std(ddof=1) if len(d) > 1 else np.nan
    return {"steps": len(idx), "peaks": len(idx), "step_interval": interval, "cadence": 60 / interval,
            "variability_ms": sd * 1000, "cv": sd / interval * 100,
            "asymmetry": m(d[1::2]) / m(d[0::2]) if len(d[1::2]) and len(d[0::2]) else np.nan,
            "span": t[idx[-1] - 1] - t[idx[0] - 1] if len(idx) > 1 else np.nan}


def export_model(t, A, idx, about, settings, w=30, h=1):
    """The export model (format 3) for Coza's result: about, settings, one indicator (coza),
    signals (time_s, signal), steps (time_s, sample_matlab 1-based, value, coza), metrics
    (metric, unit, coza) and an empty notes table. Same layout as buildExport in
    src/core.js; the timing rows come from the timestamps, the coza_ rows from the .m file's
    formulas (gait_metrics). The harmonic ratio isn't ported, so it is NaN here."""
    with warnings.catch_warnings():  # mean/std of too few intervals
        warnings.simplefilter("ignore", RuntimeWarning)
        g = gait_metrics(idx)
        tm = _timing(t, idx)
    d = np.diff(idx)
    script_asym = g["GaitAsymmetry"] if len(d[1::2]) and len(d[0::2]) else np.nan
    rows = [
        ("steps", "count", tm["steps"]), ("peaks", "count", tm["peaks"]), ("step_interval", "s (timestamps)", tm["step_interval"]),
        ("cadence", "steps/min", tm["cadence"]), ("step_time_variability", "ms (SD)", tm["variability_ms"]),
        ("coefficient_of_variation", "%", tm["cv"]), ("gait_asymmetry", "even/odd intervals", tm["asymmetry"]), ("walking_span", "s", tm["span"]),
        ("harmonic_ratio", "even/odd harmonics per stride", np.nan),
        ("coza_average_step_duration", "s (samples/100, Coza\u2019s formula)", g["AverageStepDuration"]),
        ("coza_pace", "duration*60 (Coza\u2019s formula)", g["Pace"]),
        ("coza_variability", "samples (SD, Coza\u2019s formula)", g["VariabilitySteps"] if len(d) > 1 else np.nan),
        ("coza_gait_asymmetry", "even/odd sample intervals (Coza\u2019s formula)", script_asym),
    ]
    import json
    from datetime import datetime, timezone
    return {
        "about": {"format": "gaitscope-export", "format_version": EXPORT_FORMAT_VERSION, "generator": "gaitscope python port",
                  "version": VERSION, "exported": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "sample_numbers": "1-based, like MATLAB (sample_matlab)", "time": "s from the first sample of the recording", **about},
        "settings": settings,
        "params": {},
        "indicators": {"id": ["coza"], "kind": ["detector"], "type": ["coza_original"], "name": ["Coza"], "source": ["recorded"],
                       "color": ["c1"], "params": [json.dumps({"w": w, "h": h})], "settings": ["{}"], "credit": [COZA_CREDIT]},
        "signals": {"time_s": np.asarray(t, float), "signal": np.asarray(A, float)},
        "steps": {"time_s": np.asarray(t, float)[idx - 1], "sample_matlab": idx.astype(float),
                  "value": np.asarray(A, float)[idx - 1], "coza": ["step"] * len(idx)},
        "metrics": {"metric": [r[0] for r in rows], "unit": [r[1] for r in rows],
                    "coza": np.array([float(r[2]) if np.isfinite(r[2]) else np.nan for r in rows])},
        "notes": {"time_s": np.zeros(0), "plot": [], "kind": [], "x": np.zeros(0), "y": np.zeros(0), "text": []},
    }


def _plain(v):
    """JSON-ready: arrays to lists, NaN and infinities to None."""
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (np.ndarray, list, tuple)):
        return [_plain(x) for x in (v.tolist() if isinstance(v, np.ndarray) else v)]
    if isinstance(v, (float, np.floating)):
        return float(v) if np.isfinite(v) else None
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


def _kind(name, values):
    """'str', 'bool' or 'f8', as columnKind in src/core.js: by name, else by the values."""
    if name in TEXT_COLUMNS:
        return "str"
    first = next((v for v in values if v is not None and not (isinstance(v, float) and np.isnan(v))), None)
    return "str" if isinstance(first, str) else "bool" if isinstance(first, (bool, np.bool_)) else "f8"


def _column(name, values):
    kind = _kind(name, values)
    if kind == "str":
        return np.array(list(values), dtype=str) if len(values) else np.array([], dtype="<U1")
    if kind == "bool":
        return np.asarray(values, bool)
    return np.asarray(values, float)


def _number_text(v):
    """A number as JavaScript's String() writes it, so both ports' CSVs read the same:
    shortest round-trip digits, whole numbers without .0, exponents without padding."""
    v = float(v)
    if not np.isfinite(v):
        return ""
    if v.is_integer() and abs(v) < 1e21:
        return str(int(v))
    return re.sub(r"e([+-])0*(\d)", r"e\1\2", repr(v))


def write_export(model, path):
    """Write the export model to path; the extension picks the format: .json, .mat (v5, a
    struct 'gaitscope'), .npz (np.load(..., allow_pickle=False)) or .zip (a CSV per part)."""
    import json
    ext = path.rsplit(".", 1)[-1].lower()
    parts = [k for k in RECORDS + TABLES if k in model]
    if ext == "json":
        with open(path, "w", encoding="utf-8") as f:
            f.write("{\n" + ",\n".join(json.dumps(k) + ": " + json.dumps(_plain(model[k]), ensure_ascii=False) for k in parts) + "\n}\n")
    elif ext == "mat":
        from scipy.io import savemat
        out = {}
        for k in parts:
            if k in RECORDS:
                out[k] = {f: ("" if v is None else v) for f, v in model[k].items()}
            else:  # columns n x 1; text as a cell array
                out[k] = {c: (np.array(list(v), dtype=object).reshape(-1, 1) if _kind(c, v) == "str" else _column(c, v).reshape(-1, 1))
                          for c, v in model[k].items()}
        savemat(path, {"gaitscope": out})
    elif ext == "npz":
        arrays = {k: np.array(json.dumps(_plain(model[k]), ensure_ascii=False)) for k in parts if k in RECORDS}
        arrays.update({f"{k}/{c}": _column(c, v) for k in parts if k in TABLES for c, v in model[k].items()})
        np.savez(path, **arrays)
    elif ext == "zip":
        import csv
        import io
        with zipfile.ZipFile(path, "w") as z:
            for k in parts:
                buf = io.StringIO()
                w = csv.writer(buf, lineterminator="\n")
                if k in RECORDS:
                    w.writerow(["key", "value"])
                    w.writerows([f, json.dumps(v) if isinstance(v, dict) else v] for f, v in model[k].items())
                else:
                    cols = list(model[k])
                    w.writerow(cols)
                    cell = lambda v: (_number_text(v) if isinstance(v, (float, np.floating)) and not isinstance(v, (bool, np.bool_))
                                      else str(v).lower() if isinstance(v, (bool, np.bool_)) else v)
                    w.writerows([cell(model[k][c][i]) for c in cols] for i in range(len(model[k][cols[0]])))
                z.writestr(f"{k}.csv", buf.getvalue())
    else:
        raise ValueError(f"Can't export to {path!r}: use .json, .mat, .npz or .zip.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--file", default="data/Walking.mat",
                   help=".mat file, a Physics Toolbox or phyphox .csv export, or a phyphox .zip export")
    p.add_argument("--var", default="Walking", help="variable name inside the .mat")
    p.add_argument("--col", type=int, default=2,
                   help="MATLAB-style column number: 2, 3 or 4 (1 = time)")
    p.add_argument("--w", type=int, default=30, help="half-window in samples")
    p.add_argument("--h", type=float, default=1, help="peak threshold")
    p.add_argument("--resample", type=float, metavar="HZ",
                   help="resample to HZ (e.g. 100) first; needs time in column 1")
    p.add_argument("--resample-method", choices=["linear", "pchip"], default="linear",
                   help="linear (MATLAB interp1, the default) or pchip (monotone cubic)")
    p.add_argument("--antialias", action="store_true",
                   help="when --resample goes down in rate, low-pass below the new Nyquist "
                        "frequency first (Chebyshev I, order 8, like scipy decimate)")
    p.add_argument("--to-g", action="store_true",
                   help="divide by 9.80665 (m/s^2 -> g) first, since h = 1 assumes g; "
                        "for phyphox or Linear Accelerometer data")
    p.add_argument("--export", metavar="FILE",
                   help="save the result: .json, .mat, .npz or .zip (a CSV per part); see docs/export.md")
    p.add_argument("--no-plot", action="store_true", help="skip the plot window")
    args = p.parse_args()
    if args.export and not args.export.lower().endswith((".json", ".mat", ".npz", ".zip")):
        p.error(f"Can't export to {args.export!r}: use .json, .mat, .npz or .zip.")

    names = info = None
    try:
        if args.file.lower().endswith(".zip"):
            data, names, info = load_phyphox(args.file)
        elif args.file.lower().endswith((".csv", ".txt", ".tsv")):
            data, names = load_csv(args.file)
        else:
            data = load_mat(args.file, args.var)
    except ValueError as e:
        p.error(str(e))
    if info:
        print(f"phyphox export:      {info['data_file']!r} from the zip"
              + "".join(f", {v}" for v in (info["model"], info["version"] and f"phyphox {info['version']}") if v))
        if info["unused"]:
            print(f"  Also in the zip, not used: {', '.join(info['unused'])}")
        if info["sensor"]:
            print(f"Sensor:              {info['sensor']}")
        if info["start"] or info["length"] is not None:
            print("Recording:           " + ", ".join(v for v in (
                info["start"] and f"started {info['start']}",
                info["length"] is not None and f"{info['length']:.1f} s long") if v))
        if info["joins"]:
            n = len(info["joins"])
            print(f"  Warning: the recording was paused {n} time{'s' * (n > 1)}. phyphox's time leaves out "
                  f"pauses, so the stretches are joined with no gap at "
                  f"{', '.join(f'{t:.1f} s' for t in info['joins'])}. A step across a join can be "
                  f"missed or counted twice, and the interval across it is wrong.")
    if names:
        fs = sampling_rate(data[:, 0])
        print(f"CSV columns:         time = {names[0]!r}, x = {names[1]!r}, "
              f"y = {names[2]!r}, z = {names[3]!r} (--col 2/3/4)")
        print(f"Sampling rate:       about {fs:.0f} Hz")
        x_name = names[1].lower()
        if x_name.startswith(("ax", "linear acceleration")):
            print("  Note: linear acceleration is in m/s^2 without gravity; "
                  "h = 1 was chosen for G-Force Meter data (g, gravity included).")
        elif x_name.startswith("acceleration"):
            print("  Note: phyphox acceleration is in m/s^2 with gravity (a still phone reads "
                  "about 9.8); h = 1 was chosen for data in g." + ("" if args.to_g else " Add --to-g to convert."))
    if args.resample:
        if data.ndim != 2 or data.shape[1] < 2:
            p.error("--resample needs a time column in column 1 and data after it.")
        before, t = sampling_rate(data[:, 0]), data[:, 0]
        repeats = int(np.sum(np.diff(t) == 0))
        n_gaps, longest = gaps(t)
        try:
            data = resample(data, args.resample, method=args.resample_method, antialias=args.antialias)
        except ValueError as e:
            p.error(str(e))
        how = "linear interpolation, like MATLAB interp1" if args.resample_method == "linear" else "pchip, a monotone cubic"
        down = args.resample < before
        if args.antialias and down:
            how += f", low-passed at {ANTIALIAS_FRACTION * args.resample / 2:g} Hz first"
        print(f"Resampled:           about {before:.0f} Hz -> {args.resample:g} Hz ({how}), {len(data)} samples")
        if repeats:
            print(f"  {repeats} repeated timestamp{'s' * (repeats > 1)} averaged first.")
        if n_gaps:
            print(f"  Warning: {n_gaps} gap{'s' * (n_gaps > 1)} in the recording (longest {longest:.2f} s) "
                  "filled with made-up values; steps found there are not real.")
        if args.resample > before * 1.01:
            print("  Note: upsampling adds no information; it only draws lines between the recorded samples.")
        elif down and args.resample < before * 0.99 and not args.antialias:
            print(f"  Note: anything faster than {args.resample / 2:g} Hz in the recording folds back in "
                  "(aliasing). Add --antialias to low-pass first.")
    if args.to_g:
        data = to_g(data)
        print(f"Converted:           m/s^2 -> g (divided by {STANDARD_GRAVITY})")
    # checked on what Coza's algorithm actually gets: after resampling, and for .mat files too
    warning = rate_warning(data, args.w)
    if warning:
        print("  " + warning)
    # MATLAB column c -> Python column c-1. If the variable is a single
    # vector (e.g. Lab1Data), use it directly.
    A = data[:, args.col - 1] if data.ndim == 2 and data.shape[1] > 1 else data.ravel()

    step_vals, step_idx = detect_steps(A, w=args.w, h=args.h)
    with warnings.catch_warnings():  # numpy warns on mean/std of too few intervals
        warnings.simplefilter("ignore", RuntimeWarning)
        m = gait_metrics(step_idx)

    print(f"Steps detected:      {len(step_idx)}")
    print(f"Step indices:        {step_idx.tolist()}")
    print(f"AverageStepDuration: {m['AverageStepDuration']:.4f} s")
    print(f"Pace:                {m['Pace']:.4f}")
    print(f"VariabilitySteps:    {m['VariabilitySteps']:.4f} samples")
    print(f"GaitAsymmetry:       {m['GaitAsymmetry']:.4f}")
    if args.export:
        timed = _time_in_column_1(data)
        t = data[:, 0] - data[0, 0] if timed else np.arange(len(A)) / 100
        about = {"file": os.path.basename(args.file), "variable": args.var if not names else "",
                 "signal": f"column {args.col}", "signal_name": names[args.col - 1] if names else f"Column {args.col}", "unit": ""}
        settings = {"resample": f"{args.resample:g} Hz, {args.resample_method}" + (", anti-aliased" if args.antialias else "") if args.resample else "off",
                    "to_g": bool(args.to_g)}
        if timed:
            settings["sampling_rate_hz"] = float(sampling_rate(data[:, 0]))
        try:
            write_export(export_model(t, A, step_idx, about, settings, w=args.w, h=args.h), args.export)
        except ValueError as e:
            p.error(str(e))
        print(f"Exported:            {args.export}")
    if len(step_idx) < 3:
        print("  Note: fewer than 3 steps, so some metrics are NaN (not enough intervals).")
        if np.nanmax(A) <= args.h:
            print(f"  The signal never goes above h = {args.h:g} (its maximum is "
                  f"{np.nanmax(A):.3f}). With G-Force data, gravity adds about 1 g only "
                  f"to the axis that points up, so try that axis or lower --h.")

    if args.no_plot:
        return
    import matplotlib.pyplot as plt  # imported here so tests and CI need no display

    # plot(A); scatter(Step1, Step)  -- x-axis in 1-based samples like MATLAB
    plt.plot(np.arange(1, len(A) + 1), A)
    plt.scatter(step_idx, step_vals, color="red", zorder=3)
    plt.xlabel("Sample")
    plt.ylabel(f"Column {args.col}")
    plt.title(f"Detected steps: {len(step_idx)}")
    plt.show()


if __name__ == "__main__":
    main()
