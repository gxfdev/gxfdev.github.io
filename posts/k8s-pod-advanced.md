# K8s Pod 高级配置:多容器、端口映射、节点选择、网络共享

> 这篇记录 Pod 的高级配置技巧——多容器 Pod、hostPort 端口映射、nodeSelector 节点亲和、hostNetwork 共享宿主机网络。这些是生产环境解决特定问题的关键工具。

## 一、单容器 Pod 的 YAML 模板

```bash
kubectl run test --image myapp:v1 --dry-run=client -o yaml > test1.yml
```

生成的 YAML 文件大致如下,我加了注释说明每个字段的作用:

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: test
  name: test
spec:
  containers:
  - image: myapp:v1
    name: myappv1
    # ports:
    # - name: webport
    #   containerPort: 80
    #   hostPort: 80
    #   protocol: TCP
```

关键字段说明:
- **apiVersion: v1** — Pod 是核心资源,属于 v1 API 组
- **kind: Pod** — 资源类型
- **metadata.labels** — 标签,用于 Service selector 匹配
- **spec.containers** — 容器列表,Pod 可以有多个容器
- **spec.containers[].image** — 镜像名
- **spec.containers[].name** — 容器名,Pod 内必须唯一

## 二、多容器 Pod:Sidecar 模式的基础

### 2.1 多容器配置

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: test
  name: test
spec:
  containers:
  - name: web
    image: nginx:1.23
  - name: busybox
    image: busybox
    command: ["sleep","3600"]
```

```bash
kubectl apply -f test2.yml
kubectl get pods
NAME   READY   STATUS    RESTARTS   AGE
test   2/2     Running   0          11s
```

`READY` 列显示 `2/2`,表示两个容器都 Ready。多容器 Pod 是 K8s 实现 **Sidecar 模式** 的基础——主容器跑业务逻辑,Sidecar 容器做辅助工作(日志收集、配置同步、监控代理)。

经典场景:
- **Istio 服务网格** — 每个 Pod 注入一个 Envoy Sidecar 处理出入流量
- **日志收集** — 主容器写日志到 emptyDir,Filebeat Sidecar 读取并转发
- **TLS 终止** — Sidecar 处理 HTTPS,主容器只跑 HTTP

### 2.2 多容器共享 Pod 网络

多容器 Pod 内的所有容器**共享同一个 network namespace**,所以它们可以通过 `localhost` 互相访问。比如 web 容器监听 80,busybox 容器 `curl localhost:80` 就能访问 web 服务。

这种"Pod 内 localhost 互通"的设计是 Sidecar 模式可行的前提——Sidecar 不需要知道主容器的 IP,直接 `localhost:port` 即可。

## 三、端口映射:hostPort 与 containerPort

### 3.1 hostPort 配置

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: test
  name: test
spec:
  containers:
  - image: myapp:v1
    name: myappv1
    ports:
    - name: webport
      containerPort: 80    # 容器内端口
      hostPort: 80         # 宿主机端口
      protocol: TCP
```

```bash
kubectl apply -f test4.yml
kubectl get pods -o wide
NAME   READY   STATUS    RESTARTS   AGE   IP            NODE        ...
test   1/1     Running   0          7s    10.244.2.31   k8s-node2   ...

curl 172.25.254.50    # 节点 IP
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
```

`containerPort` 声明容器监听的端口(主要是文档作用);`hostPort` 把容器端口直接映射到宿主机端口,外部可以通过节点 IP + hostPort 访问 Pod。

### 3.2 hostPort 的陷阱

hostPort 看起来像 Docker 的 `-p 80:80`,但有个关键区别——**hostPort 直接占用宿主机端口,不经过 kube-proxy**。这意味着:

1. **同一节点上不能有两个 Pod 用同一个 hostPort** — 会端口冲突
2. **Pod 重新调度到别的节点,客户端必须改 IP** — hostPort 不像 NodePort 那样任何节点都能访问

所以 hostPort 的使用场景非常有限,基本只用于:
- **DaemonSet 部署的监控组件** — 比如 Node Exporter,每个节点固定端口 9100
- **网络插件的 agent** — 比如 Calico node,需要直接操作宿主机网络

普通业务服务应该用 **Service + NodePort/LoadBalancer/Ingress**,而不是 hostPort。

## 四、节点选择:nodeSelector 与亲和性

### 4.1 nodeSelector 基础用法

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: lee1
  name: lee1
spec:
  nodeSelector:
    kubernetes.io/hostname: node1   # 强制调度到 node1
  containers:
  - image: myapp:v1
    name: myappv1
```

```bash
kubectl apply -f 5test.yml
kubectl get pods -o wide
NAME   READY   STATUS    RESTARTS   AGE   IP            NODE    ...
lee1   1/1     Running   0          5s    10.244.1.14   node1   ...
```

