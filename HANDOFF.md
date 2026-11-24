# Antigravity Bridge for Pi Pocket

## State

Port of `@firespoon/pi-antigravity-bridge` 1.10.16 (MIT; see `LICENSE`). Installed in `~/.pi-pocket/extensions/antigravity-bridge.ts` with helpers in `~/.pi-pocket/extensions/antigravity-bridge/`. The live drop-in is **off**. No Pi Pocket settings or source changed.

## Turn it on

1. As the Pi Pocket owner, confirm that `agy models` works in the server account. Use the official `agy` sign-in if needed.
2. Review the code, then turn on **Antigravity Bridge** in **Menu → Extensions**. Run `/agy-status doctor` to check discovery. The provider starts with a fallback list and replaces it when discovery succeeds.
3. Select `antigravity/gemini-3-8-flash` and a thinking level. On this account, `low`, `medium` and `high` map to the Flash variants. For a second opinion from another provider, use the `antigravity_ask` tool. It takes a text question and has no workspace tools.

Optional config: `antigravity-bridge/config.json` in the Pi Pocket data folder. Default: `{"binary":"agy","sendSystemPrompt":true}`. If the server cannot find `agy`, set `binary` to the absolute executable path. Turn the extension off and on to read new settings. The extension sends the prompt, selected transcript context, and requested tool results to Google. Only enable it for a server where the owner authorizes that use of the account. Do not put secrets in prompts or tool results.

## Checks

Tested with Node 24 and `agy` 1.5.16. In this repo, link the Pi Pocket types and packages if they are not already linked:

```sh
ln -s ~/.pi-pocket/extensions/node_modules node_modules
ln -s ~/.pi-pocket/extensions/_pocket.d.ts _pocket.d.ts
npm ci --prefix .toolchain
npm run check
```

`npm run check` checks the carrier gate syntax, typechecks the port, runs 5 tests and runs the mocked ACP peer against an isolated Pi Pocket app. The app's Extensions status reports `enabled: false` and no error before the test enables its **copy**. The test then proves model registration and a real Pi `read` call. The lead session also ran `PI_POCKET_AGY_TRACE=1 node test/pocket-smoke.mjs --live` with the owner's approval. Gemini Flash (low) completed one Pi `read` of the synthetic file and returned `synthetic-fixture-content`. This command uses quota; the default checks do not.

## What is different from the Pi package

- The restricted ACP agent runs in a private work folder. Its localhost MCP endpoint uses a per-connection token. The hook denies native and foreign calls; Pi Pocket executes and checks bridge calls as ordinary Pi tools. The hook is not an OS sandbox.
- Streams text and thinking, reports ACP usage when available, passes image blocks, and supports cancellation and long tool calls. Image tool results restart the ACP turn from Pi's transcript with inline images (at most 8, 24 MB base64); this was checked live with Gemini 4 Hydrogen. `antigravity_ask` takes up to 8 absolute image paths (5 MiB each, 16 MiB total), checked by Pi Pocket's read guard (`host.guard`, an undocumented host member). Long calls are not tested live. A cancellation during a Pi tool handoff may leave ACP waiting until recovery or the turn deadline.
- Reuses live ACP sessions. After a restart, removal, or incompatible context change, starts ACP again with bounded Pi history and completed tool results. Does not use `session/load` or replay old calls. ACP retains its own application data under the agy account. Provider cost is shown as zero; Google still applies its quota.
- No TUI, installer, hindsight recall, native approval dialog, or stream-JSON engine. MCP uses HTTP JSON responses, not an SSE listener. Tested `agy` works without SSE.
