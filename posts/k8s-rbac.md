# K8s RBAC 权限控制:Role、ClusterRole 与最小权限原则

> 生产环境的 K8s 集群不能所有人都用 admin 配置——开发误删资源、第三方应用权限过大、审计无法追溯,这些都是安全隐患。RBAC(Role-Based Access Control)是 K8s 的权限控制核心,这篇记录 Role/ClusterRole 的配置实践和最小权限原则。

## 一、为什么需要 RBAC

### 1.1 全权限的风险

默认情况下,集群管理员用 `admin.conf` 操作集群,拥有所有资源的所有权限。如果所有人都用这套配置:

- **误操作风险** — 开发同学误删生产 Service、Deployment
- **权限扩散** — 第三方应用拿到 admin token,等于拿到集群控制权
- **审计困难** — 所有操作都是 admin 用户,无法追溯具体是谁操作的
- **合规问题** — 等保、SOC2 等审计要求权限最小化、可追溯

### 1.2 RBAC 的核心概念

K8s RBAC 有四个核心概念:

- **Role** — 命名空间级别的权限(只能控制某个 namespace 的资源)
- **ClusterRole** — 集群级别的权限(可以控制所有 namespace 或集群级资源如 PV、Node)
- **RoleBinding** — 把 Role 绑定到用户/组/ServiceAccount
- **ClusterRoleBinding** — 把 ClusterRole 绑定到用户/组/ServiceAccount

关系:
```
User/Group/ServiceAccount
        ↓ (binding)
Role / ClusterRole
        ↓ (rules)
Resources + Verbs
```

## 二、Role 与 RoleBinding:命名空间级权限

### 2.1 创建 Role

```yaml
# zxfrole.yml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: zxfrole
  namespace: default
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "watch", "list", "create"]
```

关键字段:
- **`apiGroups`** — API 组,空字符串 `""` 表示核心组(Pod、Service、ConfigMap 等),`apps` 表示 apps 组(Deployment、StatefulSet 等)
- **`resources`** — 资源类型(pods、services、deployments)
- **`verbs`** — 允许的操作(get、list、create、update、delete)

### 2.2 创建 RoleBinding

```yaml
# zxfrole-binding.yml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: zxfrole-binding
  namespace: default
subjects:
- kind: User
  name: zxf                        # 绑定到用户 zxf
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: zxfrole                    # 引用上面的 Role
  apiGroup: rbac.authorization.k8s.io
```

### 2.3 验证权限

```bash
kubectl apply -f zxfrole-binding.yml
rolebinding.rbac.authorization.k8s.io/zxfrole-binding created

kubectl describe rolebindings.rbac.authorization.k8s.io zxfrole-binding
Name:         zxfrole-binding
Role:
  Kind:  Role
  Name:  zxfrole
Subjects:
  Kind  Name  Namespace
  ----  ----  ---------
  User  zxf
```

切换到 zxf 用户测试:

```bash
kubectl config use-context zxf@kubernetes
Switched to context "zxf@kubernetes".

# 可以看 Pod(有权限)
kubectl get pods
NAME      READY   STATUS    RESTARTS   AGE
testpod   1/1     Running   0          62m

# 可以删 Pod(有权限)
kubectl delete pods testpod
pod "testpod" deleted from default namespace

# 不能看 Service(没权限)
kubectl get svc
Error from server (Forbidden): services is forbidden: User "zxf" cannot list resource "services" in API group "" in the namespace "default"

# 不能看 Deployment(没配 apps 组权限)
kubectl get deployments.apps
No resources found in default namespace.
```

完美体现了**最小权限原则**——zxf 用户只能操作 Pod,不能看 Service 和其他资源。

## 三、ClusterRole 与 ClusterRoleBinding:集群级权限

### 3.1 为什么需要 ClusterRole

Role 只能控制单个 namespace 的资源。如果用户需要:
- 看集群级资源(PV、Node、Namespace)
- 跨 namespace 操作(如运维同学需要看所有 namespace 的 Pod)
- 使用 `kubectl get pods -A`(查看所有 namespace)

这些场景都需要 ClusterRole。

### 3.2 创建 ClusterRole

```yaml
# zxfclusterrole.yml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: zxfclusterrole
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "watch", "list", "create"]
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get", "watch", "list", "create"]
```

