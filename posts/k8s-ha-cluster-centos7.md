# CentOS 7 部署 3 Master + 3 Worker 高可用 K8s 集群完整教程

> 生产环境的 K8s 集群不能单 master——master 挂了整个集群就不可用。这篇记录在 CentOS 7 上部署 3 master + 3 worker 的高可用 K8s 集群完整流程,包括 HAProxy + Keepalived 负载均衡、etcd 集群、kubeadm 初始化、网络插件配置。

## 一、集群架构设计

### 1.1 为什么需要多 master

单 master 集群的问题:
- **单点故障** — master 挂了,无法调度 Pod、无法创建资源
- **etcd 数据风险** — 单 etcd 节点,数据丢失集群就废了
- **无法维护** — master 升级时集群不可用

3 master 高可用架构:
- **API Server 负载均衡** — 通过 HAProxy + Keepalived 实现 VIP
- **etcd 集群** — 3 节点 etcd,容忍 1 节点故障(Raft 协议)
- **调度器/控制器高可用** — 多副本通过 leader election 选举

### 1.2 主机规划

| 主机名 | IP | 角色 | 配置 |
|--------|-----|------|------|
| **lb1** | 172.25.254.10 | HAProxy + Keepalived (MASTER) | 2C2G |
| **lb2** | 172.25.254.20 | HAProxy + Keepalived (BACKUP) | 2C2G |
| **k8s-master1** | 172.25.254.100 | master, etcd | 4C4G |
| **k8s-master2** | 172.25.254.110 | master, etcd | 4C4G |
| **k8s-master3** | 172.25.254.120 | master, etcd | 4C4G |
| **k8s-worker1** | 172.25.254.40 | worker | 4C4G |
| **k8s-worker2** | 172.25.254.50 | worker | 4C4G |
| **k8s-worker3** | 172.25.254.60 | worker | 4C4G |
| **VIP** | 172.25.254.200 | Keepalived 虚拟 IP | - |

### 1.3 网络规划

- **物理网段**: 172.25.254.0/24
- **Pod CIDR**: 10.244.0.0/16 (Flannel 默认)
- **Service CIDR**: 10.96.0.0/12 (K8s 默认)
- **Cluster DNS**: 10.96.0.10 (kube-dns)

## 二、CentOS 7 系统准备

### 2.1 所有节点执行的系统配置

```bash
# 1. 设置主机名(在各节点分别执行)
hostnamectl set-hostname lb1
hostnamectl set-hostname lb2
hostnamectl set-hostname k8s-master1
hostnamectl set-hostname k8s-master2
hostnamectl set-hostname k8s-master3
hostnamectl set-hostname k8s-worker1
hostnamectl set-hostname k8s-worker2
hostnamectl set-hostname k8s-worker3

# 2. 配置 hosts 解析(所有节点)
cat >> /etc/hosts << EOF
172.25.254.10    lb1
172.25.254.20    lb2
172.25.254.100   k8s-master1
172.25.254.110   k8s-master2
172.25.254.120   k8s-master3
172.25.254.40    k8s-worker1
172.25.254.50    k8s-worker2
172.25.254.60    k8s-worker3
172.25.254.200   k8s-api.zxf.org
EOF

# 3. 关闭 SELinux
setenforce 0
sed -i 's/SELINUX=enforcing/SELINUX=disabled/g' /etc/selinux/config

# 4. 关闭 swap(必须)
swapoff -a
sed -i '/swap/s/^/#/' /etc/fstab

# 5. 关闭防火墙(生产环境建议配置规则而非关闭)
systemctl disable --now firewalld

# 6. 同步时间
yum install chrony -y
systemctl enable --now chronyd
chronyc sources
```

### 2.2 内核参数优化

```bash
# 加载内核模块
cat > /etc/modules-load.d/k8s.conf << EOF
br_netfilter
nf_conntrack
overlay
EOF

modprobe br_netfilter
modprobe nf_conntrack
modprobe overlay

# 内核参数
cat > /etc/sysctl.d/k8s.conf << EOF
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward = 1
net.ipv4.tcp_tw_reuse = 0
net.core.somaxconn = 32768
net.ipv4.tcp_max_syn_backlog = 8096
net.netfilter.nf_conntrack_max = 1048576
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 1048576
EOF

sysctl --system
```

### 2.3 CentOS 7 内核升级

CentOS 7 默认内核 3.10,不支持部分 K8s 特性。升级到 5.x:

