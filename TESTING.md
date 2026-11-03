# 本机自动化验收

## 启动隔离测试环境

在 PowerShell 中运行：

```powershell
$env:BILISCRIBE_TEST_MEDIA_DIR = '本机测试音视频文件夹的完整路径'
npm run test:local
```

打开 `http://127.0.0.1:5174/`。按 `Ctrl+C` 关闭测试服务。测试后台使用 4175 端口、`.biliscribe-test` 独立数据/输出目录，不读取正式实例的 MiMo Key、任务、检查点或文字稿。

进入“新建任务”→“本地音视频”，可用“载入最短测试样例”从配置目录导入最短文件，也可使用测试页上的浏览器文件控件直接上传 MP3、M4A、WAV、FLAC、OGG 或 MP4（单个不超过 100 MB）。测试上传仅写入隔离目录。然后点击“创建转写任务”。后台只查看配置目录当前层级的支持媒体，按 FFprobe 读取的时长选择最短文件；原目录文件只读保留。FFmpeg 会处理媒体音轨，随后写入确定的模拟文字稿。

测试环境页面会标明“模拟转写，不调用 MiMo”。不产生 MiMo API 费用；仍会占用本机 CPU/磁盘进行媒体检查与 FFmpeg 音频处理。模拟文字稿用于验收页面流程，不代表对样例语音进行了识别。

## 样例与预期

- 未配置 `BILISCRIBE_TEST_MEDIA_DIR` 时使用仓库自带的 `fixtures/automation-sample.mp4`；该音视频由本地 Windows 语音合成和 FFmpeg 生成，适合可重复的模拟验收。
- 配置目录后自动选择其中时长最短、FFprobe 可读取的当前层级媒体。预期：导入列表显示样例文件名/时长；任务显示“模拟转写处理中”；任务完成后文字稿显示 `fixtures/expected-transcript.txt` 的内容。
- 测试无法验证真实 MiMo 转写质量、B 站登录/下载或真实 API 费用。

页面包含可访问名称和稳定的 `data-testid`，便于 ego(lite) 按链接输入、样例导入、创建任务、状态和文字稿结果进行操作。

仓库内 `scripts/ego-smoke-test.mjs` 会通过 ego(lite) 浏览器上传自制样例、检查处理中状态、等待任务完成并打开文字稿；运行前先按上面的方式启动隔离环境。
