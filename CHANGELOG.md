# Changelog

## 0.2.6 — 2026-11-06

### Fixes

- Support DSH 0.2.2-rc.1, Cordis 4.1 and Schemastery 3.19 while retaining the declared DSH 0.2.1-rc.3 / rc.5 compatibility.
- Supply the image count and offload defaults required by the new PiAi adapter profile.
- Pin the development SDK to the current desktop runtime and check distributables against each supported DSH version without compatibility exemptions.

### Validation

- Pass types, 111 automated tests and host/client builds against DSH 0.2.2-rc.1 and pi-ai 1.3.0.
- Independently install and import the tarball with DSH 0.2.1-rc.3, 0.2.1-rc.5 and 0.2.2-rc.1; verify the real Harness compatibility gate accepts each version.

## 0.2.5 — 2026-11-05

### Fixes

- Read `context_window` and `max_output_tokens` from AI-Toolkit's model catalog and use them for Harness and SDK token budgeting. A declared 1M MiniMax context no longer uses the 32K fallback that could reduce long-conversation output to one token.
- Keep context and output capacities separate, preserve explicit per-model overrides, and retain the existing defaults when the proxy omits a field.
- Preserve capacity metadata in the legacy model cache and ignore invalid capacity values.

### Validation

- Pass types, 105 automated tests, host/client builds, and package installation checks.
- Reproduce one-token truncation with a long input, verify recovery with a declared 1M context, and preserve genuine truncation when callers explicitly request one output token.
- Validate the local MiniMax workaround in an existing macOS Harness conversation: 1,270 output tokens and normal completion. Automatic capacity discovery requires an AI-Toolkit build exposing the new catalog fields.

## 0.2.4 — 2026-11-03

### Fixes

- Coalesce source credential reads across plugin installation, activation, and module hot reload in the same host process.
- Preserve cancelled/denied authorization across replaced runtimes and retry only after an explicit user action.
- Require successful catalog authentication before automatic source-key recovery, including staggered plugin instances; coalesce key-rotation recovery by credential generation.
- Keep a pending macOS authorization attached to its native read instead of restarting it after a JavaScript timeout.
- Reuse the proxy key across port changes and validate it against the newly configured endpoint.

### Validation

- Pass types, 101 automated tests, host/client builds, and package installation checks.
- Keep credentials in host memory only; no credential persistence or AI-Toolkit changes are introduced.

## 0.2.3 — 2026-11-03

First public release.

- Connect the existing local AI-Toolkit proxy to DSH without modifying AI-Toolkit.
- Discover the proxy address and key on the host and synchronize available WorkBuddy, TRAE, and Qoder models.
- Save DSH's new-session default through one model dropdown.
- Show AI-Toolkit and platform logos with light and dark theme support.
- Support DSH 0.2.1-rc.3 and 0.2.1-rc.5, with a separate provider ID for coexistence with manual profiles.
- Provide one-command installation from GitHub Releases and privacy-redacted screenshots.
- Verify types, 80 automated tests, builds, and package installation.
