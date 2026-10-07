# K8s 资源管理:命令式 vs 声明式,运维视角的取舍

> 这篇记录我对 K8s 资源管理两种范式——命令式(Imperative)和声明式(Declarative)的实战理解。不是教科书式的定义对比,而是从运维场景出发,讲清楚什么时候用哪种,以及为什么。

## 一、两种范式的本质区别

### 1.1 命令式:你告诉系统"做什么"

```bash
# 运行一个 Pod
kubectl run webpod --image nginx:1.23 --port 80
pod/webpod created

# 查看
kubectl get pods
NAME     READY   STATUS    RESTARTS   AGE
webpod   1/1     Running   0          9s

# 查看详细信息
kubectl describe pods webpod
```

命令式操作的特点是:**即时、直接、不持久化**。你执行一条命令,K8s 立即响应,但这条命令本身不会留下任何记录——重启终端、换台机器,没人知道这个 Pod 是怎么创建出来的。

这种方式适合临时调试、快速验证。比如想测试某个镜像能不能跑,直接 `kubectl run` 一把最方便;但要管理生产环境的部署,这种方式是灾难性的。

### 1.2 声明式:你告诉系统"想要什么"

```yaml
# test.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: test
  name: test
spec:
  replicas: 2
  selector:
    matchLabels:
      app: test
  template:
    metadata:
      labels:
        app: test
    spec:
      containers:
      - image: nginx:1.23
        name: nginx
```

```bash
kubectl apply -f test.yml
```

声明式操作的特点是:**幂等、可追溯、版本可控**。YAML 文件就是"期望状态",`kubectl apply` 让集群的实际状态收敛到这个期望状态。多次 apply 同一个文件,结果是一致的——这是 GitOps 工作流的基础。

## 二、命令式的两类:kubectl create vs kubectl apply

很多人以为 `kubectl create -f` 和 `kubectl apply -f` 是等价的,其实有本质区别:

### 2.1 kubectl create:建立式,不可重复执行

```bash
kubectl create -f test.yml
deployment.apps/test created

# 再次执行
kubectl create -f test.yml
Error from server (AlreadyExists): error when creating "test.yml": \
  deployments.apps "test" already exists
```

`create` 是"建立式"——它要求资源不存在,如果已存在就报错。这种特性意味着 `create` 不能用于更新资源配置。

### 2.2 kubectl apply:声明式,可重复执行

```bash
# 第一次
kubectl apply -f test.yml
deployment.apps/test created

# 修改 replicas: 2 → 4
vim test.yml
kubectl apply -f test.yml
deployment.apps/test configured

kubectl get pods
NAME                    READY   STATUS    RESTARTS   AGE
test-56f57db555-62glt   1/1     Running   0          2s
test-56f57db555-8nmk7   1/1     Running   0          28m
test-56f57db555-9ttxt   1/1     Running   0          2s
test-56f57db555-htff7   1/1     Running   0          29m
```

`apply` 是"声明式"——它对比当前状态和期望状态的差异,只更新差异部分。这就是为什么 `apply` 能用于持续更新资源配置。

### 2.3 底层原理:三路合并

`kubectl apply` 的实现是 **three-way merge**:
1. 上一次 apply 的内容(存在资源的 `last-applied-configuration` annotation 里)
2. 本次 apply 的内容(YAML 文件)
3. 集群当前的实时状态

对比这三份内容,计算出需要变更的字段。这种设计能正确处理"用户手动改了集群配置"的情况——比如用 `kubectl edit` 临时改了 replicas,下次 apply 不会把用户的临时修改覆盖掉(除非 YAML 里也改了)。

而 `kubectl create` 是 **全量替换**,每次都把 YAML 里的所有字段写入,会覆盖任何手动修改。所以生产环境基本只用 `apply`,不用 `create`。

## 三、YAML 文件的生成技巧

手写 K8s YAML 是反人类的——字段太多、嵌套太深。正确做法是用 `--dry-run=client -o yaml` 让 kubectl 帮你生成模板:

```bash
kubectl create deployment test \
  --image nginx:1.23 \
  --replicas 1 \
  --dry-run=client \
  -o yaml > test.yml
```

