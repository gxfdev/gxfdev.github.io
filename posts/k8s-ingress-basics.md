# K8s Ingress 入门:从默认后端到基于域名的虚拟主机

> Service 解决了集群内服务发现问题,但对外暴露服务时,NodePort 端口范围受限、LoadBalancer 成本太高。Ingress 是 K8s 的 L7 入口,基于 HTTP 协议(URL、Host)做流量路由,一个 IP 就能服务多个应用。这篇记录 Ingress 的基础用法和基于域名的虚拟主机配置。

## 一、为什么需要 Ingress

### 1.1 NodePort 和 LoadBalancer 的局限

回顾 Service 的几种对外暴露方式:
- **NodePort** — 每个节点开 30000-32767 端口,客户端用 `节点IP:NodePort` 访问。问题:端口范围受限,无法暴露标准 80/443;每个节点 IP 都暴露,客户端需要负载均衡
- **LoadBalancer** — 自动创建云负载均衡,但每个 Service 一个 LB,成本高;仅云上可用

这两种方式都是 L4 调度,无法基于 HTTP 协议做路由。如果你的集群里跑 10 个 Web 应用,用 NodePort 需要 10 个端口,用户记不住;用 LoadBalancer 需要 10 个 LB,每月费用上千美元。

### 1.2 Ingress 的解决方案

Ingress 提供 L7 入口,核心能力:
- **基于域名的虚拟主机** — `app1.example.com` 转发到 app1,`app2.example.com` 转发到 app2,共用 80/443 端口
- **基于 URL 路径路由** — `example.com/api` 转发到 api 服务,`example.com/web` 转发到 web 服务
- **TLS 终止** — 在 Ingress 层处理 HTTPS,后端用 HTTP,降低后端 CPU 负载
- **金丝雀发布** — 按比例切流量到新版本

架构上 Ingress 分两层:
- **Ingress Controller** — 实际运行的 Pod,监听 Ingress 资源变化,生成 Nginx/HAProxy/Traefik 配置(最常用的是 nginx-ingress-controller)
- **Ingress 资源** — 用户定义的路由规则,K8s API 对象

```
External -> Ingress Controller (LoadBalancer Service) -> Nginx (Pod) -> 后端 Service -> Pod
```

## 二、Ingress Controller 部署

### 2.1 安装 nginx-ingress-controller

```bash
# 官方推荐方式
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/baremetal/deploy.yaml
```

部署后会创建:
- `ingress-nginx` 命名空间
- `ingress-nginx-controller` Deployment(Nginx Pod)
- `ingress-nginx-controller` Service(LoadBalancer 类型)
- `ingress-nginx-controller-admission` Service(准入控制器)

### 2.2 验证 Controller 状态

```bash
kubectl -n ingress-nginx get svc
NAME                                 TYPE           CLUSTER-IP     EXTERNAL-IP     PORT(S)                      AGE
ingress-nginx-controller             LoadBalancer   10.97.40.214   172.25.254.50   80:31314/TCP,443:31333/TCP   9m6s
ingress-nginx-controller-admission   ClusterIP      10.99.51.58    <none>          443/TCP                      9m6s
```

`ingress-nginx-controller` 的 `EXTERNAL-IP` 是 `172.25.254.50`——这是 Ingress 的入口 IP,所有外部流量都从这儿进。

注意 `EXTERNAL-IP` 是节点 IP(因为是裸金属集群,没有真正的云负载均衡)。云环境下 `EXTERNAL-IP` 是云 LB 的公网 IP。

### 2.3 测试 Controller 是否正常

```bash
curl 172.25.254.50
<html>
<head><title>404 Not Found</title></head>
<body>
<center><h1>404 Not Found</h1></center>
<hr><center>nginx</center>
</body>
</html>
```

返回 404 是正常的——Controller 起来了,但还没有 Ingress 规则匹配请求。下一步就是创建 Ingress 资源。

## 三、第一个 Ingress:默认后端

### 3.1 准备后端服务

```bash
# 创建两个 Deployment + Service
kubectl create deployment myapp1 --image myapp:v1 --replicas 2
kubectl expose deployment myapp1 --port 80 --target-port 80

kubectl create deployment myapp2 --image myapp:v2 --replicas 2
kubectl expose deployment myapp2 --port 80 --target-port 80

kubectl get svc
NAME         TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
myapp1       ClusterIP   10.103.138.233   <none>        80/TCP    116s
myapp2       ClusterIP   10.111.217.93    <none>        80/TCP    6s
```

