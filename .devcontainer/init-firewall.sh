#!/usr/bin/env bash
# Outbound firewall for the dev container, so Claude Code can run without
# asking before each command. Adapted from Anthropic's reference dev
# container. Everything outbound is refused except DNS and the hosts below;
# that includes the LAN, the Docker host and the server's other services.
#
# Runs as root on every container start (postStartCommand, via a sudo rule
# that allows this script and nothing else). Hosts are resolved to IPs once,
# here; if a CDN moves and npm or GitHub stop working, run it again:
#   sudo /usr/local/bin/init-firewall.sh
set -euo pipefail
IFS=$'\n\t'

ALLOWED_DOMAINS=(
  # npm
  registry.npmjs.org
  # Claude Code: API, sign-in and token refresh, telemetry and error reports
  api.anthropic.com
  claude.ai
  console.anthropic.com
  statsig.anthropic.com
  statsig.com
  sentry.io
  # GitHub content not covered by the published IP ranges below
  objects.githubusercontent.com
  # VS Code server and extensions
  marketplace.visualstudio.com
  vscode.blob.core.windows.net
  update.code.visualstudio.com
)

# Docker's embedded DNS (127.0.0.11) is wired up with NAT rules; keep them
# across the flush, or name resolution stops working.
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

if [ -n "$DOCKER_DNS_RULES" ]; then
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

# DNS and loopback (PostgreSQL shares this network namespace) are always
# allowed. DNS to any resolver stays open: a small exfiltration channel,
# accepted as in the reference setup.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT -p udp --sport 53 -j ACCEPT
iptables -A INPUT -p tcp --sport 53 -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

ipset create allowed-domains hash:net

echo "Fetching GitHub's published IP ranges..."
gh_meta=$(curl -fsS --max-time 20 https://api.github.com/meta)
if ! echo "$gh_meta" | jq -e '.web and .api and .git' >/dev/null; then
  echo "ERROR: GitHub's /meta response is missing the expected ranges" >&2
  exit 1
fi
while read -r cidr; do
  ipset add allowed-domains "$cidr" -exist
done < <(echo "$gh_meta" | jq -r '(.web + .api + .git)[]' | grep -v ':' | sort -u)

for domain in "${ALLOWED_DOMAINS[@]}"; do
  ips=$(dig +short +time=5 +tries=2 A "$domain" | grep -E '^[0-9]+(\.[0-9]+){3}$' || true)
  if [ -z "$ips" ]; then
    # Not fatal: the checks at the end catch anything that matters.
    echo "WARNING: could not resolve $domain; it stays blocked" >&2
    continue
  fi
  while read -r ip; do
    ipset add allowed-domains "$ip" -exist
  done <<<"$ips"
done

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
# Refuse rather than silently drop, so blocked requests fail fast.
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# IPv6 has no allowlist: block it entirely, or it would bypass the above.
if ip6tables -L -n >/dev/null 2>&1; then
  ip6tables -F
  ip6tables -P INPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -P OUTPUT DROP
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
fi

# Verify both directions, so a broken firewall is loud rather than silent.
# Any HTTP response at all, even an error, means the connection was allowed.
if curl -sS --max-time 5 -o /dev/null https://example.com 2>/dev/null; then
  echo "ERROR: firewall check failed: example.com is reachable" >&2
  exit 1
fi
if ! curl -sS --max-time 10 -o /dev/null https://api.github.com/zen; then
  echo "ERROR: firewall check failed: api.github.com is unreachable" >&2
  exit 1
fi
if ! curl -sS --max-time 10 -o /dev/null https://api.anthropic.com; then
  echo "ERROR: firewall check failed: api.anthropic.com is unreachable" >&2
  exit 1
fi
echo "Firewall active and verified."
