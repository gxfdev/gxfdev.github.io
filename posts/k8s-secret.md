# K8s Secret:敏感数据管理与私有仓库认证

> ConfigMap 用于明文配置,Secret 专门用于敏感数据——密码、密钥、证书、Docker 仓库认证。这篇记录 Secret 的创建方式、使用模式,以及生产环境的密钥治理实践。

## 一、Secret vs ConfigMap

### 1.1 为什么需要 Secret

ConfigMap 的数据是明文存储的,任何有 `kubectl get cm` 权限的人都能看到内容。对于敏感数据(数据库密码、API Key、TLS 证书),明文存储有严重安全风险:
- **审计泄露** — 操作记录、日志可能包含配置内容
- **权限扩散** — RBAC 配置不当导致非授权用户读到
- **etcd 持久化** — 数据存在 etcd,etcd 备份泄露就全泄露

Secret 解决了这些问题:
- **Base64 编码** — 数据在 etcd 中 base64 编码存储(不是加密,但避免肉眼可见)
- **独立 RBAC** — 可以单独控制 Secret 的访问权限
- **类型约束** — 不同类型 Secret(docker-registry、tls、opaque)有不同校验
- **加密静态存储** — 配合 etcd 加密,数据落盘加密

### 1.2 Secret 的三种类型

- **`Opaque`** — 通用类型,任意键值对
- **`kubernetes.io/dockerconfigjson`** — Docker 仓库认证
- **`kubernetes.io/tls`** — TLS 证书和私钥
- **`kubernetes.io/service-account-token`** — SA 令牌(系统自动创建)

## 二、Secret 的创建方式

### 2.1 通过文件创建

```bash
# 准备用户名和密码文件
echo zxf > username
echo 123 > passwd

# 创建 Secret
kubectl create secret generic userlist \
  --from-file username \
  --from-file passwd
secret/userlist created

# 查看
kubectl get secrets userlist -o yaml
apiVersion: v1
data:
  passwd: MTIzCg==                       # base64 编码
  username: enhmCg==                     # base64 编码
kind: Secret
metadata:
  name: userlist
type: Opaque
```

`--from-file` 把文件内容存为 Secret 的键,值是 base64 编码后的内容。

解码验证:
```bash
echo "enhmCg==" | base64 -d
zxf

echo "MTIzCg==" | base64 -d
123
```

注意:base64 是**编码不是加密**!任何人拿到 Secret 都能解码看到原文。Secret 的安全性依赖 RBAC 和 etcd 加密,而不是 base64。

### 2.2 通过 YAML 文件创建

```bash
# 先把敏感数据 base64 编码
echo -n zxf | base64
enhm

echo -n 123 | base64
MTIz
```

```yaml
# userlist.yml
apiVersion: v1
kind: Secret
metadata:
  name: userlist
type: Opaque
data:
  username: enhm                        # base64 编码后的值
  passwd: MTIz
```

```bash
kubectl apply -f userlist.yml

kubectl describe secrets userlist
Name:         userlist
Type:  Opaque
Data
====
passwd:    3 bytes                       # 只显示字节数,不显示内容
username:  3 bytes
```

`kubectl describe` 只显示数据大小,不显示内容——这是 Secret 的安全特性。但 `kubectl get -o yaml` 会显示 base64 编码的内容,所以 RBAC 要严格控制 `get` 权限。

### 2.3 通过字面量创建

```bash
kubectl create secret generic my-secret \
  --from-literal=username=zxf \
  --from-literal=password=123
```

`--from-literal` 直接在命令行指定键值对,适合少量敏感数据。但命令行参数会出现在 shell history 和 ps 输出里,有泄露风险,生产环境不推荐。

## 三、Secret 的使用方式

### 3.1 作为数据卷挂载

```yaml
# testpod.yml
apiVersion: v1
kind: Pod
metadata:
  name: busyboxplus
spec:
  containers:
  - image: busyboxplus
    name: busyboxplus
    command:
    - /bin/sh
    - -c
    - sleep 1000000
    volumeMounts:
    - name: config-volume
      mountPath: /userlist               # 挂载到容器的 /userlist 目录
  volumes:
  - name: config-volume
    secret:
      secretName: userlist               # 引用 Secret
  restartPolicy: Never
```

```bash
kubectl apply -f testpod.yml
kubectl exec -it pods/busyboxplus -- /bin/sh
/ # ls /userlist/
passwd    username
/ # cat /userlist/username
zxf
/ # cat /userlist/passwd
123
```

Secret 挂载为数据卷时,每个键变成一个文件,文件内容是解码后的原文(不是 base64)。应用读文件就能拿到明文敏感数据。

### 3.2 自定义挂载路径

```yaml
volumes:
- name: config-volume
  secret:
    secretName: userlist
    items:                               # 指定挂载哪些键
    - key: username
      path: my-users/username            # 自定义路径
    - key: passwd
      path: my-users/passwd
```

`items` 可以控制:
- **挂载哪些键** — 不指定则挂载所有键
- **挂载路径** — `path` 指定文件在挂载目录下的相对路径

