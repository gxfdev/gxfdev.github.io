/**
 * gxfdev Blog - 核心逻辑 v4
 * 极光背景 / 粒子系统 / 光标追踪 / 打字机 / 技能动画
 * 数字跳动 / 视差滚动 / 波纹点击 / 路由 / 搜索 / 主题
 */
(function () {
  'use strict';

  // ====== 工具 ======
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function formatDate(d) {
    var dt = new Date(d);
    return dt.getFullYear() + '.' + String(dt.getMonth() + 1).padStart(2, '0') + '.' + String(dt.getDate()).padStart(2, '0');
  }

  function getYearMonth(d) { return d.substring(0, 7); }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function highlightText(t, q) { return q ? t.replace(new RegExp('(' + escapeRegex(q) + ')', 'gi'), '<mark>$1</mark>') : t; }

  function estimateReadingTime(text) {
    var cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    var en = text.replace(/[\u4e00-\u9fa5]/g, '').split(/\s+/).filter(function (w) { return w.length > 0; }).length;
    var minutes = Math.ceil((cn / 400 + en / 200));
    if (minutes < 1) return '1 分钟';
    return minutes + ' 分钟';
  }

  function getWordCount(text) {
    var cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    var en = text.replace(/[\u4e00-\u9fa5]/g, '').split(/\s+/).filter(function (w) { return w.length > 0; }).length;
    return cn + en;
  }

  // ====== 光标追踪光效 ======
  function initCursorGlow() {
    var glow = document.getElementById('cursor-glow');
    if (!glow) return;
    var mouseX = 0, mouseY = 0, glowX = 0, glowY = 0;
    var isTouchDevice = 'ontouchstart' in window;

    if (isTouchDevice) {
      glow.style.display = 'none';
      return;
    }

    document.addEventListener('mousemove', function (e) {
      mouseX = e.clientX;
      mouseY = e.clientY;
      if (!glow.classList.contains('active')) glow.classList.add('active');
    });

    document.addEventListener('mouseleave', function () {
      glow.classList.remove('active');
    });

    function animateGlow() {
      glowX += (mouseX - glowX) * 0.1;
      glowY += (mouseY - glowY) * 0.1;
      glow.style.left = glowX + 'px';
      glow.style.top = glowY + 'px';
      requestAnimationFrame(animateGlow);
    }
    animateGlow();
  }

  // ====== 粒子系统（升级版） ======
  function initParticles() {
    var canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var particles = [];
    var mouse = { x: -999, y: -999 };
    var animId;
    var time = 0;

    function resize() {
      var hero = document.getElementById('hero');
      if (!hero) return;
      canvas.width = hero.offsetWidth;
      canvas.height = hero.offsetHeight;
    }

    function createParticle() {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      var colors = isDark
        ? ['129,140,248', '167,139,250', '244,114,182']
        : ['99,102,241', '139,92,246', '168,85,247'];
      return {
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.6,
        vy: (Math.random() - 0.5) * 0.6,
        r: Math.random() * 2.5 + 0.8,
        alpha: Math.random() * 0.5 + 0.2,
        color: colors[Math.floor(Math.random() * colors.length)],
        pulse: Math.random() * Math.PI * 2,
        pulseSpeed: Math.random() * 0.02 + 0.01
      };
    }

    function init() {
      resize();
      particles = [];
      var count = Math.min(Math.floor(canvas.width * canvas.height / 6000), 100);
      for (var i = 0; i < count; i++) particles.push(createParticle());
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      var lineColors = isDark
        ? ['129,140,248', '167,139,250', '244,114,182']
        : ['99,102,241', '139,92,246', '168,85,247'];
      time += 0.01;

      // Draw connections
      for (var i = 0; i < particles.length; i++) {
        for (var j = i + 1; j < particles.length; j++) {
          var dx = particles[i].x - particles[j].x;
          var dy = particles[i].y - particles[j].y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 140) {
            var opacity = 0.15 * (1 - dist / 140);
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = 'rgba(' + lineColors[i % 3] + ',' + opacity + ')';
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }

      // Draw & update particles
      for (var k = 0; k < particles.length; k++) {
        var p = particles[k];
        p.pulse += p.pulseSpeed;
        var pulseFactor = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(p.pulse));

        // Mouse interaction
        var mdx = p.x - mouse.x;
        var mdy = p.y - mouse.y;
        var mDist = Math.sqrt(mdx * mdx + mdy * mdy);
        if (mDist < 120) {
          var force = (120 - mDist) / 120 * 0.03;
          p.vx += mdx * force;
          p.vy += mdy * force;
        }

        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.985;
        p.vy *= 0.985;

        // Add slight drift
        p.vx += Math.sin(time + k) * 0.003;
        p.vy += Math.cos(time + k * 0.7) * 0.003;

        // Wrap around
        if (p.x < -10) p.x = canvas.width + 10;
        if (p.x > canvas.width + 10) p.x = -10;
        if (p.y < -10) p.y = canvas.height + 10;
        if (p.y > canvas.height + 10) p.y = -10;

        // Draw glow
        var gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        gradient.addColorStop(0, 'rgba(' + p.color + ',' + (p.alpha * pulseFactor * 0.6) + ')');
        gradient.addColorStop(1, 'rgba(' + p.color + ',0)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Draw core
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * pulseFactor, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + p.color + ',' + (p.alpha * pulseFactor) + ')';
        ctx.fill();
      }

      animId = requestAnimationFrame(draw);
    }

    // Mouse tracking on hero
    var hero = document.getElementById('hero');
    if (hero) {
      hero.addEventListener('mousemove', function (e) {
        var rect = canvas.getBoundingClientRect();
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
      });
      hero.addEventListener('mouseleave', function () {
        mouse.x = -999;
        mouse.y = -999;
      });
    }

    window.addEventListener('resize', function () {
      clearTimeout(window._particleResize);
      window._particleResize = setTimeout(function () { resize(); }, 200);
    });

    init();
    draw();
  }

  // ====== GitHub 项目自动同步 ======
  var GITHUB_USERNAME = 'gxfdev';
  var FALLBACK_PROJECTS = [
    { name: 'shell-scripts', desc: 'Shell 脚本自动化运维，涵盖服务器巡检、服务管理、日志分析等常用运维场景', icon: '🖥️' },
    { name: 'monitoring-playbook', desc: 'Prometheus + Grafana 监控实战手册：从零搭建、配置运行、指标采集到告警规则', icon: '📊' },
    { name: 'ops-toolkit', desc: 'Python 自动运维工具集：定时备份、日志清理、健康检查等运维脚本，开箱即用', icon: '🛠️' },
    { name: 'docker-install-scripts', desc: 'Linux 系统 Docker 一键安装脚本，支持多发行版，开箱即用', icon: '🐳' },
    { name: 'jenkins-learning', desc: 'Jenkins CI/CD 流水线 · DevOps 学习笔记与实战配置', icon: '🔄' },
    { name: 'CSPostgraduate-408', desc: '计算机考研408科目学习资料汇总', icon: '📚' },
    { name: 'Pet-Service-System', desc: '基于 Spring Boot + Vue.js 的全栈宠物服务系统', icon: '🐾' },
    { name: 'library-management-system', desc: '企业级图书管理系统（Spring Boot 3 + Vue 3 + TypeScript + MySQL）', icon: '📖' },
    { name: 'cicd-pipeline-train-schedule-autodeploy', desc: '自动化部署流水线项目，CI/CD 自动部署实践', icon: '🚀' }
  ];

  var PROJECT_ICONS = {
    'python': '🐍','javascript':'🟨','typescript':'💙','java':'☕','go':'🔵','rust':'🦀',
    'c':'⚙️','cpp':'⚙️','c#':'💜','php':'🐘','ruby':'💎','swift':'🍎','kotlin':'🟣',
    'shell':'🖥️','dockerfile':'🐳','html':'🌐','css':'🎨','vue':'💚','react':'⚛️',
    'spring':'🌱','nginx':'🔥','mysql':'🗄️','linux':'🐧','default':'📁'
  };

  function getProjectIcon(lang) {
    if (!lang) return '📁';
    var l = lang.toLowerCase();
    for (var key in PROJECT_ICONS) {
      if (l.indexOf(key) !== -1) return PROJECT_ICONS[key];
    }
    return '📁';
  }

  function timeAgo(dateStr) {
    var now = new Date();
    var date = new Date(dateStr);
    var diff = Math.floor((now - date) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
    if (diff < 31536000) return Math.floor(diff / 2592000) + ' 个月前';
    return Math.floor(diff / 31536000) + ' 年前';
  }

  function renderProjects(repos) {
    var container = document.getElementById('project-list');
    if (!container) return;
    if (!repos || !repos.length) {
      container.innerHTML = '<div class="search-empty">暂无项目</div>';
      return;
    }
    var html = '';
    repos.forEach(function (repo, i) {
      var desc = repo.description || '暂无描述';
      var lang = repo.language || '';
      var icon = getProjectIcon(lang);
      var stars = repo.stargazers_count || 0;
      var forks = repo.forks_count || 0;
      var updated = repo.updated_at ? timeAgo(repo.updated_at) : '';
      html += '<a href="' + escapeHtml(repo.html_url) + '" rel="noopener noreferrer" class="project-card animate-in" style="transition-delay:' + (i * 0.06) + 's">';
      html += '<div class="project-icon">' + icon + '</div>';
      html += '<div class="project-info">';
      html += '<div class="project-name">' + escapeHtml(repo.name.replace(/[-_]/g, ' ')) + '</div>';
      html += '<div class="project-desc">' + escapeHtml(desc) + '</div>';
      html += '<div class="project-meta-row">';
      if (lang) html += '<span class="project-lang"><span class="lang-dot" style="background:' + getLangColor(lang) + '"></span>' + escapeHtml(lang) + '</span>';
      if (stars > 0) html += '<span class="project-stat">⭐ ' + stars + '</span>';
      if (forks > 0) html += '<span class="project-stat">🍴 ' + forks + '</span>';
      if (updated) html += '<span class="project-updated">更新于 ' + updated + '</span>';
      html += '</div></div>';
      html += '<svg class="project-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>';
    });
    container.innerHTML = html;
    observeNewElements();
  }

  function getLangColor(lang) {
    var colors = {
      'Python':'#3572A5','JavaScript':'#f1e05a','TypeScript':'#3178c6','Java':'#b07219',
      'Go':'#00ADD8','Rust':'#dea584','C':'#555555','C++':'#f34b7d','C#':'#239120',
      'PHP':'#4F5D95','Ruby':'#701516','Shell':'#89e051','Dockerfile':'#384d54',
      'HTML':'#e34c26','CSS':'#563d7c','Vue':'#41b883','React':'#61dafb'
    };
    return colors[lang] || '#8b949e';
  }

  var githubRefreshTimer = null;
  var githubLastUpdated = null;

  function loadGitHubProjects(forceRefresh) {
    if (githubRefreshTimer) { clearTimeout(githubRefreshTimer); githubRefreshTimer = null; }

    var refreshBtn = document.getElementById('github-refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('loading');

    if (!forceRefresh) {
      var container = document.getElementById('project-list');
      if (container && !container.querySelector('.project-card')) {
        container.innerHTML = '<div class="projects-loading">加载中...</div>';
      }
    }

    fetch('https://api.github.com/users/' + GITHUB_USERNAME + '/repos?sort=updated&per_page=20&type=owner')
      .then(function (r) {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(function (repos) {
        var filtered = repos.filter(function (r) { return !r.fork; });
        filtered.sort(function (a, b) { return (b.stargazers_count || 0) - (a.stargazers_count || 0); });
        renderProjects(filtered);
        githubLastUpdated = new Date();
        updateGithubRefreshTime();
      })
      .catch(function () {
        var fallback = FALLBACK_PROJECTS.map(function (p) {
          return { name: p.name, description: p.desc, html_url: 'https://github.com/' + GITHUB_USERNAME + '/' + p.name, language: '', stargazers_count: 0, forks_count: 0 };
        });
        renderProjects(fallback);
        githubLastUpdated = new Date();
        updateGithubRefreshTime();
      })
      .then(function () {
        if (refreshBtn) refreshBtn.classList.remove('loading');
        githubRefreshTimer = setTimeout(function () { loadGitHubProjects(true); }, 300000);
      });
  }

  function updateGithubRefreshTime() {
    var el = document.getElementById('github-last-updated');
    if (el && githubLastUpdated) {
      el.textContent = '最后更新: ' + githubLastUpdated.toLocaleTimeString('zh-CN');
    }
  }

  function initGithubRefreshButton() {
    var btn = document.getElementById('github-refresh-btn');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', function () { loadGitHubProjects(true); });
    }
  }

  // ====== 打字机效果 ======
  function initTypingEffect() {
    var el = document.getElementById('hero-typing');
    var bioEl = document.getElementById('hero-bio');
    if (!el) return;

    var texts = ['古晓锋', 'gxfdev'];
    var bioText = '热爱钻研技术，主攻网络与信息安全，用代码解决实际问题';
    var textIndex = 0;
    var charIndex = 0;
    var isDeleting = false;
    var typingSpeed = 120;

    function type() {
      var currentText = texts[textIndex];

      if (isDeleting) {
        el.textContent = currentText.substring(0, charIndex - 1);
        charIndex--;
        typingSpeed = 60;
      } else {
        el.textContent = currentText.substring(0, charIndex + 1);
        charIndex++;
        typingSpeed = 150;
      }

      if (!isDeleting && charIndex === currentText.length) {
        typingSpeed = 2000;
        isDeleting = true;
      } else if (isDeleting && charIndex === 0) {
        isDeleting = false;
        textIndex = (textIndex + 1) % texts.length;
        typingSpeed = 400;
      }

      setTimeout(type, typingSpeed);
    }

    // Type bio
    var bioCharIndex = 0;
    function typeBio() {
      if (bioCharIndex < bioText.length) {
        bioEl.textContent = bioText.substring(0, bioCharIndex + 1);
        bioCharIndex++;
        setTimeout(typeBio, 40);
      }
    }

    setTimeout(function () { type(); }, 800);
    setTimeout(function () { typeBio(); }, 1500);
  }

  // ====== 数字跳动动画 ======
  function initCountUp() {
    var statNumbers = document.querySelectorAll('.stat-number[data-count]');
    statNumbers.forEach(function (el) {
      var target = parseInt(el.getAttribute('data-count'), 10);
      var duration = 1500;
      var startTime = null;

      function animate(currentTime) {
        if (!startTime) startTime = currentTime;
        var progress = Math.min((currentTime - startTime) / duration, 1);
        var eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        el.textContent = Math.floor(eased * target);
        if (progress < 1) requestAnimationFrame(animate);
        else el.textContent = target;
      }

      setTimeout(function () { requestAnimationFrame(animate); }, 1200);
    });
  }

  // ====== 技能条动画 ======
  function initSkillBars() {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var items = entry.target.querySelectorAll('.skill-bar-item');
          items.forEach(function (item, index) {
            var level = item.getAttribute('data-level');
            var fill = item.querySelector('.skill-fill');
            if (fill) {
              fill.style.setProperty('--fill-width', level + '%');
              setTimeout(function () {
                item.classList.add('animated');
              }, index * 150);
            }
          });
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.2 });

    var container = document.querySelector('.skills-container');
    if (container) observer.observe(container);
  }

  // ====== 滚动入场动画 ======
  function initScrollAnimations() {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.animate-in').forEach(function (el) {
      observer.observe(el);
    });
    window._scrollObserver = observer;
  }

  function observeNewElements() {
    if (!window._scrollObserver) initScrollAnimations();
    document.querySelectorAll('.post-card, .archive-item, .archive-group').forEach(function (el) {
      if (!el.classList.contains('animate-in')) {
        el.classList.add('animate-in');
        window._scrollObserver.observe(el);
      }
    });
    // Force visible for elements already in viewport after page switch
    // Multiple rounds to handle layout timing after display:none -> display:block
    function forceVisible() {
      document.querySelectorAll('.animate-in:not(.visible)').forEach(function (el) {
        var rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight + 50 && rect.bottom > -50) {
          el.classList.add('visible');
        }
      });
    }
    setTimeout(forceVisible, 30);
    setTimeout(forceVisible, 100);
    setTimeout(forceVisible, 250);
    setTimeout(forceVisible, 500);
  }

  // ====== 导航栏滚动效果 ======
  function initHeaderScroll() {
    var header = document.getElementById('site-header');
    var scrollHint = document.getElementById('scroll-hint');
    window.addEventListener('scroll', function () {
      header.classList.toggle('scrolled', window.scrollY > 20);
      if (scrollHint) scrollHint.classList.toggle('hidden', window.scrollY > 100);
    }, { passive: true });
  }

  // ====== 状态 ======
  var allPosts = [];
  var postsCache = {};
  var navToken = 0;

  // ====== 主题 ======
  var themeToggle = document.getElementById('theme-toggle');
  var lightHLJS = document.getElementById('hljs-light-theme');
  var darkHLJS = document.getElementById('hljs-dark-theme');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    if (theme === 'dark') { lightHLJS.disabled = true; darkHLJS.disabled = false; }
    else { lightHLJS.disabled = false; darkHLJS.disabled = true; }
  }

  function initTheme() {
    var saved = localStorage.getItem('theme');
    if (saved) applyTheme(saved);
    else applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  themeToggle.addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    if (!localStorage.getItem('theme')) applyTheme(e.matches ? 'dark' : 'light');
  });

  initTheme();

  // ====== 移动端菜单 ======
  var mobileMenuToggle = document.getElementById('mobile-menu-toggle');
  var siteNav = document.getElementById('site-nav');
  mobileMenuToggle.addEventListener('click', function () { siteNav.classList.toggle('open'); });
  siteNav.querySelectorAll('a[data-nav]').forEach(function (l) {
    l.addEventListener('click', function () { siteNav.classList.remove('open'); });
  });

  // ====== 阅读进度 ======
  var progressBar = document.getElementById('reading-progress');
  function updateProgress() {
    var pagePost = document.getElementById('page-post');
    if (pagePost.classList.contains('hidden')) { progressBar.style.width = '0'; return; }
    var content = document.getElementById('post-content');
    if (!content) return;
    var total = content.scrollHeight;
    var visible = window.innerHeight;
    var scrolled = -content.getBoundingClientRect().top;
    progressBar.style.width = (Math.min(Math.max(scrolled / (total - visible), 0), 1) * 100) + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });

  // ====== 回到顶部 ======
  var backToTop = document.getElementById('back-to-top');
  window.addEventListener('scroll', function () { backToTop.classList.toggle('visible', window.scrollY > 400); }, { passive: true });
  backToTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // ====== 搜索 ======
  var searchToggle = document.getElementById('search-toggle');
  var searchOverlay = document.getElementById('search-overlay');
  var searchBackdrop = document.getElementById('search-backdrop');
  var searchInput = document.getElementById('search-input');
  var searchResults = document.getElementById('search-results');

  function openSearch() { searchOverlay.classList.remove('hidden'); searchInput.value = ''; searchResults.innerHTML = ''; setTimeout(function () { searchInput.focus(); }, 80); }
  function closeSearch() { searchOverlay.classList.add('hidden'); }
  searchToggle.addEventListener('click', openSearch);
  searchBackdrop.addEventListener('click', closeSearch);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape' && !searchOverlay.classList.contains('hidden')) closeSearch();
  });

  var searchTimer = null;
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { performSearch(searchInput.value.trim()); }, 150);
  });

  function performSearch(query) {
    if (!query) { searchResults.innerHTML = ''; return; }
    var lq = query.toLowerCase();
    var results = allPosts.filter(function (p) {
      return p.title.toLowerCase().indexOf(lq) !== -1 ||
        p.summary.toLowerCase().indexOf(lq) !== -1 ||
        (postsCache[p.id] && postsCache[p.id].toLowerCase().indexOf(lq) !== -1);
    });
    if (!results.length) { searchResults.innerHTML = '<div class="search-empty">没有找到相关文章</div>'; return; }
    searchResults.innerHTML = results.map(function (p) {
      return '<div class="search-result-item" data-id="' + escapeHtml(p.id) + '"><div class="search-result-title">' + escapeHtml(p.title) + '</div><div class="search-result-summary">' + highlightText(escapeHtml(p.summary), query) + '</div></div>';
    }).join('');
    searchResults.querySelectorAll('.search-result-item').forEach(function (item) {
      item.addEventListener('click', function () { closeSearch(); window.location.hash = '#/post/' + item.getAttribute('data-id'); });
    });
  }

  // ====== 导航来源追踪 ======
  var navSource = 'home';

  // ====== 路由 ======
  function navigate() {
    navToken++;
    var hash = window.location.hash || '#/';
    var parts = hash.replace('#', '').split('/').filter(Boolean);
    siteNav.classList.remove('open');

    // Clear post content when leaving post detail page to prevent stale DOM
    if (!(parts[0] === 'post' && parts[1])) {
      var oldContent = document.getElementById('post-content');
      if (oldContent) oldContent.innerHTML = '';
      var tocC = document.getElementById('toc-container');
      var tocS = document.getElementById('toc-sidebar');
      if (tocC) { tocC.classList.add('hidden'); tocC.innerHTML = ''; }
      if (tocS) { tocS.classList.add('hidden'); tocS.innerHTML = ''; }
    }

    if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
      navSource = 'home';
      homePage = 1;
      document.title = "gxfdev's Blog";
      showPage('home');
      if (allPosts.length) { renderPostList(allPosts, homePage); }
      else { document.getElementById('post-list').innerHTML = '<div class="search-empty">文章加载中...</div>'; }
      setActiveNav('home');
    } else if (parts[0] === 'post' && parts[1]) {
      showPage('post'); renderPostDetail(parts[1]); setActiveNav('');
    } else if (parts[0] === 'archives') {
      navSource = 'archives';
      archivePage = 1;
      document.title = '归档 - gxfdev Blog';
      showPage('archives'); renderArchives(archivePage); setActiveNav('archives');
    } else if (parts[0] === 'tags') {
      document.title = '标签 - gxfdev Blog';
      showPage('tags'); if (parts[1]) renderTagPosts(decodeURIComponent(parts[1])); else renderTagCloud(); setActiveNav('tags');
    } else if (parts[0] === 'about') {
      document.title = '关于 - gxfdev Blog';
      showPage('about'); setActiveNav('about');
      setTimeout(initSkillBars, 300);
      setTimeout(function () { loadGitHubProjects(false); }, 200);
      initGithubRefreshButton();
    } else {
      document.title = '404 - gxfdev Blog';
      showPage('404'); setActiveNav('');
    }
    window.scrollTo(0, 0);
    progressBar.style.width = '0';
    // Observe new elements after a short delay to allow DOM to settle
    observeNewElements();
    setTimeout(observeNewElements, 200);
  }

  function showPage(name) {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.add('hidden'); });
    var t = document.getElementById('page-' + name);
    if (t) t.classList.remove('hidden');
  }

  function setActiveNav(name) {
    document.querySelectorAll('.site-nav a[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === name);
    });
  }

  window.addEventListener('hashchange', navigate);

  // ====== 首页文章列表 ======
  var homePage = 1;
  var homePerPage = 6;

  function renderPostList(posts, page) {
    if (page === undefined) page = 1;
    homePage = page;
    var list = document.getElementById('post-list');
    var paginationEl = document.getElementById('home-pagination');
    if (!posts.length) { list.innerHTML = '<div class="search-empty">暂无文章</div>'; if (paginationEl) paginationEl.innerHTML = ''; return; }
    var totalPages = Math.ceil(posts.length / homePerPage);
    var start = (page - 1) * homePerPage;
    var pagePosts = posts.slice(start, start + homePerPage);
    list.innerHTML = pagePosts.map(function (p, i) {
      var tags = p.tags.map(function (t) { return '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'; }).join('');
      var cached = postsCache[p.id];
      var readTime = cached ? estimateReadingTime(cached) : '';
      var timeHtml = readTime ? '<span class="post-card-time"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ' + readTime + '</span>' : '';
      return '<article class="post-card animate-in" style="transition-delay:' + (i * 0.08) + 's"><h2 class="post-card-title"><a href="#/post/' + escapeHtml(p.id) + '">' + escapeHtml(p.title) + '</a></h2><div class="post-card-meta"><span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ' + escapeHtml(formatDate(p.date)) + '</span>' + timeHtml + '</div><p class="post-card-summary">' + escapeHtml(p.summary) + '</p><div class="post-card-footer"><div class="post-card-tags">' + tags + '</div><a href="#/post/' + escapeHtml(p.id) + '" class="read-more">阅读全文 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></a></div></article>';
    }).join('');
    bindTagClicks(list);
    observeNewElements();
    renderPagination(paginationEl, page, totalPages, function (p) { renderPostList(posts, p); window.scrollTo({ top: document.querySelector('.section-header').offsetTop - 80, behavior: 'smooth' }); });
  }

  function renderPagination(container, current, total, callback) {
    if (!container || total <= 1) { if (container) container.innerHTML = ''; return; }
    var html = '<div class="pagination">';
    html += '<button class="page-btn prev' + (current <= 1 ? ' disabled' : '') + '" data-page="' + (current - 1) + '"' + (current <= 1 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>';
    for (var i = 1; i <= total; i++) {
      if (total > 7) {
        if (i === 1 || i === total || (i >= current - 1 && i <= current + 1)) {
          html += '<button class="page-btn' + (i === current ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
        } else if (i === current - 2 || i === current + 2) {
          html += '<span class="page-ellipsis">...</span>';
        }
      } else {
        html += '<button class="page-btn' + (i === current ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
      }
    }
    html += '<button class="page-btn next' + (current >= total ? ' disabled' : '') + '" data-page="' + (current + 1) + '"' + (current >= total ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>';
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.page-btn:not(.disabled)').forEach(function (btn) {
      btn.addEventListener('click', function () { var p = parseInt(btn.getAttribute('data-page'), 10); if (p >= 1 && p <= total) callback(p); });
    });
  }

  function bindTagClicks(container) {
    container.querySelectorAll('.tag[data-tag]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); window.location.hash = '#/tags/' + encodeURIComponent(el.getAttribute('data-tag')); });
    });
  }

  // ====== 文章详情 ======
  function renderPostDetail(postId) {
    var post = allPosts.find(function (p) { return p.id === postId; });
    if (!post) { showPage('404'); return; }
    document.getElementById('post-title').textContent = post.title;
    document.getElementById('post-date').querySelector('span').textContent = formatDate(post.date);
    document.getElementById('post-author').querySelector('span').textContent = post.author;
    var tagsC = document.getElementById('post-tags');
    tagsC.innerHTML = post.tags.map(function (t) { return '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'; }).join('');
    bindTagClicks(tagsC);
    var backLinkEl = document.querySelector('.back-link');
    if (backLinkEl) {
      var backText = navSource === 'archives' ? '返回归档' : '返回首页';
      var backHash = navSource === 'archives' ? '#/archives' : '#/';
      backLinkEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> ' + backText;
      backLinkEl.href = backHash;
    }
    var contentEl = document.getElementById('post-content');
    if (postsCache[postId]) {
      renderMarkdown(postsCache[postId], contentEl);
      updatePostMeta(postId, postsCache[postId]);
    } else {
      var token = navToken;
      contentEl.innerHTML = '<div class="search-empty">加载中...</div>';
      fetch(post.file).then(function (r) { if (!r.ok) throw new Error(); return r.text(); }).then(function (t) {
        if (token !== navToken) return;
        postsCache[postId] = t;
        renderMarkdown(t, contentEl);
        updatePostMeta(postId, t);
      }).catch(function () { if (token !== navToken) return; contentEl.innerHTML = '<div class="search-empty">文章内容加载失败</div>'; });
    }
    renderPostNav(postId);
    document.title = post.title + ' - gxfdev Blog';
  }

  function updatePostMeta(postId, rawText) {
    var readingTimeEl = document.getElementById('post-reading-time');
    var wordCountEl = document.getElementById('post-word-count');
    if (readingTimeEl) readingTimeEl.textContent = estimateReadingTime(rawText);
    if (wordCountEl) wordCountEl.textContent = getWordCount(rawText).toLocaleString();
  }

  function renderMarkdown(raw, container) {
    if (typeof marked === 'undefined') { container.innerHTML = '<p>Markdown 引擎加载失败</p>'; return; }
    marked.setOptions({ breaks: true, gfm: true, headerIds: true, mangle: false });
    container.innerHTML = marked.parse(raw);
    if (typeof hljs !== 'undefined') container.querySelectorAll('pre code').forEach(function (b) { hljs.highlightElement(b); });
    sanitizeContent(container);
    buildTOC(container);
    addCodeCopyButtons(container);
  }

  function addCodeCopyButtons(container) {
    container.querySelectorAll('pre').forEach(function (pre) {
      if (pre.querySelector('.code-copy-btn')) return;
      var btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = '复制';
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = code ? code.textContent : pre.textContent;
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = '已复制!';
          btn.classList.add('copied');
          setTimeout(function () { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000);
        }).catch(function () {
          var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); btn.textContent = '已复制!'; btn.classList.add('copied'); setTimeout(function () { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000); } catch (e) { btn.textContent = '失败'; }
          document.body.removeChild(ta);
        });
      });
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }

  function buildTOC(container) {
    var tocContainer = document.getElementById('toc-container');
    var tocSidebar = document.getElementById('toc-sidebar');
    if (!tocContainer && !tocSidebar) return;
    var headings = container.querySelectorAll('h2, h3');
    if (headings.length < 3) {
      if (tocContainer) tocContainer.classList.add('hidden');
      if (tocSidebar) tocSidebar.classList.add('hidden');
      return;
    }
    var html = '<div class="toc-title">目录</div><ul>';
    headings.forEach(function (h, i) {
      var id = 'heading-' + i;
      h.id = id;
      var indent = h.tagName === 'H3' ? ' toc-indent' : '';
      html += '<li class="toc-item' + indent + '"><a href="#' + id + '">' + escapeHtml(h.textContent) + '</a></li>';
    });
    html += '</ul>';
    if (tocContainer) {
      tocContainer.innerHTML = html;
      tocContainer.classList.remove('hidden');
    }
    if (tocSidebar) {
      tocSidebar.innerHTML = html;
      tocSidebar.classList.remove('hidden');
    }
    [tocContainer, tocSidebar].forEach(function (tc) {
      if (!tc) return;
      tc.querySelectorAll('.toc-item a').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var target = document.getElementById(a.getAttribute('href').substring(1));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          tc.querySelectorAll('.toc-item').forEach(function (item) { item.classList.remove('active'); });
          a.parentElement.classList.add('active');
        });
      });
    });
  }

  function sanitizeContent(c) {
    c.querySelectorAll('script').forEach(function (s) { s.remove(); });
    c.querySelectorAll('*').forEach(function (el) { for (var i = el.attributes.length - 1; i >= 0; i--) { if (el.attributes[i].name.indexOf('on') === 0) el.removeAttribute(el.attributes[i].name); } });
    c.querySelectorAll('iframe').forEach(function (f) { var src = f.getAttribute('src') || ''; if (src && src.indexOf('https://') !== 0) f.removeAttribute('src'); });
  }

  function renderPostNav(postId) {
    var prevEl = document.getElementById('prev-post'), nextEl = document.getElementById('next-post');
    var sorted = allPosts.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    var idx = sorted.findIndex(function (p) { return p.id === postId; });
    if (idx < sorted.length - 1) { var prev = sorted[idx + 1]; prevEl.href = '#/post/' + prev.id; prevEl.querySelector('.nav-title').textContent = prev.title; prevEl.classList.remove('empty'); } else prevEl.classList.add('empty');
    if (idx > 0) { var next = sorted[idx - 1]; nextEl.href = '#/post/' + next.id; nextEl.querySelector('.nav-title').textContent = next.title; nextEl.classList.remove('empty'); } else nextEl.classList.add('empty');
  }

  // ====== 归档 ======
  var archivePage = 1;
  var archivePerPage = 10;

  function renderArchives(page) {
    if (page === undefined) page = 1;
    archivePage = page;
    var container = document.getElementById('archives-list');
    var paginationEl = document.getElementById('archive-pagination');
    var sorted = allPosts.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    var totalCount = sorted.length;
    var yearCount = {};
    sorted.forEach(function (p) { var y = p.date.substring(0, 4); yearCount[y] = (yearCount[y] || 0) + 1; });
    var statsHtml = '<div class="archive-stats">共 <strong>' + totalCount + '</strong> 篇文章' + Object.keys(yearCount).sort(function (a, b) { return b.localeCompare(a); }).map(function (y) { return '<span class="archive-year-stat">' + escapeHtml(y) + ' 年 ' + yearCount[y] + ' 篇</span>'; }).join('') + '</div>';
    var totalPages = Math.ceil(sorted.length / archivePerPage);
    var start = (page - 1) * archivePerPage;
    var pagePosts = sorted.slice(start, start + archivePerPage);
    var groups = {};
    pagePosts.forEach(function (p) { var ym = getYearMonth(p.date); if (!groups[ym]) groups[ym] = []; groups[ym].push(p); });
    var listHtml = Object.keys(groups).sort(function (a, b) { return b.localeCompare(a); }).map(function (ym) {
      var parts = ym.split('-');
      var groupPosts = groups[ym];
      var items = groupPosts.map(function (p) { return '<div class="archive-item animate-in"><span class="archive-date">' + escapeHtml(p.date.substring(5)) + '</span><a href="#/post/' + escapeHtml(p.id) + '" class="archive-title">' + escapeHtml(p.title) + '</a><div class="archive-item-tags">' + p.tags.map(function (t) { return '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'; }).join('') + '</div></div>'; }).join('');
      return '<div class="archive-group animate-in"><h2>' + escapeHtml(parts[0]) + ' 年 ' + parseInt(parts[1], 10) + ' 月 <span class="archive-count">' + groupPosts.length + ' 篇</span></h2>' + items + '</div>';
    }).join('');
    container.innerHTML = statsHtml + listHtml;
    bindTagClicks(container);
    observeNewElements();
    renderPagination(paginationEl, page, totalPages, function (p) { renderArchives(p); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  // ====== 标签云 ======
  function renderTagCloud() {
    var cloudEl = document.getElementById('tag-cloud'), tagPostsEl = document.getElementById('tag-posts');
    tagPostsEl.classList.add('hidden');
    var tagCount = {};
    allPosts.forEach(function (p) { p.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; }); });
    var maxC = Math.max.apply(null, Object.values(tagCount)), minC = Math.min.apply(null, Object.values(tagCount));
    cloudEl.innerHTML = Object.keys(tagCount).sort().map(function (t) {
      var c = tagCount[t], s = 'size-md';
      if (maxC > minC) { var r = (c - minC) / (maxC - minC); if (r > 0.66) s = 'size-lg'; else if (r <= 0.33) s = 'size-sm'; }
      return '<span class="tag ' + s + '" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + ' <span style="opacity:0.5">' + c + '</span></span>';
    }).join('');
    cloudEl.querySelectorAll('.tag[data-tag]').forEach(function (el) { el.addEventListener('click', function () { window.location.hash = '#/tags/' + encodeURIComponent(el.getAttribute('data-tag')); }); });
  }

  function renderTagPosts(tag) {
    document.getElementById('tag-posts-title').textContent = tag;
    document.getElementById('tag-posts').classList.remove('hidden');
    renderPostListInto(allPosts.filter(function (p) { return p.tags.indexOf(tag) !== -1; }).sort(function (a, b) { return b.date.localeCompare(a.date); }), document.getElementById('tag-posts-list'));
  }

  function renderPostListInto(posts, container) {
    if (!posts.length) { container.innerHTML = '<div class="search-empty">该标签下暂无文章</div>'; return; }
    container.innerHTML = posts.map(function (p) {
      var tags = p.tags.map(function (t) { return '<span class="tag" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'; }).join('');
      var cached = postsCache[p.id];
      var readTime = cached ? estimateReadingTime(cached) : '';
      var timeHtml = readTime ? '<span class="post-card-time"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ' + readTime + '</span>' : '';
      return '<article class="post-card animate-in"><h2 class="post-card-title"><a href="#/post/' + escapeHtml(p.id) + '">' + escapeHtml(p.title) + '</a></h2><div class="post-card-meta"><span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ' + escapeHtml(formatDate(p.date)) + '</span>' + timeHtml + '</div><p class="post-card-summary">' + escapeHtml(p.summary) + '</p><div class="post-card-footer"><div class="post-card-tags">' + tags + '</div><a href="#/post/' + escapeHtml(p.id) + '" class="read-more">阅读全文 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></a></div></article>';
    }).join('');
    bindTagClicks(container);
    observeNewElements();
  }

  // ====== 初始化 ======
  function init() {
    fetch('posts.json')
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (data) {
        allPosts = data;
        preloadPosts();
        navigate();
        initParticles();
        initCursorGlow();
        initTypingEffect();
        initCountUp();
        initSkillBars();
        initScrollAnimations();
        initHeaderScroll();
        loadGitHubProjects();
      })
      .catch(function () {
        document.getElementById('post-list').innerHTML = '<div class="search-empty">文章数据加载失败</div>';
      });
  }

  function preloadPosts() {
    allPosts.forEach(function (p) {
      fetch(p.file).then(function (r) { return r.text(); }).then(function (t) { postsCache[p.id] = t; }).catch(function () {});
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
