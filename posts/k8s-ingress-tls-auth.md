# K8s Ingress 进阶:TLS 加密与 Basic Auth 认证

> 生产环境的 Web 服务必须解决两个安全问题——传输加密和访问控制。这篇记录 Ingress 如何实现 TLS 终止(HTTPS)和 Basic Auth 认证,让后端应用无需关心这些基础设施层面的安全机制。

## 一、TLS 加密:HTTPS 的工程实现

### 1.1 为什么要在 Ingress 层做 TLS 终止

HTTPS 加密解密需要 CPU 算力(非对称密钥交换、对称加解密)。如果每个后端 Pod 都处理 HTTPS,会导致:
- **CPU 资源浪费** — 同样的 TLS 握手在每个 Pod 重复执行
- **证书管理复杂** — 每个 Pod 都要装证书,证书轮换时所有 Pod 都要更新
- **应用代码耦合** — 后端代码要处理 HTTPS,违反业务/基础设施分离原则

Ingress 层做 TLS 终止(SSL Termination)的方案:
- **客户端 → Ingress** — HTTPS 加密传输,Ingress 解密
- **Ingress → 后端 Pod** — HTTP 明文传输(集群内可信网络)

这样后端 Pod 只跑 HTTP,证书只在 Ingress 管理,运维成本大幅降低。

### 1.2 生成 TLS 证书

```bash
openssl req -newkey rsa:2048 \
  -nodes \
  -keyout tls.key \
  -x509 -days 365 \
  -subj "/CN=nginxsvc/O=nginxsvc" \
  -out tls.crt
```

参数说明:
- **`-newkey rsa:2048`** — 生成 2048 位 RSA 密钥对
- **`-nodes`** — 不对私钥加密(否则 K8s 无法读取)
- **`-keyout tls.key`** — 私钥输出文件
- **`-x509`** — 直接生成自签名证书(不生成 CSR)
- **`-days 365`** — 证书有效期 365 天
- **`-subj "/CN=nginxsvc/O=nginxsvc"`** — 证书主题,CN 是 Common Name

**注意**:自签名证书浏览器不信任,会报"证书不受信任"警告。生产环境用 Let's Encrypt、阿里云、Cloudflare 等签发的正式证书。

### 1.3 创建 K8s Secret

```bash
kubectl create secret tls web-tls-secret \
  --key tls.key \
  --cert tls.crt
secret/web-tls-secret created

kubectl get secrets
NAME             TYPE                DATA   AGE
web-tls-secret   kubernetes.io/tls   2      4s
```

K8s 的 `Secret` 是用来存敏感数据的资源(密码、证书、token)。`type: kubernetes.io/tls` 是专门的 TLS Secret 类型,要求 `tls.key` 和 `tls.crt` 两个键。

```bash
kubectl get secrets web-tls-secret -o yaml
apiVersion: v1
data:
  tls.crt: LS0tLS1CRUdJTi...    # base64 编码的证书
  tls.key: LS0tLS1CRUdJTi...    # base64 编码的私钥
kind: Secret
metadata:
  name: web-tls-secret
  namespace: default
type: kubernetes.io/tls
```

Secret 的数据是 base64 编码(不是加密!),任何能 `kubectl get secret` 的人都能解码看到内容。生产环境更安全的方案:
- **云厂商 KMS** — AWS KMS、阿里云 KMS,用云密钥管理服务加密 Secret
- **Sealed Secrets** — Bitnami 的开源方案,把 Secret 加密成"只能由集群内 controller 解密"的 SealedSecret
- **External Secrets** — 从 Vault、AWS Secrets Manager 等外部密钥管理服务同步

### 1.4 配置 Ingress 启用 TLS

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
  name: webcluster
spec:
  tls:                          # TLS 配置
  - hosts:
    - myapp1.zxf.org            # 该证书适用的域名
    secretName: web-tls-secret  # 证书 Secret 名
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

关键字段:
- **`spec.tls[].hosts`** — 该证书覆盖的域名列表(SAN)
- **`spec.tls[].secretName`** — 存证书的 Secret 名

Ingress Controller 会:
1. 从 Secret 读取证书和私钥
2. 在 Nginx 配置里给 `myapp1.zxf.org` 加 `listen 443 ssl` + 证书路径
3. 自动把 80 端口的 HTTP 请求 301 重定向到 443 HTTPS

### 1.5 应用并验证

```bash
kubectl apply -f 3-ingress.yml
ingress.networking.k8s.io/webcluster created

kubectl describe ingress
Name:             webcluster
Ingress Class:    nginx
TLS:
  web-tls-secret terminates myapp1.zxf.org
Rules:
  Host            Path  Backends
  ----            ----  --------
  myapp1.zxf.org  
                  /   myapp1:80 (10.244.1.13:80)
```

