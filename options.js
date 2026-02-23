// options.js — Options page logic

document.addEventListener("DOMContentLoaded", () => {
  const apiKeyInput = document.getElementById("api-key");
  const modelSelect = document.getElementById("model-select");
  const saveBtn = document.getElementById("save-btn");
  const toast = document.getElementById("toast");

  // Load saved settings
  chrome.storage.sync.get(["openaiApiKey", "gptModel"], (result) => {
    if (result.openaiApiKey) {
      apiKeyInput.value = result.openaiApiKey;
    }
    if (result.gptModel) {
      modelSelect.value = result.gptModel;
    }
  });

  // Save settings
  saveBtn.addEventListener("click", () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value;

    if (!apiKey) {
      toast.textContent = "❌ Please enter an API key.";
      toast.style.background = "#ea4335";
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 3000);
      return;
    }

    if (!apiKey.startsWith("sk-")) {
      toast.textContent = "⚠️ API key should start with 'sk-'. Saved anyway.";
      toast.style.background = "#f9ab00";
    } else {
      toast.textContent = "✅ Settings saved successfully!";
      toast.style.background = "#34a853";
    }

    chrome.storage.sync.set({ openaiApiKey: apiKey, gptModel: model }, () => {
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 3000);
    });
  });
});
