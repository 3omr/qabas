# Agent Note: ACP capabilities wait for application startup

Status: implemented

English | [中文](2026-10-06-acp-startup-capabilities.zh.md)

## Problem

The ACP transport can receive initialization while provider registrations are still mounting. Capability discovery can then miss an adapter, and session creation immediately after initialization can fail for a valid configured provider.

## Decision

ACP initialization awaits the application Loader before inspecting the configured model's image capabilities. Direct bridge compositions without a Loader use their already mounted services. Model selection and the protocol response fields remain owned by the existing ACP configuration and session implementation.

## Alternatives considered

**Sleep before sending initialization.** Rejected because a fixed delay does not establish that provider registration completed on a contended host.

**Inspect capabilities on the first prompt.** Rejected because the initialization response tells clients which prompt content the server accepts.

## Consequences

Initialization can take as long as application startup. A controlled startup promise proves that model inspection waits; removing the wait makes the regression fail. Built-profile tests use an explicit mock provider/model pair, leaving saved-default model selection as a separate behavior.
