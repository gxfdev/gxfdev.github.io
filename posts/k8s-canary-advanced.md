# K8s Canary 进阶:基于 Header 与权重的灰度发布详解

> 上一篇讲了 Canary 金丝雀发布的整体思路,这篇深入两种具体的流量切分策略——基于 Header 的精确灰度和基于权重的随机灰度。两种策略各有适用场景,生产环境经常组合使用。

## 一、回顾:Canary Ingress 的基本结构

Canary 发布需要一个主 Ingress 和一个 Canary Ingress,两者 host 和 path 必须完全相同,通过注解区分:

```yaml
# 主 Ingress(承接大部分流量)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webcluster                    # 主 Ingress 名字
spec:
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org
    http:
      paths:
      - backend:
          service:
            name: myapp1               # 主版本(v1)
            port:
              number: 80
        path: /
        pathType: Prefix

# Canary Ingress(承接灰度流量)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"          # 关键:标记为 Canary
    nginx.ingress.kubernetes.io/canary-by-header: "version"          # 基于 Header
    nginx.ingress.kubernetes.io/canary-by-header-value: "2"
    nginx.ingress.kubernetes.io/rewrite-target: /
  name: webcluster-new                 # 名字必须不同
spec:
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org               # 必须与主 Ingress 相同
    http:
      paths:
      - backend:
          service:
            name: myapp2               # 金丝雀版本(v2)
            port:
              number: 80
        path: /
        pathType: Prefix
```

nginx-ingress-controller 看到 `canary: "true"` 注解后,不会把这个 Ingress 当成独立路由,而是把它与同 host+path 的主 Ingress 关联,按 Canary 规则切分流量。

## 二、基于 Header 的灰度发布

### 2.1 配置

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-header: "version"
    nginx.ingress.kubernetes.io/canary-by-header-value: "2"
    nginx.ingress.kubernetes.io/rewrite-target: /
  name: webcluster-new
spec:
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org
    http:
      paths:
      - backend:
          service:
            name: myapp2
            port:
              number: 80
        path: /
        pathType: Prefix
```

关键注解:
- **`canary-by-header: "version"`** — 检查请求头 `version`
- **`canary-by-header-value: "2"`** — 当 `version: 2` 时,流量走金丝雀版本

### 2.2 测试验证

```bash
# 应用配置
kubectl apply -f 6-ingress.yml

# 不带 Header,走主版本(v1)
curl myapp1.zxf.org
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>

# 带 Header,走金丝雀版本(v2)
curl -H "version:2" myapp1.zxf.org
Hello MyApp | Version: v2 | <a href="hostname.html">Pod Name</a>
```

`-H "version:2"` 给请求加 `version: 2` 头,nginx-ingress 匹配到 Canary 规则,把流量转发到 myapp2(v2)。不带 Header 的请求走主版本。

### 2.3 Header 灰度的工程场景

基于 Header 的灰度是"精确控制"——100% 匹配 Header 的请求才走金丝雀。适用场景:

**1. 内部测试**  
测试人员在浏览器装 ModHeader 插件,加 `version: 2` 头,所有请求都走新版本。其他用户无感知。

**2. 自动化测试**  
CI/CD 流水线发请求带 Header,验证新版本功能:
```bash
# 流水线里的健康检查
curl -H "version:2" https://myapp1.zxf.org/health
```

**3. 特定用户灰度**  
后端网关给指定用户 UID 的请求加 Header,实现"指定用户先体验新版":
```nginx
# 网关层 Nginx 配置
if ($http_x_user_id = "12345") {
    proxy_set_header version "2";
}
```

**4. A/B 测试对照**  
同一时间,带 Header 的走 v2,不带的走 v1,对比两个版本的业务指标(转化率、错误率)。

### 2.4 Header 灰度的优势

- **零风险** — 不带 Header 的用户完全不受影响
- **精确控制** — 可以指定具体用户、具体请求走新版本
- **即时生效** — 改 Header 立即切换,无需重启
- **可逆** — 去掉 Header 立即回到旧版本

## 三、基于权重的灰度发布

### 3.1 配置

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"             # 10% 流量走金丝雀
    nginx.ingress.kubernetes.io/canary-weight-total: "100"      # 总权重 100
    nginx.ingress.kubernetes.io/rewrite-target: /
  name: webcluster-new
spec:
  ingressClassName: nginx
  rules:
  - host: myapp1.zxf.org
    http:
      paths:
      - backend:
          service:
            name: myapp2
            port:
              number: 80
        path: /
        pathType: Prefix
```

