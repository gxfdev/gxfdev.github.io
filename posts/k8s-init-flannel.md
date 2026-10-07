# Kubernetes 集群初始化与 Flannel 网络插件:从 NotReady 到 Ready 的关键两步

> 上篇文档把 Docker、Harbor、cri-dockerd 这些前置组件准备好了,这篇聚焦两个最关键的环节——`kubeadm init` 集群初始化和 Flannel CNI 网络插件部署。这两步直接决定集群能不能从 `NotReady` 跑到 `Ready`。

## 一、kubeadm init:控制面的诞生

### 1.1 初始化命令的工程含义

```bash
kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --image-repository reg.zxf.org/k8s \
  --kubernetes-version v1.35.3 \
  --cri-socket=unix:///var/run/cri-dockerd.sock
```

这四个参数每一个都有特定的工程含义,不是随便填的:

**`--pod-network-cidr=10.244.0.0/16`**  
这是 Pod IP 的 CIDR 范围。选 `10.244.0.0/16` 不是任意的,而是因为 Flannel 默认就用这个网段。如果改成 `192.168.0.0/16`,Flannel 的配置文件也得同步改,否则 Pod 间通信会失败。这个 CIDR 必须与节点的物理网络不重叠——我实验室用的是 `172.25.254.0/24`,所以选 `10.244.0.0/16` 完全安全。在生产环境做网络规划时,这种"三层网络不冲突"的检查是必须的,跟 VLAN 划分时的网段规划是同一套思路。

**`--image-repository reg.zxf.org/k8s`**  
指定从私有 Harbor 仓库拉取控制面组件镜像(kube-apiserver、kube-controller-manager、kube-scheduler、kube-proxy、etcd、coredns、pause)。如果留空,kubeadm 默认从 `registry.k8s.io` 拉取,国内网络基本不可达。这就是上一篇文章里"镜像预拉取 + 上传到 Harbor"的意义——让 kubeadm 能从本地仓库快速拉取镜像。

**`--kubernetes-version v1.35.3`**  
锁定版本号。不指定的话 kubeadm 会尝试拉取 stable 版本,但 stable 版本可能跟你预下载的镜像版本不匹配,导致初始化失败。**生产环境永远要锁定版本**。

**`--cri-socket=unix:///var/run/cri-dockerd.sock`**  
明确告诉 kubeadm 用 cri-dockerd 而不是默认的 containerd。这个参数在 K8s 1.24+ 是必须的,否则 kubeadm 找不到可用的 CRI。

### 1.2 初始化成功后的关键输出

```bash
kubeadm join 172.25.254.100:6443 \
  --token ffx4xg.eeuzn2he4657r196 \
  --discovery-token-ca-cert-hash sha256:e12a7bd4d84c13db0860008de6b081d0b4a4c9c7c178356207c974f08b3668eb
```

这段 `kubeadm join` 命令是 worker 节点加入集群的"门票",包含两个核心要素:

- **token**:短期有效的认证令牌,默认 24 小时过期。如果忘了保存,可以用 `kubeadm token create --print-join-command` 重新生成
- **discovery-token-ca-cert-hash**:CA 证书的 SHA256 哈希,worker 节点用它验证 master 的身份,防止中间人攻击

这两个值不要泄露。token 泄露后任何能访问 master 6443 端口的人都能加入集群,hash 泄露后理论上可以伪造 master。**生产环境建议开启 RBAC 并定期轮换 token**。

### 1.3 配置 kubectl 客户端

```bash
echo "export KUBECONFIG=/etc/kubernetes/admin.conf" >> ~/.bash_profile
source ~/.bash_profile
```

`/etc/kubernetes/admin.conf` 是 master 节点的管理员 kubeconfig 文件,包含了访问 API Server 的证书和密钥。`kubectl` 命令默认查找 `~/.kube/config`,通过环境变量 `KUBECONFIG` 重定向到 admin.conf 是最快的配置方式。

更优雅的做法是把 admin.conf 复制到 `~/.kube/config`:

```bash
mkdir -p $HOME/.kube
cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
chown $(id -u):$(id -g) $HOME/.kube/config
```

## 二、Worker 节点加入集群

```bash
# 在每个 worker 节点执行
kubeadm join 172.25.254.100:6443 \
  --token ffx4xg.eeuzn2he4657r196 \
  --discovery-token-ca-cert-hash sha256:e12a7bd4d84c13db0860008de6b081d0b4a4c9c7c178356207c974f08b3668eb \
  --cri-socket=unix:///var/run/cri-dockerd.sock
```

注意 worker 节点也要加 `--cri-socket` 参数,跟 master 保持一致。加入后查看节点状态:

```bash
kubectl get nodes
NAME         STATUS     ROLES           AGE     VERSION
k8s-master   NotReady   control-plane   8m57s   v1.35.3
k8s-node1    NotReady   <none>          29s     v1.35.3
k8s-node2    NotReady   <none>          8s      v1.35.3
```

**所有节点都是 `NotReady`**——这是正常的!因为还没有部署 CNI 网络插件,kubelet 检测到节点网络不可用,所以标记为 NotReady。这时候千万不要以为初始化失败了去 reset,装上 Flannel 就好了。

## 三、Flannel 网络插件:跨节点 Pod 通信的关键

### 3.1 Flannel 的工作原理

