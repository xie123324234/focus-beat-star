const TASKS = new Set(["lyrics", "plan", "mistake", "quiz", "weekly", "summary"]);
// 旋律信息会随歌词请求一并提交，不能用过小的 12 KB 上限拦截正常请求。
const MAX_PAYLOAD_CHARS = 32_000;

function safeText(value, limit = 1200) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, limit);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) { result ^= char.codePointAt(0); result = Math.imul(result, 16777619); }
  return result >>> 0;
}

function randomFrom(seed) {
  let value = seed >>> 0;
  return () => { value += 0x6d2b79f5; let next = value; next = Math.imul(next ^ next >>> 15, next | 1); next ^= next + Math.imul(next ^ next >>> 7, next | 61); return ((next ^ next >>> 14) >>> 0) / 4294967296; };
}

function pick(random, list) { return list[Math.floor(random() * list.length)]; }

function mock(task, payload) {
  const seed = Number(payload.seed) || Date.now();
  const random = randomFrom(hash(`${task}|${JSON.stringify(payload)}|${seed}`));
  if (task === "lyrics") {
    const title = safeText(payload.title, 32) || "今天我会发光";
    const topic = safeText(payload.topic, 100) || "完成今天的小目标";
    const starts = ["晨光落在刚翻开的书页", "窗外的风替我数着节拍", "笔尖轻轻敲醒新的期待", "深呼吸让心慢慢安静下来"];
    const turns = ["看不懂就把问题拆开", "走慢一点也仍然在向前", "每个错误都藏着新线索", "再试一次答案就会出现"];
    const hooks = ["让今天的努力被旋律听见", "把小小勇气唱到更远", "我的脚步正把未知改变", "这一刻我为自己加冕"];
    const lyrics = ["[主歌 A]", pick(random, starts), `今天我要完成：${topic}`, pick(random, turns), pick(random, turns), "", "[副歌]", `${title}，跟着心跳出发`, ...hooks.sort(() => random() - .5).slice(0, 3), "", "[主歌 B]", pick(random, starts), pick(random, turns), "难题不会定义我的明天", "我会带着自己的节奏向前", "", "[桥段]", "把弯路也写成成长的诗篇", "原来坚持本身就是答案", "", "[终章副歌]", `${title}，现在就出发`, ...hooks.slice(0, 2), `${title}，我正在慢慢发光`].join("\n");
    return { lyrics, seed, title, style: payload.style || "pop", versionLabel: `创作版本 ${String(seed).slice(-4)}` };
  }
  if (task === "plan") {
    const config = { easy: [15, 5, 2], standard: [25, 5, 2], deep: [40, 10, 2] }[payload.preset] || [25, 5, 2];
    const subject = safeText(payload.subject, 80) || "今天最重要的学习任务";
    return { focusMin: config[0], breakMin: config[1], roundCount: config[2], segments: [`读清要求，开始${subject}`, `检查易错点，完成${subject}`], note: "每一段只处理一个明确目标，先完成再完善。" };
  }
  if (task === "mistake") return { analysis: "关键问题可能是没有把条件、方法和结果分开。先圈出题目中的关键词，再逐步检查推理或计算。", nextStep: "遮住原答案，用“已知—方法—结果”三步重新完成一次，并解释为什么这样做。" };
  if (task === "quiz") {
    const subject = safeText(payload.subject, 12) || "数学";
    const libraries = {
      数学: [["一本书有 96 页，每天读 12 页，几天读完？", "8", "用总页数除以每天阅读页数。", "96 ÷ 12 = 8（天）。"], ["长方形长8厘米、宽5厘米，面积是多少？", "40", "面积等于长乘宽。", "8 × 5 = 40（平方厘米）。"], ["72比一个数多18，这个数是多少？", "54", "用72减去18。", "72 - 18 = 54。"]],
      语文: [["“小鸟在枝头唱歌”使用了什么修辞手法？", "拟人", "“唱歌”原本是谁的动作？", "把小鸟当作人来写，使用了拟人。"], ["“安静”的反义词是什么？", "热闹", "想一想人多声音多的场景。", "安静与热闹意思相反。"]],
      英语: [["补全句子：She ___ to school every day. (go)", "goes", "一般现在时的第三人称单数。", "主语 She 后 go 变为 goes。"], ["There ___ two books on the desk. (is / are)", "are", "two books 是复数。", "复数主语后使用 are。"]],
      科学: [["植物光合作用通常需要光、水和哪一种气体？", "二氧化碳", "这种气体由人和动物呼出。", "植物吸收二氧化碳进行光合作用。"], ["地球自转一周大约需要多长时间？", "24小时", "想一想一天的长度。", "地球自转一周大约是24小时。"]],
    };
    const bank = pick(random, libraries[subject] || libraries.数学);
    return { id: `quiz_${hash(`${subject}|${bank[0]}|${seed}`)}`, question: bank[0], answer: bank[1], answers: [bank[1]], hint: bank[2], explanation: bank[3], level: "基础巩固" };
  }
  if (task === "weekly") {
    const tasks = ["拆解目标，完成第一小步", "推进主任务，标出卡点", "回顾并做一次自测", "攻克一个卡点", "完成主任务并检查", "整理错题并讲解", "轻量复盘，准备下周"];
    return { goal: safeText(payload.goal, 100) || "巩固本周知识", days: tasks.map((item, index) => ({ day: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][index], task: item })) };
  }
  const focus = Number(payload.focus) || 0; const sessions = Number(payload.sessions) || 0; const mistakes = Number(payload.mistakes) || 0;
  return { keyword: sessions ? "已经出发" : "等待第一拍", copy: sessions ? `今天完成了 ${sessions} 段专注，共投入 ${focus} 分钟，并记录了 ${mistakes} 道错题。明天先重做一道今天的错题，再进入新任务。` : "今天先从一个 15 分钟的小任务开始。完成第一段之后，学习的节奏就会慢慢建立起来。" };
}

