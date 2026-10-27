#!/usr/bin/env bash
# Prints the Baseten documentation pages the Baseten provider is built on, so they can be read
# from the job log (the development sandbox cannot reach docs.baseten.co). Read-only.
set -u
base=https://docs.baseten.co
curl -sSL -m 30 "$base/llms.txt" -o /tmp/llms.txt || { echo "no llms.txt"; exit 0; }
echo "=== llms.txt: $(wc -l < /tmp/llms.txt) lines; relevant entries ==="
grep -iE 'model.?api|quickstart|chat|completion|reason|vision|image|audio|structured|json|pricing|openai|muse|meta' /tmp/llms.txt | head -60
grep -oE 'https://docs\.baseten\.co/[^) ]+' /tmp/llms.txt \
  | grep -iE 'model-apis|inference/model-apis|quickstart|chat|reason|vision|audio|structured|json|openai|pricing' \
  | sort -u | head -16 > /tmp/pages.txt
echo "=== pages ==="; cat /tmp/pages.txt
while read -r url; do
  echo; echo "################ $url"
  u="$url"; case "$u" in *.md) ;; *) u="$u.md";; esac
  curl -sSL -m 30 "$u" | head -c 7000 || curl -sSL -m 30 "$url" | sed 's/<[^>]*>//g' | head -c 7000
done < /tmp/pages.txt
