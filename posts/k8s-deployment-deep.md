# K8s Deployment 控制器深度解析:滚动更新、回滚与版本治理

> Deployment 是 K8s 里最常用的控制器,但很多人只停留在"创建、扩缩容"层面。这篇深入解析 Deployment 的工作机制——ReplicaSet 与版本管理、滚动更新策略、回滚机制,以及生产环境的版本治理实践。

## 一、Deployment、ReplicaSet、Pod 的三层结构

### 1.1 三层关系

```
Deployment (apps/v1)
    └── 控制 ──> ReplicaSet (apps/v1)
                     └── 控制 ──> Pod (v1)
                                     └── 运行 ──> Container
```

每一层的职责:
- **Deployment** — 管"版本",定义应用在不同版本间的迁移策略
- **ReplicaSet** — 管"副本数",确保任意时刻都有期望数量的 Pod 在运行
- **Pod** — 实际运行的容器实例,被 ReplicaSet 创建和销毁

这种分层设计的核心价值在于**版本与副本解耦**。当 Deployment 触发滚动更新时,它会创建一个新的 ReplicaSet(用新镜像),旧的 ReplicaSet 保留但副本数缩到 0。这样既保证了新版本接管流量,也保留了回滚到旧版本的能力。

### 1.2 验证三层结构

```bash
# 创建 Deployment
kubectl create deployment webcluster --image myapp:v2 --replicas 3

# 查看 ReplicaSet
kubectl get replicasets
NAME                    DESIRED   CURRENT   READY   AGE
webcluster-6c8b4bb9d7   3         3         3       30s

# 查看 Pod
kubectl get pods
NAME                          READY   STATUS    RESTARTS   AGE
webcluster-6c8b4bb9d7-abc12   1/1     Running   0          30s
webcluster-6c8b4bb9d7-def34   1/1     Running   0          30s
webcluster-6c8b4bb9d7-ghi56   1/1     Running   0          30s
```

可以看到,ReplicaSet 名字 `webcluster-6c8b4bb9d7` 是 Deployment 名字 + Pod 模板哈希。这个哈希值是 K8s 自动计算的,基于 Pod 模板的内容(image、env、command 等)。**只要 Pod 模板变了,哈希就变,就会创建新的 ReplicaSet**。

## 二、滚动更新:零停机部署的核心机制

### 2.1 触发滚动更新

```bash
# 把镜像从 myapp:v2 升级到 myapp:v1
kubectl set image deployments webcluster myapp=myapp:v1
deployment.apps/webcluster image updated
```

### 2.2 滚动更新的内部流程

```bash
# 查看更新过程中的 ReplicaSet
kubectl get replicasets
NAME                    DESIRED   CURRENT   READY   AGE
webcluster-6c8b4bb9d7   2         2         2       5m     # 旧 RS,缩容中
webcluster-7d9c5cc8e2   2         3         2       20s    # 新 RS,扩容中
```

更新过程:
1. Deployment 创建新的 ReplicaSet `7d9c5cc8e2`(用 myapp:v1)
2. 新 RS 扩容到 2(maxSurge 决定),同时旧 RS 缩容到 2
3. 等待新 RS 里有 Pod Ready
4. 新 RS 扩容到 3,旧 RS 缩容到 0
5. 更新完成,旧 RS 保留(replicas=0),用于回滚

整个过程通过 `kubectl rollout status` 实时监控:

```bash
kubectl rollout status deployment webcluster
Waiting for rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for rollout to finish: 2 of 3 updated replicas are available...
deployment "webcluster" successfully rolled out
```

### 2.3 滚动更新策略参数

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webcluster
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1           # 滚动更新时,最多比期望副本数多 1 个
      maxUnavailable: 0     # 滚动更新时,最多比期望副本数少 0 个
  template:
    # ...
```

两个关键参数:

**`maxSurge: 1`** — 更新过程中,新 RS 最多比期望副本数多 1 个。比如期望 3 个,更新时最多 4 个(3 旧 + 1 新)。这个值控制"额外资源消耗上限"。

**`maxUnavailable: 0`** — 更新过程中,允许比期望副本数少 0 个。即任何时候至少有 3 个 Pod Ready。这个值控制"可用性下限"。

生产环境推荐配置:
- **`maxSurge: 25%, maxUnavailable: 0`** — 保证可用性,适合核心服务
- **`maxSurge: 1, maxUnavailable: 1`** — 资源敏感型,适合批处理任务

如果 `maxUnavailable: 0` 且没配 readinessProbe,滚动更新会卡住——因为新 Pod 不会被标记为 Ready,Deployment 不敢缩容旧 Pod。**readinessProbe 是滚动更新正确工作的前提**。

### 2.4 Readiness Probe 与滚动更新的协作

滚动更新的"先扩新再缩旧"策略依赖 readinessProbe 判断新 Pod 是否就绪:

```
1. 新 Pod 启动,readinessProbe 失败,不进入 Service Endpoints
2. 新 Pod readinessProbe 成功,进入 Endpoints,接收流量
3. Deployment 看到 maxSurge 已满,开始缩旧 RS
4. 旧 Pod 收到 SIGTERM,从 Endpoints 移除,处理完已有请求后退出
```

这套机制要求应用正确处理 SIGTERM 信号:
- 收到 SIGTERM 后,停止接收新请求
- 等待已有请求处理完
- 释放资源(数据库连接、文件句柄)
- 退出进程

Java Spring Boot 应用默认支持优雅停机:
```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

