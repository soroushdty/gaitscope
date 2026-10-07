"""
Python port of LabStepDet_2025.m (Wearable Devices Lab 1 - step detection).

Faithful 1:1 translation of the MATLAB script: same algorithm, same
parameters, same outputs. Verified against the original run in Octave on
Walking.mat (identical step indices and metrics for columns 2, 3 and 4).

Usage (from the repo root):
    uv run python python/lab_step_det.py                     # data/Walking.mat, column 2
    uv run python python/lab_step_det.py --col 4             # pick column 2, 3 or 4
    uv run python python/lab_step_det.py --file data/Lab1Data.mat --var Lab1Data
    uv run python python/lab_step_det.py --no-plot           # print results only
    uv run python python/lab_step_det.py --file data/g_force_....csv --col 3 --w 60
                                          # Physics Toolbox CSV: --col 2/3/4 = x/y/z
    uv run python python/lab_step_det.py --file data/g_force_....csv --resample 100
                                          # phone recorded at ~460 Hz -> 100 Hz first

Requirements: numpy, scipy, matplotlib (pinned in uv.lock; install with `uv sync`)
"""
import argparse
import re
import warnings

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


# --- Physics Toolbox CSV input (the MATLAB script only reads .mat) ---------
# Same rules as parseCsv/buildDataset in src/core.js, for the layouts the app
# exports: '#' metadata lines, ',' or ';' (decimal comma) or tab delimiters,
# units in headers ('ax (m/s^2)'), clock times ('13:05:10:006') and blank cells
# where several sensors take turns.

AXIS_NAMES = {  # header (unit suffix removed, lowercase) -> axis
    "x": {"gfx", "ax", "x", "acc_x", "accx"},
    "y": {"gfy", "ay", "y", "acc_y", "accy"},
    "z": {"gfz", "az", "z", "acc_z", "accz"},
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


def load_csv(path):
    """Read a Physics Toolbox CSV into the Walking.mat layout.

    Returns (W, names): W has columns [time, x, y, z] (time starts at 0 s), so
    MATLAB column 2/3/4 means x/y/z exactly as in Walking.mat. Rows where any
    of the four is blank are dropped. names are the CSV headers used.
    """
    with open(path, encoding="utf-8-sig") as f:
        lines = [ln.rstrip("\r\n") for ln in f]
    lines = [ln for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]
    if len(lines) < 2:
        raise ValueError(f"{path} has fewer than 2 lines of data. "
                         "Record for longer, or check that the export completed.")

    # Delimiter: the one that splits the first lines into the same, largest number of fields.
    sample = lines[:12]
    delim, best = ",", 1
    for d in ("\t", ";", ","):
        counts = {len(ln.split(d)) for ln in sample}
        if len(counts) == 1 and (n := counts.pop()) > best:
            delim, best = d, n
    decimal_comma = delim == ";" and any(re.search(r"\d,\d", ln) for ln in sample[1:])

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
                "(ax, ay, az) from Physics Toolbox with the time column included.")
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
    """Median sampling rate in Hz from a time column in seconds."""
    dt = np.diff(t)
    return 1 / np.median(dt[dt > 0])


def rate_warning(data, w=30):
    """Warning text when the data reaching the lab code is not at about 100 Hz, else None.

    The lab code divides sample counts by 100 to get seconds and counts its window w in
    samples, so both are only right at 100 Hz. The rate is measured from column 1 when it
    is a strictly increasing time column (Walking.mat layout, CSV exports, resampled data);
    a single vector with no time column (e.g. Lab1Data) gives no warning, since its rate
    is unknown.
    """
    if data.ndim != 2 or data.shape[1] < 2 or len(data) < 3 or not np.all(np.diff(data[:, 0]) > 0):
        return None
    fs = sampling_rate(data[:, 0])
    if abs(fs - 100) <= 0.05 * 100:
        return None
    return (f"Warning: the data reaching the lab code is at about {fs:.0f} Hz, but the lab code "
            f"assumes 100 Hz. It divides by 100 to get seconds, so its durations are off by "
            f"{abs(100 / fs - 1):.0%}, and its window w = {w} samples covers +/-{w / fs:.3g} s "
            f"instead of +/-{w / 100:.3g} s. Add --resample 100 to put the data on a 100 Hz grid first.")


def resample(W, fs):
    """Put every column of W (column 0 = time in s) on a uniform grid
    t = 0, 1/fs, 2/fs, ... by linear interpolation.

    For phone recordings that are not at the 100 Hz the lab code assumes.
    MATLAB equivalent: t2 = (0:1/fs:t(end)-t(1))'; A2 = interp1(t-t(1), A, t2);
    """
    t = W[:, 0] - W[0, 0]
    if np.any(np.diff(t) < 0):
        raise ValueError("The time column goes backwards, so the data cannot be resampled. "
                         "Check that the file holds a single recording.")
    t2 = np.arange(int(np.floor(t[-1] * fs + 1e-9)) + 1) / fs
    return np.column_stack([t2] + [np.interp(t2, t, W[:, c]) for c in range(1, W.shape[1])])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--file", default="data/Walking.mat",
                   help=".mat file, or a Physics Toolbox .csv export")
    p.add_argument("--var", default="Walking", help="variable name inside the .mat")
    p.add_argument("--col", type=int, default=2,
                   help="MATLAB-style column number: 2, 3 or 4 (1 = time)")
    p.add_argument("--w", type=int, default=30, help="half-window in samples")
    p.add_argument("--h", type=float, default=1, help="peak threshold")
    p.add_argument("--resample", type=float, metavar="HZ",
                   help="resample to HZ (e.g. 100) by linear interpolation first; "
                        "needs time in column 1")
    p.add_argument("--no-plot", action="store_true", help="skip the plot window")
    args = p.parse_args()

    if args.file.lower().endswith((".csv", ".txt")):
        data, names = load_csv(args.file)
        fs = sampling_rate(data[:, 0])
        print(f"CSV columns:         time = {names[0]!r}, x = {names[1]!r}, "
              f"y = {names[2]!r}, z = {names[3]!r} (--col 2/3/4)")
        print(f"Sampling rate:       about {fs:.0f} Hz")
        if names[1].lower().startswith("ax"):
            print("  Note: Linear Accelerometer data is in m/s^2 without gravity; "
                  "h = 1 was chosen for G-Force Meter data (g, gravity included).")
    else:
        try:
            data = load_mat(args.file, args.var)
        except ValueError as e:
            p.error(str(e))
    if args.resample:
        if data.ndim != 2 or data.shape[1] < 2:
            p.error("--resample needs a time column in column 1 and data after it.")
        before = sampling_rate(data[:, 0])
        data = resample(data, args.resample)
        print(f"Resampled:           about {before:.0f} Hz -> {args.resample:g} Hz "
              f"(linear interpolation, like MATLAB interp1), {len(data)} samples")
    # checked on what the lab code actually gets: after resampling, and for .mat files too
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
