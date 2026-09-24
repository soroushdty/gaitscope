"""
Plot every accelerometer axis of a lab recording with the steps found by the
lab algorithm, plus the total magnitude column if present.

Usage:
    python python/plot_walking.py data/Walking.mat
    python python/plot_walking.py data/Walking.mat --var Walking --out walking_steps.png

Expects the lab layout: column 1 = time (s), columns 2-4 = x, y, z,
optional column 5 = magnitude.
"""
import argparse

import matplotlib.pyplot as plt
from scipy.io import loadmat

from lab_step_det import detect_steps


def main():
    p = argparse.ArgumentParser()
    p.add_argument("file")
    p.add_argument("--var", default=None, help="variable name (default: first numeric variable)")
    p.add_argument("--w", type=int, default=30)
    p.add_argument("--h", type=float, default=1)
    p.add_argument("--out", default=None, help="save the figure instead of showing it")
    args = p.parse_args()

    mat = loadmat(args.file)
    name = args.var or next(k for k in mat if not k.startswith("__"))
    W = mat[name]
    t = W[:, 0]

    names = {2: "x (col 2)", 3: "y (col 3)", 4: "z (col 4)", 5: "magnitude (col 5)"}
    colors = {2: "#4C72B0", 3: "#DD8452", 4: "#55A868", 5: "#8172B3"}
    cols = [c for c in (2, 3, 4, 5) if c <= W.shape[1]]

    fig, axes = plt.subplots(len(cols), 1, figsize=(12, 2.5 * len(cols)), sharex=True, squeeze=False)
    for ax, col in zip(axes[:, 0], cols):
        A = W[:, col - 1]
        ax.plot(t, A, color=colors[col], linewidth=1)
        if col <= 4:
            vals, idx = detect_steps(A, w=args.w, h=args.h)
            ax.scatter(t[idx - 1], vals, color="black", marker="v", s=40, zorder=3,
                       label=f"{len(idx)} detected steps")
            ax.axhline(args.h, color="grey", linestyle="--", linewidth=1, label=f"threshold h = {args.h}")
            ax.legend(loc="upper left", fontsize=9)
        ax.set_title(names[col], loc="left", fontsize=11, fontweight="bold")
        ax.set_ylabel("Acceleration")
        ax.spines[["top", "right"]].set_visible(False)
    axes[-1, 0].set_xlabel("Time (s)")
    plt.tight_layout()
    if args.out:
        plt.savefig(args.out, dpi=150, bbox_inches="tight")
    else:
        plt.show()


if __name__ == "__main__":
    main()
