from pathlib import Path

path = Path("services/mcp-gateway/test/mcp-authorization.test.js")
text = path.read_text()
old = "  const repository = new MemoryMcpPairingRepository();\n"
new = "  const repository = new MemoryMcpPairingRepository({ now: () => new Date(NOW) });\n"
count = text.count(old)
if count != 1:
    raise SystemExit(f"Expected one authorization repository fixture, found {count}")
path.write_text(text.replace(old, new, 1))
print("Aligned MCP authorization pairing repository clock")
