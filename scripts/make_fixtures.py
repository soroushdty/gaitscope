"""
Generate the test fixtures in tests/fixtures/ from a synthetic walk.

No course data is used, so every fixture can be committed publicly.
Also writes tests/fixtures/expected.json with the Python port's results,
which the JavaScript tests use to check that both ports agree, and
tests/fixtures/filters.json with scipy's filter designs and zero-phase outputs,
which the JavaScript filters (src/core.js designFilter, sosfiltfilt) must match, and
tests/fixtures/envelopes.json with scipy's PchipInterpolator for the smooth envelope, and
tests/fixtures/spectral.json with numpy/scipy references for the frequency-domain features.

Run from the repo root:
    python scripts/make_fixtures.py
"""
import json
import math
import struct
from fractions import Fraction
import os
import sys
import zipfile

import h5py
import numpy as np
import pywt
import scipy.io as sio
from scipy import interpolate, ndimage, signal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "fixtures")
sys.path.insert(0, os.path.join(ROOT, "python"))
from lab_step_det import detect_steps, gait_metrics, load_csv, resample  # noqa: E402


def synthetic_walk(seed=7, fs=100, dur=18.0):
    """t, x, y, z, |a| like a Physics Toolbox linear-accelerometer recording:
    irregular timing, values rounded to 0.01 (which creates tied peaks),
    standing still at the start and end."""
    rng = np.random.default_rng(seed)
    n = int(fs * dur)
    dt = (1 + 0.3 * (rng.random(n) - 0.5)) / fs
    t = np.cumsum(dt)
    env = np.clip((t - 1.5) / 1.0, 0, 1) * np.clip((dur - 1.8 - t) / 1.0, 0, 1)
    f = 0.9 + 0.04 * np.sin(t / 3)
    phase = np.cumsum(2 * np.pi * f * dt)
    noise = lambda s: s * (rng.random(n) - 0.5)
    x = env * (9 * np.sin(phase) + 2.5 * np.sin(2 * phase + 0.6)) + noise(0.35)
    y = env * (-4 + 10 * np.maximum(0, np.sin(phase - 0.4)) ** 3 - 2 * np.cos(phase)) + noise(0.35)
    z = env * (1.8 * np.sin(4 * phase) + 1.1 * np.sin(2 * phase)) + noise(0.5)
    x, y, z = (np.round(v, 2) for v in (x, y, z))
    mag = np.round(np.sqrt(x ** 2 + y ** 2 + z ** 2), 2)
    return np.column_stack([t, x, y, z, mag])


def filter_input(fs, dur=2.0):
    """Test signal for the filter fixtures; tests/core.test.js builds the same one."""
    t = np.arange(round(fs * dur)) / fs
    return 1 + np.sin(2 * np.pi * 1.8 * t) + 0.3 * np.sin(2 * np.pi * 17 * t + 0.4) + 0.1 * np.sin(2 * np.pi * 0.2 * t)


def spiky_input(fs):
    """filter_input() with a 2.5 spike every 53 samples, for the smoothing filters."""
    x = filter_input(fs)
    x[7::53] += 2.5
    return x


def odd_window(seconds, fs):
    """Same as oddWindow() in src/core.js (JS Math.round: halves round up)."""
    return 2 * math.floor(seconds * fs / 2 + 0.5) + 1


