# Prometheus 监控体系:从 Helm 部署到应用监控

> 监控是运维的眼睛——没有监控,故障发现靠用户投诉,排查靠猜。Prometheus 是云原生时代的事实标准监控方案,这篇记录用 Helm 部署 kube-prometheus-stack 监控栈,以及如何接入应用监控。

## 一、为什么选择 Prometheus

### 1.1 监控的需求

生产环境监控要回答四个问题:
- **什么时候出问题** — 告警(Alert)
- **出了什么问题** — 指标(Metrics)
- **问题在哪里** — 日志(Logs)
- **怎么发生的** — 追踪(Traces)

Prometheus 专注解决前两个——指标采集和告警。配合 Grafana(可视化)、Loki(日志)、Jaeger(追踪),构成完整的可观测性体系。

### 1.2 Prometheus 的核心概念

- **Metric** — 指标,带标签的时间序列数据(如 `http_requests_total{method="GET",status="200"}`)
- **Exporter** — 采集器,把系统指标暴露成 Prometheus 格式(如 node-exporter 采集主机指标)
- **PromQL** — Prometheus 查询语言,类似 SQL 但专门用于时序数据
- **Alertmanager** — 告警组件,接收 Prometheus 的告警,去重、分组、路由到通知渠道
- **Grafana** — 可视化面板,用 Prometheus 数据源画图表

### 1.3 kube-prometheus-stack

`kube-prometheus-stack` 是社区维护的"全家桶" Chart,包含:
- **Prometheus** — 指标采集与存储
- **Alertmanager** — 告警管理
- **Grafana** — 可视化面板
- **Node Exporter** — 主机指标采集
- **Kube State Metrics** — K8s 资源状态指标
- **Prometheus Operator** — 简化 Prometheus 部署管理

一个 Chart 部署完整的监控体系,这就是 Helm 的价值。

## 二、Helm 部署 kube-prometheus-stack

### 2.1 添加 Helm 仓库

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
"prometheus-community" has been added to your repositories

helm repo update
```

### 2.2 拉取 Chart 并修改配置

```bash
# 拉取 Chart
helm pull prometheus-community/kube-prometheus-stack
tar zxf kube-prometheus-stack-84.1.0.tgz
cd kube-prometheus-stack/
```

修改 `values.yaml` 中的镜像地址为私有仓库:

```yaml
# values.yaml 关键配置
global:
  imageRegistry: "reg.zxf.org"      # 全局镜像仓库

# 各组件的镜像配置
prometheus:
  image:
    registry: reg.zxf.org
    repository: prometheus/prometheus
    tag: v3.11.2

alertmanager:
  image:
    registry: reg.zxf.org
    repository: prometheus/alertmanager
    tag: v0.32.0

grafana:
  image:
    registry: reg.zxf.org
    repository: grafana/grafana
    tag: 10.x.x

kube-state-metrics:
  image:
    registry: reg.zxf.org
    repository: kube-state-metrics/kube-state-metrics

prometheus-node-exporter:
  image:
    registry: reg.zxf.org
    repository: prometheus/node-exporter
```

国内环境必须把镜像地址改成私有 Harbor 仓库,否则拉取官方镜像会超时。

### 2.3 准备镜像

```bash
# 解压镜像包
tar zxf prometheus-images.tar.gz

# 导入所有镜像
for img in *.tar; do
  docker load -i $img
done

# 重新打 tag 并推送到 Harbor
# 例如:registry.k8s.io/kube-state-metrics/kube-state-metrics
docker tag registry.k8s.io/kube-state-metrics/kube-state-metrics \
  reg.zxf.org/kube-state-metrics/kube-state-metrics
docker push reg.zxf.org/kube-state-metrics/kube-state-metrics
```

所有依赖镜像都要上传到 Harbor 的对应项目,否则 Pod 拉镜像失败。

### 2.4 安装 Chart

```bash
# 创建命名空间
kubectl create namespace kube-prometheus-stack

# 安装
helm -n kube-prometheus-stack install kube-prometheus-stack \
  /mnt/kube-prometheus-stack
