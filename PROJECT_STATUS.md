# Project Status

## 已完成

- MiMo 转写采用自适应音频准备、串行流式请求与逐段检查点；短视频真实测试已通过，未运行长课程测试。
- 设置页自动保存本机 API Key 与目录配置；Key 只以掩码状态显示。
- 单视频处理方式与创建按钮之间增加了 18px 间距。
- 八字转写提示词增加自然分段要求，明确不调整顺序、不总结或改写。
- 下载和转写任务持久化 startedAt、endedAt、durationMs；执行耗时不含队列等待，重试重新计时。
- 已完成历史行显示执行耗时；旧任务缺少 durationMs 时兼容隐藏。
- 完成的文字稿任务可通过稳定 transcriptId 点击打开对应正文；行内按钮阻止冒泡。

## 当前验证

- `npm run build`、`node --check server/api.js`、`git diff --check` 通过。
- 正式 `BiliScribe.vbs` 重启成功；production 健康接口与 `/api/tasks` 均返回 200。
- 本次未运行任何转写任务或长视频测试。

## 下一步

- 等待用户确认后再进行完整课程转写测试。
