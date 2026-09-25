# BiliScribe

BiliScribe 是运行在 Windows 本地的 B 站视频下载与文字稿生成工具，通过本地后台服务和浏览器 Web UI 使用。

## 项目定义

- 支持单个视频链接及 UP 主主页解析；UP 主模式展示视频、合集/系列和合集内视频，并支持批量选择。
- 用户可选择下载完整视频、仅下载音频或转写文字稿。B 站解析、扫码登录和下载能力优先复用成熟开源项目，不重复实现。
- 下载和转写任务第一版采用单队列串行执行。
- 转写模型固定为 MiMo V2.6 Flash。文字稿面向八字课程，忠实保留原话，不总结、不重写；正式提示词后续提供。
- 完成的文字稿支持查看、复制和导出 TXT。
- 设置页提供 B 站登录状态、MiMo API Key、API 测试、下载目录和文字稿目录。
- Windows 普通使用时双击根目录的 `BiliScribe.vbs`，静默启动本地服务并打开默认浏览器；VBS 只负责启动和就绪检查。

## 当前阶段

当前已进入真实功能接入阶段：本地后台通过 BBDownNext 解析单个 B 站视频，向前端返回统一格式的视频信息；设置页支持 BBDownNext WEB 扫码登录并在本机持久保存凭据。UP 主主页、真实下载、音频下载、MiMo 转写和后台任务执行尚未接入，其余页面交互仍为原型数据。

## 运行

需要 Windows 和 Node.js 18 或更新版本。BBDownNext 可执行文件默认位于 `tools/BBDownNext/BBDown.exe`；也可在启动前设置 `BBDOWN_PATH` 指向其他位置。

普通使用：在已安装 Node.js 18 或更新版本、项目依赖已就绪的环境中，双击根目录的 `BiliScribe.vbs`。如果还没有构建页面，启动器会在后台执行构建；随后静默启动正式服务，并在健康检查通过后打开浏览器。

开发调试：先运行 `npm install` 安装依赖，再运行 `npm run dev` 同时启动本地后台和 Vite 页面：

```powershell
npm install
npm run dev
```

正式服务将前端页面和 API 一起托管在 `http://127.0.0.1:4174`；开发页面默认地址为 `http://127.0.0.1:5173`，API 后台端口为 `4174`。两种模式均仅监听本机回环地址。手动启动正式模式时先运行 `npm run build`，再运行 `npm run start`；缺少构建页面时 `start` 会给出清楚错误。`npm run dev:api` 和 `npm run dev:ui` 可分别启动开发后台和前端。日志写入 `logs/biliscribe.log`，超过大小上限会轮换。

解析使用 BBDownNext 的 `--info-only --hide-streams`，不触发下载；Vite 将同源 `/api` 请求转发给本地后台。执行 `npm run build` 可检查前端生产构建。
