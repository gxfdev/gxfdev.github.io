# Nginx 负载均衡实战:从反向代理到高可用架构

> 在 Web 集群部署与自动化运维项目里,Nginx 负载均衡是核心组件之一。这篇记录从单机反向代理到多节点负载均衡的完整实践,包括 L4/L7 调度、会话保持、健康检查等关键配置。

## 一、为什么用 Nginx 做负载均衡

电商系统初期是单机部署——Spring Boot 后端跑在一台 4C8G 的服务器上,QPS 上不去,而且这台机器一旦挂掉,整个服务就中断。引入负载均衡的核心目标有两个:

1. **横向扩展** — 把流量分摊到多台后端机器,突破单机性能瓶颈
2. **故障转移** — 后端某台机器故障,负载均衡器自动剔除,服务整体可用

为什么选 Nginx 而不是 HAProxy 或商业 F5?主要原因:
- **同时支持 L4(TCP/UDP)和 L7(HTTP)调度** — 一套配置搞定所有场景
- **配置灵活** — 基于域名的虚拟主机、URL 重写、SSL 终止都能在一层完成
- **生态成熟** — 配合 Prometheus + nginx_exporter 实现完整监控
- **运维成本低** — 比 HAProxy 配置语法更友好,比 F5 没有授权费

## 二、反向代理:最基础的流量转发

### 2.1 配置示例

```nginx
# /etc/nginx/conf.d/proxy.conf
upstream backend {
    server 172.25.254.40:8080;
    server 172.25.254.50:8080;
}

server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

这段配置做了三件事:

1. **`upstream`** — 定义后端服务器池,这里有两个后端节点
2. **`server`** — Nginx 对外的虚拟主机,监听 80 端口
3. **`location /`** — 把所有请求转发到 upstream 池

### 2.2 proxy_set_header 的工程含义

转发请求时必须传递的三个 header:

- **`Host`** — 后端应用经常用 Host 区分虚拟主机,如果不传,后端看到的 Host 是 upstream 名字(`backend`),会导致路由错误
- **`X-Real-IP`** — 客户端真实 IP,后端日志和风控逻辑依赖这个
- **`X-Forwarded-For`** — 代理链路记录,格式 `client_ip, proxy1_ip, proxy2_ip`,多层代理时用于追溯客户端
- **`X-Forwarded-Proto`** — 客户端原始协议(http/https),后端生成回调 URL 时需要

很多后端框架(Spring Boot、Express)默认信任 `X-Forwarded-*`,但需要在配置里启用。Spring Boot 的配置:

```yaml
server:
  forward-headers-strategy: native
  tomcat:
    remoteip:
      remote-ip-header: X-Real-IP
      protocol-header: X-Forwarded-Proto
