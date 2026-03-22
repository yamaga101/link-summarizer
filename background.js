importScripts('auto-reload.js');

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
const MAX_TEXT_LENGTH = 30000;
const DIGEST_BATCH_SIZE = 40;

// ---------- Context Menu ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "summarize-link",
    title: "リンク先を要約",
    contexts: ["link"],
  });
  chrome.contextMenus.create({
    id: "summarize-page",
    title: "このページを要約",
    contexts: ["page"],
    documentUrlPatterns: ["https://*/*", "http://*/*"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "summarize-link") {
    await handleSummarize(info.linkUrl);
  } else if (info.menuItemId === "summarize-page") {
    await handleSummarize(tab.url);
  }
});

// ---------- Toolbar Icon → Digest ----------

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("digest.html"),
  });
});

// ---------- Message Handler ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "get-digest") {
    handleDigest().then(sendResponse).catch((e) =>
      sendResponse({ error: e.message })
    );
    return true; // async
  }
  if (message.type === "summarize-url") {
    handleSummarize(message.url);
    return false;
  }
  if (message.type === "summarize-voice") {
    handleVoiceSummarize(message).then(sendResponse).catch((e) =>
      sendResponse({ error: e.message })
    );
    return true;
  }
});

// ---------- Voice Summarize ----------

async function handleVoiceSummarize({ audioData, mimeType, tabTitle, tabUrl }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { error: "APIキーが未設定です。" };
  }

  // Save loading state and open summary tab with unique ID
  const summaryId = generateSummaryId();
  const storageKey = `summary_${summaryId}`;
  await chrome.storage.local.set({
    [storageKey]: { status: "loading", url: tabUrl },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`summary.html?id=${summaryId}`), active: false });

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: `以下のWebページについて、音声の指示に従って要約・回答してください。
音声が無言や短い場合は、ページの一般的な要約を返してください。

ページ情報:
- タイトル: ${tabTitle}
- URL: ${tabUrl}

出力は必ずHTMLで返してください（マークダウン不可）。
図解テンプレートは使わず、h2/h3/p/ul/li/strong/blockquote等のシンプルなHTMLで。`,
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: audioData,
              },
            },
          ],
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini APIエラー (${response.status})`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("応答なし");

    await chrome.storage.local.set({
      [storageKey]: {
        status: "done",
        url: tabUrl,
        title: tabTitle,
        summary: text,
        sourceType: "web",
      },
    });

    return { success: true };
  } catch (error) {
    await chrome.storage.local.set({
      [storageKey]: { status: "error", url: tabUrl, error: error.message },
    });
    return { error: error.message };
  }
}

// ---------- Digest Flow ----------

async function handleDigest() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { error: "APIキーが設定されていません。設定ページからGemini APIキーを入力してください。" };
  }

  // Get all tabs
  const tabs = await chrome.tabs.query({});

  // Filter out extension pages, new tabs, etc.
  const webTabs = tabs.filter((t) => {
    if (!t.url) return false;
    if (t.url.startsWith("chrome://")) return false;
    if (t.url.startsWith("chrome-extension://")) return false;
    if (t.url.startsWith("about:")) return false;
    if (t.url === "edge://newtab/") return false;
    return true;
  });

  if (webTabs.length === 0) {
    return { error: "分析対象のタブがありません。" };
  }

  // Get tab group info
  let groupInfo = {};
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      groupInfo[g.id] = { title: g.title, color: g.color };
    }
  } catch {
    // tabGroups API not available (e.g., older Chrome)
  }

  // Prepare tab data for classification
  const tabData = webTabs.map((t) => ({
    tabId: t.id,
    windowId: t.windowId,
    url: t.url,
    title: t.title || "",
    favIconUrl: t.favIconUrl || "",
    groupId: t.groupId || -1,
  }));

  // Batch classify with Gemini
  const classified = await batchClassify(apiKey, tabData);

  // Group by genre
  const genres = {};
  for (const item of classified) {
    const genre = item.genre || "その他";
    if (!genres[genre]) genres[genre] = [];
    genres[genre].push(item);
  }

  return {
    genres,
    tabCount: webTabs.length,
    groupInfo,
  };
}

async function batchClassify(apiKey, tabData) {
  const results = [];
  const batches = [];

  for (let i = 0; i < tabData.length; i += DIGEST_BATCH_SIZE) {
    batches.push(tabData.slice(i, i + DIGEST_BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      const classified = await classifyBatch(apiKey, batch);
      results.push(...classified);
    } catch (e) {
      // If API fails for a batch, return items with "その他" genre
      console.error("Batch classify failed:", e);
      for (const item of batch) {
        results.push({ ...item, genre: "その他", summary: "" });
      }
    }
  }

  return results;
}

async function classifyBatch(apiKey, batch) {
  const tabList = batch
    .map((t, i) => `${i}. ${t.title} | ${t.url}`)
    .join("\n");

  const prompt = `以下のブラウザタブ一覧をジャンル分類し、各タブの1行要約を付けてください。

