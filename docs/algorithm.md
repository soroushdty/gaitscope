# Step detection: the lab code and Coza

## Original (lab code)

`LabStepDet_2025.m` marks sample `i` as a step when

```
A(i) == max(A(i-w : i+w))   and   max(A(i-w : i+w)) > h
```

for `i = w+1 … length(A)-w`, with `w = 30` and `h = 1`. From the step indices it computes:

| Output | Formula | Note |
|---|---|---|
| `AverageStepDuration` | `mean(diff(Step1)) / 100` | Assumes 100 Hz. |
| `Pace` | `AverageStepDuration * 60` | Commented as steps/min, but this is not cadence. Cadence is `60 / AverageStepDuration`. |
| `VariabilitySteps` | `std(diff(Step1))` | In samples, N−1 normalisation. |
| `GaitAsymmetry` | `mean(d(2:2:end)) / mean(d(1:2:end))` | Even over odd intervals. |

Both ports reproduce this exactly:

* `python/lab_step_det.py` (`detect_steps`, `gait_metrics`)
* `src/core.js` (`detectOriginal`, `originalMetrics`)

On the course `Walking.mat`, both give the same step indices and metrics as the
original script run in GNU Octave, for columns 2, 3 and 4
(`tests/core.test.js`, `tests/test_python_port.py`, `scripts/octave_parity.sh`).

## Issues found in the original

1. **Tied peaks are counted twice.** Values are rounded to 0.01, so two samples near a
   peak can share the maximum. Both pass `A(i) == max(...)`, which creates intervals of
   1–2 samples. These inflate `VariabilitySteps` and shift the odd/even pairing in
   `GaitAsymmetry`. On `Walking.mat` column 2 this happens twice (samples 471/472
   and 1036/1037).
2. **Start/stop artefacts.** The small bump when the walker stops (15.6 s in
   `Walking.mat`) clears `h = 1` and is counted as a step.
3. **Fixed 100 Hz.** Phone apps sample unevenly and not always at 100 Hz.
4. **"Pace" is not steps per minute** (see the table above).
5. **Peaks may be strides.** In `Walking.mat` the clean peaks repeat about every
   1.14 s, which is slow for single steps (normally 0.45–0.7 s). If the phone rode
   on one leg, each peak is a left plus a right step.

## Coza (`detectCoza`, `cozaMetrics`)

Coza is the dashboard's first step detection algorithm: the lab code with the problems
above fixed. It is picked from the **Algorithm** dropdown; later algorithms are added as
entries in `ALGORITHMS` in `src/core.js`, and the lab code stays alongside each of them
as the MATLAB reference.

Each fix can be switched on or off under Advanced, so its effect can be seen on its own.
Window `w` and threshold `h` are shared with the original.

| Fix | Rule |
|---|---|
| Tied peaks once | A sample must also be strictly greater than every earlier sample in its window, so on a plateau only the first sample counts. |
| Weak peaks | Peak strength is `A(i) − h`. A peak is dropped when its strength is below *r* × the median strength (default *r* = 40%). This keeps the real first step in `Walking.mat` (strength 0.83) and drops the stop bump (0.13). |
| Real timing | Intervals come from the timestamps, not `samples / 100`. |
| Cadence | `60 / mean step interval`, in steps/min. |
| Strides (optional) | Each peak counts as 2 steps; cadence doubles. Asymmetry is not reported, because it needs single steps. |

Variability is reported as the standard deviation of intervals in ms, plus the
coefficient of variation.
