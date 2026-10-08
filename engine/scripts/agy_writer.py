"""Antigravity writing with supplied evidence and an optional temporary prompt read."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
from typing import Any

import cancellation
from transcript_contract import (
    DraftingHandoffContext,
    build_drafting_contract,
    drafting_reference,
)

DEFAULT_MODEL = "gemini-3.8-flash-high"
DEFAULT_TIMEOUT_SECONDS = 600
SLIDE_OUTLINE_LIMIT = 40_000
DOCTOR_FIRST = """DOCTOR_FIRST:
- Every sentence of narration must come from what the doctor said in THIS verbatim segment. Never attribute a point to the doctor ("الدكتور بيقول/بيشرح/بيفصل") unless it is in this segment.
- The slides are a map, not a source of narration: use them only to decode garbled ASR into the correct medical term, drug name, number or dose when the segment clearly says it, and optionally to name a topic the doctor actually explained. Topics and their order come only from the spoken explanation.
- Do not narrate slide points the doctor did not say in this segment. For an important point skipped within a discussed topic, use at most ONE short callout under that topic: > **إضافة من الكتاب/السلايد — لم يشرحها الدكتور في التسجيل**.
- Numbers, percentages, doses and lists that appear only in the slides must go in that callout or the final folded unspoken section, never in narration or attribution to the doctor.
- No outside or textbook knowledge. Skip a passage too garbled to understand; never invent it. Never add content to reach a length target.
- Keep the doctor's own examples, stories, repetitions, exam tips, questions to students and side remarks."""
NO_TOOLS_RULE = (
    "IMPORTANT: Do not use any tools, do not read or write files, do not run commands. "
)
NO_TOOLS = NO_TOOLS_RULE + "Reply directly with the final markdown in your answer."
FILE_READ_RULE = (
    "IMPORTANT: The only permitted tool use is reading prompt.md in the current working directory "
    "with your file-reading tool, all of it to the end. Do not use any other tools, read other files, "
    "write files or run shell commands. "
)
FILE_READ_PROMPT = (
    "Read the file prompt.md in the current working directory with your file-reading tool "
    "(do not run shell commands), all of it to the end, and follow its instructions exactly."
)
EGYPTIAN_REGISTER = (
    "Narration and Clinical Explanation must be natural Egyptian colloquial Arabic: "
    "بيقول/بيوضح/عشان/مش/ده/دي/اللي/إن, with medical terms in English. "
    "Keep the doctor's quotes verbatim and sourced questions' examiner wording, repairing OCR only. "
    "MSA narration verbs (أوضح، أكد، أشار، تناول، انتقل إلى) are wrong here. "
    "Good: الدكتور بيوضح إن الـ Retina محتاجة نفهمها، مش نحفظها وخلاص. "
    "Bad: أوضح الدكتور أن فهم الشبكية ضروري وأكد أهمية دراستها."
)
RESPONSE_SCHEMA = json.dumps({
    "type": "object", "properties": {"guide": {"type": "string"}},
    "required": ["guide"],
})
_SUCCESSFUL_MODELS: dict[str, str] = {}


class AgyWriterError(RuntimeError):
    """The writer failed; existing staged parts remain available for resume."""


class AgyProposalError(AgyWriterError):
    """A completed model answer deterministically fails proposal JSON parsing."""

    def __init__(self, message: str, raw_proposal: str = "") -> None:
        super().__init__(message)
        self.raw_proposal = raw_proposal


@dataclass(frozen=True)
class Availability:
    binary: str | None
    models: str = ""
    error: str | None = None


@dataclass(frozen=True)
class WrittenPart:
    text: str
    seconds: float


def disabled() -> bool:
    return os.environ.get("TRANSCRIBER_AGY", "").strip().lower() in {"off", "0", "false", "no"}


def binary_path() -> str | None:
    binary = shutil.which("agy")
    fallback = Path.home() / ".local" / "bin" / "agy"
    return binary or (str(fallback) if fallback.is_file() else None)


def _listed_models(binary: str, timeout: int) -> str:
    try:
        with TemporaryDirectory(prefix="transcriber-agy-models-") as directory:
            checked = cancellation.run(
                [binary, "models"], cwd=directory, capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=timeout,
            )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AgyWriterError(f"agy models failed: {error}") from error
    if checked.returncode or not checked.stdout.strip():
        raise AgyWriterError(f"agy models failed: {(checked.stderr or checked.stdout).strip()[:1000]}")
    return checked.stdout.strip()


