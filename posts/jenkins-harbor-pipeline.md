# Jenkins + Harbor 流水线:自动构建镜像并更新 K8s Deployment

> 在 Web 集群部署与自动化运维项目里,最核心的能力就是 CI/CD 流水线——代码推送到 Gitee,Jenkins 自动构建 Docker 镜像,推送到 Harbor 仓库,然后自动更新 K8s Deployment。这篇记录完整的流水线搭建过程,从零到一键部署。

## 一、流水线架构设计

### 1.1 整体流程

```
开发者 git push → Gitee 仓库 → Jenkins Webhook 触发
    ↓
Jenkins Pipeline:
    1. 拉取代码
    2. Maven 编译打包 Spring Boot
    3. docker build 构建镜像
    4. docker push 推送到 Harbor
    5. kubectl set image 更新 Deployment
    6. kubectl rollout status 等待滚动更新完成
    7. 健康检查(5 分钟观察期)
    ↓
K8s 集群:拉取新镜像 → 滚动更新 Pod → 流量切到新版本
```

### 1.2 组件职责

| 组件 | 职责 |
|------|------|
| **Gitee** | 代码托管,Webhook 触发 Jenkins |
| **Jenkins** | 流水线编排,执行构建/部署脚本 |
| **Harbor** | Docker 镜像私有仓库,版本管理 |
| **K8s** | 应用运行时,滚动更新 Pod |

### 1.3 为什么用 Harbor 而不是 Docker Hub

- **拉取速度快** — 内网 Harbor 拉取镜像秒级,Docker Hub 国内拉取经常超时
- **无频率限制** — Docker Hub 免费版有拉取频率限制,CI/CD 跑几次就触发
- **安全合规** — 企业镜像不对外暴露,Harbor 支持 RBAC 和镜像扫描
- **支持 Helm Chart** — Harbor 既能存镜像也能存 Chart,统一管理

## 二、Harbor 仓库准备

### 2.1 Harbor 部署(已完成)

假设 Harbor 已部署在 `reg.zxf.org`,管理员账号 `admin/123`。如果还没部署,参考我之前的 K8s 集群部署文章。

### 2.2 创建项目

在 Harbor Web 界面创建项目 `myapp`:
- **项目名**: myapp
- **访问级别**: 私有(需要认证才能拉取)
- **存储配额**: -1(无限制)

### 2.3 K8s 配置 Harbor 认证

K8s 拉 Harbor 镜像需要认证,创建 `docker-registry` 类型的 Secret:

```bash
kubectl create secret docker-registry harbor-auth \
  --docker-server=reg.zxf.org \
  --docker-username=admin \
  --docker-password=123 \
  --docker-email=admin@zxf.org
secret/harbor-auth created
```

在 Deployment 中引用这个 Secret:

```yaml
spec:
  template:
    spec:
      imagePullSecrets:
      - name: harbor-auth
      containers:
      - name: myapp
        image: reg.zxf.org/myapp/app:v1
```

## 三、Jenkins 环境准备

### 3.1 Jenkins 部署

Jenkins 可以部署在独立服务器,也可以部署在 K8s 集群里。这里采用独立服务器部署,避免 Jenkins 构建(消耗 CPU/内存)影响 K8s 集群。

```bash
# 安装 Jenkins
wget -O /etc/yum.repos.d/jenkins.repo https://pkg.jenkins.io/redhat-stable/jenkins.repo
rpm --import https://pkg.jenkins.io/redhat-stable/jenkins.io.key
yum install jenkins java-11-openjdk -y

# 启动
systemctl enable --now jenkins

# 查看初始密码
cat /var/lib/jenkins/secrets/initialAdminPassword
```

### 3.2 安装必要插件

Jenkins → Manage Jenkins → Manage Plugins,安装:

- **Git Plugin** — 拉取 Gitee 代码
- **Pipeline** — 流水线编排
- **Docker Pipeline** — Docker 构建集成
- **Kubernetes CLI Plugin** — kubectl 命令
- **Gitee Plugin** — Gitee Webhook 集成

### 3.3 Jenkins 配置 Docker

Jenkins 用户需要能执行 docker 命令:

```bash
usermod -aG docker jenkins
systemctl restart jenkins
```

