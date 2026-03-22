const POLL_INTERVAL_MS = 500;

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("options-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  pollForResult();
});

function getStorageKey() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  return id ? `summary_${id}` : null;
}

function pollForResult() {
  const storageKey = getStorageKey();
  if (!storageKey) {
    showError({ error: "要約IDが見つかりません。" });
    return;
  }

  const check = async () => {
    const result = await chrome.storage.local.get(storageKey);
    const data = result[storageKey];
    if (!data) return;

    if (data.status === "loading") {
      setTimeout(check, POLL_INTERVAL_MS);
      return;
    }

    // Clean up storage after displaying
    chrome.storage.local.remove(storageKey);

    if (data.status === "error") {
      showError(data);
      return;
    }

    if (data.status === "done") {
      showResult(data);
    }
  };
  check();
}

function showResult(data) {
  document.getElementById("loading").hidden = true;
  document.getElementById("error").hidden = true;
  const result = document.getElementById("result");
  result.hidden = false;

  const badge = document.getElementById("source-type");
  badge.textContent = data.sourceType === "youtube" ? "YouTube" : "Web";
  badge.className = `badge badge-${data.sourceType}`;

  document.getElementById("source-url").href = data.url;
  document.getElementById("title").textContent = data.title || "";
  document.getElementById("summary").innerHTML = sanitizeHtml(data.summary);
}

function showError(data) {
  document.getElementById("loading").hidden = true;
  document.getElementById("result").hidden = true;
  const errorEl = document.getElementById("error");
  errorEl.hidden = false;

  document.getElementById("error-message").textContent = data.error;
  const errorUrl = document.getElementById("error-url");
  if (errorUrl) errorUrl.href = data.url || "#";
}

function sanitizeHtml(html) {
  if (!html) return "";

  // Remove markdown code fences if Gemini wraps output in ```html ... ```
  let cleaned = html
    .replace(/^```html?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");

  // Remove script tags and event handlers
  cleaned = cleaned
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]*/gi, "");

  return cleaned;
}
