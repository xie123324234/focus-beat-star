const TASKS = new Set(["lyrics", "plan", "mistake", "quiz", "weekly", "summary", "ambient"]);
// 歌词请求会携带结构化曲调计划（音符、乐句和音节位），通常超过 12 KB。
// 12 KB 会让正常的“按当前曲调生成/润色歌词”被误判为超长请求并直接回退本地模板。
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

function isLocalRequest(request) { return ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname); }
function clientIdentity(request) { return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || (isLocalRequest(request) ? "local-development" : "unknown"); }
async function readCounter(bucket, key) {
  const object = await bucket?.get(key); if (!object) return 0;
  try { return Number(JSON.parse(await object.text())?.count) || 0; } catch (_) { return 0; }
}
async function consumeAiQuota(context) {
  const bucket = context.env.MUSIC_AUDIO || context.env.SONG_AUDIO; if (!bucket) return;
  const now = new Date(); const identity = clientIdentity(context.request); const hour = now.toISOString().slice(0, 13); const day = now.toISOString().slice(0, 10);
  const hourlyLimit = Math.max(1, Math.min(500, Number(context.env.AI_HOURLY_LIMIT) || 60)); const dailyLimit = Math.max(1, Math.min(5000, Number(context.env.AI_DAILY_LIMIT) || 500));
  const hourlyKey = `ai/rate/${hash(`${identity}|${hour}`).toString(36)}.json`; const dailyKey = `ai/quota/${hash(`global|${day}`).toString(36)}.json`;
  const [hourly, daily] = await Promise.all([readCounter(bucket, hourlyKey), readCounter(bucket, dailyKey)]);
  if (hourly >= hourlyLimit) throw new Error(`文本 AI 本小时调用额度已达上限（${hourlyLimit} 次）`);
  if (daily >= dailyLimit) throw new Error(`文本 AI 今日全站调用额度已达上限（${dailyLimit} 次）`);
  const metadata = { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } }; const updatedAt = new Date().toISOString();
  await Promise.all([bucket.put(hourlyKey, JSON.stringify({ count: hourly + 1, updatedAt }), metadata), bucket.put(dailyKey, JSON.stringify({ count: daily + 1, updatedAt }), metadata)]);
}

function randomFrom(seed) {
  let value = seed >>> 0;
  return () => { value += 0x6d2b79f5; let next = value; next = Math.imul(next ^ next >>> 15, next | 1); next ^= next + Math.imul(next ^ next >>> 7, next | 61); return ((next ^ next >>> 14) >>> 0) / 4294967296; };
}

function pick(random, list) { return list[Math.floor(random() * list.length)]; }

