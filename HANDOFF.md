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

The check runs syntax checks, type checks, mocked ACP tests, and an isolated Pi Pocket smoke test. It covers tool handoff, long-history recovery, image forwarding, validation of image paths, model refresh, and ACP errors. It uses only mocks. After installation, check **Menu → Extensions** for an error and run `/agy-status doctor`. For a live image check, run `PI_POCKET_AGY_TRACE=1 node test/pocket-smoke.mjs --live --image` in this repo. The isolated check uses Gemini 4 Hydrogen (low) to read one PNG through Pi. It uses quota. `ACP media read denied` means the check used the inline fallback.

## Limits

- The bridge uses a private work folder and a localhost MCP endpoint with a per-connection token. It removes the work folder after the ACP process exits. At startup, it removes work folders with `acp-XXXXXX` names that are more than 1 day old, but does not follow symlinks. It does not remove agy application data. Pi Pocket checks MCP calls as ordinary Pi tools. The hook is not an OS sandbox.
- The bridge sends image results over MCP in the same ACP turn. agy can open an offloaded image with its only native tool, `view_file`. The installed agy 1.5.16 binary names `view_file` for page images and lists `Path` and `AbsolutePath` in its argument type. The gate permits only regular `media_*` image files in `brain/<id>/.system_generated/steps/<n>/` under agy application data. It rejects traversal and symlink redirection.
- agy 1.5.16 exposes `HookArgsCommon.GetConversationId`; `jsonhook.marshalHookArgs` merges the common fields into the hook input. Historical ACP `cascade_id` log values match brain directory names. The gate checks `conversationId` when agy sends it. If that field is absent, an eligible image in **any** agy conversation can be read. ACP `sessionId` is not used as a brain directory name.
- A denied media read before the next Pi tool handoff discards the partial answer and starts a fresh ACP turn. A restart also uses inline images from Pi history (up to 8 and 24 MB of base64). `antigravity_ask` accepts up to 8 absolute image paths (5 MiB per file, 16 MiB total) from the session's local working folder or `uploads/<conversationId>` in the Pi Pocket data folder. It checks real paths. It uses the experimental `host.cwdOf` API (Pi Pocket 0.28.0 or later).
- The bridge reuses ACP sessions and recovers from Pi history without replaying tool calls. When the live ACP turn no longer matches Pi's transcript (for example, after compaction during a tool call or an edit to history), it closes that turn and starts again from Pi's transcript. A 400,000-byte JSON digest keeps the first user message (or Pi's compaction summary) and the newest history. It marks omitted entry ranges and clipped text. A cancellation during tool handoff can leave ACP waiting until recovery or the turn deadline. ACP retains its own data. Provider cost shows as zero, but Google still applies its quota.

- Gemini 4 models call agy's native view tool `read_file` (declared as `view_file`) and can pass the path as a JSON string literal. The gate accepts both names and unwraps the quotes once. Live check with a large image (agy offloads large MCP images): `AGY_SMOKE_IMAGE=/path/big.jpg AGY_SMOKE_MODEL=gemini-4-neon node test/pocket-smoke.mjs --live --image`.
