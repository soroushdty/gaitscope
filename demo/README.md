# Demo walks

Three real walks the dashboard offers under **Try a demo walk**, next to the synthetic one
(#91). The page fetches them from this folder when they are picked. All three were recorded
by the owner, Dr. Soroush Dianaty, on 2026-10-07 with the dashboard's own recorder (#51), on
a Pixel 9a in Firefox 157 (Android 17), at about 57.4 Hz. The files are byte for byte what
the recorder saved, metadata lines included, so they load exactly like a downloaded
recording.

| File | Phone | Steps counted | Length | What else is in it |
|---|---|---|---|---|
| `walk-hand.csv` | Held flat, screen up, in portrait, at the chest just below the breastbone | 10, slow (about 1 s apart); the last brings the feet together | 13.3 s | Settling after the stop (10.8 s), and the press on Stop 1 s before the end (12.3 s) |
| `walk-pocket.csv` | Right front trouser pocket | 28 (about 0.79 s apart) | 28.2 s | Putting it in the pocket (0–1.9 s), and taking it out and holding Stop (from 24.5 s) |
| `walk-noisy.csv` | Moved around on purpose (below) | not counted | 42.3 s | The phone changing position four times |

**The noisy walk** shows what sudden changes in phone position do to the signal. The phone
was held:
- flat in front (0–5.5 s);
- at the side with the arm swinging (6.5–14 s): it stands on its edge and turns at about 2 rad/s;
- flat in front again (15.5–22 s);
- in the left hand at the side (23–26 s), on its other edge;
- flat and nearly still at chest level (from 27.5 s).

Each change shows as a jump in the separate axes. The steps weren't counted, so the page
doesn't score the detectors on it. They disagree with each other: on the total, with their
default settings, 51 to 65 steps. The spectrum's walking rhythm, about 99 steps a minute,
suggests about 70. A Physics Toolbox recording made at the same time (not included) gives
the same steps for each detector whose window is in seconds, so the disagreement comes from
the walk, not from the recorder (#51).

On the up-and-down signal (vertical, or the total TgF), every detector finds the hand and
pocket walks' steps to within one. The extra steps come from the ends. They were recorded before
the recorder learned to cut the Stop press out (#87), and are kept as recorded.
