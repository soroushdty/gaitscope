"""Tests for python/lab_step_det.py.  Run: uv run pytest"""
import json
import os
import sys

import numpy as np
import pytest
from scipy.io import loadmat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))
import lab_step_det  # noqa: E402
from lab_step_det import detect_steps, gait_metrics, load_csv, load_mat, rate_warning, resample, sampling_rate  # noqa: E402

FIX = os.path.join(ROOT, "tests", "fixtures")
WALKING = os.path.join(ROOT, "data", "Walking.mat")

# From running the course's LabStepDet_2025.m in GNU Octave on Walking.mat.
OCTAVE_WALKING = {
    2: (15, 0.9542857143, 57.25714286, 42.39505466, 1.234113712),
    3: (12, 1.144545455, 68.67272727, 8.801859308, 1.00877193),
    4: (21, 0.6955, 41.73, 37.12209585, 1.214968153),
}


@pytest.mark.skipif(not os.path.exists(WALKING), reason="data/Walking.mat not present (course file, not committed)")
@pytest.mark.parametrize("col", [2, 3, 4])
def test_matches_octave_on_walking(col):
    W = loadmat(WALKING)["Walking"]
    _, idx = detect_steps(W[:, col - 1])
    m = gait_metrics(idx)
    steps, avg, pace, var, asym = OCTAVE_WALKING[col]
    assert len(idx) == steps
    assert m["AverageStepDuration"] == pytest.approx(avg, rel=1e-8)
    assert m["Pace"] == pytest.approx(pace, rel=1e-8)
    assert m["VariabilitySteps"] == pytest.approx(var, rel=1e-8)
    assert m["GaitAsymmetry"] == pytest.approx(asym, rel=1e-8)


def test_fixture_expectations_are_current():
    """expected.json must be regenerated whenever the port changes (scripts/make_fixtures.py)."""
    W = loadmat(os.path.join(FIX, "walk.mat"))["Walking"]
    expected = json.load(open(os.path.join(FIX, "expected.json")))["columns"]
    for col in ("2", "3", "4"):
        _, idx = detect_steps(W[:, int(col) - 1])
        assert idx.tolist() == expected[col]["step_indices_matlab"]


def test_matlab_loop_bounds_and_one_based_indices():
    A = np.zeros(100)
    A[30] = 5   # 0-based 30 == MATLAB index 31 == first index the loop visits (w+1) when w=30
    A[69] = 5   # MATLAB 70 == last index visited (length - w)
    A[70] = 9   # MATLAB 71 is outside the loop and must not be detected
    _, idx = detect_steps(A, w=30, h=1)
    assert idx.tolist() == [31]  # 70 is not the max of its window because of 71


def test_tied_peak_is_counted_twice_like_matlab():
    A = np.zeros(200)
    A[100] = A[101] = 3.0
    _, idx = detect_steps(A, w=30, h=1)
    assert idx.tolist() == [101, 102]


def test_std_uses_n_minus_1():
    m = gait_metrics(np.array([1, 11, 31]))
    assert m["VariabilitySteps"] == pytest.approx(np.std([10, 20], ddof=1))


# --- Physics Toolbox CSV input. The fixtures are written from walk.mat by
# scripts/make_fixtures.py, so each CSV must give back walk.mat's time, x, y, z.

def _walk():
    W = loadmat(os.path.join(FIX, "walk.mat"))["Walking"][:, :4]
    return np.column_stack([W[:, 0] - W[0, 0], W[:, 1:]])


@pytest.mark.parametrize("name, time_tol", [
    ("ptb_metadata_units.csv", 1e-6),    # '#' metadata lines, 'ax (m/s^2)' headers
    ("ptb_linacc_semicolon.csv", 1e-4),  # ';' delimiter, decimal comma
    ("ptb_clock_time.csv", 1e-3),        # 13:05:10:010 clock times
    ("plain_noheader.csv", 1e-5),        # no header: time, x, y, z like Walking.mat
])
def test_csv_gives_walking_layout(name, time_tol):
    D, _ = load_csv(os.path.join(FIX, name))
    W = _walk()
    assert D.shape == W.shape
    assert np.allclose(D[:, 0], W[:, 0], atol=time_tol)
    assert np.array_equal(D[:, 1:], W[:, 1:])
    for c in (1, 2, 3):
        assert detect_steps(D[:, c])[1].tolist() == detect_steps(W[:, c])[1].tolist()


def test_csv_gforce_columns_and_rate():
    D, names = load_csv(os.path.join(FIX, "ptb_gforce.csv"))
    assert names == ["time", "gFx", "gFy", "gFz"]  # TgF is not used as an axis
    assert np.allclose(D[:, 1], _walk()[:, 1] / 9.81, atol=1e-3)
    assert sampling_rate(D[:, 0]) == pytest.approx(100, rel=0.1)


def test_csv_multi_sensor_rows_keep_only_accelerometer_rows():
    D, names = load_csv(os.path.join(FIX, "ptb_multi_record.csv"))
    single, _ = load_csv(os.path.join(FIX, "ptb_gforce.csv"))
    assert names == ["time", "gFx", "gFy", "gFz"]
    assert np.array_equal(D, single)  # gyroscope rows (blank gF cells) dropped


@pytest.mark.parametrize("name, what, fix", [
    ("bad_empty.csv", "fewer than 2 lines", "Record for longer"),
    ("bad_backwards_time.csv", "no y, z column", "Export the G-Force Meter"),
])
def test_csv_errors_say_what_and_how_to_fix(name, what, fix):
    with pytest.raises(ValueError, match=what) as e:
        load_csv(os.path.join(FIX, name))
    assert fix in str(e.value)


