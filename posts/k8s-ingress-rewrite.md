# K8s Ingress URL Rewrite:路径重写的工程化应用

> Ingress 的 URL Rewrite 能力,让前端 URL 和后端实际路径解耦。这篇记录两种典型的重写场景——app-root 默认页跳转和正则路径捕获重写,以及生产环境的 URL 治理实践。

## 一、为什么需要 URL Rewrite

### 1.1 业务场景

考虑以下场景:

**场景 1:默认页跳转**  
用户访问 `https://myapp1.zxf.org`,希望直接跳到 `https://myapp1.zxf.org/hostname.html`,而不是默认的 `/` 路径。后端应用没有处理根路径的逻辑,直接访问会返回 404。

**场景 2:路径前缀剥离**  
前端代码用 `/lee/api/users` 调用接口,但后端应用只识别 `/api/users`。需要在 Ingress 层把 `/lee` 前缀剥离,转发给后端时路径变成 `/api/users`。

**场景 3:版本路由**  
`/v1/users` 转发到 v1 版本后端,`/v2/users` 转发到 v2 版本后端。后端应用代码里没有 `/v1` `/v2` 前缀,需要 Ingress 重写。

这些场景的共同点:**前端看到的 URL 和后端处理的 URL 不一致**。URL Rewrite 就是 Ingress 层做这种"翻译"。

### 1.2 Rewrite 的工程价值

- **前后端解耦** — 前端 URL 设计可以独立于后端实现
- **后端无感知** — 后端代码不用关心前缀、版本号等路由细节
- **平滑迁移** — 路径变更时,改 Ingress 配置即可,后端代码不动
- **多版本并存** — 同一应用多版本通过路径区分,灰度发布的基础

## 二、app-root:默认页跳转

### 2.1 配置

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/app-root: /hostname.html       # 关键注解
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: auth-web
    nginx.ingress.kubernetes.io/auth-realm: "Please input username and password"
    nginx.ingress.kubernetes.io/rewrite-target: /
  name: webcluster
spec:
  tls:
  - hosts:
    - myapp1.zxf.org
    secretName: web-tls-secret
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

`app-root: /hostname.html` 注解告诉 nginx-ingress:当用户访问根路径 `/` 时,返回 302 重定向到 `/hostname.html`。

### 2.2 验证

```bash
# 应用配置
kubectl apply -f 5-ingress.yml

# 不跟随重定向
curl -lk https://myapp1.zxf.org -u zxf:123
<html>
<head><title>302 Found</title></head>
<body>
<center><h1>302 Found</h1></center>
<hr><center>nginx</center>
</body>
</html>

# 跟随重定向(-L)
curl -Lk https://myapp1.zxf.org -u zxf:123
myapp1-8456b584d6-b96qq
```

`-L` 参数让 curl 跟随 302 重定向。重定向后访问 `/hostname.html`,后端返回 Pod 名字 `myapp1-8456b584d6-b96qq`。

### 2.3 app-root 的内部机制

nginx-ingress-controller 生成的 Nginx 配置大致是:

```nginx
location = / {
    return 302 https://$host/hostname.html;
}
```

当请求路径是 `/`(完全匹配 `location = /`),返回 302 重定向,Location 头指向 `https://myapp1.zxf.org/hostname.html`。

注意是 302(临时重定向)而不是 301(永久重定向)。原因:
- **301 会被浏览器缓存** — 用户后续访问 `/` 直接从本地缓存跳转,Ingress 配置改了也不生效
- **302 不缓存** — 每次请求都问 Ingress,配置变更立即生效

如果确实想永久重定向(比如域名迁移),可以用 `nginx.ingress.kubernetes.io/permanent-redirect` 注解。

### 2.4 app-root 的使用场景

- **默认首页** — 访问根路径跳到首页 `/index.html`
- **管理后台** — 访问 `/admin` 跳到登录页 `/admin/login`
- **API 文档** — 访问 `/api` 跳到 Swagger 文档 `/api/docs`
- **维护页** — 服务维护时,所有访问跳到 `/maintenance.html`

## 三、正则路径重写:rewrite-target 与 use-regex

### 3.1 配置

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2                    # 引用捕获组
    nginx.ingress.kubernetes.io/use-regex: "true"                       # 启用正则
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: auth-web
    nginx.ingress.kubernetes.io/auth-realm: "Please input username and password"
  name: webcluster
spec:
  tls:
  - hosts:
    - myapp1.zxf.org
    secretName: web-tls-secret
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
        path: /lee(/|$)(.*)                # 正则匹配
        pathType: ImplementationSpecific    # 必须用这个类型