### 3.4 Jenkins 配置 kubectl

Jenkins 需要 kubectl 操作 K8s 集群。把 master 节点的 kubeconfig 复制到 Jenkins:

```bash
# 在 K8s master 上
scp /etc/kubernetes/admin.conf jenkins@jenkins-server:/var/lib/jenkins/.kube/config

# 在 Jenkins 上
chown jenkins:jenkins /var/lib/jenkins/.kube/config
chmod 600 /var/lib/jenkins/.kube/config
```

### 3.5 Jenkins 配置 Harbor 认证

Jenkins 需要 docker login Harbor 才能推送镜像:

```bash
# 切换到 jenkins 用户
su - jenkins

# 登录 Harbor
docker login reg.zxf.org -u admin -p 123

# 认证信息保存在 ~/.docker/config.json
cat ~/.docker/config.json
{
  "auths": {
    "reg.zxf.org": {
      "auth": "YWRtaW46MTIz"
    }
  }
}
```

## 四、Spring Boot 应用准备

### 4.1 应用结构

```
myapp/
├── src/
│   └── main/
│       ├── java/
│       └── resources/
│           └── application.yml
├── pom.xml
├── Dockerfile
└── Jenkinsfile
```

### 4.2 Dockerfile

```dockerfile
# 多阶段构建,减小最终镜像大小
FROM maven:3.8-openjdk-11 as builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline      # 先下载依赖(利用 Docker 缓存)
COPY src ./src
RUN mvn package -DskipTests

FROM openjdk:11-jre-slim
WORKDIR /app
COPY --from=builder /build/target/myapp-*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

多阶段构建的好处:
- **最终镜像小** — 只包含 JRE 和 jar,不含 Maven 和源码
- **构建速度快** — 依赖层缓存,改代码只重新编译
- **安全** — 最终镜像没有编译工具,攻击面小

### 4.3 Jenkinsfile

```groovy
pipeline {
    agent any
    
    environment {
        HARBOR_URL = 'reg.zxf.org'
        HARBOR_PROJECT = 'myapp'
        IMAGE_NAME = "${HARBOR_URL}/${HARBOR_PROJECT}/app"
        IMAGE_TAG = "${env.BUILD_NUMBER}"
        K8S_DEPLOYMENT = 'myapp'
        K8S_NAMESPACE = 'default'
    }
    
    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        
        stage('Build Image') {
            steps {
                sh "docker build -t ${IMAGE_NAME}:${IMAGE_TAG} ."
                sh "docker tag ${IMAGE_NAME}:${IMAGE_TAG} ${IMAGE_NAME}:latest"
            }
        }
        
        stage('Push to Harbor') {
            steps {
                sh "docker push ${IMAGE_NAME}:${IMAGE_TAG}"
                sh "docker push ${IMAGE_NAME}:latest"
            }
        }
        
        stage('Deploy to K8s') {
            steps {
                sh "kubectl set image deployment/${K8S_DEPLOYMENT} app=${IMAGE_NAME}:${IMAGE_TAG} -n ${K8S_NAMESPACE}"
                sh "kubectl rollout status deployment/${K8S_DEPLOYMENT} -n ${K8S_NAMESPACE} --timeout=300s"
            }
        }
        
        stage('Health Check') {
            steps {
                sh '''
                for i in $(seq 1 30); do
                    ERROR_RATE=$(kubectl exec monitoring -- curl -s http://prometheus:9090/api/v1/query?query=rate|grep 5xx)
                    if [ "$ERROR_RATE" > 0.05 ]; then
                        echo "Error rate too high, rolling back..."
                        kubectl rollout undo deployment/${K8S_DEPLOYMENT} -n ${K8S_NAMESPACE}
                        exit 1
                    fi
                    sleep 10
                done
                '''
            }
        }
    }
    
    post {
        failure {
            echo 'Pipeline failed, check logs...'
        }
        success {
            echo "Deploy success! Image: ${IMAGE_NAME}:${IMAGE_TAG}"
        }
    }
}
```

## 五、K8s Deployment 配置

### 5.1 Deployment YAML

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: default
  labels:
    app: myapp
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      imagePullSecrets:
      - name: harbor-auth           # Harbor 认证
      containers:
      - name: app                   # 容器名,必须和 kubectl set image 中的对应
        image: reg.zxf.org/myapp/app:v1
        imagePullPolicy: Always     # 总是拉取最新镜像
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        readinessProbe:
          httpGet:
            path: /actuator/health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /actuator/health
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: myapp
spec:
  selector:
    app: myapp
  ports:
  - port: 80
    targetPort: 8080
  type: ClusterIP
```