不配置优雅停机的后果:Pod 收到 SIGTERM 立刻被 kill,正在处理的请求返回 502,用户体验受损。

## 三、版本历史与回滚

### 3.1 查看版本历史

```bash
kubectl rollout history deployment webcluster
deployment.apps/webcluster
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
```

每次更新都会生成新的 revision。`CHANGE-CAUSE` 默认是空的,建议用 `--record` 记录命令:

```bash
kubectl set image deployments webcluster myapp=myapp:v1 --record
# revision 2 的 CHANGE-CAUSE 会变成 "kubectl set image ..."
```

但 `--record` 已经被标记为 deprecated(K8s 1.21+),推荐用 **kustomize annotation** 或在 CI/CD 流水线里把 commit hash 写到 Deployment 的 annotation:

```yaml
metadata:
  annotations:
    deployment.kubernetes.io/revision: "2"
    ci.example.com/git-commit: "abc1234"
    ci.example.com/build-url: "https://jenkins.example.com/job/123"
```

这种"版本即 Git commit"的可追溯性,是 GitOps 工作流的基础。

### 3.2 回滚到指定版本

```bash
# 回滚到上一个版本
kubectl rollout undo deployment webcluster

# 回滚到指定 revision
kubectl rollout undo deployment webcluster --to-revision=1
```

回滚的内部机制:
1. Deployment 找到 revision 1 对应的 ReplicaSet
2. 把它的 replicas 从 0 扩到期望值(3)
3. 同时把当前 ReplicaSet 缩到 0
4. 回滚完成,生成新的 revision 3(注意:不是 revision 1 复活,而是新的 revision)

这种"用旧 ReplicaSet 直接扩容"的回滚方式,**不需要重新拉镜像**——因为旧 ReplicaSet 的 Pod 模板用的就是旧镜像。所以回滚速度极快,通常几秒钟就完成。

### 3.3 回滚的工程意义

回滚能力是生产部署的安全网。在电商项目的 CI/CD 流水线里,我们配了完整的回滚机制:

1. **自动回滚** — 部署后 5 分钟内,如果 5xx 错误率 > 1%,自动 `rollout undo`
2. **手动回滚** — 运维同学发现异常,一键 `kubectl rollout undo` 恢复
3. **金丝雀发布** — 新版本先发 1 个 Pod,观察 30 分钟没问题再全量

这套机制让我们在两次线上事故中(一次是 SQL 性能问题,一次是配置错误)在 1 分钟内回滚,用户基本无感知。如果没有快速回滚能力,事故响应时间会从分钟级变成小时级。

## 四、revisionHistoryLimit:版本保留策略

```yaml
spec:
  revisionHistoryLimit: 10    # 默认 10
```

Deployment 默认保留 10 个历史 ReplicaSet,超过的会被自动清理。这个值的权衡:

- **太大** — 占用 etcd 存储,旧 ReplicaSet 多了影响 kubectl 输出
- **太小** — 回滚余地小,生产环境建议至少 20

etcd 存储成本几乎可以忽略(每个 ReplicaSet 几 KB),所以生产环境建议 `revisionHistoryLimit: 20` 甚至更高,给回滚留充足余地。

## 五、Deployment 的工程化部署模板

完整的 Deployment YAML 模板(生产环境):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webcluster
  labels:
    app: webcluster
    version: v1
  annotations:
    deployment.kubernetes.io/revision: "1"
    ci.example.com/git-commit: "abc1234"
spec:
  replicas: 3
  revisionHistoryLimit: 20
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: webcluster
  template:
    metadata:
      labels:
        app: webcluster
        version: v1
    spec:
      containers:
      - name: web
        image: reg.zxf.org/webcluster:v1
        imagePullPolicy: IfNotPresent
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        startupProbe:
          httpGet:
            path: /healthz
            port: 8080
          failureThreshold: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          periodSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          periodSeconds: 10
          failureThreshold: 3
        lifecycle:
          preStop:
            exec:
              command: ["sh", "-c", "sleep 10"]    # 优雅停机缓冲
        env:
        - name: SPRING_PROFILES_ACTIVE
          value: prod
      terminationGracePeriodSeconds: 60