```bash
kubectl apply -f zxfclusterrole.yml
clusterrole.rbac.authorization.k8s.io/zxfclusterrole created

kubectl describe clusterrole zxfclusterrole
Name:         zxfclusterrole
PolicyRule:
  Resources         Non-Resource URLs  Resource Names  Verbs
  ---------         -----------------  --------------  -----
  pods              []                 []              [get watch list create update patch delete]
  services          []                 []              [get watch list create]
  deployments.apps  []                 []              [get watch list create]
```

### 3.3 创建 ClusterRoleBinding

```bash
kubectl create clusterrolebinding clusterrolebind-zxfclusterrole \
  --clusterrole zxfclusterrole \
  --user zxf
clusterrolebinding.rbac.authorization.k8s.io/clusterrolebind-zxfclusterrole created

kubectl describe clusterrolebindings.rbac.authorization.k8s.io clusterrolebind-zxfclusterrole
Name:         clusterrolebind-zxfclusterrole
Role:
  Kind:  ClusterRole
  Name:  zxfclusterrole
Subjects:
  Kind  Name  Namespace
  ----  ----  ---------
  User  zxf
```

### 3.4 验证集群级权限

```bash
kubectl config use-context zxf@kubernetes
Switched to context "zxf@kubernetes".

# 可以看 Service 了
kubectl get svc
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   10.96.0.1    <none>        443/TCP   28d
zxf          ClusterIP   None         <none>        80/TCP    6d19h

# 可以看所有 namespace 的 Pod
kubectl get pods -A
NAMESPACE                NAME                                        READY   STATUS    RESTARTS   AGE
ingress-nginx            ingress-nginx-controller-6bcbfdbd4b-z2qkr   1/1     Running   1          19h
kube-system              calico-kube-controllers-76cf8c6dbf-g6pgh    1/1     Running   1          23h
kube-system              coredns-7c4f9bc886-psn82                    1/1     Running   333        28d
...

# 但不能看 PV(没配权限)
kubectl get pv
Error from server (Forbidden): persistentvolumes is forbidden: User "zxf" cannot list resource "persistentvolumes" in API group "" at the cluster scope
```

注意:虽然 ClusterRole 给了 pods 的 list 权限,但没给 PV 权限,所以 `kubectl get pv` 仍然 Forbidden。这就是 RBAC 的精细控制能力。

## 四、ServiceAccount 与 RBAC

### 4.1 ServiceAccount 的用途

之前的例子都是绑定到 User(用户),实际生产中更多用 ServiceAccount:
- **应用部署在 Pod 里** — Pod 用 ServiceAccount 身份访问 API Server
- **CI/CD 系统** — Jenkins 用 ServiceAccount 部署应用
- **自动化运维** — 运维脚本用 ServiceAccount 操作集群

### 4.2 创建 ServiceAccount + RBAC

```yaml
# 为 CI/CD 创建专用 ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer-role
  namespace: production
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "update", "patch"]    # 只能更新 Deployment
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list"]                        # 只能看 Pod 和日志
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: deployer-binding
  namespace: production
subjects:
- kind: ServiceAccount
  name: ci-deployer
  namespace: production
roleRef:
  kind: Role
  name: deployer-role
  apiGroup: rbac.authorization.k8s.io
```

这个 ServiceAccount 只能更新 Deployment 和看 Pod 日志,不能删除资源、不能看 Secret、不能操作其他 namespace——典型的 CI/CD 最小权限。

### 4.3 Pod 使用 ServiceAccount

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  template:
    spec:
      serviceAccountName: ci-deployer    # 指定 ServiceAccount
      containers:
      - name: myapp
        image: myapp:v1
```

Pod 里的应用用 ServiceAccount 的 token 访问 API Server,权限受 RoleBinding 控制。

## 五、RBAC 的 verbs 详解

### 5.1 常用 verbs

| Verb | 含义 | 对应 kubectl 命令 |
|------|------|-----------------|
| `get` | 获取单个资源 | `kubectl get pod xxx` |
| `list` | 列出资源列表 | `kubectl get pods` |
| `watch` | 监听资源变化 | `kubectl get pods -w` |
| `create` | 创建资源 | `kubectl apply -f pod.yml` |
| `update` | 全量更新 | `kubectl edit pod xxx` |
| `patch` | 部分更新 | `kubectl patch pod xxx -p '{...}'` |
| `delete` | 删除资源 | `kubectl delete pod xxx` |
| `exec` | 进入容器 | `kubectl exec -it pod xxx -- sh` |
| `port-forward` | 端口转发 | `kubectl port-forward pod xxx 8080:80` |

### 5.2 资源子资源

某些资源有子资源,需要单独授权:

```yaml
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]        # pods/log 是子资源
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["pods/exec"]               # pods/exec 是子资源
  verbs: ["create"]