Flannel 是 CoreOS 开发的 CNI 插件,核心机制是 **VXLAN 隧道**。每个节点会分配一个 `/24` 的子网(从 `10.244.0.0/16` 这个大网段里切),比如 master 是 `10.244.0.0/24`,node1 是 `10.244.1.0/24`,node2 是 `10.244.2.0/24`。

当 node1 上的 Pod(假设 IP `10.244.1.5`)要访问 node2 上的 Pod(`10.244.2.3`),Flannel 会:
1. 在源节点把原始 L2 帧封装进 UDP 包(VXLAN 封装)
2. 通过物理网络(172.25.254.0/24)发送到目标节点
3. 目标节点解封装,把原始帧投递给目标 Pod

这种 overlay 网络方案虽然有一点点性能损耗(大概 5-10%),但实现了跨节点 Pod 的 L2 互通,是 K8s 网络模型的标准实现。我学过 VLAN 和 Trunk,理解 VXLAN 时就特别顺畅——VXLAN 本质就是"用 UDP 封装的 VLAN",把 12 位的 VLAN ID 扩展到 24 位的 VNI,突破 4096 个 VLAN 的限制。

### 3.2 镜像准备与部署

```bash
# 加载 Flannel 镜像
docker load -i flannel-0.28.1.tar

# 重新打 tag 并推送到 harbor
docker tag ghcr.io/flannel-io/flannel-cni-plugin:v1.9.0-flannel1 \
  reg.zxf.org/flannel-io/flannel-cni-plugin:v1.9.0-flannel1
docker push reg.zxf.org/flannel-io/flannel-cni-plugin:v1.9.0-flannel1

docker tag ghcr.io/flannel-io/flannel:v0.28.1 \
  reg.zxf.org/flannel-io/flannel:v0.28.1
docker push reg.zxf.org/flannel-io/flannel:v0.28.1
```

这里需要两个镜像:`flannel` 是主程序,负责 VXLAN 隧道的建立和维护;`flannel-cni-plugin` 是 CNI 插件本身,kubelet 调用 CNI 接口时实际执行的二进制。

### 3.3 部署 Flannel

```bash
kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml
```

但是这里有个坑——官方 YAML 里的镜像地址是 `ghcr.io/flannel-io/flannel`,国内拉不下来。所以需要先把 YAML 下载下来,把镜像地址改成 `reg.zxf.org/flannel-io/flannel`,然后再 apply。这就是为什么前面要先把镜像推到 Harbor 的原因。

### 3.4 验证集群状态

```bash
kubectl get nodes
NAME         STATUS   ROLES           AGE     VERSION
k8s-master   Ready    control-plane   15m     v1.35.3
k8s-node1    Ready    <none>          7m2s    v1.35.3
k8s-node2    Ready    <none>          6m41s   v1.35.3
```

所有节点 `Ready`!集群正式可用。这时候可以查看 Flannel 的 DaemonSet:

```bash
kubectl get pods -n kube-flannel -o wide
```

每个节点上都会有一个 flannel Pod,这是 DaemonSet 的特性——确保每个节点上都运行一个副本。这也解释了为什么 Flannel 用 DaemonSet 而不是 Deployment——因为每个节点都需要自己的 VXLAN 隧道端点。

## 四、kubeadm reset:故障恢复的最后一道防线

部署过程中大概率会遇到初始化失败需要重置的情况,常见场景包括:

- `--pod-network-cidr` 选错导致与 Flannel 不匹配
- 镜像拉取失败导致 init 卡住
- token 过期需要重新生成
- 想重新配置控制面参数

```bash
kubeadm reset --cri-socket=unix:///var/run/cri-dockerd.sock
```

重置时也要带上 `--cri-socket` 参数,否则 kubeadm 找不到 CRI 无法清理容器。重置后还需要手动清理:

```bash
rm -rf /etc/cni/net.d
rm -rf /var/lib/cni
rm -rf /var/lib/etcd
iptables -F
iptables -t nat -F
iptables -t mangle -F
iptables -X
```

清空 iptables 规则特别重要,因为 kube-proxy 和 Flannel 都会写大量 iptables 规则,如果不清理,重新初始化的集群会受旧规则影响,出现各种网络异常。

## 五、网络排错的工程思路

部署 Flannel 后如果节点还是 NotReady,排查思路:

1. **`kubectl describe node <node-name>`** 看 Events,如果是 `networkPlugin not ready` 说明 CNI 没起来
2. **`kubectl get pods -n kube-flannel`** 看 Flannel Pod 状态,如果是 `CrashLoopBackOff` 大概率是镜像拉不下来
3. **`journalctl -u kubelet -f`** 看 kubelet 日志,如果是 `failed to get container info` 可能是 cri-dockerd 没起来
4. **`ip link show flannel.1`** 看 VXLAN 网卡是否创建,如果没有说明 Flannel 还没初始化完成

这种"从集群状态 → Pod 状态 → 节点日志 → 系统网络"逐层下钻的排查思路,是云原生运维的基本功。在电商项目里排查 Docker 网络故障时,我用的也是这套思路——从 `docker ps` → `docker logs` → `docker network inspect` → `iptables -L`,逐层定位问题层级。

> K8s 网络的复杂度远超传统运维,但理解了 VXLAN、CNI、iptables 这几层之后,所有"玄学"网络问题都能找到根源。