```

几个关键配置项的工程含义:

- **`imagePullPolicy: IfNotPresent`** — 节点有镜像就不拉,加速启动
- **`resources.requests/limits`** — 资源声明,影响调度和质量保障
- **`startupProbe + readinessProbe + livenessProbe`** — 三层探针,慢启动 + 流量控制 + 自愈
- **`lifecycle.preStop`** — 收到 SIGTERM 前先 sleep 10 秒,让 Service Endpoints 更新完成
- **`terminationGracePeriodSeconds: 60`** — 给应用 60 秒处理已有请求

这些配置组合起来,才能实现真正的"零停机滚动更新"。每个字段都有它的设计意图,缺一不可。

## 六、生产环境的 Deployment 治理实践

### 6.1 命名规范

- **版本号语义化** — `webcluster:v1.2.3` 而不是 `webcluster:latest`
- **镜像 tag 用 Git SHA** — `webcluster:abc1234`,保证唯一性
- **Deployment 名带版本** — `webcluster-v1`, `webcluster-v2`,方便多版本并存

### 6.2 部署策略选择

不同场景用不同策略:

1. **RollingUpdate** — 日常发布,默认策略
2. **Recreate** — 测试环境,先全删再重建,资源占用少但停机
3. **Blue/Green** — 用两个 Deployment + Service selector 切换,适合大版本升级
4. **Canary** — 用 Ingress + weight 做流量切分,新版本先承接 10% 流量

### 6.3 部署流水线集成

Jenkins Pipeline 部署阶段的标准步骤:

```groovy
stage('Deploy') {
    steps {
        // 1. 部署新版本
        sh 'kubectl apply -f k8s/deployment.yml'
        
        // 2. 等待 rollout 完成
        sh 'kubectl rollout status deployment/webcluster --timeout=300s'
        
        // 3. 健康检查(5 分钟观察期)
        sh '''
        for i in $(seq 1 30); do
            ERROR_RATE=$(kubectl exec monitoring -- curl -s http://prometheus:9090/api/v1/query?query=rate(http_requests_total{status=~"5.."}[1m]) | jq '.data.result[0].value[1]')
            if [ $(echo "$ERROR_RATE > 0.01" | bc) -eq 1 ]; then
                kubectl rollout undo deployment/webcluster
                exit 1
            fi
            sleep 10
        done
        '''
    }
}
```

这套流程的关键点:
- **rollout status 等待** — 确保新版本完全接管
- **健康检查观察期** — 5 分钟内监控错误率
- **自动回滚** — 错误率超阈值自动 rollback

## 七、Deployment 不是银弹

Deployment 适合**无状态应用**(Web 服务、API 服务),但有些场景需要其他控制器:

- **StatefulSet** — 有状态应用(数据库、消息队列),需要稳定网络标识和持久化存储
- **DaemonSet** — 每个节点跑一个副本(日志收集、网络插件)
- **Job/CronJob** — 一次性任务或定时任务(数据迁移、备份)

电商项目里,我们用 Deployment 部署 Spring Boot 后端,用 StatefulSet 部署 MySQL/Redis,用 DaemonSet 部署 Filebeat 日志收集,用 CronJob 跑每日数据备份。每种控制器都有它的适用场景,选错会导致各种"灵异问题"。

## 八、版本治理的工程哲学

总结几条 Deployment 治理原则:

1. **YAML 即真相** — 所有 Deployment 配置必须进 Git,集群状态是 YAML 的投影
2. **版本可追溯** — 镜像 tag 用 Git SHA,Deployment annotation 记录 commit
3. **回滚能力兜底** — `revisionHistoryLimit` 设大,自动回滚机制就位
4. **探针配置完整** — startup + readiness + liveness 三层探针缺一不可
5. **优雅停机必备** — preStop hook + terminationGracePeriod + 应用层 graceful shutdown

掌握 Deployment 不是记住命令,而是理解它背后的"声明式 + 控制循环 + 期望状态收敛"的云原生哲学。这套思想贯穿所有 K8s 控制器,理解了 Deployment,StatefulSet、DaemonSet 都是触类旁通。

> Deployment 是 K8s 最常用的控制器,但"用好"它需要理解 ReplicaSet、滚动更新、探针、优雅停机的完整链路。任何一个环节配置不当,都会导致"看似部署成功,实际流量异常"的玄学问题。