```bash
# 安装 ELRepo
rpm --import https://www.elrepo.org/RPM-GPG-KEY-elrepo.org
rpm -Uvh https://www.elrepo.org/elrepo-release-7.el7.elrepo.noarch.rpm

# 安装 5.x 内核
yum --enablerepo=elrepo-kernel install kernel-lt -y

# 设置默认启动内核
grub2-set-default 0
grub2-mkconfig -o /boot/grub2/grub.cfg

# 重启
reboot

# 验证内核版本
uname -r
# 5.4.0-xxx.el7.elrepo.x86_64
```

## 三、HAProxy + Keepalived 负载均衡

### 3.1 在 lb1 和 lb2 安装

```bash
yum install haproxy keepalived -y
```

### 3.2 HAProxy 配置(lb1 和 lb2 相同)

```bash
cat > /etc/haproxy/haproxy.cfg << 'EOF'
global
    log /dev/log local0
    log /dev/log local1 notice
    daemon
    maxconn 2000

defaults
    log     global
    mode    tcp
    option  tcplog
    option  dontlognull
    retries 3
    timeout connect 5000
    timeout client  50000
    timeout server  50000

frontend k8s-api
    bind *:6443
    mode tcp
    option tcplog
    default_backend k8s-api

backend k8s-api
    mode tcp
    option tcp-check
    balance roundrobin
    default-server inter 10s downinter 5s rise 2 fall 2 slowstart 60s maxconn 250 maxqueue 256 weight 100
    server k8s-master1 172.25.254.100:6443 check
    server k8s-master2 172.25.254.110:6443 check
    server k8s-master3 172.25.254.120:6443 check
EOF
```

HAProxy 把发往 VIP:6443 的流量轮询转发到 3 个 master 的 API Server。

### 3.3 Keepalived 配置

**lb1 (MASTER)**:

```bash
cat > /etc/keepalived/keepalived.conf << 'EOF'
global_defs {
    router_id LVS_K8S
}

vrrp_script check_haproxy {
    script "/etc/keepalived/check_haproxy.sh"
    interval 3
    weight -2
    fall 10
    rise 2
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        172.25.254.200/24
    }
    track_script {
        check_haproxy
    }
}
EOF
```

**lb2 (BACKUP)**:

```bash
cat > /etc/keepalived/keepalived.conf << 'EOF'
global_defs {
    router_id LVS_K8S
}

vrrp_script check_haproxy {
    script "/etc/keepalived/check_haproxy.sh"
    interval 3
    weight -2
    fall 10
    rise 2
}

vrrp_instance VI_1 {
    state BACKUP
    interface eth0
    virtual_router_id 51
    priority 90
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        172.25.254.200/24
    }
    track_script {
        check_haproxy
    }
}
EOF
```

### 3.4 健康检查脚本

```bash
cat > /etc/keepalived/check_haproxy.sh << 'EOF'
#!/bin/bash
if ! killall -0 haproxy 2>/dev/null; then
    systemctl stop keepalived
fi
EOF
chmod +x /etc/keepalived/check_haproxy.sh
```

### 3.5 启动服务

```bash
systemctl enable --now haproxy
systemctl enable --now keepalived

# 验证 VIP
ip addr show eth0 | grep 172.25.254.200
# lb1 应该有 VIP,lb2 没有
```

## 四、Docker 部署(所有 K8s 节点)

### 4.1 安装 Docker

```bash
# 配置仓库
cat > /etc/yum.repos.d/docker.repo << 'EOF'
[docker]
name=docker-ce
baseurl=https://mirrors.aliyun.com/docker-ce/linux/centos/7/x86_64/stable
gpgcheck=0
EOF

# 安装
yum install docker-ce-20.10.24 docker-ce-cli-20.10.24 containerd.io -y

# 配置 Docker
mkdir /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "exec-opts": ["native.cgroupdriver=systemd"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  },
  "registry-mirrors": ["https://reg.zxf.org"]
}
EOF

# 启动
systemctl enable --now docker
```

### 4.2 安装 cri-dockerd

K8s 1.24+ 需要 cri-dockerd 作为 Docker 和 kubelet 的桥梁:

```bash
# 下载 cri-dockerd
wget https://github.com/Mirantis/cri-dockerd/releases/download/v0.3.14/cri-dockerd-0.3.14-3.el7.x86_64.rpm
rpm -ivh cri-dockerd-0.3.14-3.el7.x86_64.rpm

# 修改配置
sed -i 's#ExecStart=/usr/bin/cri-dockerd.*#ExecStart=/usr/bin/cri-dockerd --container-runtime-endpoint fd:// --network-plugin=cni --pod-infra-container-image=reg.zxf.org/k8s/pause:3.10.1#' /usr/lib/systemd/system/cri-docker.service

systemctl daemon-reload
systemctl enable --now cri-docker
```