`TLS: web-tls-secret terminates myapp1.zxf.org` 表示 TLS 已配置,在 `myapp1.zxf.org` 域名上做 SSL 终止。

测试:

```bash
# -k 跳过证书验证(自签名证书)
curl -k https://myapp1.zxf.org
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
```

成功!HTTPS 访问正常工作。

### 1.6 HTTP 自动跳转 HTTPS

默认情况下,nginx-ingress-controller 会把 HTTP(80)请求 308 永久重定向到 HTTPS(443):

```bash
curl -I http://myapp1.zxf.org
HTTP/1.1 308 Permanent Redirect
Location: https://myapp1.zxf.org/
```

如果不想跳转(同时支持 HTTP 和 HTTPS),加注解:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
```

生产环境推荐开启跳转,强制所有流量走 HTTPS,避免敏感数据明文传输。

### 1.7 证书管理:cert-manager

生产环境证书有效期通常 90 天(Let's Encrypt),手动更新不可行。**cert-manager** 是 K8s 的证书管理控制器,自动签发和轮换证书:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: myapp1-tls
spec:
  secretName: web-tls-secret
  dnsNames:
  - myapp1.zxf.org
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

cert-manager 会:
1. 用 Let's Encrypt ACME 协议签发证书
2. 自动验证域名所有权(HTTP-01 或 DNS-01 challenge)
3. 把证书存到指定 Secret
4. 证书到期前 30 天自动续期

cert-manager 是生产环境必备工具,推荐部署。

## 二、Basic Auth 认证

### 2.1 为什么要在 Ingress 层做认证

后端应用自己实现认证有缺点:
- **重复造轮子** — 每个应用都要写登录逻辑
- **认证方式不统一** — A 应用用 Session,B 应用用 JWT,运维混乱
- **安全风险** — 应用代码漏洞可能导致认证绕过

Ingress 层做认证(比如 Basic Auth)的好处:
- **统一认证入口** — 所有应用共用一套认证机制
- **应用无关** — 后端应用不用改代码,Ingress 层校验
- **集中审计** — 认证日志在 Ingress,容易追溯

Basic Auth 是最简单的 HTTP 认证,适合内部工具、管理后台等小范围场景。生产环境对外的应用推荐 OAuth2/OIDC,安全性更高。

### 2.2 生成 htpasswd 文件

```bash
# 安装工具
dnf install httpd-tools -y

# 生成密码文件
htpasswd -cm auth zxf
New password:
Re-type password:
Adding password for user zxf

# 查看内容
cat auth
zxf:$apr1$hNTmKmxS$qyM7y53AAzPaIUyCNJcgy.
```

`htpasswd` 命令参数:
- **`-c`** — 创建新文件(已存在会覆盖,谨慎用)
- **`-m`** — 用 MD5 加密密码(APR1 算法)
- **`auth`** — 输出文件名
- **`zxf`** — 用户名

生成的文件格式:`用户名:加密后的密码`。加密算法用 APR1(Apache MD5 变种),不可逆。

### 2.3 创建 K8s Secret

```bash
kubectl create secret generic auth-web --from-file=auth
secret/auth-web created

kubectl get secrets auth-web -o yaml
apiVersion: v1
data:
  auth: bGVlOiRhcHIxJGhOVG1LbXhTJHF5TTd5NTNBQXpQYUlVeUNOSmNneS4K
kind: Secret
metadata:
  name: auth-web
  namespace: default
type: Opaque
```

`--from-file=auth` 把 `auth` 文件内容存到 Secret 的 `auth` 键。Secret 类型是 `Opaque`(通用类型)。

注意:`kubectl get secret auth-web -o yaml` 输出的 `data.auth` 是 base64 编码,解码就能看到原始 htpasswd 内容:

```bash
echo "bGVlOiRhcHIxJGhOVG1LbXhTJHF5TTd5NTNBQXpQYUlVeUNOSmNneS4K" | base64 -d
zxf:$apr1$hNTmKmxS$qyM7y53AAzPaIUyCNJcgy.
```

所以 Secret 不加密,只是 base64 编码。生产环境用 RBAC 严格控制 Secret 访问权限。

### 2.4 配置 Ingress 启用 Basic Auth

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic                    # 认证类型
    nginx.ingress.kubernetes.io/auth-secret: auth-web               # Secret 名
    nginx.ingress.kubernetes.io/auth-realm: "Please input username and password"  # 认证域
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

三个注解:
- **`auth-type: basic`** — 启用 Basic Auth
- **`auth-secret: auth-web`** — 指定 htpasswd 文件所在的 Secret
- **`auth-realm: "..."`** — 认证域,浏览器弹窗显示的提示文字

### 2.5 验证认证

```bash
# 不带认证,返回 401
curl -k https://myapp1.zxf.org
<html>
<head><title>401 Authorization Required</title></head>
<body>
<center><h1>401 Authorization Required</h1></center>
<hr><center>nginx</center>
</body>
</html>

