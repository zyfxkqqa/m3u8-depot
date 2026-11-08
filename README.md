# m3u8-depot

本地 HLS 播放列表下载器，带浏览器任务管理界面。浏览器只负责提交和管理任务，实际的解析、下载、封装与任务持久化全部由本地 Node.js 服务执行，因此刷新或关闭页面不会中断服务端任务。

> **使用前请阅读 [`DISCLAIMER.md`](DISCLAIMER.md)。** 本项目不提供、不托管任何音视频内容，仅限个人学习与技术研究使用，严禁商业用途。使用者须自行确保对所下载内容拥有合法权利。

当前版本：`v1.3.0`

## 特性

- **双引擎下载**：默认多线程并发拉取，失败自动回退单连接
- **任务队列**：并发调度、暂停、删除、失败重试，状态持久化并可跨重启恢复
- **原子落盘**：先写临时文件，成功后再提交为正式文件，不会留下看似完成的半成品
- **合集归类**：详情页批量下载按剧名自动建立子目录，单片直接落在根目录
- **零运行时依赖**：仅使用 Node.js 内置模块，`npm install` 不是必需的
- **本地优先**：仅监听 `127.0.0.1`，带同源校验，不对外暴露

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | 20 或更高版本 |
| 操作系统 | Windows（`start.bat` 为 Windows 脚本；其他平台可直接 `node server.js`） |
| FFmpeg | 已随项目放在 `tools/ffmpeg.exe`，无需单独安装 |
| N_m3u8DL-RE | 已随项目放在 `tools/N_m3u8DL-RE.exe`，无需单独安装 |

## 快速开始

```cmd
start.bat
```

脚本会探测 Node.js、启动服务并自动打开浏览器：

```text
http://127.0.0.1:17892
```

也可以手动启动：

```cmd
node server.js
```

## 配置

所有路径均有跨平台默认值，无需任何配置即可运行。需要自定义时，有两种方式。

**方式一：环境变量**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `M3U8_DOWNLOADER_PORT` | `17892` | 服务端口 |
| `M3U8_OUTPUT_DIR` | `~/Downloads/M3U8` | 输出目录 |
| `FFMPEG_PATH` | `tools/ffmpeg.exe` | FFmpeg 路径，缺失时回退到 PATH |
| `M3U8_N3U8DL_PATH` | `tools/N_m3u8DL-RE.exe` | 多线程引擎路径 |
| `M3U8_DATA_DIR` | `data/` | 任务记录目录 |
| `M3U8_TASKS_FILE` | `data/tasks.json` | 任务记录文件 |
| `M3U8_DOWNLOAD_ENGINE` | `n3u8` | `n3u8` 或 `ffmpeg` |
| `M3U8_DOWNLOAD_THREADS` | `16` | 并发线程数，1–64 |
| `M3U8_MAX_ACTIVE_TASKS` | `2` | 同时下载的任务数，1–32 |
| `M3U8_PARSE_CONCURRENCY` | `4` | 解析并发数，1–64 |

**方式二：`env.local.bat`**

在项目根目录新建 `env.local.bat`（已被 `.gitignore` 忽略），写入个人配置：

```bat
set M3U8_OUTPUT_DIR=D:\Downloads
set M3U8_DOWNLOAD_THREADS=16
```

`start.bat` 会自动加载它。

## 输出目录结构

详情页批量下载（电视剧、综艺等合集）按剧名建立子目录；播放页单条解析（电影）直接放在输出根目录。

判断依据是任务是否带批次信息：详情页批量提交会生成批次标识，单条解析不会。目录名取剧名，缺失时退化为线路名，再退化为「合集」。

```text
<输出目录>\
├── 单条解析的影片.mp4
└── 合集名称\
    ├── 合集名称 第01集.mp4
    ├── 合集名称 第02集.mp4
    └── 合集名称 第03集.mp4
```

同一合集分多次批量下载时，只要剧名一致，会归入同一个目录。目录名中的非法字符按与文件名相同的规则清洗。

## 下载引擎

下载层采用双引擎：默认使用 `N_m3u8DL-RE` 多线程并发拉取分片，遇到格式或加密层面的永久错误时自动回退到 FFmpeg 单连接。

| 引擎 | 实测速度 | 说明 |
| --- | --- | --- |
| `N_m3u8DL-RE`（默认，16 线程） | 峰值约 20 MB/s | 按连接数并发拉取，突破源站单连接限速 |
| FFmpeg 单连接（回退） | 约 1.2 MB/s | HLS demuxer 串行拉取，兼容性最好 |

实测依据：一部 114 分钟、3434 个分片、809 MB 的影片，FFmpeg 单连接需 16–20 分钟；多线程引擎下载约 75 秒，合并与封装约 60 秒，全程约 2.5 分钟。

### 两阶段流程

