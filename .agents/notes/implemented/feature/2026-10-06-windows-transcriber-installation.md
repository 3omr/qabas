# Agent Note: Windows transcriber tool installation

Status: implemented

English | [中文](2026-10-06-windows-transcriber-installation.zh.md)

## Problem

Windows package-manager commands entered a Linux privilege route. Missing OCRmyPDF displayed a bundled-tool claim instead of an executable installer command. A running desktop retained the PATH from before installation.

## Decision

Windows package managers run directly and own their permission prompts. NotebookLM and OCRmyPDF install with uv in isolated tool environments; WinGet supplies missing uv. Engine children refresh registered PATH and user tool links before tool discovery. Tesseract has its own installation action. Antigravity uses only the exact official Google PowerShell installer command on Windows; other PowerShell commands remain manual. OCR produces PDF without optional optimization, and recognizes the Windows OCRmyPDF executable name.

## Alternatives considered

**Use Linux elevation helpers on every platform.** Rejected because Windows does not supply those helpers.

**Install Python packages into the frozen engine.** Rejected because frozen application files are not a mutable Python environment.

**Assume install exit status establishes readiness.** Rejected because the selected executable must also be discovered by a fresh doctor report.

## Consequences

Installation output remains visible, failures stop the selected installation, and cancellation uses the existing subprocess lifecycle. WinGet must be present for its packages and uv bootstrap. Tesseract language data and optional compression tools remain external prerequisites. Engine CI installs Poppler for tests that intentionally exercise real PDF reading and rendering. Host process tests cover direct Windows installation and uv bootstrap success and failure; Python tests cover fresh PATH discovery and Windows OCR command selection.