function promptFor(task, payload) {
  const common = "你是面向6-12岁学生的学习伙伴。内容必须积极、具体、安全，不说教。只返回合法JSON，不要Markdown代码块。";
  const prompts = {
    lyrics: `根据歌名、音乐风格和主题写一首全新的中文儿童成长歌曲。需要[主歌 A]、[副歌]、[主歌 B]、[桥段]、[终章副歌]，每段4行左右，每行7-16个汉字，副歌要有记忆点且与上次不同。返回 {"lyrics":"...","seed":${Number(payload.seed) || Date.now()}}。输入：${JSON.stringify(payload)}`,
    plan: `把学习任务拆成1-6段可执行计划。返回 {"focusMin":整数,"breakMin":整数,"roundCount":整数,"segments":[字符串],"note":"一句建议"}。输入：${JSON.stringify(payload)}`,
    mistake: `分析错题的可能错因和下一步，不直接贬低学生。返回 {"analysis":"80字内","nextStep":"80字内"}。输入：${JSON.stringify(payload)}`,
    quiz: `按学科和薄弱点生成一道小学生可独立作答的新题，不得重复excludeQuestions中的题目。答案要允许合理的同义表达。返回 {"id":"含随机性的短ID","question":"题目","answer":"标准短答案","answers":["可接受答案1","可接受答案2"],"hint":"只提示方法，不泄露答案","explanation":"解析","level":"难度"}。输入：${JSON.stringify(payload)}`,
    weekly: `把目标安排成周一到周日每天一个小任务。返回 {"goal":"目标","days":[{"day":"周一","task":"任务"}...共7项]}。输入：${JSON.stringify(payload)}`,
    summary: `根据今日数据写鼓励但不夸张的学习总结，并给出明天第一步。返回 {"keyword":"四字内关键词","copy":"120字内"}。输入：${JSON.stringify(payload)}`,
  };
  return `${common}\n${prompts[task]}`;
}

function parseModelJson(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(raw); } catch (_) {
    const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("模型没有返回有效 JSON");
  }
}

