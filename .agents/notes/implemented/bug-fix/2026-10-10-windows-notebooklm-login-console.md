# Agent Note: Windows NotebookLM login console recovery

Status: implemented

## Problem

A student's installed Windows app shows `nlm.exe` application error `0xC0000142` when reconnecting NotebookLM. The UV tool trampoline starts UV-managed Python, but the failing component and DLL initialization cause are unproven. The login owner discarded the exit status, rebuilt PATH without explicitly adding Windows system directories, and released the ConPTY master immediately after spawning.

## Decision

The shared local-agent environment preserves inherited Windows OS variables, supplies missing OS defaults, and adds System32 and Wbem to PATH while excluding credentials and loader injection variables. On Windows, NotebookLM retains the PTY master through child exit and drains output while closing it. portable-pty opens ConPTY with `PSEUDOCONSOLE_INHERIT_CURSOR`, so conhost holds the child until the host answers its cursor-position request; the output reader answers each `ESC[6n` it reads with a cursor report (`ESC[1;1R`) on PTY input. A report written before conhost asks is read as keyboard input (it is the F3 key sequence). Abnormal exits disclose hexadecimal status and an environment summary containing names only and System32 presence.

Windows PTY spawn failures, `0xC0000142`, and exits within five seconds without output open a normal visible console with the same scrubbed environment. The console reuses the native suspended-start Job owner with CREATE_NEW_CONSOLE, so UV and Python enter the owned process tree before execution. Cancellation and successful status verification terminate and await that tree. The auth stream announces the console, continues the existing login status check until connected or cancelled, and carries diagnostics to a closed UI disclosure. UI copy is Arabic and English only.

Both embedded login and console recovery pass `--storage protected` to select OS-keystore storage for new profiles without the CLI's 1/2 question. Existing profiles retain the CLI's existing storage behavior; no migration is forced. Google sign-in remains interactive. Windows replies end with carriage return, the ConPTY Enter key; Unix replies retain newline. Sending only newline on a real Windows PTY echoed the answer but left Python `input()` waiting; carriage return completed it.

The session check preserves an unspecified environment when resolving `nlm`, allowing the Windows subprocess provider to discover newly installed user-local tools even when the launcher's PATH predates installation. Explicit environment overrides retain their existing authority. The account card uses localized guidance and failure copy; original CLI output and failure messages are available only in closed optional technical details.

## Alternatives considered

**Environment hardening alone.** Existing scrubbing already preserves OS variable names when present. PATH hardening addresses a concrete omission but cannot prove or resolve every ConPTY or GUI startup failure.

**Always use an external console.** The embedded conversation remains useful on healthy installations and other operating systems. Recovery opens a console only for the specified Windows failures.

**Treat login exit as connected.** CLI termination does not establish a valid session. The existing `nlm login --check` remains the authorization authority, even after the external console exits.

**Automatically type the storage answer.** The CLI provides `--storage protected`; passing its supported option avoids parsing terminal text and timing a synthetic answer.

**Treat terminal output as student-facing instructions.** Raw paths, protocol names and English messages do not provide localized next steps. Keep them as optional evidence while localized guidance owns the normal flow.

## Consequences

A Windows regression test waits for a real cmd prompt and submits through the production manager, then verifies the child consumed the answer and exited. Its private child is terminated and joined before assertions, including timeout paths. The installed CLI's help confirms the protected-storage flag skips the new-profile question. Local native execution requires the Rust and Windows build toolchains; desktop Windows CI owns this test.

Diagnostics reveal no environment values. An external-console attempt remains pending until a status check connects or the student cancels; there is no arbitrary authentication timeout. The five-second silent-exit rule can also open a console after a fast successful exit, so the status check remains authoritative.

Unit tests cover environment scrubbing, OS variables on Windows, signed and unsigned DLL status classification, disclosure and localized console states. Owner-local UI snapshots cover Arabic and English. Windows CI explicitly runs cmd and installed Python through the production PTY helper. It does not install notebooklm-mcp-cli, because the job has no UV tool installation requirement. A real installed Windows app is still required to verify UV-managed Python, Google sign-in, console visibility, cancellation and the reported student's failure.
