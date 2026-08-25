# 部署说明｜Focus Beat 本地拟唱版

## 本地验收

```powershell
npx wrangler pages dev .
```

看到 `Ready on http://127.0.0.1:8788` 后访问该地址即可。`Request.cf` 的本地警告可忽略。

## 环境变量

只需要文本 AI（可选）：

|变量|保存位置|说明|
|---|---|---|
|`AGNES_API_KEY`|Secret|Agnes 密钥|
|`AGNES_BASE_URL`|Text|Agnes API 地址|
|`AGNES_MODEL`|Text|模型名|
|`AI_PROVIDER`|Text|`agnes`|

本地拟唱不需要 Eleven、ACE、R2 或任何音乐 API Key。没有 Agnes 时，歌词和学习功能会使用离线回退。

## Cloudflare Pages

1. 将本文件夹作为 Pages 项目部署目录。
2. 在 Pages 的 Variables and Secrets 中添加 Agnes 变量（如需云端文字生成）。
3. 构建输出目录设为 `.`。
4. 不上传 `.dev.vars`。

## 音乐说明

歌曲收藏保存的是歌词、曲调蓝图与种子，之后由浏览器重新生成伴奏和拟唱；因此同一首歌在不同设备上可能有不同中文语音音色。Chrome 或 Edge 且已安装中文语音时体验更完整。