关键配置:
- **`imagePullPolicy: Always`** — 即使镜像 tag 相同(如 latest),也强制拉取最新版本
- **`readinessProbe`** — 滚动更新正确工作的前提,新 Pod Ready 才进入 Endpoints
- **`strategy.maxUnavailable: 0`** — 滚动更新时始终保持期望副本数,零停机

### 5.2 首次部署

```bash
kubectl apply -f deployment.yml
deployment.apps/myapp created
service/myapp created

kubectl get pods
NAME                     READY   STATUS    AGE
myapp-6c8b4bb9d7-abc12   1/1     Running   30s
myapp-6c8b4bb9d7-def34   1/1     Running   30s
myapp-6c8b4bb9d7-ghi56   1/1     Running   30s
```

## 六、Gitee Webhook 配置

### 6.1 Jenkins 创建 Pipeline 任务

1. Jenkins → New Item → Pipeline
2. **Pipeline**:
   - Definition: Pipeline script from SCM
   - SCM: Git
   - Repository URL: `https://gitee.com/zxf/myapp.git`
   - Script Path: `Jenkinsfile`
3. **Build Triggers**:
   - 勾选 "Build when a change is pushed to Gitee"
   - 记录 Webhook URL: `http://jenkins-server:8080/gitee-webhook/`

### 6.2 Gitee 配置 Webhook

Gitee 仓库 → 管理 → WebHooks:
- **URL**: `http://jenkins-server:8080/gitee-webhook/`
- **密码**: Jenkins 生成的 webhook token
- **触发事件**: Push 事件

配置后,每次 `git push` 都会触发 Jenkins 流水线。

## 七、流水线执行验证

### 7.1 触发流水线

```bash
# 开发者提交代码
git add .
git commit -m "Update user service"
git push origin main
```

Jenkins 自动触发流水线:

```
[Pipeline] Started by Gitee push by zxf
[Pipeline] stage (Checkout)
 > git checkout ...
[Pipeline] stage (Build Image)
 > docker build -t reg.zxf.org/myapp/app:42 .
 Successfully tagged reg.zxf.org/myapp/app:42
[Pipeline] stage (Push to Harbor)
 > docker push reg.zxf.org/myapp/app:42
 Pushed: reg.zxf.org/myapp/app:42
[Pipeline] stage (Deploy to K8s)
 > kubectl set image deployment/myapp app=reg.zxf.org/myapp/app:42
 deployment.apps/myapp image updated
 > kubectl rollout status deployment/myapp
 Waiting for rollout to finish: 2 out of 3 new replicas have been updated...
 deployment "myapp" successfully rolled out
[Pipeline] stage (Health Check)
 Health check passed!
[Pipeline] Success
 Deploy success! Image: reg.zxf.org/myapp/app:42
```

### 7.2 验证 K8s 滚动更新

```bash
kubectl get pods -w
NAME                     READY   STATUS              AGE
myapp-6c8b4bb9d7-abc12   1/1     Running             5m      # 旧 Pod
myapp-6c8b4bb9d7-def34   1/1     Running             5m      # 旧 Pod
myapp-6c8b4bb9d7-ghi56   1/1     Running             5m      # 旧 Pod
myapp-7d9c5cc8e2-xxx11   0/1     ContainerCreating   0s      # 新 Pod 创建
myapp-7d9c5cc8e2-xxx11   1/1     Running             10s     # 新 Pod Ready
myapp-6c8b4bb9d7-abc12   1/1     Terminating         5m      # 旧 Pod 销毁
myapp-7d9c5cc8e2-yyy22   0/1     ContainerCreating   0s
...
myapp-7d9c5cc8e2-xxx11   1/1     Running             30s
myapp-7d9c5cc8e2-yyy22   1/1     Running             20s
myapp-7d9c5cc8e2-zzz33   1/1     Running             10s
```

