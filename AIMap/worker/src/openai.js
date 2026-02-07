/**
 * Minimal OpenAI chat.completions client.
 *
 * Notes:
 * - 12s timeout
 * - 1 retry max (caller controls)
 * - JSON-only response requested via response_format
 */

function defaultBaseURL(env) {
  return env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
}

function model(env) {
  return env.OPENAI_MODEL ?? "gpt-4.1-mini";
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

export async function callNearbyLLM({ env, systemPrompt, payload, timeoutMs, retries }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchWithRetry(
      `${defaultBaseURL(env)}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model(env),
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(payload) },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      },
      retries,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned empty content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function callPlaceLLM({ env, systemPrompt, payload, timeoutMs, retries }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchWithRetry(
      `${defaultBaseURL(env)}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model(env),
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(payload) },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      },
      retries,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned empty content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}
