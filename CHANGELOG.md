# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0-beta.3] - 2026-07-23

This release adds profile import/export and JSONC editing to the Oh My OpenAgent VS Code extension. You can now move individual profiles or your entire sidecar in and out as JSON/JSONC, edit saved profiles or the active config's agents/categories directly as JSON, and import full sidecars with extend-or-replace semantics. The model editor also got a routing overhaul: position 1 is always Main, later cards are fallbacks, and Main-specific advanced settings are preserved independently through `main_overrides`.

### Features

- Add profile import and export for single `{ agents, categories }` fragments and full `{ version: 1, profiles: [...] }` sidecars.
- Add five new commands: `Import Profiles`, `Export Profile`, `Export All Profiles`, `Edit Profile JSON`, and `Edit Active Profile JSON`.
- Register the new transfer commands in the extension manifest and command aggregator.
- Add a JSONC profile editor webview and host protocol for editing active and saved profiles as JSON.
- Add strict JSONC parsing for transfer inputs with byte-size limits, UTF-8/BOM handling, duplicate-key detection, and CR line-ending support.
- Add atomic URI-based transfer I/O using VS Code `workspace.fs` for local and non-file targets.
- Add transactional profile imports that perform a single sidecar write and emit one change event.
- Add `ImportProfilesResult` schema type and expose transfer snapshots and replacement helpers in `ProfileStore`.
- Normalize exported sidecars and resolve profile-name collisions when importing.
- Validate pinned profile contracts and align transfer validation rules with the structured editor.
- Redesign inherited model routing so Main and fallback cards share defaults cleanly.
- Add `main_overrides` for durable Main-specific advanced settings.
- Simplify model ordering and related commands.
- Enhance model-card position labels for Main and fallback states.
- Add target-aware messaging and a dirty-state lifecycle for profile-scoped JSON edits.

### Fixes

- Canonicalize export serialization to sorted, two-space JSON with only safe data values.
- Preserve unknown rejection causes during atomic transfer I/O instead of dropping them.
- Sync the active profile after saving an edited profile JSON document.
- Align pinned validation rules with transfer and editor contracts.

### Tests

- Cover profile import/export end-to-end round trips.
- Add direct command-handler tests with mocked VS Code context.
- Strengthen profile schema contract proofs.

### Documentation

- Document import/export and JSON editing in README.
- Record smoke-test coverage and import learnings in the plan notepad.

### Chores/Refactors

- Pin the profile-facing upstream contract in the schema module.
- Bump version to `0.5.0-beta.3`.

[0.5.0-beta.3]: https://github.com/andersou/oh-my-openagent-vscode-extension/compare/v0.4.0...v0.5.0-beta.3