`nodeSelector` 是最简单的节点选择方式——Pod 只会被调度到带有指定 label 的节点。这种"硬约束"在某些场景是必须的:

- **GPU 任务** — 节点带 `gpu=true` label,只调度到 GPU 节点
- **存储亲和** — 持久化数据在节点 A,Pod 必须调度到 A 才能访问
- **网络隔离** — 某些 Pod 必须在 DMZ 节点,不能在内网节点

### 4.2 nodeSelector 的局限

`nodeSelector` 是"非此即彼"——满足条件就调度,不满足就 Pending。生产环境更常用的是 **nodeAffinity**,它支持:
- `requiredDuringSchedulingIgnoredDuringExecution` — 硬约束(等价于 nodeSelector)
- `preferredDuringSchedulingIgnoredDuringExecution` — 软约束,优先调度但不强制

以及 **podAffinity/podAntiAffinity** — 让 Pod 互相亲和或互斥,比如把缓存服务和数据库放一起(亲和),或者把同一个 Deployment 的副本分散到不同节点(互斥,避免单节点故障导致全部副本挂掉)。

## 五、hostNetwork:共享宿主机网络

### 5.1 配置

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: test
  name: test
spec:
  hostNetwork: true        # 关键字段
  containers:
  - name: busybox
    image: busybox
    command: ["sleep","3600"]
```

### 5.2 验证 Pod 看到的网络

```bash
kubectl exec -it pods/test -c busybox -- /bin/sh
/ # ip a
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue qlen 1000
    inet 127.0.0.1/8 scope host lo
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq qlen 1000
    inet 172.25.254.40/24 brd 172.25.254.255 scope global eth0    # 这是宿主机 IP!
3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue
4: flannel.1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue
5: cni0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue
    inet 10.244.1.1/24 brd 10.244.1.255 scope global cni0
```

可以看到,Pod 里的 `eth0` IP 是 `172.25.254.40`——这就是宿主机的 IP!`hostNetwork: true` 让 Pod 直接使用宿主机的 network namespace,不再分配 Pod 网络。

### 5.3 hostNetwork 的使用场景

hostNetwork 是个"核武器",只在以下场景使用:

1. **网络插件自身** — Calico、Cilium 的 agent 需要 hostNetwork 才能操作宿主机网络栈
2. **Ingress Controller** — 比如 Nginx Ingress,需要直接监听宿主机 80/443 端口
3. **节点监控 agent** — 比如 Prometheus Node Exporter,需要采集宿主机指标

普通业务 Pod **绝对不要**用 hostNetwork,因为:
- 端口冲突风险大(没有 K8s 的端口分配机制)
- Pod 网络与 Service 网络脱节,ClusterIP 无法访问
- 失去 K8s 网络策略的保护

## 六、错误排查:strict decoding error

部署 Pod 时常见的错误之一:

```bash
kubectl apply -f test3.yml
Error from server (BadRequest): error when creating "test3.yml": \
  Pod in version "v1" cannot be handled as a Pod: \
  strict decoding error: unknown field "spec.containers[0].port"
```

错误原因:YAML 里写了 `port` 字段,但正确的字段名是 `ports`(复数)。K8s 1.25+ 启用了 **strict decoding**,所有未知的字段都会被拒绝,避免用户拼写错误导致配置不生效。

排查思路:
1. 看错误信息里的字段路径 `spec.containers[0].port` — 第 0 个容器的 port 字段
2. 查官方 API 文档,正确的字段名是 `ports`
3. 修正 YAML,重新 apply

这种"严格的字段校验"刚开始会让人不适应,但长期看是好的——它逼着你按规范写 YAML,避免"配置写了但没生效"的玄学问题。

## 七、配置管理的工程实践

总结 Pod 高级配置的几条经验:

1. **多容器 Pod 谨慎用** — Sidecar 模式确实强大,但调试复杂度成倍增加。能用 Deployment + Service 解决的,不要上多容器
2. **hostPort 只用于 DaemonSet** — 业务服务用 NodePort 或 Ingress
3. **nodeSelector 简单场景够用** — 复杂调度需求上 nodeAffinity
4. **hostNetwork 是禁区** — 除非你是网络插件作者,否则别碰
5. **YAML 严格模式拥抱它** — 它帮你避免低级错误,代价是手写时要小心字段名

这些配置项是 K8s 灵活性的体现——同一个 Pod 资源,通过不同的字段组合,能解决完全不同的问题。但灵活性也是双刃剑,用错场景反而会引入故障。

> K8s 的配置项像乐高积木,每个字段都有特定用途。理解每个字段的"设计意图"比记住语法更重要——知道它解决什么问题,才知道什么时候该用。
