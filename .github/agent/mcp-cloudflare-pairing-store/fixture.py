from pathlib import Path

path = Path("services/mcp-gateway/test/mcp-authorization.test.js")
text = path.read_text()
replacements = [
    (
        "  const repository = new MemoryMcpPairingRepository();\n",
        "  const repository = new MemoryMcpPairingRepository({ now: () => new Date(NOW) });\n",
    ),
    (
        "  assert.equal(repository.connections.size, 0);\n",
        "  assert.equal((await repository.getSession(challenge.id)).connection, null);\n",
    ),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one authorization fixture anchor, found {count}: {old!r}")
    text = text.replace(old, new, 1)
path.write_text(text)
print("Aligned MCP authorization pairing retry fixtures")
