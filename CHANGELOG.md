# Changelog

## 0.2.6 — 2026-11-17

### Features

- Show platform credit rates in the default-model dropdown, selected-model card, and conversation model picker. The model badge includes the current discount when its declared schedule is active, with daily windows, time zones, priorities, and discount factors handled by the shared formatter.
- Offer reasoning levels declared by the gateway catalog. TRAE's `light` and `extra_high` map to the host's low and xhigh levels, and the selected effort reaches the gateway using the platform's original spelling.
- Extend catalog parsing and configuration serialization with `credit_rate`, `supports_reasoning`, and `reasoning_effort_options`. Unknown rates display as “倍率未知”, and models with switch-only or unrecognized reasoning options have no level selector.

### Fixes and Improvements

- Use `context_window` and `max_output_tokens` from the catalog for Harness and SDK token budgets. A MiniMax model advertising a 1M context gets that capacity, resolving the small-context fallback that could reduce long-conversation output to one token. Explicit per-model budgets remain authoritative, with separate defaults for missing context and output limits.
- Read AI-Toolkit's private gateway key file at `~/.ai-toolkit/gateway-key` before the system credential store. A valid private file avoids repeated Keychain authorization after an AI-Toolkit rebuild. Discovery checks file type, ownership, and permissions, reports unsafe files, and uses the credential store when the file is absent.
- Keep file-based discovery inside the shared credential lease. Source-key recovery after HTTP 401 remains limited to an authenticated generation, and denied access pauses until an explicit dropdown retry.
- Supply the current PiAi adapter profile's image count and offload defaults, `maxRequestImages=50` and `imageOffloadCountQuantum=10`.
- Update the macOS CI runner to macOS 15 for the current build checks.

### Compatibility

- Support DSH `0.2.1-rc.3`, `0.2.1-rc.5`, `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3`, with the development SDK pinned to `0.2.2-rc.3`, Cordis 4.1.0, Schemastery 3.19.0, and pi-ai 1.3.0.
- Pair with AI-Toolkit 2.2.6 for catalog credit rates, reasoning declarations, TRAE effort forwarding, and the private key file. Node.js `>=24.9.0 <25` is required.

### Validation

- Type checking, 125 automated tests, and host/browser builds passed on nvmd Node.js 24.21.0. Coverage includes rates, promotion windows, reasoning mappings and request bodies, catalog limits, private key discovery, and the compatibility gate.
- The v0.2.6 tarball passed independent installation, host entry import, browser module wrapper, icon and compatibility checks across all five supported DSH versions. The package validation record is in `docs/VALIDATION.md`.
- The recorded MiniMax long-conversation check completed with 28,838 input tokens and 1,270 output tokens. The recorded TRAE probe accepted all tested effort values, including an invalid value, with comparable thinking lengths. Level availability follows the platform catalog.

### Known Limitations

- Runtime catalog persistence requires wiring configuration serialization into refresh saves and startup restoration. Offline restarts currently begin with an empty model list.
- Legacy WorkBuddy rate text such as `x0.18 credits` still displays as unknown when its numeric multiplier is absent. A catalog containing the normalized numeric multiplier displays the rate.
- AI-Toolkit's multi-account metadata aggregation can depend on account order when one account lacks a declaration, affecting the route's advertised rates and reasoning fields.

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
