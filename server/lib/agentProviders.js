// Agent Server brains: free-tier providers, called over plain HTTPS with zero
// dependencies. Two shapes cover everything he asked for:
//   kind 'gemini' -> Google Generative Language API (Gemini free tier)
//   kind 'openai' -> any OpenAI-compatible /chat/completions endpoint
//                    (NVIDIA NIM, Groq, OpenCode Zen, OpenRouter free models,
//                     a local llama-server, whatever comes next)
// Every preset ships with honest notes about its free tier. Endpoints and
// models stay editable in the session config, so a dead preset never traps
// the user.
import { getKey } from './agentStore.js';

export const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Gemini',
    kind: 'gemini',
    model: 'gemini-2.0-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    freeNote:
      'Free tier from Google AI Studio. Get a key at aistudio.google.com/apikey and paste it here.',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai',
    model: 'meta/llama-3.1-8b-instruct',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    freeNote:
      'Free credits from build.nvidia.com. Strong models, but responses can be slow at peak times.',
    keyUrl: 'https://build.nvidia.com',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    model: 'llama-3.3-70b-versatile',
    endpoint: 'https://api.groq.com/openai/v1',
    freeNote:
      'Free tier at console.groq.com — usually the fastest responses of the bunch.',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'zen',
    label: 'OpenCode Zen',
    kind: 'openai',
    model: 'qwen3-coder',
    endpoint: 'https://opencode.ai/zen/v1',
    freeNote:
      'OpenCode Zen free tiers for coding models. If the endpoint changed, edit it — everything here stays editable.',
    keyUrl: 'https://opencode.ai/zen',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    model: '',
    endpoint: '',
    freeNote:
      'Any OpenAI-compatible URL + key + model name: OpenRouter free models, LM Studio, llama-server, whatever you use. The model must support function calling (tool use) for the agent to act on files — hosted models do; small local models often cannot and will only chat.',
    keyUrl: null,
  },
];

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** Everything the UI may show — plus whether a key is configured. */
export function providerSummaries() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    model: p.model,
    endpoint: p.endpoint,
    freeNote: p.freeNote,
    keyUrl: p.keyUrl,
    hasKey: getKey(p.id) !== null,
  }));
}

/** Effective endpoint/model/URL for a session (per-session overrides win). */
export function resolveProvider(session) {
  const preset = providerById(session.providerId);
  if (!preset) return null;
  const endpoint = (session.endpoint || preset.endpoint || '').replace(/\/+$/, '');
  const model = session.model || preset.model;
  if (!endpoint) return { preset, error: 'No endpoint set for this provider.' };
  if (!model) return { preset, error: 'No model set for this provider.' };
  const key = getKey(preset.id);
  if (!key) return { preset, error: `No API key saved for ${preset.label}.` };
  return { preset, endpoint, model, key };
}

// --- provider calls (fetch injected for tests) ---

const TIMEOUT_MS = 120 * 1000;

async function callGemini({ endpoint, model, key }, systemText, contents, tools, fetchImpl) {
  const url = `${endpoint}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { temperature: 0.4 },
  };
  if (tools) body.tools = [{ functionDeclarations: tools }];

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} from Gemini: ${text.slice(0, 300)}`);
  }
  const j = await res.json();
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  const calls = parts
    .filter((p) => p.functionCall && typeof p.functionCall.name === 'string')
    .map((p) => ({
      name: p.functionCall.name,
      args: p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {},
    }));
  if (j?.promptFeedback?.blockReason) {
    throw new Error(`Gemini refused this request (${j.promptFeedback.blockReason}).`);
  }
  return { text, calls };
}

async function callOpenAI({ endpoint, model, key }, systemText, messages, tools, fetchImpl) {
  const body = {
    model,
    messages: [{ role: 'system', content: systemText }, ...messages],
    temperature: 0.4,
  };
  if (tools) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const res = await fetchImpl(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} from ${endpoint}: ${text.slice(0, 300)}`);
  }
  const j = await res.json();
  const msg = j?.choices?.[0]?.message || {};
  const calls = (msg.tool_calls || [])
    .filter((c) => c?.function?.name)
    .map((c) => {
      let args = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        args = {};
      }
      return { name: c.function.name, args, id: c.id || null };
    });
  return { text: typeof msg.content === 'string' ? msg.content : '', calls };
}

/**
 * One model call. `contents`/`messages` are already provider-shaped (the
 * loop builds them); `tools` is provider-neutral here and shaped inside.
 */
export function callBrain(session, systemText, contents, messages, tools, fetchImpl) {
  const brain = resolveProvider(session);
  if (brain.error) return Promise.reject(new Error(brain.error));
  const f = fetchImpl || globalThis.fetch;
  if (brain.preset.kind === 'gemini') {
    return callGemini(brain, systemText, contents, tools, f);
  }
  return callOpenAI(brain, systemText, messages, tools, f);
}
