#!/bin/sh
# Container entrypoint: make sure the agent has a configuration, then run it.
#
# The config is kept inside the data directory (the part that is mounted as a
# volume) so the machine id survives redeploys; ~/.247/config.json, where the
# agent looks for it, is a link to that file.
set -eu

CONFIG_DIR="${HOME}/.247"
CONFIG_FILE="${CONFIG_DIR}/config.json"
PERSISTED_CONFIG="${CONFIG_DIR}/data/config.json"
PROJECTS_DIR="${AGENT_247_PROJECTS:-${HOME}/projects}"

mkdir -p "${CONFIG_DIR}/data" "${PROJECTS_DIR}"

if [ ! -e "${CONFIG_FILE}" ]; then
  if [ ! -f "${PERSISTED_CONFIG}" ]; then
    machine_id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
    machine_name="$(hostname | tr -cd 'A-Za-z0-9._-')"
    projects_dir="$(printf '%s' "${PROJECTS_DIR}" | tr -d '"\\')"

    cat > "${PERSISTED_CONFIG}" <<EOF
{
  "machine": {
    "id": "${machine_id}",
    "name": "${machine_name:-cloud-agent}"
  },
  "agent": {
    "port": 4678
  },
  "projects": {
    "basePath": "${projects_dir}",
    "whitelist": []
  }
}
EOF
    chmod 600 "${PERSISTED_CONFIG}"
    echo "[entrypoint] Created default config at ${PERSISTED_CONFIG}"
  fi
  ln -s "${PERSISTED_CONFIG}" "${CONFIG_FILE}"
fi

exec "$@"
