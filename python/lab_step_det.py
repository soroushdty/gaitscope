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

Requirements: numpy, scipy, matplotlib (pinned in uv.lock; install with `uv sync`)
"""
import argparse

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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--file", default="data/Walking.mat")
    p.add_argument("--var", default="Walking", help="variable name inside the .mat")
    p.add_argument("--col", type=int, default=2,
                   help="MATLAB-style column number: 2, 3 or 4 (1 = time)")
    p.add_argument("--w", type=int, default=30, help="half-window in samples")
    p.add_argument("--h", type=float, default=1, help="peak threshold")
    p.add_argument("--no-plot", action="store_true", help="skip the plot window")
    args = p.parse_args()

    data = loadmat(args.file)[args.var]
    # MATLAB column c -> Python column c-1. If the variable is a single
    # vector (e.g. Lab1Data), use it directly.
    A = data[:, args.col - 1] if data.ndim == 2 and data.shape[1] > 1 else data.ravel()

    step_vals, step_idx = detect_steps(A, w=args.w, h=args.h)
    m = gait_metrics(step_idx)

    print(f"Steps detected:      {len(step_idx)}")
    print(f"Step indices:        {step_idx.tolist()}")
    print(f"AverageStepDuration: {m['AverageStepDuration']:.4f} s")
    print(f"Pace:                {m['Pace']:.4f}")
    print(f"VariabilitySteps:    {m['VariabilitySteps']:.4f} samples")
    print(f"GaitAsymmetry:       {m['GaitAsymmetry']:.4f}")

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
