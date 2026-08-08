#!/usr/bin/env bash
set -euo pipefail

: "${WECHAT_MINIAPP_APP_ID:?WECHAT_MINIAPP_APP_ID is required}"
: "${WECHAT_MINIAPP_PRIVATE_KEY_PATH:?WECHAT_MINIAPP_PRIVATE_KEY_PATH is required}"
: "${WECHAT_MINIAPP_VERSION:?WECHAT_MINIAPP_VERSION is required}"

robot="${WECHAT_MINIAPP_CI_ROBOT:-1}"
desc="${WECHAT_MINIAPP_DESC:-TiGame CI upload}"
project_path="${WECHAT_MINIAPP_PROJECT_PATH:-.}"
trial_entry_path="${WECHAT_MINIAPP_TRIAL_ENTRY_PATH:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tigame-wechat-trial-entry.txt}"

if [[ ! "$WECHAT_MINIAPP_APP_ID" =~ ^wx[0-9A-Za-z]{16}$ ]]; then
  echo "WECHAT_MINIAPP_APP_ID must be a valid wx AppID" >&2
  exit 2
fi
case "$robot" in
  ''|*[!0-9]*) echo "WECHAT_MINIAPP_CI_ROBOT must be an integer from 1 to 30" >&2; exit 2 ;;
esac
if [ "$robot" -lt 1 ] || [ "$robot" -gt 30 ]; then
  echo "WECHAT_MINIAPP_CI_ROBOT must be an integer from 1 to 30" >&2
  exit 2
fi
if [ ! -f "$WECHAT_MINIAPP_PRIVATE_KEY_PATH" ]; then
  echo "WeChat Mini Program upload private key file does not exist" >&2
  exit 2
fi
if [ ! -f "$project_path/project.config.json" ]; then
  echo "Missing project.config.json in Mini Program project path: $project_path" >&2
  exit 2
fi
if [ ! -f "$project_path/miniprogram/app.json" ]; then
  echo "Missing miniprogram/app.json in Mini Program project path: $project_path" >&2
  exit 2
fi

mkdir -p "$(dirname "$trial_entry_path")"

echo "Uploading TiGame WeChat Mini Program with CI robot $robot (version $WECHAT_MINIAPP_VERSION)..."
pnpm dlx miniprogram-ci@2.1.31 upload \
  --appid "$WECHAT_MINIAPP_APP_ID" \
  --project-path "$project_path" \
  --private-key-path "$WECHAT_MINIAPP_PRIVATE_KEY_PATH" \
  --upload-version "$WECHAT_MINIAPP_VERSION" \
  --upload-description "$desc" \
  --robot "$robot" \
  --use-project-config

entry_url="https://open.weixin.qq.com/sns/getexpappinfo?appid=${WECHAT_MINIAPP_APP_ID}#wechat-redirect"
printf '%s\n' "$entry_url" > "$trial_entry_path"

echo "WeChat Mini Program upload succeeded."
echo "Fixed trial entry: $entry_url"
echo "If robot $robot has already been selected as the experience version in WeChat, no further selection is needed."
