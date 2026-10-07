# K8s 弹性伸缩:HPA、VPA 与集群自动扩缩容

> 流量高峰时 Pod 不够用,流量低谷时 Pod 浪费资源。K8s 的弹性伸缩能力让应用根据负载自动调整副本数,这篇记录 HPA(水平扩缩容)、VPA(垂直扩缩容)和 Cluster Autoscaler 的工程实践。

## 一、弹性伸缩的三种方式

### 1.1 水平扩缩容(HPA)

**Horizontal Pod Autoscaler** — 根据负载自动增减 Pod 副本数

- **适用** — Web 服务、API 服务(无状态应用)
- **原理** — 监控 CPU/内存/自定义指标,自动 scale Deployment
- **优势** — 线性扩展,理论上无上限

### 1.2 垂直扩缩容(VPA)

**Vertical Pod Autoscaler** — 自动调整 Pod 的 requests/limits

- **适用** — 数据库、有状态应用(无法水平扩展)
- **原理** — 分析历史资源使用,推荐合理 requests
- **限制** — 调整需要重启 Pod

### 1.3 集群自动扩缩容(CA)

**Cluster Autoscaler** — 节点不够时自动从云厂商申请新节点

- **适用** — 云上集群(AWS、阿里云、腾讯云)
- **原理** — Pod Pending 时自动加节点,空闲时自动释放
- **限制** — 依赖云厂商支持

## 二、HPA 水平扩缩容

### 2.1 部署 Metrics Server

HPA 需要 Metrics Server 提供 CPU/内存指标:

```bash
# 安装 Metrics Server
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# 验证
kubectl top nodes
NAME          CPU(cores)   MEMORY(bytes)
k8s-master1   200m          2Gi
k8s-worker1   100m          1Gi
...
```

### 2.2 创建 HPA

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 3                    # 最小副本数
  maxReplicas: 10                   # 最大副本数
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70      # CPU 使用率目标 70%
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80      # 内存使用率目标 80%
```

- **minReplicas: 3** — 平时保持 3 副本
- **maxReplicas: 10** — 最多扩到 10 副本
- **CPU 目标 70%** — 平均 CPU > 70% 时扩容,< 70% 时缩容

### 2.3 HPA 工作原理

```
监控周期(默认 15 秒):
  1. 获取 Deployment 所有 Pod 的 CPU 使用率
  2. 计算平均值
  3. 如果 > 70%,计算需要的副本数 = ceil(当前副本数 * 实际使用率 / 70%)
  4. 如果 < 70%,计算需要的副本数(向下取整)
  5. 调整 Deployment 的 replicas
```

举例:
- 当前 3 副本,CPU 使用率 90%
- 需要副本数 = ceil(3 * 90% / 70%) = ceil(3.86) = 4
- 扩容到 4 副本

### 2.4 自定义指标 HPA

除了 CPU/内存,还可以基于自定义指标(QPS、队列长度)扩缩容:

```yaml
metrics:
- type: Pods
  pods:
    metric:
      name: http_requests_per_second
    target:
      type: AverageValue
      averageValue: "1000"          # 每秒 1000 请求
```

需要部署 Prometheus Adapter 把 Prometheus 指标暴露给 K8s API。

### 2.5 HPA 行为调优

```yaml
behavior:
  scaleDown:
    stabilizationWindowSeconds: 300    # 缩容稳定窗口 5 分钟
    policies:
    - type: Percent
      value: 10                         # 每次最多缩 10%
      periodSeconds: 60
  scaleUp:
    stabilizationWindowSeconds: 0       # 扩容立即执行
    policies:
    - type: Percent
      value: 100                        # 每次最多扩 100%
      periodSeconds: 60
    - type: Pods
      value: 4                          # 或最多加 4 个 Pod
      periodSeconds: 60
    selectPolicy: Max
```

- **扩容快** — 流量来了立即扩,最多翻倍
- **缩容慢** — 流量降了等 5 分钟,每次只缩 10%

避免"扩缩容抖动"——流量波动导致副本数频繁变化。

## 三、VPA 垂直扩缩容

### 3.1 部署 VPA

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-up.sh
```

### 3.2 创建 VPA

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"              # Auto | Off | Initial
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 1000m
        memory: 1Gi
```

`updateMode`:
- **Auto** — 自动调整 requests(需要重启 Pod)
- **Initial** — 只在 Pod 创建时调整,不重启已有 Pod
- **Off** — 只给建议,不实际调整(推荐先用 Off 观察)

### 3.3 VPA 的使用场景

- **数据库** — MySQL/Redis 无法水平扩展,用 VPA 调整资源
- **JVM 应用** — Java 应用内存需求变化大,VPA 自动调整
- **资源优化** — 分析 VPA 建议,手动优化 requests

### 3.4 VPA 的限制

- **需要重启 Pod** — 调整 requests 需要重建 Pod
- **与 HPA 冲突** — 同一资源不能同时用 HPA 和 VPA(对同一指标)
- **不稳定** — VPA 还是 beta,生产环境慎用

## 四、Cluster Autoscaler

### 4.1 工作原理

```
Pod Pending(资源不足)
    ↓
Cluster Autoscaler 检测到 Pending Pod
    ↓
从云厂商申请新节点
    ↓
新节点加入集群
    ↓