function meterGuide(payload) {
  const source = payload?.melodyGuide && typeof payload.melodyGuide === "object" ? payload.melodyGuide : {};
  const slots = {};
  for (const section of ["verse", "chorus", "bridge", "outro"]) {
    const values = Array.isArray(source?.slots?.[section]) ? source.slots[section].map(Number).filter(value => Number.isFinite(value) && value >= 4 && value <= 16).slice(0, 6) : [];
    slots[section] = values.length ? values : [8, 8, 8, 8];
  }
  return { ...source, name: safeText(source.name, 24) || "结构化旋律", bpm: Math.max(60, Math.min(180, Number(source.bpm) || 108)), key: safeText(source.key, 20) || "C Major", slots, compositionPlan: source.compositionPlan || null };
}
function lyricSection(line) { const value = String(line); if (value.includes("副歌")) return value.includes("终章") ? "outro" : "chorus"; if (value.includes("桥")) return "bridge"; if (value.includes("终章") || value.includes("尾")) return "outro"; return "verse"; }
function isHeader(line) { return /^\s*[\[【].+[\]】]\s*$/.test(String(line)); }
function singableLength(line) { return Array.from(String(line).replace(/[\s，。！？、；：,.!?~～—-]/g, "")).length; }
function textLength(value) { return Array.from(String(value || "").replace(/[\s，。！？、；：,.!?~～—-]/g, "")).length; }
const PAD_PHRASES = {
  1: ["呀", "吧", "啦", "呢"],
  2: ["向前", "发光", "起来", "更亮"],
  3: ["一起吧", "向前吧", "发光吧", "更勇敢"],
  4: ["一起向前", "勇敢发光", "慢慢成长", "继续出发"],
};
function calibratedLine(original, target, random) {
  let chars = Array.from(String(original || "").replace(/[\s，。！？、；：,.!?~～—-]/g, ""));
  const removableWords = ["悄悄", "轻轻", "慢慢", "真的", "一直", "非常"];
  for (const word of removableWords) {
    if (chars.length <= target) break;
    const value = chars.join(""); const index = value.indexOf(word);
    if (index >= 0 && chars.length - Array.from(word).length >= target) chars.splice(index, Array.from(word).length);
  }
  const removableChars = ["的", "了", "着", "正", "都", "也", "就", "在", "很", "又", "还"];
  for (const char of removableChars) {
    while (chars.length > target && chars.includes(char)) chars.splice(chars.lastIndexOf(char), 1);
  }
  if (chars.length > target) chars = chars.slice(0, target);
  while (chars.length < target) {
    const need = target - chars.length; const size = Math.min(4, need); const options = PAD_PHRASES[size];
    chars.push(...Array.from(options ? pick(random, options) : "向前发光".slice(0, size)));
  }
  return chars.join("");
}
function phraseTarget(guide, section, index) { return Number(guide?.slots?.[section]?.[Math.min(index, (guide?.slots?.[section]?.length || 1) - 1)]) || 8; }
function meterizeLyrics(lyrics, payload) {
  const guide = meterGuide(payload); let section = "verse"; const positions = { verse: 0, chorus: 0, bridge: 0, outro: 0 }; const random = randomFrom(hash(`${payload.seed}|fallback-fit`));
  return String(lyrics || "").split(/\r?\n/).map(line => {
    const text = line.trim(); if (!text) return ""; if (isHeader(text)) { section = lyricSection(text); positions[section] = 0; return text; }
    const target = phraseTarget(guide, section, positions[section]); positions[section] += 1;
    return textLength(text) === target ? text.replace(/[\s，。！？、；：,.!?~～—-]/g, "") : calibratedLine(text, target, random);
  }).join("\n");
}
function meterInstruction(payload) {
  const guide = meterGuide(payload); const describe = values => values.map(value => `${value}个音节位`).join("、");
  return `【最高优先级：严格按固定曲调填词，不能偏离】旋律规格：${guide.name}，${guide.bpm} BPM，${guide.key}。每个段落的非空歌词行必须严格一一对应音节槽位，不得多行、少行、合并或拆分：主歌A与主歌B都分别依次使用${describe(guide.slots.verse)}；副歌依次为${describe(guide.slots.chorus)}；桥段依次为${describe(guide.slots.bridge)}；终章副歌依次为${describe(guide.slots.outro)}。每个汉字计一个音节位，标点和空格不计，拖音/转音不重复计数。生成前必须逐行核对字数；任何一行不等于对应槽位都视为失败，不能用“差不多”“左右”替代。不要自行创作新曲调，不要为了押韵增加或删除整行。`;
}