```

关键点:

- **`rewrite-target: /$2`** — `$2` 是正则第二个捕获组的内容
- **`use-regex: "true"`** — 启用正则匹配
- **`path: /lee(/|$)(.*)`** — 正则匹配 `/lee` 后面跟 `/` 或结尾,再捕获剩余部分
- **`pathType: ImplementationSpecific`** — 必须用这个类型,Prefix/Exact 不支持正则

### 3.2 正则捕获组的工作机制

正则 `/lee(/|$)(.*)` 有两个捕获组:

- **`$1`** — `(/|$)`,匹配 `/` 或字符串结尾
- **`$2`** — `(.*)`,匹配剩余的所有字符

`rewrite-target: /$2` 把请求路径重写为 `/` + `$2` 的内容。举例:

| 客户端请求路径 | $1 | $2 | 重写后路径 |
|--------------|----|----|-----------|
| `/lee/hostname.html` | `/` | `hostname.html` | `/hostname.html` |
| `/lee/aaa` | `/` | `aaa` | `/aaa` |
| `/lee` | (空,字符串结尾) | (空) | `/` |
| `/leebbb` | 不匹配 | 不匹配 | 不重写(路径不匹配) |

### 3.3 验证

```bash
kubectl apply -f 5-ingress.yml

# 测试 1:访问 /lee/hostname.html,后端收到 /hostname.html
curl -Lk https://myapp1.zxf.org/lee/hostname.html -u zxf:123
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>

# 测试 2:访问 /lee/aaa,后端收到 /aaa
curl -Lk https://myapp1.zxf.org/lee/aaa -u zxf:123
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
```

成功!`/lee/xxx` 被重写成 `/xxx`,后端应用完全无感知。

### 3.4 nginx-ingress 生成的 Nginx 配置

```nginx
location ~* ^/lee(/|$)(.*) {
    rewrite "^/lee(/|$)(.*)" /$2 break;
    proxy_pass http://upstream-name;
}
```

`~* ^/lee(/|$)(.*)` 是 Nginx 的正则 location 匹配。`rewrite ... break` 把路径重写为 `/$2`,然后 `proxy_pass` 转发到后端。

`break` 标志很重要——它告诉 Nginx 重写后不再匹配其他 location 规则,直接转发。如果用 `last`,会重新匹配 location,可能导致循环。

## 四、Rewrite 的典型应用模式

### 4.1 API 版本路由

```yaml
rules:
- host: api.example.com
  http:
    paths:
    - path: /v1(/|$)(.*)
      backend:
        service:
          name: api-v1
          port: { number: 80 }
      pathType: ImplementationSpecific
    - path: /v2(/|$)(.*)
      backend:
        service:
          name: api-v2
          port: { number: 80 }
      pathType: ImplementationSpecific
```

`rewrite-target: /$2` 让 `/v1/users` 重写成 `/users` 转发到 v1 服务,`/v2/users` 重写成 `/users` 转发到 v2 服务。后端应用代码完全一致,不需要处理版本前缀。

### 4.2 前后端分离

```yaml
rules:
- host: app.example.com
  http:
    paths:
    - path: /api(/|$)(.*)
      backend:
        service:
          name: backend
          port: { number: 8080 }
      pathType: ImplementationSpecific
    - path: /
      backend:
        service:
          name: frontend
          port: { number: 80 }
      pathType: Prefix
```

`/api/xxx` 转发到后端,重写成 `/xxx`(后端不识别 `/api` 前缀);其他路径转发到前端 SPA。前端代码用 `/api/users` 调接口,实际后端处理 `/users`,Ingress 做翻译。

### 4.3 服务聚合

```yaml
rules:
- host: gateway.example.com
  http:
    paths:
    - path: /user(/|$)(.*)
      backend:
        service: { name: user-service, port: { number: 80 } }
    - path: /order(/|$)(.*)
      backend:
        service: { name: order-service, port: { number: 80 } }
    - path: /payment(/|$)(.*)
      backend:
        service: { name: payment-service, port: { number: 80 } }
```

多个微服务通过一个 Ingress 暴露,客户端只看到一个域名,通过路径前缀区分服务。这种"API 网关"模式,是微服务架构的典型实践。

## 五、Rewrite 的常见陷阱

### 5.1 捕获组不匹配

```yaml
# 错误示例
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /$1
spec:
  rules:
  - http:
      paths:
      - path: /api/(.*)              # 一个捕获组
        pathType: ImplementationSpecific
```

`$1` 引用第一个捕获组,`/api/(.*)` 只有一个捕获组。访问 `/api/users`,`$1` 是 `users`,重写成 `/users`。这是对的。

但如果不小心写成 `/api/(.*)/(.*)`(两个捕获组),`$1` 就只是中间部分,容易出 bug。**捕获组数量和 `$N` 引用要严格对应**。

### 5.2 pathType 用错

```yaml
# 错误示例
paths:
- path: /lee(/|$)(.*)
  pathType: Prefix          # 错误!Prefix 不支持正则
