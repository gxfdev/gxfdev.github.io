# K8s Volumes:存储卷与数据持久化基础

> Pod 是临时的——容器重启、节点故障、滚动更新都会导致容器内数据丢失。Volume 解决了这个问题,让数据在容器重启后仍然存在。这篇记录 K8s 的存储体系,重点讲 emptyDir 的特性和适用场景。

## 一、为什么需要 Volume

### 1.1 容器文件系统的 ephemeral 特性

容器的文件系统是基于镜像层 + 可写层的联合文件系统(OverlayFS)。当容器销毁时,可写层的数据随之丢失:

```bash
# 启动容器,写入文件
docker run -it busybox sh
/ # echo hello > /tmp/test.txt
/ # exit

# 重新启动,文件没了
docker run -it busybox sh
/ # cat /tmp/test.txt
cat: /tmp/test.txt: No such file or directory
```

这种行为对有状态应用是灾难性的:
- **数据库** — 重启后数据全没
- **日志文件** — 重启后日志丢失
- **临时缓存** — 多容器共享的缓存无法持久化

### 1.2 Volume 的解决方案

Volume 是 K8s 的存储抽象,挂载到 Pod 的某个路径,数据存储在 Volume 而不是容器可写层:

```
Pod
├── Container A
│   └── /data → Volume (持久化)
└── Container B
    └── /data → Volume (共享同一 Volume)
```

Volume 的核心价值:
- **容器重启不丢数据** — 数据在 Volume,不在容器可写层
- **多容器共享** — 同一 Pod 内多个容器可以共享同一个 Volume
- **多种后端** — emptyDir、hostPath、NFS、PV/PVC、CSI 等

## 二、K8s 存储体系概览

K8s 的存储分为几个层次:

### 2.1 Volume(Pod 级别)

Volume 定义在 Pod spec 里,生命周期与 Pod 绑定。Pod 销毁,Volume 也销毁(emptyDir 类型)或保留(PV 类型)。

常见 Volume 类型:
- **emptyDir** — 临时空目录,Pod 销毁即删
- **hostPath** — 挂载宿主机路径
- **configMap/secret** — 挂载 ConfigMap/Secret(前文已讲)
- **persistentVolumeClaim** — 挂载 PV(持久化存储)
- **nfs** — 挂载 NFS 共享存储
- **csi** — 容器存储接口(第三方存储驱动)

### 2.2 PersistentVolume + PersistentVolumeClaim(集群级别)

PV 是集群管理员声明的存储资源,PVC 是用户对 PV 的申请。两者解耦了"存储提供"和"存储消费":

```
管理员: 创建 PV (存储资源)
用户:   创建 PVC (申请存储)
K8s:    绑定 PVC 到合适的 PV
Pod:    通过 PVC 使用存储
```

### 2.3 StorageClass(动态供应)

StorageClass 定义了"如何动态创建 PV"。用户创建 PVC 时,K8s 根据 StorageClass 自动创建 PV,无需管理员预先创建:

```
用户: 创建 PVC (申请 10Gi)
K8s:    根据 StorageClass 自动创建 10Gi PV
K8s:    绑定 PVC 到新创建的 PV
```

这套体系是 K8s 存储的核心,本篇先从最基础的 emptyDir 讲起。

## 三、emptyDir:临时空目录

### 3.1 emptyDir 的特性

emptyDir 是最简单的 Volume 类型:
- **Pod 创建时创建** — 空目录,初始无内容
- **Pod 销毁时销毁** — 数据随 Pod 消失
- **容器重启不销毁** — 数据在 Pod 生命周期内持久

适用场景:
- **多容器共享数据** — Sidecar 模式的主容器与 Sidecar 共享文件
- **临时缓存** — 不需要持久化的临时数据
- **数据处理中间结果** — 流式处理的中间文件

不适用场景:
- **数据库** — 需要持久化,Pod 销毁数据不能丢
- **用户上传文件** — 需要持久化
- **日志归档** — 需要持久化

### 3.2 emptyDir 配置示例

```yaml
# empty.yml
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: empty
  name: empty
spec:
  containers:
  - image: busybox
    name: busybox
    command:
    - /bin/sh
    - -c
    - sleep 100000
    volumeMounts:
    - mountPath: /cache                  # busybox 容器挂载到 /cache
      name: cache-vol

  - image: nginx:1.23
    name: nginx
    volumeMounts:
    - mountPath: /usr/share/nginx/html   # nginx 容器挂载到 web 根目录
      name: cache-vol                    # 同一个 Volume

  volumes:
  - name: cache-vol
    emptyDir:
      medium: Memory                     # 用内存(tmpfs)而不是磁盘
      sizeLimit: 100Mi                   # 限制 100MB
```

关键配置:
- **`volumes[].emptyDir`** — 声明 emptyDir 类型 Volume
- **`medium: Memory`** — 用 tmpfs(内存文件系统),读写极快但消耗内存
- **`sizeLimit: 100Mi`** — 限制 Volume 大小,防止内存耗尽
- **多容器共享** — busybox 和 nginx 挂载同一个 `cache-vol`,数据互通

