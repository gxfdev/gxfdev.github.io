# K8s 调度器:Pod 调度原理与节点选择策略

> Pod 最终运行在哪个节点上,由 K8s 调度器(Scheduler)决定。理解调度原理,才能控制 Pod 的分布——避免单节点资源耗尽、实现故障隔离、优化性能。这篇记录调度器的工作机制和节点选择策略。

## 一、调度器的工作流程

### 1.1 调度过程

当创建一个 Pod,kube-scheduler 会执行:

1. **预选(Predicate)** — 过滤掉不满足条件的节点
2. **优选(Priority)** — 对剩余节点打分,选最优
3. **绑定(Bind)** — 把 Pod 绑定到选中的节点

```
新 Pod 创建 → 预选(过滤不满足条件的节点) → 优选(对剩余节点打分) → 绑定到最优节点
```

### 1.2 预选条件

预选阶段会检查:
- **资源是否足够** — CPU、内存是否满足 Pod requests
- **nodeSelector 是否匹配** — 节点 label 是否匹配
- **taints/tolerations** — Pod 是否容忍节点的污点
- **端口冲突** — hostPort 是否被占用
- **volume 限制** — 节点是否能挂载要求的 volume
- **亲和性规则** — nodeAffinity/podAffinity 是否满足

### 1.3 优选打分

优选阶段对通过的节点打分:
- **LeastRequestedPriority** — 资源使用率低的节点得分高
- **BalancedResourceAllocation** — CPU/内存使用平衡的节点得分高
- **NodeAffinityPriority** — 满足亲和性的节点得分高
- **PodAntiAffinityPriority** — 与冲突 Pod 距离远的节点得分高
- **TaintTolerationPriority** — 污点少的节点得分高

## 二、nodeSelector:最简单的节点选择

### 2.1 给节点打标签

```bash
# 给节点打标签
kubectl label nodes k8s-worker1 disktype=ssd
kubectl label nodes k8s-worker2 disktype=hdd
kubectl label nodes k8s-worker3 gpu=true

# 查看节点标签
kubectl get nodes --show-labels
```

### 2.2 Pod 用 nodeSelector 选择节点

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-pod
spec:
  nodeSelector:
    gpu: "true"                    # 只调度到有 gpu=true 标签的节点
  containers:
  - name: app
    image: tensorflow/tensorflow:latest
    resources:
      limits:
        nvidia.com/gpu: 1
```

这个 Pod 只会调度到 `k8s-worker3`(有 `gpu=true` 标签)。

### 2.3 nodeSelector 的局限

- **硬约束** — 不满足就 Pending,没有"优先"概念
- **只支持精确匹配** — 不支持 "或"、"非" 等逻辑
- **无法表达偏好** — "优先调度到 SSD 节点,但 HDD 也可以"做不到

这些局限由 nodeAffinity 解决。

## 三、nodeAffinity:更强大的节点亲和

### 3.1 requiredDuringScheduling(硬约束)

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: disktype
            operator: In
            values:
            - ssd
            - nvme
```

等价于 nodeSelector,但支持更多操作符:
- **In** — 值在列表中
- **NotIn** — 值不在列表中
- **Exists** — key 存在
- **DoesNotExist** — key 不存在
- **Gt** — 大于(数值比较)
- **Lt** — 小于(数值比较)

### 3.2 preferredDuringScheduling(软约束)

```yaml
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
          - key: disktype
            operator: In
            values:
            - ssd
      - weight: 50
        preference:
          matchExpressions:
          - key: zone
            operator: In
            values:
            - east
```

- **优先调度到 SSD 节点(weight 100)**
- **其次调度到 east 机房(weight 50)**
- **如果都不满足,调度到任意节点**

软约束是"尽量满足",不是必须满足。

## 四、podAffinity:Pod 间亲和

### 4.1 把相关 Pod 调度到一起

```yaml
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - cache
        topologyKey: kubernetes.io/hostname
```

这个 Pod 会调度到已经有 `app=cache` Pod 的节点。适合:
- **应用 + 缓存** — 把 Redis 和应用 Pod 放一起,减少网络延迟
- **前端 + 后端** — 把相关服务放一起,降低调用延迟

### 4.2 podAntiAffinity:Pod 间反亲和

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - web
        topologyKey: kubernetes.io/hostname
```

这个 Pod 不会调度到已经有 `app=web` Pod 的节点。适合:
- **分散副本** — 同一 Deployment 的副本分散到不同节点,避免单节点故障
- **故障隔离** — 互相冲突的 Pod 不放一起

### 4.3 生产环境实践

```yaml
spec:
  replicas: 3
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - myapp
              topologyKey: kubernetes.io/hostname
```

3 个副本尽量分散到不同节点(软约束),提高可用性。

## 五、Taints 和 Tolerations:污点与容忍

### 5.1 给节点打污点

```bash
# 给 master 节点打污点(默认就有)
kubectl taint nodes k8s-master1 node-role.kubernetes.io/control-plane=:NoSchedule

