# Learnings — profile-import-export-json-editor

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

- Task 5: VS Code 1.85 `workspace.fs` is the URI-provider boundary for local and non-file resources. Atomic transfer saves can preserve the selected target URI while writing to `target.with({ path: target.path + randomSuffix, query: '', fragment: '' })`, then renaming with `{ overwrite: true }`.
- Task 5: Dialog cancellation is best represented as a discriminated result, while provider failures retain their original `Error` as the cause of a typed boundary error. `Promise.allSettled` provides best-effort temp cleanup without replacing the write/rename failure.
- Task 5 review correction: VS Code's `Thenable` signatures do not constrain rejection reasons to `Error`. Every caught `unknown` cause must be passed unchanged into `ProfileTransferFileError`; write and rename cleanup must run before returning regardless of cause type.
- Task 3: Runtime transfer validation is split into a public profile/sidecar boundary and an internal entry validator. Full config fragments deliberately project only `agents` and `categories`, while sidecars reject every root key outside `version`, `profiles`, and `lastActiveProfile`.
- Task 3: The structured editor now reaches the same model/fallback/main-override validation rules through a one-line compatibility export. Its established extension tolerance and exact error messages remain covered by the existing panel suite, while transfer inputs use strict nested-key and enum policies.
- Task 3: ISO timestamp validation must check calendar components in addition to `Date.parse`; JavaScript normalizes impossible dates such as February 31 instead of rejecting them.
- Task 3 review correction: Pinned transfer rules and legacy structured-editor rules intentionally diverge for model numbers and thinking budgets. Transfer accepts any finite `maxTokens`/`budgetTokens` number and optional budgets; editor compatibility retains positive integers and a required enabled-thinking budget.
- Task 3 review correction: Agent color is a transfer-only six-digit hex field. Permission extension keys accept direct `ask|allow|deny`, but object pattern maps are valid only for `bash`; rejecting the object at the tool key yields the stable exact path.
- Task 4: Keep the parser at its 246 pure-LOC ceiling by re-exporting transfer serialization helpers from a separate pure module. Export payloads use `structuredClone`; `providerOptions` sensitivity checks inspect only the owning agent key and provider-option key count, never option values.
- Task 4 repair: Canonical transfer JSON accepts only null, booleans, finite numbers, strings, dense arrays, and enumerable data-only plain objects; it sorts object keys by Unicode code unit and rejects unsupported, cyclic, accessor, symbol-keyed, or non-plain values with one typed error code. Source/export filenames use NFC; filesystem collision allocation additionally uses en-US lowercase keys, while stored-profile names remain exact case-sensitive.
- Task 6: `ProfileStore.importSingleProfile` and `importProfiles` can be implemented by reusing `deriveProfileNameFromSource`, `resolveProfileNameCollisions`, `cloneProfileFragment`, and `cloneProfilesFile` from `profileTransferSerialization.ts`. Both methods perform exactly one `writeProfilesFile` call and therefore emit one `change` event; the live OmO config is never touched.
- Task 6: TDD tests should assert exact case-sensitive collision behavior, since stored-profile collision resolution is exact case-sensitive regardless of filename normalization.
- Task 6: In `extend` mode, `updatedAt` should be bumped only when the resolved name differs from the imported name; `replace` preserves imported timestamps verbatim.
- Task 6: The local `lastActiveProfile` marker must be checked against the rebuilt profile list, because `replace` may remove the active profile entirely.

- Task 7: `exportProfileFragment` and `cloneProfilesFile` from `profileTransferSerialization.ts` fit the snapshot APIs exactly. `getProfileFragment` omits metadata by construction, while `getProfilesFileSnapshot` normalizes `version` to `1` and deep-clones the whole sidecar.
- Task 7: `replaceProfileFragment` reuses `cloneProfileFragment` and `writeProfilesFile` for one sidecar write and one `change` event. Missing fragment sections must explicitly `delete` the stored profile section.
- Task 7: `replaceActiveConfigFragment` routes through `ConfigStore.updateConfig`, which preserves comments and unrelated keys on untouched sections. When the first root key (`agents`) is removed, `jsonc-parser` also drops the top-level comment preceding it, so tests for comment preservation should target untouched keys rather than deleted sections.

- Task 8: Keep profile transfer commands in a focused module (`profileTransferCommands.ts`) with handlers in `profileTransferCommandHandlers.ts`; `commands.ts` only registers the resulting disposable. This keeps `commands.ts` as an aggregator and makes handlers testable with a small injected context.
- Task 8: `AgentEditorPanel.showProfileJson` is the minimal host-side contract for the two edit commands; opening an untitled JSON document satisfies the requirement without depending on the full profile-JSON webview host.
- Task 8: Cancellation at every dialog stage is a no-op; destructive replace requires a second modal confirmation. All user-facing messages are path-independent and never log the payload.
- Task 8: Tests should assert registration parity, fragment/sidecar import paths, provider-options warning branches, every cancellation point, parse/store/FS errors, no payload logging, and no direct tree refresh.
