// popup.js — Popup logic

document.addEventListener("DOMContentLoaded", () => {
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const optionsBtn = document.getElementById("options-btn");

  // Check if API key is configured
  chrome.storage.sync.get(["openaiApiKey"], (result) => {
    if (result.openaiApiKey) {
      statusDot.classList.remove("inactive");
      statusDot.classList.add("active");
      statusText.textContent =
        "API key configured. Navigate to a YouTube Short to start!";
    } else {
      statusDot.classList.remove("active");
      statusDot.classList.add("inactive");
      statusText.textContent =
        "No API key found. Click below to configure.";
    }
  });

  // Open options page
  optionsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
