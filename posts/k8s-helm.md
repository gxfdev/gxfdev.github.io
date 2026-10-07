# Helm:K8s 应用包管理的工程化实践

> 手动管理一堆 YAML 文件部署复杂应用(如 Prometheus、Grafana)效率低下且容易出错。Helm 是 K8s 的包管理工具,把一组 YAML 模板化、参数化、版本化,实现"一键部署复杂应用"。这篇记录 Helm 的部署、Chart 构建、仓库管理的完整实践。

## 一、为什么需要 Helm

### 1.1 裸 YAML 部署的痛点

部署一个 Prometheus 监控栈,需要:
- Prometheus Deployment + Service + ConfigMap
- Alertmanager Deployment + Service + ConfigMap
- Grafana Deployment + Service + Secret
- Node Exporter DaemonSet
- Kube State Metrics Deployment
- 各种 RBAC 配置

总共 20+ 个 YAML 文件,互相依赖。手动部署的痛点:
- **配置分散** — 20 个文件改 20 次(改 namespace、改镜像地址、改存储)
- **版本管理混乱** — 升级时哪些文件变了?回滚到哪个版本?
- **无法复用** — 同一应用部署到 dev/test/prod,每个环境都要复制一份 YAML
- **依赖管理缺失** — 应用 A 依赖应用 B,手动管理部署顺序

### 1.2 Helm 的解决方案

Helm 把一组 K8s 资源打包成 **Chart**,实现:
- **模板化** — YAML 用 Go template 语法,支持变量、条件、循环
- **参数化** — 用 `values.yaml` 配置参数,同一 Chart 部署到不同环境
- **版本化** — 每次 release 有版本号,支持回滚
- **依赖管理** — Chart 可以声明依赖其他 Chart
- **仓库分发** — Chart 推送到仓库,团队共享

类比:Helm 之于 K8s,就像 apt/yum 之于 Linux,就像 npm 之于 Node.js。

## 二、Helm 部署

### 2.1 安装 Helm

```bash
# 下载
wget https://get.helm.sh/helm-v4.1.3-linux-amd64.tar.gz

# 解压
tar zxf helm-v4.1.3-linux-amd64.tar.gz
cd linux-amd64/
ls
helm  LICENSE  README.md

# 安装
cp -p helm /usr/local/bin/

# 配置 bash 补全
echo "source <(helm completion bash)" >> ~/.bashrc
source ~/.bashrc

# 验证
helm
completion  create  dependency  env  get  help  history  install  lint  list  ...
```

### 2.2 安装 helm-push 插件(用于推送 Chart 到 ChartMuseum)

```bash
# 离线安装 helm-push 插件
tar zxf helm-push_0.11.1.tar.gz

# 验证插件
helm cm-push    # 出现 cm-push 命令说明安装成功
```

`helm-push` 插件用于把本地 Chart 推送到 ChartMuseum 仓库,类似 `docker push` 推送镜像。

## 三、Helm 仓库管理

### 3.1 添加仓库

```bash
# 添加 Bitnami 仓库(主流 Chart 仓库)
helm repo add bitnami https://charts.bitnami.com/bitnami
"bitnami" has been added to your repositories

# 添加阿里云仓库(国内加速)
helm repo add aliyun https://kubernetes.oss-cn-hangzhou.aliyuncs.com/charts

# 查看已添加的仓库
helm repo list
NAME   	URL                                                   
aliyun 	https://kubernetes.oss-cn-hangzhou.aliyuncs.com/charts
bitnami	https://charts.bitnami.com/bitnami                   

# 更新仓库索引
helm repo update
```

### 3.2 搜索 Chart

```bash
# 搜索 nginx 相关的 Chart
helm search repo bitnami/nginx
NAME                            	CHART VERSION	APP VERSION	DESCRIPTION                                       
bitnami/nginx                   	23.0.3       	1.30.0     	NGINX Open Source is a web server that can be a...
bitnami/nginx-ingress-controller	12.0.7       	1.13.1     	NGINX Ingress Controller is an Ingress controll...
bitnami/nginx-intel             	2.1.15       	0.4.9      	DEPRECATED NGINX Open Source for Intel is a lig...
```

`CHART VERSION` 是 Helm Chart 的版本,`APP VERSION` 是应用本身的版本。两者独立,可以分别升级。

### 3.3 拉取 Chart(离线部署)

```bash
# 拉取 Chart 到本地
helm pull bitnami/nginx --version 18.1.11

# 解压
tar zxf nginx-18.1.11.tgz
cd nginx/

# 查看 Chart 结构
ls
charts  Chart.yaml  README.md  templates  values.yaml
```

