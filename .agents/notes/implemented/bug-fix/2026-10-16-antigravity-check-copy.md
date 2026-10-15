# Agent Note: Antigravity check results stay in the app

Status: implemented

## Problem

Testing Antigravity in Settings → Accounts and tools could wait and then tell the student to open a terminal and run `agy` (#32). The copy did not say whether sign-in was the problem, what to do in the app, or whether Qabas could continue. The chat's Antigravity sign-in failure gave the same terminal instruction.

## Decision

A failed live test shows two visible lines: the cause (needs Google sign-in, cannot use its model, or did not answer in time) and that chat and transcripts can continue with a Gemini key while reading question papers needs Antigravity. The test button becomes Test again, and Use a Gemini key scrolls to the key card on the same page. The manual first-run sign-in steps and the probe's own failure text sit in a closed Technical details disclosure. The `hint.agy` row hint points to the Antigravity test. In chat, `omar-auth` and `omar-missing` failures offer Open Accounts and tools, which dispatches `dsh-desktop-open-settings` with section `transcriber-engine`.

## Alternatives considered

**Launch agy's interactive sign-in from the app.** agy has no sign-in subcommand: it signs in when run interactively, which needs a visible console on each platform and a Host Remote to launch it. That flow is deferred until it can be verified on Windows; this change keeps the terminal step out of the normal flow without claiming a one-click sign-in.

## Consequences

The student sees a plain status, a retry, and an available alternative. Signing in still requires running agy once outside Qabas, now behind Technical details. Component tests pin the visible lines, the disclosure contents, Test again and the key-card scroll; the chat test pins the settings section.