```

不启用的话,后端拿到的永远是 Nginx 的 IP 和 http 协议,会导致 OAuth 回调 URL 错误、风控日志全是 Nginx IP 等问题。

## 三、负载均衡调度算法

### 3.1 Round Robin(轮询,默认)

```nginx
upstream backend {
    server 172.25.254.40:8080;
    server 172.25.254.50:8080;
}
```

默认算法,请求依次轮询分发。适合后端机器配置相同、处理能力一致的场景。

### 3.2 Weighted Round Robin(加权轮询)

```nginx
upstream backend {
    server 172.25.254.40:8080 weight=3;   # 4C8G 机器
    server 172.25.254.50:8080 weight=1;   # 2C4G 机器
}
```

通过 `weight` 参数调整分发比例。`172.25.254.40` 性能强,承担 3/4 的流量;`172.25.254.50` 性能弱,承担 1/4。这种"按性能加权"是异构集群的标准做法。

### 3.3 IP Hash(会话保持)

```nginx
upstream backend {
    ip_hash;
    server 172.25.254.40:8080;
    server 172.25.254.50:8080;
}
```

根据客户端 IP 哈希,同一客户端的请求始终转发到同一后端。这种"会话粘性"适合以下场景:

- **后端 session 存内存** — 比如 Java 的 HttpSession,无法跨节点共享
- **后端有本地缓存** — 比如本地内存缓存用户数据,粘性避免缓存失效

但 ip_hash 有个明显缺陷——客户端 IP 一变(比如手机切 4G/WiFi),session 就丢。生产环境更推荐:

- **后端用 Redis 共享 session** — 彻底摆脱会话粘性
- **JWT 无状态认证** — 服务端不存 session,任何节点都能验证

### 3.4 Least Connections(最少连接)

```nginx
upstream backend {
    least_conn;
    server 172.25.254.40:8080;
    server 172.25.254.50:8080;
}
```

把请求转发到当前活跃连接数最少的后端。适合请求处理时间差异大的场景,比如有些请求是 100ms,有些是 10s,轮询会导致慢请求堆积在某台机器上。

## 四、健康检查:故障转移的关键

### 4.1 被动健康检查(默认)

Nginx 默认的被动健康检查:
- 请求某后端失败,标记为 unavailable,持续 `fail_timeout`(默认 10 秒)
- 在 `fail_timeout` 内不转发流量到这台后端
- `fail_timeout` 结束后,重新尝试转发

```nginx
upstream backend {
    server 172.25.254.40:8080 max_fails=3 fail_timeout=30s;
    server 172.25.254.50:8080 max_fails=3 fail_timeout=30s;
}
```

`max_fails=3 fail_timeout=30s` 含义:30 秒内失败 3 次就标记为不可用,30 秒后再尝试。这是被动检查——只有"请求过来才发现后端挂了",无法主动检测。

### 4.2 主动健康检查(Nginx Plus 或第三方模块)

开源版 Nginx 不支持主动健康检查,需要 Nginx Plus(付费)或 `nginx_upstream_check_module`(开源)。

主动健康检查的逻辑:Nginx 周期性向后端发探测请求,失败则剔除,成功则加回。这种"主动探测"能在用户感知到故障前就完成转移,可用性更高。

开源替代方案:
- **用 consul-template + nginx** — Consul 做服务发现,consul-template 动态生成 nginx.conf
- **用 OpenResty + lua-resty-healthcheck** — Lua 主动探测
- **改造架构,在 Nginx 前面加 keepalived + HAProxy** — HAProxy 做主动健康检查,Nginx 做 L7 调度

电商项目里我们用的是 OpenResty 方案,Lua 主动探测 `/health` endpoint,健康状态写共享内存,worker 进程读取,实现了秒级故障转移。

## 五、L4 vs L7 调度:Nginx 的双面性

### 5.1 L4(TCP/UDP)调度

```nginx
stream {
    upstream mysql_backend {
        server 172.25.254.40:3306;
        server 172.25.254.50:3306;
    }

    server {
        listen 3306;
        proxy_pass mysql_backend;
    }
}
```

L4 调度在 `stream` 块里配置,不解析应用层协议,只看 TCP/UDP 头。优点:
- **协议无关** — MySQL、Redis、Kafka、gRPC 都能转发
- **性能高** — 内核态转发,无应用层解析开销

缺点:
- **无法基于 URL/Header 调度** — 所有流量按 IP/port 转发
- **无法做 SSL 终止** — 后端必须自己处理 HTTPS

### 5.2 L7(HTTP)调度

```nginx
http {
    upstream api_v1 {
        server 172.25.254.40:8080;
    }
    upstream api_v2 {
        server 172.25.254.50:8080;
    }

    server {
        listen 80;
        server_name api.example.com;

        location /v1/ {
            proxy_pass http://api_v1;
        }
        location /v2/ {
            proxy_pass http://api_v2;
        }
    }
}
```

L7 调度在 `http` 块里,基于 HTTP 协议(URL、Header、Cookie)调度。优点:
- **基于 URL 路由** — `/v1/` 和 `/v2/` 可以转发到不同后端,实现灰度发布
- **SSL 终止** — Nginx 处理 HTTPS,后端用 HTTP,降低后端 CPU 负载
- **请求改写** — 可以在转发前修改 Header、URL

缺点:
- **只支持 HTTP/HTTPS** — 不能转发 MySQL、Redis 等协议
- **性能略低** — 应用层解析有开销(但用 Nginx 一般不是瓶颈)

### 5.3 工程选型

生产环境的典型架构:
- **公网入口用 L7** — SSL 终止、URL 路由、灰度发布都在这一层
- **内部分调用用 L4** — 比如 MySQL Proxy、Redis Cluster 代理,需要协议无关

在电商项目里,我们用 Nginx L7 处理用户请求(80/443),用 Nginx L4 做内网 MySQL 读负载均衡(3306),一套 Nginx 实例搞定两个层级的需求。

## 六、高可用:Keepalived + Nginx 双机热备

单台 Nginx 是单点故障——一旦挂掉,整个服务中断。生产环境必须用 **Keepalived + VIP** 实现高可用。

### 6.1 架构

```
                  +-------- VIP: 172.25.254.200 --------+
                  |                                     |
        +---------+---------+                 +---------+---------+
        |  Nginx Master     |                 |  Nginx Backup     |
        |  Keepalived (MASTER) |              |  Keepalived (BACKUP) |
        +---------+---------+                 +---------+---------+
                  |                                     |
        +---------+---------+                 +---------+---------+
        |  Backend 1       |                 |  Backend 2       |
        +-----------------+                 +-----------------+
