# K8s Canary 金丝雀发布:基于 Header 的灰度发布实战

> 金丝雀发布(Canary Release)是生产环境部署的核心策略——新版本先承接小比例流量,验证无问题后逐步扩大,出问题立即回滚。这篇记录基于 nginx-ingress 的 Header 灰度发布方案,以及金丝雀发布的工程化实践。

## 一、为什么需要金丝雀发布

### 1.1 全量发布的风险

传统的全量发布流程:
1. 旧版本(3 副本)全部销毁
2. 新版本(3 副本)全部创建
3. 流量切到新版本

这种"一刀切"的发布方式有几个严重问题:
- **故障即不可用** — 新版本有 bug,所有用户立刻受影响,没有缓冲时间
- **回滚慢** — 销毁新版本、重建旧版本,需要几分钟,期间服务不可用
- **难以验证** — 没有真实流量验证,测试环境通过不代表生产环境没问题
- **影响所有用户** — 不能选择性影响(比如只让内部用户先试)

### 1.2 金丝雀发布的思路

"金丝雀"这个名字来自矿工——古代矿工带金丝雀下井,鸟先死人就跑。引申到软件发布:**新版本先接小比例流量,观察一段时间,没问题再扩大**。

典型流程:
1. **0%** — 旧版本承接 100% 流量
2. **1%** — 新版本承接 1% 流量(内部测试),观察 30 分钟
3. **10%** — 新版本扩大到 10%,观察 1 小时
4. **50%** — 新版本扩大到 50%,观察 2 小时
5. **100%** — 新版本完全接管,旧版本下线

任何阶段发现问题,一键回滚到 0%,影响范围可控。

### 1.3 K8s 实现金丝雀的方式

K8s 实现金丝雀发布的几种方案:

**方案 1:Deployment 滚动更新**  
最简单,但只能做"副本数比例",无法精确控制流量比例。比如旧 3 副本 + 新 1 副本,流量比例不一定是 75%/25%(取决于负载均衡算法)。

**方案 2:两个 Deployment + Label 共享**  
新版本 Deployment 用相同 label,但副本数少。Service selector 选 label,自动负载均衡。同样无法精确控制比例。

**方案 3:Ingress Canary 注解**  
nginx-ingress 提供专门的 Canary 注解,可以基于 Header、Cookie、权重做精细流量切分。这是最推荐的方案。

**方案 4:Service Mesh(Istio)**  
Istio 提供更强大的流量管理能力,支持基于权重、Header、用户身份的精细路由。但引入 Istio 复杂度高,适合大规模集群。

这篇主要讲方案 3——基于 nginx-ingress 的 Canary 发布。

## 二、创建基础 Ingress

### 2.1 准备主版本服务

```bash
# 创建 myapp1(v1)作为主版本
kubectl create deployment myapp1 --image myapp:v1 --replicas 3
kubectl expose deployment myapp1 --port 80 --target-port 80
```

### 2.2 创建基础 Ingress

```yaml
# 7-ingress.yml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
  name: webcluster                # 主 Ingress
spec:
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

```bash
kubectl apply -f 7-ingress.yml
ingress.networking.k8s.io/webcluster created

# 测试
curl myapp1.zxf.org
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
```

主版本正常工作,所有流量都到 myapp1(v1)。

## 三、Canary Ingress 配置

### 3.1 准备金丝雀版本服务

```bash
# 创建 myapp2(v2)作为金丝雀版本
kubectl create deployment myapp2 --image myapp:v2 --replicas 1
kubectl expose deployment myapp2 --port 80 --target-port 80
```

### 3.2 创建 Canary Ingress

```yaml
# 8-canary-ingress.yml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"                          # 关键:Canary Ingress
    nginx.ingress.kubernetes.io/canary-by-header: "x-canary"            # 基于 Header
    nginx.ingress.kubernetes.io/canary-by-header-value: "true"          # Header 值
    nginx.ingress.kubernetes.io/canary-weight: "10"                     # 权重 10%
  name: webcluster-canary                  # 名字必须不同