function isValid(task, data) {
  if (!data || typeof data !== "object") return false;
  if (task === "lyrics") return typeof data.lyrics === "string" && data.lyrics.trim().length >= 40;
  if (task === "plan") return Number.isFinite(Number(data.focusMin)) && Number.isFinite(Number(data.breakMin)) && Number.isFinite(Number(data.roundCount)) && Array.isArray(data.segments);
  if (task === "mistake") return typeof data.analysis === "string" && typeof data.nextStep === "string";
  if (task === "quiz") return ["id", "question", "answer", "hint", "explanation"].every(key => typeof data[key] === "string" && data[key].trim()) && (!data.answers || Array.isArray(data.answers));
  if (task === "weekly") return typeof data.goal === "string" && Array.isArray(data.days) && data.days.length === 7 && data.days.every(item => item && typeof item.day === "string" && typeof item.task === "string");
  if (task === "summary") return typeof data.keyword === "string" && typeof data.copy === "string";
  return false;
}

async function callMimo(task, payload, env) {
  const useAgnes = env.AI_PROVIDER === "agnes" || Boolean(env.AGNES_API_KEY && !env.MIMO_API_KEY && !env.AI_API_KEY);
  const base = String(env.AI_BASE_URL || (useAgnes ? env.AGNES_BASE_URL : env.MIMO_BASE_URL) || "https://api.xiaomimimo.com/v1").replace(/\/$/, "");
  const apiKey = env.AI_API_KEY || env.MIMO_API_KEY || env.AGNES_API_KEY;
  const model = env.AI_MODEL || (useAgnes ? env.AGNES_MODEL : env.MIMO_MODEL) || "mimo-v2.5";
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: "POST", signal: controller.signal,
      headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: "你只输出符合要求的JSON。" }, { role: "user", content: promptFor(task, payload) }], temperature: task === "lyrics" ? .95 : .55, max_tokens: task === "lyrics" ? 1800 : 900 }),
    });
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`MiMo API ${response.status}`);
  const result = await response.json();
  return parseModelJson(result.choices?.[0]?.message?.content);
}

export async function onRequestPost(context) {
  const origin = context.request.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== new URL(context.request.url).host) return json({ ok: false, error: "不允许跨站调用" }, 403); }
    catch (_) { return json({ ok: false, error: "来源地址无效" }, 403); }
  }
  let body;
  try { body = await context.request.json(); } catch (_) { return json({ ok: false, error: "请求必须是 JSON" }, 400); }
  const task = safeText(body?.task, 20); const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  if (!TASKS.has(task)) return json({ ok: false, error: "不支持的 AI 任务" }, 400);
  if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) return json({ ok: false, error: `输入内容过长（上限 ${MAX_PAYLOAD_CHARS} 字符）` }, 413);
  const apiKey = context.env.AI_API_KEY || context.env.MIMO_API_KEY || context.env.AGNES_API_KEY;
  const provider = context.env.AI_PROVIDER || (context.env.AGNES_API_KEY && !context.env.MIMO_API_KEY ? "agnes" : "mimo");
  const model = context.env.AI_MODEL || (provider === "agnes" ? context.env.AGNES_MODEL : context.env.MIMO_MODEL) || "mimo-v2.5";
  if (!apiKey || context.env.AI_MODE === "mock") return json({ ok: true, data: mock(task, payload), meta: { mode: "mock" } });
  try {
    const data = await callMimo(task, payload, context.env);
    if (!isValid(task, data)) throw new Error("MiMo 返回的数据结构不符合要求");
    return json({ ok: true, data, meta: { mode: "remote", provider, model } });
  } catch (error) {
    console.error("MiMo request failed", error?.message);
    return json({ ok: true, data: mock(task, payload), meta: { mode: "mock", degraded: true } });
  }
}

export function onRequestGet(context) {
  const apiKey = context.env.AI_API_KEY || context.env.MIMO_API_KEY || context.env.AGNES_API_KEY;
  const provider = context.env.AI_PROVIDER || (context.env.AGNES_API_KEY && !context.env.MIMO_API_KEY ? "agnes" : "mimo");
  const model = context.env.AI_MODEL || (provider === "agnes" ? context.env.AGNES_MODEL : context.env.MIMO_MODEL) || "mimo-v2.5";
  return json({ ok: true, service: "Focus Beat AI gateway", tasks: [...TASKS], meta: apiKey && context.env.AI_MODE !== "mock" ? { mode: "remote", provider, model } : { mode: "mock" } });
}
