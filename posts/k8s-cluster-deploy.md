# Kubernetes 集群部署全流程：从 Docker 到 cri-dockerd 的工程化落地

> 这是我做 Web 集群部署与自动化运维项目时,把一台台裸机变成一个 K8s 集群的全流程记录。不是教程搬运,而是踩过坑之后的工程化复盘。

## 一、为什么要把部署流程文档化

容器化项目做完之后,我意识到一个核心问题:**部署环境的复现性比应用代码本身更重要**。当我在电商项目里用 Docker Compose 编排 Spring Boot + MySQL + Redis + Nginx 四个服务时,部署脚本确实能把 15 分钟的人工流程压缩到 3 分钟,但一旦换台机器,网络配置、内核参数、镜像仓库认证这些底层依赖全得重头来。

K8s 把这个问题彻底结构化了——只要 master 和 worker 节点的初始化步骤一致,集群就能稳定复现。所以我花了将近两周时间,把 harbor 仓库 + cri-dockerd + kubeadm 初始化 + flannel 网络插件 这条链路完整跑通,并把每一步的配置文件和验证命令都沉淀成文档。下面是核心环节的工程化要点。

## 二、环境规划与角色划分

集群架构采用经典的 1 master + 2 worker 模式,另外单独一台 harbor 节点做私有镜像仓库。这种分离设计有两个考量:一是 harbor 本身依赖 Docker Compose 编排多个服务(PostgreSQL、Redis、core、jobservice 等),资源占用不小,跟 K8s 控制面混部会互相干扰;二是镜像仓库是集群的"基础设施中的基础设施",一旦它挂掉,所有 Pod 的镜像拉取都会失败,所以独立部署更利于故障隔离。

| 主机名 | IP | 角色 |
|--------|-----|------|
| harbor | 172.25.254.30 | harbor 私有镜像仓库 |
| k8s-master | 172.25.254.100 | 控制节点(API Server、Scheduler、Controller Manager、etcd) |
| k8s-node1 | 172.25.254.40 | 工作节点 |
| k8s-node2 | 172.25.254.50 | 工作节点 |

## 三、Docker 部署与内核参数调优

每台主机都要装 Docker,这一步看似简单,但有几个关键细节容易被忽略。

### 3.1 仓库配置与版本锁定

```bash
cat > /etc/yum.repos.d/docker.repo << EOF
[docker]
name=docker-ce
baseurl=https://mirrors.aliyun.com/docker-ce/linux/rhel/9/x86_64/stable
gpgcheck=0
EOF

dnf install docker-ce-3:28.5.2-1.el9 -y
```

这里我特意指定了 `docker-ce-3:28.5.2-1.el9` 这个具体版本而不是 `latest`,原因很实际——**生产环境的依赖版本必须可追溯**。之前在电商项目里就踩过坑,某次 `dnf upgrade` 升级了 Docker,导致 containerd 的 CRI 接口版本和 kubelet 不兼容,Pod 一直处于 ContainerCreating 状态。版本锁定是运维的基本素养。

### 3.2 iptables 与内核参数

```bash
vim /usr/lib/systemd/system/docker.service
# ExecStart 加上 --iptables=true
ExecStart=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock --iptables=true

# 内核参数
echo br_netfilter > /etc/modules-load.d/docker_mod.conf
modprobe br_netfilter
cat > /etc/sysctl.d/docker.conf << EOF
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward = 1
EOF
sysctl --system
```

这三个内核参数背后是一套完整的网络转发链路。`br_netfilter` 模块让桥接流量也能被 iptables 规则处理;`bridge-nf-call-iptables=1` 是 K8s Service 转发正常工作的前提——如果不开启,kube-proxy 写的 iptables 规则对 Pod 间通信不生效,Service 的 ClusterIP 会无法访问;`ip_forward=1` 则是跨节点 Pod 通信的基础。在实验室配置 VLAN 和路由器时,我对此深有体会——网络工程专业的底子在这种时候特别有用。

## 四、Harbor 私有镜像仓库部署

### 4.1 为什么不用 Docker Hub 而要自建 Harbor

电商项目初期我直接用 Docker Hub 存放业务镜像,后来发现三个痛点:一是国内拉取速度慢得离谱,push 一次几百兆的镜像要等好几分钟;二是免费版有拉取频率限制,CI/CD 流水线跑几次就触发限流;三是企业镜像放公网仓库存在合规风险。Harbor 解决了所有这些问题,而且支持镜像签名、漏洞扫描、RBAC 权限控制。

### 4.2 HTTPS 证书生成

```bash
mkdir /data/certs -p
openssl req -newkey rsa:4096 \
  -nodes -sha256 -keyout /data/certs/zxf.org.key \
  -addext "subjectAltName = DNS:reg.zxf.org" \
  -x509 -days 365 -out /data/certs/zxf.org.crt
```

这里的关键是 `subjectAltName`(SAN)扩展。早期 OpenSSL 用 `commonName` 字段做域名匹配,但现代浏览器和 Docker 客户端已经废弃了这种做法,必须用 SAN。如果证书里没有 SAN,Docker daemon 在 login 时会报 `x509: certificate relies on legacy Common Name field`,这是被很多人忽略的坑。

