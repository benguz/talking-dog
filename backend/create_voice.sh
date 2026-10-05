#!/usr/bin/env bash
# https://developers.openai.com/api/docs/guides/text-to-speech
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.dev.vars"
set +a

CONSENT_FILE="${1:-$SCRIPT_DIR/consent_recording.wav}"
SAMPLE_FILE="${2:-$SCRIPT_DIR/audio_sample_recording.wav}"
VOICE_NAME="${3:-ben_testing}"

mime_type() {
  case "${1##*.}" in
    m4a) echo "audio/mp4" ;;
    *)   echo "audio/x-wav" ;;
  esac
}

CONSENT_MIME=$(mime_type "$CONSENT_FILE")
SAMPLE_MIME=$(mime_type "$SAMPLE_FILE")

echo "Creating voice consent..."
CONSENT_RESPONSE=$(curl -s https://api.openai.com/v1/audio/voice_consents \
  -X POST \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "name=${VOICE_NAME}_consent" \
  -F "language=en" \
  -F "recording=@${CONSENT_FILE};type=${CONSENT_MIME}")

echo "$CONSENT_RESPONSE"

CONSENT_ID=$(echo "$CONSENT_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$CONSENT_ID" ]]; then
  echo "Error: could not extract consent ID from response."
  exit 1
fi

echo ""
echo "Consent ID: $CONSENT_ID"
echo ""
echo "Creating voice..."
curl -s https://api.openai.com/v1/audio/voices \
  -X POST \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "name=$VOICE_NAME" \
  -F "audio_sample=@${SAMPLE_FILE};type=${SAMPLE_MIME}" \
  -F "consent=$CONSENT_ID"

echo ""
