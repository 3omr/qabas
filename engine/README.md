# Qabas transcription engine

This directory contains Qabas's Python engine, copied from the universal-transcriber skill repository at commit `c1168da`. Qabas owns this copy and its tests independently. Runtime and tests require no skill checkout, skill instructions, mirror, installer, or skill release metadata. The app reports its own version and does not check for skill updates.

The scripts require Python 3.10 or later. Create the environment from this repository root:

```sh
python3 -m venv engine/.venv
engine/.venv/bin/python -m pip install -r engine/requirements.txt -r engine/requirements-dev.txt
pnpm run engine:test
pnpm run engine:lint
pnpm run engine:typecheck
```

On Windows, use `engine/.venv/Scripts/python.exe`. The root commands select that environment when present, otherwise `python3`. `engine:test` runs unittest discovery; the additional desktop cases use pytest (`engine/.venv/bin/python -m pytest engine/tests`). CI runs both suites and the two static checks. NotebookLM, OCR, office conversion and media commands remain external dependencies; run `engine/.venv/bin/python engine/scripts/run_transcription.py --doctor` to inspect them. The optional Whisper backend needs the packages listed in [requirements.txt](requirements.txt).

Run the MCP server or apply the app's patch:

```sh
engine/.venv/bin/python engine/scripts/mcp_server.py --help
pnpm dsh --profile web --patch engine/transcriber.cordis.yml
```

Activate the environment before using the source profile so `python3` finds its dependencies. `TRANSCRIBER_ENGINE_ROOT` overrides this directory; `TRANSCRIBER_SKILL_ROOT` remains a legacy override. `TRANSCRIBER_WORKSPACE` selects student data, not engine code. [Host resolution](../packages/api/transcriber-engine/README.md) defines workspace selection and errors.

For the desktop sidecar, install [requirements-build.txt](requirements-build.txt), then run `pnpm run engine:build` (or `bash engine/build-engine.sh` from any directory). Build on the target OS and architecture. The script produces `engine/dist/transcriber-engine-<target-triple>[.exe]`; `TRANSCRIBER_DIST_DIR` and `TRANSCRIBER_PYINSTALLER_WORKDIR` override output directories. Desktop preparation copies the native sidecar and [MCP patch](transcriber.cordis.yml) into `runtime/app/engine/`, which Tauri includes through its existing runtime resource mapping. The binary contains the app version and runtime references. The build script verifies its help entry, MCP initialization version and packaged editorial reference before reporting success.

The runtime [editorial guide](references/drafting-and-editorial.md) and [grouping cases](references/lecture-grouping-cases.json) are the only copied skill references. Python and TypeScript tests read the same grouping JSON. Omitted test files are `test_anki_extraction.py` and `test_anki_generator.py` (the separate Anki skill), `test_next_version.py` (skill release machinery), and `test_version_checker.py` (skill updates and shared skill-version metadata). Their 75 unittest cases account for the difference from the source's 716 cases. The launcher-discovery tests instead pin the bundled sibling script and reject a missing bundled engine; student workspaces are never searched for engine code.

Lecture visibility is module-owned metadata. `module.json` stores safe recording names relative to `Lecture/` in `hidden_recordings`; `hidden_transcripts` retains the recording association for existing transcripts with legacy custom titles. `hide_lecture(module, title)` hides a defined or automatic unit and removes its manual definition atomically under the registry lock. A manual id disambiguates duplicate titles. `restore_recordings(module, recordings)` removes selected names from the hidden list without recreating definitions. Neither operation changes source files, NotebookLM sources or transcript files. Hidden recordings remain in file inventory with `hidden: true`, are excluded from unassigned organization sources, and cannot be used in a definition until restored. Fully hidden units and their orphan transcript rows are omitted from library listings; partially restored units contain only visible recording sources.

The MCP tools run without a chat through the Host registry Remotes. Direct source and packaged entry points also accept `run_transcription.py --workspace <workspace> --module <module> --hide-lecture <title>` or `--restore-recordings <name>...`; the sidecar uses its `run-transcription` subcommand with the same flags.