def availability() -> Availability:
    if disabled():
        return Availability(None, error="agy is turned off (TRANSCRIBER_AGY=off).")
    binary = binary_path()
    if binary is None:
        return Availability(None, error="agy is absent; install and authenticate Antigravity.")
    if binary in _SUCCESSFUL_MODELS:
        return Availability(binary, _SUCCESSFUL_MODELS[binary])
    listing_error = ""
    for timeout in (30, 90):
        try:
            models = _listed_models(binary, timeout)
        except AgyWriterError as error:
            listing_error = str(error)
        else:
            _SUCCESSFUL_MODELS[binary] = models
            return Availability(binary, models)
    # Listing can fail independently of writing; let the writer report its own failure.
    return Availability(binary, error=listing_error)


def _strip_json_fence(text: str) -> str:
    match = re.fullmatch(r"\s*```(?:json)?[ \t]*\r?\n(.*?)\r?\n[ \t]*```\s*", text, re.DOTALL | re.IGNORECASE)
    return match.group(1) if match else text


def _response(completed: subprocess.CompletedProcess[str]) -> str:
    stderr = completed.stderr.strip()
    if re.search(r"auto.?den(?:y|ied)|permission.*(?:den(?:y|ied)|required)|tool required.*permission|no output produced", stderr, re.I):
        raise AgyWriterError(f"agy permission auto-denial: {stderr[:1000]}. The writer must reply without tools.")
    if completed.returncode:
        raise AgyWriterError(f"agy exited {completed.returncode}: {(stderr or completed.stdout).strip()[:1000]}")
    try:
        envelope = json.loads(_strip_json_fence(completed.stdout))
    except json.JSONDecodeError as error:
        raise AgyWriterError(f"agy returned invalid JSON: {error}") from error
    if not isinstance(envelope, dict):
        raise AgyWriterError("agy returned a JSON value instead of a response object.")
    if envelope.get("status") != "SUCCESS":
        raise AgyWriterError(f"agy status {envelope.get('status')!r}: {str(envelope.get('response', ''))[:1000]}")
    text = envelope.get("response")
    if not isinstance(text, str) or not text.strip():
        raise AgyWriterError("agy returned an empty response; no part was staged.")
    return text.strip() + "\n\n"


def _trailing_json(text: str, position: int) -> list[dict[str, Any]] | None:
    decoder = json.JSONDecoder()
    objects = []
    while position < len(text):
        try:
            payload, position = decoder.raw_decode(text, position)
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        objects.append(payload)
        while position < len(text) and text[position].isspace():
            position += 1
    return objects


def _markdown_response(text: str) -> str:
    unfenced = _strip_json_fence(text)
    if unfenced.lstrip().startswith(("{", "[")):
        text = unfenced
    # agy appends completion objects even when response contains the full markdown.
    for opening in re.finditer(r"(?m)^[ \t]*\{", text):
        objects = _trailing_json(text, opening.end() - 1)
        if objects is None:
            continue
        markdown = text[:opening.start()].strip()
        if not markdown:
            guide = objects[0].get("guide")
            metadata = "toolAction" in objects[0] or "toolSummary" in objects[0]
            if isinstance(guide, str) and guide.strip() and (
                not metadata or re.search(r"(?m)^#{1,6}\s+", guide)
            ):
                markdown = guide.strip()
        if not markdown:
            raise AgyWriterError("agy returned only completion metadata; no markdown part was staged.")
        return markdown + "\n\n"
    return text.strip() + "\n\n"


@dataclass(frozen=True)
class Invocation:
    binary: str
    model: str = DEFAULT_MODEL
    timeout: int = DEFAULT_TIMEOUT_SECONDS


def _prompt_argument(prompt: str, directory: str) -> str:
    # Full multi-recording evidence can exceed the OS limit for one argv value.
    if len(prompt.encode("utf-8")) <= 60_000:
        return prompt
    content = prompt.replace(NO_TOOLS_RULE, FILE_READ_RULE)
    if NO_TOOLS_RULE not in prompt:
        content = FILE_READ_RULE + "\n\n" + content
    (Path(directory) / "prompt.md").write_text(content, encoding="utf-8")
    return FILE_READ_PROMPT


def _invoke(prompt: str, schema: str, invocation: Invocation) -> str:
    try:
        with TemporaryDirectory(prefix="transcriber-agy-write-") as directory:
            completed = cancellation.run(
                [invocation.binary, "-p", _prompt_argument(prompt, directory), "--model", invocation.model,
                 "--disable-slash-commands", "--output-format", "json", "--json-schema", schema],
                cwd=directory, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=invocation.timeout,
            )
    except subprocess.TimeoutExpired:
        raise AgyWriterError(f"agy timed out after {invocation.timeout}s.") from None
    except OSError as error:
        raise AgyWriterError(f"Could not run agy: {error}") from error
    return _response(completed)


