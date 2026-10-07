# K8s Service:集群内服务的稳定访问入口

> Pod 的 IP 是易变的——每次重建都会换 IP,客户端无法直接连 Pod。Service 通过 label selector 关联一组 Pod,对外提供稳定的 ClusterIP,内部做负载均衡。这篇记录 Service 的工作机制、四种类型差异,以及生产环境的选型实践。

## 一、为什么需要 Service

Pod 的生命周期决定了它的 IP 不稳定:
- 滚动更新时,旧 Pod 销毁、新 Pod 创建,IP 全部变化
- Pod 崩溃重启,新 Pod 拿到新 IP
- 节点故障,Pod 被调度到其他节点,IP 也变

如果客户端直接连 Pod IP,任何一个上述场景都会导致连接失败。Service 解决了这个问题的核心思路是:**解耦"服务发现"和"实例地址"**。

Service 提供一个稳定的虚拟 IP(ClusterIP),客户端访问 ClusterIP,kube-proxy 在内核态把流量转发到后端某个 Pod。后端 Pod 怎么变化,客户端完全无感知。

## 二、Service 的工作机制

### 2.1 label selector 关联 Pod

```bash
# 创建 Deployment
kubectl create deployment myapp1 --image myapp:v1 --replicas 2

# 创建 Service
kubectl expose deployment myapp1 --port 80 --target-port 80
service/myapp1 exposed

# 查看
kubectl get svc
NAME         TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   10.96.0.1        <none>        443/TCP   14d
myapp1       ClusterIP   10.103.138.233   <none>        80/TCP    116s
```

`kubectl expose` 命令做了三件事:
1. 自动从 Deployment 的 label 推导 Service 的 selector
2. 创建 Service 资源,分配 ClusterIP(从 Service CIDR `10.96.0.0/12` 里随机选)
3. Endpoints Controller 根据 selector 持续监听 Pod,把符合 label 的 Pod IP 加入 Endpoints

### 2.2 Endpoints 的动态更新

```bash
kubectl describe svc myapp1
Name:                     myapp1
Type:                     ClusterIP
IP:                       10.103.138.233
Port:                     <unset>  80/TCP
TargetPort:               80/TCP
Endpoints:                10.244.1.13:80,10.244.2.7:80
Session Affinity:         None
```

`Endpoints` 字段列出了所有健康 Pod 的 IP:Port。这个列表是**动态的**——Pod 扩缩容、滚动更新、节点故障,Endpoints 都会自动更新。

更新机制:
- **Pod 创建** — Endpoints Controller 监听到 Pod Ready,把 IP 加入 Endpoints
- **Pod 销毁** — Pod 从 Endpoints 移除
- **Pod NotReady** — Pod 从 Endpoints 移除(但 Pod 还在,只是不接收流量)

这种"Ready 才进 Endpoints"的机制,正是 readinessProbe 在 Service 层的价值——Pod 启动慢时,readinessProbe 没通过,Pod 不进 Endpoints,客户端流量不会打到未就绪的 Pod。

### 2.3 kube-proxy 的三种模式

Service 的流量转发由 kube-proxy 实现,有三种模式:

**1. userspace(已废弃)** — 早期模式,kube-proxy 在用户态监听端口,流量先到 kube-proxy 再转发到 Pod。性能差,已不推荐。

**2. iptables(默认)** — kube-proxy 在每个节点写 iptables 规则,流量在内核态转发。性能高,是 K8s 1.2+ 的默认模式。

iptables 模式的转发链路:
```
Client -> ClusterIP -> iptables PREROUTING -> KUBE-SERVICES -> KUBE-SVC-XXX -> KUBE-SEP-XXX -> Pod IP
```

每条 Service 对应一个 `KUBE-SVC-XXX` 链,后端每个 Pod 对应一个 `KUBE-SEP-XXX`(Service Endpoint)链。`KUBE-SVC-XXX` 用随机模式(`-m statistic --mode random`)做负载均衡。

**3. IPVS(高性能)** — 用 Linux IPVS 模块做 L4 负载均衡,支持更多调度算法(rr/wrr/lc/sh/dh 等),性能比 iptables 高一个数量级。Service 数量超过 1000 时,IPVS 是首选。

```bash
# 查看 kube-proxy 模式
kubectl -n kube-system get cm kube-proxy -o yaml | grep mode
mode: "ipvs"
```

生产环境推荐 IPVS 模式,尤其是大规模集群。我实验室用 iptables 模式(Service 不多),生产环境用 IPVS。

## 三、Service 的四种类型

### 3.1 ClusterIP(默认)

```yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp1
spec:
  type: ClusterIP          # 默认值
  selector:
    app: myapp1
  ports:
  - port: 80
    targetPort: 80
```

ClusterIP 类型的 Service 只能在集群内访问。这是最常用的类型,适合:
- 微服务之间的内部调用
- 数据库、缓存等内部依赖
- 后台任务的处理队列

### 3.2 NodePort

```yaml
spec:
  type: NodePort
  selector:
    app: myapp1
  ports:
  - port: 80
    targetPort: 80
    nodePort: 30080         # 可选,不指定则自动分配(30000-32767)
```

NodePort 在每个节点上开一个端口(默认 30000-32767),外部可以通过 `节点IP:NodePort` 访问 Service。

```bash
kubectl get svc myapp1
NAME     TYPE       CLUSTER-IP      EXTERNAL-IP   PORT(S)        AGE
myapp1   NodePort   10.103.138.233  <none>        80:30080/TCP   1m

curl 172.25.254.100:30080    # 任意节点 IP + NodePort 都能访问
```

NodePort 的优点:
- 配置简单,适合测试和小规模对外服务
- 任何节点都能访问,自带高可用(节点挂了换另一个)

缺点:
- 端口范围受限(30000-32767),不适合暴露标准 80/443
- 节点 IP 暴露,客户端需要知道节点 IP
- 大规模集群下iptables 规则爆炸

### 3.3 LoadBalancer

```yaml
spec:
  type: LoadBalancer
  selector:
    app: myapp1
  ports:
  - port: 80
    targetPort: 80
```

LoadBalancer 类型依赖云厂商的负载均衡服务(AWS ELB、阿里云 SLB、腾讯云 CLB)。K8s 自动创建云负载均衡,把流量转发到 NodePort,再到 Pod。

```bash
kubectl get svc myapp1
NAME     TYPE           CLUSTER-IP      EXTERNAL-IP      PORT(S)        AGE
myapp1   LoadBalancer   10.103.138.233  203.0.113.10     80:30080/TCP   1m
```

`EXTERNAL-IP` 是云负载均衡的公网 IP,客户端通过这个 IP 访问服务。

LoadBalancer 适合:
- 云上生产环境
- 需要公网访问的服务
- 需要云负载均衡的高可用能力(健康检查、SSL 终止等)

缺点:
- 每个 Service 一个云负载均衡,成本高
- 仅云上可用,裸金属集群不支持

### 3.4 ExternalName

```yaml
spec:
  type: ExternalName
  externalName: api.external-service.com
```

ExternalName 类型的 Service 不创建 ClusterIP,而是在集群内 DNS 里创建一个 CNAME 记录,把 `myapp1.default.svc.cluster.local` 指向 `api.external-service.com`。

这种 Service 适合:
- 把外部服务引入集群 DNS,Pod 内统一用 Service 名访问
- 后续把外部服务迁到集群内,只需改 Service 类型,Pod 代码不变
- 跨命名空间访问,通过 ExternalName 做转发

## 四、Service 与 DNS

K8s 集群自带 DNS 服务(CoreDNS),每个 Service 都会自动注册 DNS 记录:

```bash
# 在 Pod 内访问 Service
kubectl exec -it myapp-pod -- curl http://myapp1.default.svc.cluster.local
# 简写
kubectl exec -it myapp-pod -- curl http://myapp1.default
# 同命名空间内最简
kubectl exec -it myapp-pod -- curl http://myapp1
```

DNS 命名规则:`<service-name>.<namespace>.svc.cluster.local`

DNS 解析的优势:
- 不需要记住 ClusterIP(虽然 ClusterIP 稳定,但还是数字 IP)
- 跨命名空间访问有清晰的命名
- 应用配置里写 Service 名,部署到不同命名空间也能工作

生产环境推荐用 DNS 名而不是 ClusterIP——ClusterIP 在不同集群可能冲突,但 DNS 名是稳定的。

## 五、Headless Service:无 ClusterIP 的特殊场景

```yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp-headless
spec:
  clusterIP: None         # 关键:Headless
  selector:
    app: myapp
  ports:
  - port: 80
    targetPort: 80
```

`clusterIP: None` 创建 Headless Service——不分配 ClusterIP,DNS 查询直接返回所有 Pod IP。

```bash
nslookup myapp-headless
Name:    myapp-headless.default.svc.cluster.local
Address: 10.244.1.13
Name:    myapp-headless.default.svc.cluster.local
Address: 10.244.2.7
```

