# pi-customizations

A reusable pi customization package for extensions, commands, flags, themes, prompt templates, and other pi add-ons.

The repo is meant to be cloned, installed, and adapted by anyone who wants a starting point for pi customizations. It intentionally keeps runtime source in TypeScript so pi can load the package directly.

## What's included

| Customization | Type | Summary |
| --- | --- | --- |
| Codex Fast Mode | Extension command + CLI flag | Optionally adds `service_tier: "priority"` to OpenAI / OpenAI Codex provider payloads when enabled. |
| Inline Skill Slash Autocomplete | Extension autocomplete + editor + input transform | Lets `/skill:<name>` autocomplete work inside prose and expands known inline skill tokens before submit. |

More customizations can be added under `src/` and registered from `index.ts`.

## Install from a clone

```bash
git clone <this-repo-url> pi-customizations
cd pi-customizations
make install
```

`make install`:

1. installs dependencies with `pnpm install --frozen-lockfile`,
2. runs TypeScript + tests via `pnpm check`,
3. symlinks this repo into pi's auto-discovered extension folder:
   `~/.pi/agent/extensions/pi-customizations`.

Reload pi after installing:

```text
/reload
```

### Non-default pi settings folder

Pi's default settings folder is `~/.pi/agent`. Override it the same way pi does:

```bash
make install PI_CODING_AGENT_DIR=/path/to/pi-agent-settings
```

You can also change the installed extension folder name:

```bash
make install PI_CUSTOMIZATIONS_EXTENSION_NAME=pi-customizations-dev
```

Uninstall:

```bash
make uninstall
```

## Install as a pi git package

Use this repo's Git URL:

```bash
pi install git:github.com/<owner>/pi-customizations
```

For a project-local install:

```bash
pi install -l git:github.com/<owner>/pi-customizations
```

## Using inline `/skill:` autocomplete

The package installs an editor customization and autocomplete provider that make slash command tokens cursor-local instead of message-start-only for installed commands. This is most useful for skills:

```text
Please use /skill:dev-go to review this
```

Typing `/ski`, `/dev`, `/prp`, or `/skill:` after prose opens token-aware autocomplete. Selecting a skill replaces only the active slash token, preserving surrounding text.

On submit, known inline `/skill:<name>` tokens are expanded to the same `<skill ...>` block used by pi's normal start-of-message `/skill:<name>` command. Unknown skill tokens remain literal. Built-in control-plane slash commands still only execute at the start of a prompt.

## Using the included Codex Fast Mode extension

Inside pi:

```text
/codex-fast
/codex-fast on
/codex-fast off
/codex-fast status
```

From the CLI for one session:

```bash
pi --fast
```

The extension only patches provider payloads when fast mode is enabled, the active provider is `openai` or `openai-codex`, and the outgoing payload does not already include `service_tier`.

Persistent state is read from effective pi settings:

- global: `$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`
- project: `<cwd>/.pi/settings.json`

Preferred key:

```json
{
  "pi-customizations": {
    "codexFast": {
      "enabled": true
    }
  }
}
```

The upstream-compatible `pi-codex-fast.enabled` key is also read. Writes from `/codex-fast on|off` go to the preferred key.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm check
make smoke
```

This repo intentionally ships TypeScript source. Pi loads extension `.ts` files directly via its extension loader, so the build step is type-checking rather than transpilation.

## Reference docs

- Pi package docs: packages can declare resources under the `pi` key in `package.json`.
- Pi extension docs: extensions can register flags, commands, event handlers, and mutate `before_provider_request` payloads.
- TypeScript docs: `tsconfig.json` marks the project root and `module: "NodeNext"` is the correct Node-oriented module mode.
- pnpm docs: `pnpm run` executes manifest scripts with `node_modules/.bin` on `PATH`; `pnpm install --frozen-lockfile` keeps lockfile-based installs reproducible.
