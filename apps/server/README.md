# Flux Server

当前目录包含两个阶段的服务端目标：

1. `flux_server.py`：当前可运行的零依赖 MVP 服务端。
2. 正式 FastAPI 服务端：后续按照 `DEVELOPMENT_GUIDE.md` 拆分实现。

## 运行当前 MVP

```powershell
python apps/server/flux_server.py
```

默认访问地址：

```text
http://127.0.0.1:8787
```

## 正式依赖

正式服务端建议使用：

```text
fastapi
uvicorn
pydantic
sqlalchemy
alembic
python-jose
passlib
```

当前机器未安装这些依赖，因此暂未生成依赖锁文件。

