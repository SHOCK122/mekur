# Dev container for mekur: Node 22 (from the feature in devcontainer.json)
# plus the PostgreSQL client tools, a compiler for native npm modules, and
# the outbound firewall that lets Claude Code run unattended.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        build-essential \
        postgresql-client \
        iptables \
        ipset \
        iproute2 \
        dnsutils \
        jq \
        curl \
    && rm -rf /var/lib/apt/lists/*

# The firewall script and the launcher that refuses to skip permission
# prompts unless the firewall is up. Root-owned, so they can only change
# through a rebuild.
COPY --chmod=0755 init-firewall.sh /usr/local/bin/init-firewall.sh
COPY --chmod=0755 claude-unattended /usr/local/bin/claude-unattended

# The base image gives the dev user passwordless sudo for everything, which
# would let Claude simply switch the firewall off. Allow the firewall script
# and nothing else, and fail the build if any broader rule survives.
RUN grep -rl '^vscode' /etc/sudoers.d | xargs -r rm -f \
    && echo 'vscode ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh' > /etc/sudoers.d/vscode-firewall \
    && chmod 0440 /etc/sudoers.d/vscode-firewall \
    && visudo -c \
    && ! sudo -l -U vscode | grep NOPASSWD | grep -v /usr/local/bin/init-firewall.sh

# Pre-create the Claude Code config dir so the named volume mounted over it
# is owned by the dev user rather than root.
RUN mkdir -p /home/vscode/.claude && chown vscode:vscode /home/vscode/.claude