### 3.2 创建 Ingress

```bash
kubectl create ingress webcluster --rule='*/=myapp1:80' --dry-run=client -o yaml > 1-ingress.yml
```

生成的 YAML 文件修改后:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webcluster
spec:
  ingressClassName: nginx       # 必须指定,告诉用哪个 Ingress Controller
  rules:
  - http:
      paths:
      - backend:
          service:
            name: myapp1
            port:
              number: 80
        path: /                  # 匹配所有路径
        pathType: Prefix         # 前缀匹配
```

关键字段说明:

- **`ingressClassName: nginx`** — 指定用 nginx Ingress Controller。K8s 1.18+ 用 IngressClass 替代旧的 `kubernetes.io/ingress.class` 注解
- **`rules[].http.paths[].backend`** — 后端 Service 名和端口
- **`path: /`** — 匹配所有路径
- **`pathType: Prefix`** — 前缀匹配,`/` 匹配所有路径

### 3.3 应用并测试

```bash
kubectl apply -f 1-ingress.yml
ingress.networking.k8s.io/webcluster created

curl 172.25.254.50
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
```

成功!所有流量都转发到 myapp1。这就是 Ingress 最基础的用法——把外部 80 端口的流量路由到集群内的 Service。

### 3.4 pathType 的三种模式

K8s 1.19+ 的 `pathType` 有三种:

- **`Prefix`** — 前缀匹配,`/api` 匹配 `/api`、`/api/`、`/api/v1`,但不匹配 `/apiv1`
- **`Exact`** — 精确匹配,`/api` 只匹配 `/api`,不匹配 `/api/`
- **`ImplementationSpecific`** — 由 Ingress Controller 自己定义匹配规则(nginx-ingress 用正则匹配)

生产环境推荐 `Prefix`,语义清晰。`ImplementationSpecific` 灵活但可移植性差——换 Ingress Controller(比如从 nginx 换到 traefik),行为可能变化。

## 四、基于域名的虚拟主机

### 4.1 配置基于域名的路由

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
  name: webcluster
spec:
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org         # 第一个域名
    http:
      paths:
      - backend:
          service:
            name: myapp1
            port:
              number: 80
        path: /
        pathType: Prefix
  - host: myapp2.zxf.org         # 第二个域名
    http:
      paths:
      - backend:
          service:
            name: myapp2
            port:
              number: 80
        path: /
        pathType: Prefix
```

这个 Ingress 把:
- `myapp1.zxf.org` 的流量转发到 myapp1 Service
- `myapp2.zxf.org` 的流量转发到 myapp2 Service

共用 Ingress Controller 的 80 端口,通过 HTTP Host 头区分。

### 4.2 应用并验证

```bash
kubectl apply -f 2-ingress.yml

kubectl describe ingress webcluster
Name:             webcluster
Ingress Class:    nginx
Rules:
  Host            Path  Backends
  ----            ----  --------
  myapp1.zxf.org  
                  /   myapp1:80 (10.244.1.13:80)
  myapp2.zxf.org  
                  /   myapp2:80 (10.244.2.5:80)
Events:
  Type    Reason  Age   From                      Message
  ----    ------  ----  ----                      -------
  Normal  Sync    5s    nginx-ingress-controller  Scheduled for sync
```

`Scheduled for sync` 表示 nginx-ingress-controller 已经把这个 Ingress 规则同步到 Nginx 配置,即将生效。

### 4.3 配置 DNS 并测试

```bash
# 在测试机本地 hosts 加 DNS 解析
vim /etc/hosts
172.25.254.50      myapp1.zxf.org   myapp2.zxf.org

# 测试
curl myapp1.zxf.org
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>

curl myapp2.zxf.org
Hello MyApp | Version: v2 | <a href="hostname.html">Pod Name</a>
```

成功!同一个 IP(`172.25.254.50`),通过不同的 Host 头访问到不同的应用。

### 4.4 生产环境的 DNS 配置

实验室环境用 `/etc/hosts` 是临时方案,生产环境需要正式 DNS:

**方案 1:通配符 DNS 记录**  
```
*.zxf.org.  IN  A  172.25.254.50
```
所有 `*.zxf.org` 都解析到 Ingress IP,新增应用不需要改 DNS。

**方案 2:外部 DNS 服务**  
用 Cloudflare、阿里云 DNS 等,每个应用加 A 记录。管理方便但新增应用要操作 DNS。

