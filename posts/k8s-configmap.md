# K8s ConfigMap:配置管理的工程化实践

> 应用配置和代码分离是十二要素应用的核心原则。ConfigMap 是 K8s 实现这一原则的关键资源——把配置数据存在 etcd,通过环境变量或数据卷注入 Pod。这篇记录 ConfigMap 的四种创建方式和三种使用模式,以及生产环境的配置治理实践。

## 一、为什么需要 ConfigMap

### 1.1 配置即代码的问题

传统部署方式经常把配置硬编码在镜像里:
- 数据库连接字符串写在 application.properties
- Nginx 配置文件打包进镜像
- 环境变量写死在启动脚本

这种方式的问题:
- **环境不可变** — 改配置要重新构建镜像,测试环境和生产环境用不同镜像,违反"一次构建到处部署"
- **配置泄露风险** — 数据库密码、API Key 等敏感信息打进镜像,镜像仓库被攻破就泄露
- **多环境管理混乱** — dev/test/prod 环境配置散落在不同镜像,维护成本高

### 1.2 ConfigMap 的解决方案

ConfigMap 把配置数据从镜像中分离出来:
- **配置存 K8s** — ConfigMap 资源存在 etcd,与镜像解耦
- **运行时注入** — Pod 启动时通过环境变量或数据卷读取配置
- **同一镜像多环境** — dev/test/prod 用同一镜像,挂不同 ConfigMap

这种"镜像 + 配置"的分离模式,是云原生应用的标准实践。

## 二、ConfigMap 的四种创建方式

### 2.1 通过字面量创建(--from-literal)

```bash
kubectl create cm timinglee \
  --from-literal fname=timing \
  --from-literal lname=lee
configmap/timinglee created

kubectl describe cm timinglee
Name:         timinglee
Data
====
fname:
----
timing

lname:
----
lee
```

`--from-literal` 直接在命令行指定键值对,适合少量配置。每个 `--from-literal` 一个键值对,可以多个一起用。

适用场景:快速测试、少量配置项(如数据库端口、环境标识)。

### 2.2 通过文件创建(--from-file)

```bash
echo hello zxf > zxf
kubectl create cm zxf2 --from-file zxf
configmap/zxf2 created

kubectl describe cm zxf2
Name:         zxf2
Data
====
zxf:
----
hello zxf
```

`--from-file` 把文件内容存为 ConfigMap 的一个键,键名默认是文件名,值是文件内容。

适用场景:Nginx 配置文件、Application.properties 等单文件配置。

如果想自定义键名:
```bash
kubectl create cm zxf2 --from-file=myconfig=zxf
# 键名变成 myconfig,而不是文件名 zxf
```

### 2.3 通过目录创建(--from-file <dir>)

```bash
mkdir test
echo zxf > test/tfile
echo xf > test/lfile
kubectl create cm zxf3 --from-file test/
configmap/zxf3 created

kubectl describe cm zxf3
Name:         zxf3
Data
====
lfile:
----
xf

tfile:
----
zxf
```

`--from-file` 指定目录时,目录下每个文件都变成 ConfigMap 的一个键,键名是文件名,值是文件内容。

适用场景:多文件配置(如 Nginx 的 conf.d 目录、多个 .properties 文件)。

### 2.4 通过 YAML 文件创建

```bash
# 用 --dry-run 生成模板
kubectl create cm zxf4 --from-literal zxf=abc --dry-run=client -o yaml > zxf4.yaml
```

```yaml
# zxf4.yaml
apiVersion: v1
data:
  zxf: abc
  xf: def
kind: ConfigMap
metadata:
  name: zxf4
```

```bash
kubectl apply -f zxf4.yaml
```

YAML 方式是最推荐的生产环境做法:
- **可版本控制** — YAML 文件进 Git,变更可追溯
- **可复用** — 同一 YAML 可部署到不同集群
- **可审查** — PR 审查时能看到配置变更

## 三、ConfigMap 的三种使用模式

### 3.1 作为环境变量注入(单个键)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: zxf
data:
  ipaddress: "172.25.254.50"
  port: "3306"
```

```yaml
# testpod.yml
apiVersion: v1
kind: Pod
metadata:
  name: testpod
spec:
  containers:
  - image: busybox
    name: testpod
    command:
    - /bin/sh
    - -c
    - env
    env:
    - name: key1                        # 环境变量名
      valueFrom:
        configMapKeyRef:
          name: zxf                     # ConfigMap 名
          key: ipaddress                # ConfigMap 中的键
    - name: key2
      valueFrom:
        configMapKeyRef:
          name: zxf
          key: port
  restartPolicy: Never
