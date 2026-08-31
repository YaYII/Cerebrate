# @deepseek-ai/dsh-web-search

AI 自主搜索阅读插件（DSH 原生插件，**全程无 MCP**）：让 AI 自己
**搜索网页 → 解析内容 → 阅读**。通过自托管 SearXNG（元搜索）+ crawl4ai/Jina Reader
（网页解析），AI 可以直接获取最新信息、调研资料、精读网页原文。

## 能力

| 工具 | 作用 | 后端 |
|---|---|---|
| `web_search` | 搜索网页，返回带标题/URL/摘要的结果 | SearXNG（聚合 Google/Bing/DDG） |
| `web_read` | 把 URL 解析为 LLM 友好的 Markdown | crawl4ai（首选）→ Jina Reader（兜底） |

## 架构

    DSH（AI 工作区）
     └─ dsh-web-search 原生插件（defineTool，无 MCP）
          ├─ web_search  → SearXNG 元搜索（自托管 127.0.0.1:8080）
          └─ web_read    → crawl4ai 网页解析（自托管 127.0.0.1:11235）
                           └─ 降级 → Jina Reader（r.jina.ai）

## 部署依赖（docker compose）

```yaml
# infra-websearch/docker-compose.yml
services:
  searxng:
    image: searxng/searxng:latest
    ports: ["127.0.0.1:8080:8080"]
    volumes: [./searxng/settings.yml:/etc/searxng/settings.yml:ro]
  crawl4ai:
    image: unclecode/crawl4ai:latest
    ports: ["127.0.0.1:11235:11235"]
    environment: [HOST=0.0.0.0, CRAWL4AI_API_TOKEN=dsh-local-crawl-token-2026]
```

> crawl4ai 默认监听容器内回环，必须设 `HOST=0.0.0.0` 才能从宿主机访问；
> 建议设 `CRAWL4AI_API_TOKEN` 固定 token（否则每次重启生成临时 token）。

## 配置

    - insert:
        - id: dsh-web-search
          name: '@deepseek-ai/dsh-web-search'
          config:
            searxngUrl: 'http://127.0.0.1:8080'      # SearXNG 地址
            crawl4aiUrl: 'http://127.0.0.1:11235'    # crawl4ai 地址
            crawl4aiToken: 'dsh-local-crawl-token-2026' # crawl4ai API token
            jinaReaderUrl: 'https://r.jina.ai'        # Jina Reader（兜底）
            timeoutMs: 30000
            maxResults: 8
            injectGuidance: true

## 引导注入

插件加载时向首个 agent step 注入「搜索优先」引导：需要最新信息/查资料时
先 `web_search` 找 URL，再 `web_read` 精读原文，不凭记忆臆断。

## 开发

```bash
node scripts/check-all.mjs   # 一键门禁：注释语言 + 类型 + 测试 + 构建
```

## 许可证

MIT
