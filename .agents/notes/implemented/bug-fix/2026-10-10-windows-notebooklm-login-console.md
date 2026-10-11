# Agent Note: Windows NotebookLM login console recovery

Status: implemented

English | [中文](2026-10-10-windows-notebooklm-login-console.zh.md)

## Problem

A student's installed Windows app shows `nlm.exe` application error `0xC0000142` when reconnecting NotebookLM. The UV tool trampoline starts UV-managed Python, but the failing component and DLL initialization cause are unproven. The login owner discarded the exit status, rebuilt PATH without explicitly adding Windows system directories, and released the ConPTY master immediately after spawning.

## Decision

The shared local-agent environment preserves inherited Windows OS variables, supplies missing OS defaults, and adds System32 and Wbem to PATH while excluding credentials and loader injection variables. On Windows, NotebookLM retains the PTY master through child exit and drains output while closing it. portable-pty opens ConPTY with `PSEUDOCONSOLE_INHERIT_CURSOR`, so conhost holds the child until the host answers its cursor-position request; the output reader answers each `ESC[6n` it reads with a cursor report (`ESC[1;1R`) on PTY input. A report written before conhost asks is read as keyboard input (it is the F3 key sequence). Abnormal exits disclose hexadecimal status and an environment summary containing names only and System32 presence.

Windows PTY spawn failures, `0xC0000142`, and exits within five seconds without output open a normal visible console with the same scrubbed environment. The console reuses the native suspended-start Job owner with CREATE_NEW_CONSOLE, so UV and Python enter the owned process tree before execution. Cancellation and successful status verification terminate and await that tree. The auth stream announces the console, continues the existing login status check until connected or cancelled, and carries diagnostics to a closed UI disclosure. UI copy is Arabic and English only.

## Alternatives considered

**Environment hardening alone.** Existing scrubbing already preserves OS variable names when present. PATH hardening addresses a concrete omission but cannot prove or resolve every ConPTY or GUI startup failure.

**Always use an external console.** The embedded conversation remains useful on healthy installations and other operating systems. Recovery opens a console only for the specified Windows failures.

**Treat login exit as connected.** CLI termination does not establish a valid session. The existing `nlm login --check` remains the authorization authority, even after the external console exits.

## Consequences

Diagnostics reveal no environment values. An external-console attempt remains pending until a status check connects or the student cancels; there is no arbitrary authentication timeout. The five-second silent-exit rule can also open a console after a fast successful exit, so the status check remains authoritative.

Unit tests cover environment scrubbing, OS variables on Windows, signed and unsigned DLL status classification, disclosure and localized console states. Owner-local UI snapshots cover Arabic and English. Windows CI explicitly runs cmd and installed Python through the production PTY helper. It does not install notebooklm-mcp-cli, because the job has no UV tool installation requirement. A real installed Windows app is still required to verify UV-managed Python, Google sign-in, console visibility, cancellation and the reported student's failure.
