# Oh My OpenAgent Webview Design System

## 1. Atmosphere & Identity

This is a compact VS Code-native configuration surface: quiet, dense, and predictable rather than branded. Its signature is a clearly ordered, borders-only stack of model cards, where the `MAIN` marker makes runtime priority visible without competing with the editor chrome.

## 2. Color

All palette decisions defer to the active VS Code theme. No raw colors, gradients, shadows, imagery, or decorative color treatments are permitted.

| Role | VS Code token | Usage |
| --- | --- | --- |
| Canvas | `--vscode-editor-background` | Webview background |
| Surface | `--vscode-sideBar-background`, `--vscode-input-background` | Sections and cards |
| Primary text | `--vscode-foreground` | Labels and headings |
| Secondary text | `--vscode-descriptionForeground` | Hints and summaries |
| Control text | `--vscode-input-foreground` | Inputs and selects |
| Border | `--vscode-widget-border`, `--vscode-input-border` | Cards, sections, controls |
| Focus | `--vscode-focusBorder` | Visible keyboard focus and reorder target |
| Primary action | `--vscode-button-*` | Save action |
| Secondary action | `--vscode-button-secondary*` | Secondary and icon actions |
| Error | `--vscode-errorForeground`, `--vscode-inputValidation-error*` | Invalid fields and save status |
| Warning | `--vscode-inputValidation-warningBorder` | Model discovery warning |

## 3. Typography

- Primary: `var(--vscode-font-family, system-ui, sans-serif)`.
- Mono: `var(--vscode-editor-font-family, ui-monospace, monospace)` for model identifiers.
- Base: `var(--vscode-font-size, 13px)` at 1.5 line height.
- Title: 20px, 600 weight; section/card labels: 11px, 600 weight, uppercase with 0.08em tracking; metadata and hints: 11-12px.

## 4. Spacing & Layout

All spacing uses the 4px base: 4, 8, 12, 16, 20, 24, 28, 32, 48, and 64px. The editor is one column, capped at 720px, with 32px desktop and 16px narrow-panel gutters. Card internals use grids only when they can collapse to one readable column at 520px and below. Long identifiers wrap and controls retain `min-width: 0` so 375px panels never horizontally overflow.

## 5. Components

### Ordered Model List
- **Structure**: semantic `<ol id="model-list">` containing `<li>` model cards, then shared defaults below the list.
- **States**: main, fallback, drag target, keyboard pickup, validation error, empty new fallback.
- **Spacing**: 8px card gaps; 12px card inset; 16px section inset.
- **Accessibility**: list semantics, textual `MAIN` / `FALLBACK N` labels, live status, native drag tooltip, described keyboard instructions, and stable-UID focus restoration.
- **Motion**: border/focus state only, 120ms maximum; disabled under reduced motion.

### ModelCard
- **Structure**: drag handle, textual position badge, model field, remove action only for fallbacks, and a compact native advanced disclosure for fallback override controls.
- **States**: main has a concise attached-choice note and never exposes inheritance selectors; fallbacks expose `Inherit default` / `Override` mode controls per field, with inherited values shown but not editable.
- **Accessibility**: every control has a visible label, unavailable capabilities disable explicit controls with an explanation, validation is inline, and the disclosure summary reports inheritance/override state.

### Default Generation Settings
- **Structure**: a section following the ordered list that edits active top-level defaults.
- **States**: default, capability unavailable, field error.
- **Accessibility**: copy explains that values apply to Main and are inherited by fallback fields in inherit mode.

## 6. Motion & Interaction

Controls use existing 120ms background, color, border, opacity, and transform feedback only. Reordering has no decorative animation; the semantic position and `aria-live` messages provide the feedback. `prefers-reduced-motion: reduce` neutralizes transitions and animations.

## 7. Depth & Surface

**Strategy: borders-only.** A one-pixel VS Code theme border and the existing 2-4px radii separate sections, cards, inputs, status banners, and focus states. No `box-shadow` is used.

## 8. Accessibility Constraints & Accepted Debt

- Target: WCAG 2.2 AA within VS Code theme guarantees.
- Full keyboard reachability includes Space/Enter pickup/drop, Arrow reorder, Escape cancel, focus restoration by stable card UID, and standard native disclosure/input behavior.
- The reorder tooltip and visible helper explain that first position promotes a fallback and that override/inherit choices travel with its model.
- Model metadata is evaluated per card. Unknown metadata permits configuration; known unsupported temperature or reasoning disables only the relevant explicit control.
- No accepted debt.
