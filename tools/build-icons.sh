#!/bin/sh
# 由 public/favicon.svg 重新產生 public/favicon.ico 與 public/apple-touch-icon.png
# 依賴：librsvg2-bin（rsvg-convert）、imagemagick（convert）
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for size in 16 32 48; do
  rsvg-convert -w "$size" -h "$size" public/favicon.svg -o "$tmp/icon-$size.png"
done
convert "$tmp/icon-16.png" "$tmp/icon-32.png" "$tmp/icon-48.png" public/favicon.ico
# iOS 會自己套用圓角遮罩，所以觸控圖示要鋪滿、不留透明邊
rsvg-convert -w 180 -h 180 public/favicon.svg -o "$tmp/touch.png"
convert "$tmp/touch.png" -background '#20262b' -alpha remove -alpha off public/apple-touch-icon.png

printf 'favicon.ico %s bytes · apple-touch-icon.png %s bytes\n'   "$(wc -c < public/favicon.ico)" "$(wc -c < public/apple-touch-icon.png)"
