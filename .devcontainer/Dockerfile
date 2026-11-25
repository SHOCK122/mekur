# Dev container for mekur: Node 22 (from the feature in devcontainer.json)
# plus the PostgreSQL client tools and a compiler for native npm modules.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        build-essential \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Pre-create the Claude Code config dir so the named volume mounted over it
# is owned by the dev user rather than root.
RUN mkdir -p /home/vscode/.claude && chown vscode:vscode /home/vscode/.claude
