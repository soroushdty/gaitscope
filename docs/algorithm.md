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

## Vertical and horizontal acceleration (`gravitySplit`)

A phone in a pocket is tilted and turns during a walk. The step bounce is then spread
over x, y and z in proportions that drift. The magnitude avoids the tilt, but it mixes
in forward and sideways motion and can show two bumps per stride. **Signal to analyse**
offers two signals computed from x, y and z that don't depend on the tilt:

1. **Gravity's direction:** x, y and z low-passed at 0.3 Hz (2nd-order Butterworth, run
   both ways). Slow enough to ignore the steps, fast enough to follow the phone tilting.
2. **Vertical** = each sample projected onto that direction, minus the size of gravity.
   Standing still reads 0 whatever the tilt, so `h` for Coza and the lab code belongs a
   little above 0 (about 0.1 g or 1 m/s²), not at 1.
3. **Horizontal** = the size of what is left after the vertical part is removed: forward
   and sideways sway.

This needs gravity in the data. The sensor name decides when the file has one: G-Force
yes, Linear Accelerometer no. Otherwise gravity must be a steady vector, at least 2× the
motion around it and varying by under 15%. On the owner's recordings the G-Force export
measures 4.8× and 3%; `Walking.mat`, the test fixture and the demo measure under 0.6× and
over 35%. Without gravity the options are listed but disabled, with the reason.

On a synthetic walk seen by a phone that tilts by 0.4–1.0 rad and turns about the
vertical, the vertical signal is within 0.14 of the true bounce (amplitude 2), and every
algorithm finds the same steps as on the bounce itself (`tests/core.test.js`).

## Signal filters (`FILTERS`, `applyFilter`)

A **Filter** dropdown, above Algorithm, picks a filter for the signal the selected
algorithm runs on. The default is None. The lab code always runs on the recorded
signal, so it stays exact. The plot draws the recorded signal faded and the filtered
one over it.

