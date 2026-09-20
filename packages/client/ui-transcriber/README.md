---
description: "The right Sidebar's medical-lecture panel: workspace modules, lecture completion, live five-phase run progress, and refresh behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-transcriber

English | [中文](README.zh.md)

## Summary

A right-Sidebar tab type that answers one question — where do my lectures stand — by reading the transcriber workspace directly: one row per module, every local or NotebookLM lecture, live five-phase progress for the newest run, and counts that include recordings with no local copy. Each module also exposes native drop targets for recordings/slides and exam material; the Host capability copies the dropped files and reports mixed outcomes. It registers through the Sidebar's public two-stage path and patches nothing upstream.

## Table of Contents

- [Why it reads the workspace itself](#why-it-reads-the-workspace-itself)
- [The layout it expects](#the-layout-it-expects)
- [What a lecture is](#what-a-lecture-is)
- [Live run state](#live-run-state)
- [Dropping files](#dropping-files)
- [What it will not do](#what-it-will-not-do)
- [Registration](#registration)
- [Copy](#copy)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="why-it-reads-the-workspace-itself"></a>
## Why it reads the workspace itself

The pipeline this panel reports on is a Python engine, reached from the chat as an MCP tool server. The obvious design would be to draw whatever that server last answered. The panel does not, because a sidebar redraws on every change and a redraw that has to start a subprocess is a redraw that mostly shows stale state — the reader drops a recording into a folder and the panel would keep insisting the module is empty until something else happened to run a tool.

So the panel reads the disk half through `remote.workspaceFiles`, the same read-only file service the file tree uses, and decides for itself. After that immediate paint, the shared workspace reader asks `remote.transcriberEngine.listLectures` once per module and merges the NotebookLM answer. The cost is that the rule for what counts as a lecture exists twice, in two languages. That cost is paid down in the one place it could actually hurt: both implementations read `tests/fixtures/lecture-grouping-cases.json`, so a change to either that the other does not follow fails both suites. The copy here is checked byte for byte against the engine's original whenever `TRANSCRIBER_SKILL_ROOT` points at a checkout beside this one.

<a id="the-layout-it-expects"></a>
## The layout it expects

```
<workspace>/modules/<id>/module.json     the module's own display_name
                        /Lecture/        recordings, read recursively
                        /Questions/      exam material
                        /Transcripts/    finished transcripts, read flat
```

These three names are a convention the engine resolves the same way, not settings a reader could change out from under the panel. A folder under `modules/` with no `module.json` is not a module and is skipped, which is what the engine does with it too. A dot folder is skipped.

A missing folder is not a failure: a workspace with no `modules/` yet, or a module with no `Lecture/` yet, is the normal first screen of setup and draws as empty. A failure that is *not* a missing folder is passed on and shown — reporting a dropped connection as "no modules yet" would send a reader off to recreate modules they already have.

Recursion under `Lecture/` stops at four levels. The engine globs the whole subtree; a panel that redraws constantly wants a listing that cannot become unbounded, and no real layout nests deeper than that.

<a id="what-a-lecture-is"></a>
## What a lecture is

**A lecture split across files is one lecture.** `Corrosives Part 1.mp3` and `Corrosives Part 2.mp3` are one row whose title carries no chunk number, matching the engine's rule that a multipart lecture is one unit and one run. Listing them separately would invite two runs over halves of one lecture. `Part 2`, `(2)`, `- 2`, `.2`, `_2` and the Arabic `جزء 2` all group, ordered by part number.

A trailing year does not group, and that guard is narrower than it looks: a two-digit cap alone does not give it, because a digit run anchored at the end matches its own last two digits just as happily — `Revision 2024` would split into `Revision 20` part 24, and sit in one fake lecture beside `Revision 2025`. The lookbehind requiring a complete digit run is what actually holds.

Grouping applies only when two or more files share a base, so a lone `food poisoning (1).mp3` keeps its own stem as its title rather than being silently retitled.

Only audio and video extensions are listed. Slides and papers share the `Lecture/` folder and must never be offered as a lecture to transcribe.

A lecture counts as transcribed when its title appears *within* a transcript's stem, not when the two are equal: a finished transcript carries decoration the recording does not, and `مراجعه اشعه 🩻.md` is the transcript of `مراجعه اشعه.m4a`. `Index.md` is excluded — it lists the deliverables and is not a transcript.

A transcript no recording title matches is still a lecture, listed with no sources. The audio is large and the transcript is the deliverable, so a recording is often deleted once it is transcribed; listing only what can still be transcribed would answer "no lectures" for a module whose finished transcripts are sitting right there. Having no sources is also what keeps such a row from being offered as something to run: there is no audio to run over. A transcript a recording title already matched is claimed by that lecture and is not listed a second time on its own.

A recording uploaded to NotebookLM is also a lecture when its local copy is gone. The merged row has no local sources and cannot be opened or offered to a file-based action. A local recording and its NotebookLM copy share one row, so the module count does not double-count it.

<a id="live-run-state"></a>
## Live run state

The panel reads the newest directory under `.transcriber-cache/runs/` for each module and folds its `events.ndjson` from the last `init` line. A resumed run therefore reports the current attempt, and an incomplete final line does not hide the preceding phases.

Each lecture row reuses the lecture-title containment rule to attach the run. While a run is unfinished, the row shows the five-phase progress bar and active phase; a failed phase moves the row to Failed instead of leaving it under Waiting.

A visible panel polls every five seconds only while at least one module has an unfinished run. The poll reads `Lecture/`, `Transcripts/`, `Questions/`, and run state from disk; it does not start another NotebookLM request. The initial read and the reload control ask for the NotebookLM half, which arrives after the disk paint. A slow or failed listing leaves the disk rows visible with a plain status sentence. The poll stops after a `result` event, and a panel with no unfinished run does not poll. Five seconds keeps an hour-long run live enough to read while limiting polling ticks to twelve per minute.

<a id="dropping-files"></a>
## Dropping files

Each module shows one drop target for recordings and slides and one for exam material. Tauri supplies absolute native paths to the WebView; the panel sends those paths to `transcriberEngine.importFiles`, which copies them into the selected module folder and then refreshes the listing. The result keeps filed paths and every rejected filename with its reason, and displayed paths use left-to-right direction even in the Arabic locale.

<a id="what-it-will-not-do"></a>
## What it will not do

The panel has reload, a module's disclosure, and two drop targets per module. It offers nothing that starts a run, and a spec holds it to that.

This is deliberate rather than unfinished. The tools that would be behind such a button write to the reader's own study material and to their NotebookLM, and three of them refuse to run without an explicit confirmation flag for that reason. Asking for a run belongs in the chat, where the request is a sentence the reader wrote, not a button they brushed past on the way to something else.

The panel does not write through `remote.workspaceFiles`: that surface remains read-only. A drop delegates copying to the separate `transcriberEngine.importFiles` capability, which refuses module escapes, never overwrites a colliding name, and leaves the original source in place.

<a id="registration"></a>
## Registration

The public two-stage path, unmodified — the type into `ctx.sidebarRightTabs`, the body and chip title into the keyed `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` seats under the type's own `id`. The type is a page: it claims no address, so it can never take a file a viewer should open. It binds to `ctx.sidebarRight`, the service face, rather than to the docking kit, whose exports are documented as free to change in any release.

One row in the web bundle's patch list loads it. Nothing upstream is patched to make room for it.

<a id="copy"></a>
## Copy

Every string comes from the `transcriber` locale namespace. The bundled `dsh-client-locale-ar` language pack supplies the Egyptian Arabic copy without changing the built-in locale ids or metadata.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The grouping rule lives in two languages.** The shared case file is what keeps them honest; it is not the same thing as having one implementation.
- **NotebookLM inventory is on demand.** The panel does not cache a server answer or poll the unofficial client; opening the panel and pressing reload can take as long as the engine listing.
- **Native drops are desktop-only.** A browser build without Tauri's event bridge keeps the panel readable but has no native file paths to import.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pipeline this panel reports on lives in another repository, and the rule for what counts as a lecture is implemented there in Python as well as here in TypeScript. `tests/fixtures/lecture-grouping-cases.json` is a copy of that repository's `references/lecture-grouping-cases.json`; set `TRANSCRIBER_SKILL_ROOT` to a checkout beside this one and the suite additionally compares the two byte for byte.

</details>

**Runtime invariant:** No companion is published. The panel's only runtime state is one Slot store per tab, written by the body that owns it and forgotten on the tab's abort signal; workspace reads remain on the read-only `workspaceFiles` surface, while file copying is owned by the engine capability.