def other_filter_fixtures():
    """scipy references for the smoothing and notch filters, on spiky_input(): the first and
    last 12 samples (where edge handling shows) and every 8th sample in between."""
    cases = []
    for fs in (57, 100, 460):
        x = spiky_input(fs)
        n = len(x)
        idx = sorted(set(range(12)) | set(range(0, n, 8)) | set(range(n - 12, n)))
        for sec in (0.1, 0.25):
            y = ndimage.uniform_filter1d(x, odd_window(sec, fs), mode="nearest")
            cases.append({"filter": "movavg", "fs": fs, "p": {"maWindow": sec}, "idx": idx, "y": y[idx].tolist()})
        for sec in (0.05, 0.15):
            y = ndimage.median_filter(x, odd_window(sec, fs), mode="nearest")
            cases.append({"filter": "median", "fs": fs, "p": {"medWindow": sec}, "idx": idx, "y": y[idx].tolist()})
        # scipy's savgol_coeffs fits unscaled positions, which loses precision for long windows of
        # high order (1.5e-10 at 231 samples, order 5); these cases stay within 1e-12 of exact.
        for sec, order in ((0.3, 3), (0.15, 2), (0.2, 5)):
            y = signal.savgol_filter(x, odd_window(sec, fs), order, mode="interp")
            cases.append({"filter": "savgol", "fs": fs, "p": {"sgWindow": sec, "sgOrder": order}, "idx": idx, "y": y[idx].tolist()})
        for level, scale in ((4, 1.0), (2, 0.5)):
            coeffs = pywt.wavedec(x, "db4", mode="symmetric", level=level)
            t = scale * np.median(np.abs(coeffs[-1])) / 0.6745 * np.sqrt(2 * np.log(n))
            coeffs[1:] = [pywt.threshold(c, t, "soft") for c in coeffs[1:]]
            y = pywt.waverec(coeffs, "db4", mode="symmetric")[:n]
            cases.append({"filter": "wavelet", "fs": fs, "p": {"wLevel": level, "wScale": scale}, "idx": idx, "y": y[idx].tolist()})
        for f0, q in ((17, 30), (25, 10)):
            b, a = signal.iirnotch(f0, q, fs=fs)
            y = signal.sosfiltfilt(np.concatenate([b, a])[None, :], x)
            cases.append({"filter": "notch", "fs": fs, "p": {"notchFreq": f0, "notchQ": q}, "idx": idx, "y": y[idx].tolist()})
    return cases


def savgol_exact_weights(w, order):
    """Exact Savitzky-Golay centre weights by rational arithmetic: e0ᵀ (VᵀV)⁻¹ Vᵀ."""
    h = (w - 1) // 2
    xs = range(-h, h + 1)
    P = order + 1
    A = [[Fraction(sum(x ** (r + c) for x in xs)) for c in range(P)] + [Fraction(int(r == 0))] for r in range(P)]
    for c in range(P):
        piv = next(r for r in range(c, P) if A[r][c] != 0)
        A[c], A[piv] = A[piv], A[c]
        A[c] = [v / A[c][c] for v in A[c]]
        for r in range(P):
            if r != c and A[r][c] != 0:
                f = A[r][c]
                A[r] = [a - f * b for a, b in zip(A[r], A[c])]
    coef = [A[r][P] for r in range(P)]
    return [float(sum(coef[k] * Fraction(x) ** k for k in range(P))) for x in xs]


def pchip_fixtures():
    """scipy's PchipInterpolator on point sets like an envelope's peaks: uneven spacing, sign
    changes in the slope, a flat stretch, and two points (a straight line)."""
    sets = [
        ([0.2, 1.1, 2.3, 2.9, 4.0, 5.5, 6.1], [3.0, 3.6, 2.1, 2.1, 4.2, 3.9, 1.0]),
        ([0.0, 0.5, 1.0, 1.4, 2.6], [1.0, 1.0, 2.0, 5.0, 5.5]),
        ([1.0, 3.0], [-2.0, 4.0]),
    ]
    cases = []
    for xs, ys in sets:
        td = np.linspace(xs[0], xs[-1], 41)
        cases.append({"x": xs, "y": ys, "at": td.tolist(), "value": interpolate.PchipInterpolator(xs, ys)(td).tolist()})
    return cases


def fft_input(n):
    """Deterministic test signal for the FFT; tests/core.test.js builds the same one."""
    k = np.arange(n)
    return np.sin(0.37 * k) + 0.5 * np.cos(1.9 * k + 0.3) + 0.01 * k