## タブ一覧
${tabList}

## 出力形式
必ず以下のJSON配列形式で返してください。他のテキストは一切含めないでください。
[
  {"index": 0, "genre": "ジャンル名", "summary": "1行要約（30文字以内）"},
  ...
]

## ジャンル名の候補（これ以外でも適切なら使ってOK）
テクノロジー, ビジネス, デザイン, ニュース, エンタメ, 学習・教育, ライフスタイル, 開発ツール, AI・機械学習, マーケティング, ファイナンス, 健康, 科学, スポーツ, 旅行, 料理・グルメ, 音楽, ゲーム, SNS, セキュリティ

## ルール
- genreは日本語で統一
- summaryはタイトルとURLから推測できる範囲で簡潔に
- 同じサイトでもコンテンツが違えば別ジャンルに分類してOK
- ショッピングサイトの商品ページは「ショッピング」
- YouTubeはコンテンツ内容で判断（音楽動画→「音楽」、技術動画→「テクノロジー」等）
- JSONのみ返すこと（markdown code fenceも不要）`;

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 429) {
      throw new Error("APIの利用制限に達しました。少し待ってから再試行してください。");
    }
    throw new Error(`Gemini APIエラー (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini APIから有効な応答が得られませんでした");
  }

  // Parse JSON (handle potential markdown fences)
  const cleaned = text
    .replace(/^```json?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("APIの応答をJSONとして解析できませんでした");
  }

  // Merge classification results back into tab data
  return batch.map((tab, i) => {
    const classification = parsed.find((p) => p.index === i) || {};
    return {
      ...tab,
      genre: classification.genre || "その他",
      summary: classification.summary || "",
    };
  });
}

// ---------- Main Flow ----------

async function handleSummarize(url) {
  const summaryId = generateSummaryId();
  const storageKey = `summary_${summaryId}`;

  // Save loading state and open summary tab with ID
  await chrome.storage.local.set({
    [storageKey]: { status: "loading", url },
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`summary.html?id=${summaryId}`),
    active: false,
  });

  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      await chrome.storage.local.set({
        [storageKey]: {
          status: "error",
          url,
          error: "APIキーが設定されていません。設定ページからGemini APIキーを入力してください。",
        },
      });
      return;
    }

    const content = await fetchContent(url);
    const summary = await callGeminiApi(apiKey, content);

    await chrome.storage.local.set({
      [storageKey]: {
        status: "done",
        url,
        title: content.title,
        summary,
        sourceType: content.type,
      },
    });
  } catch (error) {
    console.error("Link Summarizer error:", error);
    await chrome.storage.local.set({
      [storageKey]: { status: "error", url, error: error.message },
    });
  }
}

function generateSummaryId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- API Key ----------

async function getApiKey() {
  const result = await chrome.storage.sync.get("geminiApiKey");
  return result.geminiApiKey || null;
}

// ---------- Content Fetching ----------

async function fetchContent(url) {
  if (isYouTubeUrl(url) && extractVideoId(url)) {
    return await fetchYouTubeContent(url);
  }
  return await fetchWebContent(url);
}

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.youtube.com" ||
      u.hostname === "youtube.com" ||
      u.hostname === "m.youtube.com" ||
      u.hostname === "youtu.be"
    );
  } catch {
    return false;
  }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1).split("/")[0];
    }
    // /watch?v=ID
    const vParam = u.searchParams.get("v");
    if (vParam) return vParam;
    // /shorts/ID, /live/ID, /embed/ID
    const pathMatch = u.pathname.match(/^\/(shorts|live|embed|v)\/([^/?]+)/);
    if (pathMatch) return pathMatch[2];
    return null;
  } catch {
    return null;
  }
}

async function fetchYouTubeContent(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error("YouTube動画IDを取得できませんでした");
  }

  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetch(pageUrl);
  if (!response.ok) {
    throw new Error(`YouTubeページの取得に失敗しました (${response.status})`);
  }

  const html = await response.text();

  // Extract player response from HTML
  const playerResponse = extractPlayerResponse(html);
  const title = playerResponse?.videoDetails?.title || "タイトル不明";
  const description =
    playerResponse?.videoDetails?.shortDescription || "";

  // Try to get captions
  let captionText = "";
  try {
    captionText = await fetchYouTubeCaptions(playerResponse);
  } catch (e) {
    console.warn("Caption fetch failed, using description only:", e);
  }

  const textContent = captionText
    ? `タイトル: ${title}\n\n字幕:\n${captionText}`
    : `タイトル: ${title}\n\n説明:\n${description}`;

  return {
    type: "youtube",
    title,
    text: textContent.slice(0, MAX_TEXT_LENGTH),
  };
}

function extractPlayerResponse(html) {
  const patterns = [
    /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/,
    /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function fetchYouTubeCaptions(playerResponse) {
  if (!playerResponse) {
    throw new Error("プレイヤーレスポンスが見つかりません");
  }

  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) {
    throw new Error("字幕トラックが見つかりません");
  }

  // Prefer Japanese, then English, then first available
  const jaTrack = captionTracks.find((t) => t.languageCode === "ja");
  const enTrack = captionTracks.find((t) => t.languageCode === "en");
  const track = jaTrack || enTrack || captionTracks[0];

  const captionUrl = track.baseUrl;
  const response = await fetch(captionUrl);
  if (!response.ok) {
    throw new Error(`字幕の取得に失敗しました (${response.status})`);
  }

  const xml = await response.text();
  return parseCaptionXml(xml);
}

function parseCaptionXml(xml) {
  // Extract text content from <text> elements
  const textSegments = [];
  const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const decoded = match[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, " ")
      .trim();
    if (decoded) {
      textSegments.push(decoded);
    }
  }
  return textSegments.join(" ");
}

async function fetchWebContent(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ページの取得に失敗しました (${response.status})`);
  }

  const html = await response.text();

  // Extract main content using regex (Service Worker has no DOM APIs)
  const { title, textContent } = extractMainContent(html);

  return {
    type: "web",
    title: title || extractTitleFromHtml(html) || url,
    text: textContent.slice(0, MAX_TEXT_LENGTH),
  };
}