def write(prompt: str, model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT_SECONDS) -> WrittenPart:
    ready = availability()
    if ready.binary is None:
        raise AgyWriterError(ready.error)
    started = monotonic()
    text = _markdown_response(_invoke(prompt, RESPONSE_SCHEMA, Invocation(ready.binary, model, timeout)))
    return WrittenPart(text, round(monotonic() - started, 2))


def request_json(prompt: str, schema: dict[str, Any], timeout: int = 90, model: str = DEFAULT_MODEL) -> dict[str, Any]:
    ready = availability()
    if ready.binary is None:
        raise AgyWriterError(ready.error)
    text = _invoke(prompt, json.dumps(schema), Invocation(ready.binary, model, timeout))
    return _proposal_json(text, schema.get("required", []))


def _top_level_json_values(text: str) -> list[Any]:
    text = re.sub(r"(?m)^[ \t]*```(?:json)?[ \t]*\r?$", "", text, flags=re.IGNORECASE)
    decoder = json.JSONDecoder()
    payloads: list[Any] = []
    parsed_through = 0
    for match in re.finditer(r"(?m)^[ \t]*[\[{]", text):
        if match.start() < parsed_through:
            continue
        position = match.start() + len(match.group()) - 1
        try:
            payload, end = decoder.raw_decode(text, position)
        except json.JSONDecodeError as error:
            if not payloads:
                raise AgyProposalError(f"agy returned invalid proposal JSON: {error}", text) from error
            break
        parsed_through = end
        payloads.append(payload)
    return payloads


def _proposal_json(text: str, required: list[str]) -> dict[str, Any]:
    proposal = None
    for payload in _top_level_json_values(_strip_json_fence(text)):
        if isinstance(payload, dict) and all(key in payload for key in required):
            # agy can append a more authoritative structured tool result.
            proposal = payload
    if proposal is None:
        raise AgyProposalError("agy returned no proposal object with the schema's required keys", text)
    return proposal


def _probe_failure_status(message: str) -> str:
    if re.search(r"not signed|sign.?in|log.?in|auth|credential|session.*expir", message, re.I):
        return "not-signed-in"
    if re.search(r"model.*(?:unavailable|not (?:found|available|supported)|unknown|unsupported|does not exist)|(?:unknown|invalid|unsupported|unavailable|missing|no such) model", message, re.I):
        return "model-unavailable"
    return "failed"


