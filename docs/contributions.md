# Contributions and use of AI

This page says who did what in this repository, and how the work was checked. It is the
record a paper, a course submission or a reviewer can point to. Keep it accurate: it is
only useful if the git history and the issue tracker bear it out.

## Summary

The project is directed by its owner, Soroush Dianaty. Almost all code, tests, fixtures
and documentation were written by Claude Code (Anthropic's AI coding assistant), working
in sessions the owner started and steered. The owner decided what to build and accepted,
changed or rejected what the AI proposed. Nothing reaches `main` without the owner merging
it. Correctness does not rest on the AI: it is checked against independent reference
implementations, GNU Octave running the original script, and the owner's own recordings.

## Who did what

Roles follow the [CRediT taxonomy](https://credit.niso.org/).

| Role | Owner | Claude Code |
|---|---|---|
| Conceptualization | The project and its direction: a Python port and a dashboard for the lab, then an open teaching tool (#42); which features to add (#11, #51, #61, #64) | Analyses of each request: options, prior work, trade-offs and a recommendation (e.g. #11) |
| Decisions | Every "decisions needed" item, the licence and naming (#42), accepting or rejecting recommendations | None. Its recommendations are proposals until the owner decides |
| Methodology | The rules every change follows (`CLAUDE.md`, `CONTRIBUTING.md`), set or approved by the owner | Technical design: the details of the algorithms, file formats, the cross-checks against scipy, numpy and Octave |
| Software | Review of every pull request before merging | Nearly all code, tests and fixtures |
| Data | All real recordings besides the course's `Walking.mat` (Physics Toolbox and phyphox exports from the owner's phone) | Synthetic fixtures (`scripts/make_fixtures.py`) |
| Validation | Real-device checks, recordings with hand-counted steps (#68), the instructor's answers (#67) | Automated tests, reference-implementation fixtures, headless-browser checks |
| Investigation | Questions to research and verdicts accepted (e.g. the five ideas in PR #59) | Literature and tool research, benchmarks, research write-ups (PR #59) |
| Writing | Review and final approval of all text | Drafts of the documentation, issue analyses and pull request descriptions |
| Supervision, accountability | All of it. The owner is responsible for everything in the repository | None. An AI can't be an author or take responsibility |

The course instructor, Dr. Aurel Coza, wrote the original step-detection script
(`LabStepDet_2025.m`). The repository ports its rule exactly and credits it. The script and
the course data are never committed.

## Where to see it

- **Commits.** Every commit on `main` (108 of 108 before this page, on 2026-10-07)
  carries a `Co-Authored-By: Claude` trailer. Merging into `main` is the owner's.
- **Pull requests.** Descriptions written by the AI end with "Generated with Claude Code"
  and a link to the session. Requests from the owner are marked "Requested by the owner".
- **Issues.** Analyses list the decisions they need. The owner's answers are recorded in
  the issue or the pull request that closes it.
- **Research.** PR #59 records the owner's ideas and the AI's verdict on each, including
  one it rejected.

## How correctness was established

The AI's output was not trusted on its own. Each result is checked against something the AI
did not write:

- **The original script.** The Python and JavaScript ports give the same steps and metrics
  as GNU Octave running `LabStepDet_2025.m` (`scripts/octave_parity.sh`).
- **Reference libraries.** Filters, spectra, envelopes and resampling match scipy, numpy
  and PyWavelets (`tests/fixtures/*.json`, written by `scripts/make_fixtures.py`).
- **Independent readers.** Exports read back with scipy, numpy, Python's `zipfile` and
  `csv`, and Octave (`docs/export.md`).
- **Continuous integration.** Both test suites run on every pull request, on Node and on
  Python 3.12 and 3.14.
- **Real data.** The owner's own phone recordings, and walks with hand-counted steps
  (#68, in progress).

## Recording decisions from now on

So that the record stays clear:

- When the owner decides something in an issue or a pull request, start the comment with
  **"Decision (owner):"**.
- Write down the owner's own ideas in the issue before an AI session expands them.
- When an idea comes from an AI session, the issue or pull request says so.
- Update this page when the roles change, for example when someone else contributes.

## Text for a paper

A starting point for an author-contributions and AI-use statement. Fill in the brackets and
check each claim against the record above before using it.

> **Author contributions.** S.D.: conceptualization, design decisions, data collection
> (all recordings and hand-counted step counts), validation on physical devices,
> supervision of all AI-generated work, and final review of all code and text.
> [Other authors and their roles.]
>
> **Use of generative AI.** The software, tests and documentation were written with
> Claude Code (Anthropic; [models and dates]) under the author's direction. The AI wrote
> most of the code and drafted documentation and design analyses, including alternatives
> and recommendations, which the author accepted, modified or rejected. Project decisions
> were made by the author and are recorded in the public issue tracker. Correctness was
> established independently of the AI, through reference implementations (scipy, numpy,
> PyWavelets, GNU Octave), continuous integration, and the author's own recordings. The
> author takes full responsibility for the content.