| Filter | Passband | Stopband | Trade-off |
|---|---|---|---|
| Butterworth | Flat | Gentle roll-off | Little change to the shape of each step |
| Bessel | Flat, gently falling | Gentlest roll-off | The most even delay across frequencies, so steps keep their shape best (least overshoot). The cut-off is where the phase is half delayed (scipy's `norm='phase'`), so the gain there is above ½. |
| Chebyshev I | Ripple (default 0.5 dB) | Steeper roll-off | Ripple slightly reshapes peaks. The cut-off is where the ripple band ends. |
| Chebyshev II | Flat | Ripple, at least the set attenuation (default 40 dB) | The cut-off is where the stopband starts, so the passband ends lower. |
| Elliptic | Ripple (default 0.5 dB) | Ripple, at least the set attenuation (default 40 dB) | The steepest roll-off for its order. The cut-off is where the passband ripple ends. |

Smoothing filters take a window in seconds, which becomes an odd number of samples
(`2·round(seconds·fs/2) + 1`) centred on each sample. They and the notch are checked
against scipy, edges included, on a signal with spikes (`other` in
`tests/fixtures/filters.json`).

| Filter | What it does | Edges | Note |
|---|---|---|---|
| Moving average | Mean over the window (default 0.1 s) | Repeat the end sample (scipy `ndimage.uniform_filter1d`, `mode='nearest'`) | The simplest smoother; it also lowers peaks |
| Median | Median over the window (default 0.05 s) | Repeat the end sample (scipy `ndimage.median_filter`, `mode='nearest'`) | Removes spikes shorter than half the window (a tap or knock) and keeps real peaks at their height. Not a frequency filter. |
| Savitzky–Golay | Least-squares polynomial (default order 3) over the window (default 0.3 s); keeps its centre value | The first and last half-windows use the polynomial fitted to the first and last full window (scipy `savgol_filter`, `mode='interp'`) | Smooths noise while keeping peak heights and timing better than an average. The window needs at least order + 2 samples. Checked against scipy where scipy is exact to 1e-12, and against exact rational weights for a 231-sample, order-5 window, where scipy's own weights are off by 1.5e-10 (it fits unscaled positions; this fit scales them to [−1, 1]). |
| Notch | Removes a band frequency ÷ Q wide around one frequency (default 50 Hz, Q 30), as scipy `iirnotch`, run forwards and backwards | Same odd padding as the other IIR filters | For mains hum or a known vibration. A narrow notch (high Q) rings for a few hundred milliseconds at each end of the recording. Only reachable at high sampling rates: the frequency stays below half the sampling rate (28.5 Hz on the Linear Accelerometer export). |

Settings, under Advanced: order 2–6 (default 4), low-pass cut-off (default 3 Hz,
kept below half the sampling rate), and an optional high-pass cut-off (default off).
Two presets set order 4 and a band-pass common in gait papers, walking 0.5–3 Hz and
running 1–5 Hz, and keep the selected filter type. A
high-pass removes gravity and drift and turns the filter into a band-pass of twice the
order, as in scipy. The centred signal then needs a different `h` for Coza.

How it is built (`designFilter`, `sosfiltfilt`):

* The design follows scipy's `iirfilter`: analog prototype poles and zeros (`buttap`,
  `besselap` (roots of the reverse Bessel polynomial, by Aberth iteration), `cheb1ap`, `cheb2ap`, `ellipap` (Jacobi elliptic functions as cephes `ellpj`, the degree equation by nomes, `K` by the arithmetic-geometric mean and `F` by Carlson's `RF`)), pre-warped low-pass or band-pass transform, bilinear transform,
  and second-order sections. Sections stay numerically stable at the low cut-off to
  sampling-rate ratios of phone data (0.3 Hz at 460 Hz).
* Filtering runs forwards and backwards like scipy's `sosfiltfilt`, with the same odd
  padding and steady-state start, so steps keep their timing. The two passes square the
  magnitude response: the gain at a Butterworth cut-off is ½, and a Chebyshev ripple of
  0.5 dB becomes 1 dB.
* `scripts/make_fixtures.py` writes scipy's frequency responses and outputs for every
  type, orders 2–6, at 57, 100 and 460 Hz, low-pass and band-pass
  (`tests/fixtures/filters.json`). The JS versions match within 1e-9. The pairing of poles
  into sections differs from scipy's, which does not change the filter.
* IIR filters assume even spacing. When timestamps vary by more than 1%, the signal is
  interpolated onto an even grid at the median rate,
  filtered, and read back at the original timestamps. The algorithm still sees one value
  per recorded sample, and a check says it happened. Of the owner's phone exports, the
  Linear Accelerometer file (36% variation) is resampled; the G-Force file (0.5%) is not.

On a known walk with a 25 Hz vibration and a 60 Hz hum added, each filter brings every
algorithm back to the steps it finds on the clean walk (`tests/core.test.js`). The
algorithms that smooth internally (Threshold peaks, Peak-to-valley, Zero-crossing) still
apply their own low-pass on top of the filter.

## Envelopes (`ENVELOPES`)

An **Envelope** select in the plot toolbar draws curves around the signal the algorithm
sees: the filtered signal when a filter is on, the recorded signal otherwise. Envelopes
are a view, like notes: they never change the detected steps, the metrics or the
exports. The fixed `h` line stays, so the two kinds of threshold can be compared.
Windows are in seconds, so an envelope looks the same at 57 Hz and 460 Hz.

| Envelope | How it is computed | What it shows |
|---|---|---|
| Sliding window | Running max and min over a centred window (default 1 s), `windowExtreme` | How big the swings are at each moment: walking vs. standing, speeding up, slowing down |
| Peak-trough | Peaks are samples that are the highest within ±half a window (default 0.3 s), ties counted once as in Coza; troughs likewise. Successive peaks, and successive troughs, are joined by straight lines and held flat past the ends. | The outline of the step pattern. Uneven steps (one leg stronger) show as a zig-zag in the upper line. |
| Dynamic threshold | The sliding window band plus its midline `(max + min) / 2`, `dynamicThreshold` | Where an adaptive threshold would sit, next to the fixed `h`. It is the same function and window rounding Peak-to-valley counts steps with, so on the signal that algorithm smooths it draws exactly that algorithm's threshold. |
| Mean ± k·SD | Moving mean (the midline) ± k × moving SD over a centred window (default 1 s, k = 1), shortened at the ends. The SD divides by N, so with k = 1 the band is ± the RMS around the mean. | With k = 1, how hard the person is moving: it separates walking from standing, and one spike can't stretch it the way it stretches the max/min band. With k = 0.5, the upper line is where Threshold peaks' cut-off (mean + 0.5 SD, over the whole recording) would sit if it followed the signal, which shows why that algorithm counts noise on recordings with long rests. #38 listed RMS, moving SD and mean ± k·SD separately; they are this one envelope with different k. |
| Percentile band | The q-th and (100 − q)-th percentile (default 10th–90th) over a centred window (default 1 s), shortened at the ends, with numpy's default linear interpolation between ranks | Like the sliding max and min, but a single spike can't stretch it |

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

## Zero-crossing (`detectZeroCrossing`)

Uses timing, not peak height, so it ignores how hard each step lands.

1. Low-pass the signal (default 3 Hz).
2. Subtract a slow baseline: the smoothed signal low-passed again at 0.3 Hz. This
   removes gravity (1 g or 9.81 m/s² in G-Force data) and follows slow drift, such as
   the phone tilting. A 2 s moving average was tried first, but at about one step per
   second it ripples by up to a third of the signal's swing, because 2 s is not a whole
   number of steps.
3. Each upward crossing of zero is a step, with hysteresis: after a step, the signal must
   fall below −0.3 SD (of signal minus baseline) before the next crossing can count, and a
   crossing counts only once the signal goes on to rise above +0.3 SD. Noise near zero
   then adds no crossings. The 0.3 Hz and 0.3 SD are fixed; the cut-off is a setting.
4. Crossings closer than the minimum interval (default 0.25 s) to the last step are ignored.

Markers sit where the smoothed signal crosses its baseline, on the rise before the peak,
so their times are earlier than the peak-based detectors' (about 0.4 s on `Walking.mat`
column 2) but their intervals are the same. At the very first step the filter smears the rise from rest, so that one
crossing can come up to about 0.07 s early.

## Comparison on real recordings

Steps found with the dashboard defaults, and the mean interval between them (from the
timestamps, for every column). `Walking.mat` is the course file; the CSVs are the
owner's Physics Toolbox recordings from 2026-09-23 (G-Force Meter at ~460 Hz, 6.6 s;
Linear Accelerometer at ~57 Hz, 7.6 s). None of these files is committed.

