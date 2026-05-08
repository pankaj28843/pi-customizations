# pi-customizations

Pankaj's public pi customization package.

First extension: **Codex Fast Mode**, a local version of [`calesennett/pi-codex-fast`](https://github.com/calesennett/pi-codex-fast) for current pi (`@earendil-works/pi-coding-agent`). It can add `service_tier: "priority"` to OpenAI / OpenAI Codex provider payloads.

## Install locally

```bash
cd ~/Personal/Code/pi-customizations
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

Once pushed to GitHub:

```bash
pi install git:github.com/pankaj28843/pi-customizations
```

For a project-local install:

```bash
pi install -l git:github.com/pankaj28843/pi-customizations
```

## Codex Fast Mode

### Commands

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

### Behavior

The extension patches provider payloads only when all of these are true:

- Codex fast mode is enabled.
- The active provider is `openai` or `openai-codex`.
- The outgoing payload does not already include `service_tier`.

When active, it returns a modified payload with:

```json
{ "service_tier": "priority" }
```

### Settings

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

For compatibility with the upstream package, this key is also read:

```json
{
  "pi-codex-fast": {
    "enabled": true
  }
}
```

Writes from `/codex-fast on|off` go to the global preferred key.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm check
make smoke
```

This repo intentionally ships TypeScript source. Pi loads extension `.ts` files directly via its extension loader, so the build step is type-checking rather than transpilation.

## Docs used

- Pi package docs: packages can declare resources under the `pi` key in `package.json`.
- Pi extension docs: extensions can register flags, commands, event handlers, and mutate `before_provider_request` payloads.
- TypeScript docs: `tsconfig.json` marks the project root and `module: "NodeNext"` is the correct Node-oriented module mode.
- pnpm docs: `pnpm run` executes manifest scripts with `node_modules/.bin` on `PATH`; `pnpm install --frozen-lockfile` keeps lockfile-based installs reproducible.