**方案 3:ExternalDNS 自动同步**  
ExternalDNS 是 K8s 的一个控制器,监听 Ingress 资源,自动创建 DNS 记录。新增 Ingress 自动同步 DNS,这是云原生的最佳实践。

## 五、rewrite-target 注解

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
```

这个注解把请求路径重写为 `/`。比如客户端访问 `myapp1.zxf.org/api/users`,转发到后端时路径变成 `/`。

使用场景:
- 后端应用只处理根路径(`/`),不希望看到前缀路径
- 路径迁移时,前端用新路径,后端用旧路径,Ingress 做转换

但 `rewrite-target: /` 会让**所有路径都变成 /**,丢失原始路径信息。如果需要保留部分路径,用更精细的 rewrite-target 配置(后续文章会讲)。

## 六、Ingress 的事件排查

```bash
kubectl describe ingress webcluster
...
Events:
  Type    Reason  Age   From                      Message
  ----    ------  ----  ----                      -------
  Normal  Sync    5s    nginx-ingress-controller  Scheduled for sync
```

`Events` 字段是排查 Ingress 问题的关键:

- **`Scheduled for sync`** — Controller 收到 Ingress 变更,计划同步
- **`Synced`** — 配置已写入 Nginx,即将生效
- **`Error`** — 配置有问题(比如 backend Service 不存在)

如果 Ingress 配置后访问还是 404,排查:
1. **`kubectl describe ingress`** 看 Events 有没有错误
2. **`kubectl -n ingress-nginx logs -l app.kubernetes.io/name=ingress-nginx`** 看 Controller 日志
3. **`kubectl -n ingress-nginx exec -it <controller-pod> -- cat /etc/nginx/nginx.conf`** 看 Nginx 配置是否正确生成
4. **`kubectl get endpoints <backend-service>`** 确认后端 Service 有 Pod

## 七、Ingress 的工程化选型

### 7.1 Ingress Controller 选型

主流 Ingress Controller 对比:

| Controller | 优点 | 缺点 | 适用场景 |
|------------|------|------|---------|
| **nginx-ingress** | 生态成熟、配置灵活、社区活跃 | 性能一般、配置复杂 | 通用 Web 入口 |
| **Traefik** | 配置简单、自动 HTTPS、有 Dashboard | 大规模下性能差 | 中小规模集群 |
| **HAProxy Ingress** | 性能极高、L4/L7 都支持 | 文档少、生态弱 | 高性能场景 |
| **Istio Gateway** | 强大的流量治理、灰度、熔断 | 重度依赖 Istio、学习曲线陡 | 服务网格场景 |
| **APISIX** | 插件丰富、动态配置 | 相对较新 | API 网关场景 |

生产环境最常用 nginx-ingress,生态成熟、文档完善。如果用了 Istio 服务网格,可以用 Istio Gateway 一致管理。

### 7.2 Ingress 资源 vs Gateway API

K8s 1.19+ 推出了 **Gateway API**,是 Ingress 的下一代替代。Gateway API 把"路由规则"和"网关实例"解耦:

- **GatewayClass** — 网关类型(类似 IngressClass)
- **Gateway** — 网关实例(监听端口、TLS 证书)
- **HTTPRoute** — HTTP 路由规则(类似 Ingress 规则)
- **TLSRoute** — TLS 路由
- **TCPRoute/UDPRoute** — L4 路由

Gateway API 比 Ingress 更强大,但更复杂。目前 nginx-ingress、Traefik、Istio 都已支持 Gateway API,但生产环境迁移还需要时间。建议新项目评估 Gateway API,存量项目继续用 Ingress。

## 八、Ingress 的工程价值

Ingress 是 K8s 网络模型的"对外门户",它的工程价值:

1. **统一入口** — 所有外部流量从 Ingress 进,运维边界清晰
2. **复用端口** — 多个应用共用 80/443,通过域名区分
3. **TLS 集中处理** — 证书管理在 Ingress 层,后端不用管 HTTPS
4. **流量治理** — 灰度、限流、重写,所有非业务逻辑都在 Ingress 层

下一篇我会深入讲 Ingress 的 TLS 加密和 Basic Auth 认证,这是生产环境必上的安全配置。再后续会讲 URL Rewrite 和金丝雀发布,完整覆盖 Ingress 的高级用法。

> Ingress 不只是"HTTP 路由",它是 K8s 集群的"应用层网关"。所有的 L7 流量治理——路由、TLS、认证、灰度——都应该在 Ingress 这一层完成,后端应用只关心业务逻辑。