关键注解:
- **`canary-weight: "10"`** — 金丝雀版本承接 10% 的流量
- **`canary-weight-total: "100"`** — 总权重 100(默认值,可省略)

### 3.2 验证 Ingress 状态

```bash
kubectl apply -f 7-ingress.yml
kubectl get ingress
NAME             CLASS   HOSTS                  ADDRESS         PORTS   AGE
webcluster       nginx   myapp1.zxf.org   172.25.254.40   80      7m37s
webcluster-new   nginx   myapp1.zxf.org   172.25.254.40   80      6s
```

两个 Ingress 都指向同一个 host,nginx-ingress-controller 内部按 90:10 的比例分发流量。

### 3.3 编写测试脚本验证流量比例

```bash
#!/bin/bash
# check.sh - 测试金丝雀流量分布
v1=0
v2=0

for (( i=0; i<100; i++))
do
    response=`curl -s myapp1.zxf.org | grep -c v1`
    v1=`expr $v1 + $response`
    v2=`expr $v2 + 1 - $response`
done
echo "v1:$v1, v2:$v2"
```

```bash
sh check.sh
v1:88, v2:12
```

100 次请求中,88 次走 v1,12 次走 v2。接近 90:10 的配置比例(随机分布有轻微波动,符合预期)。

### 3.4 脚本的工作原理

```bash
response=`curl -s myapp1.zxf.org | grep -c v1`
```

- `curl -s` 静默模式,只输出响应体
- `grep -c v1` 统计 "v1" 出现的次数(0 或 1)
- 如果返回 v1,`response=1`,`v1+1`
- 如果返回 v2,`response=0`,`v2+1`

这种"统计响应内容判断版本"的方式简单有效。生产环境监控更推荐用 Prometheus 抓取 `version` label,长期统计流量分布。

### 3.5 权重灰度的工程场景

基于权重的灰度是"随机切分"——按比例随机分配流量。适用场景:

**1. 真实流量验证**  
新版本先承接 1%-5% 真实流量,观察错误率、响应时间等指标。比 Header 灰度更真实,因为是普通用户的流量。

**2. 渐进式扩大**  
```
1% → 5% → 10% → 25% → 50% → 100%
```
每一步观察一段时间(30 分钟到 2 小时),无问题再扩大。出问题立即回滚到 0%。

**3. 蓝绿发布的基础**  
50%:50% 是"蓝绿并存"状态,验证稳定后直接切到 0%:100%,完成发布。

## 四、Header 与权重的组合策略

两种策略可以组合使用:

```yaml
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-by-header: "version"
  nginx.ingress.kubernetes.io/canary-by-header-value: "2"
  nginx.ingress.kubernetes.io/canary-weight: "10"
```

匹配规则(优先级从高到低):
1. **Header 匹配** — 请求带 `version: 2`,100% 走金丝雀
2. **权重分配** — 请求不带 Header,按 10% 概率走金丝雀
3. **默认走主版本** — 剩余 90% 走主版本

这种组合实现了"内部测试 + 真实流量验证"的双重保险:
- 内部测试人员带 Header,始终走新版本
- 真实用户按权重分配,小比例走新版本

## 五、Canary 发布的渐进式流程

完整的渐进式发布流程:

### 阶段 1:内部测试(0% 真实流量)

```yaml
# 只配 Header,不配 weight
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-by-header: "version"
  nginx.ingress.kubernetes.io/canary-by-header-value: "2"
```

测试人员带 Header 验证新版本功能,真实用户完全不受影响。观察 30 分钟。

### 阶段 2:小流量验证(5%)

```bash
kubectl annotate ingress webcluster-new \
  nginx.ingress.kubernetes.io/canary-weight="5" \
  --overwrite
```

5% 真实流量走新版本,观察核心指标:
- 错误率(5xx)是否上升
- P99 响应时间是否劣化
- 业务转化率是否下降

观察 1 小时,无问题进入下一阶段。

### 阶段 3:中流量验证(25%)

```bash
kubectl annotate ingress webcluster-new \
  nginx.ingress.kubernetes.io/canary-weight="25" \
  --overwrite
```

1/4 流量走新版本,继续观察指标。观察 2 小时。

### 阶段 4:大流量验证(50%)

```bash
kubectl annotate ingress webcluster-new \
  nginx.ingress.kubernetes.io/canary-weight="50" \
  --overwrite
```

对半切,这是最关键的阶段。如果两个版本都能稳定承接 50% 流量,说明新版本基本没问题。观察 4 小时。

### 阶段 5:全量发布(100%)

