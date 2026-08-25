(() => {
  "use strict";

  const API_PATH = "/api/ai";
  // Agnes 的完整歌词响应实测可能超过 12 秒；前端超时必须长于服务端的 20 秒上限。
  const REQUEST_TIMEOUT = 25000;

  function hashString(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    return () => {
      let value = seed += 0x6d2b79f5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function pick(random, list) {
    return list[Math.floor(random() * list.length)];
  }

  function clean(value, limit = 120) {
    return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, limit);
  }

  const styleWords = {
    pop: ["让心跳跟着节拍发亮", "把小小勇气唱得响亮", "一步一步也能追上太阳", "今天的我比昨天更有力量"],
    rock: ["把犹豫踩成坚定的鼓点", "让难题听见我不退的宣言", "跌倒也要带着笑重新出现", "这一刻我要冲过自己的边界"],
    rap: ["一题一题拆开线索就在眼前", "错过一次没关系再来一遍", "我的节奏由我自己掌握时间", "专注上线把小目标全部兑现"],
    folk: ["晚风把书页轻轻翻到下一行", "窗边的月亮听见我慢慢成长", "铅笔写下今天努力的模样", "小小的坚持也会开出一片光"],
    classic: ["星光落在安静展开的纸上", "旋律带着思考轻轻地流淌", "每一个答案都有耐心的回响", "我在时间深处收藏成长"],
  };

  function localLyrics(payload) {
    const title = clean(payload.title, 32) || "今天我会发光";
    const style = Object.hasOwn(styleWords, payload.style) ? payload.style : "pop";
    const topic = clean(payload.topic, 100) || "完成今天的小目标";
    const seed = Number(payload.seed) || Date.now();
    const random = mulberry32(hashString(`${title}|${style}|${topic}|${seed}`));
    const beginnings = ["清晨的第一束光落在桌角", "钟摆轻轻提醒新的篇章", "翻开书本也翻开一扇窗", "深呼吸让纷乱慢慢退场", "笔尖碰到纸面发出轻响"];
    const challenges = ["有些答案绕了很远才遇见", "也曾被一道难题挡在半路", "错误留下的不是失败而是线索", "看不懂的地方先画一个小圈", "偶尔的停顿也在准备出发"];
    const turns = ["我把大目标切成小小一段", "重新读题就看见隐藏的方向", "把每次不会变成下一次会", "跟着节拍耐心再试一遍", "慢一点也不会错过终点"];
    const hooks = [
      [`${title}，现在就出发`, "每一次专注都在回答", "不必一下抵达最远的地方", "今天向前一点就值得鼓掌"],
      [`唱起${title}，让勇气发芽`, "把新的发现装进行囊吧", "所有认真都不会被时光落下", "我会带着自己的节奏长大"],
      [`${title}，听见心里的回答`, "一步一步把未知变成办法", "就算今天只点亮一颗星", "明天也会连成闪亮的银河"],
    ];
    const hook = pick(random, hooks);
    const lines = [
      "[主歌 A]", pick(random, beginnings), `今天我要挑战：${topic}`, pick(random, challenges), pick(random, turns), "",
      "[副歌]", ...hook, "",
      "[主歌 B]", pick(random, beginnings), pick(random, challenges), pick(random, turns), pick(random, styleWords[style]), "",
      "[桥段]", "把走过的弯路写进旋律", "原来坚持本身就是答案", "",
      "[终章副歌]", ...hook.slice(0, 2), pick(random, styleWords[style]), `${title}，我正在慢慢发光`,
    ];
    return { lyrics: lines.join("\n"), seed, title, style, versionLabel: `创作版本 ${String(seed).slice(-4)}` };
  }

  function localPlan(payload) {
    const preset = ["easy", "standard", "deep"].includes(payload.preset) ? payload.preset : "standard";
    const config = { easy: [15, 5, 2], standard: [25, 5, 2], deep: [40, 10, 2] }[preset];
    const subject = clean(payload.subject, 80) || "完成今天最重要的学习任务";
    return { focusMin: config[0], breakMin: config[1], roundCount: config[2], segments: [`先读清要求，开始${subject}`, `检查易错点，完成${subject}`], note: "先完成再完善，每一段只处理一个明确目标。" };
  }

  function localMistake(payload) {
    const text = clean(payload.text, 1200);
    const subject = clean(payload.subject, 20) || "这道题";
    const tips = {
      数学: "先圈出已知条件与所求问题，再把每一步计算写开并反向验算。",
      语文: "回到原文找到关键词，区分题目是在问内容、作用还是表达效果。",
      英语: "先确定句子时态和主语，再检查单词形式与语序。",
      科学: "分清观察到的现象和由现象得到的结论，再检查变量是否唯一。",
    };
    return { analysis: `这道${subject}题的关键可能不是“不会”，而是解题步骤没有显性化。${tips[payload.subject] || tips.数学}`, nextStep: `遮住原答案，用“已知—方法—结果”三步重新完成：${text.slice(0, 38)}${text.length > 38 ? "……" : ""}` };
  }

  function localQuiz(payload) {
    const subject = clean(payload.subject, 12) || "数学";
    const seed = Number(payload.seed) || Date.now();
    const random = mulberry32(hashString(`${subject}|${seed}`));
    let entry;
    if (subject === "数学") {
      const kind = Math.floor(random() * 4);
      const a = 4 + Math.floor(random() * 8); const b = 3 + Math.floor(random() * 7);
      if (kind === 0) entry = [`一本故事书有 ${a * b} 页，每天读 ${a} 页，几天能读完？`, String(b), "用总页数除以每天阅读页数。", `${a * b} ÷ ${a} = ${b}（天）。`];
      else if (kind === 1) entry = [`一个长方形长 ${a + 2} 厘米、宽 ${b} 厘米，它的面积是多少平方厘米？`, String((a + 2) * b), "长方形面积 = 长 × 宽。", `${a + 2} × ${b} = ${(a + 2) * b}（平方厘米）。`];
      else if (kind === 2) entry = [`${a * 5} 加上一个数等于 ${a * 5 + b * 3}，这个数是多少？`, String(b * 3), "用和减去已知加数。", `${a * 5 + b * 3} - ${a * 5} = ${b * 3}。`];
      else entry = [`有 ${a} 盒彩笔，每盒 ${b} 支，送出 ${a + b} 支后还剩多少支？`, String(a * b - a - b), "先算总数，再减去送出的数量。", `${a} × ${b} - ${a + b} = ${a * b - a - b}（支）。`];
    } else {
      const banks = {
        语文: [
          ["“小鸟在枝头唱歌”使用了什么修辞手法？", "拟人", "想一想“唱歌”原本是谁的动作。", "把小鸟当作人来写，使用了拟人。", ["拟人句"]],
          ["“安静”的反义词是什么？", "热闹", "想一想人多、声音多的场景。", "“安静”与“热闹”意思相反。", ["喧闹"]],
          ["“一眨眼，假期就结束了”主要表现时间怎样？", "过得很快", "注意“一眨眼”表达的速度。", "“一眨眼”说明时间过去得非常快。", ["很快", "飞快"]],
          ["“保护”的近义词是什么？", "爱护", "想一想怎样对待珍贵的东西。", "“爱护”和“保护”意思相近。", ["呵护"]],
        ],
        英语: [
          ["补全句子：She ___ to school every day. (go)", "goes", "主语是第三人称单数，且是一般现在时。", "第三人称单数后动词 go 变为 goes。"],
          ["“图书馆”的英文单词是什么？", "library", "单词以 lib- 开头。", "图书馆是 library。"],
          ["选择正确形式：There ___ two books on the desk. (is / are)", "are", "主语是复数 two books。", "复数名词前使用 are。"],
          ["“星期三”的英文单词是什么？", "Wednesday", "单词以 Wed- 开头。", "星期三是 Wednesday。"],
        ],
        科学: [
          ["植物进行光合作用通常需要光、水和哪一种气体？", "二氧化碳", "这种气体由人和动物呼出。", "植物吸收二氧化碳进行光合作用。", ["CO2"]],
          ["水在标准大气压下的沸点是多少摄氏度？", "100", "这是常见的温度基准。", "标准大气压下，水在 100℃ 沸腾。", ["100℃", "100摄氏度"]],
          ["地球自转一周大约需要多长时间？", "24小时", "想一想一天的长度。", "地球自转一周大约是一天，也就是24小时。", ["一天", "1天"]],
          ["用磁铁靠近铁钉，铁钉被吸起，这说明磁铁具有什么性质？", "磁性", "答案是磁铁吸引铁制品的能力。", "磁铁能够吸引铁制品，这种性质叫磁性。", ["能吸引铁"]],
        ],
      };
      entry = pick(random, banks[subject] || banks.语文);
    }
    const answers = [entry[1], ...(entry[4] || [])];
    return { id: `quiz_${hashString(`${subject}|${entry[0]}|${seed}`)}`, question: entry[0], answer: entry[1], answers, hint: entry[2], explanation: entry[3], level: random() > .72 ? "进阶思考" : "基础巩固" };
  }

  function localWeekly(payload) {
    const goal = clean(payload.goal, 100) || "巩固本周知识，整理错题并完成一次复盘";
    const tasks = ["拆解目标，完成第一小步", "继续主任务，标出两个卡点", "复习前两天内容，做一次自测", "攻克一个卡点，记录解题方法", "完成本周主任务并检查", "整理错题，向家人讲解一道题", "轻量回顾，为下周写一句计划"];
    return { goal, days: tasks.map((task, index) => ({ day: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][index], task })) };
  }

  function localSummary(payload) {
    const focus = Math.max(0, Number(payload.focus) || 0);
    const sessions = Math.max(0, Number(payload.sessions) || 0);
    const mistakes = Math.max(0, Number(payload.mistakes) || 0);
    const keyword = focus >= 50 ? "稳定前进" : sessions > 0 ? "已经出发" : mistakes > 0 ? "找到线索" : "等待第一拍";
    const copy = sessions
      ? `你今天完成了 ${sessions} 段专注，共投入 ${focus} 分钟，并认真记录了 ${mistakes} 道错题。真正重要的不只是完成数量，而是你已经建立了“开始—坚持—回顾”的节奏。明天优先重做一道今天的错题，再进入新任务。`
      : "今天的学习节拍还没有正式开始。先选一个最小任务，专注 15 分钟就好；完成第一段之后，动力通常会自己跟上来。";
    return { keyword, copy };
  }

  const localHandlers = { lyrics: localLyrics, plan: localPlan, mistake: localMistake, quiz: localQuiz, weekly: localWeekly, summary: localSummary };

  async function request(task, payload = {}) {
    if (!Object.hasOwn(localHandlers, task)) throw new Error("未知 AI 任务");
    if (location.protocol === "http:" || location.protocol === "https:") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      try {
        const response = await fetch(API_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task, payload }),
          signal: controller.signal,
        });
        if (response.ok) {
          const result = await response.json();
          if (result?.ok && result.data) return { data: result.data, mode: result.meta?.mode || "remote" };
        }
      } catch (_) {
        // 网络或后端不可用时，产品仍可完整运行。
      } finally {
        clearTimeout(timeout);
      }
    }
    return { data: localHandlers[task](payload), mode: "local" };
  }

  async function status() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return { mode: "local", reason: "file" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(API_PATH, { headers: { accept: "application/json" }, signal: controller.signal, cache: "no-store" });
      if (!response.ok) return { mode: "local", reason: "backend" };
      const result = await response.json();
      return result?.meta || { mode: "local", reason: "backend" };
    } catch (_) {
      return { mode: "local", reason: "backend" };
    } finally {
      clearTimeout(timeout);
    }
  }

  window.FocusBeatAI = { request, status, local: localHandlers, hashString };
})();
