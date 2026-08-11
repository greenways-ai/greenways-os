from pathlib import Path

path = Path("services/mcp-gateway/src/sqlite-delivery-store.js")
text = path.read_text()
replacements = [
    ("      || row.lease_id !== record.lease?.id\n", "      || row.lease_id !== (record.lease?.id ?? null)\n"),
    ("      || row.consumer_id !== record.lease?.consumerId\n", "      || row.consumer_id !== (record.lease?.consumerId ?? null)\n"),
    ("      || row.lease_expires_at !== record.lease?.expiresAt\n", "      || row.lease_expires_at !== (record.lease?.expiresAt ?? null)\n"),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one SQLite optional-column anchor, found {count}: {old!r}")
    text = text.replace(old, new, 1)
path.write_text(text)
print("Normalized optional SQLite delivery columns to null")