离线部署场景:先把 Chart 下载到本地,修改 `values.yaml` 后用本地路径安装。

## 四、部署第三方 Chart

### 4.1 修改 values.yaml

```yaml
# nginx/values.yaml(关键配置)
global:
  imageRegistry: "reg.zxf.org"        # 私有仓库地址

image:
  registry: registry-1.docker.io
  repository: library/nginx
  tag: latest
  digest: ""

livenessProbe:
  enabled: false                       # 禁用存活探针(测试环境)
  
readinessProbe:
  enabled: false                       # 禁用就绪探针

containerSecurityContext:
  enabled: false                       # 禁用安全上下文
  runAsUser: 1001
  runAsGroup: 1001
  runAsNonRoot: true
  
containerPorts:
  http: 80
  https: 443
```

`values.yaml` 是 Chart 的配置文件,所有可配置参数都在这里。修改后用 `--set` 或直接编辑文件覆盖默认值。

### 4.2 安装 Chart

```bash
helm install webserver /root/nginx \
  --set global.security.allowInsecureImages=true
NAME: webserver
LAST DEPLOYED: Sun Apr 26 12:28:08 2026
NAMESPACE: default
STATUS: deployed
REVISION: 1
CHART NAME: nginx
CHART VERSION: 18.1.11
APP VERSION: 1.27.1
```

`helm install <release-name> <chart-path>` 安装 Chart:
- **`webserver`** — release 名(同一 Chart 可以安装多个 release)
- **`/root/nginx`** — Chart 路径(本地路径或仓库名)
- **`--set`** — 命令行覆盖参数(优先级高于 values.yaml)

### 4.3 验证部署

```bash
kubectl get svc
NAME              TYPE           CLUSTER-IP       EXTERNAL-IP     PORT(S)                      AGE
webserver-nginx   LoadBalancer   10.110.208.180   172.25.254.60   80:31579/TCP,443:32555/TCP   3m58s

kubectl get pods
NAME                               READY   STATUS    RESTARTS   AGE
webserver-nginx-5f8665b589-4h8jc   1/1     Running   0          4m26s

# 测试访问
curl 172.25.254.60
<!DOCTYPE html>
<html>
<head><title>Welcome to nginx!</title></head>
...
```

一条 `helm install` 命令,自动创建了 Deployment、Service、ConfigMap 等所有资源——这就是 Helm 的价值。

### 4.4 Helm release 管理

```bash
# 查看已安装的 release
helm list
NAME      	NAMESPACE	REVISION	UPDATED                                	STATUS  	CHART           	APP VERSION
webserver 	default  	1       	2026-04-26 12:28:08 +0800 CST         	deployed	nginx-18.1.11   	1.27.1

# 查看 release 状态
helm status webserver
NAME: webserver
...
STATUS: deployed
REVISION: 1

# 升级 release(改 values.yaml 后)
helm upgrade webserver /root/nginx

# 回滚到上一版本
helm rollback webserver 1

# 卸载 release
helm uninstall webserver
```

`REVISION` 是 release 的版本号,每次 upgrade 加 1,可以 rollback 到任意历史版本。

## 五、构建自定义 Chart

### 5.1 创建 Chart 骨架

```bash
mkdir mnt && cd mnt
helm create zxf
Creating zxf

# 查看 Chart 结构
tree zxf
zxf
├── charts/                    # 依赖的其他 Chart
├── Chart.yaml                 # Chart 元数据
├── templates/                 # 模板文件
│   ├── deployment.yaml        # Deployment 模板
│   ├── _helpers.tpl           # 模板辅助函数
│   ├── hpa.yaml               # HPA 模板
│   ├── httproute.yaml         # HTTPRoute 模板
│   ├── ingress.yaml           # Ingress 模板
│   ├── NOTES.txt              # 安装后提示信息
│   ├── serviceaccount.yaml    # SA 模板
│   ├── service.yaml           # Service 模板
│   └── tests/
│       └── test-connection.yaml
└── values.yaml                # 默认配置
```

`helm create` 生成一个完整的 Chart 骨架,包含常用的 K8s 资源模板。

### 5.2 配置 Chart.yaml

```yaml
apiVersion: v2
name: zxf
description: A Helm chart for Kubernetes
type: application               # application 或 library
version: 0.1.0                  # Chart 版本
appVersion: "v1"                # 应用版本
```

关键字段:
- **`apiVersion: v2`** — Helm 3+ 的 Chart 格式
- **`type: application`** — 可部署的应用(application)或可复用的库(library)
- **`version`** — Chart 自身版本,每次修改 Chart 递增
- **`appVersion`** — 包含的应用版本(如 nginx 1.27.1)