function mock(task, payload) {
  const seed = Number(payload.seed) || Date.now();
  const random = randomFrom(hash(`${task}|${JSON.stringify(payload)}|${seed}`));
  if (task === "lyrics") {
    const title = safeText(payload.title, 32) || "今天我会发光";
    const topic = safeText(payload.topic, 100) || "完成今天的小目标";
    const starts = ["晨光落在刚翻开的书页", "窗外的风替我数着节拍", "笔尖轻轻敲醒新的期待", "深呼吸让心慢慢安静下来"];
    const turns = ["看不懂就把问题拆开", "走慢一点也仍然在向前", "每个错误都藏着新线索", "再试一次答案就会出现"];
    const hooks = ["让今天的努力被旋律听见", "把小小勇气唱到更远", "我的脚步正把未知改变", "这一刻我为自己加冕"];
    const draft = payload.mode === "polish" && safeText(payload.lyrics, 2400) ? safeText(payload.lyrics, 2400) : ["[主歌 A]", pick(random, starts), `今天我要完成：${topic}`, pick(random, turns), pick(random, turns), "先把眼前这一小步走稳", "再让新的发现慢慢发生", "", "[副歌]", `${title}，跟着心跳出发`, ...hooks.sort(() => random() - .5).slice(0, 3), "", "[主歌 B]", pick(random, starts), pick(random, turns), "难题不会定义我的明天", "我会带着自己的节奏向前", "把学会的方法认真记下", "下一次我会回答得更好", "", "[桥段]", "把弯路也写成成长的诗篇", "原来坚持本身就是答案", "每次尝试都让勇气长大", "", "[终章副歌]", `${title}，现在就出发`, ...hooks.slice(0, 2), `${title}，我正在慢慢发光`].join("\n");
    const lyrics = meterizeLyrics(draft, payload);
    return { lyrics, seed, title, style: payload.style || "pop", melodyGuide: meterGuide(payload), versionLabel: `创作版本 ${String(seed).slice(-4)}` };
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
  if (task === "ambient") {
    const focus = Number(payload.focus) || 0; const sessions = Number(payload.sessions) || 0; const streak = Number(payload.streak) || 0;
    const messages = sessions > 0 ? [`你已经完成 ${sessions} 段专注，认真开始本身就很棒。`, `今天投入的 ${focus} 分钟，正在一点点变成你的底气。`, `连续前进 ${Math.max(1, streak)} 天，慢慢走也一直在靠近目标。`] : ["先做一个小到不会害怕的目标，今天的节奏就会开始。", "不用等状态完美，翻开第一页就是很好的开始。", "把难题切成第一小步，现在只完成这一小步。"];
    return { message: messages[Math.abs(hash(`${payload.day}|${focus}|${sessions}`)) % messages.length], mood: sessions ? "proud" : "gentle" };
  }
  const focus = Number(payload.focus) || 0; const sessions = Number(payload.sessions) || 0; const mistakes = Number(payload.mistakes) || 0;
  return { keyword: sessions ? "已经出发" : "等待第一拍", copy: sessions ? `今天完成了 ${sessions} 段专注，共投入 ${focus} 分钟，并记录了 ${mistakes} 道错题。明天先重做一道今天的错题，再进入新任务。` : "今天先从一个 15 分钟的小任务开始。完成第一段之后，学习的节奏就会慢慢建立起来。" };
}

function promptFor(task, payload) {
  const common = "你是面向6-12岁学生的学习伙伴。内容必须积极、具体、安全，不说教。不要展示思考过程，只返回一个合法JSON对象，不要Markdown代码块，不要任何前后说明。";
  // 曲调计划中包含逐音符数组。它对语言模型写词没有额外帮助，却会把同一份
  // 节拍信息重复塞进提示词，增加响应时间，也更容易让模型在 JSON 后续写说明。
  // 只保留写词真正需要的 BPM、调性和每行音节位。
  const promptPayload = task === "lyrics" ? {
    title: safeText(payload.title, 80), style: safeText(payload.style, 80), topic: safeText(payload.topic, 300),
    mode: safeText(payload.mode, 24), repairOnly: Boolean(payload.repairOnly), seed: Number(payload.seed) || 0,
    lyrics: safeText(payload.lyrics, 2400), previousLyrics: payload.previousLyrics && payload.previousLyrics !== payload.lyrics ? safeText(payload.previousLyrics, 1600) : "",
    melodyGuide: (() => { const guide = meterGuide(payload); return { name: guide.name, bpm: guide.bpm, key: guide.key, slots: guide.slots }; })(),
  } : payload;
  const prompts = {
    lyrics: payload.mode === "polish"
      ? `只润色输入歌词，不重新创作。必须保留所有段落标题、非空歌词行的数量和顺序；一行对应一行，不能合并、拆分、删除整行或添加新段落。只允许在当前曲调要求下对少量字词做同义替换、补字或删字，优先保留原意、叙事和关键词。${payload.repairOnly ? "这是一次针对音节偏差的定点修复，只修改不合格行，其余行原样保留。" : ""}${meterInstruction(payload)} 返回 {"lyrics":"...","seed":${Number(payload.seed) || Date.now()}}。输入：${JSON.stringify(promptPayload)}`
      : `${meterInstruction(payload)} 在不改变上述固定行数和音节位的前提下规划完整故事：主歌A提出场景，副歌表达核心，主歌B出现方法或变化，桥段产生转折，终章副歌完成成长。写一首中文儿童成长歌曲，必须包含[主歌 A]、[副歌]、[主歌 B]、[桥段]、[终章副歌]，副歌要有自然记忆点；每写完一行立即核对音节数，不合格就重写该行。返回 {"lyrics":"...","seed":${Number(payload.seed) || Date.now()}}。输入：${JSON.stringify(promptPayload)}`,
    plan: `把学习任务拆成1-6段可执行计划。返回 {"focusMin":整数,"breakMin":整数,"roundCount":整数,"segments":[字符串],"note":"一句建议"}。输入：${JSON.stringify(payload)}`,
    mistake: `分析错题的可能错因和下一步，不直接贬低学生。返回 {"analysis":"80字内","nextStep":"80字内"}。输入：${JSON.stringify(payload)}`,
    quiz: `按学科和薄弱点生成一道小学生可独立作答的新题，不得重复excludeQuestions中的题目。答案要允许合理的同义表达。返回 {"id":"含随机性的短ID","question":"题目","answer":"标准短答案","answers":["可接受答案1","可接受答案2"],"hint":"只提示方法，不泄露答案","explanation":"解析","level":"难度"}。输入：${JSON.stringify(payload)}`,
    weekly: `把目标安排成周一到周日每天一个小任务。返回 {"goal":"目标","days":[{"day":"周一","task":"任务"}...共7项]}。输入：${JSON.stringify(payload)}`,
    summary: `根据今日数据写鼓励但不夸张的学习总结，并给出明天第一步。返回 {"keyword":"四字内关键词","copy":"120字内"}。输入：${JSON.stringify(payload)}`,
    ambient: `根据极少量今日学习数据写一句自然、具体、不说教的短提醒，18-34个汉字，不使用感叹号，不提AI，不虚构成绩。返回 {"message":"一句话","mood":"gentle或proud或curious"}。输入：${JSON.stringify(payload)}`,
  };
  return `${common}\n${prompts[task]}`;
}

function modelContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(part => typeof part === "string" ? part : part?.text ?? part?.content ?? part?.value ?? "").join("");
  if (content && typeof content === "object") return content.text ?? content.content ?? content.value ?? JSON.stringify(content);
  return String(content || "");
}

