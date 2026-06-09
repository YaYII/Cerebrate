# Cerebrate v5 — 脑虫 Brain Server
# ==============================
# 用法:
#   make build      # 构建 Docker 镜像
#   make up         # 启动服务 (生产，后台)
#   make up-dev     # 启动服务 (开发，后台 + 代码挂载)
#   make up-pro     # 启动服务 (生产强化，后台)
#   make down       # 停止服务
#   make restart    # 重启服务 (生产)
#   make restart-dev # 重启服务 (开发，无需 rebuild)
#   make logs       # 查看日志
#   make ps         # 查看状态
#   make shell      # 进入容器 shell
#   make test       # 运行测试套件
#   make clean      # 停止并清理

include .env
export

# ── Compose 文件组合 ──
COMPOSE_BASE     = -f docker-compose.yml
COMPOSE_DEV      = $(COMPOSE_BASE) -f docker-compose.dev.yml
COMPOSE_PRO      = $(COMPOSE_BASE) -f docker-compose.pro.yml

.PHONY: build build-fast up up-dev up-pro down restart restart-dev \
        logs ps shell test smoke clean

# ── 构建 ──

build:
	docker compose build --no-cache

build-fast:
	docker compose build

# ── 启动 ──

up:
	docker compose up -d

up-dev:
	docker compose $(COMPOSE_DEV) up -d --build

up-pro:
	docker compose $(COMPOSE_PRO) up -d

# ── 停止 ──

down:
	docker compose down

# ── 重启 ──

restart: down up

restart-dev:
	docker compose $(COMPOSE_DEV) restart cerebrate

# ── 运维 ──

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