`--dry-run=client` 表示只在客户端生成 YAML 不真正提交到集群,`-o yaml` 输出 YAML 格式。生成的文件可以直接 vim 修改,然后 `kubectl apply -f` 部署。

这套"命令式生成 + 声明式部署"的组合拳,是我日常运维的标准工作流。在我的电商项目里,所有 K8s 资源(Deployment、Service、ConfigMap、Secret)都是这么生成的,然后统一进 Git 仓库管理。

## 四、kubectl 的常用资源操作命令

### 4.1 patch:非交互式修改

```bash
# 把 replicas 从 4 改成 1
kubectl patch deployments.apps test -p '{"spec":{"replicas":1}}'
deployment.apps/test patched
```

`patch` 用 JSON Patch 或 Strategic Merge Patch 格式,适合脚本化批量操作。CI/CD 流水线里经常用 patch 动态调整副本数,比如根据监控指标自动扩缩容。

### 4.2 edit:交互式修改

```bash
kubectl edit deployments.apps test
# 会打开 vim,修改 replicas: 4 后保存退出
deployment.apps/test edited
```

`edit` 适合临时调试,但不适合生产环境——因为修改不会留痕,违反 GitOps 原则。我自己的规则是:**`edit` 只在排查问题时用,任何配置变更最终都要落到 YAML 文件 + `git commit`**。

### 4.3 expose:创建 Service

```bash
kubectl expose deployment test --port 80 --target-port 80
service/test exposed

kubectl describe service test
Name:                     test
Type:                     ClusterIP
IP:                       10.101.115.11
Port:                     <unset>  80/TCP
TargetPort:               80/TCP
Endpoints:                10.244.1.2:80,10.244.3.6:80,10.244.1.4:80 + 1 more...
```

`expose` 会根据 Deployment 自动创建一个 ClusterIP 类型的 Service,selector 跟 Deployment 的 pod label 一致。Endpoints 字段列出了所有健康 Pod 的 IP,这就是 Service 负载均衡的后端实例。

## 五、声明式的工程价值:GitOps 的基石

为什么整个云原生社区都在推崇声明式?核心原因是**声明式让基础设施变成了代码**。

在我的 Web 集群项目里,完整工作流是这样的:

1. **本地修改 YAML 文件** — `vim deployment.yml`
2. **Git 提交** — `git add . && git commit -m "bump replicas to 4"`
3. **Push 到 Gitee** — `git push`
4. **Jenkins Webhook 触发** — Pipeline 自动执行 `kubectl apply -f deployment.yml`
5. **集群状态收敛** — Deployment Controller 创建新 Pod,销毁旧 Pod,最终 4 个副本运行

整个流程**没有任何手动 `kubectl` 命令**,所有变更都通过 Git 提交记录可追溯。出了问题直接 `git revert` 回滚,集群状态自动收敛到上一个版本。这就是 GitOps 的核心思想——**Git 是基础设施的唯一真相源(single source of truth)**。

对比命令式操作:某次运维同学手动 `kubectl scale deployment web --replicas=10` 应对流量高峰,事后忘了改回来,导致夜间资源浪费。这种"配置漂移"在命令式管理下无法避免,但在 GitOps 下根本不会发生——因为 YAML 文件没改,下次 apply 会把 replicas 拉回正确值。

## 六、什么时候用命令式

声明式不是银弹,有些场景命令式更合适:

1. **临时调试** — `kubectl run -it --rm --image=busybox debug-pod -- sh` 起一个临时 Pod 进容器网络里抓包,这种一次性操作写 YAML 反而麻烦
2. **应急处理** — 生产环境出故障,需要立刻 `kubectl delete pod xxx` 强制重启,等不及改 YAML
3. **探索学习** — 刚接触 K8s 时,命令式能快速建立直觉,等理解了再学 YAML 写法

但只要进入"持续运维"阶段,就必须切换到声明式。这是从"运维"到"SRE"的关键转变——**把所有的运维动作都变成代码**,让基础设施具备版本控制和可审计性。

> 命令式适合"做事",声明式适合"管事"。生产环境选后者,因为出问题时你需要的是"看到配置历史",而不是"回忆当时敲了什么命令"。