### 5.3 配置 values.yaml

```yaml
replicaCount: 2                 # 副本数

image:
  repository: myapp             # 镜像名
  tag: ""                       # 镜像 tag

ingress:
  enabled: true                 # 启用 Ingress
  className: "nginx"            # Ingress Controller
  hosts:
    - host: myappv1.zxf.org     # 域名
      paths:
        - path: /
          pathType: ImplementationSpecific
```

`values.yaml` 定义了所有可配置参数,模板文件通过 `{{ .Values.xxx }}` 引用。

### 5.4 模板文件示例

```yaml
# templates/deployment.yaml(简化版)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "zxf.fullname" . }}
  labels:
    {{- include "zxf.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "zxf.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "zxf.selectorLabels" . | nindent 8 }}
    spec:
      containers:
      - name: {{ .Chart.Name }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        ports:
        - containerPort: 80
```

模板语法:
- **`{{ .Values.replicaCount }}`** — 引用 values.yaml 的值
- **`{{ .Chart.Name }}`** — 引用 Chart.yaml 的值
- **`{{ include "zxf.fullname" . }}`** — 调用 _helpers.tpl 定义的辅助函数
- **`| nindent 4`** — 缩进 4 空格

### 5.5 校验与打包

```bash
# 校验 Chart 语法
helm lint zxf/
==> Linting zxf/
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed

# 打包 Chart
helm package zxf/
Successfully packaged chart and saved it to: /root/mnt/zxf-0.1.0.tgz
```

`helm lint` 检查 Chart 格式是否正确,`helm package` 把 Chart 打成 `.tgz` 包,便于分发。

### 5.6 安装自定义 Chart

```bash
# 用打包后的 tgz 安装
helm install zxf zxf-0.1.0.tgz
NAME: zxf
LAST DEPLOYED: Sun Apr 26 14:49:11 2026
NAMESPACE: default
STATUS: deployed
REVISION: 1
NOTES:
1. Get the application URL by running these commands:
  http://myapp.zxf.org/

# 测试
curl myapp.zxf.org
<!DOCTYPE html>
<html>
<head><title>Welcome to nginx!</title></head>
...
```

成功!自定义 Chart 部署完成。

## 六、Helm 仓库管理

### 6.1 OCI 模式(推荐)

Helm v3+ 支持用 OCI(Open Container Initiative)协议存 Chart,直接用 Harbor 的 OCI 仓库:

```bash
# 登录 Harbor OCI 仓库
helm registry login reg.zxf.org \
  --username admin \
  --password 123 \
  --ca-file /etc/docker/certs.d/reg.zxf.org/ca.crt
Login Succeeded

# 推送 Chart 到 Harbor
helm push zxf-0.1.0.tgz oci://reg.zxf.org/helm-charts
Pushed: reg.zxf.org/helm-charts/zxf:0.1.0
Digest: sha256:7728e21a6b62fc388bfda151c40f0197d68910974d44d08f6f748f306df965e1

# 拉取 Chart
helm pull oci://reg.zxf.org/helm-charts/zxf --version 0.1.0
Pulled: reg.zxf.org/helm-charts/zxf:0.1.0

# 直接安装
helm install zxf oci://reg.zxf.org/helm-charts/zxf --version 0.1.0
NAME: zxf
STATUS: deployed
```

OCI 模式的优势:
- **复用 Docker 仓库** — Harbor 同时存镜像和 Chart
- **签名验证** — 用 cosign 签名 Chart,防篡改
- **统一认证** — Docker 和 Helm 用同一套认证

### 6.2 ChartMuseum 模式(传统)

ChartMuseum 是专门的 Chart 仓库服务,Harbor 内置了 ChartMuseum 支持:

```bash
# 添加 Harbor 的 Chart 仓库
helm repo add zxf https://charts.zxf.org/chartrepo/charts

# 推送 Chart
helm cm-push zxf-0.1.0.tgz zxf -u admin -p 123
Pushing zxf-0.1.0.tgz to zxf...
Done.

# 更新本地索引
helm repo update zxf

# 搜索
helm search repo zxf
NAME   	CHART VERSION	APP VERSION	DESCRIPTION                
zxf/zxf	0.1.0        	v1         	A Helm chart for Kubernetes

# 安装
helm install zxf zxf/zxf
NAME: zxf
STATUS: deployed
```

ChartMuseum 模式用 `helm cm-push` 推送,`helm install <repo>/<chart>` 安装。

## 七、Helm 的工程化实践

