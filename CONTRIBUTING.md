# Contributing

Every change reaches `main` through a pull request:

**new branch → atomic commits → pull request → merge into `main`**

Nobody pushes to `main` directly, including the owner and AI assistants.

## 1. Branch

Start from an up-to-date `main`:

```bash
git switch main && git pull
git switch -c <type>/<short-description>
```

| Type | For |
|---|---|
| `feat/` | New behaviour in the dashboard or the Python port |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `test/` | Tests or fixtures only |
| `chore/` | Tooling, dependencies, CI, scripts |

Use lowercase words joined by hyphens: `fix/physics-toolbox-exports`, `chore/python-env`.
Keep one topic per branch. If you find an unrelated problem, fix it on its own branch.

## 2. Atomic commits

One commit is one logical change that can be reviewed, reverted or cherry-picked on
its own.

- **Tests pass at every commit**, not just at the end of the branch. Run both suites
  before each commit:
  ```bash
  npm test
  uv run pytest
  ```
- **Code, its tests and its docs go in the same commit.** For example, a new
  validation check comes with its test and its row in `docs/schema.md`.
- **Don't mix concerns.** Keep a refactor, a bug fix and a dependency bump in separate
  commits, even when they touch the same file. `git add -p` stages part of a file.
- **Message:** an imperative subject line of at most 72 characters ("Skip '#' metadata
  lines in CSV exports", not "fixed stuff"), then a blank line and a body that says
  *why* the change is needed.
- **Regenerated fixtures:** `scripts/make_fixtures.py` rewrites every `.mat` fixture
  with a new timestamp in its header. Commit only the fixtures that really changed
  (`git checkout -- tests/fixtures/<unchanged>.mat`).

Before opening the PR, tidy the branch into atomic commits. Squash "fix typo" and
"oops" commits into the commit they fix.

## 3. Pull request

```bash
git push -u origin <branch>
gh pr create --base main --fill
```

- Fill in the template: what changed, why, and how it was checked.
- CI (`.github/workflows/ci.yml`) runs when the pull request is opened and on every push to
  it after that. It must be green: the Node job and both Python jobs (3.12 and 3.14).
- If `main` moves on, rebase onto it (`git fetch && git rebase origin/main`) instead of
  merging `main` into the branch.

## 4. Merge into `main`

- Use **Rebase and merge**. It keeps the atomic commits and gives `main` a linear
  history. Don't squash; squashing throws away the commit structure built in step 2.
- Delete the branch after merging.
- `main` is deployed to GitHub Pages, so a merge changes the live dashboard.

## Contributing from a fork

Without write access to this repository, work in a fork. The rest of this guide applies
unchanged.

1. **Open an issue first** for anything beyond a small fix, so the approach is agreed
   before you spend time on it.
2. Fork the repository, then create a branch in your fork, named as in step 1 above.
3. Make atomic commits that pass both test suites, as in step 2 above.
4. Open a pull request against `main` here and tick **Allow edits by maintainers**, so the
   owner can rebase it if `main` moves.
5. CI runs on your pull request. The first time you contribute, the owner approves the run
   before it starts.
6. When `main` moves, rebase onto it (`git fetch upstream && git rebase upstream/main`,
   then `git push --force-with-lease`); the branch must be up to date to merge.
7. The owner reviews and merges with Rebase and merge.

**Licence of contributions.** Contributions are made under the repository's licence
(`LICENSE`), the same terms the code is used under ("inbound = outbound"). No separate
agreement or sign-off is needed.

**Students taking the course.** This repository started from a lab of BME 598/494 (Dr. Aurel Coza).
If you are taking that course, check its rules on
collaboration and outside code before contributing; a contribution may count as shared
work on an assignment.

## Rules that apply to every change

These come from `CLAUDE.md`:

- The *original* algorithm (`detect_steps`/`gait_metrics`, `detectOriginal`/
  `originalMetrics`) stays bit-exact with MATLAB. Improvements go into our own
  algorithms (entries in `ALGORITHMS` in `src/core.js`, currently Coza) only.
- `src/core.js` has no DOM access.
- Never commit course files. `data/` is git-ignored except its README.
- The dashboard stays a static page with no build step.
- Python dependencies are managed with uv: `uv sync` builds `.venv/` from `uv.lock`.
  Add a package with `uv add <pkg>` (`uv add --dev` for test tools) and commit
  `pyproject.toml` and `uv.lock` together. Never `pip install` into the system Python.
  Minimum Python is 3.12.
