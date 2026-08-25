# Focus Beat｜Treblo Melodia 真唱版

面向小学生的专注与学习网站。文本 AI 负责歌词和学习内容；歌曲创作室先生成结构化曲调，再按音节位填词，默认由 Treblo Melodia v3 负责真实演唱和编曲，MiniMax 与 ACE 保留为备用适配器。

## 歌曲规则

1. 生成试听扣 1 音符，曲调计划先确定每句音节位；通过 Treblo `/v1/generations/v3` 创建完整歌曲任务，完成后临时开放全曲试听，便于逐句检查演唱。
2. 收藏完整歌曲扣 30 音符，直接标记浏览器中同一份原版音频，不再使用 `complete` 二次生成，也不拼接两段 MP3。
3. 换歌词、换曲调与填词各扣 1 音符，但只更新创作草稿并删除旧试听；确认后点击“生成试听”才调用音乐 API。
4. 音乐服务未配置时页面会明确提示，绝不降级播放节拍器或浏览器朗读。
5. 每个曲调都有主歌、副歌、桥段的音节槽位；一个字跨多个音符时只占一个音节位。歌词输入框直接显示灰体多余字和 `☆` 缺音节。试听前若存在偏差会弹出确认提示，但不会额外扣费。
6. 供应商返回 LRC 或逐词时间戳时，收藏页按真实字级时间轴蓝色扫读；未返回时，页面会明确标注“估算逐行同步”，不会伪装成字级同步。
7. 异步任务从提交开始即使用幂等键防重；短暂断网或状态查询超时不会重复创建歌曲，也不会把仍在生成的任务误判为退款。后端默认限制每来源每小时 8 首、全站每天 15 首，可通过环境变量调整。

## 本地启动

```powershell
npx wrangler pages dev .
```

不要直接双击 `index.html`：真唱版的密钥只能通过 Pages Function 使用。

## 必填配置

复制 `.dev.vars.example` 为 `.dev.vars` 后填写：

- `MUSIC_PROVIDER=treblo`
- `TREBLO_API_KEY`（只需在 `.dev.vars` 中粘贴这一项的真实值）
- `TREBLO_BASE_URL=https://api.treblo.com/v1`
- `TREBLO_MODEL_VERSION=v3`
- `TREBLO_TARGET_DURATION=120`（默认请求约 120–150 秒；歌词较长时会按需扩展，最长 300 秒）
- `MUSIC_SIGNING_SECRET`（可选；至少 32 位随机文本，用于独立下载授权。不填时安全地派生自 Treblo Key）

Treblo 的生成链接只保证保留一周。本站会在歌曲完成后立即通过同源受保护下载通道保存至用户当前浏览器的 IndexedDB；收藏不重新生成歌曲，也不依赖 R2。清除浏览器站点数据会删除本地收藏，因此建议保留后续提供的本地备份文件。用户可见页面必须保留 `Powered By Treblo` 链接，除非另行取得官方豁免。

真实密钥和可选的 `MUSIC_SIGNING_SECRET` 绝不能提交到仓库或放进浏览器代码。

## 主要文件

- `functions/api/music.js`：Treblo/MiniMax/ACE 音乐任务、歌词时间戳读取，以及 Treblo 本地收藏模式的受保护下载代理。
- `functions/api/ai.js`：OpenAI 兼容文本 AI 网关；会压缩曲调输入并容错解析模型在 JSON 后附带的说明，避免误降级为本地模板。
- `composition-plan.js`：曲调模板、音符、拖音和音节位的唯一真源。
- `music-client.js`：只调用同源后端，前端没有音乐 Key。
- `app.js`：音符扣费、退款、歌曲收藏和详情。
- `tests/music-api.mjs`：模拟 Treblo、MiniMax、ACE、R2 兼容模式与无 R2 的本地收藏下载通路。
