# K8s Pod 生命周期:init 容器与探针的工程化应用

> Pod 的生命周期管理是 K8s 高级调度的核心。这篇记录两个关键机制——init 容器(负责启动顺序依赖)和探针(负责健康检查与自愈)。这两个机制是生产环境保证服务可用性的基础设施。

## 一、Pod 生命周期阶段

Pod 从创建到销毁,会经历几个阶段:

1. **Pending** — Pod 已创建,但还有容器没启动(可能正在拉镜像、调度中)
2. **Running** — 所有容器已创建,至少一个在运行
3. **Succeeded** — 所有容器正常退出(主要用于 Job)
4. **Failed** — 所有容器退出,至少一个异常退出
5. **Unknown** — 无法与 Pod 所在节点通信(节点故障)

在 `Running` 阶段,Pod 内部还有更细粒度的状态机,涉及 **init 容器** 和 **主容器** 的协作。理解这个状态机,是配置探针和 init 容器的前提。

## 二、Init 容器:启动顺序依赖的优雅解法

### 2.1 业务场景

考虑一个常见场景:Web 应用启动时需要连接数据库做初始化(建表、加载种子数据),但数据库服务可能还没起来。如果 Web 容器直接启动,会因为连不上数据库而崩溃,然后 K8s 重启,再崩溃……进入 `CrashLoopBackOff` 死循环。

传统解决方案是在应用代码里加重试逻辑——但这把"基础设施依赖"耦合到了"业务代码"里,违反单一职责原则。**Init 容器**就是 K8s 提供的优雅解法。

### 2.2 Init 容器配置

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: lee1
  name: lee1
spec:
  initContainers:
  - name: init-myservice
    image: busybox
    command: ["sh","-c","until test -e /testfile; do echo waiting for myservice; sleep 2; done"]
  containers:
  - image: myapp:v1
    name: myappv1
```

这个配置的含义:
1. **init 容器先执行** — `init-myservice` 容器先启动,运行 `until test -e /testfile; do ...; done` 这段 shell
2. **轮询等待** — 每 2 秒检查 `/testfile` 是否存在,不存在就打印日志继续等
3. **init 完成后启动主容器** — 当 `/testfile` 出现,init 容器退出(exit code 0),主容器 `myappv1` 才启动

### 2.3 验证 init 容器的阻塞行为

```bash
kubectl apply -f init.yml
pod/lee1 created

kubectl get pods
NAME   READY   STATUS     RESTARTS   AGE
lee1   0/1     Init:0/1   0          3s
```

状态 `Init:0/1` 表示 "1 个 init 容器,0 个完成"。Pod 会一直卡在这个状态,直到 init 容器成功退出。

```bash
# 实时监控
watch -n 1 kubectl get pods

# 进入 init 容器创建触发文件
kubectl exec -it pods/lee1 -c init-myservice -- /bin/sh
/ # touch /testfile
/ # command terminated with exit code 137   # init 容器收到 SIGKILL,因为 command 退出后容器结束

kubectl get pods
NAME   READY   STATUS    RESTARTS   AGE
lee1   1/1     Running   0          2m32s
```

创建 `/testfile` 后,`until` 循环退出,init 容器 exit 0,主容器立即启动。Pod 状态从 `Init:0/1` 变成 `Running`。

### 2.4 Init 容器的工程化用法

生产环境 init 容器常用于:

1. **等待外部依赖** — 比如 `until nslookup mysql-service; do sleep 2; done`,等数据库 Service 可解析
2. **配置文件生成** — 从 ConfigMap/Secret 读取模板,用 envsubst 渲染成最终配置
3. **数据迁移** — 主容器启动前执行 SQL migration 脚本
4. **权限初始化** — 修改 emptyDir 卷的 owner,让主容器以非 root 用户运行

注意 init 容器的几个特性:
- **多个 init 容器串行执行** — 必须按顺序,前一个退出 0 才执行下一个
- **init 容器失败会重启整个 Pod** — 默认 restartPolicy=Always
- **init 容器没有 readiness/liveness 探针** — 因为它是"一次性任务"
- **init 容器不参与 Service 流量** — Service 只把流量打到主容器

## 三、Liveness Probe:存活探针与自动重启

### 3.1 为什么需要存活探针

容器"在运行"不等于"服务可用"。常见死锁场景:
- Java 应用发生了 GC 停顿,进程还在但响应不了请求
- 数据库连接池耗尽,新连接全部阻塞
- 应用内部状态机进入死循环,API 不响应

这种"进程活着但功能死了"的情况,kubelet 无法自动检测,需要 **livenessProbe** 主动探测。

### 3.2 Liveness Probe 配置

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    name: liveness
  name: liveness
spec:
  containers:
    - image: myapp:v1
      name: myapp
      livenessProbe:
        tcpSocket:                  # TCP 端口探测
          port: 8080
        initialDelaySeconds: 3      # 容器启动后等待 3 秒开始探测
        periodSeconds: 1            # 每 1 秒探测一次
        timeoutSeconds: 1           # 探测超时时间 1 秒
```

