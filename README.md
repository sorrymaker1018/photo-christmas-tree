# 照片圣诞树（Photo Christmas Tree）

在线使用：https://sorrymaker1018.github.io/photo-christmas-tree/

用手机浏览器（Safari / Chrome）打开即可：

- 从相册导入照片，照片挂满 3D 圣诞树（照片只在浏览器本地处理，不上传）
- 导入的照片保存在手机浏览器本地（IndexedDB），刷新或下次打开自动加载，不用重新选图
- 点开照片后可以“保存”到相册或“分享”发出去，对方打开就能直接看
- 手机摄像头手势：握拳聚成树、张开手掌散开、手掌左右移动旋转
- 打开某张照片后，拇指与食指张开放大 / 收拢缩小
- 点照片全屏查看，可拖动旋转、双指缩放
- 低配手机自动进入轻量模式（也可用 `?lite=1` 强制开启）

## 分支

| 分支 | 内容 |
| --- | --- |
| `main` | 构建后的静态网页（GitHub Pages 发布这个分支的根目录） |
| `source` | 源码、`public` 资源与构建配置 |

## 重新构建

```bash
npm install
npm run build
```

把 `dist/` 内容更新到 `main` 分支根目录并推送即可重新发布。

## 手势资源

- `public/models/gesture_recognizer.task`：MediaPipe 手势模型
- `public/mediapipe/wasm/`：MediaPipe 运行时（本地加载，不依赖外网 CDN）

## 来源

基于开源项目 `moleculemmeng020425/christmas-tree` 改造，仅供个人使用。
