// The carrier's PreToolUse hook. No shell, files, or external services from here.
const PREFIX = "mcp_pi-bridge_";
async function main() {
  const chunks = [];
  let count = 0;
  for await (const chunk of process.stdin) {
    count += chunk.length;
    if (count > 1024 * 1024) return false;
    chunks.push(chunk);
  }
  const { toolCall } = JSON.parse(Buffer.concat(chunks).toString());
  return (
    (typeof toolCall?.name === "string" && toolCall.name.startsWith(PREFIX)) ||
    (toolCall?.name === "call_mcp_tool" &&
      toolCall.args?.ServerName === "pi-bridge")
  );
}
main()
  .catch(() => false)
  .then((allow) =>
    process.stdout.write(
      JSON.stringify(
        allow
          ? { decision: "allow" }
          : {
              decision: "deny",
              reason: "Use only the private Pi bridge tools.",
            },
      ) + "\n",
    ),
  );
