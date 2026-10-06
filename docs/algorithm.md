# Step detection: the lab code and our algorithms

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

## Coza (`detectCoza`)

Coza is the dashboard's first step detection algorithm: the lab code with the problems
above fixed. It is picked from the **Algorithm** dropdown; later algorithms are added as
entries in `ALGORITHMS` in `src/core.js`, and the lab code stays alongside each of them
as the MATLAB reference.

Tied peaks are always counted once; the lab code, drawn alongside, shows the double
count. Weak-peak removal can be switched off under Advanced.
Threshold `h` is shared with the original. The window is not: the lab code keeps `w` in
samples, as in MATLAB, and Coza has its own window in seconds.

| Fix | Rule |
|---|---|
| Window in seconds | Default 0.3 s, which is the lab's `w = 30` at 100 Hz. It is turned into `round(seconds × fs)` samples, so the window covers the same time at any sampling rate. In samples, `w = 30` is only ±0.065 s at 460 Hz (free Physics Toolbox), where the lab code finds many noise peaks. |
| Tied peaks once | A sample must also be strictly greater than every earlier sample in its window, so on a plateau only the first sample counts. |
| Weak peaks | Peak strength is `A(i) − h`. A peak is dropped when its strength is below 40% of the median strength. The cut-off is fixed, not a setting: it keeps the real first step in `Walking.mat` (strength 0.83) and drops the stop bump (0.13), with a wide margin on both sides. |
| Real timing | Intervals come from the timestamps, not `samples / 100`. |
| Cadence | `60 / mean step interval`, in steps/min. |
| Strides | With Phone position set to *One leg*, each peak counts as 2 steps; cadence doubles. Asymmetry is not reported, because it needs single steps. |

Variability is reported as the standard deviation of intervals in ms, plus the
coefficient of variation.

Every algorithm's metrics come from the same function, `timingMetrics`, which works
only from the step times. Algorithms differ in which samples they call steps, never in
how the metrics are computed, so their results compare directly.

## Shared building blocks

| Function | What it does |
|---|---|
| `lowpass(A, fs, fc)` | 2nd-order Butterworth low-pass run forwards and backwards (MATLAB `filtfilt`, scipy `filtfilt`), so peaks keep their timing. Gain ½ at the cut-off `fc`. Same output as scipy to 1e-13. Uses the median sampling rate; phone timing jitter is small next to a cut-off of a few Hz. |
| `dynamicThreshold(A, half)` | Sliding max and min and their midpoint. |

## Threshold peaks (`detectThresholdPeaks`)

The textbook peak detector. Coza is already a threshold-based peak detector, so this
one is not a copy: it adds exactly the parts Coza lacks, to test whether they beat
Coza's fixes.

1. Low-pass the signal (default 3 Hz).
2. Threshold = mean + k × SD of the smoothed signal (default k = 0.5). It follows the
   signal's units and offset, so it needs no `h`: the same k works in g, in m/s², with
   or without gravity.
3. Local maxima of the smoothed signal above the threshold are candidate steps.
4. Of two candidates closer than the minimum interval (default 0.25 s), only the taller
   counts. Taller peaks are placed first, as in scipy's `find_peaks(distance=…)`.

Markers sit on the smoothed signal, which is drawn with the threshold. The weakness is
the global threshold: a long rest pulls the mean and SD down, so noise at rest can clear
it.

## Peak-to-valley (`detectPeakToValley`)

Min-max detection with a threshold that moves with the signal, after
[Zhao (2010, Analog Devices)](https://www.analog.com/en/resources/analog-dialogue/articles/pedometer-design-3-axis-digital-acceler.html).
Coza's threshold `h` is fixed for the whole recording; here it is recomputed at every
sample.

1. Low-pass the signal lightly (5 Hz, fixed), so noise does not split one rise in two.
2. Threshold = (max + min) / 2 of the smoothed signal over a centred sliding window
   (default 1 s). Zhao updates it every 50 samples from the previous block; a centred
   window is possible here because the whole recording is available.
3. The smoothed signal alternates between runs above and below the threshold. Each run
   above followed by a run below is a candidate step, marked at its peak.
4. Swing = peak − the lowest point of the run below. A candidate counts when its swing is
   at least 40% of the median swing (a setting). This drops the small wiggles of standing
   still, in any units. Zhao uses a fixed swing instead, which depends on the units.
5. Of two steps closer than the minimum interval (default 0.25 s), the one with the
   larger swing is kept.

The weakness is signals with several bumps per step (the magnitude, or the vertical
axis): each bump that crosses the moving threshold is a candidate, and similar-sized
bumps all pass the swing rule.
