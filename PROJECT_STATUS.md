# Project Status

## 当前成果

- BiliScribe 支持 B 站视频解析、批量任务、串行下载与 MiMo 文字稿；本地 MP3、M4A、WAV、FLAC、OGG、MP4 可通过同一转写流程处理。
- 音视频使用 FFmpeg 规范化；任务专属 checkpoint 支持失败恢复，成功后保存 TXT 并清理该任务工作文件。
- 新增技术交接文档 [`docs/TRANSCRIPTION_TECHNICAL_OVERVIEW.md`](docs/TRANSCRIPTION_TECHNICAL_OVERVIEW.md)，说明当前实现、已发现问题及未来 Codex Agent 直连本机处理服务的建议。
- 隔离测试环境 `npm run test:local` 不读取正式 MiMo Key，以模拟文字稿验收页面流程；ego(lite) 已完成浏览器导入、处理、查看结果的冒烟验证。

## 当前验证与限制

- 上一轮代码验证：语法检查、前端构建、`git diff --check` 通过；相关 Node 测试 24 项通过。
- 测试环境地址为 `http://127.0.0.1:5174/`，后台端口 4175；不产生 MiMo API 费用。真实 MiMo 转写、真实 B 站下载及 75 个真实任务的压力验收未完成。
- 当前本地转写任务创建依赖 Windows 文件选择器产生的短时 selectionId，尚无面向 Agent 的无界面路径导入接口。
- Ego 自定义扩展的全自动安装/调用验证仍受 Ego 未开放的扩展 API 限制；CrawlHub 未改。
- Ego 页面解析和扩展能力交接文档见 `EGO_BROWSER_WORKFLOW_HANDOFF.md`，含 CLI、Skill、探针源码地址及新项目复制方式。

## 下一步

- 如决定让 Codex Agent 无网页操作，增加复用现有串行队列与转写执行器的本机 CLI 或 Agent 适配层，并加入重复提交保护。
- 若需验证真实 B 站或 MiMo 流程，需使用正式环境；真实 MiMo 请求会产生 API 费用。
