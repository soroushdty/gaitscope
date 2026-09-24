"""
Generate the test fixtures in tests/fixtures/ from a synthetic walk.

No course data is used, so every fixture can be committed publicly.
Also writes tests/fixtures/expected.json with the Python port's results,
which the JavaScript tests use to check that both ports agree.

Run from the repo root:
    python scripts/make_fixtures.py
"""
import json
import os
import sys

import numpy as np
import scipy.io as sio

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "fixtures")
sys.path.insert(0, os.path.join(ROOT, "python"))
from lab_step_det import detect_steps, gait_metrics  # noqa: E402


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
    print("Wrote fixtures to", OUT)


if __name__ == "__main__":
    main()
