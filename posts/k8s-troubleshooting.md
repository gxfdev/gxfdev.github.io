# K8s 故障排查:Pod 状态解析与常见问题诊断

> K8s 运维的核心技能是故障排查——Pod 状态异常时,如何快速定位问题根因。这篇记录 Pod 各种异常状态的含义、排查思路和常见故障的解决方案。

## 一、Pod 状态解析

### 1.1 Pod 生命周期状态

| 状态 | 含义 | 是否正常 |
|------|------|---------|
| **Pending** | Pod 已创建,但还未调度或容器未启动 | 短暂正常,长时间异常 |
| **Running** | 所有容器已创建,至少一个在运行 | ✅ 正常 |
| **Succeeded** | 所有容器正常退出 | Job 正常,Deployment 异常 |
| **Failed** | 所有容器退出,至少一个异常 | ❌ 异常 |
| **Unknown** | 无法与节点通信 | ❌ 节点故障 |

### 1.2 容器状态

```bash
kubectl get pods
NAME    READY   STATUS              RESTARTS   AGE
myapp   0/1     ContainerCreating   0          10s
```

- **READY** — `0/1` 表示 1 个容器中 0 个 Ready
- **STATUS** — 容器当前状态
- **RESTARTS** — 重启次数
- **AGE** — Pod 创建时长

## 二、Pending 状态排查

### 2.1 Pending 的原因

Pod 一直 Pending,通常是调度失败:

```bash
kubectl describe pod my-pod
# Events:
#   Warning  FailedScheduling  ...
#   Message: 0/6 nodes are available: 3 Insufficient cpu, 3 node(s) didn't match node selector.
```

常见原因:
- **资源不足** — 节点 CPU/内存不够
- **nodeSelector 不匹配** — 没有符合条件的节点
- **taints 阻止** — 节点有污点,Pod 没有容忍
- **affinity 不满足** — 亲和性规则无法满足

### 2.2 排查步骤

```bash
# 1. 查看 Pod 事件
kubectl describe pod my-pod

# 2. 查看节点资源
kubectl top nodes
kubectl describe node k8s-worker1 | grep -A 10 "Allocated resources"

# 3. 检查节点 label
kubectl get nodes --show-labels

# 4. 检查 taints
kubectl describe node k8s-worker1 | grep -i taint
```

### 2.3 解决方案

- **降低 requests** — 资源不够时降低 Pod 资源需求
- **加节点** — 集群资源确实不足
- **修改 nodeSelector** — 放宽节点选择条件
- **加 toleration** — 容忍节点的污点

## 三、ContainerCreating 状态

### 3.1 常见原因

Pod 卡在 ContainerCreating,通常是镜像或网络问题:

```bash
kubectl describe pod my-pod
# Events:
#   Normal   Pulling            pulling image "myapp:v1"
#   Warning  Failed             Failed to pull image "myapp:v1": rpc error
```

常见原因:
- **镜像拉取失败** — 镜像不存在、仓库认证失败、网络问题
- **存储挂载失败** — PVC 未绑定、NFS 挂载失败
- **CNI 网络问题** — Flannel/Calico 未就绪

### 3.2 镜像拉取失败

```bash
# 检查镜像名是否正确
kubectl get pod my-pod -o jsonpath='{.spec.containers[*].image}'

# 检查 imagePullSecrets
kubectl get pod my-pod -o jsonpath='{.spec.imagePullSecrets}'

# 手动测试拉取
docker pull reg.zxf.org/myapp:v1
```

解决方案:
- **私有仓库加 imagePullSecrets** — 配置认证 Secret
- **检查镜像 tag** — 确认 tag 存在
- **检查网络** — 节点能访问镜像仓库

### 3.3 存储挂载失败

```bash
# 检查 PVC 状态
kubectl get pvc
NAME       STATUS    VOLUME   CAPACITY   ACCESS MODES
my-pvc     Pending                                      # PVC 未绑定

# 检查 PV
kubectl get pv
```

