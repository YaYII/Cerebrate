# Cerebrate v5 — 脑虫 Brain Server
# ==============================
# 用法:
#   make build    # 构建 Docker 镜像
#   make up       # 启动服务 (前台)
#   make up-d     # 启动服务 (后台)
#   make down     # 停止服务
#   make restart  # 重启服务
#   make logs     # 查看日志
#   make ps       # 查看状态
#   make shell    # 进入容器 shell
#   make test     # 运行测试套件
#   make clean    # 停止并清理

include .env
export

.PHONY: build up up-d down restart logs ps shell test clean

build:
	docker compose build --no-cache

build-fast:
	docker compose build

up:
	docker compose up

up-d:
	docker compose up -d

down:
	docker compose down

restart: down up-d

logs:
	docker compose logs -f

ps:
	docker compose ps

shell:
	docker compose exec cerebrate /bin/bash

test:
	docker compose exec cerebrate python3 -m pytest tests/ -v

smoke:
	@echo "=== 烟雾测试: 检查脑虫服务 ==="
	@curl -s http://127.0.0.1:8765/v1/sense | python3 -m json.tool
	@echo ""
	@echo "=== 帮助: 查看可用 API ==="
	@curl -s http://127.0.0.1:8765/v1/help | python3 -m json.tool

clean: down
	@echo "清理构建缓存..."
	docker system prune -f --filter label=stage=cerebrate
