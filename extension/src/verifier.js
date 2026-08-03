import { verifyEvidenceBundle } from "./protocol.js";

const input = document.querySelector("[data-file]");
const output = document.querySelector("[data-result]");

input.addEventListener("change", async () => {
  const file = input.files[0];
  if (!file) return;
  try {
    const bundle = JSON.parse(await file.text());
    const result = await verifyEvidenceBundle(bundle);
    output.className = `notice ${result.valid ? "" : "attention"}`;
    output.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = result.valid ? "Evidence verified" : "Evidence did not verify";
    const summary = document.createElement("p");
    summary.textContent = result.valid
      ? `${bundle.actions?.length ?? 0} signed action(s) and ${bundle.inclusions?.length ?? 0} personal-chain inclusion(s) verified.`
      : result.errors.join(" · ");
    const detail = document.createElement("p");
    detail.className = "proof";
    detail.textContent = `Bundle ${bundle.id ?? "unknown"}\nRoot ${bundle.root ?? "missing"}`;
    output.append(title, summary, detail);
  } catch (error) {
    output.className = "notice attention";
    output.textContent = `Unable to read bundle: ${error.message}`;
  }
});