### 4.3 客户端证书分发

```bash
# 在 harbor 主机把证书分发到所有 K8s 节点
for i in 100 40 50; do
  scp /data/certs/zxf.org.crt root@172.25.254.$i:/etc/docker/certs.d/reg.zxf.org/ca.crt
done
```

把 CA 证书放到 `/etc/docker/certs.d/<registry-domain>/ca.crt` 这个路径是 Docker 官方约定的"信任锚点"机制。Docker daemon 在拉取 HTTPS 镜像时,会用这个 CA 证书校验服务端证书。如果不分发,所有节点 `docker login` 都会失败,报 `x509: certificate signed by unknown authority`。

## 五、cri-dockerd:连接 kubelet 与 Docker 的桥梁

### 5.1 为什么需要 cri-dockerd

K8s 1.24 之后,kubelet 移除了内置的 dockershim,Docker 不再是 K8s 原生支持的容器运行时。但生产环境中 Docker 的生态最成熟(镜像构建、调试工具、CI 流水线),完全切换到 containerd 代价太大。`cri-dockerd` 就是这个过渡期的解决方案——它实现了 CRI(Container Runtime Interface)接口,把 kubelet 的 CRI 调用翻译成 Docker API。

```bash
rpm -ivh cri-dockerd-0.3.14-3.el8.x86_64.rpm libcgroup-0.41-19.el8.x86_64.rpm

# 修改 cri-dockerd 的启动参数
vim /lib/systemd/system/cri-docker.service
ExecStart=/usr/bin/cri-dockerd \
  --container-runtime-endpoint fd:// \
  --network-plugin=cni \
  --pod-infra-container-image=reg.zxf.org/k8s/pause:3.10.1
```

`--pod-infra-container-image` 这个参数特别关键。每个 Pod 都会有一个 pause 容器作为"网络命名空间的根",kubelet 通过它来持有 Pod 的网络栈。如果不指定,默认从 `registry.k8s.io/pause:3.10.1` 拉取,而国内网络访问 k8s 官方仓库几乎不可达,Pod 就会卡在 `ContainerCreating` 状态。指向私有仓库的 pause 镜像是国内 K8s 部署的必备配置。

### 5.2 验证 cri-dockerd 状态

```bash
ll /var/run/cri-dockerd.sock
# srw-rw---- 1 root docker 0 ... /var/run/cri-dockerd.sock
```

cri-dockerd 启动后会在 `/var/run/` 下创建一个 Unix Socket,kubelet 就是通过这个 socket 与 cri-dockerd 通信的。后续 `kubeadm init` 时要显式指定 `--cri-socket=unix:///var/run/cri-dockerd.sock`,否则 kubeadm 会找不到运行时。

## 六、kubeadm 镜像预拉取与上传

```bash
# 配置 docker 加速器指向 harbor
cat > /etc/docker/daemon.json << EOF
{
  "registry-mirrors": ["https://reg.zxf.org"]
}
EOF

# 拉取 K8s 组件镜像(用阿里云镜像源)
kubeadm config images pull \
  --image-repository registry.aliyuncs.com/google_containers \
  --kubernetes-version v1.35.3 \
  --cri-socket=unix:///var/run/cri-dockerd.sock

# 重新打 tag 并推送到 harbor
docker images --format "{{.Repository}}:{{.Tag}}" | \
  awk -F "/" '/google/{system("docker tag "$0" reg.zxf.org/k8s/"$3")}'

docker images --format "{{.Repository}}:{{.Tag}}" | \
  awk -F "/" '/zxf/{system("docker push "$0)}'
```

这段 shell 管道是典型的"批量镜像迁移"操作。`awk -F "/"` 按 `/` 分割镜像名,`/google/` 过滤出 google_containers 命名空间的镜像,然后用 `system()` 调用 docker 命令。这种写法比写 for 循环更紧凑,也是 shell 编程里值得掌握的技巧。在我的电商项目里,镜像批量迁移脚本就是基于这种思路写的。

## 七、工程化反思

整个部署流程下来,最大的体会是:**K8s 的复杂性不在于命令本身,而在于各组件之间的依赖关系**。Docker → harbor → cri-dockerd → kubeadm → kubelet → flannel,这条链路上任何一个环节出错,集群都无法 Ready。所以工程化部署的核心是:

1. **每一步都要有验证命令**——装完 Docker 跑 `docker info`,装完 cri-dockerd 看 socket 文件,初始化集群后 `kubectl get nodes` 看 Ready 状态
2. **配置文件用版本控制管理**——`daemon.json`、`/etc/hosts`、`/etc/sysctl.d/docker.conf` 这些文件全部进 Git 仓库,而不是散落在各台机器上
3. **故障重置流程要预先准备好**——`kubeadm reset --cri-socket=unix:///var/run/cri-dockerd.sock` 这个命令必须烂熟于心,因为部署过程中大概率会重置好几次

> 折腾是最好的学习方式,记录是最好的复盘。这套部署文档我后续会持续更新,把生产环境遇到的新问题都补充进来。
