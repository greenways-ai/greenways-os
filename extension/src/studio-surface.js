import { strToU8, zipSync } from "fflate";

const AUDIO_EXTENSION = /\.(?:aac|aif|aiff|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i;

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function localId() {
  if (globalThis.crypto?.randomUUID) return `local:${crypto.randomUUID()}`;
  return `local:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function audioFile(file) {
  return file.type.startsWith("audio/") || AUDIO_EXTENSION.test(file.name);
}

function safeFilename(value) {
  const name = String(value || "audio").normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim();
  return name || "audio";
}

function archiveName() {
  return `greenways-studio-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function createStudioArchive(studio, assetStore, { now = () => new Date() } = {}) {
  const tracks = studio?.tracks ?? [];
  if (!tracks.length) throw new Error("Studio project has no tracks to export");

  const files = {};
  const manifestTracks = [];
  for (const [index, track] of tracks.entries()) {
    const asset = assetStore.get(track.id);
    if (!asset?.file) throw new Error(`Local audio is unavailable for ${track.name || track.id}`);
    const path = `audio/${String(index + 1).padStart(2, "0")}-${safeFilename(track.name)}`;
    files[path] = new Uint8Array(await asset.file.arrayBuffer());
    manifestTracks.push({ ...track, assetPath: path });
  }

  const manifest = {
    format: "greenways-studio/0.1",
    exportedAt: now().toISOString(),
    tracks: manifestTracks,
  };
  files["studio.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  return { archive: zipSync(files, { level: 0 }), manifest };
}

export async function exportStudioProject(studio, assetStore) {
  const { archive, manifest } = await createStudioArchive(studio, assetStore);
  const blob = new Blob([archive], { type: "application/zip" });
  downloadBlob(blob, archiveName());
  return { bytes: blob.size, tracks: manifest.tracks.length };
}

export class AudioAssetStore {
  constructor() {
    this.assets = new Map();
  }

  add(id, file) {
    this.remove(id);
    const entry = { file, url: URL.createObjectURL(file) };
    this.assets.set(id, entry);
    return entry;
  }

  get(id) {
    return this.assets.get(id);
  }

  remove(id) {
    const entry = this.assets.get(id);
    if (entry) URL.revokeObjectURL(entry.url);
    this.assets.delete(id);
  }

  destroy() {
    for (const id of this.assets.keys()) this.remove(id);
  }
}

export function createStudioSurface({ root, close, session, assetStore }) {
  const abort = new AbortController();
  const signal = abort.signal;
  let destroyed = false;

  root.innerHTML = `
    <section class="studio-app">
      <header class="studio-header">
        <div><p>HODOS / MUSIC</p><h1>Studio</h1></div>
        <div class="studio-header-actions">
          <span data-studio-count>0 tracks</span>
          <button type="button" data-studio-export disabled>Export project</button>
          <button type="button" data-studio-close aria-label="Close Studio">Close</button>
        </div>
      </header>
      <div class="studio-workspace">
        <aside class="studio-library">
          <p class="studio-kicker">Library</p>
          <h2>Local audio</h2>
          <p>Drop recordings and stems from your desktop. The file remains local to this world session.</p>
          <button type="button" data-studio-choose>Add audio files</button>
          <input data-studio-input type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus,.webm" multiple hidden>
        </aside>
        <main class="studio-arrangement">
          <div class="studio-ruler" aria-hidden="true"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span></div>
          <div class="studio-dropzone" data-studio-dropzone>
            <strong>Drop tracks into the studio</strong>
            <span>WAV, MP3, M4A, FLAC, OGG, Opus or WebM</span>
          </div>
          <div class="studio-tracks" data-studio-tracks aria-live="polite"></div>
        </main>
        <aside class="studio-inspector">
          <p class="studio-kicker">Inspector</p>
          <h2>Project</h2>
          <dl><div><dt>Tempo</dt><dd>120 BPM</dd></div><div><dt>Meter</dt><dd>4 / 4</dd></div><div><dt>State</dt><dd>Hara</dd></div></dl>
          <p class="studio-note">This first slice keeps track identity and arrangement state in Hara while the browser retains the audio blobs.</p>
        </aside>
      </div>
      <footer class="studio-transport"><button type="button" disabled>◀</button><button type="button" disabled>▶</button><span>00:00.000</span><span>120 BPM</span><span class="studio-spacer"></span><strong>LOCAL DRAFT</strong></footer>
    </section>`;

  const input = root.querySelector("[data-studio-input]");
  const tracksRoot = root.querySelector("[data-studio-tracks]");
  const dropzone = root.querySelector("[data-studio-dropzone]");
  const count = root.querySelector("[data-studio-count]");
  const exportButton = root.querySelector("[data-studio-export]");

  async function importFiles(fileList) {
    const files = [...fileList].filter(audioFile);
    if (!files.length) {
      dropzone.dataset.error = "true";
      dropzone.querySelector("strong").textContent = "No supported audio files found";
      return;
    }
    dropzone.dataset.error = "false";
    for (const file of files) {
      const id = localId();
      assetStore.add(id, file);
      try {
        await session.dispatch("studio/add-track", [{
          id,
          name: file.name,
          mediaType: file.type || "audio/unknown",
          size: file.size,
          source: "desktop",
        }]);
      } catch (error) {
        assetStore.remove(id);
        throw error;
      }
    }
  }

  root.querySelector("[data-studio-close]").addEventListener("click", close, { signal });
  root.querySelector("[data-studio-choose]").addEventListener("click", () => input.click(), { signal });
  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    exportButton.textContent = "Exporting…";
    try {
      await session.dispatch("studio/export-project");
    } catch (error) {
      console.error("Studio project export failed", error);
      exportButton.textContent = "Export failed";
      exportButton.title = error.message;
      exportButton.disabled = false;
    }
  }, { signal });
  input.addEventListener("change", () => importFiles(input.files).finally(() => { input.value = ""; }), { signal });
  root.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dropzone.dataset.active = "true";
  }, { signal });
  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, { signal });
  root.addEventListener("dragleave", (event) => {
    if (!root.contains(event.relatedTarget)) dropzone.dataset.active = "false";
  }, { signal });
  root.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dropzone.dataset.active = "false";
    importFiles(event.dataTransfer.files).catch((error) => {
      console.error("Studio audio import failed", error);
      dropzone.dataset.error = "true";
      dropzone.querySelector("strong").textContent = error.message;
    });
  }, { signal });

  function renderTrack(track) {
    const lane = document.createElement("article");
    lane.className = "studio-track";
    lane.dataset.trackId = track.id;

    const identity = document.createElement("div");
    identity.className = "studio-track-identity";
    const name = document.createElement("strong");
    name.textContent = track.name;
    const detail = document.createElement("span");
    detail.textContent = `${humanBytes(track.size)} · ${track.source || "local"}`;
    identity.append(name, detail);

    const clip = document.createElement("div");
    clip.className = "studio-clip";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    const asset = assetStore.get(track.id);
    if (asset) audio.src = asset.url;
    clip.append(audio);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "studio-track-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await session.dispatch("studio/remove-track", [track.id]);
      assetStore.remove(track.id);
    }, { signal });

    lane.append(identity, clip, remove);
    return lane;
  }

  function update(state) {
    if (destroyed) return;
    const tracks = state?.studio?.tracks ?? [];
    count.textContent = `${tracks.length} track${tracks.length === 1 ? "" : "s"}`;
    exportButton.textContent = "Export project";
    exportButton.title = tracks.length ? "Download a ZIP with studio.json and the original audio files" : "Add a track before exporting";
    exportButton.disabled = tracks.length === 0;
    dropzone.hidden = tracks.length > 0;
    tracksRoot.replaceChildren(...tracks.map(renderTrack));
  }

  return {
    update,
    destroy() {
      destroyed = true;
      abort.abort();
    },
  };
}
