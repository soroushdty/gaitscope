"""Tests for python/lab_step_det.py.  Run: uv run pytest"""
import json
import os
import sys

import numpy as np
import pytest
from scipy.io import loadmat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))
from lab_step_det import detect_steps, gait_metrics  # noqa: E402

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