# 带认证,正常访问
curl -k https://myapp1.zxf.org -u zxf:123
Hello MyApp | Version: v1 | <a href="hostname.html">Pod Name</a>
```

成功!没有认证返回 401,带正确用户名密码才能访问。

`-u zxf:123` 是 curl 的 Basic Auth 参数,等价于 HTTP 头 `Authorization: Basic base64(zxf:123)`。浏览器访问时,会弹出登录框让用户输入用户名密码。

### 2.6 Basic Auth 的安全考量

Basic Auth 简单但有安全风险:

1. **密码明文传输(如果用 HTTP)** — 必须配合 HTTPS,否则密码会被中间人截获
2. **密码无法注销** — 浏览器关闭前一直保持登录,无 logout 机制
3. **无细粒度权限** — 所有用户访问相同资源,无法区分角色
4. **密码文件维护麻烦** — 加用户、改密码都要操作 htpasswd 文件

生产环境的认证方案推荐:

**OAuth2 / OIDC** — 用 Keycloak、Auth0、Dex 等做身份提供者,Ingress 配置 oauth2-proxy 做认证代理。优点:支持 SSO、细粒度权限、登出机制。

**JWT Token** — 应用自己实现,但用统一网关验证 token。适合微服务架构,每个服务不用重复验证。

**mTLS 双向认证** — 客户端和服务器互相验证证书。安全性最高,但证书管理复杂,适合零信任网络。

## 三、TLS + Basic Auth 的组合配置

完整的 Ingress 配置(TLS + Basic Auth):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: auth-web
    nginx.ingress.kubernetes.io/auth-realm: "Please input username and password"
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"            # 强制 HTTPS
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"          # 上传文件大小限制
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"        # 读超时 60s
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"        # 写超时 60s
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

这些注解组合起来,实现了:
- HTTPS 强制(ssl-redirect)
- Basic Auth 认证(auth-type)
- 上传文件限制(proxy-body-size)
- 超时控制(proxy-read/send-timeout)
- 路径重写(rewrite-target)

这种"基础设施即代码"的配置方式,让所有非业务逻辑都集中在 Ingress 层。后端应用代码只关心业务,极大降低了开发复杂度。

## 四、生产环境的安全最佳实践

### 4.1 TLS 配置

- **证书用正式 CA 签发** — Let's Encrypt(免费)或商业 CA
- **cert-manager 自动管理** — 避免证书过期
- **TLS 1.2+** — 禁用 TLS 1.0/1.1,有安全漏洞
- **强加密套件** — 禁用弱加密(RC4、3DES、MD5)

```yaml
# 强加密套件配置(在 ConfigMap)
data:
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256"
  ssl-protocols: "TLSv1.2 TLSv1.3"
```

### 4.2 认证配置

- **内部工具用 Basic Auth** — 管理后台、监控面板
- **对外应用用 OAuth2/OIDC** — 安全性更高
- **密码强度策略** — 至少 12 位,包含大小写数字符号
- **审计日志** — 记录所有认证成功/失败,便于追溯

### 4.3 网络层防护

Ingress 层之外,还需要:
- **WAF(Web Application Firewall)** — ModSecurity、阿里云 WAF,拦截 SQL 注入、XSS
- **DDoS 防护** — Cloudflare、阿里云 DDoS 高防
- **限流** — nginx-ingress 的 `limit-connections`、`limit-rps` 注解

```yaml
annotations:
  nginx.ingress.kubernetes.io/limit-connections: "20"      # 单 IP 最大连接数
  nginx.ingress.kubernetes.io/limit-rps: "10"               # 单 IP 每秒请求数
  nginx.ingress.kubernetes.io/limit-burst: "20"             # 突发请求数
```

这些防护层叠加,构成了生产环境 Web 服务的纵深防御体系。

## 五、Ingress 安全的工程哲学

Ingress 层做安全的好处是**关注点分离**:
- **应用开发** — 只关心业务逻辑,不管 TLS、认证、限流
- **平台运维** — 在 Ingress 统一配置安全策略,所有应用受益
- **安全团队** — 在 Ingress 审计和监控,不用每个应用都看

这种"基础设施即代码"+"关注点分离"的思路,是云原生安全的核心。下一篇我会讲 Ingress 的 URL Rewrite 能力,实现路径重写、流量改写等高级路由。

> 安全不是应用代码的事,是基础设施的事。把 TLS、认证、限流都收敛到 Ingress 层,后端应用代码才能保持纯粹和简洁。
