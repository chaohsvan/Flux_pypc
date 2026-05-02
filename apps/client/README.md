# Flux Client

当前目录先提供一个浏览器端 MVP 原型：

```text
apps/client/web
```

它由 `apps/server/flux_server.py` 静态托管，启动服务端后访问：

```text
http://127.0.0.1:8787
```

正式 Flutter 客户端后续建议建立在以下结构上：

```text
apps/client/lib/
  app/
  core/
  shared/
  features/
    diary/
    todo/
    calendar/
    analytics/
```

当前机器未安装 Flutter SDK，所以暂未生成完整 Flutter 工程。

