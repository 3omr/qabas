---
description: "The right Sidebar's medical-lecture panel: the workspace's modules, which of their lectures the pipeline has transcribed, and which are still waiting." kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-transcriber

English | [中文](README.zh.md)

## Summary

A right-Sidebar tab type that answers one question — where do my lectures stand — by reading the transcriber workspace directly: one row per module, and under it the lectures already transcribed and the lectures still waiting. It registers through the Sidebar's public two-stage path and patches nothing upstream.

## Table of Contents

- [Why it reads the workspace itself](#why-it-reads-the-workspace-itself)
- [The layout it expects](#the-layout-it-expects)
- [What a lecture is](#what-a-lecture-is)
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

So the panel lists the workspace through `remote.workspaceFiles`, the same read-only file service the file tree uses, and decides for itself. The cost is that the rule for what counts as a lecture exists twice, in two languages. That cost is paid down in the one place it could actually hurt: both implementations read `tests/fixtures/lecture-grouping-cases.json`, so a change to either that the other does not follow fails both suites. The copy here is checked byte for byte against the engine's original whenever `TRANSCRIBER_SKILL_ROOT` points at a checkout beside this one.

<a id="the-layout-it-expects"></a>
## The layout it expects

```
<workspace>/modules/<id>/module.json     the module's own display_name
                        /Lecture/        recordings, read recursively
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

<a id="what-it-will-not-do"></a>
## What it will not do

The panel has exactly two controls: reload, and a module's disclosure. It offers nothing that starts a run, and a spec holds it to that.

This is deliberate rather than unfinished. The tools that would be behind such a button write to the reader's own study material and to their NotebookLM, and three of them refuse to run without an explicit confirmation flag for that reason. Asking for a run belongs in the chat, where the request is a sentence the reader wrote, not a button they brushed past on the way to something else.

The panel also never writes: its whole Remote surface is `list` and `read`.

<a id="registration"></a>
## Registration

The public two-stage path, unmodified — the type into `ctx.sidebarRightTabs`, the body and chip title into the keyed `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` seats under the type's own `id`. The type is a page: it claims no address, so it can never take a file a viewer should open. It binds to `ctx.sidebarRight`, the service face, rather than to the docking kit, whose exports are documented as free to change in any release.

One row in the web bundle's patch list loads it. Nothing upstream is patched to make room for it.

<a id="copy"></a>
## Copy

Every string comes from the `transcriber` locale namespace, in the two languages the client ships. The panel's readers are Arabic-speaking medical students and an Arabic dictionary is the obvious next addition; it waits on `LOCALE_IDS`, which is a client-wide change and not this package's to make.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No live progress.** A run in flight looks exactly like a lecture still waiting, until it finishes and its transcript appears. The engine already emits NDJSON phase events for this; carrying them from a tool call to the panel needs a channel that does not exist yet.
- **No automatic refresh.** The panel reads on mount and on reload. The Remote change feed reports instrumented filesystem operations, and the engine's writes are not among them, so a file dropped into `Lecture/` appears on the next reload rather than by itself.
- **The grouping rule lives in two languages.** The shared case file is what keeps them honest; it is not the same thing as having one implementation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pipeline this panel reports on lives in another repository, and the rule for what counts as a lecture is implemented there in Python as well as here in TypeScript. `tests/fixtures/lecture-grouping-cases.json` is a copy of that repository's `references/lecture-grouping-cases.json`; set `TRANSCRIBER_SKILL_ROOT` to a checkout beside this one and the suite additionally compares the two byte for byte.

</details>

**Runtime invariant:** No companion is published. The panel's only runtime state is one Slot store per tab, written by the body that owns it and forgotten on the tab's abort signal; its whole Remote surface is `list` and `read`, so there is nothing it can write that a second observation would have to agree with.
