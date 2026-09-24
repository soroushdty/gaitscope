#!/usr/bin/env bash
# Run the course's original MATLAB script in GNU Octave and compare it with
# the Python port. Needs data/LabStepDet_2025.m and data/Walking.mat (course
# files, not committed) plus `octave-cli` and uv (Python runs in the project .venv).
#
#   bash scripts/octave_parity.sh            # columns 2, 3 and 4
set -euo pipefail
cd "$(dirname "$0")/.."
M=data/LabStepDet_2025.m; D=data/Walking.mat
[[ -f $M && -f $D ]] || { echo "Put LabStepDet_2025.m and Walking.mat in data/ first."; exit 1; }
command -v octave-cli >/dev/null || { echo "Install GNU Octave (octave-cli)."; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
status=0
for c in 2 3 4; do
  # same script, column swapped, plotting commented out so it runs headless
  sed -e "s/A=Walking (:,[0-9]);/A=Walking (:,$c);/" -e 's/^hold all/%&/' -e 's/^plot(A);/%&/' -e 's/^scatter(/%&/' "$M" > "$tmp/run_c$c.m"
  (cd "$tmp" && cp "$OLDPWD/$D" . && octave-cli -q --eval "load Walking.mat; run_c$c; printf('%d\n', Step1);" > oct.txt)
  py=$(uv run --locked python -c "
import sys; sys.path.insert(0,'python')
from scipy.io import loadmat; from lab_step_det import detect_steps
_, i = detect_steps(loadmat('$D')['Walking'][:, $c-1]); print('\n'.join(map(str, i)))")
  if [[ "$py" == "$(cat "$tmp/oct.txt")" ]]; then echo "column $c: identical ($(wc -l < "$tmp/oct.txt") steps)"; else echo "column $c: DIFFERENT"; status=1; fi
done
exit $status