### 3.3 作为环境变量注入

```yaml
# testpod.yml
apiVersion: v1
kind: Pod
metadata:
  name: busyboxplus
spec:
  containers:
  - image: busyboxplus
    name: busyboxplus
    command:
    - /bin/sh
    - -c
    - env
    env:
    - name: USERNAME                     # 环境变量名
      valueFrom:
        secretKeyRef:
          name: userlist                 # Secret 名
          key: username                  # Secret 中的键
    - name: PASSWD
      valueFrom:
        secretKeyRef:
          name: userlist
          key: passwd
  restartPolicy: Never
```

```bash
kubectl apply -f testpod.yml
kubectl logs pods/busyboxplus
...
USERNAME=zxf
PASSWD=123
...
```

`env[].valueFrom.secretKeyRef` 把 Secret 的某个键映射为环境变量。应用通过环境变量读取敏感数据,代码与 ConfigMap 用法完全一致。

注意:环境变量一旦设置就不能动态更新,修改 Secret 后需要重启 Pod 才能生效。数据卷挂载支持热更新(约 10-60 秒延迟)。

## 四、Docker Registry 认证 Secret

### 4.1 私有仓库的认证问题

```bash
# 推送镜像到私有仓库
docker login reg.zxf.org -u admin
docker tag myapp:v1 reg.zxf.org/zxf/myapp:v1
docker push reg.zxf.org/zxf/myapp:v1
```

K8s 拉 Private 仓库镜像时,默认没有认证信息,会报 `ErrImagePull`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
spec:
  containers:
  - image: reg.zxf.org/zxf/myapp:v1     # 私有仓库镜像
    name: myapp
```

```bash
kubectl get pods
NAME          READY   STATUS         RESTARTS   AGE
myapp         0/1     ErrImagePull   0          4s
```

### 4.2 创建 Docker Registry Secret

```bash
kubectl create secret docker-registry docker-auth \
  --docker-server reg.zxf.org \
  --docker-username admin \
  --docker-password 123 \
  --docker-email timinglee@timinglee.org
secret/docker-auth created

kubectl get secrets docker-auth
NAME          TYPE                             DATA   AGE
docker-auth   kubernetes.io/dockerconfigjson   1      6s
```

`docker-registry` 类型的 Secret 专门用于 Docker 仓库认证,类型是 `kubernetes.io/dockerconfigjson`。内部存储的是 `~/.docker/config.json` 格式的认证信息。

### 4.3 在 Pod 中使用

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
spec:
  containers:
  - image: reg.zxf.org/zxf/myapp:v1
    name: myapp
  imagePullSecrets:                      # 关键:引用认证 Secret
  - name: docker-auth
```

```bash
kubectl apply -f testpod.yml
kubectl get pods
NAME    READY   STATUS    RESTARTS   AGE
myapp   1/1     Running   0          4s
```

`imagePullSecrets` 字段告诉 kubelet 用哪个 Secret 做 Docker 仓库认证。kubelet 拉镜像时会读取 Secret 中的认证信息,自动 `docker login`。

### 4.4 全局 imagePullSecrets

每个 Pod 都配 `imagePullSecrets` 太繁琐。可以在 ServiceAccount 上配置全局认证:

```bash
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets":[{"name":"docker-auth"}]}'
```

之后所有用 default SA 的 Pod 都会自动带上 docker-auth,不需要在 Pod 里显式声明。

生产环境推荐这种方式——一次配置,全局生效。

## 五、TLS 证书 Secret

### 5.1 创建 TLS Secret

```bash
# 生成证书
openssl req -newkey rsa:2048 \
  -nodes -keyout tls.key \
  -x509 -days 365 \
  -subj "/CN=nginxsvc/O=nginxsvc" \
  -out tls.crt

# 创建 TLS Secret
kubectl create secret tls web-tls-secret \
  --key tls.key \
  --cert tls.crt
secret/web-tls-secret created
```

TLS Secret 的数据结构:
- **`tls.crt`** — 证书
- **`tls.key`** — 私钥

### 5.2 在 Ingress 中使用

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webcluster
spec:
  tls:
  - hosts:
    - myapp1.zxf.org
    secretName: web-tls-secret          # 引用 TLS Secret
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org
    http:
      paths:
      - backend:
          service:
            name: myapp1
            port:
              number: 80
        path: /
        pathType: Prefix
```

Ingress Controller 从 Secret 读取证书和私钥,配置 HTTPS 监听。这种"证书集中管理"的方式让证书轮换只需要更新 Secret,不需要改 Ingress 配置。

## 六、Secret 的安全加固

### 6.1 etcd 加密静态存储

默认情况下,Secret 在 etcd 中是 base64 编码存储,能直接解码。生产环境必须开启 **etcd 加密**:

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - aescbc:
      keys:
      - name: key1
        secret: <base64-encoded-32-byte-key>
  - identity: {}
```

配置 API Server 使用该加密配置:
```bash
kube-apiserver \
  --encryption-provider-config=/etc/kubernetes/encryption-config.yaml
```