滚动更新完成,3 个新 Pod 运行,旧 Pod 已销毁。

### 7.3 验证 Harbor 镜像

Harbor Web 界面 → myapp 项目 → app 仓库:
- `app:42` — 最新推送的镜像
- `app:41` — 上一个版本
- `app:latest` — 指向最新版本

每次构建都生成新 tag(BUILD_NUMBER),支持回滚到任意版本。

## 八、自动回滚机制

### 8.1 健康检查脚本

```groovy
stage('Health Check') {
    steps {
        sh '''
        # 5 分钟观察期,检查错误率
        for i in $(seq 1 30); do
            # 查询 Prometheus 5xx 错误率
            ERROR_COUNT=$(curl -s 'http://prometheus:9090/api/v1/query?query=rate(http_requests_total{status=~"5..",app="myapp"}[1m])' | jq '.data.result[0].value[1]')
            
            if [ $(echo "$ERROR_COUNT > 0.05" | bc) -eq 1 ]; then
                echo "Error rate > 5%, rolling back..."
                kubectl rollout undo deployment/myapp -n default
                exit 1
            fi
            sleep 10
        done
        echo "Health check passed!"
        '''
    }
}
```

### 8.2 回滚验证

如果新版本有问题(如 5xx 错误率 > 5%),流水线自动回滚:

```
[Pipeline] stage (Health Check)
 Error rate > 5%, rolling back...
 > kubectl rollout undo deployment/myapp
 deployment "myapp" rolled back
[Pipeline] Failed
```

K8s 立即回滚到上一个版本,用户基本无感知。

## 九、Jenkinsfile 进阶优化

### 9.1 镜像 tag 用 Git commit SHA

```groovy
environment {
    GIT_COMMIT = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
    IMAGE_TAG = "${env.BUILD_NUMBER}-${GIT_COMMIT}"
}
```

镜像 tag 包含构建号和 Git commit,方便追溯:
- `app:42-abc1234` — 第 42 次构建,对应 Git commit abc1234

### 9.2 多环境部署

```groovy
stage('Deploy') {
    steps {
        script {
            if (env.BRANCH_NAME == 'dev') {
                sh "kubectl --kubeconfig=/path/to/dev-config set image ..."
            } else if (env.BRANCH_NAME == 'main') {
                sh "kubectl --kubeconfig=/path/to/prod-config set image ..."
            }
        }
    }
}
```

dev 分支部署到测试环境,main 分支部署到生产环境。

### 9.3 构建结果通知

```groovy
post {
    success {
        dingtalk(
            robot: 'my-robot-id',
            type: 'MARKDOWN',
            title: '部署成功',
            text: "### 部署成功 ✅\n- 应用: myapp\n- 版本: ${IMAGE_TAG}\n- 构建号: ${env.BUILD_NUMBER}\n- [查看详情](${env.BUILD_URL})"
        )
    }
    failure {
        dingtalk(
            robot: 'my-robot-id',
            type: 'MARKDOWN',
            title: '部署失败',
            text: "### 部署失败 ❌\n- 应用: myapp\n- 版本: ${IMAGE_TAG}\n- [查看日志](${env.BUILD_URL})"
        )
    }
}
```

部署成功/失败都发钉钉通知,运维群实时感知。

## 十、流水线的工程价值

这套 Jenkins + Harbor + K8s 流水线的核心价值:

1. **一键部署** — `git push` 触发全流程,无需手动操作
2. **版本可追溯** — 镜像 tag 对应 Git commit,出问题能快速定位
3. **零停机更新** — K8s 滚动更新,用户无感知
4. **自动回滚** — 健康检查失败自动回滚,故障影响小
5. **环境一致** — dev/test/prod 用同一流水线,只是参数不同

在电商项目里,这套流水线让我们从"手动部署 15 分钟"变成"自动部署 3 分钟",而且每次部署都有完整的构建日志和版本记录。半年内做了 80+ 次部署,只有 2 次需要回滚,平均回滚时间 30 秒——这就是 CI/CD 的工程价值。

> CI/CD 不是"自动化部署",是"工程化发布"。它把发布从"高风险操作"变成"日常操作",让团队敢于频繁发布,快速迭代。这种能力的积累,是 DevOps 文化的基石。