解决方案:
- **PVC Pending** — 没有匹配的 PV,需要创建 PV 或用 StorageClass
- **NFS 挂载失败** — 检查 NFS 服务、权限、网络

## 四、CrashLoopBackOff 状态

### 4.1 原因

容器启动后崩溃,K8s 重启,再崩溃,循环往复:

```bash
kubectl get pods
NAME    READY   STATUS              RESTARTS   AGE
myapp   0/1     CrashLoopBackOff    5          3m
```

常见原因:
- **应用启动失败** — 配置错误、依赖缺失
- **命令错误** — command/args 配置错误
- **探针失败** — livenessProbe 配置不当
- **权限问题** — 容器以非 root 运行但需要 root 权限

### 4.2 排查步骤

```bash
# 1. 查看容器日志
kubectl logs my-pod
kubectl logs my-pod --previous          # 查看上次崩溃的日志

# 2. 查看容器事件
kubectl describe pod my-pod

# 3. 进入容器调试(如果还能进)
kubectl exec -it my-pod -- /bin/sh
```

### 4.3 常见 CrashLoopBackOff 场景

**场景 1:应用配置错误**

```
Error: Could not find or load main class com.example.MyApp
```

解决:检查 jar 包路径、镜像构建是否正确。

**场景 2:数据库连接失败**

```
Caused by: java.net.ConnectException: Connection refused (Connection refused)
```

解决:检查数据库 Service 是否存在、网络是否通。

**场景 3:探针配置不当**

```
Liveness probe failed: HTTP probe failed with statuscode: 404
```

解决:检查 livenessProbe 路径是否正确,或增加 initialDelaySeconds。

## 五、ImagePullBackOff 状态

### 5.1 原因

镜像拉取失败,K8s 退避重试:

```bash
kubectl get pods
NAME    READY   STATUS              RESTARTS   AGE
myapp   0/1     ImagePullBackOff    0          2m
```

常见原因:
- **镜像不存在** — tag 写错或镜像没推送
- **认证失败** — 私有仓库没配 imagePullSecrets
- **网络问题** — 节点无法访问镜像仓库

### 5.2 排查

```bash
kubectl describe pod my-pod
# Warning  Failed     Failed to pull image "reg.zxf.org/myapp:v1": rpc error: code = Unknown desc = Error response from daemon: Get https://reg.zxf.org/v2/: denied: access forbidden
```

- **access forbidden** — 认证失败,加 imagePullSecrets
- **not found** — 镜像不存在,检查 tag
- **timeout** — 网络问题,检查节点到仓库的连通性

### 5.3 解决方案

```yaml
spec:
  imagePullSecrets:
  - name: harbor-auth               # 配置私有仓库认证
  containers:
  - name: app
    image: reg.zxf.org/myapp:v1     # 确认镜像名和 tag
```

## 六、OOMKilled 状态

### 6.1 原因

容器内存超过 limits,被内核 OOM Killer 杀死:

```bash
kubectl describe pod my-pod
# Last State: Terminated
#   Reason: OOMKilled
#   Exit Code: 137
```

### 6.2 排查

```bash
# 查看容器内存使用
kubectl top pod my-pod

# 查看历史资源使用
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/default/pods/my-pod"
```

### 6.3 解决方案

- **增加 limits.memory** — 内存确实不够,调大限制
- **优化应用** — 内存泄漏,修复代码
- **检查 JVM 参数** — Java 应用 -Xmx 设置不当

```yaml
resources:
  limits:
    memory: 1Gi                     # 从 512Mi 调大到 1Gi
```

## 七、Evicted 状态

### 7.1 原因

节点资源压力(磁盘满、内存紧张),kubelet 驱逐 Pod:

```bash
kubectl get pods
NAME    READY   STATUS      RESTARTS   AGE
myapp   0/1     Evicted     0          5m
```

常见原因:
- **磁盘压力** — 节点磁盘使用率 > 85%
- **内存压力** — 节点内存紧张
- **kubelet 配置** — eviction-hard 阈值触发

### 7.2 排查

