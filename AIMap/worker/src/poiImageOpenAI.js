import { safeLog } from "./utils.js";

const SYSTEM_PROMPT = `You are an image filter for a map app.
You will receive ONE low-quality thumbnail image (small JPEG).
Classify it for use as a POI card photo.

Rules:
- Output VALID JSON ONLY: {"verdict":"SAFE|UNSAFE|REJECTED","reason":"...","confidence":0..1}
- SAFE: a real photo that plausibly represents a place (exterior/interior/food/product/venue context) with no unsafe content.
- REJECTED: not useful as a POI image (logos, icons, text-heavy banners, stock graphics, maps, UI screenshots, unrelated imagery).
- UNSAFE: any nudity/sexual content, violence/gore, hate/extremism, or otherwise unsafe-for-work content.
- Be conservative: if unsure, prefer REJECTED over SAFE.`;

function defaultBaseURL(env) {
  return env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
}

function imageModel(env) {
  return env.OPENAI_IMAGE_MODEL ?? env.OPENAI_MODEL ?? "gpt-4o-mini";
}

async function fetchWithRetry(input, init, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastError = err;
      if (attempt >= retries) throw err;
    }
  }
  throw lastError;
}

export async function callPoiImageFilterLLM({ env, poi_id, source_url, thumbBase64, timeoutMs, retries }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${defaultBaseURL(env)}/chat/completions`;

  try {
    safeLog(env, "[openai] poiimage filter request", {
      url,
      model: imageModel(env),
      timeout_ms: timeoutMs,
      retries,
      poi_id,
    });

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: imageModel(env),
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `POI id: ${poi_id}\nImage source URL: ${source_url}\nReturn JSON verdict.`,
                },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${thumbBase64}` },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      },
      retries,
    );

    if (!response.ok) {
      const text = await response.text();
      safeLog(env, "[openai] poiimage filter error", { status: response.status, body: text.slice(0, 500) });
      throw new Error(`OpenAI error ${response.status}: ${text}`);
    }

    const data = await response.json();
    safeLog(env, "[openai] poiimage filter ok", { usage: data?.usage });
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned empty content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