spec:
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org                   # 必须与主 Ingress 相同
    http:
      paths:
      - backend:
          service:
            name: myapp2                   # 指向金丝雀服务
            port:
              number: 80
        path: /
        pathType: Prefix
```

关键注解:

- **`canary: "true"`** — 标记这是 Canary Ingress(否则会被当成普通 Ingress,与主 Ingress 冲突)
- **`canary-by-header: "x-canary"`** — 检查请求头 `x-canary`
- **`canary-by-header-value: "true"`** — 当 `x-canary: true` 时,流量走金丝雀版本
- **`canary-weight: "10"`** — 没有匹配 Header 的流量,按 10% 概率走金丝雀

### 3.3 测试金丝雀发布

```bash
kubectl apply -f 8-canary-ingress.yml

# 测试 1:不带 Header,90% 走 v1,10% 走 v2
for i in {1..20}; do curl -s myapp1.zxf.org; echo; done | sort | uniq -c
     18 Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
      2 Hello MyApp | Version: v2 | <a href="hostname.html">Pod Name</a>

# 测试 2:带 Header,100% 走 v2
curl -H "x-canary: true" myapp1.zxf.org
Hello MyApp | Version: v2 | <a href="hostname.html">Pod Name</a>
```

效果:
- 普通流量:18 次 v1 + 2 次 v2(接近 90%/10%)
- 带 `x-canary: true` Header 的流量:100% v2

## 四、Canary 流量切分策略

### 4.1 基于 Header(精确控制)

```yaml
annotations:
  nginx.ingress.kubernetes.io/canary-by-header: "x-canary"
  nginx.ingress.kubernetes.io/canary-by-header-value: "true"
```

只要请求带 `x-canary: true` Header,就 100% 走金丝雀版本。适合:
- **内部测试** — 测试人员浏览器加 Header,先体验新版本
- **特定用户灰度** — 后端给指定用户的请求加 Header
- **自动化测试** — CI 流水线发请求带 Header,验证新版本

如何加 Header:
- **浏览器** — 用 ModHeader 插件
- **curl** — `curl -H "x-canary: true" URL`
- **应用代码** — 后端网关给指定 UID 加 Header
- **Cookie** — `canary-by-cookie` 注解,基于 Cookie 切分

### 4.2 基于 Cookie(用户粘性)

```yaml
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-by-cookie: "canary"
```

请求带 `canary=true` Cookie 时走金丝雀。适合:
- **用户主动选择** — 提供"体验新版"按钮,点击后设置 Cookie
- **A/B 测试** — 给一部分用户设 Cookie,持续观察行为差异

### 4.3 基于权重(随机流量)

```yaml
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-weight: "10"
```

按比例随机切分流量,10% 走金丝雀。适合:
- **小规模试水** — 新版本先承接少量真实用户流量
- **逐步扩大** — 10% → 50% → 100%,每步观察

### 4.4 组合策略

Header/Cookie 和 Weight 可以组合:

```yaml
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-by-header: "x-canary"
  nginx.ingress.kubernetes.io/canary-by-header-value: "true"
  nginx.ingress.kubernetes.io/canary-weight: "10"
```

匹配规则:
1. 请求带 `x-canary: true` → 100% 走金丝雀
2. 请求不带 Header → 按 10% 概率走金丝雀

这种组合策略实现了"内部测试 + 真实流量验证"的双重保险。

## 五、Canary 发布的工程化流程

### 5.1 发布前准备

```bash
# 1. 主版本部署(假设已存在)
kubectl get deployment myapp1
# 3 副本,稳定运行

# 2. 金丝雀版本部署
kubectl create deployment myapp1-canary --image=myapp:v2 --replicas=1
kubectl expose deployment myapp1-canary --port=80 --target-port=80