Headless Service 的使用场景:
- **StatefulSet** — 每个 Pod 需要稳定的网络标识(`pod-0`, `pod-1`),Headless Service 配合 StatefulSet 提供 `pod-0.myapp-headless` 这样的稳定 DNS
- **客户端做负载均衡** — gRPC、Cassandra 客户端自带负载均衡,需要拿到所有 Pod IP 自己选,而不是用 Service 的代理
- **数据库主从** — 主节点和从节点需要分别访问,Headless Service 让客户端拿到所有节点 IP,自己区分主从

## 六、Service 的工程化实践

### 6.1 命名规范

```yaml
metadata:
  name: user-service       # 用服务名,不要带 -service 后缀
  namespace: production    # 必须显式指定 namespace
  labels:
    app: user-service
    tier: backend
    environment: production
```

命名规则:
- 用服务名,简短清晰(`user-service` 而不是 `user-management-service`)
- 必须显式 namespace,避免误部署到 default
- label 体系化(`app`/`tier`/`environment`),方便监控和告警分组

### 6.2 端口命名

```yaml
spec:
  ports:
  - name: http-web         # 命名端口
    port: 80
    targetPort: http       # 也可以引用容器命名端口
  - name: http-metrics
    port: 9090
    targetPort: 9090
```

命名端口的好处:
- Service 配置可读性强(`targetPort: http` 比 `targetPort: 8080` 清晰)
- 端口变化时只改容器一处,Service 自动跟随
- Istio 等服务网格靠端口名识别协议(http/tcp/grpc)

### 6.3 多端口 Service

```yaml
spec:
  selector:
    app: myapp
  ports:
  - name: http
    port: 80
    targetPort: 8080
  - name: https
    port: 443
    targetPort: 8443
  - name: admin
    port: 9090
    targetPort: 9090
```

一个 Service 可以暴露多个端口,适合一个 Pod 提供多种协议(如同时提供 HTTP 和 gRPC)。

### 6.4 sessionAffinity 会话粘性

```yaml
spec:
  type: ClusterIP
  sessionAffinity: ClientIP    # 基于客户端 IP 粘性
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800    # 粘性保持 3 小时
  selector:
    app: myapp
  ports:
  - port: 80
```

`sessionAffinity: ClientIP` 让同一客户端 IP 的请求始终转发到同一 Pod。这种"会话粘性"适合:
- 后端 session 存内存,无法跨 Pod 共享
- 后端有本地缓存,粘性避免缓存失效

但生产环境不推荐,更好的方案是:
- **JWT 无状态认证** — 任何 Pod 都能验证
- **Redis 共享 session** — 任何 Pod 都能访问
- **数据库存储 session** — 完全去状态化

## 七、Service 的故障排查

### 7.1 Service 无法访问

排查思路:
1. **看 Endpoints 是否为空** — `kubectl get endpoints myapp1`,空说明 selector 没匹配到 Pod
2. **看 Pod Ready 状态** — Pod NotReady 不会进 Endpoints
3. **看 Pod label 是否匹配 selector** — `kubectl get pods --show-labels`
4. **看 kube-proxy 是否正常** — `kubectl get pods -n kube-system | grep kube-proxy`
5. **看 iptables 规则** — `iptables -t nat -L KUBE-SERVICES | grep <ClusterIP>`

### 7.2 端口不匹配

```yaml
# Service port 80,但 Pod 监听 8080
spec:
  ports:
  - port: 80
    targetPort: 8080       # 必须和容器监听端口一致
```

`targetPort` 是容器实际监听的端口,如果配置错(比如 Pod 监听 8080,Service targetPort 写 80),请求会被转发到不存在的端口,返回 connection refused。

### 7.3 跨命名空间访问

Service 默认只能被同命名空间的 Pod 访问。跨命名空间需要用完整 DNS 名:
```bash
curl http://myapp1.production.svc.cluster.local
# 简写
curl http://myapp1.production
```

跨命名空间访问不是"特殊配置",而是 DNS 名的差异。生产环境经常用这种机制,比如 `monitoring` 命名空间的 Prometheus 抓取 `production` 命名空间的应用指标。

## 八、Service 是 K8s 网络的基石

Service 解决了"Pod IP 不稳定"的核心问题,是 K8s 服务发现的基础。但 Service 本身只是 L4(TCP/UDP)调度,无法基于 HTTP URL/Header 路由——这就需要 **Ingress**。

下一篇我会深入讲 Ingress,它是 K8s 的 L7 入口,实现基于域名的虚拟主机、TLS 终止、URL 重写、金丝雀发布等高级流量管理能力。理解 Service + Ingress 的组合,才算真正掌握 K8s 的网络模型。

> Service 是"内部服务发现"的解决方案,Ingress 是"外部流量入口"的解决方案。两者配合,构成了 K8s 完整的网络服务体系。