# --- --resample: phones without a 100 Hz setting record at ~460 Hz

def test_resample_keeps_uniform_100hz_data():
    t = np.arange(500) / 100
    W = np.column_stack([t, np.sin(t), np.cos(t)])
    assert np.allclose(resample(W, 100), W)


def test_resample_460hz_peaks_land_on_100hz_samples():
    t = np.cumsum(np.full(4600, 1 / 460) * (1 + 0.01 * np.sin(np.arange(4600))))  # jittery 460 Hz
    peaks = [1.5, 2.6, 3.7, 4.8, 5.9, 7.0, 8.1]                                  # seconds
    a = 1 + 0.5 * sum(np.exp(-((t - p) / 0.05) ** 2) for p in peaks)
    R = resample(np.column_stack([t, a]), 100)
    assert sampling_rate(R[:, 0]) == pytest.approx(100)
    _, idx = detect_steps(R[:, 1], w=60, h=1)
    assert idx.tolist() == [round((p - t[0]) * 100) + 1 for p in peaks]  # 1-based, like MATLAB
    assert gait_metrics(idx)["AverageStepDuration"] == pytest.approx(1.1)


def test_resample_refuses_backwards_time():
    W = np.array([[0.0, 1], [0.01, 2], [0.005, 3]])
    with pytest.raises(ValueError, match="goes backwards.*single recording"):
        resample(W, 100)


# --- the 100 Hz check runs on whatever reaches the lab code (#47)
def walk_at(fs, seconds=12):
    """Walking.mat layout (time, x, y, z) at fs Hz, one peak per second."""
    t = np.arange(0, seconds, 1 / fs)
    x = 1.5 * np.cos(2 * np.pi * t) ** 8 * (np.cos(2 * np.pi * t) > 0)
    return np.column_stack([t, x, x, x])


def run_cli(monkeypatch, capsys, *args):
    monkeypatch.setattr(sys, "argv", ["lab_step_det.py", *args, "--no-plot"])
    lab_step_det.main()
    return capsys.readouterr().out


def test_rate_warning_says_how_far_off_and_how_to_fix():
    msg = rate_warning(walk_at(200))
    assert "about 200 Hz" in msg and "off by 50%" in msg and "+/-0.15 s instead of +/-0.3 s" in msg and "--resample 100" in msg
    assert rate_warning(walk_at(100)) is None
    assert rate_warning(walk_at(103)) is None, "within 5%"
    assert rate_warning(walk_at(200)[:, 1]) is None, "a single vector has no known rate"


@pytest.mark.parametrize("fs, extra, warned, duration", [
    (200, [], True, 2.0),                     # .mat at 200 Hz: was silent
    (100, [], False, 1.0),
    (200, ["--resample", "100"], False, 1.0),
    (200, ["--resample", "50"], True, 0.5),   # resampled to the wrong rate: was silent
])
def test_cli_warns_for_mat_files_and_any_resample_rate(tmp_path, monkeypatch, capsys, fs, extra, warned, duration):
    from scipy.io import savemat
    f = tmp_path / "walk.mat"
    savemat(f, {"Walking": walk_at(fs)})
    out = run_cli(monkeypatch, capsys, "--file", str(f), *extra)
    assert ("lab code assumes 100 Hz" in out) == warned, out
    assert f"AverageStepDuration: {duration:.4f} s" in out, out


# --- MATLAB v7.3 (HDF5) files (#48)
def test_v73_reads_like_the_v5_file():
    W5 = loadmat(os.path.join(FIX, "walk.mat"))["Walking"]
    W73 = load_mat(os.path.join(FIX, "walk_v73.mat"), "Walking")
    assert W73.shape == W5.shape == (1800, 5)
    assert np.array_equal(W73, W5)
    for col in (2, 3, 4):
        assert np.array_equal(detect_steps(W73[:, col - 1])[1], detect_steps(W5[:, col - 1])[1])


def test_v73_compact_storage_and_messages():
    mixed = os.path.join(FIX, "walk_v73_mixed.mat")
    W5 = loadmat(os.path.join(FIX, "walk.mat"))["Walking"]
    assert np.array_equal(load_mat(mixed, "A"), W5[:25]), "small array, compact storage"
    with pytest.raises(ValueError, match=r"'labels' .* MATLAB cell variable, not a numeric matrix.*-v7"):
        load_mat(mixed, "labels")
    with pytest.raises(ValueError, match=r"'rec' .* MATLAB struct variable"):
        load_mat(mixed, "rec")
    with pytest.raises(ValueError, match=r"MATLAB complex variable"):
        load_mat(mixed, "z")
    with pytest.raises(ValueError, match=r"has no variable 'Walking'\. It has: A, flags, labels, nothing, rec, subject, z\. Pick one with --var"):
        load_mat(mixed, "Walking")


def test_cli_reads_v73_and_reports_input_errors(monkeypatch, capsys):
    out73 = run_cli(monkeypatch, capsys, "--file", os.path.join(FIX, "walk_v73.mat"))
    out5 = run_cli(monkeypatch, capsys, "--file", os.path.join(FIX, "walk.mat"))
    assert out73 == out5
    with pytest.raises(SystemExit):
        run_cli(monkeypatch, capsys, "--file", os.path.join(FIX, "walk_v73_mixed.mat"))
    assert "has no variable 'Walking'" in capsys.readouterr().err