之后新创建的 Secret 会用 AES-CBC 加密存储,即使 etcd 备份泄露也无法解密。

### 6.2 RBAC 权限控制

```yaml
# 限制 Secret 读取权限
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: secret-reader
  namespace: production
rules:
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["app-tls-secret"]      # 只允许读特定 Secret
  verbs: ["get"]
```

生产环境:
- **默认禁止读 Secret** — 应用 SA 不给 Secret 读取权限
- **按需授权** — 只允许特定应用读特定 Secret
- **审计日志** — 开启审计,记录所有 Secret 访问

### 6.3 外部密钥管理

对于高安全要求场景,Secret 仍然不够安全(因为它存在 etcd)。推荐用外部密钥管理服务:

**1. HashiCorp Vault**  
独立的密钥管理系统,K8s 通过 Vault Agent 或 CSI Driver 注入密钥。密钥不存 etcd,审计完善。

**2. 云厂商 KMS**  
AWS KMS、阿里云 KMS、Azure Key Vault。用 External Secrets Operator 同步到 K8s Secret。

**3. Sealed Secrets**  
Bitnami 开源工具,把 Secret 加密成"只能由集群内 controller 解密"的 SealedSecret,可以安全存 Git。

## 七、Secret 的工程化实践

### 7.1 命名规范

```yaml
metadata:
  name: user-service-db-secret           # 应用-用途-secret
  namespace: production
  labels:
    app: user-service
    type: database-credentials
```

### 7.2 环境隔离

```bash
# dev 环境
kubectl create secret generic db-secret \
  --from-literal=password=devpass123 \
  -n dev

# prod 环境
kubectl create secret generic db-secret \
  --from-literal=password=Pro$tr0ngP@ss \
  -n prod
```

不同命名空间用不同 Secret,密码强度也不同。dev 环境用弱密码方便测试,prod 用强密码保证安全。

### 7.3 密钥轮换

定期轮换密钥是安全最佳实践:

```bash
# 1. 生成新密码
NEW_PASSWORD=$(openssl rand -base64 24)

# 2. 更新 Secret
kubectl create secret generic db-secret \
  --from-literal=password=$NEW_PASSWORD \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. 滚动重启应用(让新密码生效)
kubectl rollout restart deployment/user-service
```

自动化轮换可以用 External Secrets Operator + Vault,实现 90 天自动轮换。

### 7.4 CI/CD 中的密钥管理

```yaml
# .gitlab-ci.yml
deploy:
  script:
    # 从 CI/CD 变量读取密码(不在代码里)
    - kubectl create secret generic db-secret
        --from-literal=password=$DB_PASSWORD
        --dry-run=client -o yaml | kubectl apply -f -
```

CI/CD 变量在 GitLab/GitHub 后台配置,不会出现在代码里。部署时注入到 K8s Secret,实现"密钥不进代码库"。

## 八、Secret 的常见陷阱

### 8.1 Base64 不是加密

```bash
# 任何人都能解码
kubectl get secret db-secret -o yaml | yq '.data.password' | base64 -d
```

Secret 的 base64 只是编码,不是加密。生产环境必须开启 etcd 加密或用外部密钥管理。

### 8.2 Secret 在日志中泄露

```bash
# 错误示范:命令行参数泄露
kubectl create secret generic my-secret --from-literal=password=Pro$tr0ng
# 这条命令会出现在 shell history 和审计日志里

# 正确做法:用文件
echo -n 'Pro$tr0ng' > password
kubectl create secret generic my-secret --from-file=password
rm password
```

### 8.3 Secret 更新不生效

修改 Secret 后,作为环境变量注入的不会自动更新(环境变量是启动时读取的)。需要重启 Pod:

```bash
kubectl rollout restart deployment/myapp
```

作为数据卷挂载的会热更新(约 10-60 秒),但应用是否读取新值取决于应用实现。

### 8.4 Secret 大小限制

单个 Secret 最大 **1MB**。大型 TLS 证书链或大量密钥可能超限,需要拆分或用外部存储。

## 九、Secret 的工程哲学

Secret 是 K8s 处理敏感数据的核心机制,但它的安全模型是分层的:

1. **第一层:RBAC** — 控制谁能访问 Secret
2. **第二层:etcd 加密** — 即使 etcd 泄露,数据也是加密的
3. **第三层:外部密钥管理** — 高安全场景用 Vault/KMS,密钥不进 K8s

这三层叠加,构成了完整的密钥安全体系。但最重要的还是第一层——**RBAC 配置不当,任何加密都没用**。

在电商项目里,我们的密钥管理流程:
- **开发环境** — 用 K8s Secret,密码简单,方便测试
- **预发环境** — 用 K8s Secret + etcd 加密,密码强度中等
- **生产环境** — 用 Vault + External Secrets Operator,密钥不进 K8s,90 天自动轮换

这种分层策略平衡了安全性和便利性,是生产环境的推荐做法。

> Secret 不是"加密的 ConfigMap",它是 K8s 密钥管理的起点。真正的安全需要 RBAC + etcd 加密 + 外部密钥管理的多层防护,Secret 只是其中一环。