```bash
# 方式 1:继续用 Canary,权重设为 100
kubectl annotate ingress webcluster-new \
  nginx.ingress.kubernetes.io/canary-weight="100" \
  --overwrite

# 方式 2:更新主 Deployment 镜像,删除 Canary
kubectl set image deployment/myapp1 myapp=myapp:v2
kubectl delete ingress webcluster-new
kubectl delete deployment,svc myapp2
```

方式 2 更干净——把新版本变成主版本,删除金丝雀资源,避免维护两套 Ingress。

## 六、Canary 发布的监控指标

每个阶段都要监控的核心指标:

### 6.1 技术指标

```promql
# 错误率对比
sum(rate(http_requests_total{status=~"5..", version="v1"}[1m])) by (version)
sum(rate(http_requests_total{status=~"5..", version="v2"}[1m])) by (version)

# 响应时间 P99 对比
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{version="v1"}[1m])) by (le))
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{version="v2"}[1m])) by (le))

# 吞吐量对比
sum(rate(http_requests_total{version="v1"}[1m]))
sum(rate(http_requests_total{version="v2"}[1m]))
```

### 6.2 业务指标

- **转化率** — 注册、下单、支付等关键转化
- **用户行为** — 页面停留时间、跳出率
- **客服反馈** — 用户投诉是否增加

业务指标劣化比技术指标更难发现,但影响更大。建议金丝雀期间重点对比业务指标。

### 6.3 自动回滚

```yaml
# Prometheus Alertmanager 规则
- alert: CanaryHighErrorRate
  expr: |
    rate(http_requests_total{status=~"5..", version="v2"}[1m]) /
    rate(http_requests_total{version="v2"}[1m]) > 0.05
  for: 1m
  annotations:
    summary: "Canary 版本错误率 > 5%"
```

Alertmanager 收到告警后调用 webhook,触发自动回滚脚本:

```bash
#!/bin/bash
# auto-rollback.sh
kubectl annotate ingress webcluster-new \
  nginx.ingress.kubernetes.io/canary-weight="0" \
  --overwrite
kubectl delete ingress webcluster-new
kubectl delete deployment,svc myapp2
```

## 七、Canary 发布的陷阱与对策

### 7.1 数据库 Schema 不兼容

新版本改了数据库 Schema,旧版本读不了新数据。金丝雀期间两个版本共用数据库,必须保证 Schema 向后兼容。

**对策**:
- Schema 变更分两次发布——先加字段(不删旧字段),后用新字段
- 用 Feature Flag 控制新功能,而不是用 Schema 区分版本

### 7.2 Session 状态不一致

用户请求分到 v1 创建 Session,下次分到 v2 读不到。

**对策**:
- Session 存 Redis,两个版本共享
- 用无状态认证(JWT),彻底摆脱 Session
- 用 `canary-by-cookie` 让同一用户始终走同一版本

### 7.3 流量太小统计无意义

1% 流量在小规模用户下可能几分钟才一个请求,统计意义不大。

**对策**:
- 小集群先用 Header 模式(内部测试)
- 流量大的服务才能用权重模式做有意义的灰度
- 至少观察 1000 个请求才能得出可靠结论

### 7.4 缓存不一致

新版本改了缓存 key 结构,两个版本的缓存互相污染。

**对策**:
- 缓存 key 加版本前缀(`v2:user:123` vs `v1:user:123`)
- 金丝雀期间用独立缓存实例
- 新版本预热缓存后再切流量

## 八、Canary 发布的工程哲学

Canary 发布体现的核心思想:

1. **渐进式发布** — 任何变更都先小范围试,验证后再扩大
2. **可观测性优先** — 没有监控就不要做金丝雀,出问题不知道
3. **快速回滚能力** — 回滚要秒级,不能等几分钟
4. **故障隔离** — 新版本问题只影响小部分用户,大部分用户无感知

基于 Header 的灰度是"精确控制",适合内部测试;基于权重的灰度是"随机验证",适合真实流量验证。两者组合,构成了完整的金丝雀发布策略。

在电商项目里,我们用这套机制在半年内做了 80+ 次发布,只有 2 次需要回滚,平均回滚时间 30 秒,用户基本无感知。对比全量发布时代——每次发布都是"提心吊胆 30 分钟",金丝雀发布让部署从"高风险操作"变成"日常操作"。

> 金丝雀发布不是"功能",是"哲学"。它把"发布即风险"变成"发布即日常",让团队敢于频繁发布,快速迭代。这种能力的积累,是 SRE 文化的基石。