# 3. 监控准备
# Prometheus 抓取 myapp1 和 myapp1-canary 的指标
# Grafana 面板对比两个版本的关键指标
```

金丝雀版本的 Deployment 名字建议带 `-canary` 后缀,便于区分。

### 5.2 Canary Ingress 部署

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-header: "x-canary"
    nginx.ingress.kubernetes.io/canary-by-header-value: "true"
  name: myapp1-canary
spec:
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org
    http:
      paths:
      - backend:
          service:
            name: myapp1-canary
            port:
              number: 80
        path: /
        pathType: Prefix
```

**注意**:Canary Ingress 的 host 和 path 必须与主 Ingress 完全相同,nginx-ingress 才能识别它们是同一应用的不同版本。

### 5.3 渐进式发布

```bash
# 阶段 1:内部测试(0% 真实流量,只接 Header 流量)
# Canary Ingress 只配 canary-by-header,不配 canary-weight

# 阶段 2:小流量验证(10%)
kubectl annotate ingress myapp1-canary \
  nginx.ingress.kubernetes.io/canary-weight="10" \
  --overwrite

# 观察指标 30 分钟
watch -n 5 'kubectl get pods; curl -s monitoring:9090/api/v1/query?query=...'

# 阶段 3:中流量验证(50%)
kubectl annotate ingress myapp1-canary \
  nginx.ingress.kubernetes.io/canary-weight="50" \
  --overwrite

# 观察指标 1 小时

# 阶段 4:全量发布
# 更新主 Deployment 镜像到 v2
kubectl set image deployment/myapp1 myapp=myapp:v2

# 等待滚动更新完成
kubectl rollout status deployment/myapp1

# 删除 Canary Ingress 和 Deployment
kubectl delete ingress myapp1-canary
kubectl delete deployment myapp1-canary
kubectl delete service myapp1-canary
```

### 5.4 自动化回滚

发布过程中如果发现指标异常,立即回滚:

```bash
# 紧急回滚:把 Canary 权重设为 0
kubectl annotate ingress myapp1-canary \
  nginx.ingress.kubernetes.io/canary-weight="0" \
  --overwrite

# 或直接删除 Canary
kubectl delete ingress myapp1-canary
kubectl delete deployment myapp1-canary
```

回滚后,所有流量回到主版本(v1),金丝雀版本(v2)下线。

自动化回滚可以用 Prometheus Alert + webhook 实现:

```yaml
# Prometheus Alertmanager 规则
- alert: HighErrorRate
  expr: |
    rate(http_requests_total{status=~"5..", version="v2"}[1m]) /
    rate(http_requests_total{version="v2"}[1m]) > 0.05
  for: 2m
  annotations:
    summary: "Canary 版本错误率 > 5%"
```

Alertmanager 收到告警后调用 webhook,触发回滚脚本。

## 六、Canary 监控指标

金丝雀发布期间,核心监控指标:

### 6.1 业务指标

- **错误率** — 5xx 状态码占比,> 1% 立即告警
- **响应时间** — P99 延迟,> 基线 2 倍告警
- **吞吐量** — QPS 是否正常
- **业务转化率** — 注册、下单等关键转化

### 6.2 系统指标

- **CPU/内存使用率** — 新版本资源消耗
- **GC 时间** — Java 应用的 Full GC 频率
- **连接池** — 数据库、Redis 连接池使用情况
- **日志错误** — ERROR 级别日志数量

### 6.3 对比监控

金丝雀的核心是"对比",关键指标需要 v1 和 v2 并列对比:

```promql
# v1 vs v2 错误率
sum(rate(http_requests_total{status=~"5..", version="v1"}[1m])) by (version)
sum(rate(http_requests_total{status=~"5..", version="v2"}[1m])) by (version)

# v1 vs v2 响应时间 P99
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{version="v1"}[1m])) by (le, version))
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{version="v2"}[1m])) by (le, version))
```

Grafana 面板把 v1 和 v2 的指标画在同一张图上,差异一目了然。

## 七、Canary 发布的工程实践

### 7.1 命名规范

```yaml
# 主版本
metadata:
  name: myapp1                          # Deployment
  name: myapp1                          # Service
  name: myapp1                          # Ingress

# 金丝雀版本
metadata:
  name: myapp1-canary                   # Deployment
  name: myapp1-canary                   # Service
  name: myapp1-canary                   # Ingress
```

