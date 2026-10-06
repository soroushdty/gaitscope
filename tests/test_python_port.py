"""Tests for python/lab_step_det.py.  Run: uv run pytest"""
import json
import os
import sys

import numpy as np
import pytest
from scipy.io import loadmat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))
from lab_step_det import detect_steps, gait_metrics, load_csv, sampling_rate  # noqa: E402

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
