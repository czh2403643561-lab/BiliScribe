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
- 本地导入扩展为“本地音视频”，支持 MP4；每个任务通过 FFmpeg 只提取第一条音轨并按 AAC/16 kHz/单声道/32 kbps 生成任务目录内的 M4A。MP4 无音轨、不可读或解码失败时任务会明确失败并继续队列；成功清理该任务工作目录，原始媒体保留。
- Windows 原生文件/文件夹选择器使用置顶宿主窗口，避免弹窗藏在浏览器后面；页面关闭时终止相应子进程，并限制同一时间只打开一个选择器，选择超时会返回错误。
- MiMo 遇到 `repetition_truncation` 或 `length` 时只自适应拆分当前失败片段；整段请求仍优先，成功片段立即写入 checkpoint 并在重试时复用。动态拆分最小子段为 8 分钟，重复截断达到下限时显示明确的音频质量错误。
- 重复截断诊断日志只记录任务 ID、片段时长/层级、生成字符数、finish reason 和子段时长，不记录正文；纯数字用量字段使用 `completionTokenCount`。
- MiMo `content_filter` 会自动二分当前失败片段，左右子片段继续走现有串行转写和 checkpoint；按 content-filter 专属递归深度最多拆 4 层，失败时记录音频时间范围并显示明确提示。
- 音频段 checkpoint 保存源音频时间范围；content-filter 拆分有 `content_filter_split_start`、`content_filter_split_success`、`content_filter_split_failed` 三类诊断事件，不记录转写正文。
- MiMo 转写 Prompt 明确要求纯文字且禁止时间戳、说话人标签和会议纪要格式；输出清理只剥除行首时间范围与 `SPEAKER_nn:` 前缀，不改正文。
- MiMo 调试日志补充任务内部音频路径、媒体参数、模型/Prompt 版本/片段范围，以及有界输出摘要；异常结束时附重复度与最多 200 字符的重复片段样例，并统一记录 content_filter、repetition_truncation、length 的失败时间范围。
- MiMo 非 2xx 响应会在最多读取 8 KiB、最多等待 2 秒后记录 HTTP 状态、服务端错误代码/类型、脱敏消息和可用请求 ID；界面继续显示安全错误提示，不记录请求内容或凭据。
- 经授权的长度诊断中，失败首段（约 76 分钟）返回 HTTP 400 / `Param Incorrect`；从同一音频生成的 10 分钟与 30 分钟片段均获 HTTP 200。仅对 HTTP 400 且消息精确为 `Param Incorrect` 启用现有串行自适应拆分，沿用 8 分钟下限、10 层上限、checkpoint 和既有顺序合并。
- 自适应拆分改为从原片段按明确起点和时长生成两个 M4A；两段均通过文件大小、FFprobe 音轨参数及实际时长验证后才替换 checkpoint。失败时回滚本次子文件并保留原片段与 checkpoint；拆分日志记录切分点、生成数、时长、大小及有界 FFmpeg 错误信息。content_filter、length、repetition_truncation 和 Param Incorrect 共用该流程。
- MiMo V2.6 Flash 单次最大输出上限提高到 131072 tokens，其余转写配置保持不变。
- UP 主主页合集展开显示合集内全部子视频；搜索时仅显示合集内匹配项，合集勾选继续作用于当前匹配的视频。
- 展开的合集子视频列表使用视口适配的内部滚动区；合集标题栏保持在滚动区外可见，收起后不保留展开高度。
- UP 主解析页“投稿视频”统计使用完整 `creatorData.videos.length`；合集/系列统计保持合集数量。

## 当前验证

- 自适应拆分及相关现有单元测试 24 项通过，包括 4570.048 秒合成音频实际拆成两段、FFprobe 检查、checkpoint 时间范围存在毫秒级偏差、第二段晋升失败时回滚；`node --check server/api.js`、`npm run build`、`git diff --check` 通过。未调用 MiMo API。
- production 后端已重启，健康接口返回 200；文件和文件夹弹窗均实际创建且处于置顶状态，关闭后 API 返回取消；并发请求返回 409，页面请求中断后未遗留选择器子进程。
- 尚未在原生弹窗中实际选择文件或文件夹，因此多选、当前层级扫描及 MP4 导入交互仍待人工验收。
- 本次未运行完整长课程转写；BiliScribe.vbs 启动命令被本机执行策略拦截，尚未完成 VBS 启动验证。

## 下一步

- 在可控制 Windows 原生窗口的环境完成文件/文件夹选择及本地转写验收，并验证 VBS 启动。
- 用原失败任务重试，验证 `Param Incorrect` 触发细分后的真实转写、checkpoint 恢复和最终文字稿顺序；诊断测试的 200 响应未完成完整转写。
- 后续可在短音频上观察 content-filter 自动拆分与恢复；不要用长课程重复测试。
- MP4 尚未在 BiliScribe 界面中进行 Windows 原生文件/文件夹导入与完整队列验收；75 个任务的真实批量创建/串行执行和真实 MiMo 转写也未进行。
