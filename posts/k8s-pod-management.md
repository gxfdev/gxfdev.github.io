# K8s Pod 管理的两种范式:自主管理 vs 控制器管理

> Pod 是 K8s 调度的最小单元,但 Pod 本身并不"自我管理"。这篇文档对比两种 Pod 创建方式——`kubectl run` 直接创建 vs 通过 Deployment 控制器创建,讲清楚为什么生产环境从不用前者。

## 一、自主管理 Pod:简单但脆弱

### 1.1 创建与生命周期

```bash
kubectl run myappv2 --image myapp:v2 --port 80
pod/myappv2 created
```

这条命令直接创建一个 Pod,没有控制器托管。Pod 的生命周期完全独立——只要不被删除,就一直运行;**但只要挂了,就再也起不来**。

观察 Pod 的状态变化:

```bash
kubectl get pods
NAME      READY   STATUS              RESTARTS   AGE
myappv2   0/1     ContainerCreating   0          8s    # 创建中

kubectl get pods
NAME      READY   STATUS         RESTARTS   AGE
myappv2   0/1     ErrImagePull   0          20s         # 镜像拉取失败

kubectl get pods
NAME      READY   STATUS             RESTARTS   AGE
myappv2   0/1     ImagePullBackOff   0          3m48s        # 放弃重试

# 修复镜像后
kubectl get pods
NAME      READY   STATUS    RESTARTS   AGE
myappv2   1/1     Running   0          4m20s

# 删除
kubectl delete pods myappv2
pod "myappv2" deleted from default namespace
```

这套状态流转背后是 K8s 的 Pod 状态机:`Pending → ContainerCreating → Running` 是正常路径,`ErrImagePull → ImagePullBackOff` 是镜像问题,`CrashLoopBackOff` 是容器启动失败。每种状态对应不同的故障域,排查时根据状态定位问题层级。

### 1.2 自主管理 Pod 的致命缺陷

**Pod 一旦被删除就永久消失**。这在生产环境是不可接受的——节点故障、网络抖动、人为误删,任何一个原因都会导致服务中断。

测试一下:

```bash
# 节点重启后,这个 Pod 不会回来
kubectl delete pods myappv2
kubectl get pods
No resources found in default namespace.
```

这就是为什么自主管理 Pod 在生产环境基本不用,只用于临时调试场景(比如起一个 busybox Pod 进集群内抓包)。

## 二、Deployment 控制器:Pod 的"自我修复"

### 2.1 创建 Deployment

```bash
kubectl create deployment webcluster --image myapp:v2 --replicas 1
deployment.apps/webcluster created
```

这条命令背后发生了什么:
1. K8s 创建一个 Deployment 资源
2. Deployment Controller 根据 `replicas: 1` 创建一个 ReplicaSet
3. ReplicaSet 创建实际的 Pod

这三层结构(Deployment → ReplicaSet → Pod)是 K8s 声明式管理的精髓。Deployment 管"版本",ReplicaSet 管"副本数",Pod 是实际运行的容器。

### 2.2 扩缩容

```bash
kubectl scale deployment webcluster --replicas 2
deployment.apps/webcluster scaled

kubectl scale deployment webcluster --replicas 1
deployment.apps/webcluster scaled
```

`scale` 命令直接修改 Deployment 的 `replicas` 字段,ReplicaSet 会自动创建或销毁 Pod 来匹配期望副本数。**Pod 的生死由 ReplicaSet 管理,而不是人工干预**。

### 2.3 自我修复能力测试

```bash
# 故意删除一个 Pod
kubectl delete pods webcluster-6c8b4bb9d7-jsjws
pod "webcluster-6c8b4bb9d7-jsjws" deleted

# 立即查看,ReplicaSet 已经在创建新 Pod
kubectl get pods
NAME                          READY   STATUS              RESTARTS   AGE
webcluster-6c8b4bb9d7-xxxxx   0/1     ContainerCreating   0          2s
```

这就是控制器管理的核心价值——**Pod 挂了会自动重建,副本数永远保持期望值**。生产环境的服务高可用,本质上就是靠这套机制。

## 三、Label 与 Selector:K8s 的服务发现机制

### 3.1 Label 的工程含义

```bash
# 查看某个 Pod 的 label
kubectl get pods webcluster-6c8b4bb9d7-jsjws --show-labels
NAME                          ...   LABELS
webcluster-6c8b4bb9d7-jsjws   ...   app=webcluster,pod-template-hash=6c8b4bb9d7
```

每个 Pod 都有两个关键 label:
- `app=webcluster` — Deployment 创建时打的,标识属于哪个应用
- `pod-template-hash=6c8b4bb9d7` — ReplicaSet 自动加的,标识属于哪个版本的 Pod 模板

`pod-template-hash` 是滚动更新的关键——每次 Deployment 修改 Pod 模板(比如改镜像版本),hash 就会变化,新的 ReplicaSet 用新 hash,旧的 ReplicaSet 用旧 hash,互不干扰。

### 3.2 删除 Label 的后果

```bash
# 删除 app label
kubectl label pods webcluster-6c8b4bb9d7-jsjws app-
pod/webcluster-6c8b4bb9d7-jsjws unlabeled

# 立即查看,原 Pod 还在,但 ReplicaSet 立刻创建新 Pod 来补副本数
kubectl get pods
NAME                          READY   STATUS    RESTARTS   AGE
webcluster-6c8b4bb9d7-jsjws   1/1     Running   0          5m
webcluster-6c8b4bb9d7-yyyyy   1/1     Running   0          3s
```

