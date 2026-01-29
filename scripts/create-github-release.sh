#!/bin/bash

# Create GitHub Release with build artifacts
# Usage: ./create-github-release.sh <tag> <token>

set -e

TAG=${1:-"v0.1.15"}
TOKEN=${2}
REPO="Arxchibobo/vibeCraft-matrix"
RELEASE_DIR="../release"

# Create release
echo "Creating GitHub release: $TAG"
RESPONSE=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "{\"tag_name\": \"$TAG\", \"name\": \"Vibecraft $TAG\", \"body\": \"## Vibecraft $TAG\\n\\n### Downloads\\n\\nChoose your platform below:\\n- **macOS (Apple Silicon)**: Vibecraft-0.1.15-arm64.dmg\\n- **macOS (Intel)**: Vibecraft-0.1.15-mac.dmg\\n- **Linux (x64)**: Vibecraft-0.1.15.AppImage\\n\\n### Installation\\n\\n1. Download the appropriate file for your platform\\n2. macOS: Open the .dmg file and drag Vibecraft.app to /Applications\\n3. Linux: Make the AppImage executable (chmod +x Vibecraft-0.1.15.AppImage) and run it\\n\\n### Notes\\n\\n- This is a development build without code signing\\n- macOS may show a security warning on first launch\\n- For production use, proper code signing is required\\n\\nBuilt with Electron 40.1.0\"}")

RELEASE_ID=$(echo $RESPONSE | jq -r '.id')
UPLOAD_URL=$(echo $RESPONSE | jq -r '.upload_url')

echo "Release created with ID: $RELEASE_ID"

# Upload assets
cd "$RELEASE_DIR"

for file in *.dmg *.zip *.AppImage; do
  if [ -f "$file" ]; then
    echo "Uploading $file..."
    curl -s -X POST \
      -H "Authorization: token $TOKEN" \
      -H "Content-Type: application/octet-stream" \
      --data-binary @"$file" \
      "${UPLOAD_URL}?name=$file"
    echo "Uploaded $file"
  fi
done

echo "Release created successfully!"
echo "Visit: https://github.com/$REPO/releases/tag/$TAG"
