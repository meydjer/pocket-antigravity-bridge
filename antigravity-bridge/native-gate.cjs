// The carrier's PreToolUse hook. Native access is limited to agy's media files.
const { realpathSync, statSync, writeFileSync } = require("node:fs");
const { isAbsolute, join, relative, sep } = require("node:path");
const PREFIX = "mcp_pi-bridge_";
const CONVERSATION = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const MEDIA = /^media_[\w-]+\.(?:png|jpe?g|gif|webp)$/i;
// agy declares the native tool as `view_file`; Gemini 4 models call it `read_file`.
const VIEW_TOOLS = new Set(["view_file", "read_file"]);
const isViewTool = (name) => VIEW_TOOLS.has(name);

function allowMedia(args, appData, stagedAppData, conversationId) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const keys = Object.keys(args);
  // agy's viewFileArgs supports Path and the legacy AbsolutePath. Only a
  // single path, with no line/range or other arguments, is permitted here.
  if (keys.length !== 1 || !["Path", "AbsolutePath"].includes(keys[0])) return false;
  let input = args[keys[0]];
  // agy can pass the path as a JSON string literal: "\"/abs/path\"". Unwrap once.
  if (typeof input === "string" && input.length > 1 && input.startsWith('"') && input.endsWith('"')) {
    try { input = JSON.parse(input); } catch { return false; }
  }
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0") ||
      input.split(sep).some((part) => part === ".." || part === ".")) return false;
  const valid = (root) => {
    const parts = relative(root, input).split(sep);
    const [brain, id, generated, steps, step, file] = parts;
    return parts.length === 6 && brain === "brain" && CONVERSATION.test(id) &&
      (conversationId === undefined || id === conversationId) &&
      generated === ".system_generated" && steps === "steps" && /^\d+$/.test(step) &&
      MEDIA.test(file) ? parts : undefined;
  };
  try {
    const root = realpathSync(appData);
    const parts = valid(root) ?? valid(appData) ?? valid(stagedAppData);
    if (!parts) return false;
    const target = realpathSync(input);
    // Permit the carrier's app-data alias, but no redirection inside that tree.
    return target === join(root, ...parts) && statSync(target).isFile();
  } catch {
    return false;
  }
}

function markDenial(path) {
  if (path) writeFileSync(path, "", { mode: 0o600 });
}

async function main() {
  const [, , appData, stagedAppData, denial] = process.argv;
  const chunks = [];
  let count = 0;
  for await (const chunk of process.stdin) {
    count += chunk.length;
    if (count > 1024 * 1024) return false;
    chunks.push(chunk);
  }
  const { toolCall, conversationId } = JSON.parse(Buffer.concat(chunks).toString());
  if (isViewTool(toolCall?.name)) {
    // conversationId is in agy's common hook data, not in model arguments.
    const allowed = allowMedia(toolCall.args, appData, stagedAppData, conversationId);
    if (!allowed) markDenial(denial);
    return allowed;
  }
  return (
    (typeof toolCall?.name === "string" && toolCall.name.startsWith(PREFIX)) ||
    (toolCall?.name === "call_mcp_tool" && toolCall.args?.ServerName === "pi-bridge")
  );
}

module.exports = { allowMedia, isViewTool, markDenial };
if (require.main === module)
  main()
    .catch(() => false)
    .then((allow) => process.stdout.write(JSON.stringify(allow
      ? { decision: "allow" }
      : { decision: "deny", reason: "Use the private Pi tools or an eligible agy media image." }) + "\n"));