Pending Pod 调度到新节点
```

### 4.2 配置(AWS EKS 示例)

```yaml
# Cluster Autoscaler Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        image: k8s.gcr.io/autoscaling/cluster-autoscaler:v1.8.0
        command:
        - ./cluster-autoscaler
        - --scale-down-unneeded-time=10m      # 空闲 10 分钟后缩容
        - --scale-down-delay-after-add=10m    # 扩容后 10 分钟内不缩容
        - --max-node-provision-time=15m       # 节点创建超时
```

### 4.3 节点组配置

在云厂商控制台配置节点组:
- **最小节点数** — 3(保证基础容量)
- **最大节点数** — 20(限制成本)
- **节点规格** — 按需选择(如 4C8G)

Cluster Autoscaler 在 3-20 之间自动调整。

## 五、弹性伸缩的工程实践

### 5.1 HPA + CA 组合

```
流量增加 → HPA 扩容 Pod → 节点资源不足 → Pod Pending → CA 扩容节点 → Pod 调度成功
流量减少 → HPA 缩容 Pod → 节点空闲 → CA 缩容节点 → 节省成本
```

这套组合实现了"Pod 级别 + 节点级别"的双层弹性。

### 5.2 容量规划

```yaml
# 基础容量(始终保留)
minReplicas: 3
# 峰值容量(最大扩展)
maxReplicas: 10
# 节点最小数
minNodes: 3
# 节点最大数
maxNodes: 20
```

规划原则:
- **minReplicas** — 承受日常流量,不依赖扩容
- **maxReplicas** — 承受峰值流量,但受限于预算
- **minNodes** — 满足 minReplicas 的资源需求
- **maxNodes** — 满足 maxReplicas 的资源需求

### 5.3 扩缩容策略

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 0       # 扩容立即执行
    policies:
    - type: Percent
      value: 100                        # 每次最多翻倍
      periodSeconds: 60
  scaleDown:
    stabilizationWindowSeconds: 600     # 缩容等 10 分钟
    policies:
    - type: Percent
      value: 10                         # 每次最多缩 10%
      periodSeconds: 60
```

- **扩容快** — 流量来了立即扩,避免雪崩
- **缩容慢** — 流量降了等一会,避免抖动

### 5.4 监控告警

```promql
# HPA 扩容到上限
kube_hpa_status_condition{condition="ScalingLimited", status="true"}

# Pod Pending 时间过长
rate(kube_pod_status_phase{phase="Pending"}[5m]) > 0

# 节点资源使用率
sum(rate(container_cpu_usage_seconds_total[5m])) by (node) / sum(kube_node_status_allocatable) by (node)
```

告警规则:
- HPA 达到 maxReplicas — 容量不足,需要调大 maxReplicas 或加节点
- Pod Pending > 5 分钟 — 调度失败,检查资源
- 节点 CPU > 80% — 资源紧张,准备扩容

## 六、弹性伸缩的陷阱

### 6.1 扩容太慢

**问题**: 流量突增,HPA 扩容需要 1-2 分钟(Pod 启动 + 应用预热),期间服务可能被压垮。

**解决**:
- **预扩容** — 在预期流量高峰前手动 scale
- **minReplicas 设大** — 平时多保留副本,应对突发
- **用 HPA 预测** — 基于历史数据预测扩容(需要工具支持)

### 6.2 缩容抖动

**问题**: 流量波动导致 HPA 频繁扩缩容,Pod 频繁创建销毁。

**解决**:
- **stabilizationWindowSeconds** — 缩容稳定窗口,默认 5 分钟,建议 10 分钟
- **scaleDown policy** — 每次最多缩 10%,避免大幅缩容
- **自定义指标** — CPU/内存可能抖动,用 QPS 等稳定指标

### 6.3 HPA 与 VPA 冲突

**问题**: HPA 基于 CPU 扩缩容,VPA 又调整 CPU requests,导致 HPA 行为异常。

**解决**: HPA 和 VPA 不要对同一指标操作。建议:
- HPA 用 CPU/自定义指标
- VPA 用内存(或 Off 模式只观察)

### 6.4 节点扩容成本

**问题**: CA 自动扩容节点,但忘记缩容,导致成本失控。

**解决**:
- **设置 maxNodes** — 限制最大节点数
- **监控节点使用率** — 低使用率节点及时缩容
- **成本告警** — 云账单异常时告警

## 七、弹性伸缩的工程价值

弹性伸缩是云原生降本增效的核心:

1. **应对流量峰值** — 双 11、促销等活动自动扩容
2. **节省成本** — 低谷时自动缩容,不浪费资源
3. **自动化运维** — 无需人工干预,7x24 自动调整
4. **提高可用性** — 流量来了能扛住,不会因为资源不足崩溃

在电商项目里,我们用 HPA + CA 实现了:
- **日常 3 副本** — 承受平时流量
- **峰值 15 副本** — 大促时自动扩容
- **节点 3-8 个** — 根据需求自动调整
- **成本降低 40%** — 低谷时自动缩容

这种"按需使用"的模式,是云原生相比传统运维的最大优势——不再需要为峰值容量买单,资源利用率大幅提升。

> 弹性伸缩不是"自动扩容",是"按需使用"。它让资源利用率从"为峰值买单"变成"按实际使用",这是云原生降本增效的核心。