```

`Prefix` 和 `Exact` 都是字面匹配,不支持正则。正则路径必须用 `ImplementationSpecific`,并配合 `use-regex: "true"` 注解。

### 5.3 rewrite-target 与 pathType 冲突

```yaml
# 这种配置无效
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - http:
      paths:
      - path: /
        pathType: Exact       # Exact 不会被 rewrite
```

`rewrite-target` 只对 `Prefix` 和 `ImplementationSpecific` 生效。`Exact` 是精确匹配,不参与重写。

### 5.4 重写导致路径丢失

```yaml
# 简单重写
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /
```

`rewrite-target: /` 把所有路径都重写成 `/`,丢失原始路径。后端拿不到原始 URL,无法做路由。

如果后端需要知道原始路径(比如生成回调 URL),改用捕获组重写:

```yaml
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /$2
```

这样后端能拿到 `$2` 部分,知道客户端访问的具体路径。

## 六、Rewrite 与 X-Forwarded-* 头

Ingress 重写路径后,后端可能丢失原始 URL 信息。解决方案是用 HTTP 头传递:

```yaml
annotations:
  nginx.ingress.kubernetes.io/configuration-snippet: |
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Original-Path $uri;
```

后端应用读 `X-Original-URI` 头,就能拿到客户端的原始 URL,用于生成回调、日志记录等。

nginx-ingress-controller 默认会传递以下头:
- **`X-Forwarded-For`** — 客户端 IP 链
- **`X-Forwarded-Host`** — 原始 Host
- **`X-Forwarded-Port`** — 原始端口
- **`X-Forwarded-Proto`** — 原始协议
- **`X-Real-IP`** — 客户端真实 IP
- **`X-Request-ID`** — 请求 ID(用于链路追踪)

后端应用信任这些头,可以重建原始请求上下文。Spring Boot 配置:

```yaml
server:
  forward-headers-strategy: native
```

启用后,Spring Boot 会用 `X-Forwarded-*` 头填充 `request.getRemoteAddr()`、`request.getScheme()` 等,应用代码透明使用。

## 七、生产环境的 URL 治理

### 7.1 URL 设计原则

- **稳定** — URL 一旦发布就不要变,避免破坏书签和外链
- **语义化** — `/api/users` 比 `/api/v1/user-list` 更清晰
- **版本化** — API 必须有版本前缀(`/v1/`、`/v2/`),便于灰度
- **简洁** — 避免多层嵌套(`/api/v1/user/list/active` 太长)

### 7.2 URL 迁移策略

URL 变更时的迁移方案:

**方案 1:301 永久重定向**

```yaml
annotations:
  nginx.ingress.kubernetes.io/permanent-redirect: https://new.example.com
```

告诉客户端"这个 URL 永久迁移到新地址",浏览器会缓存,后续直接访问新地址。

**方案 2:同时支持新旧路径**

```yaml
rules:
- host: example.com
  http:
    paths:
    - path: /old-api/                # 旧路径,继续支持一段时间
      backend: { service: { name: api, port: { number: 80 } } }
    - path: /new-api/                # 新路径
      backend: { service: { name: api, port: { number: 80 } } }
```

新旧路径并存,给客户端时间迁移。观察一段时间旧路径流量降为 0 后,再删除。

**方案 3:URL 重写透明迁移**

```yaml
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /new-api$1
spec:
  rules:
  - http:
      paths:
      - path: /old-api(.*)
        pathType: ImplementationSpecific
```

`/old-api/users` 重写成 `/new-api/users`,后端只看到新路径。客户端无感知,代码不变。

### 7.3 URL 文档化

所有对外 URL 必须文档化,建议:
- **OpenAPI/Swagger** — API 路径自动生成文档
- **API Gateway** — 用 Kong、APISIX 等 API 网关集中管理
- **API Contract Testing** — 用 Pact 等工具保证前后端 API 契约一致

## 八、Rewrite 的工程哲学

URL Rewrite 看似简单的"字符串处理",背后是 URL 设计的工程哲学:

1. **URL 是 API 契约** — 一旦发布就要稳定,变更要有迁移策略
2. **前后端解耦** — 前端 URL 设计独立于后端实现,Ingress 做翻译
3. **重写要可追溯** — 用 X-Forwarded-* 头传递原始信息,后端能重建上下文
4. **配置即文档** — Ingress YAML 就是 URL 路由的文档,版本控制管理

下一篇我会讲 Ingress 的金丝雀发布(Canary Release),通过流量切分实现新版本的渐进式上线,这是 Ingress 最有价值的高级特性之一。

> URL Rewrite 是 Ingress 的"翻译官"。它让前端看到稳定的 API 接口,后端保持简单的路径处理,中间的复杂度由 Ingress 承担。这种"中间层做翻译"的思路,贯穿了所有的网关设计。