```

```bash
kubectl apply -f testpod.yml
kubectl logs pods/testpod
...
key1=172.25.254.50
key2=3306
...
```

`env[].valueFrom.configMapKeyRef` 把 ConfigMap 的某个键映射为环境变量。这种方式适合少量配置项,可以精确控制每个环境变量的来源。

### 3.2 作为环境变量注入(全部键)

```yaml
# testpod.yml
apiVersion: v1
kind: Pod
metadata:
  name: testpod
spec:
  containers:
  - image: busyboxplus
    name: testpod
    command:
    - /bin/sh
    - -c
    - env
    envFrom:                            # 用 envFrom 而不是 env
    - configMapRef:
        name: zxf                       # ConfigMap 名
  restartPolicy: Never
```

```bash
kubectl apply -f testpod.yml
kubectl logs pods/testpod
...
port=3306
ipaddress=172.25.254.50
...
```

`envFrom` 把 ConfigMap 的所有键值对都注入为环境变量,变量名就是键名。这种方式适合配置项多、且环境变量名与 ConfigMap 键名一致的场景。

注意:如果 ConfigMap 键名不符合环境变量命名规范(如 `my.key`),会被自动转换(`MY_KEY`)或忽略。

### 3.3 作为数据卷挂载

```yaml
# testpod.yml
apiVersion: v1
kind: Pod
metadata:
  name: testpod
spec:
  containers:
  - image: busyboxplus
    name: testpod
    command:
    - /bin/sh
    - -c
    - sleep 100000
    volumeMounts:
    - name: config-volume
      mountPath: /config                # 挂载到容器的 /config 目录
  volumes:
  - name: config-volume
    configMap:
      name: zxf                         # ConfigMap 名
  restartPolicy: Never
```

```bash
kubectl apply -f testpod.yml
kubectl exec -it pods/testpod -- /bin/sh
/ # ls /config/
ipaddress  port
/ # cat /config/port
3306
/ # cat /config/ipaddress
172.25.254.50
```

ConfigMap 的每个键变成挂载目录下的一个文件,文件名是键名,文件内容是键值。这种方式适合:
- 配置文件(如 nginx.conf、application.yml)
- 多个配置项需要按文件组织
- 应用只支持文件配置,不支持环境变量

## 四、ConfigMap 配置 Nginx 实战

### 4.1 创建 Nginx 配置文件 ConfigMap

```bash
# nginx.conf
cat > nginx.conf << EOF
server {
  listen 8000;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
}
EOF

kubectl create cm nginx --from-file nginx.conf
```

### 4.2 Pod 挂载 ConfigMap 替换默认配置

```yaml
# testpod.yml
apiVersion: v1
kind: Pod
metadata:
  name: nginx
spec:
  containers:
  - image: nginx:1.23
    name: nginx
    volumeMounts:
    - name: config-volume
      mountPath: /etc/nginx/conf.d      # 覆盖默认配置目录
  volumes:
  - name: config-volume
    configMap:
      name: nginx
  restartPolicy: Never
```

```bash
kubectl apply -f testpod.yml
kubectl get pods -o wide
NAME    READY   STATUS    RESTARTS   AGE   IP           NODE
nginx   1/1     Running   0          12s   10.244.2.8   k8s-node2

# 测试,Nginx 监听 8000 端口
curl 10.244.2.8:8000
<!DOCTYPE html>
<html>
<head><title>Welcome to nginx!</title></head>
...
```

成功!ConfigMap 里的 nginx.conf 覆盖了镜像默认的 `/etc/nginx/conf.d/` 目录,Nginx 按我们的配置监听 8000 端口。

### 4.3 修改 ConfigMap 更新配置

```bash
kubectl edit cm nginx
# 把 listen 8000 改成 listen 8080
```

ConfigMap 修改后,**已运行的 Pod 不会自动更新**(配置文件是挂载时读取的)。需要重建 Pod:

```bash
kubectl delete -f testpod.yml
kubectl apply -f testpod.yml

