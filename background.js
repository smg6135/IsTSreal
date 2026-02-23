// background.js — Service worker: streaming GPT fact-check

// ══════════════════════════════════════════════
//  STORAGE HELPERS
// ══════════════════════════════════════════════

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["openaiApiKey"], (result) => {
      resolve(result.openaiApiKey || "");
    });
  });
}

async function getModel() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["gptModel"], (result) => {
      resolve(result.gptModel || "gpt-5.2");
    });
  });
}

// ══════════════════════════════════════════════
//  PORT CONNECTION — streaming fact-check
// ══════════════════════════════════════════════

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "factcheck-stream") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.action === "factCheckTranscript") {
      try {
        await handleTranscriptFactCheck(port, msg);
      } catch (err) {
        safeSend(port, { type: "error", message: err.message });
      }
    }

    if (msg.action === "factCheckAudio") {
      try {
        await handleAudioFactCheck(port, msg);
      } catch (err) {
        safeSend(port, { type: "error", message: err.message });
      }
    }
  });
});

function safeSend(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // port disconnected
  }
}

// ══════════════════════════════════════════════
//  HANDLERS
// ══════════════════════════════════════════════

// Path A: captions already extracted — just fact-check
async function handleTranscriptFactCheck(port, { transcript, videoUrl, videoTitle }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    safeSend(port, {
      type: "error",
      message: "OpenAI API key not set. Click the extension icon → Configure API Key.",
    });
    return;
  }

  try {
    await streamFactCheck(port, apiKey, transcript, videoTitle, videoUrl);
  } catch (err) {
    safeSend(port, { type: "error", message: "Analysis failed: " + err.message });
  }
}

// Path B: audio blob — transcribe with Whisper first, then fact-check
async function handleAudioFactCheck(port, { audioData, mimeType, videoUrl, videoTitle }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    safeSend(port, {
      type: "error",
      message: "OpenAI API key not set. Click the extension icon → Configure API Key.",
    });
    return;
  }

  // Step 1: Whisper transcription
  let transcript;
  try {
    transcript = await transcribeAudio(apiKey, audioData, mimeType);
  } catch (err) {
    safeSend(port, { type: "error", message: "Whisper transcription failed: " + err.message });
    return;
  }

  // Send transcript back to content script
  safeSend(port, { type: "transcript", text: transcript });

  // Step 2: Stream fact-check
  try {
    await streamFactCheck(port, apiKey, transcript, videoTitle, videoUrl);
  } catch (err) {
    safeSend(port, { type: "error", message: "Analysis failed: " + err.message });
  }
}

// ══════════════════════════════════════════════
//  WHISPER TRANSCRIPTION
// ══════════════════════════════════════════════

async function transcribeAudio(apiKey, base64Audio, mimeType) {
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const extension = mimeType.includes("webm") ? "webm" : "mp4";
  const blob = new Blob([bytes], { type: mimeType });
  const file = new File([blob], `audio.${extension}`, { type: mimeType });

  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", "whisper-1");
  formData.append("response_format", "text");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    }
  );

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Whisper API (${response.status}): ${errBody}`);
  }

  return await response.text();
}

// ══════════════════════════════════════════════
//  STREAMING GPT FACT-CHECK
// ══════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a rigorous fact-checker. You will be given a transcript from a YouTube Short video. Your job is to:

1. Identify all factual claims made in the transcript.
2. Evaluate each claim as TRUE, FALSE, MISLEADING, or UNVERIFIABLE.
3. Provide a brief explanation for each evaluation.
4. Give an overall credibility rating: HIGH, MEDIUM, LOW, or VERY LOW.
5. Suggest reliable sources where the user can verify the claims.

Format your response as:

**Overall Credibility: [RATING]**

**Claims Analysis:**
1. **Claim:** [claim text]
   **Verdict:** [TRUE/FALSE/MISLEADING/UNVERIFIABLE]
   **Explanation:** [brief explanation]

**Suggested Sources:**
Return sources as a JSON array at the very end of your response on its own line, formatted as:
SOURCES_JSON: [{"title": "Source Name", "url": "https://..."}]

Be concise but thorough. If the content is opinion-based or entertainment, note that.`;

async function streamFactCheck(port, apiKey, transcript, videoTitle, videoUrl) {
  const model = await getModel();

  const userPrompt = `Video Title: ${videoTitle}
Video URL: ${videoUrl}

Transcript:
${transcript}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`GPT API (${response.status}): ${errBody}`);
  }

  // Read the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        safeSend(port, { type: "stream-done" });
        return;
      }

      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) {
          safeSend(port, { type: "stream-token", token });
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  safeSend(port, { type: "stream-done" });
}