```

- **`pods/log`** — 看 Pod 日志
- **`pods/exec`** — 进入容器执行命令
- **`pods/portforward`** — 端口转发
- **`deployments/scale`** — 扩缩容

### 5.3 通配符

```yaml
rules:
- apiGroups: ["*"]          # 所有 API 组
  resources: ["*"]          # 所有资源
  verbs: ["*"]              # 所有操作
```

通配符 `*` 表示"全部",生产环境**慎用**——等同于 admin 权限。

## 六、生产环境的 RBAC 实践

### 6.1 按角色设计 ClusterRole

```yaml
# 开发者角色:可以看所有资源,但不能修改
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer-readonly
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create"]              # 允许 exec 进 Pod 调试
---
# 运维角色:可以管理 Deployment、Service,不能管 Node、Namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ops-engineer
rules:
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets", "daemonsets"]
  verbs: ["*"]
- apiGroups: [""]
  resources: ["services", "configmaps", "secrets", "pods"]
  verbs: ["*"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["*"]
```

### 6.2 命名空间隔离

```yaml
# dev 环境开发同学有完整权限
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: dev-full-access
  namespace: dev
subjects:
- kind: Group
  name: developers              # 绑定到开发者组
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: admin                   # 用内置的 admin ClusterRole
  apiGroup: rbac.authorization.k8s.io
---
# prod 环境开发同学只读
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: prod-readonly
  namespace: production
subjects:
- kind: Group
  name: developers
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: developer-readonly
  apiGroup: rbac.authorization.k8s.io
```

开发同学在 dev namespace 可以随便折腾,在 production namespace 只能看不能改——典型的多环境权限隔离。

### 6.3 审计日志

开启 K8s 审计日志,记录所有 API 调用:

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: Metadata              # 记录请求元数据
  verbs: ["create", "update", "patch", "delete"]    # 只记录写操作
  resources:
  - group: ""
    resources: ["secrets"]     # 重点审计 Secret 访问
- level: None                  # 其他请求不记录
```

审计日志可以追溯"谁在什么时间对什么资源做了什么操作",是合规审计的关键证据。

## 七、RBAC 的常见陷阱

### 7.1 权限过大

```yaml
# 错误:给所有权限
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
```

这种"admin 级"权限违反最小权限原则,生产环境严禁使用。应该按需配置具体资源的具体操作。

### 7.2 忘记子资源

```yaml
# 只授权 pods,但没授权 pods/log
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
```

开发同学 `kubectl logs xxx` 会报 Forbidden——因为 `pods/log` 是子资源,需要单独授权。

### 7.3 namespace 不匹配

Role 是 namespace 级别,RoleBinding 的 namespace 必须与 Role 一致:

```yaml
# 错误:Role 在 default,RoleBinding 在 production
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-binding
  namespace: production          # RoleBinding 在 production
roleRef:
  kind: Role
  name: my-role                  # 但 Role 定义在 default namespace
```

这种配置会导致权限不生效。

### 7.4 ServiceAccount 跨 namespace

ServiceAccount 是 namespace 级别,RoleBinding 引用其他 namespace 的 ServiceAccount 需要 `namespace` 字段:

```yaml
subjects:
- kind: ServiceAccount
  name: ci-deployer
  namespace: ci-tools           # 显式指定 namespace
```

## 八、RBAC 的工程哲学

RBAC 体现了几个核心安全原则:

1. **最小权限原则(Least Privilege)** — 只授予完成任务所需的最小权限,不多给
2. **职责分离(Separation of Duties)** — 开发、运维、审计角色分离,互相制约
3. **可审计性(Accountability)** — 每个操作都能追溯到具体身份
4. **默认拒绝(Default Deny)** — 没有显式授权的操作一律拒绝

在电商项目里,我们的 RBAC 体系:
- **开发同学** — dev namespace 完整权限,prod 只读
- **运维同学** — 所有 namespace 的应用资源管理权限,但不能管 Node/Namespace
- **CI/CD** — 专用 ServiceAccount,只能更新 Deployment 和看日志
- **审计** — 所有写操作记审计日志,定期审查

这套体系让团队协作既高效又安全——每个人都能完成自己的工作,但不会因为误操作影响其他部分。

> RBAC 不是"权限管理",是"安全治理"。它让 K8s 集群从"所有人都是 admin"变成"每个人都有恰到好处的权限",这是生产环境安全的基础。
