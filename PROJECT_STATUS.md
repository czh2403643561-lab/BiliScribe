# Project Status

## 已完成

- MiMo 转写采用自适应音频准备、串行流式请求与逐段检查点；短视频真实测试已通过，未运行长课程测试。
- 设置页自动保存本机 API Key 与目录配置；Key 只以掩码状态显示。
- 单视频处理方式与创建按钮之间增加了 18px 间距。
- 八字转写提示词增加自然分段要求，明确不调整顺序、不总结或改写。
- 下载和转写任务持久化 startedAt、endedAt、durationMs；执行耗时不含队列等待，重试重新计时。
- 已完成历史行显示执行耗时；旧任务缺少 durationMs 时兼容隐藏。
- 完成的文字稿任务可通过稳定 transcriptId 点击打开对应正文；行内按钮阻止冒泡。
- 每次转写运行时将视频标题、UP 主和可用合集/系列名称附加到现有 Prompt 前；单视频与 UP 主批量任务均使用各自元数据，普通投稿不生成空合集信息，动态内容不写入日志。
- 新增本地音频导入入口与 Windows 原生多选/文件夹选择；本地 source 以授权引用创建现有串行 transcript task，复用 FFmpeg、MiMo、Prompt、checkpoint、任务中心和文字稿库。
- 本地音频支持 mp3、m4a、wav、flac、ogg；文件夹只扫描当前层级，标题可编辑，TXT 保存到“本地导入/课程名”或“本地导入/未分组”。本机路径只保存在后台状态中，任务 API 返回时会隐藏路径。
- MiMo 遇到 `repetition_truncation` 或 `length` 时只自适应拆分当前失败片段；整段请求仍优先，成功片段立即写入 checkpoint 并在重试时复用。动态拆分最小子段为 8 分钟，重复截断达到下限时显示明确的音频质量错误。
- 重复截断诊断日志只记录任务 ID、片段时长/层级、生成字符数、finish reason 和子段时长，不记录正文；纯数字用量字段使用 `completionTokenCount`。
- UP 主主页合集展开显示合集内全部子视频；搜索时仅显示合集内匹配项，合集勾选继续作用于当前匹配的视频。
- 展开的合集子视频列表使用视口适配的内部滚动区；合集标题栏保持在滚动区外可见，收起后不保留展开高度。

## 当前验证

- 本次 `npm run build`、`node --check server/api.js`、`node --test server/transcript-adaptive.test.js`（4 项模拟）和 `git diff --check` 通过。
- 合集分页修复后 `npm run build` 和 `git diff --check` 通过。
- 合集展开滚动体验优化后 `npm run build` 和 `git diff --check` 通过。
- production 服务由 `npm run start` 启动，健康接口与 `/api/tasks` 返回 200；浏览器中已验证来源切换和本地音频页面。
- 原生选择器子进程已启动；当前 UI 控制工具无法操作 Windows 原生窗口，因此未完成实际多选、文件夹扫描和不支持格式的交互验收。
- 未创建转写任务，未调用 MiMo，未运行长课程测试；BiliScribe.vbs 启动命令被本机执行策略拦截，未能验证本次构建的 VBS 启动。

## 下一步

- 在可控制 Windows 原生窗口的环境完成文件/文件夹选择及本地转写验收，并验证 VBS 启动。
- 后续通过真实音频观察自动缩片与 checkpoint 恢复；避免重复运行 77 分钟课程，短音频 `stop` 路径仍保持单次完整请求。
