# 部署说明｜Focus Beat Treblo 真唱版

## 1. 创建 R2

在 Cloudflare 创建名为 `focus-beat-audio` 的 R2 桶。`wrangler.toml` 已将其绑定为 `MUSIC_AUDIO`；线上 Pages 项目也必须在 Settings → Bindings 中绑定同一桶。

## 2. 设置服务端变量

本地放在 `.dev.vars`，线上放在 Cloudflare Pages 的 Variables and Secrets：

|变量|类型|说明|
|---|---|---|
|`MUSIC_PROVIDER`|Text|默认 `treblo`；备用值为 `minimax` 或 `acemusic`|
|`TREBLO_API_KEY`|Secret|Treblo Developer API Key|
|`TREBLO_BASE_URL`|Text|默认 `https://api.treblo.com/v1`|
|`TREBLO_MODEL_VERSION`|Text|默认 `v3`|
|`TREBLO_TARGET_DURATION`|Text|基础目标时长，默认 `120`，通常发送 `[120,150]`；歌词确实更长时自动按 30 秒档位扩展，最长 `[270,300]`|
|`MINIMAX_API_KEY`|Secret|MiniMax 开放平台 API Key|
|`MINIMAX_BASE_URL`|Text|国内默认 `https://api.minimaxi.com`|
|`MINIMAX_MUSIC_MODEL`|Text|备用；`music-2.6-free` 已停止服务，不建议继续使用|
|`MINIMAX_REQUEST_TIMEOUT_MS`|Text|生成请求超时，默认 `300000` 毫秒|
|`MINIMAX_TARGET_DURATION`|Text|目标时长提示，默认 `60` 秒|
|`MUSIC_HOURLY_LIMIT`|Text|每个来源每小时生成上限，默认 `8`|
|`MUSIC_DAILY_LIMIT`|Text|全站每天生成上限，默认 `15`；用于保护有限的供应商额度|
|`ACEMUSIC_API_KEY`|Secret|ACE Music API Key|
|`ACEMUSIC_BASE_URL`|Text|默认 `https://api.acemusic.ai`|
|`ACEMUSIC_MODEL`|Text|默认 `acemusic/acestep-v15-turbo`|
|`ACEMUSIC_DURATION`|Text|完整母带的目标时长，默认 `60` 秒|
|`ACEMUSIC_PREVIEW_DURATION`|Text|仅用于兼容旧版短试听任务；新任务始终临时开放全曲|
|`ACEMUSIC_MIN_LYRIC_SCORE`|Text|ACE 返回匹配评分时的最低接受值，默认 `0.72`|
|`ACEMUSIC_RENDER_MODE`|Text|默认 `text2music`：优先确保生成中文主唱；`cover-guide` 只有提供真实人声引导音频时才启用|
|`ACEMUSIC_API_MODE`|Text|`cloud_completion`（默认）：官方 `api.acemusic.ai` 同步接口；`native_async`：自己的 ACE-Step API 服务|
|`ACEMUSIC_INFERENCE_STEPS`|Text|云端 Turbo 推理步数，默认 `5`；越低越快但音质会略降，建议 4～8|
|`AI_PROVIDER`|Text|文本 AI 提供商标识，例如 `siliconflow`|
|`AI_API_KEY`|Secret|文本 AI Key|
|`AI_BASE_URL`|Text|OpenAI 兼容接口地址，例如 `https://api.siliconflow.cn/v1`|
|`AI_MODEL`|Text|文本 AI 模型，例如 `deepseek-ai/DeepSeek-V4-Flash`|
|`AI_HOURLY_LIMIT`|Text|每个来源每小时文本 AI 调用上限，默认 `60`|
|`AI_DAILY_LIMIT`|Text|全站每天文本 AI 调用上限，默认 `500`|
|`AGNES_API_KEY`|Secret|可选，文本 AI Key|
|`AGNES_BASE_URL`|Text|可选，Agnes 地址|
|`AGNES_MODEL`|Text|可选，Agnes 模型|

不要把 Key 放在 `app.js`、`music-client.js`、`index.html` 或 Git 仓库中。

推荐使用上面的 `AI_*` 通用变量。`AGNES_*` 仅为旧配置保留，且只有明确设置 `AI_PROVIDER=agnes` 时才会读取；未配置完整时不会再静默回退到其他供应商。

## 3. 本地测试

```powershell
npx wrangler pages dev .
```

访问终端输出的本地地址。出现 `Unable to fetch Request.cf` 的 warning 是 Wrangler 本地模拟提示，不是启动失败。

## 4. 音频与付费流程

Treblo 模式使用 `POST /generations/v3` 创建任务，并轮询 `GET /generations/status/{task_id}`。成功后从 `song_paths[0]` 下载完整母带到 R2；试听令牌临时开放同一份全曲母带，永久收藏时只创建收藏凭证，不会再次生成、复制或拼接音频。

Treblo 的临时歌曲地址只保证一周，因此线上必须绑定 R2。项目请求 `align_lyrics=true` 并等待对齐任务；供应商实际返回时间戳时使用真实同步，否则诚实降级为估算逐行同步。生成失败时 Treblo 官方不扣 credits，网站也会退还音符。

Treblo API 条款要求用户可见产品清晰展示链接到 `https://treblo.com` 的 `Powered By Treblo`；项目页脚已加入该链接，请勿删除。

ACE 是备用模式。`api.acemusic.ai` 使用 `POST /v1/chat/completions`；只有自己的 ACE-Step API Server 才应设置 `ACEMUSIC_API_MODE=native_async`。

ACE 原生异步协议为：`POST /release_task` 创建任务，`POST /query_result` 轮询状态，成功后通过 `GET /v1/audio?path=...` 下载。不要把该模式指向 `https://api.acemusic.ai`。

- 试听地址使用独立临时令牌，可播放全曲以检查所有歌词。只要完整音频到达浏览器，就无法绝对阻止用户提取，因此 30 音符对应的是永久收藏与产品内管理，而不是“才能听到后半首”。
- 保存后复制同一母带并返回完整播放令牌，不再产生旋律或歌手变化。
- 换歌词或换曲调成功后删除旧试听凭证和未收藏母带。
- 未保存试听建议在 R2 生命周期规则中设置 24 小时自动删除。

当前音符余额和收藏仍保存在浏览器本地，适合单机产品演示。公开运营前应将账户、扣费流水、歌曲归属和播放令牌迁移到 D1/认证系统。

## 6. 歌词同步的准确度

`functions/api/music.js` 会请求 Treblo 歌词对齐，并读取供应商响应中的 LRC 或逐词时间戳；收到后收藏页使用真实字级同步。若结果接口没有提供时间戳，前端会明确标注“估算逐行同步”，它不能代替真实逐字对齐。

若产品要求每个字都与演唱声严格吻合，需要接入一个能返回时间戳的音乐供应商，或部署独立的音频强制对齐服务；仅靠歌词、BPM 和音频文件无法诚实地推导出每个字的真实唱出时刻。

## 5. 歌词适唱度

歌曲创作室会先生成结构化曲调（速度、调性、音符、拖音和每句音节位），再把同一份计划传给文本 AI 与音乐服务。手动歌词会在原输入框内标记灰体多余字和 `☆` 缺音节；点击试听时若有偏差会提示“歌词不符合曲调旋律，可能影响效果，建议修改”，用户可以返回修改或继续试听。
