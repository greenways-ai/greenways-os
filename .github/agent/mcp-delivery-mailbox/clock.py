from pathlib import Path

path = Path("services/mcp-gateway/src/sqlite-delivery-store.js")
text = path.read_text()
old = '''  currentDate() {
    return repositoryDate(this.now());
  }
'''
new = '''  currentDate() {
    return repositoryDate(this.now);
  }
'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"Expected one SQLite delivery clock anchor, found {count}")
path.write_text(text.replace(old, new, 1))
print("Kept the SQLite delivery repository clock callback intact")
