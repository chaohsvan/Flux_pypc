# Flux
(vibe coding)

本项目采用 GNU General Public License v3.0 许可证开源，详见 [LICENSE](LICENSE)。

Copyright (C) 2026 chaohsvan
Flux 是一个本地优先的个人效率与生活记录系统，用来把日记、日历、待办、附件和回收站恢复放在同一个清晰的时间上下文里。

当前项目是一个可运行的 MVP：前端使用原生 Web，后端使用 Python 标准库 HTTP 服务，数据保存在本地 SQLite 数据库中，附件保存在本地文件系统中。整体目标是低依赖、易运行、易备份，并让个人数据始终可控。

## 核心能力

- 日记：支持 Markdown、标签、收藏、心情/天气/位置、全文搜索和导出。
- 日历：支持日、周、月、季度视图，以及“那年今日”“那年这月”等历史回看。
- 待办：支持任务、子任务、优先级、截止时间、拖拽排序、批量操作和历史记录。
- 节假日：支持默认周末、静态节假日数据和手动标记。
- 附件：支持图片、音频和普通文件上传，并可扫描引用关系。
- 回收站：日记、待办和日历事件采用软删除，支持恢复；日记恢复时可按日期合并。
- 导出：日记和待办支持 Markdown、JSON、CSV 等格式导出。

## 技术栈

| 层级 | 当前实现 |
| :--- | :--- |
| 前端 | HTML / CSS / Vanilla JavaScript |
| 后端 | Python 标准库 `http.server` |
| 数据库 | SQLite + FTS5 |
| 附件存储 | 本地文件系统 |
| 通信 | REST / JSON / multipart |

当前 MVP 不依赖 React、Vue、FastAPI、PostgreSQL、Redis 或外部搜索服务。

## 目录结构

```text
apps/
  client/
    web/
      index.html      # Web MVP 页面结构
      app.js          # 前端状态、渲染、交互和 API 调用
      styles.css      # 页面样式与响应式布局
    lib/
      main.dart       # Flutter shell 占位入口
  server/
    flux_server.py    # 当前可运行的 Python MVP 服务端
    requirements.txt  # 后续 FastAPI 服务端建议依赖
data/
  flux.db             # 本地 SQLite 数据库
  attachments/        # 日记附件文件
tools/
  import_static_holidays.py
vendor/
designREADME.md       # 产品与设计理念
featuresREADME.md     # 功能规格说明
technicalREADME.md    # 技术实现文档
```

## 快速开始

确保本机已经安装 Python 3，然后在项目根目录执行：

```powershell
python apps/server/flux_server.py
```

默认服务地址：

```text
http://127.0.0.1:8787
```

服务启动后会静态托管 `apps/client/web`，并通过 `/api/v1/*` 提供接口。

可选参数：

```powershell
python apps/server/flux_server.py --host 127.0.0.1 --port 8787 --db data/flux.db --static apps/client/web
```

## 数据与备份

Flux 的核心数据默认保存在：

- `data/flux.db`
- `data/attachments/`

备份时建议同时复制数据库文件和附件目录。附件不会写入 SQLite，而是以文件形式保存，并通过日记 Markdown 内容引用。

## 当前状态

当前可用版本是 Web MVP。`apps/client/lib/main.dart` 只是 Flutter 占位壳，后续可以在 Flutter 客户端方向继续演进；`apps/server/requirements.txt` 中列出的 FastAPI、SQLAlchemy、Alembic 等依赖也是后续正式服务端拆分方向，当前 MVP 运行不需要安装这些依赖。

## 文档入口

- `technicalREADME.md`：架构、API、数据库、状态机、测试矩阵、部署和演进建议。
- `featuresREADME.md`：日记、待办、日历、附件、导出和回收站的功能规则。
- `designREADME.md`：产品愿景、视觉语言、交互原则和体验风险。

## 设计原则

Flux 的核心判断是：一天不只是日期，它是生活的容器。

因此项目围绕“日期”组织日记、事件、待办、节假日、附件和历史恢复记录，让用户能按天回到自己的记忆、计划和行动上下文中。
