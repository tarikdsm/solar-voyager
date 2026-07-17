# T0044 Camera Controls Benchmark

Both measurements used the production Vite build, Chromium headless at
1280x720, 120 warmup frames, and 600 sampled frames on the same machine.

| Revision                 |   Median |      p75 |      p99 | JS heap delta | Main JS (gzip) |
| ------------------------ | -------: | -------: | -------: | ------------: | -------------: |
| `6edc357` before T0044   | 150.0 ms | 150.0 ms | 166.7 ms |  +1,200,019 B |      163.01 kB |
| `a65bc27` T0044 controls | 150.0 ms | 150.0 ms | 166.7 ms |    +168,356 B |      165.49 kB |

The headless Chromium render path on this machine was software/refresh limited,
so these figures are comparative rather than a hardware acceptance result. The
frame percentiles are unchanged. The added controller, input adapter, HUD, and
regression support add 2.48 kB gzip to the production entry chunk. Both runs
reported empty browser console/page-error collections; the after run's sampled
heap growth was 1,031,663 bytes lower than the baseline.

The dedicated WebGL acceptance (`npm run test:camera-controls`) additionally
verified 31 byte-stable surface-skimming frames and a 90-step Earth-to-Jupiter
transfer with an accumulated `-1000` wheel delta at midpoint. Its maximum
non-input per-step displacement was 13,951,067.344 km over a 639,687,262.867 km
target transfer, with departure/arrival steps of 123,711.239 km and 6,588.489 km
respectively. Production screenshots also prove that the center view changes
from Earth to a visible Jupiter after the real application transfer completes.
