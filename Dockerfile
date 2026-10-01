# 季节年历：Python 3 标准库同时托管静态前端与 /api/*，零第三方依赖
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8090 \
    TZ=Asia/Shanghai \
    STATIC_ROOT=/app

WORKDIR /app

# 静态站点
COPY index.html courses.html plan.html resources.html profile.html about.html \
     contact.html demo.html calendar.html ./
COPY css/ ./css/
COPY js/ ./js/
# 季节年历后端与种子
COPY server/ ./server/
RUN mkdir -p /app/data

EXPOSE 8090

# 健康检查：后端健康接口
HEALTHCHECK --interval=30s --timeout=3s CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/api/health',timeout=2).status==200 else 1)"

CMD ["python3", "server/app.py"]