删除 label 后,这个 Pod 不再被 ReplicaSet 的 selector 匹配,所以 ReplicaSet 认为副本数不足,立即创建新 Pod。这种"标签解绑即脱离管理"的机制,在故障排查时要特别注意——如果你的 Pod 突然"多出来"一个,大概率是某个 label 被误改了。

### 3.3 重新打 Label

```bash
kubectl label pods webcluster-6c8b4bb9d7-jsjws app=webcluster
pod/webcluster-6c8b4bb9d7-jsjws labeled
```

label 重新打上后,这个 Pod 又被 ReplicaSet 纳入管理,副本数会变成 2(超过期望的 1),然后 ReplicaSet 会销毁一个 Pod 来收敛到期望状态。

## 四、Service:Pod 的稳定访问入口

### 4.1 为什么需要 Service

Pod 的 IP 是不稳定的——每次重建都会换 IP,客户端无法直接连 Pod IP。Service 通过 label selector 关联一组 Pod,对外提供稳定的 ClusterIP,内部做负载均衡。

```bash
kubectl expose deployment webcluster --port 80 --target-port 80
service/webcluster exposed

kubectl describe svc webcluster
Name:                     webcluster
Type:                     ClusterIP
IP:                       10.98.36.168
Port:                     <unset>  80/TCP
TargetPort:               80/TCP
Endpoints:                10.244.1.12:80
Session Affinity:         None
Internal Traffic Policy:  Cluster
```

关键字段:
- **ClusterIP** `10.98.36.168` — 集群内稳定的虚拟 IP,Pod 重建不影响
- **Endpoints** — 后端 Pod IP 列表,Service 会动态更新
- **Selector** — 通过 label 匹配后端 Pod(`app=webcluster`)

### 4.2 Service 的工作机制

```bash
# 直接访问 Service IP
curl 10.98.36.168
Hello MyApp | Version: v2 | <a href="hostname.html">Pod Name</a>
```

Service 的负载均衡是基于 **iptables/IPVS** 实现的。kube-proxy 会在每个节点上写 iptables 规则,把 ClusterIP 的流量 DNAT 到某个后端 Pod IP。所以 Service 本质是"一组 iptables 规则 + label selector",而不是一个独立的进程。

这种设计让 Service 的性能极高(内核态转发,无用户态开销),但也带来调试难点——出问题时需要 `iptables -t nat -L KUBE-SERVICES` 看 Service 链,而不是 `curl` 一个进程。

## 五、滚动更新与回滚

### 5.1 触发滚动更新

```bash
# 把镜像从 myapp:v2 升级到 myapp:v1
kubectl set image deployments webcluster myapp=myapp:v1
deployment.apps/webcluster image updated

# 验证
curl 10.98.36.168
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
```

`kubectl set image` 触发 Deployment 的滚动更新:
1. Deployment 创建新的 ReplicaSet(用新镜像)
2. 新 ReplicaSet 启动一个新 Pod
3. 新 Pod Ready 后,旧 ReplicaSet 销毁一个旧 Pod
4. 重复 2-3,直到所有 Pod 都用新镜像

这种"先扩新,再缩旧"的策略保证了更新过程中服务始终可用,这是 K8s 滚动更新的核心价值。

### 5.2 查看更新历史

```bash
kubectl rollout history deployment webcluster
deployment.apps/webcluster
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
```

每次更新都会生成一个新的 revision。`CHANGE-CAUSE` 是空的,因为创建时没加 `--record`。建议生产环境用 `kubectl apply --record` 或在 YAML 注解里记录变更原因,方便审计。

### 5.3 回滚到指定版本

```bash
kubectl rollout undo deployment webcluster --to-revision 1
deployment.apps/webcluster rolled back

curl 10.98.36.168
Hello MyApp | Version: v2 | <a href="hostname.html">Pod Name</a>
```

回滚本质是"反向滚动更新"——把 revision 1 对应的 ReplicaSet 重新激活,把当前版本缩容到 0。整个过程也是无停机的,因为还是"先扩新,再缩旧"的策略。

这种"版本即 ReplicaSet"的设计让回滚成本极低——只要旧的 ReplicaSet 还在(默认保留 10 个历史版本),回滚就是几秒钟的事。在电商项目里,我们 CI/CD 流水线每次部署都自动创建新 revision,出问题一键 `rollout undo`,根本不需要回滚脚本。

## 六、生产环境的 Pod 管理实践

总结几条生产环境的最佳实践:

1. **永远不要直接创建 Pod** — 即使测试也用 Deployment, replica=1 即可
2. **YAML 文件进 Git** — 所有 Deployment 配置必须版本控制
3. **镜像 tag 用语义化版本** — 不要用 `latest`,否则 `rollout undo` 找不到正确版本
4. **配置 `readinessProbe` 和 `livenessProbe`** — 这是滚动更新正确工作的前提
5. **保留足够的历史 revision** — `revisionHistoryLimit: 20` 比默认的 10 更安全

这些规则我在 Web 集群项目里都落地了,后续文章会详细展开。

> Pod 是 K8s 的执行单元,Deployment 是 Pod 的"管理者"。理解了这层关系,就理解了 K8s 声明式管理的核心——你声明"想要什么",Controller 负责让"实际是什么"收敛到"想要什么"。