1. **下载与合并**：`N_m3u8DL-RE` 以 16 线程把分片拉取到 `<输出目录>/.n3u8tmp/<任务短码>/`，合并为中间文件
2. **转封装**：FFmpeg 以 `-c copy` 无损封装为 `.mp4`，只取首路视频与首路音频，避免源流多轨被重复写入

中间产物全部位于 `.n3u8tmp` 下，任务提交或失败后整目录删除。

### 直连策略

所有下载子进程强制直连，不受系统代理影响：

- `N_m3u8DL-RE` 显式传 `--use-system-proxy false`（.NET 默认会读取系统代理）
- 子进程启动时清空 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等变量，并注入 `NO_PROXY=*`
- `start.bat` 启动时同样清空代理变量

### 进度采集

进度不依赖引擎的 stdout（管道下会被缓冲），而是轮询临时目录的实际落盘量，因此进度显示与看门狗判定不受输出缓冲影响。

## 站点适配示例

站点解析规则位于 `lib/sites/`，每个适配器实现 `matches` / `parsePlay` / `parseDetail` 三个方法。未匹配到专用适配器时，会退化为通用 MACCMS 解析器 `common-maccms.js`。

以下为已适配的页面结构示例，仅用于验证解析逻辑：

| 站点 | 播放页 | 详情页 |
| --- | --- | --- |
| kxmp4 | `https://www.kxmp4.com/play/378302-6-2.html` | `https://www.kxmp4.com/detail/378301.html` |
| maliys | `https://www.maliys.com/yun/64204-4-1.html` | `https://www.maliys.com/html/64204.html` |
| ZJLQZG | `https://www.zjlqzg.com/tianlangtv/193253-1-1.html` | `https://www.zjlqzg.com/tianlangyy/193253.html` |

适配器基于 MACCMS 页面结构，不代表自动支持所有使用相似模板的站点。新增站点时，可参考现有适配器实现，并在 `lib/url-policy.js` 的 `DEFAULT_HOSTS` 中加入域名。

## 下载可靠性

- 任务状态持久化采用节流、串行和原子替换，保留备份并支持损坏恢复
- 服务重启时，遗留的未完成任务会恢复到可调度状态并继续处理
- 下载引擎先写入带任务短码的唯一 `.part.mp4`，成功后再提交为正式 `.mp4`，避免把半成品当作完成文件
- 并发同名任务会预留不同输出路径，例如 `标题.mp4`、`标题 (2).mp4`
- 仅明确的临时网络错误会自动重试，最多两次；取消、解析错误、持久化错误和永久 FFmpeg 错误不会自动重试
- 重试前会重新解析播放页刷新播放地址，以应对签名地址过期
- 停止或删除运行中任务会等待子进程退出并清理临时文件
- 运行日志达到 5 MB 后轮换，最多保留三份

## 测试

项目没有运行时 npm 依赖。测试均使用临时目录、随机端口和模拟子进程，不会读取或修改正式任务、视频和日志。

```cmd
npm run check
npm test
npm run smoke
```

- `check`：递归检查项目内 JavaScript 和 ES module 语法
- `test`：依次运行语法检查与全部冒烟测试，每项最长 30 秒
- `smoke`：隔离启动、健康接口、静态入口和版本一致性检查

## 模块结构

- `server.js`：应用初始化、路由注册、启动和关闭
- `routes/`：健康、解析和任务 API
- `lib/http/`：请求体、JSON 响应和静态文件服务
- `lib/sites/`：通用 MACCMS 解析及站点适配器
- `lib/task-store.js`：任务持久化与恢复
- `lib/scheduler.js`：并发调度、取消、删除和重试
- `lib/downloader.js`：下载引擎编排与 FFmpeg 回退
- `lib/n3u8-engine.js`：N_m3u8DL-RE 参数构建、进度解析与错误分类
- `lib/ffmpeg-runner.js`：下载子进程生命周期、进度、看门狗与错误处理
- `lib/output-manager.js`：输出路径预留、原子提交与安全清理
- `static/js/`：原生 ES modules 管理页面
- `test/`：冒烟测试与统一运行器
- `tools/`：随项目分发的 FFmpeg 与 N_m3u8DL-RE

## 许可证

代码以 [MIT](LICENSE) 授权。使用限制与免责条款见 [`DISCLAIMER.md`](DISCLAIMER.md)。

## 第三方组件

- **FFmpeg**：版权归 FFmpeg 项目及其贡献者所有，依据 LGPL/GPL 分发。源码见 <https://ffmpeg.org/download.html>。本项目仅做打包分发，未修改源代码。许可证全文见 `tools/FFMPEG-LICENSE.txt`。
- **N_m3u8DL-RE**：版权归其作者所有，详见 <https://github.com/nilaoda/N_m3u8DL-RE>。
