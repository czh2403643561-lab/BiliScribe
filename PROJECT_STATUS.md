# Project Status

## 已完成

- BiliScribe 支持 B 站解析、UP 主视频批量选择、串行下载与 MiMo 文字稿；文字稿可在库中查看、复制、导出，并按本地批次归档。
- 本地 MP3、M4A、WAV、FLAC、OGG、MP4 可导入转写；FFmpeg 提取/规范音频，自适应分段和 checkpoint 支持恢复。
- 设置、API Key、任务和文字稿保存在本机；B 站登录信息由 BBDownNext 管理。
- 新增本机隔离测试环境：独立端口和数据目录，不读取、保存或发送正式 MiMo Key；支持浏览器文件上传及从指定文件夹选最短可读媒体。转写结果固定为样例文字，不调用 MiMo。
- `TESTING.md` 记录通用运行步骤；本机交接 `TEST_HANDOFF.local.md`（仅本机忽略）含用户提供的测试素材位置。ego(lite) 回归脚本为 `scripts/ego-smoke-test.mjs`。

## 当前验证

- `node --check`、`npm run build`、`git diff --check` 通过；现有相关 Node 测试 24 项全部通过。
- ego(lite) 已通过浏览器文件控件上传自制 MP4，看到处理中状态、完成任务并打开预期文字稿；测试文件目录的最短媒体载入也已验证。
- 测试服务地址 `http://127.0.0.1:5174/`，API 端口 4175；真实 MiMo 转写、真实 B 站下载及费用未测试。

## 下一步

- Agent 可按 `TEST_HANDOFF.local.md` 在用户指定的素材目录挑最短视频，通过本地 FFmpeg 与模拟文字稿继续验收；不会产生 MiMo API 费用。
- 若要验收真实 B 站或 MiMo 流程，需切回正式环境；真实转写会产生 API 费用。
