#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$HOME/.config/openclaw-colab"
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$CONF" "$SERVICE_DIR"
chmod 700 "$CONF"
ENVFILE="$CONF/gateway.env"
if [[ ! -f "$ENVFILE" ]]; then
  umask 077
  printf 'COLAB_GATEWAY_API_KEY=%s\nCOLAB_MODEL=qwen3:4b-instruct-2507-q4_K_M\nCOLAB_GATEWAY_PORT=18080\nCOLAB_IDLE_MINUTES=30\nCOLAB_DELETE_OWNED_RUNTIME_ON_IDLE=yes\n' "$(openssl rand -hex 24)" > "$ENVFILE"
fi
chmod 600 "$ENVFILE"
# Upgrade an existing gateway.env without replacing its API key.
for setting in 'COLAB_MODEL=qwen3:4b-instruct-2507-q4_K_M' 'COLAB_GATEWAY_PORT=18080' 'COLAB_IDLE_MINUTES=30' 'COLAB_DELETE_OWNED_RUNTIME_ON_IDLE=yes'; do
  name="${setting%%=*}"
  if ! grep -q "^${name}=" "$ENVFILE"; then
    printf '%s\n' "$setting" >> "$ENVFILE"
  fi
done
# An existing v1.2 setup may contain a fixed COLAB_SESSION. Autopilot ignores it.
cat > "$SERVICE_DIR/openclaw-colab-gateway.service" <<SERVICE
[Unit]
Description=OpenClaw Colab Autopilot Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOME=$HOME
Environment=PATH=$PATH
EnvironmentFile=$ENVFILE
ExecStart=$(command -v node) $ROOT/bin/colabautopilot.mjs
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
SERVICE
systemctl --user daemon-reload
systemctl --user enable --now openclaw-colab-gateway
printf 'Installed service. Check: systemctl --user status openclaw-colab-gateway\nConfig: %s\n' "$ENVFILE"