# 给特殊节点打污点
kubectl taint nodes k8s-worker3 dedicated=gpu:NoSchedule
```

污点效果:
- **NoSchedule** — 不调度新 Pod
- **PreferNoSchedule** — 尽量不调度
- **NoExecute** — 不调度新 Pod,且驱逐已有 Pod

### 5.2 Pod 容忍污点

```yaml
spec:
  tolerations:
  - key: "dedicated"
    operator: "Equal"
    value: "gpu"
    effect: "NoSchedule"
```

这个 Pod 能调度到 `k8s-worker3`(有 `dedicated=gpu:NoSchedule` 污点)。

### 5.3 典型场景

- **GPU 节点专用** — GPU 节点打污点,只有需要 GPU 的 Pod 容忍
- **master 节点隔离** — master 有 `NoSchedule` 污点,业务 Pod 不会调度上来
- **维护模式** — 节点维护时打 `NoExecute` 污点,驱逐所有 Pod

## 六、资源限制与调度

### 6.1 requests 和 limits

```yaml
containers:
- name: app
  image: myapp:v1
  resources:
    requests:                     # 调度依据(保证最小资源)
      cpu: 200m                    # 200 millicpu = 0.2 核
      memory: 256Mi
    limits:                       # 运行时限制(最大资源)
      cpu: 500m
      memory: 512Mi
```

- **requests** — 调度器用这个判断节点资源是否足够
- **limits** — kubelet 用这个限制容器最大资源使用

### 6.2 调度原理

节点可调度资源 = 节点总资源 - 所有已调度 Pod 的 requests 之和

```bash
# 查看节点资源
kubectl describe node k8s-worker1
# Allocated resources:
#   cpu: 800m (40%)    # 已分配 0.8 核
#   memory: 2Gi (50%)  # 已分配 2G
```

如果 Pod requests 200m CPU,只能调度到剩余 CPU ≥ 200m 的节点。

## 七、调度器的工程实践

### 7.1 资源规划

```yaml
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1Gi
```

- **requests** 设为日常使用的 1.2 倍,保证调度
- **limits** 设为峰值的 1.5 倍,防止突发
- **CPU limit** 不设(或设高),避免 CPU throttling

### 7.2 副本分散

```yaml
spec:
  replicas: 3
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: myapp
              topologyKey: kubernetes.io/hostname
```

3 副本分散到 3 节点,单节点故障只影响 1/3 流量。

### 7.3 专用节点

```bash
# GPU 节点打污点
kubectl taint nodes k8s-gpu1 dedicated=gpu:NoSchedule
```

```yaml
# GPU Pod 容忍污点
spec:
  tolerations:
  - key: dedicated
    operator: Equal
    value: gpu
    effect: NoSchedule
  nodeSelector:
    gpu: "true"
  containers:
  - name: training
    image: tensorflow/tensorflow:latest-gpu
    resources:
      limits:
        nvidia.com/gpu: 1
```

GPU Pod 只调度到 GPU 节点,其他 Pod 不会占用 GPU 资源。

## 八、调度问题排查

### 8.1 Pod 一直 Pending

```bash
kubectl describe pod my-pod
# Events:
#   Warning  FailedScheduling  ...
#   Message: 0/6 nodes are available: 3 Insufficient cpu, 3 node(s) didn't match node selector.
```

排查:
- **资源不足** — 降低 requests 或加节点
- **nodeSelector 不匹配** — 检查节点 label
- **taints 阻止** — 加 toleration 或去掉 taint

### 8.2 Pod 调度不均衡

```bash
kubectl get pods -o wide
# 发现 5 个 Pod 都在 worker1,worker2/3 空
```

排查:
- **没配 podAntiAffinity** — 副本会随机调度
- **节点资源差异大** — 调度器选资源多的节点

解决:加 podAntiAffinity 强制分散。

## 九、调度的工程哲学

K8s 调度器体现了"声明式"思想——你声明 Pod 的需求(requests、affinity),调度器负责找到合适的节点。这种设计让运维从"手动指定节点"变成"声明约束条件",大幅降低管理复杂度。

但声明式调度也有挑战:
- **调度是静态的** — Pod 创建后不会因为节点资源变化重新调度
- **无法预测未来** — 调度器只看当前资源,不知道后续 Pod
- **亲和性复杂** — 多层 affinity 规则容易出错

生产环境的最佳实践:
1. **设置合理的 requests/limits** — 不要设太小(Pending)也不要设太大(浪费)
2. **用 podAntiAffinity 分散副本** — 高可用基础
3. **专用节点打 taint** — GPU、SSD 等特殊资源隔离
4. **监控节点资源** — 及时扩容,避免调度失败

> 调度不是"选个节点",是"声明需求 + 自动匹配"。理解了 requests、affinity、taint 这三件套,就能精确控制 Pod 的分布,实现高可用和资源优化。
