#!/usr/bin/env bash
set -euo pipefail
# Dedicated durable state branch. Never commit/push to main; never restore executable code.
branch=automation/wiki-sync-state
files=(data/videos-cache.json data/update-state.json data/classification-state.json)
mkdir -p work/state data
case "${1:?load or save}" in
  load)
    set +e
    git ls-remote --exit-code --heads origin "refs/heads/$branch" > work/state/remote
    status=$?
    set -e
    if [[ $status == 2 ]]; then
      echo '' > work/state/base
    elif [[ $status == 0 ]]; then
      git fetch --no-tags origin "refs/heads/$branch"
      git rev-parse FETCH_HEAD > work/state/base
      for file in "${files[@]}"; do
        if git cat-file -e "$(cat work/state/base):$file" 2>/dev/null; then
          git show "$(cat work/state/base):$file" > "$file"
        elif [[ "$file" == data/classification-state.json ]]; then echo '{}' > "$file"
        else echo 'Required state file missing' >&2; exit 1; fi
      done
    else
      echo 'State remote unavailable; aborting' >&2; exit 1
    fi
    [[ -f data/classification-state.json ]] || echo '{}' > data/classification-state.json
    node --input-type=module -e 'import {readFileSync} from "node:fs"; for (const f of process.argv.slice(1)) JSON.parse(readFileSync(f));' "${files[@]}"
    ;;
  save)
    [[ "${DRY_RUN:-true}" == false && "${VIDEO_WIKI_WRITE_ENABLED:-false}" == true ]] || exit 0
    base=$(cat work/state/base)
    export GIT_INDEX_FILE="$PWD/work/state/index"
    rm -f "$GIT_INDEX_FILE"
    if [[ -n "$base" ]]; then git read-tree "$base"; else git read-tree --empty; fi
    git add -- "${files[@]}"
    tree=$(git write-tree)
    if [[ -n "$base" && "$tree" == "$(git rev-parse "$base^{tree}")" ]]; then exit 0; fi
    git config user.name 'github-actions[bot]'
    git config user.email 'github-actions[bot]@users.noreply.github.com'
    parents=(); if [[ -n "$base" ]]; then parents=(-p "$base"); fi
    commit=$(git commit-tree "$tree" "${parents[@]}" -m 'chore: checkpoint Wiki sync state')
    # CAS even when restoring an older base. A rejected save must be visible, never force overwrite.
    git push --force-with-lease="refs/heads/$branch:$base" origin "$commit:refs/heads/$branch"
    ;;
  *) exit 2 ;;
esac
