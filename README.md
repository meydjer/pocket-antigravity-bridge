# pocket-antigravity-bridge

A [Pi Pocket](https://github.com/TannerMidd/pi-pocket) drop-in extension that adds Google Antigravity models (`antigravity/*`) to the model picker. It is a port of [`@firespoon/pi-antigravity-bridge`](https://github.com/FireSpoonYZ/pi-antigravity-bridge), a fork of [`@estebanforge/pi-antigravity-bridge`](https://github.com/EstebanForge/pi-extensions/tree/main/packages/pi-antigravity-bridge). Pi Pocket does not load Pi packages, so the bridge needs its own module.

## How it works

- It starts the official Antigravity CLI as `agy acp`, the [ACP server that Google documents for other clients](https://antigravity.google/docs/ide/extensions/acp/). Sign-in stays inside `agy`. This extension never reads or copies OAuth tokens.
- `agy` runs a generated restricted agent. Its only native tool, `view_file`, can read eligible agy media images. See `HANDOFF.md` for the path and conversation checks.
- Pi's tools reach the agent through an MCP server on `127.0.0.1` with a per-connection token. Each action runs as a normal Pi tool call, so Pi Pocket's cards, permissions, and Lancet Guard apply.
- Images from Pi tools reach agy over MCP in the same ACP turn. If the media read is denied, the bridge can start a fresh turn with the images inline from Pi history.
- It adds `antigravity_ask`, a second-opinion tool that accepts up to 8 absolute image paths within the current session's local working folder or its uploads folder. The second-opinion model has no workspace tools. It also adds the `/agy-status` command.

Not ported: the TUI pickers and dialogs, the installer, hindsight recall, the native approval gate, and the stream-json engine. See `HANDOFF.md` for details and known gaps.

## Install

1. Install the [Antigravity CLI](https://antigravity.google/docs/cli/) and sign in once with `agy` (or `agy acp --login` over SSH). Check with `agy models`.
2. Copy `antigravity-bridge.ts` and the `antigravity-bridge/` folder into Pi Pocket's drop-in folder (`~/.pi-pocket/extensions/`).
3. Read the code, then turn on **Antigravity Bridge** in Menu → Extensions. Run `/agy-status doctor`.

## Terms of service: read this first

This project is not affiliated with or endorsed by Google. It does not claim to be "ToS safe".

The [Antigravity terms](https://antigravity.google/terms) say: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." Google also documents `agy acp` for "any ACP client". How these two fit for a host like Pi Pocket is not clear. You are responsible for your use of your account. If in doubt, sign `agy` in with a Gemini API key instead of a subscription.

## Development

```sh
ln -s ~/.pi-pocket/extensions/node_modules node_modules
ln -s ~/.pi-pocket/extensions/_pocket.d.ts _pocket.d.ts
npm ci --prefix .toolchain
npm run check            # mocked ACP peer, no quota
node test/pocket-smoke.mjs --live   # live text check; uses your quota
PI_POCKET_AGY_TRACE=1 node test/pocket-smoke.mjs --live --image  # live image check; uses your quota
```

## License

MIT. See `LICENSE`.
