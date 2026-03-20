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

  // Native Messaging update button
  document.getElementById('updateBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('updateBtn');
    const origText = btn.textContent;
    btn.textContent = '⏳ 実行中...';
    btn.style.pointerEvents = 'none';
    try {
      const response = await chrome.runtime.sendNativeMessage(
        'com.yamaga101.gitpull',
        { repo: 'link-summarizer' }
      );
      btn.textContent = response.success ? '✅ 完了' : '❌ 失敗';
      btn.title = response.output || '';
    } catch (e) {
      btn.textContent = '❌ 失敗';
      btn.title = e.message || 'Native host not installed';
    }
    setTimeout(() => {
      btn.textContent = origText;
      btn.style.pointerEvents = '';
      btn.title = 'git pull で最新に更新';
    }, 3000);
  });
});