curl 10.244.2.9:8080    # 新 Pod 监听 8080
```

### 4.4 热更新机制

ConfigMap 挂载为数据卷时,支持**热更新**——修改 ConfigMap 后,挂载目录下的文件会自动更新(约 10-60 秒延迟)。

但应用是否读取新配置取决于应用本身:
- **Nginx** — 需要reload才生效(`nginx -s reload`),不会自动读新配置
- **Spring Boot** — 默认不热加载,需要 Spring Cloud Kubernetes 等插件
- **自定义应用** — 需要监听文件变化,主动重新加载

生产环境的配置更新流程:
1. 修改 ConfigMap(`kubectl apply -f` 或 `kubectl edit`)
2. 等待热更新传播到所有 Pod(约 1 分钟)
3. 触发应用 reload(滚动重启或发送信号)

## 五、ConfigMap 的工程化实践

### 5.1 命名规范

```yaml
metadata:
  name: user-service-prod-config       # 应用-环境-用途
  namespace: production
  labels:
    app: user-service
    environment: production
```

清晰的命名规范让配置管理更高效:
- **应用名** — `user-service`、`order-service`
- **环境标识** — `prod`、`staging`、`dev`
- **用途** — `config`、`nginx`、`logging`

### 5.2 多环境配置管理

```
config-repo/
├── base/                          # 基础配置(所有环境共享)
│   ├── nginx.conf
│   └── application.yml
├── overlays/
│   ├── dev/                       # 开发环境覆盖
│   │   └── application.yml
│   ├── staging/                   # 预发环境覆盖
│   │   └── application.yml
│   └── prod/                      # 生产环境覆盖
│       └── application.yml
```

用 Kustomize 管理多环境配置——base 是公共配置,overlays 是环境特定覆盖。部署时:
```bash
kubectl apply -k config-repo/overlays/prod
```

### 5.3 配置版本控制

所有 ConfigMap YAML 进 Git:
```bash
git add config-repo/
git commit -m "Update database connection pool config"
git push
```

CI/CD 流水线自动同步到集群:
```groovy
stage('Deploy Config') {
  steps {
    sh 'kubectl apply -k config-repo/overlays/prod'
  }
}
```

这种"配置即代码"的方式让配置变更可追溯、可审查、可回滚。

### 5.4 配置验证

部署前验证 ConfigMap 格式:
```bash
# 验证 YAML 语法
kubectl apply --dry-run=client -f config.yml

# 验证配置内容
kubectl get cm user-service-prod-config -o yaml | yq '.data'
```

生产环境推荐用 Schema 验证工具(如 CUE、JsonSchema),确保配置符合预期格式。

## 六、ConfigMap 的限制与注意事项

### 6.1 大小限制

单个 ConfigMap 最大 **1MB**。如果配置文件超过 1MB(如大型 JSON 规则文件),需要:
- 拆分为多个 ConfigMap
- 用 PV/PVC 挂载外部存储
- 用 Init Container 从对象存储下载

### 6.2 敏感数据不能用 ConfigMap

ConfigMap 数据是明文存储的(任何能 `kubectl get cm` 的人都能看到)。敏感数据(密码、密钥、证书)必须用 **Secret**,而不是 ConfigMap。

### 6.3 不可变 ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
immutable: true                        # 标记为不可变
data:
  key: value
```

`immutable: true` 后,ConfigMap 不能被修改,只能删除重建。好处:
- **性能优化** — kubelet 不需要 watch 变化,减少 API Server 压力
- **安全** — 防止误修改,强制通过删除重建的方式更新

生产环境对稳定配置建议开启 immutable。

### 6.4 ConfigMap 更新不会自动重启 Pod

修改 ConfigMap 后,已运行的 Pod 不会自动重启(除非用 Reloader 等工具)。解决方案:
- **手动滚动重启** — `kubectl rollout restart deployment/myapp`
- **Reloader 工具** — 监听 ConfigMap 变化,自动触发 Deployment 滚动更新
- **应用层热加载** — 应用监听文件变化,主动重新加载配置

## 七、ConfigMap 与十二要素应用

十二要素应用(12-Factor App)的第三条:**配置存储在环境变量中**。

ConfigMap 完美契合这一原则:
- **配置与代码分离** — ConfigMap 在 K8s,代码在镜像
- **环境变量注入** — `envFrom` 把配置注入环境变量
- **多环境差异** — 同一镜像 + 不同 ConfigMap = 不同环境

但 ConfigMap 比纯环境变量更强大:
- **支持文件挂载** — 适合复杂配置(Nginx、Logstash)
- **支持热更新** — 不需要重启 Pod 就能更新配置
- **支持版本控制** — YAML 文件进 Git

这种灵活性让 ConfigMap 成为 K8s 配置管理的核心工具。下一篇我会讲 Secret,它和 ConfigMap 用法类似,但专门用于敏感数据。

> ConfigMap 是"配置即代码"在 K8s 的落地。把配置从镜像中解放出来,让应用真正实现"一次构建,到处部署",这是云原生应用的基本素养。