## 五、安装 kubeadm、kubelet、kubectl

### 5.1 配置 K8s 仓库

```bash
cat > /etc/yum.repos.d/kubernetes.repo << 'EOF'
[kubernetes]
name=Kubernetes
baseurl=https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.35/rpm/
gpgcheck=0
EOF
```

### 5.2 安装(所有 K8s 节点)

```bash
yum install kubelet-1.35.3 kubeadm-1.35.3 kubectl-1.35.3 -y
systemctl enable kubelet
```

### 5.3 配置 bash 补全(master 节点)

```bash
echo "source <(kubectl completion bash)" >> ~/.bashrc
echo "source <(kubeadm completion bash)" >> ~/.bashrc
source ~/.bashrc
```

## 六、预拉取镜像

### 6.1 拉取镜像(所有 master 节点)

```bash
kubeadm config images pull \
  --image-repository registry.aliyuncs.com/google_containers \
  --kubernetes-version v1.35.3 \
  --cri-socket=unix:///var/run/cri-dockerd.sock
```

### 6.2 推送到 Harbor 仓库

```bash
# 登录 Harbor
docker login reg.zxf.org -u admin

# 重新打 tag 并推送
docker images --format "{{.Repository}}:{{.Tag}}" | \
  awk -F "/" '/google/{system("docker tag "$0" reg.zxf.org/k8s/"$3)}'

docker images --format "{{.Repository}}:{{.Tag}}" | \
  awk -F "/" '/zxf/{system("docker push "$0)}'
```

## 七、初始化第一个 master

### 7.1 生成 kubeadm 配置文件

```bash
cat > kubeadm-config.yaml << 'EOF'
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: v1.35.3
controlPlaneEndpoint: "172.25.254.200:6443"      # VIP
imageRepository: reg.zxf.org/k8s
networking:
  podSubnet: 10.244.0.0/16
  serviceSubnet: 10.96.0.0/12
apiServer:
  certSANs:
  - 172.25.254.100
  - 172.25.254.110
  - 172.25.254.120
  - 172.25.254.200
  - k8s-master1
  - k8s-master2
  - k8s-master3
  - k8s-api.zxf.org
etcd:
  local:
    extraArgs:
      listen-client-urls: "https://127.0.0.1:2379"
      advertise-client-urls: "https://127.0.0.1:2379"
      listen-peer-urls: "https://127.0.0.1:2380"
      initial-advertise-peer-urls: "https://127.0.0.1:2380"
      initial-cluster: "k8s-master1=https://172.25.254.100:2380"
      initial-cluster-state: new
      initial-cluster-token: etcd-cluster
    serverCertSANs:
    - k8s-master1
    - 172.25.254.100
    peerCertSANs:
    - k8s-master1
    - 172.25.254.100
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
nodeRegistration:
  criSocket: unix:///var/run/cri-dockerd.sock
  name: k8s-master1
EOF
```

### 7.2 初始化集群

```bash
kubeadm init --config=kubeadm-config.yaml --upload-certs
```

关键参数:
- **`--upload-certs`** — 上传证书到 K8s Secret,其他 master 加入时自动下载
- **`controlPlaneEndpoint`** — VIP 地址,所有 kubelet 连这个 IP
- **`certSANs`** — 证书包含所有 master IP 和 VIP

### 7.3 初始化成功输出

```
Your Kubernetes control-plane has initialized successfully!

To start using your cluster, you need to run the following as a regular user:

  mkdir -p $HOME/.kube
  sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
  sudo chown $(id -u):$(id -g) $HOME/.kube/config

You should now deploy a pod network to the cluster.
Run "kubectl apply -f [podnetwork].yaml" with one of the options listed at:
  https://kubernetes.io/docs/concepts/cluster-administration/addons/

You can now join any number of the control-plane node running the following command on each as root:

  kubeadm join 172.25.254.200:6443 --token xxxxxx.xxxxxxxx \
    --discovery-token-ca-cert-hash sha256:xxxxxxxx \
    --control-plane \
    --certificate-key xxxxxxxx \
    --cri-socket=unix:///var/run/cri-dockerd.sock

Then you can join any number of worker nodes by running the following on each as root:

  kubeadm join 172.25.254.200:6443 --token xxxxxx.xxxxxxxx \
    --discovery-token-ca-cert-hash sha256:xxxxxxxx \
    --cri-socket=unix:///var/run/cri-dockerd.sock
```

