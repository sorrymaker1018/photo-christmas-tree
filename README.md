# 照片圣诞树（Photo Christmas Tree）

在线使用：https://sorrymaker1018.github.io/photo-christmas-tree/

用手机浏览器（Safari / Chrome）打开即可：

- 从相册导入照片，照片挂满 3D 圣诞树
- 导入的照片保存在手机浏览器本地（IndexedDB），刷新或下次打开自动加载
- 点开照片后可以「保存」到相册，或「分享」发出去
- **生成分享链接**：把这批照片上传到云端，得到一条带随机口令的独立链接，只有拿到链接的人能打开看；30 天后自动失效
- 「分享记录」里可以随时复制或撤销自己发过的链接
- 手机摄像头手势：握拳聚成树、张开手掌散开、手掌左右移动旋转；打开某张照片后，拇指与食指张开放大 / 收拢缩小
- 点照片全屏查看，可拖动旋转、双指缩放
- 低配手机自动进入轻量模式（也可用 `?lite=1` 强制开启）

## 隐私说明

- 不点「生成分享链接」时，照片只留在本机浏览器里，不会上传
- 点「生成分享链接」时，会把这批照片上传到 Cloudflare（Pages + KV），只保存 30 天
- 分享链接里的口令是 10 位随机串，猜不到；撤销后对方立即看不到
- 仓库是公开的，但没有任何账号密钥：Cloudflare 令牌只在你本机使用，不写进代码

## 分支

| 分支 | 内容 |
| --- | --- |
| `main` | 构建后的静态网页（GitHub Pages 发布这个分支的根目录） |
| `source` | 源码、`public` 资源、构建配置与分享后端源码（`server/`） |

## 重新构建

```bash
npm install
npm run build
```

把 `dist/` 内容更新到 `main` 分支根目录并推送即可重新发布。

## 分享后端

- 线上地址：`https://photo-tree-share.pages.dev`（Cloudflare Pages + KV）
- 源码：`server/_worker.js`，配置：`server/wrangler.toml`
- 接口：`POST /api/share`、`GET /api/share?id=`、`GET /api/photo?id=&i=`、`DELETE /api/share?id=&k=`
- 重新部署：在 `server/` 里执行 `npx wrangler pages deploy public --project-name photo-tree-share`

## 手势资源

- `public/models/gesture_recognizer.task`：MediaPipe 手势模型
- `public/mediapipe/wasm/`：MediaPipe 运行时（本地加载，不依赖外网 CDN）

## 来源

基于开源项目 `moleculemmeng020425/christmas-tree` 改造，仅供个人使用。