NAME: kube-prometheus-stack
NAMESPACE: kube-prometheus-stack
STATUS: deployed
REVISION: 1
```

### 2.5 验证部署

```bash
kubectl get pods -n kube-prometheus-stack
NAME                                                        READY   STATUS    AGE
alertmanager-kube-prometheus-stack-alertmanager-0           2/2     Running   150m
kube-prometheus-stack-grafana-7f46fdb68c-m2gtk              3/3     Running   150m
kube-prometheus-stack-kube-state-metrics-54899f6d8c-qfl7d   1/1     Running   150m
kube-prometheus-stack-operator-67d44488c4-229tn             1/1     Running   150m
kube-prometheus-stack-prometheus-node-exporter-4stw9        1/1     Running   150m
prometheus-kube-prometheus-stack-prometheus-0               2/2     Running   150m
```

所有组件 Running,监控栈部署成功!

```bash
kubectl get svc -n kube-prometheus-stack
NAME                                             TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)
kube-prometheus-stack-grafana                    LoadBalancer   10.110.74.57    172.25.254.60   80:31639/TCP
kube-prometheus-stack-prometheus                 LoadBalancer   10.110.131.79   172.25.254.61   9090:32427/TCP
kube-prometheus-stack-alertmanager               ClusterIP      10.99.255.90    <none>          9093/TCP
kube-prometheus-stack-kube-state-metrics         ClusterIP      10.98.163.197   <none>          8080/TCP
kube-prometheus-stack-prometheus-node-exporter   ClusterIP      10.111.30.89    <none>          9100/TCP
```

Grafana 和 Prometheus 是 LoadBalancer 类型,分配了外部 IP,可以直接访问。

## 三、访问 Grafana 与 Prometheus

### 3.1 修改 Service 类型为 LoadBalancer

```bash
# 修改 Grafana Service
kubectl edit -n kube-prometheus-stack svc kube-prometheus-stack-grafana
# 把 type: ClusterIP 改成 type: LoadBalancer

# 修改 Prometheus Service
kubectl edit -n kube-prometheus-stack svc kube-prometheus-stack-prometheus
# 把 type: ClusterIP 改成 type: LoadBalancer
```

LoadBalancer 类型会通过 MetalLB 分配外部 IP,可以直接访问。

### 3.2 获取 Grafana 密码

```bash
kubectl -n kube-prometheus-stack get secrets kube-prometheus-stack-grafana -o yaml
apiVersion: v1
data:
  admin-password: U0RGVEFwUUg1OVlTOTdJTHZtbE1SU012cFF3MDlhakdaMkNzSWYzNA==
  admin-user: YWRtaW4=
kind: Secret
...
```

解码:

```bash
echo -n "YWRtaW4=" | base64 -d
admin

echo -n "U0RGVEFwUUg1OVlTOTdJTHZtbE1SU012cFF3MDlhakdaMkNzSWYzNA==" | base64 -d
SDFTApQH59YS97ILvmlMRSMvpQw09ajGZ2CsIf34
```

用户名 `admin`,密码是随机生成的字符串。

### 3.3 登录 Grafana

浏览器访问 `http://172.25.254.60`(Grafana 的 External IP),输入用户名密码。

登录后会看到 kube-prometheus-stack 预置的 Dashboard:
- **集群概览** — 节点数、Pod 数、CPU/内存使用率
- **节点详情** — 每个节点的 CPU、内存、磁盘、网络
- **Pod 详情** — 每个 Pod 的资源使用、重启次数
- **API Server** — K8s API Server 的请求量、延迟、错误率

这些 Dashboard 开箱即用,不需要自己配置。

### 3.4 访问 Prometheus

浏览器访问 `http://172.25.254.61:9090`(Prometheus 的 External IP)。

Prometheus 自带的查询界面,可以用 PromQL 查询指标:

```promql
# 查询所有节点的 CPU 使用率
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# 查询 Pod 内存使用
container_memory_working_set_bytes{container!=""}

# 查询 HTTP 请求率
rate(http_requests_total[1m])
```

## 四、应用监控接入

### 4.1 应用暴露指标

应用要被 Prometheus 监控,必须暴露 `/metrics` 端点,输出 Prometheus 格式的指标:

```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 1234
http_requests_total{method="POST",status="500"} 5

# HELP http_request_duration_seconds HTTP request duration
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.1"} 1000
http_request_duration_seconds_bucket{le="0.5"} 1200
http_request_duration_seconds_bucket{le="1.0"} 1250
```

