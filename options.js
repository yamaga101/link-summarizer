document.addEventListener("DOMContentLoaded", async () => {
  const apiKeyInput = document.getElementById("api-key");
  const saveBtn = document.getElementById("save-btn");
  const statusEl = document.getElementById("status");

  // Load saved key
  const { geminiApiKey } = await chrome.storage.sync.get("geminiApiKey");
  if (geminiApiKey) {
    apiKeyInput.value = geminiApiKey;
  }

  saveBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showStatus("APIキーを入力してください", true);
      return;
    }

    await chrome.storage.sync.set({ geminiApiKey: key });
    showStatus("保存しました", false);
  });

  function showStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.className = isError ? "status status-error" : "status status-success";
    statusEl.hidden = false;
    setTimeout(() => {
      statusEl.hidden = true;
    }, 3000);
  }
});
