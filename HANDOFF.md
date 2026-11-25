# Antigravity Bridge for Pi Pocket

## State

Port of `@firespoon/pi-antigravity-bridge` 1.10.16 (MIT; see `LICENSE`). The live drop-in is enabled under `/data/extensions/`. This revision has not been installed or tested against live agy. No Pi Pocket settings or source changed.

## Use and reload

- **Menu → Refresh models** runs `agy models` and replaces the catalog. A local refresh does not call agy. If discovery fails, the bridge keeps the last list. A new load starts with fallback models and tries discovery in the background.
- Run `/agy-status doctor` in Pi Pocket to check the catalog and agy version. It warns if the version differs from 1.5.16. If agy needs sign-in, run `agy` in a terminal on the server, then try again. For a quota or rate limit, wait or select another provider.
- For a saved model with a removed `-xhigh` suffix, select the base model and set thinking to `xhigh`.
- Install the helpers before the entry file. The module uses static imports for gallery review. Pi Pocket caches helpers. Changes to a helper must wait for a server restart, even if you save the entry file or turn the module off and on. The first upgrade from the old mixed static and dynamic imports can use cached helpers: check with `/agy-status doctor`.

Optional config: `antigravity-bridge/config.json` in the Pi Pocket data folder. Default: `{"binary":"agy","sendSystemPrompt":true}`. If the server cannot find agy, set `binary` to its absolute path. The extension sends prompt context and requested tool results to Google. Do not put secrets in prompts or tool results.

## Checks

Tested with Node 24 and agy 1.5.16. Link Pi Pocket's types and packages if the repo lacks the links:

```sh
ln -s ~/.pi-pocket/extensions/node_modules node_modules
ln -s ~/.pi-pocket/extensions/_pocket.d.ts _pocket.d.ts
npm ci --prefix .toolchain
npm run check
```

The check runs syntax checks, type checks, mocked ACP tests, and an isolated Pi Pocket smoke test. It covers tool handoff, long-history recovery, image forwarding, validation of image paths, model refresh, and ACP errors. It uses only mocks. After installation, check **Menu → Extensions** for an error and run `/agy-status doctor`. For one live turn, with the owner's approval, run `node test/pocket-smoke.mjs --live` in this repo. That command uses quota.

## Limits

- The bridge uses a private work folder and a localhost MCP endpoint with a per-connection token. Its hook denies native and foreign calls. Pi Pocket checks bridge calls as ordinary Pi tools. The hook is not an OS sandbox.
- For image tool results, it starts a new ACP turn from Pi's transcript with inline images (up to 8 and 24 MB of base64). The installed agy binary mentions `view_file` for page images, but sampled offloaded media resolved to shared agy application data. The bridge does not grant a native read. `antigravity_ask` accepts up to 8 absolute image paths (5 MiB per file, 16 MiB total) from the session's local working folder or `uploads/<conversationId>` in the Pi Pocket data folder. The bridge checks real paths, so a symlink out of these folders does not grant access. This uses the experimental `host.cwdOf` API (Pi Pocket 0.28.0 or later).
- The bridge reuses ACP sessions and recovers from Pi history without replaying tool calls. When the live ACP turn no longer matches Pi's transcript (an image result, a compaction during a tool call, an edited history), it closes that turn and starts again from Pi's transcript. A 400,000-byte JSON digest keeps the first user message (or Pi's compaction summary) and the newest history. It marks omitted entry ranges and clipped text. A cancellation during tool handoff can leave ACP waiting until recovery or the turn deadline. ACP retains its own data. Provider cost shows as zero, but Google still applies its quota.
