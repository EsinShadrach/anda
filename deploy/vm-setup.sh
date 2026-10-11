#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VM for the proxy, Pulse and Anda. Safe to run again.
# Usage, from the Mac: ssh -i <key> ubuntu@<ip> 'sudo bash -s' < deploy/vm-setup.sh
set -euo pipefail

echo "==> Docker (Docker's apt repo: Engine + Compose plugin)"
if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -yq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker ubuntu

echo "==> 2 GB swap file (a safety net for spikes, not working memory)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show | grep -q /swapfile || swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "==> Delivery tuning (Caddy's container gets the TCP ones through sysctls: in proxy/docker-compose.yml)"
echo tcp_bbr > /etc/modules-load.d/bbr.conf
modprobe tcp_bbr
cat > /etc/sysctl.d/90-fast-video.conf <<'EOF'
# Video over a long, thin link (~150 ms RTT): BBR with fq pacing, keep the congestion window
# between segment downloads, keep send buffers short so the newest data goes first.
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_notsent_lowat = 16384
# WebRTC (LiveKit) and HTTP/3: 7.5 MB UDP buffers.
net.core.rmem_max = 7500000
net.core.wmem_max = 7500000
vm.swappiness = 10
EOF
sysctl -q --system

echo "==> edge network"
docker network inspect edge >/dev/null 2>&1 || docker network create edge

docker --version
docker compose version
free -h
