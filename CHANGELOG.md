# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.1] - 2026-07-31

This release migrates the extension to the omo.dev unified config spec: the active config is now `~/.omo/omo.jsonc` (user layer) with optional per-project `.omo/omo.jsonc` layers, and the extension edits the `[opencode]` harness block. It also adds the new `reasoning` field to the agent/category form editor.

### BREAKING CHANGES

- **Config file location** — the extension now reads and writes `~/.omo/omo.jsonc` (fallback `omo.json`) on every platform instead of `~/.config/opencode/oh-my-openagent.json[c]` / `%APPDATA%\opencode\oh-my-openagent.json[c]`. Legacy `oh-my-openagent.json[c]` and `oh-my-opencode.json[c]` files are no longer discovered. Run `bunx oh-my-openagent config migrate` once to import them into the unified file.
- **Writes target the `[opencode]` block** — all mutations go into the `[opencode]` harness block of the user file. Shared-base keys and sibling harness blocks (`[senpi]`, `[codex]`) are preserved untouched, and JSONC comments/formatting survive every edit as before.
- **Sidecar rename** — profiles moved from `oh-my-openagent.profiles.json` to `~/.omo/omo.profiles.json`. A legacy sidecar (next to the config, or in `~/.config/opencode`) is renamed automatically on first access.

### Features

- **Project layers (read-only)** — `.omo/omo.jsonc` / `.omo/omo.json` files are discovered walking from the workspace directory up to the home directory and merged into the effective view (nearest layer wins, beating the user layer). The fold follows the upstream resolution order: shared base first, then the `[opencode]` harness block, so a project's shared-base value cannot clobber a user-layer harness value for the same agent. Writes always go to the user layer; project-inherited values are never flattened into the user file unless actually changed.
- **`reasoning` field** — agents, categories, fallback-model entries, and `ultrawork`/`compaction` variants now support the new `reasoning` key (`off | minimal | low | medium | high | xhigh | max | auto`), editable in the form editor alongside the existing `reasoningEffort` (relabeled `Reasoning effort (legacy)`). Profile import/export round-trips the field.
- **New-shape profile import** — `Create Profile from Config File…` now accepts a unified `omo.jsonc`: it merges shared-base `agents`/`categories` with the `[opencode]` block (harness wins) instead of only reading flat root-level keys.

### Migration

1. Run `bunx oh-my-openagent config migrate` to import legacy `oh-my-openagent.json[c]` files into `~/.omo/omo.jsonc` (upstream moves the legacy files to a backup directory).
2. Open the extension — profiles migrate automatically on first access.

### Tests

- 527 tests pass, including new coverage for `[opencode]` block creation, sibling-key preservation, base-vs-harness merge precedence, project-layer reads with user-only writes, nearest-layer precedence, symlinked `.omo` skipping, legacy-file rejection, legacy sidecar migration, new-shape fragment import, and `reasoning` validation/round-trip.

## [0.6.0-beta.1] - 2026-07-23

This pre-release adds descriptive hover tooltips to the sidebar: agents and categories now explain what they are for, on top of the configuration details the tooltip already showed.

### Features

- Add description tooltips for the 11 built-in agents and 8 built-in categories. Hovering a sidebar leaf now shows the item name, a short description of its role (e.g. `sisyphus — Main orchestrator. Plans, delegates, drives to completion.`), then the existing model/params/fallback configuration details unchanged. Descriptions live in `schema.ts` as typed `BUILTIN_AGENT_DESCRIPTIONS` / `BUILTIN_CATEGORY_DESCRIPTIONS` records.

### Tests

- Add 3 tooltip tests covering a built-in agent, an agent override, and a category override.

### Chores/Refactors

- Bump version to `0.6.0-beta.1`.

## [0.5.0-beta.4] - 2026-07-23

This release makes profiles easier to create and manage: a new command builds a profile from any Oh My OpenAgent config file (a full `oh-my-openagent.jsonc` works out of the box), the Profiles group header gained a right-click menu with the profile management commands, the sidebar tree was re-nested for a clearer hierarchy, and the profile JSON editor textarea is much taller. The rarely used and accident-prone `Remove Override` context action was removed.

### Features

- Add `Create Profile from Config File…` command: pick any Oh My OpenAgent `.json`/`.jsonc` config and create a profile from its `agents`/`categories` sections. Other top-level keys (e.g. `$schema`) are ignored, so a full `oh-my-openagent.jsonc` can be imported directly. The profile name is pre-filled from the filename with inline duplicate validation. The active config is never modified.
- Add right-click context menu on the Profiles group header with `Create Profile from Config File…`, `Import Profiles`, and `Export All Profiles`.
- Restructure the sidebar tree: the active config file expands to the active profile, with Agents and Categories nested beneath it; Profiles remains a root-level group. Parent nodes default to expanded.
- Increase the profile JSON editor textarea initial height to 14 rows, with vertical resize enabled and monospace styling.

### Removals

- Remove the `Remove Override` right-click action on agent and category sidebar items, along with its command handler and menu wiring.

### Tests

- Add 12 tests for the config-file fragment parser (full-config extraction, JSONC tolerance, duplicate keys, size/BOM limits).
- Add 6 tests for `ProfileStore.createProfileFromFragment`, including duplicate-name rejection verified by temporary revert.
- Add 7 command-handler tests for create-from-config with a mocked VS Code context, plus menu-wiring assertions for the Profiles group header.
- Update the tree provider tests for the new nested sidebar structure.

### Documentation

- Document the new command, the Profiles group context menu, and the restructured sidebar in README.

### Chores/Refactors

- Bump version to `0.5.0-beta.4`.

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

[0.6.0-beta.1]: https://github.com/andersou/oh-my-openagent-vscode-extension/compare/v0.5.0...v0.6.0-beta.1
[0.5.0-beta.4]: https://github.com/andersou/oh-my-openagent-vscode-extension/compare/v0.5.0-beta.3...v0.5.0-beta.4
[0.5.0-beta.3]: https://github.com/andersou/oh-my-openagent-vscode-extension/compare/v0.4.0...v0.5.0-beta.3
