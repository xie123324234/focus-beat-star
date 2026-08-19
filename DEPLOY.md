# Cloudflare Pages 部署说明

## 方式一：通过 GitHub 部署

1. 新建 GitHub 仓库，例如 `focus-beat-star`。
2. 上传本目录下的所有文件。
3. 打开 Cloudflare Dashboard。
4. 进入 Workers & Pages。
5. 选择 Create application。
6. 选择 Pages。
7. 连接 GitHub 仓库。
8. 选择项目仓库。
9. 使用以下配置：

```text
Framework preset: None
Build command: 留空
Build output directory: /
Root directory: 如果仓库根目录就是本项目，留空；如果本项目在 focus-beat 子目录，填写 focus-beat
```

10. 点击 Deploy。

## 方式二：通过 Wrangler 部署

安装 Wrangler 后，在本目录运行：

```bash
npx wrangler pages deploy . --project-name focus-beat-star
```

## 部署后检查

打开 Cloudflare Pages 生成的链接，检查：

- 首页是否正常显示。
- 点击“开始专注学习”是否能打开计划弹窗。
- 是否能进入全屏专注倒计时。
- 错题是否能保存。
- 练习题是否能答题。
- 歌曲创作室是否能生成歌词和试听旋律。
- 刷新页面后音符、错题、歌曲是否仍然存在。

## 后续接 Workers 的建议结构

```text
focus-beat/
  index.html
  functions/
    api/
      summary.js
      lyrics.js
      mistake-analysis.js
```

Cloudflare Pages Functions 可以作为轻量后端，用来代理 AI API，并避免把 API Key 暴露在前端。

