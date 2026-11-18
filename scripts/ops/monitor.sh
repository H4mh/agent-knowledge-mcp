#!/usr/bin/env bash
# akm-monitor.sh — 轻量监控：服务健康 + 向量链路，异常/恢复边沿告警
# 部署：/opt/akm-monitor/monitor.sh，crontab 每 5 分钟：
#   */5 * * * * /opt/akm-monitor/monitor.sh >> /var/log/akm-monitor-cron.log 2>&1
# 可选 webhook：/opt/akm-monitor/webhook.env 里写 WEBHOOK_URL=...（钉钉/企业微信
#   机器人 text 格式通用；未配置则只记日志）
set -uo pipefail

LOG=/var/log/akm-monitor.log
STATE=/opt/akm-monitor/monitor.state
WEBHOOK_ENV=/opt/akm-monitor/webhook.env
TIMEOUT=10

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 1) 服务健康：/api/stats 非 200 即异常
health_ok=0
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" http://127.0.0.1:3000/api/stats || true)
[ "$code" = "200" ] && health_ok=1

# 2) 向量链路：容器内向 embedding 服务发一次真实 embed 请求
#    （未配置向量时此检查失败不判异常——AKM_EMBEDDING_URL 未启用则跳过）
#    URL/密钥/模型一律先从容器 printenv 读出，再以 -e 名=值 显式传回——
#    不能写裸 `-e VAR`：cron 宿主机未设该变量时 docker 会以 VAR="" 覆盖
#    容器内真实配置。配置了 AKM_EMBEDDING_API_KEY 时 JS 带 Authorization
#    （与 src/embedding/index.ts 行为一致）。JS 保持单引号静态串，无插值。
vector_ok=1
vector_enabled=$(docker exec akm-app printenv AKM_EMBEDDING_URL 2>/dev/null || true)
if [ -n "$vector_enabled" ]; then
  vector_ok=0
  embed_key=$(docker exec akm-app printenv AKM_EMBEDDING_API_KEY 2>/dev/null || true)
  embed_model=$(docker exec akm-app printenv AKM_EMBEDDING_MODEL 2>/dev/null || true)
  exec_env=(-e "AKM_EMBEDDING_URL=$vector_enabled")
  [ -n "$embed_key" ] && exec_env+=(-e "AKM_EMBEDDING_API_KEY=$embed_key")
  [ -n "$embed_model" ] && exec_env+=(-e "AKM_EMBEDDING_MODEL=$embed_model")
  if docker exec ${exec_env[@]+"${exec_env[@]}"} \
      -e "AKM_PROBE_TIMEOUT=$TIMEOUT" \
      akm-app node -e '
    const url = process.env.AKM_EMBEDDING_URL;
    if (!url) process.exit(1);
    const t = setTimeout(() => process.exit(2), Number(process.env.AKM_PROBE_TIMEOUT || 10) * 1000);
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.AKM_EMBEDDING_API_KEY ? { Authorization: "Bearer " + process.env.AKM_EMBEDDING_API_KEY } : {})
      },
      body: JSON.stringify({ model: process.env.AKM_EMBEDDING_MODEL || "bge-m3", input: ["ping"] })
    }).then(r => { clearTimeout(t); process.exit(r.ok ? 0 : 1); })
      .catch(() => { clearTimeout(t); process.exit(1); });
  ' >/dev/null 2>&1; then
    vector_ok=1
  fi
fi

# 汇总状态与告警文本（down 才发；恢复也发一条）
fail_msgs=()
[ "$health_ok" = "0" ] && fail_msgs+=("服务健康检查失败：/api/stats HTTP $code")
if [ -n "$vector_enabled" ] && [ "$vector_ok" = "0" ]; then
  fail_msgs+=("向量链路异常：$vector_enabled 不可达（隧道断或模型未起）")
fi
prev=$(cat "$STATE" 2>/dev/null || echo ok)
if [ ${#fail_msgs[@]} -gt 0 ]; then
  now=down
  msg="AKM 异常：${fail_msgs[*]}"
else
  now=ok
  msg="AKM 已恢复：服务与向量链路正常"
fi

# 边沿判重：状态没变不重复告警
if [ "$now" != "$prev" ]; then
  log "$msg"
  echo "$now" > "$STATE"
  if [ -f "$WEBHOOK_ENV" ]; then
    # shellcheck disable=SC1090
    . "$WEBHOOK_ENV"
    if [ -n "${WEBHOOK_URL:-}" ]; then
      curl -s --max-time "$TIMEOUT" -H 'Content-Type: application/json' \
        -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$msg\"}}" \
        "$WEBHOOK_URL" >/dev/null || log "webhook POST 失败"
    fi
  fi
fi
