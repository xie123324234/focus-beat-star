# Focus Beat｜本地拟唱版

面向小学生的专注、学习和歌曲创作网站。文字功能可接 Agnes；歌曲部分不依赖付费音乐 API：Web Audio 生成伴奏，浏览器 `speechSynthesis` 用不同节拍、语速和音高拟唱中文歌词。

## 能力与边界

- 离线可生成伴奏、试听和完整本地拟唱；试听播放完整蓝图的前 30%。
- 歌词、学习计划、错题分析、举一反三支持 Agnes，并有本地回退。
- 换歌词、换曲调和生成试听各消耗 1 音符；保存完整拟唱消耗 30 音符。
- 浏览器拟唱不是真人歌声，音色和节奏会因 Chrome、Edge、系统中文语音包而不同。

## 本地使用

直接双击 `index.html` 可离线体验本地功能。若要测试 Pages Functions 中的文本 AI：

```powershell
npx wrangler pages dev .
```

浏览器打开终端提示的地址；没有 Agnes Key 时会自动使用离线内容引擎。

## 配置 Agnes

将 `.dev.vars.example` 复制为 `.dev.vars`，再填写 Agnes 配置。真实 Key 只放在 `.dev.vars` 或 Cloudflare Secret，绝不放进前端文件。

## 主要文件

- `music-engine.js`：本地和弦、旋律、鼓组与中文拟唱调度。
- `music-client.js`：本地音乐任务适配器，不请求音乐后端。
- `functions/api/ai.js`：文本 AI 的服务端代理与本地回退。
- `tests/smoke.mjs`：界面、离线模式、试听、收藏和音符规则测试。
