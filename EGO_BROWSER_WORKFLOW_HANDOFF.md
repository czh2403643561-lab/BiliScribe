# Ego 浏览器页面解析与扩展工作流交接

记录日期：2026-11-04。本文供新项目的 Agent 对话接手时使用。

## 本轮验证结论

### 已验证：后台页面解析

- Ego 可通过 `ego-browser` 的 `Page` API 导航、读取可访问性快照和执行只读 DOM 查询，不需要用鼠标键盘控制桌面。
- Wikipedia 页面读取结果：标题 `Browser extension - Wikipedia`，7 个标题节点、6 张图片、644 个链接、29 个按钮。
- 1688 首页可正常打开，标题为 `阿里1688首页`，页面显示问候语。DOM 查询得到 155 张图片、110 个链接、5 个按钮、58 个输入框。
- Agent Space 窗口当时处于最小化状态，DOM 查询仍可正常运行；截图接口不能对最小化窗口截图。

### 未验证：自定义扩展的无人值守安装

- Ego 可以打开 `chrome://extensions`，并能读取“加载未打包扩展程序”“重新加载”“移除”等管理入口。
- Ego 的 `task.cdp()` 只接受 `Target.*` 和 `Browser.*` 命令；`page.cdp('Extensions.getExtensions')` 返回 `Method not available`。因此目前不能通过 Ego 暴露的 CDP 接口调用 Chrome 的扩展安装命令。
- 点击“加载未打包扩展程序”后，`page.waitForFileChooser()` 等待 10 秒超时；扩展管理页没有可由 `setInputFiles()` 设置的文件输入框。本轮没有完成扩展安装、扩展内扫描、重载或卸载的端到端验证。
- Chrome 官方文档列出了开发者模式下加载本地扩展的流程；DevTools Protocol 也定义了 `Extensions.loadUnpacked`、`Extensions.uninstall` 等命令，但当前 Ego API 没有向 Agent 开放该扩展命令域。[Chrome 加载本地扩展说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) · [CDP Extensions 命令](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)
- 浏览器中已有 CrawlHub 扩展，本轮未修改、重载或移除它。

因此，Agent 通过 Ego 在后台解析页面已经验证；Agent 自动安装、重载、调用和删除自定义扩展仍未跑通。新对话应把这两项能力分开推进。

## 本地组件地址

- 项目仓库：`C:\Users\Atlas\Documents\Bilibili Downloader`
- 页面结构探针源码：`C:\Users\Atlas\Documents\Bilibili Downloader\ego-page-inspector\`
- 探针清单：`C:\Users\Atlas\Documents\Bilibili Downloader\ego-page-inspector\manifest.json`
- 探针脚本：`C:\Users\Atlas\Documents\Bilibili Downloader\ego-page-inspector\content.js`
- Ego CLI：`C:\Users\Atlas\.local\share\ego\active_version_dir\ego-browser.exe`；当前版本 `ego-browser 0.6.2.7`，Chromium `156.0.8078.74`。
- Ego 使用说明：`C:\Users\Atlas\.agents\skills\ego-browser\SKILL.md`；浏览器任务开始前运行 `ego-browser skill`，以当前安装版本的输出为准。

探针只匹配 `1688.com`、`*.1688.com` 和 `*.wikipedia.org`。它计划在页面右下角添加“分析此页结构”按钮，点击后读取页面标题、URL、标题层级、语义区域计数、一级容器和图片样本；不发送网络请求。Manifest 与 JavaScript 语法已通过静态检查，但扩展未安装，所以页面注入效果尚未验证。

## 复制到新项目

在新项目对话中，把整个 `ego-page-inspector` 文件夹复制到新项目工作区。加载时选择**包含 `manifest.json` 的文件夹本身**，不要选择仓库根目录。例如：

```powershell
$source = 'C:\Users\Atlas\Documents\Bilibili Downloader\ego-page-inspector'
$projectRoot = 'C:\path\to\new-project'
$destination = Join-Path $projectRoot 'ego-page-inspector'
Copy-Item -LiteralPath $source -Destination $destination -Recurse
```

若新项目在不同电脑或 Windows 用户下，上面的绝对路径要按实际位置调整。

## Ego 页面解析调用方式

在 PowerShell 中通过 Ego CLI 启动浏览器脚本；单行参数内使用 JavaScript 单引号，避免 Windows PowerShell 改写引号：

```powershell
ego-browser nodejs -e "const task = await taskSpace('inspect-1688-structure'); const page = task.page('p1'); await page.goto('https://www.1688.com'); console.log(await page.info()); console.log(await page.snapshot());"
```

`page.snapshot()` 适合先读当前视口的语义结构；`page.snapshot({ scope: 'full_page' })` 可读取整页可访问性树；`page.evaluate()` 可批量统计 DOM，抽取标题、链接、图片等字段。新任务使用唯一的 TaskSpace 名称，并按 Ego Skill 的说明复用该空间。优先从快照选择语义元素；只有 DOM 语义不足时才用截图与坐标。

## 探针扩展的预期用法

如后续 Ego 提供可编程扩展加载或目录选择接口：在 `chrome://extensions` 加载本地 `ego-page-inspector` 文件夹，重新打开目标标签页，点击页面右下角“分析此页结构”。修改扩展脚本后，在扩展管理页点该扩展自己的“重新加载”，再刷新目标标签页；测试完成后只移除该探针扩展，不触碰 CrawlHub。
