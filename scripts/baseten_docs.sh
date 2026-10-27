#!/usr/bin/env bash
# Prints the Baseten documentation the Baseten provider is built on, so it can be read from the job
# log (the development sandbox cannot reach docs.baseten.co). Read-only, no secrets.
set -u
base=https://docs.baseten.co
curl -sSL -m 30 "$base/llms.txt" -o /tmp/llms.txt || { echo "no llms.txt"; exit 0; }
echo "=== llms.txt (full) ==="; cat /tmp/llms.txt
grep -oE '\((https://docs\.baseten\.co/[^)]+|/reference/[^)]+)\)' /tmp/llms.txt | tr -d '()' \
  | sed "s#^/#$base/#" \
  | grep -iE 'model-api|model_api|inference|reason|vision|multimodal|audio|structured|json|openai|quickstart|pricing|chat|llm-openapi' \
  | grep -viE 'examples/models|chains|image-gen|sandbox' | sort -u | head -20 > /tmp/pages.txt
echo; echo "=== pages ==="; cat /tmp/pages.txt
while read -r url; do
  echo; echo "################ $url"
  case "$url" in
    *.json)  # OpenAPI spec: print only the chat-completions request schema parts that matter
      curl -sSL -m 30 "$url" | python3 -c "
import json,sys
spec=json.load(sys.stdin)
txt=json.dumps(spec)
for key in ['reasoning','response_format','json_schema','input_audio','audio_url','image_url','max_tokens','max_completion_tokens','usage','chat_template_kwargs']:
    i=txt.find('\"'+key+'\"')
    print('---',key,'found' if i>=0 else 'NOT FOUND')
    if i>=0: print(txt[max(0,i-200):i+900])
" ;;
    *) u="$url"; case "$u" in *.md) ;; *) u="$u.md";; esac
       curl -sSL -m 30 "$u" | head -c 9000 ;;
  esac
done < /tmp/pages.txt