```bash
# 查看节点状态
kubectl describe node k8s-worker1
# Conditions:
#   MemoryPressure   True
#   DiskPressure     True

# 查看节点资源
kubectl top node k8s-worker1
df -h                                # SSH 到节点检查磁盘
```

### 7.3 解决方案

- **清理磁盘** — 清理 Docker 镜像、日志
- **加节点** — 节点资源确实不足
- **调整 eviction 阈值** — 修改 kubelet 配置

```bash
# 清理 Docker
docker system prune -a -f

# 清理日志
journalctl --vacuum-time=1d
```

## 八、节点 NotReady

### 8.1 原因

节点失联,kubelet 无法与 API Server 通信:

```bash
kubectl get nodes
NAME          STATUS     ROLES           AGE   VERSION
k8s-worker1   NotReady   <none>          30d   v1.35.3
```

常见原因:
- **节点宕机** — 硬件故障、系统崩溃
- **kubelet 故障** — kubelet 进程挂了
- **网络问题** — 节点与 master 网络不通

### 8.2 排查

```bash
# SSH 到节点检查
ssh k8s-worker1

# 检查 kubelet
systemctl status kubelet
journalctl -u kubelet --since "10 minutes ago"

# 检查网络
ping k8s-master1
```

### 8.3 解决方案

- **重启 kubelet** — `systemctl restart kubelet`
- **修复网络** — 检查网卡、路由
- **节点维护** — `kubectl cordon` + `kubectl drain`

## 九、故障排查方法论

### 9.1 排查流程

```
Pod 异常
   ↓
kubectl get pods (看 STATUS)
   ↓
kubectl describe pod (看 Events)
   ↓
kubectl logs (看应用日志)
   ↓
kubectl logs --previous (看崩溃前日志)
   ↓
kubectl exec (进容器调试)
   ↓
SSH 到节点 (检查节点状态)
```

### 9.2 常用排查命令

```bash
# Pod 状态
kubectl get pods -o wide
kubectl describe pod <pod-name>

# 日志
kubectl logs <pod-name>
kubectl logs <pod-name> --previous
kubectl logs <pod-name> -c <container-name>

# 进入容器
kubectl exec -it <pod-name> -- /bin/sh

# 节点状态
kubectl get nodes
kubectl describe node <node-name>
kubectl top nodes

# 事件
kubectl get events --sort-by='.lastTimestamp'
```

### 9.3 调试技巧

**临时调试 Pod**:

```yaml
# 用 busybox 调试 Pod
apiVersion: v1
kind: Pod
metadata:
  name: debug
spec:
  containers:
  - name: debug
    image: busybox
    command: ['sleep', '3600']
  restartPolicy: Never
```

```bash
kubectl exec -it debug -- /bin/sh
# 在集群内测试网络、DNS 等
```

**端口转发调试**:

```bash
# 转发 Pod 端口到本地
kubectl port-forward pod/my-pod 8080:80

# 转发 Service 端口
kubectl port-forward svc/my-svc 8080:80
```

## 十、故障排查的工程哲学

K8s 故障排查的核心是"分层定位":

1. **集群层** — 节点是否 Ready、etcd 是否健康
2. **控制面层** — API Server、Scheduler、Controller Manager 是否正常
3. **网络层** — CNI、Service、DNS 是否工作
4. **存储层** — PV/PVC 是否挂载
5. **应用层** — 容器日志、应用配置

每一层都有对应的排查命令,从上到下逐层检查,问题就能定位。

生产环境的排查经验:
- **先看 Events** — `kubectl describe` 的 Events 是第一手信息
- **再看日志** — `kubectl logs` 看应用报错
- **进容器验证** — `kubectl exec` 进容器测试网络、文件
- **最后看节点** — SSH 到节点检查系统状态

这套方法论让我们在电商项目中,平均故障定位时间从 30 分钟降到 5 分钟——这就是排查能力的价值。

> 故障排查不是"试错",是"分层定位"。每一层都有明确的检查方法,按流程走,问题总能找到。