清晰的命名规范让运维一眼看出资源关系,排查问题更快。

### 7.2 标签管理

```yaml
# 主版本 Pod
template:
  metadata:
    labels:
      app: myapp1
      version: v1                       # 版本标签

# 金丝雀版本 Pod
template:
  metadata:
    labels:
      app: myapp1
      version: v2                       # 版本标签
```

`version` 标签用于:
- Prometheus 抓取时区分版本
- 日志聚合时按版本过滤
- Service Mesh 按版本路由

### 7.3 CI/CD 集成

完整的 CI/CD Pipeline 包含金丝雀发布:

```groovy
stage('Canary Deploy') {
  steps {
    // 1. 部署金丝雀版本(0% 流量)
    sh 'kubectl apply -f k8s/canary-ingress.yml'
    sh 'kubectl annotate ingress myapp1-canary nginx.ingress.kubernetes.io/canary-weight=0 --overwrite'
    
    // 2. 内部测试(带 Header)
    sh 'curl -H "x-canary: true" https://myapp1.zxf.org/health'
    
    // 3. 10% 流量
    sh 'kubectl annotate ingress myapp1-canary nginx.ingress.kubernetes.io/canary-weight=10 --overwrite'
    sh './scripts/monitor-canary.sh 1800'    // 监控 30 分钟
    
    // 4. 50% 流量
    sh 'kubectl annotate ingress myapp1-canary nginx.ingress.kubernetes.io/canary-weight=50 --overwrite'
    sh './scripts/monitor-canary.sh 3600'    // 监控 1 小时
    
    // 5. 全量发布
    sh 'kubectl set image deployment/myapp1 myapp=myapp:v2'
    sh 'kubectl rollout status deployment/myapp1'
    
    // 6. 清理金丝雀
    sh 'kubectl delete ingress myapp1-canary'
    sh 'kubectl delete deployment,svc myapp1-canary'
  }
}
```

### 7.4 金丝雀发布的常见陷阱

**陷阱 1:数据库 Schema 不兼容**  
新版本 Schema 改了,旧版本应用读不了新数据。金丝雀期间两个版本共用数据库,Schema 必须向后兼容。建议:
- Schema 变更分两次发布——先加字段(不删旧字段),后用新字段
- 用 Feature Flag 控制新功能开关,而不是用 Schema 区分版本

**陷阱 2:Session 状态不一致**  
用户请求分到 v1 创建 Session,下次分到 v2 读不到。建议:
- Session 存 Redis,两个版本共享
- 用 Sticky Session 让同一用户始终走同一版本
- 用无状态认证(JWT),彻底摆脱 Session

**陷阱 3:金丝雀流量太小**  
1% 流量在小规模用户下可能几分钟才一个请求,统计意义不大。建议:
- 小集群先用 Header 模式(内部测试)
- 流量大的服务才能用权重模式做有意义的灰度

## 八、金丝雀发布的工程哲学

金丝雀发布体现的核心思想:

1. **渐进式发布** — 任何变更都先小范围试,验证后再扩大
2. **可观测性优先** — 没有监控就不要做金丝雀,出问题不知道
3. **快速回滚能力** — 回滚要秒级,不能等几分钟
4. **故障隔离** — 新版本问题只影响小部分用户,大部分用户无感知

这种"渐进式 + 可观测 + 快回滚"的发布哲学,是现代 SRE 的核心实践。在电商项目里,我们用这套机制在半年内做了 80+ 次发布,只有 2 次需要回滚,平均回滚时间 30 秒,用户基本无感知。

对比全量发布时代——每次发布都是"提心吊胆 30 分钟",金丝雀发布让部署从"高风险操作"变成"日常操作"。这种转变,是工程化的最大价值。

> 金丝雀发布不是"功能",是"哲学"。它把"发布即风险"变成"发布即日常",让团队敢于频繁发布,快速迭代。这种能力的积累,是 SRE 文化的基石。
