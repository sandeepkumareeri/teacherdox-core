#!/usr/bin/env bash
# Prints the Baseten documentation the Baseten provider is built on, so it can be read from the job
# log (the development sandbox cannot reach docs.baseten.co). Read-only, no secrets.
set -u
base=https://docs.baseten.co
for idx in documentation reference; do curl -sSL -m 30 "$base/_llms/$idx.txt"; echo; done > /tmp/index.txt
echo "=== Model API pages in the docs index ==="
grep -iE 'model-api|model api|structured|reasoning|vision|multimodal|audio input|pricing|rate limit|openai' /tmp/index.txt | head -50
grep -oE 'https://docs\.baseten\.co/[^) ]+' /tmp/index.txt \
  | grep -iE 'model-apis|/inference/(reasoning|structured|vision|multimodal|audio|chat)|/reference/inference-api/(chat|overview)' \
  | sort -u | head -14 > /tmp/pages.txt
echo; echo "=== pages ==="; cat /tmp/pages.txt
while read -r url; do
  echo; echo "################ $url"
  u="$url"; case "$u" in *.md) ;; *) u="$u.md";; esac
  curl -sSL -m 30 "$u" | head -c 8000
done < /tmp/pages.txt
echo; echo "################ llm-openapi-spec: InputAudio, ImageURL, JsonSchema, reasoning_effort, UsageInfo"
curl -sSL -m 30 "$base/reference/inference-api/llm-openapi-spec.json" | python3 -c "
import json,sys
s=json.load(sys.stdin); c=s.get('components',{}).get('schemas',{})
for k in ['InputAudio','ImageURL','JsonSchema','UsageInfo','CompletionTokensDetails','PromptTokensDetails']:
    print('---',k); print(json.dumps(c.get(k),indent=1)[:2500])
t=json.dumps(s); i=t.find('\"reasoning_effort\"'); print('--- reasoning_effort'); print(t[i:i+1200])
"