字段含义:
- **tcpSocket** — 用 TCP 连接探测端口是否监听,比 HTTP 探测轻量
- **initialDelaySeconds: 3** — 容器启动后 3 秒才开始探测。这个值很关键,设得太短,容器还没启动就被判定为失败,导致 `CrashLoopBackOff`
- **periodSeconds: 1** — 探测频率,默认 10 秒。生产环境一般 5-10 秒,太频繁会增加负载
- **timeoutSeconds: 1** — 单次探测超时,默认 1 秒

### 3.3 三种探测方式

K8s 支持三种 livenessProbe 探测方式,适用场景不同:

**1. tcpSocket** — 检测端口是否监听  
适合:数据库、Redis 等没有 HTTP 接口的服务  
优点:轻量;缺点:无法检测应用层健康状态

**2. httpGet** — 发 HTTP GET 请求  
适合:Web 应用、RESTful API  
优点:能检测应用层健康;缺点:要求应用实现 health endpoint
```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
```

**3. exec** — 在容器内执行命令,exit code 0 为健康  
适合:命令行检测的场景,比如检查文件是否存在
```yaml
livenessProbe:
  exec:
    command:
    - cat
    - /tmp/healthy
  initialDelaySeconds: 5
  periodSeconds: 5
```

### 3.4 Liveness 失败的后果

如果 livenessProbe 连续失败(默认 3 次),kubelet 会**杀死容器并按 restartPolicy 重启**。这是 K8s 自愈能力的核心——应用进入死锁状态后,自动重启恢复服务。

但要注意:livenessProbe 不是"万能重启"。如果你的应用每次启动都因为某个数据问题崩溃,liveness 只会让 Pod 陷入 `CrashLoopBackOff`,不会解决问题。所以 liveness 配置的 health endpoint 必须真正反映"应用是否能服务",而不是简单地返回 200。

## 四、Readiness Probe:就绪探针与流量控制

### 4.1 Readiness 与 Liveness 的区别

| 探针 | 失败后果 | 用途 |
|------|---------|------|
| livenessProbe | 重启容器 | 修复"死锁"类问题 |
| readinessProbe | 从 Service Endpoints 移除 | 隔离"未就绪"的 Pod |

readinessProbe 失败**不会重启容器**,只是把这个 Pod 从 Service 的 Endpoints 里移除,客户端流量不再打到这个 Pod。这种机制实现了"优雅上线"和"优雅下线":

- **优雅上线** — 容器启动后,readinessProbe 探测 `/ready`。应用预热完成后才返回 200,Pod 才进入 Endpoints 接收流量
- **优雅下线** — 滚动更新时,旧 Pod 收到 SIGTERM 后 readinessProbe 立刻失败,从 Endpoints 移除,新 Pod 接管流量,旧 Pod 才真正退出

### 4.2 Readiness 配置示例

```yaml
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 3
```

`failureThreshold: 3` 表示连续 3 次失败才标记为未就绪。生产环境建议:
- 应用启动慢的设置 `initialDelaySeconds` 大一点
- `periodSeconds` 设 5 秒(默认 10 秒偏慢)
- `failureThreshold` 保持默认 3 次,避免单次抖动误判

## 五、Startup Probe:启动探针(慢启动应用)

K8s 1.18+ 新增了 **startupProbe**,专门解决"应用启动慢"的问题。

Java 应用启动可能要 1-2 分钟,如果用 livenessProbe 检测,`initialDelaySeconds` 设短了容易误判,设长了又延迟故障发现。startupProbe 的逻辑:

1. **startupProbe 期间,liveness/readiness 不工作** — 避免启动过程中的误判
2. **startupProbe 成功后,liveness/readiness 接管** — 进入正常监控

```yaml
startupProbe:
  httpGet:
    path: /healthz
    port: 8080
  failureThreshold: 30       # 允许 30 次失败
  periodSeconds: 10          # 每 10 秒探测一次
  # 总共允许 5 分钟启动时间
```

这种"启动期豁免 + 运行期严格"的策略,是慢启动应用的最佳实践。电商项目里的 Spring Boot 服务,我都配置了 startupProbe,启动时间从原本的"经常 CrashLoopBackOff"变成"稳定 2 分钟内 Ready"。

## 六、探针配置的工程经验

总结几条生产环境的探针配置经验:

1. **liveness 和 readiness 都要配** — 只配 liveness 不配 readiness,流量会打到未就绪的 Pod
2. **liveness 用 httpGet,readiness 用 httpGet** — tcpSocket 太弱,exec 太重
3. **health endpoint 区分"存活"和"就绪"** — `/healthz` 返回进程是否活,`/ready` 返回是否能服务
4. **生产环境必加 startupProbe** — 即使应用启动快,加上 startupProbe 也是好习惯,防止版本升级时启动变慢导致问题
5. **initialDelaySeconds 不要设太大** — 用 startupProbe 替代大 initialDelay,避免故障延迟发现

这些探针配置在我的 Web 集群项目里都落地了,显著降低了线上故障率。后续文章会展开讲 Deployment 的滚动更新策略,以及探针配置如何影响滚动更新的安全性。

> 探针是 K8s 自愈能力的"传感器"。配置不当时,要么过度重启(Pod 一直 CrashLoopBackOff),要么无法自愈(应用死锁但不重启)。掌握探针配置,是 K8s 运维的核心技能。
