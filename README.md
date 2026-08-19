# Focus Beat Star

一个借鉴 TRAE 复赛案例「Focus Beat 专注节拍星球」产品思路的纯前端 Demo。

## 项目定位

Focus Beat Star 面向 6-12 岁小学生的放学后学习场景，把番茄钟、节拍感、音符奖励、错题记录和歌曲创作组合成一个完整的专注学习闭环。

当前版本是可直接部署到 Cloudflare Pages 的纯前端原型，不依赖后端、不依赖数据库、不需要 API Key。

## 已实现功能

- 专注计划生成：支持轻松、标准、深度三种预设，也支持自定义时长、休息、段数。
- 段落编辑：每段学习内容、专注分钟、休息分钟都可以修改。
- 全屏专注：倒计时、进度条、节拍球、暂停、跳过、结束。
- 音符奖励：专注、记录错题、答题练习都可以获得音符。
- 错题记录：本地保存学科、难点标签和错题内容。
- 举一反三：内置语文、数学、英语本地题库。
- 今日总结：根据本地专注、音符、错题数据生成总结。
- 每周任务：提供一周学习安排模板。
- 歌曲创作：生成歌词、Web Audio 试听旋律、消耗音符保存歌曲。
- 音符收藏册：本地保存已创作歌曲。

## 技术栈

- HTML
- CSS
- JavaScript
- localStorage
- Web Audio API

## 本地运行

直接打开 `index.html` 即可运行。

也可以用任意静态服务器预览，例如：

```bash
npx serve .
```

## Cloudflare Pages 部署

Cloudflare Pages 纯静态部署配置：

- Framework preset: None
- Build command: 留空
- Build output directory: `/`
- Root directory: `focus-beat`，如果仓库根目录就是本项目，则留空

部署完成后，Cloudflare Pages 会生成一个线上访问链接。

## 数据说明

当前版本所有数据都保存在浏览器本地 `localStorage` 中：

- 总音符
- 今日专注分钟
- 今日音符
- 错题记录
- 歌曲收藏
- 当前专注计划

清空浏览器数据或换浏览器后，本地数据不会同步。

## 后续升级方向

- 接入 Cloudflare Workers，统一代理 AI API。
- 使用 Cloudflare KV 保存轻量用户数据。
- 使用 Cloudflare D1 保存错题、歌曲和学习记录。
- 增加登录能力，支持多设备同步。
- 接入 AI 生成错题分析、每日总结、周计划和歌词。
- 将多个 TRAE 案例复刻 Demo 整合成一个案例合集站。