### 3.3 验证多容器共享

```bash
kubectl apply -f empty.yml
kubectl get pods -o wide
NAME    READY   STATUS    RESTARTS   AGE   IP            NODE
empty   2/2     Running   0          4s    10.244.2.15   k8s-node2

# 访问 nginx
curl 10.244.2.15
<html>
<head><title>403 Forbidden</title></head>
<body>
<center><h1>403 Forbidden</h1></center>
<hr><center>nginx/1.23.4</center>
</body>
</html>
```

返回 403 Forbidden 是因为 emptyDir 是空目录,nginx 的 web 根目录 `/usr/share/nginx/html` 没有任何文件。这验证了 emptyDir 的"空"特性——挂载后覆盖了镜像原有的内容。

### 3.4 写入数据验证共享

```bash
# 在 busybox 容器写入文件
kubectl exec -it pods/empty -c busybox -- /bin/sh
/ # echo "<h1>Hello from shared volume</h1>" > /cache/index.html
/ # exit

# 访问 nginx,能读到 busybox 写入的文件
curl 10.244.2.15
<h1>Hello from shared volume</h1>
```

成功!busybox 写入 `/cache/index.html`,nginx 从 `/usr/share/nginx/html/index.html` 读到——因为它们挂载的是同一个 emptyDir Volume。

这就是 emptyDir 的核心价值:**Pod 内多容器共享文件**。

### 3.5 medium: Memory 的工程意义

```yaml
volumes:
- name: cache-vol
  emptyDir:
    medium: Memory                       # tmpfs
    sizeLimit: 100Mi
```

`medium: Memory` 让 emptyDir 用 tmpfs(内存文件系统):
- **读写极快** — 内存速度,比磁盘快 10-100 倍
- **重启不丢** — 容器重启数据还在(Pod 没销毁)
- **Pod 销毁即丢** — 内存释放,数据消失
- **消耗内存** — 占用 Pod 的内存配额

适用场景:
- **临时缓存** — Redis 缓存、Session 存储
- **计算中间结果** — 流式处理的临时文件
- **加密解密临时文件** — 不希望落盘的敏感数据

不指定 `medium`(默认)用节点磁盘:
- **容量大** — 不占内存
- **速度慢** — 磁盘 IO 限制
- **重启不丢** — 容器重启数据还在

### 3.6 emptyDir 的常见应用模式

**1. Sidecar 模式:日志收集**

```yaml
spec:
  containers:
  - name: app                            # 主容器写日志
    image: myapp
    volumeMounts:
    - mountPath: /var/log/app
      name: log-vol
  - name: log-agent                      # Sidecar 容器读日志并转发
    image: filebeat
    volumeMounts:
    - mountPath: /var/log/app
      name: log-vol                      # 共享同一 Volume
  volumes:
  - name: log-vol
    emptyDir: {}
```

主容器写日志到 `/var/log/app`,Filebeat Sidecar 从同一目录读取并转发到 ELK。两个容器通过 emptyDir 共享日志文件。

**2. Init Container 生成配置**

```yaml
spec:
  initContainers:
  - name: init-config
    image: busybox
    command: ["sh", "-c", "envsubst < /template/nginx.conf.tmpl > /config/nginx.conf"]
    volumeMounts:
    - mountPath: /config
      name: config-vol
  containers:
  - name: nginx
    image: nginx
    volumeMounts:
    - mountPath: /etc/nginx/conf.d
      name: config-vol                   # 共享 init 生成的配置
  volumes:
  - name: config-vol
    emptyDir: {}
```

Init Container 用 envsubst 渲染配置模板,主容器从同一 Volume 读取渲染后的配置。这种模式适合"配置需要动态生成"的场景。

**3. 多容器协作:Web + Worker**

```yaml
spec:
  containers:
  - name: web                            # 接收上传文件
    image: nginx
    volumeMounts:
    - mountPath: /uploads
      name: upload-vol
  - name: worker                         # 处理上传文件
    image: image-processor
    volumeMounts:
    - mountPath: /uploads
      name: upload-vol                   # 共享上传目录
  volumes:
  - name: upload-vol
    emptyDir: {}
```

Web 容器接收上传,Worker 容器处理上传文件。两者通过 emptyDir 共享上传目录,无需网络传输。

## 四、emptyDir 的陷阱

### 4.1 挂载覆盖镜像内容

```yaml
volumeMounts:
- mountPath: /usr/share/nginx/html       # 覆盖 nginx 默认 web 目录
  name: cache-vol
```

挂载 emptyDir 后,挂载路径下的原镜像内容会被"覆盖"(实际上是隐藏)。nginx 默认的 index.html 消失,所以访问返回 403。

解决方案:
- **挂载到空目录** — `/data`、`/cache` 等原本不存在的路径
- **subPath 挂载** — 只挂载 Volume 中的某个文件,不覆盖整个目录

```yaml
volumeMounts:
- mountPath: /usr/share/nginx/html/index.html   # 只挂载单个文件
  name: cache-vol
  subPath: index.html                            # Volume 中的 index.html
```

