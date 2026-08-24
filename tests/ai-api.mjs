import assert from "node:assert/strict";
import { onRequestGet, onRequestPost } from "../functions/api/ai.js";

const originalFetch = globalThis.fetch;
let sentPrompt = "";
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  sentPrompt = request.messages[1].content;
  assert.equal(request.thinking, false, "text AI reasoning should be disabled for fast structured responses");
  // 模拟部分 OpenAI 兼容服务在 JSON 后追加一句说明的真实情况。
  return Response.json({ choices: [{ message: { reasoning_content: [{ type: "text", value: '{"lyrics":"[主歌 A]\\n晨光照进我的书页\\n我把难题慢慢拆开\\n每一步都有新的答案\\n[副歌]\\n今天我会勇敢发光\\n把小小勇气唱得响亮","seed":42}' }, { type: "text", value: "\\n创作完成。" }] } }] });
};

const plan = {
  schemaVersion: 2,
  planId: "plan_test",
  bpm: 114,
  key: "D Major",
  sections: { verse: [{ notes: Array.from({ length: 120 }, () => ({ pitch: 60, startBeat: 0, durationBeats: 1 })) }] },
};
const context = {
  env: { AI_PROVIDER: "agnes", AGNES_API_KEY: "test-key", AGNES_BASE_URL: "https://agnes.test/v1", AGNES_MODEL: "agnes-test" },
  request: new Request("http://127.0.0.1:8788/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788" },
    body: JSON.stringify({ task: "lyrics", payload: { title: "测试歌", style: "pop", topic: "完成作业", seed: 42, melodyGuide: { name: "清晨跳拍", bpm: 114, key: "D Major", slots: { verse: [7, 8, 7, 8], chorus: [9, 9, 8, 8], bridge: [7, 7], outro: [9, 9, 8, 8] }, compositionPlan: plan } } }),
  }),
};

try {
  const response = await onRequestPost(context);
  const result = await response.json();
  assert.equal(result.meta.mode, "remote", "valid JSON before trailing text must not fall back to templates");
  assert.equal(result.data.seed, 42);
  assert.match(result.data.lyrics, /今天我会勇敢发光/);
  assert.doesNotMatch(sentPrompt, /"notes"/, "note arrays must not be duplicated into the text-AI prompt");
  assert.match(sentPrompt, /"slots"/, "the lyric prompt must preserve syllable-slot constraints");
} finally {
  globalThis.fetch = originalFetch;
}

let siliconflowRequest;
globalThis.fetch = async (_url, options) => {
  siliconflowRequest = JSON.parse(options.body);
  return Response.json({ choices: [{ message: { content: '{"keyword":"已出发","copy":"继续保持。"}' } }] });
};
try {
  const siliconflowContext = {
    env: { AI_PROVIDER: "siliconflow", AI_API_KEY: "test-key", AI_BASE_URL: "https://siliconflow.test/v1", AI_MODEL: "Qwen/Qwen2.5-7B-Instruct" },
    request: new Request("http://127.0.0.1:8788/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788" },
      body: JSON.stringify({ task: "summary", payload: { focus: 25, sessions: 1, mistakes: 0 } }),
    }),
  };
  const response = await onRequestPost(siliconflowContext);
  const result = await response.json();
  assert.equal(result.meta.mode, "remote");
  assert.equal("thinking" in siliconflowRequest, false, "SiliconFlow rejects the Agnes-only thinking flag");
  assert.deepEqual(siliconflowRequest.response_format, { type: "json_object" }, "SiliconFlow structured tasks should use JSON mode");
  assert.equal(siliconflowRequest.enable_thinking, false, "SiliconFlow should disable reasoning for short structured tasks");
  assert.ok(siliconflowRequest.max_tokens <= 320, "short summary tasks should not reserve a long lyric-sized response");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS text AI JSON recovery and compact lyric prompt");

const incompleteStatus = await onRequestGet({ env: { AI_API_KEY: "test-key", AI_MODEL: "test-model" }, request: new Request("http://127.0.0.1:8788/api/ai") }).json();
assert.equal(incompleteStatus.meta.mode, "mock", "an API key without a base URL must not be reported as connected");
assert.equal(incompleteStatus.meta.reason, "incomplete-config");

const ambientResult = await (await onRequestPost({
  env: { AI_MODE: "mock" },
  request: new Request("http://127.0.0.1:8788/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "ambient", payload: { focus: 25, sessions: 1, mistakes: 0, streak: 3 } }) }),
})).json();
assert.equal(ambientResult.ok, true, "daily inspiration mock contract failed");
assert.ok(ambientResult.data.message.length >= 8 && ambientResult.data.message.length <= 80, "daily inspiration is not a concise sentence");
