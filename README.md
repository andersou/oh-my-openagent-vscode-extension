# Oh My OpenAgent for VS Code

A VS Code companion extension for Oh My OpenAgent. It gives you a visual tree of agents, categories, and profiles, and a form-based editor for model overrides without hand-editing JSONC files.

## Features

- **Agent and category model overrides** — see every built-in agent and category, add empty override slots, and edit them in a webview form.
- **JSONC preservation** — all writes go through `jsonc-parser`, so comments, trailing commas, and formatting in your config file stay intact.
- **Profiles** — snapshot the current `agents` and `categories` sections, switch between them instantly, and keep an optional description for each.
- **Sidebar integration** — the `Oh My OpenAgent` activity bar view puts everything one click away.
- **Command palette support** — every action is also available from the Command Palette.

## Requirements

- VS Code 1.85 or newer
- An existing Oh My OpenAgent configuration, or a first-run scenario where the extension will create one for you

The extension discovers the active config in this order:

1. `~/.config/opencode/oh-my-openagent.json` (Unix) or `%APPDATA%\opencode\oh-my-openagent.json` (Windows)
2. `~/.config/opencode/oh-my-openagent.jsonc` (Unix) or `%APPDATA%\opencode\oh-my-openagent.jsonc` (Windows)
3. Legacy `oh-my-opencode.json` / `oh-my-opencode.jsonc` in the same directory

Profiles live next to the active config in `oh-my-openagent.profiles.json`.

## Installation

### From a .vsix file

1. Download `oh-my-openagent-vscode-X.Y.Z.vsix` from the release page.
2. Open VS Code and run `Extensions: Install from VSIX...` from the Command Palette.
3. Select the downloaded file.

### Development build

1. Clone the repository:

   ```bash
   git clone https://github.com/oh-my-openagent/oh-my-openagent-vscode.git
   cd oh-my-openagent-vscode
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Compile:

   ```bash
   npm run compile
   ```

4. Press `F5` to open the Extension Development Host with the extension loaded.

## Usage

### Opening the view

- Click the `Oh My OpenAgent` activity bar icon (robot symbol).
- Or run the command `Oh My OpenAgent: Open Agent Manager` from the Command Palette.

The sidebar shows three collapsible groups:

- **Agents** — built-in agents; overridden agents are shown as override items.
- **Categories** — built-in categories; overridden categories are shown as override items.
- **Profiles** — saved snapshots of your agents and categories.

### Editing an agent or category

1. Hover over the agent or category and click the pencil inline action, or right-click and choose `Edit Agent` / `Edit Category`.
2. The webview editor opens with sections for Model, Sampling, Thinking, and Fallback models.
3. Change values and click **Save**. The active config is updated with JSONC preservation.

### Context menu actions

Right-click items in the Models view for more options:

- On a built-in agent: `Add Agent Override` creates an empty override entry.
- On a built-in category: `Add Category Override` creates an empty override entry.
- On an override item: `Remove Override` deletes that override from the active config.
- On a profile: `Activate`, `Rename`, `Duplicate`, or `Delete`.

The view title also provides `Refresh` and `Create Profile` buttons.

## Commands

All 12 extension commands are prefixed with **Oh My OpenAgent** in the Command Palette:

| Command | What it does |
| --- | --- |
| `Open Agent Manager` | Focuses the `Oh My OpenAgent` sidebar view. |
| `Edit Agent` | Opens the editor for the selected agent. |
| `Edit Category` | Opens the editor for the selected category. |
| `Refresh` | Refreshes the Models tree from disk. |
| `Add Agent Override` | Adds an empty override for the selected agent. |
| `Add Category Override` | Adds an empty override for the selected category. |
| `Remove Override` | Removes the override for the selected agent or category. |
| `Create Profile` | Creates a new profile from the current config. |
| `Activate Profile` | Applies the selected profile to the active config. |
| `Rename Profile` | Renames the selected profile. |
| `Duplicate Profile` | Creates a copy of the selected profile. |
| `Delete Profile` | Deletes the selected profile after confirmation. |

## Profiles

Profiles are named snapshots of the `agents` and `categories` sections of your active config. They are stored in `oh-my-openagent.profiles.json`, next to your active config file.

### Create a profile

1. Click the `Create Profile` icon in the Models view title, or run `Oh My OpenAgent: Create Profile`.
2. Enter a unique profile name.
3. Optionally enter a description.

The new profile captures the current agents and categories exactly as they are on disk.

### Activate a profile

1. Right-click the profile in the sidebar and choose `Activate`.
2. The active config's `agents` and `categories` sections are replaced with the profile's values.

Activation preserves comments and trailing commas in the active config because it reuses the same JSONC-preserving write path as the editor.

### Rename, duplicate, or delete a profile

- **Rename** updates the profile name. If it was the active profile, `lastActiveProfile` is updated automatically.
- **Duplicate** creates a deep copy under a new name; the original is unchanged.
- **Delete** asks for confirmation and removes the profile. If it was the active profile, the active marker is cleared.

## Development

This extension is built with TypeScript and esbuild.

```bash
# Install dependencies
npm install

# One-shot compile
npm run compile

# Watch mode
npm run watch

# Run tests
npm test

# Package for release
vsce package
# or
npm run package
```

To run the extension locally, press `F5` in VS Code. This opens the Extension Development Host with the compiled extension loaded.

### Tests

Tests are written with Vitest and cover config parsing, JSONC-preserving updates, profile lifecycle, and tree-provider rendering.

```bash
npm test
```

## Release / packaging

1. Update the version in `package.json`.
2. Run the packaging command:

   ```bash
   vsce package
   ```

3. The resulting `.vsix` file can be uploaded to a release page or installed directly.

The packaging rules in `.vscodeignore` make sure `out/extension.js`, `out/webview.js`, `src/ui/webview/webview.html`, and `src/ui/webview/webview.css` are included, while source maps, tests, and `node_modules` are excluded.

## License

MIT License
