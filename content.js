// content.js — YouTube Shorts Fact Checker (click-to-check)

(function () {
  "use strict";

  // ── State ──
  let currentPort = null;
  let isProcessing = false;
  let streamedAnalysis = "";
  let debounceTimer = null;

  // ── Guard: check if extension context is still valid ──
  function isExtensionValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function isYouTubeShort() {
    return window.location.pathname.startsWith("/shorts/");
  }

  function getVideoId() {
    const match = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  function getVideoTitle() {
    return (
      document.querySelector(
        "h2.ytShortsLockupViewModelHostMetadataTitle span"
      )?.textContent ||
      document.querySelector("#title")?.textContent?.trim() ||
      document.title
    );
  }

  // ── Get the video element on the page ──
  function getVideoElement() {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      if (video.readyState >= 2 && video.duration > 0) return video;
    }
    return videos[0] || null;
  }

  // ══════════════════════════════════════════════
  //  AUDIO RECORDING (Whisper fallback)
  // ══════════════════════════════════════════════

  function recordAudioFromVideo(videoEl) {
    return new Promise((resolve, reject) => {
      try {
        const stream = videoEl.captureStream?.() || videoEl.mozCaptureStream?.();
        if (!stream) {
          reject(new Error("captureStream not supported."));
          return;
        }

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          reject(new Error("No audio tracks found."));
          return;
        }

        const audioStream = new MediaStream(audioTracks);
        const recorder = new MediaRecorder(audioStream, {
          mimeType: "audio/webm;codecs=opus",
        });

        const chunks = [];

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          resolve(blob);
        };

        recorder.onerror = (e) => {
          reject(new Error("Recording error: " + (e.error?.message || "unknown")));
        };

        // Use video duration to know exactly when to stop
        const duration = videoEl.duration;
        const recordMs = (isFinite(duration) && duration > 0)
          ? (duration * 1000) + 500
          : 62000;

        const stopIfRecording = () => {
          if (recorder.state === "recording") recorder.stop();
        };

        // Stop early on pause (user paused or scrolled away)
        const onPause = () => stopIfRecording();
        videoEl.addEventListener("pause", onPause);

        // Stop early on navigation (user swiped to next Short)
        const startUrl = window.location.href;
        const navCheck = setInterval(() => {
          if (window.location.href !== startUrl) stopIfRecording();
        }, 300);

        // Clean up all listeners when recording stops
        const origOnStop = recorder.onstop;
        recorder.onstop = () => {
          videoEl.removeEventListener("pause", onPause);
          clearInterval(navCheck);
          const blob = new Blob(chunks, { type: "audio/webm" });
          resolve(blob);
        };

        // Restart from beginning and record
        videoEl.currentTime = 0;
        videoEl.play();
        recorder.start(1000);

        // Stop after one full play-through (max wait)
        setTimeout(stopIfRecording, recordMs);
      } catch (err) {
        reject(err);
      }
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  }

  // ══════════════════════════════════════════════
  //  TRANSCRIPT EXTRACTION (captions)
  // ══════════════════════════════════════════════

  // Extract caption track URL from YouTube page HTML
  function extractCaptionUrl(html) {
    // Strategy 1: Extract from ytInitialPlayerResponse
    const playerRespMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s);
    if (playerRespMatch) {
      try {
        const playerData = JSON.parse(playerRespMatch[1]);
        const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks && tracks.length > 0) {
          const enTrack = tracks.find((t) => t.languageCode?.startsWith("en")) || tracks[0];
          if (enTrack?.baseUrl) return enTrack.baseUrl;
        }
      } catch {}
    }

    // Strategy 2: Find baseUrl directly from captionTracks array
    const baseUrlMatch = html.match(/"captionTracks"\s*:\s*\[.*?"baseUrl"\s*:\s*"(.*?)"/s);
    if (baseUrlMatch) {
      let url = baseUrlMatch[1];
      url = url.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      return url;
    }

    // Strategy 3: Find any timedtext URL in the page
    const timedtextMatch = html.match(/(https?:\/\/www\.youtube\.com\/api\/timedtext[^"\\]+)/);
    if (timedtextMatch) {
      let url = timedtextMatch[1];
      url = url.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      return url;
    }

    return null;
  }

  // Parse caption XML into plain text
  function parseCaptionXml(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "text/xml");
    const textNodes = doc.querySelectorAll("text");
    if (textNodes.length === 0) return null;

    const parts = [];
    textNodes.forEach((node) => {
      let text = node.textContent || "";
      text = text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n/g, " ")
        .trim();
      if (text) parts.push(text);
    });

    return parts.join(" ") || null;
  }

  // Fetch full transcript from YouTube's timedtext API
  async function fetchTranscriptFromAPI(videoId) {
    // Fetch the watch page (not shorts page) to get player config
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    const html = await resp.text();

    const captionUrl = extractCaptionUrl(html);
    if (!captionUrl) {
      console.warn("[YT Fact Check] No caption URL found in page HTML");
      return null;
    }

    // Fetch the captions XML
    const captionResp = await fetch(captionUrl);
    const captionXml = await captionResp.text();

    return parseCaptionXml(captionXml);
  }

  // Fallback: try YouTube's auto-generated captions via direct URL construction
  async function fetchTranscriptDirect(videoId) {
    // YouTube's timedtext endpoint for auto-generated captions
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const xml = await resp.text();
      const result = parseCaptionXml(xml);
      if (result) return result;
    } catch {}

    // Try with asr (auto speech recognition)
    const asrUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`;
    try {
      const resp = await fetch(asrUrl);
      if (!resp.ok) return null;
      const xml = await resp.text();
      return parseCaptionXml(xml);
    } catch {}

    return null;
  }

  // Combined: try all methods
  async function getTranscript(videoId) {
    // Method 1: Parse from watch page HTML
    try {
      const transcript = await fetchTranscriptFromAPI(videoId);
      if (transcript && transcript.length > 10) return transcript;
    } catch (err) {
      console.warn("[YT Fact Check] API transcript failed:", err);
    }

    // Method 2: Direct timedtext URL
    try {
      const transcript = await fetchTranscriptDirect(videoId);
      if (transcript && transcript.length > 10) return transcript;
    } catch (err) {
      console.warn("[YT Fact Check] Direct transcript failed:", err);
    }

    return null;
  }

  // ══════════════════════════════════════════════
  //  UI: FACT CHECK BUTTON
  // ══════════════════════════════════════════════

  function injectButton() {
    if (document.getElementById("ytfc-btn")) return;

    const btn = document.createElement("button");
    btn.id = "ytfc-btn";
    btn.textContent = "🔍 is ts real?";
    btn.addEventListener("click", handleFactCheck);
    document.body.appendChild(btn);
  }

  function removeButton() {
    const btn = document.getElementById("ytfc-btn");
    if (btn) btn.remove();
  }

  function setButtonState(state) {
    const btn = document.getElementById("ytfc-btn");
    if (!btn) return;
    switch (state) {
      case "idle":
        btn.textContent = "🔍 is ts real?";
        btn.disabled = false;
        btn.classList.remove("loading");
        break;
      case "loading":
        btn.textContent = "⏳ Checking...";
        btn.disabled = true;
        btn.classList.add("loading");
        break;
    }
  }

  // ══════════════════════════════════════════════
  //  UI: RESULTS PANEL
  // ══════════════════════════════════════════════

  function createPanel() {
    let panel = document.getElementById("ytfc-panel");
    if (panel) {
      // Reset existing panel
      resetPanel();
      panel.style.display = "flex";
      return;
    }

    panel = document.createElement("div");
    panel.id = "ytfc-panel";
    panel.innerHTML = `
      <div class="ytfc-panel-header">
        <span class="ytfc-panel-title">
          <span class="ytfc-live-dot" id="ytfc-live-dot"></span>
          <span id="ytfc-header-text">🔍 Analyzing...</span>
        </span>
        <button class="ytfc-close-btn" id="ytfc-close-btn">✕</button>
      </div>
      <div class="ytfc-panel-body" id="ytfc-panel-body">
        <div class="ytfc-section" id="ytfc-transcript-section" style="display:none">
          <h3>📝 Transcript</h3>
          <div class="ytfc-transcript" id="ytfc-transcript-content"></div>
        </div>
        <div class="ytfc-section" id="ytfc-analysis-section" style="display:none">
          <h3>✅ Analysis</h3>
          <div class="ytfc-analysis" id="ytfc-analysis-content">
            <span class="ytfc-cursor"></span>
          </div>
        </div>
        <div class="ytfc-section" id="ytfc-sources-section" style="display:none">
          <h3>📚 Sources</h3>
          <ul id="ytfc-sources-list"></ul>
        </div>
        <div class="ytfc-section" id="ytfc-error-section" style="display:none">
          <div class="ytfc-error" id="ytfc-error-content"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById("ytfc-close-btn").addEventListener("click", () => {
      panel.style.display = "none";
      setButtonState("idle");
      isProcessing = false;
      if (currentPort) {
        try { currentPort.disconnect(); } catch {}
        currentPort = null;
      }
    });
  }

  function resetPanel() {
    streamedAnalysis = "";
    ["ytfc-transcript-section", "ytfc-analysis-section", "ytfc-sources-section", "ytfc-error-section"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
    const analysis = document.getElementById("ytfc-analysis-content");
    if (analysis) analysis.innerHTML = '<span class="ytfc-cursor"></span>';
    const sources = document.getElementById("ytfc-sources-list");
    if (sources) sources.innerHTML = "";
    const dot = document.getElementById("ytfc-live-dot");
    if (dot) { dot.classList.remove("done"); dot.classList.add("live"); }
    const header = document.getElementById("ytfc-header-text");
    if (header) header.textContent = "🔍 Analyzing...";
  }

  function showTranscript(text) {
    const section = document.getElementById("ytfc-transcript-section");
    const content = document.getElementById("ytfc-transcript-content");
    if (section) section.style.display = "";
    if (content) content.textContent = text;
  }

  function appendAnalysis(token) {
    streamedAnalysis += token;
    const section = document.getElementById("ytfc-analysis-section");
    const content = document.getElementById("ytfc-analysis-content");
    if (section) section.style.display = "";
    if (content) {
      content.innerHTML = formatFactCheck(streamedAnalysis) + '<span class="ytfc-cursor"></span>';
      content.scrollTop = content.scrollHeight;
    }
  }

  function showSources(sources) {
    if (!sources || sources.length === 0) return;
    const section = document.getElementById("ytfc-sources-section");
    const list = document.getElementById("ytfc-sources-list");
    if (section) section.style.display = "";
    if (list) {
      list.innerHTML = sources
        .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a></li>`)
        .join("");
    }
  }

  function showError(msg) {
    const section = document.getElementById("ytfc-error-section");
    const content = document.getElementById("ytfc-error-content");
    if (section) section.style.display = "";
    if (content) content.textContent = "❌ " + msg;
  }

  function setDone() {
    const dot = document.getElementById("ytfc-live-dot");
    if (dot) { dot.classList.remove("live"); dot.classList.add("done"); }
    const header = document.getElementById("ytfc-header-text");
    if (header) header.textContent = "✅ Analysis Complete";
    // Remove cursor
    const content = document.getElementById("ytfc-analysis-content");
    if (content) content.innerHTML = formatFactCheck(streamedAnalysis);
    setButtonState("idle");
    isProcessing = false;
  }

  // ══════════════════════════════════════════════
  //  MAIN HANDLER
  // ══════════════════════════════════════════════

  async function handleFactCheck() {
    if (isProcessing) return;
    isProcessing = true;
    setButtonState("loading");

    const videoId = getVideoId();
    if (!videoId) {
      showError("Could not detect video ID.");
      setButtonState("idle");
      isProcessing = false;
      return;
    }

    if (!isExtensionValid()) {
      showError("Extension context lost. Please reload the page.");
      setButtonState("idle");
      isProcessing = false;
      return;
    }

    createPanel();
    const headerText = document.getElementById("ytfc-header-text");

    // ── Step 1: Try captions first (instant) ──
    if (headerText) headerText.textContent = "📝 Getting captions...";

    let transcript = null;
    let usedWhisper = false;

    try {
      transcript = await getTranscript(videoId);
    } catch (err) {
      console.warn("[YT Fact Check] Captions failed:", err);
    }

    // ── Step 1b: Whisper fallback if no captions ──
    if (!transcript) {
      if (headerText) headerText.textContent = "🎙️ Recording audio for Whisper...";

      const videoEl = getVideoElement();
      if (!videoEl) {
        showError("Could not find video element.");
        setButtonState("idle");
        isProcessing = false;
        return;
      }

      let audioBlob;
      try {
        audioBlob = await recordAudioFromVideo(videoEl);
      } catch (err) {
        showError("No captions available and audio recording failed: " + err.message);
        setButtonState("idle");
        isProcessing = false;
        return;
      }

      if (headerText) headerText.textContent = "📝 Transcribing with Whisper...";
      usedWhisper = true;

      // Send audio to background for Whisper transcription + fact-check
      const base64Audio = await blobToBase64(audioBlob);
      connectAndStream({
        action: "factCheckAudio",
        audioData: base64Audio,
        mimeType: audioBlob.type,
        videoUrl: window.location.href,
        videoTitle: getVideoTitle(),
      });
      return;
    }

    showTranscript(transcript);

    // ── Step 2: Send transcript for streaming GPT fact-check ──
    if (headerText) headerText.textContent = "🧠 Analyzing claims...";

    connectAndStream({
      action: "factCheckTranscript",
      transcript,
      videoUrl: window.location.href,
      videoTitle: getVideoTitle(),
    });
  }

  // ── Open port, attach listeners, send message ──
  function connectAndStream(message) {
    if (currentPort) {
      try { currentPort.disconnect(); } catch {}
    }

    try {
      currentPort = chrome.runtime.connect({ name: "factcheck-stream" });
    } catch (err) {
      showError("Failed to connect to extension: " + err.message);
      setButtonState("idle");
      isProcessing = false;
      return;
    }

    currentPort.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "transcript":
          // Whisper transcript received
          showTranscript(msg.text);
          const headerText = document.getElementById("ytfc-header-text");
          if (headerText) headerText.textContent = "🧠 Analyzing claims...";
          break;
        case "stream-token":
          appendAnalysis(msg.token);
          break;
        case "stream-done":
          parseSources(streamedAnalysis);
          setDone();
          break;
        case "error":
          showError(msg.message);
          setDone();
          break;
      }
    });

    currentPort.onDisconnect.addListener(() => {
      currentPort = null;
    });

    currentPort.postMessage(message);
  }

  // ── Parse SOURCES_JSON from streamed text ──
  function parseSources(text) {
    const match = text.match(/SOURCES_JSON:\s*(\[.*\])/s);
    if (match) {
      try {
        const sources = JSON.parse(match[1]);
        showSources(sources);
        streamedAnalysis = text.replace(/SOURCES_JSON:\s*\[.*\]/s, "").trim();
        const content = document.getElementById("ytfc-analysis-content");
        if (content) content.innerHTML = formatFactCheck(streamedAnalysis);
      } catch {}
    }
  }

  // ══════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatFactCheck(text) {
    return text
      .replace(/\n/g, "<br>")
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>");
  }

  // ══════════════════════════════════════════════
  //  SPA NAVIGATION
  // ══════════════════════════════════════════════

  let lastUrl = window.location.href;

  function onUrlChange() {
    const newUrl = window.location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;

    if (isYouTubeShort()) {
      setTimeout(injectButton, 500);
    } else {
      removeButton();
    }
  }

  const observer = new MutationObserver(() => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onUrlChange();
    }, 300);
  });

  observer.observe(document.body, { childList: true, subtree: false });
  window.addEventListener("yt-navigate-finish", onUrlChange);
  window.addEventListener("popstate", onUrlChange);

  // Initial check
  if (isYouTubeShort()) {
    setTimeout(injectButton, 1000);
  }
})();