function plainLyricsFallback(content, payload) {
  const raw = modelContentText(content).trim();
  const start = raw.search(/[\[【](?:主歌|副歌|桥段|终章)/);
  if (start < 0) return null;
  let lyrics = raw.slice(start).replace(/```$/g, "").trim();
  // 有些兼容接口会把换行和引号作为转义文本返回。
  lyrics = lyrics.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\n(?:说明|解释|创作完成|希望这首歌)[：:].*$/s, "").trim();
  return isValid("lyrics", { lyrics }) ? { lyrics, seed: Number(payload?.seed) || Date.now() } : null;
}

function parseModelJson(content, accept = () => true) {
  const raw = modelContentText(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsedObject = false;
  let sawOpeningBrace = false;
  try {
    const parsed = JSON.parse(raw);
    parsedObject = Boolean(parsed && typeof parsed === "object");
    if (accept(parsed)) return parsed;
  } catch (_) {
    // Fall through to the balanced-object scanner below.
  }
  {
    // 部分供应商会在合法 JSON 后加一句自然语言说明，或连续输出两个 JSON
    // 对象。不能用“第一个 { 到最后一个 }”截取，否则会把两个对象粘在一起。
    // 逐字符识别完整对象，优先使用第一个可解析的对象。
    for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
      sawOpeningBrace = true;
      let depth = 0; let quoted = false; let escaped = false;
      for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') { quoted = true; continue; }
        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            try { const parsed = JSON.parse(raw.slice(start, index + 1)); parsedObject = true; if (accept(parsed)) return parsed; } catch (_) { break; }
          }
        }
      }
    }
    if (parsedObject) throw new Error("模型返回了 JSON，但字段不完整或类型不符合要求");
    if (sawOpeningBrace) throw new Error("模型输出可能被截断，JSON 没有闭合");
    throw new Error("模型返回内容不是 JSON");
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
  if (task === "ambient") return typeof data.message === "string" && data.message.trim().length >= 8 && data.message.length <= 80 && typeof data.mood === "string";
  return false;
}

function configuredProvider(env) {
  return String(env.AI_PROVIDER || (env.AGNES_API_KEY && !env.AI_API_KEY ? "agnes" : "remote")).toLowerCase();
}

function textConfig(env) {
  const provider = configuredProvider(env);
  const legacyAgnes = provider === "agnes";
  return {
    provider,
    base: String(env.AI_BASE_URL || (legacyAgnes ? env.AGNES_BASE_URL : "") || "").replace(/\/$/, ""),
    apiKey: env.AI_API_KEY || (legacyAgnes ? env.AGNES_API_KEY : ""),
    model: env.AI_MODEL || (legacyAgnes ? env.AGNES_MODEL : ""),
    fastModel: env.AI_FAST_MODEL || env.AI_MODEL || (legacyAgnes ? env.AGNES_MODEL : ""),
    lyricsModel: env.AI_LYRICS_MODEL || env.AI_MODEL || (legacyAgnes ? env.AGNES_MODEL : ""),
  };
}

async function callTextProvider(task, payload, env) {
  const { provider, base, apiKey, fastModel, lyricsModel } = textConfig(env);
  const model = task === "lyrics" ? lyricsModel : fastModel;
  if (!base || !apiKey || !model) throw new Error(`${provider} 文本 AI 配置不完整：需要 AI_BASE_URL、AI_API_KEY、AI_MODEL`);
  const configuredTimeout = Number(task === "lyrics" ? env.AI_LYRICS_TIMEOUT_MS : env.AI_FAST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(5_000, Math.min(45_000, configuredTimeout)) : (task === "lyrics" ? 32_000 : 15_000);
  const controller = new AbortController(); let providerTimedOut = false;
  const timeout = setTimeout(() => { providerTimedOut = true; controller.abort(); }, timeoutMs);
  let response;
  try {
    const tokenLimits = { lyrics: 700, plan: 360, mistake: 320, quiz: 480, weekly: 420, summary: 220, ambient: 90 };
    const requestBody = { model, messages: [{ role: "system", content: "只输出一个合法JSON对象，不输出思考过程。" }, { role: "user", content: promptFor(task, payload) }], temperature: task === "lyrics" ? .68 : .45, max_tokens: tokenLimits[task] || 700 };
    // Agnes 支持该开关；SiliconFlow 等兼容接口会将 thinking:false 判定为非法参数。
    if (provider === "agnes") requestBody.thinking = false;
    // SiliconFlow 的 JSON Mode 会在模型侧约束输出格式，减少截断后无法解析的降级。
    if (provider === "siliconflow") {
      requestBody.response_format = { type: "json_object" };
      requestBody.enable_thinking = false;
    }
    response = await fetch(`${base}/chat/completions`, {
      method: "POST", signal: controller.signal,
      headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    if (error?.name === "AbortError" && providerTimedOut) throw new Error(`${configuredProvider(env)} 响应超过 ${timeoutMs / 1000} 秒，后端主动中止请求`);
    throw error;
  } finally { clearTimeout(timeout); }
  const raw = await response.text();
  let result = null;
  try { result = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) {
    const detail = result?.error?.message || result?.message || raw || "空响应";
    throw new Error(`${configuredProvider(env)} API ${response.status}: ${String(detail).slice(0, 240)}`);
  }
  if (!result) throw new Error(`${configuredProvider(env)} 返回了无法解析的响应`);
  if (result?.error?.message) throw new Error(`${provider} API ${result.error.code || response.status}: ${result.error.message}`);
  if (Number.isFinite(Number(result?.code)) && result?.message) throw new Error(`${provider} API ${result.code}: ${result.message}`);
  const message = result.choices?.[0]?.message;
  const candidates = [message?.content, message?.text, message?.reasoning_content, result.output_text, result.content, result.text, result.response].filter(value => value !== undefined && value !== null && value !== "");
  let lastError = null;
  for (const candidate of candidates) {
    try { return parseModelJson(candidate, data => isValid(task, data)); }
    catch (error) { lastError = error; }
    if (task === "lyrics") {
      const fallback = plainLyricsFallback(candidate, payload);
      if (fallback) return fallback;
    }
  }
  throw lastError || new Error("模型没有返回可读取的内容");
}

export async function onRequestPost(context) {
  const origin = context.request.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== new URL(context.request.url).host) return json({ ok: false, error: "不允许跨站调用" }, 403); }
    catch (_) { return json({ ok: false, error: "来源地址无效" }, 403); }
  } else if (!["localhost", "127.0.0.1", "::1"].includes(new URL(context.request.url).hostname)) return json({ ok: false, error: "缺少同源请求信息" }, 403);
  let body;
  try { body = await context.request.json(); } catch (_) { return json({ ok: false, error: "请求必须是 JSON" }, 400); }
  const task = safeText(body?.task, 20); const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  if (!TASKS.has(task)) return json({ ok: false, error: "不支持的 AI 任务" }, 400);
  if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) return json({ ok: false, error: `输入内容过长（上限 ${MAX_PAYLOAD_CHARS} 字符）` }, 413);
  const provider = configuredProvider(context.env);
  const { apiKey, model } = textConfig(context.env);
  if (!apiKey || context.env.AI_MODE === "mock") return json({ ok: true, data: mock(task, payload), meta: { mode: "mock" } });
  const startedAt = Date.now();
  try {
    await consumeAiQuota(context);
    const data = await callTextProvider(task, payload, context.env);
    if (!isValid(task, data)) throw new Error(`${provider} 返回的数据结构不符合要求`);
    if (task === "lyrics") {
      data.lyrics = meterizeLyrics(data.lyrics, payload);
      data.melodyGuide = meterGuide(payload);
    }
    return json({ ok: true, data, meta: { mode: "remote", provider, model: task === "lyrics" ? textConfig(context.env).lyricsModel : textConfig(context.env).fastModel, task, durationMs: Date.now() - startedAt } });
  } catch (error) {
    console.error(`${provider} request failed`, error?.message);
    return json({ ok: true, data: mock(task, payload), meta: { mode: "degraded", degraded: true, provider, task, durationMs: Date.now() - startedAt, reason: error?.message || "文本 AI 请求失败" } });
  }
}

export function onRequestGet(context) {
  const provider = configuredProvider(context.env);
  const { apiKey, base, model } = textConfig(context.env);
  return json({ ok: true, service: "Focus Beat AI gateway", tasks: [...TASKS], meta: apiKey && base && model && context.env.AI_MODE !== "mock" ? { mode: "remote", provider, model } : { mode: "mock", reason: apiKey && (!base || !model) ? "incomplete-config" : undefined } });
}