很多语言有 Prometheus 客户端库:
- **Java** — `io.prometheus:simpleclient`
- **Python** — `prometheus-client`
- **Go** — `github.com/prometheus/client_golang`
- **Node.js** — `prom-client`

### 4.2 ServiceMonitor 配置

kube-prometheus-stack 用 `ServiceMonitor` 资源自动发现应用:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: myapp-monitor
  namespace: kube-prometheus-stack
  labels:
    release: kube-prometheus-stack      # 必须匹配 release 名
spec:
  selector:
    matchLabels:
      app: myapp                         # 选择有 app=myapp 标签的 Service
  namespaceSelector:
    matchNames:
    - default                            # 监控 default namespace
  endpoints:
  - port: metrics                        # Service 的 metrics 端口
    interval: 15s                        # 每 15 秒采集一次
    path: /metrics                       # 指标路径
```

ServiceMonitor 告诉 Prometheus:
- 监控哪些 Service(通过 label selector)
- 采集间隔、路径、端口

### 4.3 应用部署示例

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
  labels:
    app: nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:latest
        ports:
        - containerPort: 80
          name: http
        - containerPort: 9113
          name: metrics                  # 指标端口
---
apiVersion: v1
kind: Service
metadata:
  name: nginx
  labels:
    app: nginx                           # 必须有这个 label,ServiceMonitor 才能匹配
spec:
  type: LoadBalancer
  ports:
  - port: 80
    name: http
  - port: 9113
    name: metrics                        # 指标端口
  selector:
    app: nginx
```

```bash
helm install nginx .
kubectl get svc
NAME    TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)
nginx   LoadBalancer   10.99.190.145   172.25.254.62   80:32694/TCP,443:31003/TCP,9113:30131/TCP
```

Service 暴露了 9113 端口(metrics),Prometheus 通过这个端口采集 Nginx 指标。

### 4.4 在 Grafana 查看应用指标

应用接入后,在 Grafana 可以:
- 创建自定义 Dashboard
- 用 PromQL 查询应用指标
- 配置告警规则

## 五、PromQL 实战

### 5.1 基础查询

```promql
# 查询当前所有 Pod 的 CPU 使用率
rate(container_cpu_usage_seconds_total{container!=""}[5m])

# 查询节点的内存使用率
(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100

# 查询 K8s 部署的副本数
kube_deployment_status_replicas
```

### 5.2 聚合查询

```promql
# 按节点聚合 CPU 使用率
sum by (node) (rate(container_cpu_usage_seconds_total[5m]))

# 按 namespace 统计 Pod 数量
count by (namespace) (kube_pod_info)

# 计算集群总内存使用
sum(container_memory_working_set_bytes{container!=""})
```

### 5.3 告警规则

```yaml
# PrometheusRule 资源
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: my-alerts
  namespace: kube-prometheus-stack
spec:
  groups:
  - name: my-app
    rules:
    - alert: HighCPUUsage
      expr: |
        rate(container_cpu_usage_seconds_total[5m]) > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "CPU 使用率超过 80%"
        description: "Pod {{ $labels.pod }} CPU 使用率: {{ $value }}"
    
    - alert: PodCrashLooping
      expr: |
        rate(kube_pod_container_status_restarts_total[5m]) > 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Pod 频繁重启"
```

关键字段:
- **`expr`** — PromQL 表达式,满足条件触发告警
- **`for: 5m`** — 持续 5 分钟才告警,避免瞬时抖动
- **`severity`** — 告警级别(warning/critical)
- **`annotations`** — 告警详情,支持模板变量

## 六、Alertmanager 告警通知

### 6.1 配置通知渠道

Alertmanager 支持多种通知渠道:邮件、Slack、钉钉、企业微信、PagerDuty 等。

```yaml
# Alertmanager 配置
alerting:
  alertmanagers:
  - static_configs:
    - targets:
      - alertmanager:9093

# 通知配置
receivers:
- name: dingtalk
  webhook_configs:
  - url: "https://oapi.dingtalk.com/robot/send?access_token=xxx"
    send_resolved: true
- name: email
  email_configs:
  - to: ops@example.com
    from: alert@example.com
    smarthost: smtp.example.com:587
```