def spectral_fixtures():
    """numpy/scipy references for the frequency-domain features (#36)."""
    out = {"fft": []}
    for n in (1, 2, 8, 100, 114, 920, 1000, 1024):
        X = np.fft.fft(fft_input(n))
        out["fft"].append({"n": n, "re": X.real.tolist(), "im": X.imag.tolist()})
    out["hilbert"] = []
    for fs in (57, 100, 460):
        x = filter_input(fs)
        z = signal.hilbert(x - x.mean())
        out["hilbert"].append({"fs": fs, "re": z.real.tolist(), "im": z.imag.tolist()})
    out["spectrogram"] = []
    for fs in (57, 100, 460):
        x = filter_input(fs, dur=10.0)
        nperseg = round(4.0 * fs)
        nfft = 2 ** math.ceil(math.log2(nperseg))
        f, tt, sxx = signal.spectrogram(x, fs, window="hann", nperseg=nperseg, noverlap=nperseg - round(0.5 * fs), nfft=nfft,
                                        detrend="constant", scaling="density", mode="psd")
        out["spectrogram"].append({"fs": fs, "nperseg": nperseg, "noverlap": nperseg - round(0.5 * fs), "nfft": nfft, "t": tt.tolist(), "S": sxx.T.tolist()})
    out["welch"] = []
    for fs in (57, 100, 460):
        x = filter_input(fs, dur=10.0)
        for seg, pad in ((4.0, 1), (2.0, 4)):
            nperseg = round(seg * fs)
            nfft = pad * 2 ** math.ceil(math.log2(nperseg))
            f, psd = signal.welch(x, fs, window="hann", nperseg=nperseg, noverlap=nperseg // 2, nfft=nfft, detrend="constant", scaling="density")
            out["welch"].append({"fs": fs, "nperseg": nperseg, "nfft": nfft, "f": f.tolist(), "psd": psd.tolist()})
    return out


def dwt_fixtures():
    """PyWavelets single-level db4 transforms (symmetric edges), forwards and back, on
    fft_input() of odd and even lengths, plus the db4 filters themselves."""
    w = pywt.Wavelet("db4")
    out = {"dec_lo": list(w.dec_lo), "dec_hi": list(w.dec_hi), "rec_lo": list(w.rec_lo), "rec_hi": list(w.rec_hi), "cases": []}
    for n in (9, 20, 57, 200):
        cA, cD = pywt.dwt(fft_input(n), "db4", mode="symmetric")
        back = pywt.idwt(cA, cD, "db4", mode="symmetric")
        out["cases"].append({"n": n, "cA": cA.tolist(), "cD": cD.tolist(), "back": back.tolist()})
    return out


def cwt_fixtures():
    """PyWavelets' complex Morlet CWT (cmorB-1, method='fft', precision 12) of a walk-like signal
    whose rhythm speeds up, at several scales and widths: real and imaginary parts at some
    samples (#101)."""
    out = []
    for fs, n, B in ((20, 400, 2.0), (28.7, 517, 1.0), (20, 160, 4.0)):
        t = np.arange(n) / fs
        x = 1 + 0.3 * np.sin(2 * np.pi * (1.4 * t + 0.02 * t ** 2)) + 0.08 * np.sin(2 * np.pi * 0.7 * t + 0.3) + 0.02 * np.cos(2 * np.pi * 4.1 * t)
        freqs = [0.3, 0.75, 1.6, 2.9, 4.95]
        scales = [fs / f for f in freqs]
        coef, _ = pywt.cwt(x, scales, f"cmor{B}-1.0", method="fft")
        idx = sorted({0, 1, n // 3, n // 2, n - 2, n - 1, 37})
        out.append({"fs": fs, "n": n, "B": B, "scales": scales, "x": x.tolist(), "idx": idx,
                    "re": [c.real[idx].tolist() for c in coef], "im": [c.imag[idx].tolist() for c in coef]})
    return out


def mra_fixtures():
    """PyWavelets' db4 multiresolution analysis: wavedec to `level` (symmetric), then waverec of
    each detail level alone (the rest zeroed), cut to the input's length (#101)."""
    out = []
    for n, level in ((400, 5), (517, 6), (64, 2)):
        x = fft_input(n)
        coeffs = pywt.wavedec(x, "db4", mode="symmetric", level=level)
        zero = [np.zeros_like(c) for c in coeffs]
        details = []
        for j in range(1, level + 1):  # coeffs[-j] is detail level j (finest first)
            keep = list(zero); keep[-j] = coeffs[-j]
            details.append(pywt.waverec(keep, "db4", mode="symmetric")[:n].tolist())
        keep = list(zero); keep[0] = coeffs[0]
        out.append({"n": n, "level": level, "details": details, "approx": pywt.waverec(keep, "db4", mode="symmetric")[:n].tolist()})
    return out


def resample_input(fs, dur=3.0, seed=11):
    """t, a: uneven timing (±30%) starting at 0.0123 s, three repeated timestamps, a walk-like
    1.8 Hz swing plus a 70 Hz tone (above 50 Hz, the Nyquist frequency of 100 Hz)."""
    rng = np.random.default_rng(seed)
    n = round(fs * dur)
    t = 0.0123 + np.cumsum((1 + 0.6 * (rng.random(n) - 0.5)) / fs)
    t[[n // 4, n // 2, 3 * n // 4]] = t[[n // 4 - 1, n // 2 - 1, 3 * n // 4 - 1]]
    a = 1 + np.sin(2 * np.pi * 1.8 * t) + 0.3 * np.sin(2 * np.pi * 70 * t)
    return t, a


def resample_fixtures():
    """python/lab_step_det.py resample() on resample_input(), which resampleChannel in
    src/core.js must reproduce (linear: bit for bit)."""
    cases = []
    for src, target, method, aa in [(460, 100, "linear", False), (460, 100, "linear", True), (460, 100, "pchip", False),
                                    (460, 100, "pchip", True), (57, 100, "linear", False), (57, 100, "pchip", False),
                                    (100, 100, "linear", False), (460, 37.5, "linear", True)]:
        t, a = resample_input(src)
        R = resample(np.column_stack([t, a]), target, method=method, antialias=aa)
        cases.append({"fs_in": src, "fs": target, "method": method, "antialias": aa,
                      "t": t.tolist(), "a": a.tolist(), "out": R[:, 1].tolist()})
    return cases


def filter_fixtures():
    """scipy references for every filter the dashboard offers: three types, orders 2-6,
    low-pass 3 Hz alone and with a 0.3 Hz high-pass (band-pass), at 57, 100 and 460 Hz.
    Section pairing differs between scipy and the JS design, so each case stores the
    frequency response of the whole cascade and sosfiltfilt's output (every 8th sample)."""
    cases = []
    for ftype in ("butter", "bessel", "cheby1", "cheby2", "ellip"):
        for order in range(2, 7):
            for fs in (57, 100, 460):
                for hp in (0, 0.3):
                    spec = {"type": ftype, "order": order, "fs": fs, "lowpass": 3, "highpass": hp, "rp": 0.5, "rs": 40}
                    wn, btype = ([hp, 3], "bandpass") if hp else (3, "lowpass")
                    sos = signal.iirfilter(order, wn, rp=0.5, rs=40, btype=btype, ftype=ftype, output="sos", fs=fs)
                    freqs = np.linspace(0, fs / 2, 16, endpoint=False)
                    _, h = signal.sosfreqz(sos, worN=freqs, fs=fs)
                    y = signal.sosfiltfilt(sos, filter_input(fs))
                    cases.append({"spec": spec, "freqs": freqs.tolist(), "h_re": h.real.tolist(), "h_im": h.imag.tolist(),
                                  "y_every_8": y[::8].tolist()})
    return cases


MAT73_HEADER = b"MATLAB 7.3 MAT-file, Platform: GLNXA64, Created on: Tue Oct  6 12:00:00 2026 HDF5 schema 1.00 ."


def save_v73(path, write):
    """Write an HDF5 file in MATLAB's v7.3 layout: a 512-byte userblock holding the MAT header
    (116 text bytes, subsystem offset, version 0x0200, 'IM'), then HDF5. write(f) adds the
    variables with mat_var / mat_compact."""
    with h5py.File(path, "w", userblock_size=512) as f:
        write(f)
    with open(path, "r+b") as fh:
        fh.write((MAT73_HEADER.ljust(116, b" ") + b"\0" * 8 + struct.pack("<H", 0x0200) + b"IM").ljust(512, b"\0"))


def mat_class(obj, cls, **extra):
    obj.attrs.create("MATLAB_class", np.bytes_(cls))
    for k, v in extra.items():
        obj.attrs.create(k, v)
    return obj


def mat_var(group, name, arr, cls):
    """A matrix as MATLAB stores it: transposed (MATLAB is column-major), chunked and gzip-compressed."""
    return mat_class(group.create_dataset(name, data=np.asarray(arr).T, chunks=True, compression="gzip"), cls)


def mat_compact(group, name, arr, cls, **extra):
    """A small matrix in compact storage (data inside the object header), as MATLAB writes small arrays."""
    a = np.ascontiguousarray(np.asarray(arr).T)
    dcpl = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
    dcpl.set_layout(h5py.h5d.COMPACT)
    dsid = h5py.h5d.create(group.id, name.encode(), h5py.h5t.py_create(a.dtype), h5py.h5s.create_simple(a.shape), dcpl=dcpl)
    dsid.write(h5py.h5s.ALL, h5py.h5s.ALL, a)
    return mat_class(group[name], cls, **extra)


def v73_fixtures(W):
    """MATLAB v7.3 files (HDF5) for the dashboard and the Python port."""
    save_v73(os.path.join(OUT, "walk_v73.mat"), lambda f: mat_var(f, "Walking", W, "double"))

    def mixed(f):
        mat_compact(f, "A", W[:25], "double")                                  # small: compact storage
        rec = mat_class(f.create_group("rec"), "struct")
        mat_var(rec, "acc", (W[:, 1:4] * 100).astype(np.int16), "int16")
        mat_compact(rec, "fs", np.array([[100.0]]), "double")
        mat_compact(f, "subject", np.array([[ord(c) for c in "S1"]], dtype=np.uint16), "char")
        mat_compact(f, "flags", (W[:30, 1:3] > 0).astype(np.uint8), "logical")
        refs = f.create_group("#refs#")
        cells = [mat_compact(refs, "a", np.array([[1.0, 2.0]]), "double"), mat_compact(refs, "b", np.array([[3.0]]), "double")]
        ref_arr = np.array([[c.ref for c in cells]], dtype=h5py.ref_dtype)
        mat_compact(f, "labels", ref_arr, "cell")
        mat_compact(f, "nothing", np.array([0, 0], dtype=np.uint64), "double", MATLAB_empty=np.uint8(1))
        cplx = np.zeros((30, 2), dtype=[("real", "<f8"), ("imag", "<f8")])
        mat_compact(f, "z", cplx, "double")
    save_v73(os.path.join(OUT, "walk_v73_mixed.mat"), mixed)


def phyphox_number(v):
    """phyphox's number format: 10 significant digits, exponent without padding (2.506474800E-2)."""
    mant, exp = f"{v:.9E}".split("E")
    return f"{mant}E{int(exp)}"


def phyphox_rows(W, gravity=False):
    """t, x, y, z, |a| in m/s^2 from the synthetic walk; gravity=True adds 9.81 to y (phone upright)."""
    t, x, y, z = W[:, :4].T
    if gravity:
        y = y + 9.81
    return np.column_stack([t, x, y, z, np.sqrt(x ** 2 + y ** 2 + z ** 2)])


def phyphox_csv(rows, axis_name, delim, decimal_comma=False):
    """A phyphox Raw Data.csv: 'Acceleration' (with g) or 'Linear Acceleration' (without)."""
    heads = ["Time (s)"] + [f"{axis_name} {a} (m/s^2)" for a in "xyz"] + ["Absolute acceleration (m/s^2)"]
    num = (lambda v: phyphox_number(v).replace(".", ",")) if decimal_comma else phyphox_number
    return "\n".join([delim.join(f'"{h}"' for h in heads)] + [delim.join(num(v) for v in r) for r in rows]) + "\n"


def write_phyphox(path, rows, axis_name, delim, decimal_comma=False):
    with open(path, "w") as f:
        f.write(phyphox_csv(rows, axis_name, delim, decimal_comma))


PHYPHOX_TIME = ('"event","experiment time","system time","system time text"\n'
                '"START",0.000000000E0,1790000000.000,"2026-09-21 07:13:20.000 UTC-07:00"\n'
                '"PAUSE",1.800000000E1,1790000018.000,"2026-09-21 07:13:38.000 UTC-07:00"\n')


PHYPHOX_TIME_PAUSED = ('"event","experiment time","system time","system time text"\n'
                       '"START",0.000000000E0,1790000000.000,"2026-09-21 07:13:20.000 UTC-07:00"\n'
                       '"PAUSE",9.000000000E0,1790000009.000,"2026-09-21 07:13:29.000 UTC-07:00"\n'
                       '"START",9.000000000E0,1790000021.500,"2026-09-21 07:13:41.500 UTC-07:00"\n'
                       '"PAUSE",1.800000000E1,1790000030.500,"2026-09-21 07:13:50.500 UTC-07:00"\n')
PHYPHOX_DEVICE = "".join(f'"{k}","{v}"\n' for k, v in [
    ("property", "value"), ("version", "1.2.1"), ("deviceModel", "Pixel 9a"), ("deviceBrand", "google"),
    ("deviceManufacturer", "Google"), ("accelerometer Name", "Test Accelerometer"), ("accelerometer Vendor", "Test Vendor"),
    ("linear_acceleration Name", "Linear Acceleration Sensor"), ("humidity Name", "null")])


RECORDER_META = ("# recorder: gaitscope (browser devicemotion)\n# started: 2026-10-07T14:03:00.000Z\n"
                 "# device: Mozilla/5.0 (Linux; Android 16; Pixel 9a) Chrome/141.0 Mobile Safari/537.36\n"
                 "# sample_rate_hz: 100.3\n# samples: 1800\n# stopped: user\n"
                 "# steps_counted: 12\n# phone_position: hand\n")


def write_zip(path, files):
    """Zip of (name, text, deflate) with a fixed date, so regenerating doesn't change it."""
    with zipfile.ZipFile(path, "w") as z:
        for name, text, deflate in files:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 21, 7, 13, 50))
            info.compress_type = zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED
            z.writestr(info, text)


def main():
    os.makedirs(OUT, exist_ok=True)
    W = synthetic_walk()
    p = lambda name: os.path.join(OUT, name)

    # --- MAT files the dashboard should accept
    sio.savemat(p("walk.mat"), {"Walking": W}, do_compression=True)
    sio.savemat(p("walk_uncompressed.mat"), {"Walking": W}, do_compression=False)
    sio.savemat(p("walk_transposed.mat"), {"data": W.T}, do_compression=True)
    sio.savemat(p("walk_int16.mat"), {"raw": (W[:, 1:4] * 100).astype(np.int16)})
    sio.savemat(p("walk_struct.mat"), {"rec": {"acc": W, "fs": 100.0, "subject": "S1"}})
    sio.savemat(p("walk_multi.mat"), {"Walking": W, "fs": 100.0, "labels": np.array(["a", "b"]), "flags": W[:, 1] > 0})
    Wn = W[:, 2].copy(); Wn[[100, 500]] = np.nan
    sio.savemat(p("walk_nan.mat"), {"A": Wn})

    # --- MATLAB v7.3 (HDF5): read in the dashboard through jsfive, in Python through h5py
    v73_fixtures(W)

    # --- MAT files the dashboard should reject (with a fix)
    sio.savemat(p("bad_complex.mat"), {"z": W[:, 1] + 1j * W[:, 2]})
    sio.savemat(p("bad_v4.mat"), {"Walking": W}, format="4")
    sio.savemat(p("bad_cell.mat"), {"c": np.array([W[:50], W[:50]], dtype=object)}, do_compression=True)
    sio.savemat(p("bad_square.mat"), {"img": np.random.default_rng(1).random((64, 64))})
    sio.savemat(p("bad_flat.mat"), {"A": np.ones(500)})
    hdr = b"MATLAB 7.3 MAT-file, Platform: GLNXA64, Created on: Mon Sep  1 10:00:00 2026 HDF5 schema 1.00 ."
    with open(p("bad_v73.mat"), "wb") as f:
        f.write(hdr.ljust(512, b" ") + b"\x89HDF\r\n\x1a\n" + b"\0" * 600)
    with open(p("bad_text_as.mat"), "w") as f:
        f.write("time,gFx\n0.01,0.2\n0.02,0.3\n")
    with open(p("bad_random.mat"), "wb") as f:
        f.write(np.random.default_rng(2).bytes(4000))

    # --- Physics Toolbox style CSVs
    t, ax, ay, az, aT = W.T
    gx, gy, gz = ax / 9.81, ay / 9.81 + 1, az / 9.81
    with open(p("ptb_gforce.csv"), "w") as f:
        f.write("time,gFx,gFy,gFz,TgF\n")
        for r in zip(t, gx, gy, gz, np.sqrt(gx ** 2 + gy ** 2 + gz ** 2)):
            f.write(f"{r[0]:.4f}," + ",".join(f"{v:.3f}" for v in r[1:]) + "\n")
    with open(p("ptb_linacc_semicolon.csv"), "w") as f:
        f.write("time;ax;ay;az;aT\n")
        for r in W:
            f.write(";".join(f"{v:.4f}".replace(".", ",") for v in r) + "\n")
    with open(p("ptb_clock_time.csv"), "w") as f:
        f.write("time,ax,ay,az,aT\n")
        for r in W:
            s = 13 * 3600 + 5 * 60 + 10 + r[0]
            hh, mm, ss = int(s // 3600), int(s % 3600 // 60), s % 60
            f.write(f"{hh:02d}:{mm:02d}:{int(ss):02d}:{int(round((ss % 1) * 1000)) % 1000:03d}," + ",".join(f"{v:.2f}" for v in r[1:]) + "\n")
    with open(p("ptb_multi_record.csv"), "w") as f:
        f.write("time,gFx,gFy,gFz,TgF,wx,wy,wz\n")
        for r, g in zip(W, zip(gx, gy, gz)):
            f.write(f"{r[0]:.4f},{g[0]:.3f},{g[1]:.3f},{g[2]:.3f},{np.linalg.norm(g):.3f},,,\n")
            f.write(f"{r[0] + 0.002:.4f},,,,,{r[2] * 0.1:.3f},{r[1] * 0.1:.3f},{r[3] * 0.1:.3f}\n")
    # newer Physics Toolbox layout: '#' metadata lines (with ';' inside) and units in headers
    with open(p("ptb_metadata_units.csv"), "w") as f:
        f.write("# sensor:linear_accelerometer\n# Requested Sample Rate: 50 Hz\n"
                "# Inertial correction: sensor=linear_acceleration; operation=add; unit=m/s^2; x=0.0; y=0.0; z=0.0\n"
                "# Recording started at: 2026-09-23 16:53:10.681\n"
                "time,ax (m/s^2),ay (m/s^2),az (m/s^2),aT (m/s^2)\n")
        for r in W:
            f.write(f"{r[0]:.6f}," + ",".join(f"{v:.4f}" for v in r[1:]) + "\n")
    # --- phyphox CSVs (from the "Raw Data.csv" in its export zip): quoted headers with units,
    # scientific notation with a bare exponent (2.506474800E-2)
    write_phyphox(p("phyphox_accel.csv"), phyphox_rows(W, gravity=True), "Acceleration", ",")
    write_phyphox(p("phyphox_linear_tab.csv"), phyphox_rows(W), "Linear Acceleration", "\t", decimal_comma=True)
    with open(p("phyphox_time.csv"), "w") as f:  # meta/time.csv on its own: not sensor data
        f.write(PHYPHOX_TIME)
    # the zip phyphox exports, paused once at 9 s; meta/device.csv stored, the rest deflated
    write_zip(p("phyphox.zip"), [
        ("Raw Data.csv", phyphox_csv(phyphox_rows(W, gravity=True), "Acceleration", ","), True),
        ("meta/device.csv", PHYPHOX_DEVICE, False),
        ("meta/time.csv", PHYPHOX_TIME_PAUSED, True),
    ])
    write_zip(p("bad_phyphox_excel.zip"), [("Raw Data.xls", "not really Excel", True)])
    # the dashboard's browser recorder (#51): metadata lines, g with gravity, linear m/s^2, rad/s;
    # recordingCsv in src/core.js writes this layout (its tests check the header matches)
    with open(p("recorder.csv"), "w") as f:
        f.write(RECORDER_META)
        f.write("time,gFx (g),gFy (g),gFz (g),TgF (g),ax (m/s^2),ay (m/s^2),az (m/s^2),aT (m/s^2),wx (rad/s),wy (rad/s),wz (rad/s)\n")
        lin = W[:, 1:4]
        g = (lin + [0, 9.80665, 0]) / 9.80665
        for k, r in enumerate(W):
            row = [r[0] - W[0, 0], *g[k], np.linalg.norm(g[k]), *lin[k], np.linalg.norm(lin[k]), 0.1 * lin[k, 2], 0.1 * lin[k, 0], 0.1 * lin[k, 1]]
            f.write(",".join(repr(float(v)) for v in row) + "\n")
    np.savetxt(p("plain_noheader.csv"), W, delimiter=",", fmt="%.5f")
    with open(p("bad_backwards_time.csv"), "w") as f:
        f.write("time,ax\n")
        for r in list(W[:800]) + list(W[:800]):
            f.write(f"{r[0]:.4f},{r[1]:.2f}\n")
    with open(p("bad_empty.csv"), "w") as f:
        f.write("time,ax\n")

    # --- expected results from the Python port (original algorithm, w=30, h=1)
    expected = {}
    for col in (2, 3, 4):
        vals, idx = detect_steps(W[:, col - 1], w=30, h=1)
        m = gait_metrics(idx)
        expected[str(col)] = {
            "step_indices_matlab": idx.tolist(),
            "AverageStepDuration": m["AverageStepDuration"],
            "Pace": m["Pace"],
            "VariabilitySteps": m["VariabilitySteps"],
            "GaitAsymmetry": m["GaitAsymmetry"],
        }
    with open(p("expected.json"), "w") as f:
        json.dump({"source": "walk.mat (synthetic), python/lab_step_det.py, w=30, h=1", "columns": expected}, f, indent=2)
    # --- the Python port's export (#53) of walk.mat column 2, which the dashboard's must match
    import lab_step_det
    A = W[:, 1]
    model = lab_step_det.export_model(W[:, 0] - W[0, 0], A, detect_steps(A)[1],
                                      {"file": "walk.mat", "variable": "Walking", "signal": "column 2", "signal_name": "Column 2", "unit": ""},
                                      {"resample": "off", "to_g": False})
    model["about"]["exported"] = "2026-10-07T00:00:00.000Z"  # fixed, so regenerating doesn't change the file
    lab_step_det.write_export(model, p("export_python.json"))
    with open(p("envelopes.json"), "w") as f:
        json.dump({"source": "scipy.interpolate.PchipInterpolator", "pchip": pchip_fixtures()}, f)
    with open(p("spectral.json"), "w") as f:
        json.dump({"source": "numpy.fft, scipy.signal; inputs: fft_input(), filter_input()", **spectral_fixtures()}, f)
    with open(p("resample.json"), "w") as f:
        # and the whole path: a CSV export through load_csv and resample, then Coza
        D, _ = load_csv(p("ptb_gforce.csv"))
        lab = []
        for fs in (100, 50):
            R = resample(D, fs)
            lab.append({"fs": fs, "x": R[:, 1].tolist(), "steps_x_matlab": detect_steps(R[:, 1], w=30, h=0.2)[1].tolist()})
        json.dump({"source": "python/lab_step_det.py resample(); input: resample_input()", "cases": resample_fixtures(),
                   "lab_source": "load_csv('ptb_gforce.csv'), resample(D, fs), detect_steps(x, w=30, h=0.2)", "lab": lab}, f)
    with open(p("filters.json"), "w") as f:
        json.dump({"source": "scipy.signal.iirfilter(output='sos') and sosfiltfilt; input: filter_input()", "cases": filter_fixtures(),
                   "other_source": "scipy.ndimage (mode='nearest'), scipy.signal.savgol_filter (mode='interp'), iirnotch + sosfiltfilt; input: spiky_input()",
                   "other": other_filter_fixtures(),
                   "savgol_exact": {"window": 231, "order": 5, "weights": savgol_exact_weights(231, 5)},
                   "dwt": dwt_fixtures()}, f)
    with open(p("wavelets.json"), "w") as f:
        json.dump({"source": "PyWavelets pywt.cwt (cmorB-1.0, method='fft') and wavedec/waverec (db4, symmetric)",
                   "cwt": cwt_fixtures(), "mra": mra_fixtures()}, f)
    print("Wrote fixtures to", OUT)


if __name__ == "__main__":
    main()