### 7.1 Chart 版本管理

```yaml
# Chart.yaml
version: 1.2.3          # Chart 版本(SemVer)
appVersion: "2.4.1"     # 应用版本
```

遵循语义化版本(SemVer):
- **MAJOR** — 不兼容的 API 变更
- **MINOR** — 向后兼容的功能新增
- **PATCH** — 向后兼容的 bug 修复

每次修改 Chart 必须递增 `version`,否则推送仓库会失败。

### 7.2 多环境配置

```bash
chart-repo/
├── Chart.yaml
├── values.yaml              # 基础配置
├── values-dev.yaml          # dev 环境覆盖
├── values-staging.yaml      # staging 环境覆盖
└── values-prod.yaml         # prod 环境覆盖
```

```bash
# 部署到不同环境
helm install myapp ./chart -f values.yaml -f values-dev.yaml
helm install myapp ./chart -f values.yaml -f values-prod.yaml
```

多个 `-f` 文件按顺序覆盖,后面的优先级高。这种"基础配置 + 环境覆盖"的模式,让多环境管理非常清晰。

### 7.3 Chart 依赖管理

```yaml
# Chart.yaml
apiVersion: v2
name: my-app
dependencies:
- name: redis
  version: 17.x.x
  repository: https://charts.bitnami.com/bitnami
  condition: redis.enabled
- name: postgresql
  version: 12.x.x
  repository: https://charts.bitnami.com/bitnami
  condition: postgresql.enabled
```

```bash
# 下载依赖
helm dependency update
```

Chart 可以依赖其他 Chart,`condition` 控制是否启用依赖。适合"应用 + 依赖中间件"的场景。

### 7.4 CI/CD 集成

```yaml
# .gitlab-ci.yml
deploy:
  script:
    # 1. 打包 Chart
    - helm package ./chart -d ./charts
    
    # 2. 推送到 Harbor
    - helm cm-push ./charts/myapp-*.tgz myrepo -u $HARBOR_USER -p $HARBOR_PASS
    
    # 3. 部署到 K8s
    - helm upgrade --install myapp myrepo/myapp \
        -f values-prod.yaml \
        --set image.tag=$CI_COMMIT_SHA
```

CI/CD 流水线自动打包、推送、部署 Chart,实现 GitOps 工作流。

## 八、Helm 的常见陷阱

### 8.1 模板渲染错误

```yaml
# 错误:YAML 缩进与模板混用
spec:
  containers:
  - name: {{ .Chart.Name }}
    image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
{{- if .Values.resources }}
    resources:
{{ toYaml .Values.resources | indent 6 }}
{{- end }}
```

`{{- }}` 的 `-` 表示去除前面的空白,避免空行。`indent 6` 让生成的 YAML 正确缩进。模板渲染错误是 Helm 最常见的问题,需要仔细调试。

### 8.2 release 状态卡在 pending

```bash
helm list -a
NAME    NAMESPACE  REVISION  STATUS     CHART
myapp   default    1         pending    myapp-0.1.0
```

`pending` 状态说明安装中断了。用 `helm uninstall myapp` 清理,然后重新安装。

### 8.3 升级覆盖 values

```bash
# 错误:upgrade 时没传 -f,会用默认 values
helm upgrade myapp ./chart

# 正确:upgrade 时也要传 -f
helm upgrade myapp ./chart -f values-prod.yaml
```

`helm upgrade` 默认用 Chart 的默认 values,之前的 `--set` 或 `-f` 配置会丢失。建议用 `--reuse-values` 复用上次配置,或每次 upgrade 都显式传 `-f`。

## 九、Helm 的工程哲学

Helm 体现了几个核心思想:

1. **配置即代码** — Chart 是模板代码,values 是配置,两者分离
2. **版本化一切** — Chart 版本 + App 版本 + Release 版本,可追溯可回滚
3. **复用与组合** — Chart 依赖机制实现"积木式"应用构建
4. **仓库化分发** — Chart 仓库让团队共享应用模板

在电商项目里,我们用 Helm 管理所有中间件部署:
- **Prometheus 监控栈** — kube-prometheus-stack Chart
- **ELK 日志栈** — elastic/eck-operator Chart
- **应用部署** — 自定义 Chart,包含 Deployment + Service + Ingress + ConfigMap

之前手动部署 Prometheus 要 2 小时,用 Helm 后 5 分钟搞定,而且配置可版本控制、可回滚。这就是包管理工具的价值。

> Helm 不是"YAML 模板引擎",它是"K8s 应用的包管理系统"。理解了 Chart + Release + Repository 的三角关系,才算真正会用 Helm。