### 6.2 告警路由

```yaml
route:
  group_by: ['alertname', 'namespace']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: dingtalk
  routes:
  - match:
      severity: critical
    receiver: pagerduty              # critical 告警发 PagerDuty
  - match:
      severity: warning
    receiver: dingtalk               # warning 告警发钉钉
```

告警路由规则:
- **group_by** — 按告警名和 namespace 分组
- **group_wait** — 首次告警等待 30 秒(同组告警合并)
- **repeat_interval** — 重复告警间隔 4 小时
- **routes** — 按严重级别路由到不同渠道

## 七、监控的工程化实践

### 7.1 监控分层

生产环境监控应该分层:

**1. 基础设施层**
- 节点 CPU、内存、磁盘、网络
- K8s 控制面组件健康
- etcd 性能

**2. 中间件层**
- 数据库连接数、慢查询
- Redis 命中率、内存使用
- 消息队列积压

**3. 应用层**
- HTTP 请求量、错误率、响应时间
- 业务指标(订单量、用户数)
- JVM GC、线程池

**4. 业务层**
- 核心业务转化率
- 用户活跃度
- 收入指标

### 7.2 RED 方法

监控 HTTP 服务的 RED 方法:
- **Rate** — 请求速率(QPS)
- **Errors** — 错误率
- **Duration** — 响应时间分布(P50/P95/P99)

```promql
# Rate
rate(http_requests_total[1m])

# Errors
rate(http_requests_total{status=~"5.."}[1m]) / rate(http_requests_total[1m])

# Duration P99
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))
```

RED 是微服务监控的最小集,每个服务都应该有这三个指标。

### 7.3 USE 方法

监控资源使用的 USE 方法:
- **Utilization** — 使用率(CPU、内存、磁盘)
- **Saturation** — 饱和度(队列长度、连接数)
- **Errors** — 错误(丢包、重传)

USE 适用于基础设施监控,与 RED 互补。

## 八、监控的常见陷阱

### 8.1 指标爆炸

```yaml
# 错误:每个用户 ID 都做 label
http_requests_total{user_id="123"} 1
http_requests_total{user_id="124"} 1
http_requests_total{user_id="125"} 1
```

label 值的基数(cardinality)爆炸会导致 Prometheus 内存爆炸。规则:
- **label 值不要无限增长** — 不要用 user_id、request_id 做 label
- **label 值有限** — 如 method(GET/POST)、status(200/404/500)

### 8.2 告警风暴

告警太多会导致"狼来了"效应,真正重要的告警被淹没。对策:
- **告警分级** — critical/warning/info,只 critical 才打扰人
- **告警聚合** — 同类告警合并,Alertmanager 的 group_by
- **抑制规则** — 节点挂了,Pod 告警抑制(节点恢复 Pod 自然恢复)

### 8.3 没有黄金信号

Google SRE 的"四个黄金信号":
- **延迟(Latency)** — 响应时间
- **流量(Traffic)** — 请求量
- **错误(Errors)** — 错误率
- **饱和度(Saturation)** — 资源使用率

每个服务必须监控这四个信号,缺一不可。

## 九、监控的工程哲学

监控不是"装个 Prometheus 就完事",它是一套完整的工程体系:

1. **可观测性优先** — 没有监控的服务不要上生产
2. **分层监控** — 基础设施、中间件、应用、业务,层层覆盖
3. **告警精炼** — 告警要少而准,每个告警都要有人响应
4. **SLO 驱动** — 用 SLO(服务等级目标)量化可用性,而非靠感觉

在电商项目里,我们的监控体系:
- **kube-prometheus-stack** — 集群监控
- **应用自定义指标** — 每个服务暴露 RED 指标
- **Grafana Dashboard** — 按团队、按服务组织
- **钉钉告警** — critical 级别即时通知,warning 级别汇总日报
- **SLO 看板** — 每个核心服务有可用性 SLO,每周 review

这套体系让我们在故障发生时,1 分钟内告警,5 分钟内定位,30 分钟内恢复——这是监控的真正价值。

> 监控不是"看数据",是"知道系统在发生什么"。好的监控让你在用户感知问题前就发现并解决,这是 SRE 的核心能力。