| Signal | Lab code | Coza | Threshold peaks | Peak-to-valley | Zero-crossing |
|---|---:|---:|---:|---:|---:|
| `Walking.mat` x (column 2) | 15 (0.95 s) | 12 (1.15 s) | 12 (1.15 s) | 12 (1.15 s) | 12 (1.15 s) |
| `Walking.mat` y (column 3) | 12 (1.14 s) | 12 (1.14 s) | 17 (0.98 s) | 13 (1.13 s) | 13 (1.13 s) |
| `Walking.mat` z (column 4) | 21 (0.69 s) | 18 (0.82 s) | 16 (0.86 s) | 22 (0.71 s) | 17 (0.91 s) |
| `Walking.mat` magnitude (column 5) | 27 (0.49 s) | 23 (0.57 s) | 21 (0.57 s) | 23 (0.57 s) | 21 (0.66 s) |
| G-Force, gFz | 8 (0.80 s) | 5 (1.24 s) | 9 (0.75 s) | 8 (0.80 s) | 6 (1.13 s) |
| G-Force, TgF (magnitude) | 193 (0.03 s) | 7 (0.93 s) | 7 (0.93 s) | 11 (0.56 s) | 8 (0.81 s) |
| G-Force, vertical (computed) | 0 | 0 (7 at h = 0.1) | 8 (0.74 s) | 13 (0.48 s) | 8 (0.80 s) |
| G-Force, horizontal (computed) | 0 | 0 | 6 (0.85 s) | 9 (0.69 s) | 7 (0.91 s) |
| Linear Accelerometer, ay | 4 (1.78 s) | 6 (1.07 s) | 7 (0.81 s) | 6 (0.98 s) | 6 (1.17 s) |
| Linear Accelerometer, aT (magnitude) | 5 (1.53 s) | 7 (0.88 s) | 7 (0.88 s) | 8 (0.87 s) | 4 (1.44 s) |

What this shows, and what it doesn't:

* **On the lab's own channel (column 2) all four algorithms agree:** 12 steps,
  1.15 s apart. The peak-based detectors put them at Coza's times to within 0.05 s.
  Zero-crossing's are about 0.4 s earlier, because it marks the rise through the
  baseline rather than the peak. The lab code's 15 is these
  12 plus two tied duplicates and the stop bump.
* **Column 3** rests well away from its walking mean. Threshold peaks' global
  threshold (mean + 0.5 SD) then falls below the resting level, and it counts 5 peaks of
  noise before the walk starts and after it stops. Peak-to-valley and Zero-crossing each
  add one step at the start or the stop. This is the weakness the issue predicted for a
  global threshold.
* **Columns 4 and 5 and the magnitudes** have several bumps per stride, and the
  algorithms disagree by up to 6 steps. Without a known count, none of them can be
  called right.
* **G-Force vertical** rests at 0 g, so with `h = 1` Coza and the lab code find nothing.
  At `h = 0.1`, Coza finds the same 7 steps on it as on the magnitude (TgF), and
  Threshold peaks and Zero-crossing agree at 8.
* **The phone recordings are too short** (fewer than 10 steps) and have no known count,
  so they only show that every algorithm except the lab code gives a plausible rate at
  460 Hz. Their windows and cut-offs are in seconds and Hz, not samples.

To say which algorithm is best needs recordings with a known step count, for example
20 steps counted by hand at a normal pace, with the phone in the hand and in a pocket
(#11, decision 4). The synthetic walk in `tests/core.test.js` (`knownWalk`) has a
known count, and every algorithm finds all 20 steps there at 57, 100 and 460 Hz, with and
without gravity.