**记录这两个 join 命令**,后续加入 master 和 worker 用。

### 7.4 配置 kubectl

```bash
mkdir -p $HOME/.kube
cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
chown $(id -u):$(id -g) $HOME/.kube/config

# 验证
kubectl get nodes
NAME          STATUS     ROLES           AGE   VERSION
k8s-master1   NotReady   control-plane   30s   v1.35.3
```

## 八、加入其他 master 节点

### 8.1 在 k8s-master2 和 k8s-master3 执行

```bash
kubeadm join 172.25.254.200:6443 \
  --token xxxxxx.xxxxxxxx \
  --discovery-token-ca-cert-hash sha256:xxxxxxxx \
  --control-plane \
  --certificate-key xxxxxxxx \
  --cri-socket=unix:///var/run/cri-dockerd.sock
```

注意 `--control-plane` 参数,表示加入为 master 节点。

### 8.2 验证 master 集群

```bash
kubectl get nodes
NAME          STATUS     ROLES           AGE     VERSION
k8s-master1   NotReady   control-plane   2m      v1.35.3
k8s-master2   NotReady   control-plane   30s     v1.35.3
k8s-master3   NotReady   control-plane   15s     v1.35.3
```

3 个 master 都加入,状态是 NotReady(还没装网络插件)。

### 8.3 验证 etcd 集群

```bash
# 在任意 master 节点
kubectl get pods -n kube-system | grep etcd
etcd-k8s-master1   1/1     Running   0   3m
etcd-k8s-master2   1/1     Running   0   90s
etcd-k8s-master3   1/1     Running   0   60s

# 检查 etcd 集群成员
kubectl exec -n kube-system etcd-k8s-master1 -- etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list
```

3 个 etcd 成员组成 Raft 集群,容忍 1 节点故障。

## 九、加入 worker 节点

### 9.1 在 3 个 worker 节点执行

```bash
kubeadm join 172.25.254.200:6443 \
  --token xxxxxx.xxxxxxxx \
  --discovery-token-ca-cert-hash sha256:xxxxxxxx \
  --cri-socket=unix:///var/run/cri-dockerd.sock
```

注意 worker 节点**不加** `--control-plane` 参数。

### 9.2 验证

```bash
kubectl get nodes
NAME          STATUS     ROLES           AGE     VERSION
k8s-master1   NotReady   control-plane   5m      v1.35.3
k8s-master2   NotReady   control-plane   3m      v1.35.3
k8s-master3   NotReady   control-plane   2m      v1.35.3
k8s-worker1   NotReady   <none>          30s     v1.35.3
k8s-worker2   NotReady   <none>          20s     v1.35.3
k8s-worker3   NotReady   <none>          10s     v1.35.3
```

6 个节点全部加入,状态都是 NotReady(需要装网络插件)。

## 十、部署 Flannel 网络插件

### 10.1 准备 Flannel 镜像

```bash
# 在所有节点加载 Flannel 镜像
docker load -i flannel-v0.28.1.tar

# 重新打 tag 并推送到 Harbor
docker tag ghcr.io/flannel-io/flannel:v0.28.1 reg.zxf.org/flannel-io/flannel:v0.28.1
docker push reg.zxf.org/flannel-io/flannel:v0.28.1

docker tag ghcr.io/flannel-io/flannel-cni-plugin:v1.9.0 reg.zxf.org/flannel-io/flannel-cni-plugin:v1.9.0
docker push reg.zxf.org/flannel-io/flannel-cni-plugin:v1.9.0
```

### 10.2 部署 Flannel

```bash
# 下载 Flannel YAML
curl -o kube-flannel.yml https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml

# 修改镜像地址为 Harbor
sed -i 's|ghcr.io/flannel-io|reg.zxf.org/flannel-io|g' kube-flannel.yml

# 部署
kubectl apply -f kube-flannel.yml
```

### 10.3 验证集群状态

```bash
kubectl get nodes
NAME          STATUS   ROLES           AGE     VERSION
k8s-master1   Ready    control-plane   10m     v1.35.3
k8s-master2   Ready    control-plane   8m      v1.35.3
k8s-master3   Ready    control-plane   7m      v1.35.3
k8s-worker1   Ready    <none>          5m      v1.35.3
k8s-worker2   Ready    <none>          4m      v1.35.3
k8s-worker3   Ready    <none>          3m      v1.35.3
```

所有节点 Ready,集群部署成功!

## 十一、高可用验证

### 11.1 模拟 master 故障