function extractMainContent(html) {
  // Service Worker has no DOM APIs, so use regex-based extraction
  const title = extractTitleFromHtml(html) || "";

  // Remove script, style, nav, header, footer tags and their contents
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  // Try to extract <article> or <main> content first
  const articleMatch = cleaned.match(/<(?:article|main)[\s\S]*?>([\s\S]*?)<\/(?:article|main)>/i);
  if (articleMatch) {
    cleaned = articleMatch[1];
  }

  // Strip all remaining HTML tags
  const textContent = cleaned
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return { title, textContent };
}

function extractTitleFromHtml(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : null;
}

// ---------- Gemini API ----------

async function callGeminiApi(apiKey, content) {
  const prompt = buildPrompt(content);

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 16384,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 400) {
      throw new Error("APIリクエストが不正です。APIキーを確認してください。");
    }
    if (response.status === 403) {
      throw new Error("APIキーが無効か、権限がありません。");
    }
    if (response.status === 429) {
      let detail = "";
      try {
        const err = JSON.parse(errorBody);
        detail = err?.error?.message || errorBody;
      } catch {
        detail = errorBody;
      }
      throw new Error(`APIの利用制限に達しました。\n詳細: ${detail}`);
    }
    throw new Error(`Gemini APIエラー (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini APIから有効な応答が得られませんでした");
  }
  return text;
}

function buildPrompt(content) {
  const typeLabel =
    content.type === "youtube" ? "YouTube動画" : "ウェブ記事";

  return `以下の${typeLabel}の内容を日本語で要約してください。
出力は必ずHTMLで返してください。マークダウンではなくHTMLタグを使ってください。
要所要所に図解を挿入して、内容を直感的にわかりやすくしてください。

## 出力構成

1. <h2>サマリー</h2> — 全体の概要を3〜5文で。
2. <h2>主要ポイント</h2> — 重要ポイントを3〜5つ。ここに1つ図解を入れる。
3. <h2>詳細</h2> — セクションごとに詳しく。各セクション間に適切な図解を入れる。
   - 具体的な情報、数値、事例を含める
   - 議論や主張の根拠も記載する
   - 重要な引用や発言があれば含める

## 図解のHTMLテンプレート（必ずこのclass名を使うこと）

### フローチャート（プロセスや流れの説明に使う）
<div class="diagram-flow">
  <div class="flow-step">ステップ1<div class="flow-sub">補足</div></div>
  <div class="flow-arrow">→</div>
  <div class="flow-step highlight">ステップ2<div class="flow-sub">補足</div></div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">ステップ3</div>
</div>

### 比較カード（複数の要素を比較する時に使う）
<div class="diagram-compare">
  <div class="compare-card">
    <div class="compare-title">項目A</div>
    <div class="compare-body"><ul><li>特徴1</li><li>特徴2</li></ul></div>
  </div>
  <div class="compare-card">
    <div class="compare-title">項目B</div>
    <div class="compare-body"><ul><li>特徴1</li><li>特徴2</li></ul></div>
  </div>
</div>

### ステップ図（手順や段階の説明に使う）
<div class="diagram-steps">
  <div class="step"><div class="step-number">1</div><div class="step-line"></div><div class="step-content"><div class="step-title">タイトル</div><div class="step-desc">説明</div></div></div>
  <div class="step"><div class="step-number">2</div><div class="step-line"></div><div class="step-content"><div class="step-title">タイトル</div><div class="step-desc">説明</div></div></div>
</div>

### 数値・統計カード（重要な数値やメトリクスに使う）
<div class="diagram-stats">
  <div class="stat-card"><div class="stat-value">数値</div><div class="stat-label">ラベル</div></div>
  <div class="stat-card"><div class="stat-value">数値</div><div class="stat-label">ラベル</div></div>
</div>

### 情報ボックス（重要な注意点やポイントに使う。色: info-blue, info-green, info-yellow, info-red）
<div class="diagram-info info-blue"><div class="info-title">ポイント</div>説明テキスト</div>

### テーブル（データの比較・整理に使う）
<table class="diagram-table"><thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td>値1</td><td>値2</td></tr></tbody></table>

### タイムライン（時系列の説明に使う）
<div class="diagram-timeline">
  <div class="tl-item"><div class="tl-time">時期</div><div class="tl-title">イベント</div><div class="tl-desc">説明</div></div>
</div>

### メリット・デメリット
<div class="diagram-proscons">
  <div class="pros"><div class="pc-title">メリット</div><ul><li>項目</li></ul></div>
  <div class="cons"><div class="pc-title">デメリット</div><ul><li>項目</li></ul></div>
</div>

### パーセンテージバー（割合の視覚化に使う）
<div class="diagram-bars">
  <div class="bar-item"><div class="bar-label"><span>項目</span><span>75%</span></div><div class="bar-track"><div class="bar-fill" style="width:75%"></div></div></div>
</div>

### 関係図（中心と関連要素の関係に使う）
<div class="diagram-hub">
  <div class="hub-node">要素1</div>
  <div class="hub-node">要素2</div>
  <div class="hub-center">中心</div>
  <div class="hub-node">要素3</div>
  <div class="hub-node">要素4</div>
</div>

## 図解の使い方ルール
- 内容に応じて最適な図解タイプを選ぶ（最低3つ、できれば5つ以上の図解を使う）
- テキストだけの説明が続かないよう、要所に図解を挟む
- 上記のclass名を正確に使うこと（CSSが適用される）
- <script>タグは絶対に使わないこと
- 図解以外の部分は通常のHTMLタグ（h2, h3, p, ul, li, strong, blockquote等）を使う

---

${content.text}`;
}