def doctor_entry(live: bool = False) -> dict[str, Any]:
    binary = binary_path()
    entry: dict[str, Any] = {
        "name": "agy", "purpose": "Recommended for Google provider writing and module organization",
        "required": False, "resolved": binary is not None, "installed": binary is not None, "path": binary,
        "version": None, "disabled": disabled(), "model": DEFAULT_MODEL, "probe": None,
        "install_command": ('powershell.exe -NoProfile -Command "Invoke-RestMethod https://antigravity.google/cli/install.ps1 | Invoke-Expression"' if sys.platform == "win32" else None),
        "install_hint": "install the Antigravity CLI (agy) and sign in with your Google account",
        "failure_hint": "Sign in with your Google account; agy is required only for the Google model provider.",
    }
    if entry["disabled"]:
        entry["status"] = "disabled"
        return entry
    if binary is None:
        entry["status"] = "missing"
        return entry
    try:
        checked = subprocess.run([binary, "--version"], capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=5)
        if checked.returncode == 0:
            entry["version"] = checked.stdout.strip() or checked.stderr.strip() or None
    except (OSError, subprocess.TimeoutExpired) as error:
        entry["version_error"] = str(error)
    entry["status"] = "installed"
    if live:
        try:
            _invoke("Do not use tools, files or commands. Reply only with {\"ok\":true}.",
                    json.dumps({"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}),
                    Invocation(binary, timeout=20))
            entry.update(status="working", probe={"ran": True, "passed": True, "failure": None})
        except AgyWriterError as error:
            entry.update(status=_probe_failure_status(str(error)),
                         probe={"ran": True, "passed": False, "failure": str(error)})
    return entry


def _contract(context: DraftingHandoffContext, module_title: str) -> str:
    return "\n\n".join((
        NO_TOOLS, f"Module: {module_title}\nLecture: {context.lecture_title}",
        build_drafting_contract(context), drafting_reference(),
        "The contract's MCP instructions are for the orchestrator. You only return markdown; obey the tool restrictions above.",
    ))


def guide_prompt(context: DraftingHandoffContext, module_title: str, segment: str, part_context: dict[str, Any]) -> str:
    part, total = part_context["part"], part_context["total"]
    previous = part_context.get("previous", "")
    tail = re.split(r"(?<=[.!?؟])\s+|\n\s*\n", previous.strip())[-2:]
    opening = (
        "Include the provenance header and exactly one '## 📖 Chronological Guide' heading."
        if part == 1 else "Continue Section 1; omit '## 📖 Chronological Guide' entirely. "
        "Only guide part 1 carries that heading. Do not repeat the provenance header."
    )
    outline = part_context.get("slide_outline", "")
    merge_mode = part_context.get("merge_mode")
    merge_rules = []
    if merge_mode:
        merge_rules.append("MERGED GUIDE: all labelled recordings are spoken evidence. Merge every unique point, example, "
                           "story, repetition, question and exam tip from either cohort for this part's scope. "
                           "Attribute with (شرح البنين) / (شرح البنات) ONLY where cohorts differ; shared points are written once. For unknown cohorts use the recording name. "
                           "Do not summarize either cohort or repeat explanations assigned to earlier parts.")
        if merge_mode == "topics":
            first, last = part_context["topic_range"]
            merge_rules.append(f"TOPIC RANGE FOR THIS PART: {first}–{last} inclusive. Write exactly these topics, one ### per topic. "
                               "All cohorts' assigned verbatim slices are supplied; neighbour context is continuity only, never extra narration.")
            merge_rules.append("FULL TOPIC LIST (your range marked):\n" + json.dumps([
                {**topic, "assigned_to_this_part": first <= index <= last}
                for index, topic in enumerate(part_context["topics"], 1)
            ], ensure_ascii=False))
        elif merge_mode == "timeline":
            merge_rules.append("Write ONLY the primary recording segment's topics. Use the other complete recordings "
                               "to add each cohort's unique spoken details on those same topics; never narrate their unrelated topics.")
    slide_reference = []
    if outline:
        limit = len(outline) if part == total else SLIDE_OUTLINE_LIMIT
        truncated = "\n[SLIDE OUTLINE TRUNCATED]" if len(outline) > limit else ""
        slide_reference.append("SLIDE OUTLINE REFERENCE (map only, not narration):\n"
                               + outline[:limit] + truncated + "\nEND SLIDE OUTLINE REFERENCE")
    return "\n\n".join((
        _contract(context, module_title), opening, EGYPTIAN_REGISTER, DOCTOR_FIRST,
        "Heading style for EVERY guide part: one ### per doctor topic, 'English title — Egyptian Arabic gloss'. "
        "Use a short English topic title; a matched slide title may name that spoken topic. Slides NEVER create "
        "headings or dictate order. No Learning objectives or divider headings. Merge all returns to a topic into its one heading.",
        ("Only at the END of this final Chronological Guide part, optionally add ONE folded Obsidian callout "
         "with this exact opening: > [!summary]- في السلايدات ومتشرحش\n"
         "> - Important unspoken item.\n"
         "Include only slide/book items supported by ranked past-exam evidence or key numbers, classifications and definitions. "
         "Do not repeat items already covered in narration or a topic callout; omit the callout if nothing important remains. "
         "All its content lines start with >; no ### headings inside it. Never dump all slides.\n"
         "RANKED EXAM EVIDENCE:\n" + json.dumps(part_context.get("ranked_questions", {}), ensure_ascii=False)
         + "\nEARLIER GUIDE (exclusion reference only, do not repeat):\n" + part_context.get("earlier_guide", "")
         if part == total else "Do not add the folded unspoken-slide section in this part; it belongs only at the end of the whole guide."),
        *merge_rules,
        *slide_reference,
        "Continuity only (do not repeat):\n" + " ".join(tail)[-2000:],
        "Output only this part's markdown, without completion messages or toolAction/toolSummary objects. "
        "Preserve every spoken point in this part's assigned scope. No sections 2–5.",
        "Reported figures (link only where this segment discusses them):\n" + json.dumps(part_context.get("figures", []), ensure_ascii=False),
        "Figure placement: each figure includes its slide_text. Link it only immediately after the "
        "paragraph where the doctor discusses that slide's content in THIS segment, at most once "
        "in the whole guide. Earlier linked figures have been excluded. Never link title, divider "
        "or closing slides. OCR and vision descriptions marked Machine-read are matching hints, "
        "never the doctor's words or evidence for new narration. Match their labels and visible "
        "content to this segment's spoken topic, including scanned picture-only slides. "
        "Skip a figure only when its described content has no matching spoken explanation in this part.",
        "All extracted slide figures (also check already-used images before requesting an external illustration):\n"
        + json.dumps(part_context.get("all_slide_figures", part_context.get("figures", [])), ensure_ascii=False),
        f"VERBATIM SEGMENT (part {part} of {total}):\n{segment}",
    ))


def _imp_mcq_style(guide_context: dict[str, Any]) -> str:
    profile = guide_context["exam_style_profile"].get("mcq", {})
    observed = guide_context.get("observed_exam_style", {})
    rules = ["Section 3 generated **[IMP]** MCQs must have exactly four options labelled a, b, c, d. Stems must follow these validation constraints:"]
    if not observed.get("mcq"):
        rules.append("No MCQ exam style is observed in this module's exam index. Use short direct factual recall stems, "
                     "at most 20 English alphanumeric words; no patient vignettes. Example: 'Uncertainty in clinical decision making means:-'.")
    else:
        rules.append("Imitate the observed indexed MCQ stems and option shapes below, within the manifest profile's constraints.")
    if not observed.get("mcq") or "short direct" in str(profile.get("register", "")).casefold():
        rules.append("Use at most 20 English alphanumeric words. Do not include any of these case-insensitive substrings "
                     "in an IMP stem: 'patient', 'brought to', 'emergency department', 'on examination', 'scenario'. "
                     "Even a direct question containing 'patient' fails this rule. Keep clinical vignettes in Section 5.")
    if isinstance(profile.get("max_stem_words"), int):
        rules.append(f"Also respect max_stem_words={profile['max_stem_words']}; use the smaller applicable word limit.")
    return "\n".join(rules)


def questions_prompt(context: DraftingHandoffContext, module_title: str, questions: dict[str, Any], guide_context: dict[str, Any]) -> str:
    return "\n\n".join((
        _contract(context, module_title), EGYPTIAN_REGISTER,
        "Output only sections 2–5, using the exact headings and question formats in the contract. "
        "Keep the examiner's stem/option wording and the supplied answers' meaning while repairing OCR: joined words, misspellings, "
        "stray symbols, handwriting noise and mark allocations such as '(0.5 degree for each)'. "
        "Remove noise, never paraphrase or change meaning, negation, medical facts or doses. "
        "A stem carrying inline MCQ options, such as 'Local sign are in viperidae (a) Mos marked. b. less marked. "
        "C. both. d. none', belongs in Section 3 with the options split into their own labelled list. "
        "Retain each sourced MCQ's original count of two to six options, labelled in order; never add an option to fit the generated format. "
        "Keep every badge and Source line unchanged. "
        "Use source_papers paths as **Source:** lines for sourced questions. "
        "A sourced question that starts with a patient scenario belongs in Section 5 Clinical Cases, "
        "never Section 4 Written Questions, even when the index calls it written. "
        "Keep a sourced case when ANY sub-question is within the taught lecture scope. "
        "Prune only its out-of-scope sub-questions and renumber the retained sub-questions and answers. "
        "Prune the whole question only when nothing in it was taught. "
        "Place every relevant sourced clinical case before IMP cases. IMP cases only fill the section up; "
        "they never replace or displace sourced cases. For an empty or thin bank, supplement "
        "from taught topics with **[IMP]**, never a fabricated year; IMP blocks have no Source line.",
        _imp_mcq_style(guide_context),
        "Written-question and clinical-case **Model Answer:** fields must be ultra-concise English keywords: "
        "1–5 words per bullet or point, never prose paragraphs. A line longer than 10 words fails validation. "
        "Put all clinical reasoning and detailed explanations exclusively in **Clinical Explanation:** in Egyptian Arabic.",
        "Return markdown only, without completion messages or toolAction/toolSummary objects.",
        "FIND_QUESTIONS ENTRIES:\n" + json.dumps(questions, ensure_ascii=False),
        "GUIDE HEADINGS:\n" + guide_context["headings"],
        "EXAM STYLE PROFILE:\n" + json.dumps(guide_context["exam_style_profile"], ensure_ascii=False),
        "OBSERVED INDEXED EXAM STYLE:\n" + json.dumps(guide_context.get("observed_exam_style", {}), ensure_ascii=False),
    ))