```bash
# 关闭 k8s-master1
ssh k8s-master1 "systemctl stop kubelet"

# 检查集群状态
kubectl get nodes
NAME          STATUS     ROLES           AGE     VERSION
k8s-master1   NotReady   control-plane   15m     v1.35.3
k8s-master2   Ready      control-plane   13m     v1.35.3
k8s-master3   Ready      control-plane   12m     v1.35.3
k8s-worker1   Ready      <none>          10m     v1.35.3
...

# 集群仍然可用
kubectl get pods -A
# 所有 Pod 正常运行
```

master1 故障后,集群仍然可用,API Server 通过 VIP 自动切换到健康的 master。

### 11.2 恢复 master

```bash
ssh k8s-master1 "systemctl start kubelet"
kubectl get nodes
# master1 恢复 Ready
```

### 11.3 验证 etcd 容灾

```bash
# 停止 master1 的 etcd
ssh k8s-master1 "mv /etc/kubernetes/manifests/etcd.yaml /tmp/"

# etcd 集群仍然工作(2/3 节点)
kubectl exec -n kube-system etcd-k8s-master2 -- etcdctl member list
# 显示 2 个 healthy 成员
```

## 十二、生产环境优化

### 12.1 etcd 备份

```bash
# 定期备份 etcd
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /backup/etcd-$(date +%Y%m%d).db

# 设置 cron 定时备份
echo "0 2 * * * root /usr/local/bin/etcd-backup.sh" >> /etc/crontab
```

### 12.2 证书续期

K8s 证书默认有效期 1 年,到期前需要续期:

```bash
# 检查证书到期时间
kubeadm certs check-expiration

# 续期所有证书
kubeadm certs renew all

# 重启控制面组件
kubectl -n kube-system delete pods -l component=kube-apiserver
kubectl -n kube-system delete pods -l component=kube-controller-manager
kubectl -n kube-system delete pods -l component=kube-scheduler
```

生产环境建议用 `cert-manager` + 自签 CA 实现证书自动续期。

### 12.3 监控告警

部署 Prometheus 监控集群:
- **节点状态** — Node Ready/NotReady
- **etcd 健康** — etcd leader、raft term
- **API Server** — 请求延迟、错误率
- **Pod 状态** — CrashLoopBackOff、OOMKilled

## 十三、常见问题排查

### 13.1 master 加入失败

**错误**: `error uploading crisp`

**解决**: 证书 key 过期(2 小时),重新生成:
```bash
# 在已初始化的 master 上
kubeadm init phase upload-certs --upload-certs
# 输出新的 certificate-key,用新 key 加入
```

### 13.2 etcd 集群不一致

**错误**: `etcdserver: request timed out`

**解决**: etcd 数据不一致,需要重置:
```bash
# 在问题节点
kubeadm reset --cri-socket=unix:///var/run/cri-dockerd.sock
rm -rf /var/lib/etcd
# 重新 join
```

### 13.3 VIP 不切换

**错误**: master 故障后 VIP 没漂移

**解决**: 检查 Keepalived:
```bash
# 检查 Keepalived 状态
systemctl status keepalived
# 检查健康检查脚本
cat /etc/keepalived/check_haproxy.sh
# 手动测试
/etc/keepalived/check_haproxy.sh; echo $?
```

## 十四、高可用集群的工程价值

3 master + 3 worker 的高可用 K8s 集群,实现了:

1. **控制面高可用** — 3 个 master,容忍 1 节点故障
2. **etcd 数据安全** — 3 副本 Raft 集群,数据强一致
3. **API Server 负载均衡** — HAProxy + Keepalived VIP,自动故障转移
4. **工作节点扩展** — 3 worker 提供计算资源,可动态扩缩

这套架构能支撑生产环境的核心业务:
- **可用性 99.9%+** — 单节点故障不影响服务
- **数据安全** — etcd 3 副本,备份策略完善
- **可维护性** — 滚动升级 master,不中断服务

在 Web 集群项目里,我们用这套架构跑了半年,经历过:
- master1 硬盘故障 → VIP 自动切换,业务无感知
- etcd 内存泄漏 → 及时告警,滚动重启修复
- 网络抖动 → Flannel 自愈,Pod 通信恢复

高可用不是"装个集群",是"设计故障发生时的应对机制"。3 master 架构就是这套机制的基础——任何单点故障都能被自动消化,业务持续可用。

> 高可用集群的核心不是"没有故障",而是"故障发生时业务不中断"。3 master + etcd 集群 + VIP 负载均衡,构成了 K8s 控制面的完整容灾体系。
