#!/bin/sh
# Montaje MANUAL por sshfs del repositorio de documentos del SGD dentro del contenedor del backend.
# No guarda credenciales: ssh pide la contraseña por tty. Ejecutar siempre como root:
#   docker compose exec -u root backend sgd-sshfs montar usuario@host:/ruta/remota
#   docker compose exec -u root backend sgd-sshfs desmontar
#   docker compose exec -u root backend sgd-sshfs estado
# El `-o ro` es la garantía de solo lectura (equivale al `:ro` del bind mount): no quitarlo.
set -eu

DEST="${STORAGE_PATH:-/mnt/sgd/storage}"

montado() { grep -q " $DEST fuse.sshfs " /proc/mounts; }

case "${1:-}" in
  montar)
    REMOTO="${2:-${SGD_SSHFS_REMOTE:-}}"
    if [ -z "$REMOTO" ]; then
      echo "uso: sgd-sshfs montar usuario@host:/ruta/remota  (o definir SGD_SSHFS_REMOTE)" >&2; exit 2
    fi
    if [ "$(id -u)" -ne 0 ]; then
      echo "el montaje FUSE lo hace root: docker compose exec -u root backend sgd-sshfs montar ..." >&2; exit 1
    fi
    if montado; then
      echo "ya hay un sshfs montado en $DEST; desmontar primero" >&2; exit 1
    fi
    mkdir -p "$DEST"
    # allow_other + uid/gid: el proceso de node corre como appuser y tiene que poder leer.
    # reconnect + ServerAlive*: sobrevive a cortes de red cortos.
    # accept-new: el known_hosts de root es efímero (se pierde al recrear el contenedor).
    sshfs "$REMOTO" "$DEST" -o "ro,allow_other,uid=$(id -u appuser),gid=$(id -g appuser),reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,StrictHostKeyChecking=accept-new"
    echo "montado $REMOTO en $DEST (solo lectura)"
    ;;
  desmontar)
    if ! montado; then echo "no hay sshfs montado en $DEST"; exit 0; fi
    fusermount3 -u "$DEST"
    echo "desmontado $DEST"
    ;;
  estado)
    grep " $DEST fuse.sshfs " /proc/mounts || echo "no montado: $DEST"
    ;;
  *)
    echo "uso: sgd-sshfs montar usuario@host:/ruta | desmontar | estado" >&2; exit 2
    ;;
esac
