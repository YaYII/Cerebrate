# 本机公网入口网关（nginx-gateway）

把本机服务经过 ngrok 固定域名暴露到公网。**要给某个服务加公网入口时先读这份。**

## 链路

```
ngrok 隧道（snap 安装，命令 `ngrok http 8443`）
  → 宿主 127.0.0.1:8443
  → 本目录的 nginx.conf 以只读方式挂载进容器 nginx-gateway 的 /etc/nginx/nginx.conf
     容器网络 cerebrate_default，容器 IP 172.27.0.2，网关 172.27.0.1
  → 按 location 路径前缀分发到各服务
```

## 现有入口

| 路径 | 后端 | 说明 |
|---|---|---|
| `/cerebrate/` | `cerebrate:8765` | 团队记忆中枢 |
| `/dshagent/` | `172.27.0.1:10800` | 智能客服 |
| `/obs/` | `172.27.0.1:8770` | Obsidian Vault Bridge（电脑↔手机传知识库文件） |
| `/admin/`、`/adminprod/`、`/h5/` 等 | 见配置 | DSEDT 相关 |


另有独立 server 块：`travel-lapped-python.ngrok-free.dev` → `172.27.0.1:3083`（dsh 认证网关）。

## 加一个新入口

在默认 server 块里加一段 location，**三处必须同时满足**：

```nginx
location /新前缀/ {
    proxy_pass http://172.27.0.1:端口/;   # 1. 结尾带斜杠 = 剥离前缀
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Prefix /新前缀;   # 应用据此让页面内请求带上前缀
    client_max_body_size 128m;                     # 2. 有上传就必须放开（默认 1m → 413）
    proxy_request_buffering off;                   # 3. 上传不先整体落盘
}
```

- 后端在**宿主机**上时用 `172.27.0.1`（本网络的网关），**不是** `host.docker.internal`；
  前提是宿主服务监听 `0.0.0.0` 而非 `127.0.0.1`。
- 后端是**同网络容器**时直接用容器名，如 `cerebrate:8765`。

## 改完必须做

```bash
docker exec nginx-gateway nginx -t          # 语法不过就别 reload
docker exec nginx-gateway nginx -s reload   # reload 不中断现有连接
```

## 验证

默认 server 块里有 `if ($host ~* "^(127.0.0.1|localhost)$") { return 444; }`，
所以**本机直连 8443 返回 000 / 空响应是预期行为，不是服务坏了**。本机测试必须带 Host 头：

```bash
curl -H "Host: finale-earthworm-iciness.ngrok-free.dev" http://127.0.0.1:8443/cerebrate/
curl https://finale-earthworm-iciness.ngrok-free.dev/obs/api/health     # 公网直测
```

## 排查备忘（别再走的弯路）

- **别从端口反查进程**：8443 的监听在容器网络命名空间里，宿主 `ss -tlnp` 与 `/proc/*/fd`
  都找不到持有者。要定位配置文件，用挂载点反查：
  ```bash
  docker ps -a | grep -i nginx
  docker inspect nginx-gateway --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
  ```
- **别急着新开 cloudflared 临时隧道**：短时反复创建会被服务端拒绝（公网 530），
  且域名每次重建都变，手机要重新填。只适合临时一次性验证。
- **"域名没配"多半是"路径没加"**：域名早就通了，缺的只是一段 location。

## 改配置前先备份

目录里已有 `nginx.conf.bak-<时间戳>-<原因>` 的惯例，照做。
