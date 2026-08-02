#!/usr/bin/env bash
set -euo pipefail

umask 077

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/secure/path/orchestra.backup.db" >&2
  exit 64
fi

if [ -z "${HOME:-}" ]; then
  echo 'HOME must be set to an absolute path' >&2
  exit 1
fi
case "$HOME" in /*) ;; *) echo 'HOME must be absolute' >&2; exit 1;; esac

if [ "${ORCHESTRA_HOME+x}" = x ]; then
  if [ -z "$ORCHESTRA_HOME" ]; then
    echo 'ORCHESTRA_HOME cannot be empty when set' >&2
    exit 1
  fi
  case "$ORCHESTRA_HOME" in
    /*) orchestra_state_root="$ORCHESTRA_HOME" ;;
    *) echo 'ORCHESTRA_HOME must be absolute' >&2; exit 1;;
  esac
else
  orchestra_state_root="$HOME/.orchestra"
fi

orchestra_backup_path="$1"
case "$orchestra_backup_path" in /*) ;; *) echo 'backup path must be absolute' >&2; exit 1;; esac
case "$orchestra_state_root$orchestra_backup_path" in
  *"'"*) echo 'state and backup paths cannot contain a single quote' >&2; exit 1;;
esac
if printf '%s%s' "$orchestra_state_root" "$orchestra_backup_path" \
  | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo 'state and backup paths cannot contain control characters' >&2
  exit 1
fi

orchestra_source_db="$orchestra_state_root/orchestra.db"
orchestra_checksum_path="$orchestra_backup_path.sha256"
orchestra_backup_dir="$(dirname "$orchestra_backup_path")"
orchestra_backup_name="$(basename "$orchestra_backup_path")"
orchestra_backup_tmp="$orchestra_backup_dir/.$orchestra_backup_name.$$.tmp"
orchestra_checksum_tmp="$orchestra_backup_dir/.$orchestra_backup_name.$$.sha256.tmp"

test -f "$orchestra_source_db"
test ! -L "$orchestra_source_db"
test ! -e "$orchestra_backup_path"
test ! -e "$orchestra_checksum_path"
test ! -e "$orchestra_backup_tmp"
test ! -e "$orchestra_checksum_tmp"

if [ ! -e "$orchestra_backup_dir" ]; then
  mkdir -p "$orchestra_backup_dir"
  chmod 700 "$orchestra_backup_dir"
fi
test -d "$orchestra_backup_dir"
test ! -L "$orchestra_backup_dir"

orchestra_mode() {
  orchestra_mode_candidate="$(stat -f '%Lp' "$1" 2>/dev/null || true)"
  case "$orchestra_mode_candidate" in
    [0-7][0-7][0-7]) printf '%s\n' "$orchestra_mode_candidate" ;;
    *) stat -c '%a' "$1" ;;
  esac
}

if [ "$(orchestra_mode "$orchestra_backup_dir")" != 700 ]; then
  echo 'backup directory mode must be exactly 700' >&2
  exit 1
fi

orchestra_backup_complete=0
orchestra_backup_owned=0
orchestra_checksum_owned=0
orchestra_cleanup() {
  orchestra_status=$?
  trap - EXIT
  if [ "$orchestra_backup_complete" -ne 1 ]; then
    rm -f -- "$orchestra_backup_tmp" "$orchestra_checksum_tmp"
    if [ "$orchestra_backup_owned" -eq 1 ]; then rm -f -- "$orchestra_backup_path"; fi
    if [ "$orchestra_checksum_owned" -eq 1 ]; then rm -f -- "$orchestra_checksum_path"; fi
  fi
  exit "$orchestra_status"
}
trap orchestra_cleanup EXIT
trap 'exit 1' HUP INT TERM

sqlite3 "$orchestra_source_db" ".backup '$orchestra_backup_tmp'"
orchestra_integrity="$(sqlite3 "$orchestra_backup_tmp" 'PRAGMA integrity_check;')"
if [ "$orchestra_integrity" != ok ]; then
  echo 'backup integrity_check did not return exactly ok' >&2
  exit 1
fi
chmod 600 "$orchestra_backup_tmp"

orchestra_checksum_preference="${ORCHESTRA_CHECKSUM_TOOL:-auto}"
if [ "$orchestra_checksum_preference" = shasum ]; then
  command -v shasum >/dev/null 2>&1
  orchestra_digest="$(shasum -a 256 "$orchestra_backup_tmp" | awk '{print $1}')"
  orchestra_checksum_tool=shasum
elif [ "$orchestra_checksum_preference" = sha256sum ]; then
  command -v sha256sum >/dev/null 2>&1
  orchestra_digest="$(sha256sum "$orchestra_backup_tmp" | awk '{print $1}')"
  orchestra_checksum_tool=sha256sum
elif [ "$orchestra_checksum_preference" != auto ]; then
  echo 'ORCHESTRA_CHECKSUM_TOOL must be auto, shasum, or sha256sum' >&2
  exit 1
elif command -v shasum >/dev/null 2>&1; then
  orchestra_digest="$(shasum -a 256 "$orchestra_backup_tmp" | awk '{print $1}')"
  orchestra_checksum_tool=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  orchestra_digest="$(sha256sum "$orchestra_backup_tmp" | awk '{print $1}')"
  orchestra_checksum_tool=sha256sum
else
  echo 'no SHA-256 utility found' >&2
  exit 1
fi
case "$orchestra_digest" in
  *[!0-9a-f]*|'') echo 'SHA-256 utility returned an invalid digest' >&2; exit 1;;
esac
if [ "${#orchestra_digest}" -ne 64 ]; then
  echo 'SHA-256 utility returned an invalid digest length' >&2
  exit 1
fi
printf '%s  %s\n' "$orchestra_digest" "$orchestra_backup_path" > "$orchestra_checksum_tmp"
chmod 600 "$orchestra_checksum_tmp"

# Hard links are an atomic no-clobber commit on the target filesystem.
ln "$orchestra_backup_tmp" "$orchestra_backup_path"
orchestra_backup_owned=1
ln "$orchestra_checksum_tmp" "$orchestra_checksum_path"
orchestra_checksum_owned=1
rm -f -- "$orchestra_backup_tmp" "$orchestra_checksum_tmp"

if [ "$orchestra_checksum_tool" = shasum ]; then
  shasum -a 256 -c "$orchestra_checksum_path" >/dev/null
else
  sha256sum -c "$orchestra_checksum_path" >/dev/null
fi
if [ "$(orchestra_mode "$orchestra_backup_path")" != 600 ] \
  || [ "$(orchestra_mode "$orchestra_checksum_path")" != 600 ]; then
  echo 'backup and checksum modes must verify as 600' >&2
  exit 1
fi

orchestra_backup_complete=1
printf 'backup=%s\nchecksum=%s\n' "$orchestra_backup_path" "$orchestra_checksum_path"
