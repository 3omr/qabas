# Agent Note: Windows transcriber tool installation

Status: implemented

English | [中文](2026-10-06-windows-transcriber-installation.zh.md)

## Problem

Windows package-manager commands entered a Linux privilege route. Missing OCRmyPDF displayed a bundled-tool claim instead of an executable installer command. A running desktop retained the PATH from before installation.

## Decision

Windows package managers run directly and own their permission prompts. NotebookLM and OCRmyPDF install with uv in isolated tool environments; WinGet or Scoop supplies missing uv. Document and media tools use user-scope Scoop packages, bootstrapped from its exact official installer with a process-local execution policy. LibreOffice preparation includes Git and the extras bucket. Engine children refresh registered PATH and user tool links before tool discovery. The preparation queue attempts every missing application tool, skips shared packages discovered by fresh reports, and continues after individual failures. The frozen engine includes pinned, checksum-verified Arabic, English and orientation OCR models. Antigravity uses only the exact official Google PowerShell installer command on Windows; other PowerShell commands remain manual. OCR produces PDF without optional optimization, and recognizes the Windows OCRmyPDF executable name.

## Alternatives considered

**Use Linux elevation helpers on every platform.** Rejected because Windows does not supply those helpers.

**Install Python packages into the frozen engine.** Rejected because frozen application files are not a mutable Python environment.

**Assume install exit status establishes readiness.** Rejected because the selected executable must also be discovered by a fresh doctor report.

## Consequences

Installation output remains visible, failures stop the selected installation, and cancellation uses the existing subprocess lifecycle. Scoop prerequisites and converters install from the application. Account sign-in remains interactive. Source runs can prepare the same OCR models with the build-cache helper. Engine CI installs Poppler for tests that intentionally exercise real PDF reading and rendering. Host process tests cover direct Windows installation and uv bootstrap success and failure; Python tests cover fresh PATH discovery and Windows OCR command selection.