```

两台 Nginx 都跑 Keepalived,共享一个 VIP。正常情况下 MASTER 持有 VIP,流量走 MASTER。MASTER 故障时,BACKUP 抢占 VIP,流量切换到 BACKUP。

### 6.2 Keepalived 配置

**MASTER 节点** `/etc/keepalived/keepalived.conf`:

```ini
vrrp_script chk_nginx {
    script "/etc/keepalived/check_nginx.sh"
    interval 2
    weight -20
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass MyPassword123
    }

    virtual_ipaddress {
        172.25.254.200/24
    }

    track_script {
        chk_nginx
    }
}
```

**check_nginx.sh** 健康检查脚本:

```bash
#!/bin/bash
if ! pidof nginx > /dev/null; then
    systemctl start nginx
    sleep 2
    if ! pidof nginx > /dev/null; then
        systemctl stop keepalived   # 让 BACKUP 接管
    fi
fi
```

这套机制的核心是 **VRRP 协议** ——Keepalived 用组播定期发送 VRRP 通告,MASTER 故障时停止通告,BACKUP 收不到通告就抢占 VIP。这种"网络层故障检测 + IP 漂移"的方案,故障切换时间在 1-3 秒,远快于 DNS 切换(分钟级)。

## 七、监控与告警

负载均衡层的监控指标:

- **active_connections** — 当前活跃连接数,异常上升可能是后端慢响应
- **requests_per_second** — 每秒请求数,容量规划依据
- **upstream_response_time** — 后端响应时间 P50/P95/P99
- **upstream_failures** — 后端失败次数,触发告警
- **upstream_4xx/5xx** — HTTP 错误码分布

在电商项目里,我们用 `nginx-vts` 模块暴露 Prometheus 指标,Grafana 配置了四个核心告警:
1. 后端失败率 > 1% 持续 1 分钟
2. 后端 P99 响应时间 > 2 秒持续 5 分钟
3. 活跃后端节点数 < 2(全部后端挂掉只剩 Nginx)
4. Nginx 自身连接数 > 10000(可能被打)

这些告警在我值班期间触发过 3 次,每次都提前发现问题,避免了用户感知的故障。

## 八、负载均衡的工程哲学

总结几条原则:

1. **简单优先** — 能用轮询就不用 ip_hash,能不用 Lua 就不用 Lua
2. **被动+主动健康检查** — 开源 Nginx 至少配被动检查,预算允许上主动检查
3. **L7 入口,L4 内部** — 公网用 HTTP 调度,内网用 TCP 转发
4. **必上高可用** — 单 Nginx 就是单点,Keepalived + VIP 是最低配置
5. **监控告警先行** — 没有监控的负载均衡是黑盒,出问题无从下手

负载均衡是基础设施的"心脏",配置不当时流量分配不均、故障转移慢、监控盲区大,所有上层应用都会受影响。掌握 Nginx 负载均衡,是 Web 运维的基本功,也是云原生时代仍然重要的能力——因为 Ingress Controller 本质就是 K8s 化的 Nginx。

> 反向代理不只是转发请求,它还是流量的"治理层"。Header 改写、SSL 终止、限流熔断、灰度发布,所有非业务逻辑的流量管控,都应该在 Nginx 这一层完成。