### 4.2 sizeLimit 不强制

```yaml
emptyDir:
  sizeLimit: 100Mi
```

`sizeLimit` 默认是**软限制**——超过不会阻止写入,只是标记 Pod 为 Evicted。如果应用持续写入,可能耗尽节点磁盘/内存。

生产环境必须配合:
- **Pod 的 resources.limits** — 限制容器内存/CPU
- **节点监控** — 监控 emptyDir 使用量,及时告警
- **应用层限流** — 应用控制写入量

### 4.3 medium: Memory 的内存消耗

```yaml
emptyDir:
  medium: Memory
  sizeLimit: 1Gi
```

tmpfs 消耗的是 Pod 内存配额。如果 Pod 的 `resources.limits.memory` 是 512Mi,但 emptyDir 用了 1Gi,Pod 会被 OOM Kill。

规则:`emptyDir.sizeLimit` + 容器内存使用 ≤ `resources.limits.memory`。

## 五、从 emptyDir 到持久化存储

emptyDir 解决了"Pod 内多容器共享"的问题,但没解决"Pod 销毁数据持久化"。后者需要 PV/PVC:

### 5.1 hostPath:节点级持久化

```yaml
volumes:
- name: data-vol
  hostPath:
    path: /data/myapp                   # 节点上的路径
    type: DirectoryOrCreate
```

hostPath 把节点上的路径挂载到 Pod。Pod 销毁后,数据还在节点上。但 Pod 重新调度到别的节点,就读不到原节点的数据。

适用场景:
- **DaemonSet 部署的 agent** — 每个节点都跑,数据存在本节点
- **节点级监控** — Prometheus Node Exporter 读 /proc、/sys

不适用场景:
- **有状态应用** — Pod 可能调度到不同节点,数据不一致
- **生产数据库** — 数据应存在共享存储,不是单节点

### 5.2 PV/PVC:集群级持久化

```yaml
# PVC 声明
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: nfs
```

```yaml
# Pod 使用 PVC
spec:
  containers:
  - name: app
    image: myapp
    volumeMounts:
    - mountPath: /data
      name: data-vol
  volumes:
  - name: data-vol
    persistentVolumeClaim:
      claimName: data-pvc                # 引用 PVC
```

PV/PVC 的优势:
- **集群级持久化** — Pod 调度到任何节点都能访问数据
- **动态供应** — StorageClass 自动创建 PV
- **生命周期独立** — PVC 删除后,PV 可保留或回收

### 5.3 StatefulSet + PVC:有状态应用的标准模式

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql
  replicas: 3
  template:
    spec:
      containers:
      - name: mysql
        image: mysql:8.0
        volumeMounts:
        - mountPath: /var/lib/mysql
          name: data
  volumeClaimTemplates:                  # 每个 Pod 自动创建独立 PVC
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 50Gi
```

StatefulSet + volumeClaimTemplates 是有状态应用(MySQL、Redis、Kafka)的标准部署模式。每个 Pod 有独立的 PVC,数据相互隔离,Pod 重建后数据还在。

## 六、Volume 的工程选型

### 6.1 选型决策树

```
需要持久化吗?
├── 否 → emptyDir
│   ├── 多容器共享? → emptyDir (默认磁盘)
│   └── 高速临时存储? → emptyDir (medium: Memory)
└── 是 → 需要集群级访问吗?
    ├── 否 → hostPath (单节点)
    └── 是 → PV/PVC
        ├── 已有存储? → 静态 PV
        └── 需要动态创建? → StorageClass + PVC
```

### 6.2 生产环境推荐

- **临时数据** — emptyDir (磁盘),sizeLimit 必配
- **高速缓存** — emptyDir (Memory),严格控制大小
- **配置文件** — ConfigMap Volume
- **敏感数据** — Secret Volume
- **持久化数据** — PV/PVC + StorageClass(NFS、Ceph、云盘)
- **有状态应用** — StatefulSet + volumeClaimTemplates

## 七、Volume 的工程哲学

K8s 的 Volume 体系设计体现了几个核心思想:

1. **抽象与实现分离** — Pod 声明需要什么 Volume(接口),具体后端由 PV/StorageClass 提供(实现)
2. **生命周期解耦** — Volume 生命周期可以与 Pod 绑定(emptyDir),也可以独立(PV)
3. **动态供应** — StorageClass 让存储资源像计算资源一样动态申请

这种设计让 K8s 的存储能力极其灵活——从临时缓存到分布式存储,从本地磁盘到云盘,都通过统一的 Volume 接口暴露给 Pod。

下一篇我会深入讲 PV/PVC/StorageClass 的完整体系,这是有状态应用部署的基础。emptyDir 只是 K8s 存储的入门,真正的复杂度在持久化存储——动态供应、回收策略、备份恢复、跨可用区高可用,这些都是生产环境必须掌握的能力。

> Volume 是 K8s 的"存储抽象层"。理解了 emptyDir 的"Pod 生命周期绑定",就理解了 Volume 的基础;理解了 PV/PVC 的"集群级持久化",才真正进入 K8s 存储的世界。
