# Repository Instructions

- Use `pnpm` for dependency management and scripts.
- Run `pnpm check` before handing off changes.
- This is a pi package that intentionally exposes TypeScript source; do not add a transpiled `dist/` runtime unless pi package loading changes.
- Keep pi runtime imports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) in `peerDependencies` when used by extensions.
- `make install` must keep supporting `PI_CODING_AGENT_DIR=/custom/path` and install by symlinking the repo into `$PI_CODING_AGENT_DIR/extensions/`.
- Keep the full pi monorepo source checked out as a sibling of this repo under codename `pi`: from this repository root, it must exist at `../pi` and track `https://github.com/earendil-works/pi`.
