from pathlib import Path

path = Path("services/greenways-desktop-bridge/src/setup/tests.rs")
text = path.read_text()
old = """        file.sync_all().expect(\"script sync\");
        #[cfg(unix)]
        fs::set_permissions(&packaged_daemon, fs::Permissions::from_mode(0o755))
"""
new = """        file.sync_all().expect(\"script sync\");
        drop(file);
        #[cfg(unix)]
        fs::set_permissions(&packaged_daemon, fs::Permissions::from_mode(0o755))
"""
if text.count(old) != 1:
    raise SystemExit("temporary daemon fixture source changed")
path.write_text(text.replace(old, new, 1))
