// Packaged client for the loopback-only Home Node control plane.
export const HOME_NODE_ADMIN_CLIENT = `
    const csrf = document.querySelector('meta[name="gw-csrf"]').content;
    const notice = document.querySelector('[data-notice]');
    let latestCode = "";

    function setNotice(message, tone = "quiet") {
      notice.textContent = message;
      notice.dataset.tone = tone;
    }

    async function adminRequest(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          ...(options.headers || {}),
          "x-greenways-csrf": csrf,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || "Home Node request failed: " + response.status);
      return body;
    }

    function clear(element) {
      while (element.firstChild) element.firstChild.remove();
    }

    function empty(message) {
      const paragraph = document.createElement("p");
      paragraph.className = "empty";
      paragraph.textContent = message;
      return paragraph;
    }

    function row({ title, detail, badge, action }) {
      const article = document.createElement("article");
      article.className = "row";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = title;
      const small = document.createElement("small");
      small.textContent = detail;
      copy.append(strong, small);
      article.append(dot, copy);
      if (action) article.append(action);
      else if (badge) {
        const label = document.createElement("span");
        label.className = "badge";
        label.textContent = badge;
        article.append(label);
      }
      return article;
    }

    function render(status) {
      document.querySelector('[data-browser-count]').textContent = status.browsers.length;
      document.querySelector('[data-service-count]').textContent = status.services.length;
      document.querySelector('[data-pairing-state]').textContent = status.pairing.available ? "Open" : "Closed";
      document.querySelector('[data-durability]').textContent = status.durability === "persistent" ? "Durable" : "Ephemeral";

      const browsers = document.querySelector('[data-browsers]');
      clear(browsers);
      if (!status.browsers.length) browsers.append(empty("No browser has paired with this Home Node yet."));
      for (const browser of status.browsers) {
        const revoke = document.createElement("button");
        revoke.className = "danger";
        revoke.type = "button";
        revoke.dataset.revoke = browser.id;
        revoke.textContent = "Revoke";
        browsers.append(row({
          title: browser.name,
          detail: "Paired " + new Date(browser.pairedAt).toLocaleString() + " · last seen " + new Date(browser.lastSeenAt).toLocaleString(),
          action: revoke,
        }));
      }

      const services = document.querySelector('[data-services]');
      clear(services);
      if (!status.services.length) services.append(empty("No local service descriptors are configured."));
      for (const service of status.services) {
        services.append(row({
          title: service.name,
          detail: service.kind + (service.version ? " · v" + service.version : "") + " · " + ((service.capabilities || []).join(", ") || "no capabilities"),
          badge: service.status,
        }));
      }
    }

    async function refresh(message = null) {
      const status = await adminRequest("/greenways/admin/v1/status");
      render(status);
      if (message) setNotice(message, "good");
      return status;
    }

    document.querySelector('[data-issue]').addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        const pairing = await adminRequest("/greenways/admin/v1/pairing", { method: "POST" });
        latestCode = pairing.code;
        document.querySelector('[data-code-value]').textContent = pairing.code;
        document.querySelector('[data-code-expiry]').textContent = "Expires " + new Date(pairing.expiresAt).toLocaleString();
        document.querySelector('[data-code]').dataset.visible = "true";
        await refresh("A new single-use pairing code is active.");
      } catch (error) {
        setNotice(error.message, "error");
      } finally {
        event.currentTarget.disabled = false;
      }
    });

    document.querySelector('[data-copy]').addEventListener("click", async () => {
      if (!latestCode) return;
      try {
        await navigator.clipboard.writeText(latestCode);
        setNotice("Pairing code copied.", "good");
      } catch {
        setNotice("Select the pairing code and copy it manually.", "quiet");
      }
    });

    document.querySelector('[data-browsers]').addEventListener("click", async (event) => {
      const button = event.target.closest('[data-revoke]');
      if (!button) return;
      if (!window.confirm("Revoke this browser? It will need a new one-time code to return.")) return;
      button.disabled = true;
      try {
        await adminRequest("/greenways/admin/v1/devices/" + encodeURIComponent(button.dataset.revoke) + "/revoke", { method: "POST" });
        await refresh("The browser grant and its replay nonces were revoked.");
      } catch (error) {
        setNotice(error.message, "error");
        button.disabled = false;
      }
    });

    const themeButton = document.querySelector('[data-theme]');
    function applyTheme(theme) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      localStorage.setItem("gw-theme", theme);
      themeButton.textContent = theme === "dark" ? "☾" : "☀";
      themeButton.setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " theme");
    }
    const storedTheme = localStorage.getItem("gw-theme");
    applyTheme(storedTheme === "dark" || storedTheme === "light"
      ? storedTheme
      : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    themeButton.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

    refresh().catch((error) => setNotice(error.message, "error"));
    setInterval(() => refresh().catch(() => {}), 15000);
`;
