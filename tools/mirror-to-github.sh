#!/usr/bin/env bash
#
# Mirror the private Gitea repo to the public GitHub repo.
#
# This is NOT `git push --mirror`. That would copy the papers (third-party
# copyrighted PDFs) and the private commit history verbatim, which is exactly
# what .gitattributes is there to prevent.
#
# Instead: export the tree through `git archive` (which honours
# export-ignore), re-init a fresh single-commit history, and force-push.
#
#   private  <your private origin>.git   (has papers)
#   public   github.com/AtticusG3/okx-jev-desk                 (no papers)
#
# Usage:  tools/mirror-to-github.sh [--dry-run]
#
set -euo pipefail

REPO="okx-jev-desk"
SRC="${SRC:-$HOME/projects/$REPO}"
GITEA_DIR="$SRC/.git"
PUBLIC_REPO="AtticusG3/$REPO"
TMP="$(mktemp -d)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m%s\033[0m\n' "$*"; }
warn(){ printf '  \033[33m%s\033[0m\n' "$*"; }
die() { printf '  \033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
say "preflight"
[ -d "$GITEA_DIR" ] || die "not a git repo: $SRC"
command -v gh >/dev/null || die "gh not installed"
gh auth status >/dev/null 2>&1 || die "gh not authenticated"

cd "$SRC"
[ -z "$(git status --porcelain)" ] || die "working tree dirty - commit first"
git fetch -q origin || warn "fetch failed (offline?) - using local HEAD"
LOCAL_SHA="$(git rev-parse HEAD)"
ok "source HEAD $(git rev-parse --short HEAD)"

# --------------------------------------------------- export via git archive
# git archive honours export-ignore from .gitattributes, which strips
# docs/papers/*.pdf from the public tree.
say "export (honours export-ignore)"
git archive --format=tar HEAD | tar -x -C "$TMP"

PDF_COUNT="$(find "$TMP" -name '*.pdf' | wc -l | tr -d ' ')"
[ "$PDF_COUNT" = "0" ] || die "$PDF_COUNT PDFs leaked into the export - check .gitattributes"
ok "no PDFs in export (export-ignore working)"

# ------------------------------------------------------- secret gate (gates)
say "secret gate"
# NOTE: the scanner must not match itself. This script contains the very
# token prefixes it looks for, so scanning it would always trip the gate.
# Skip the scanner file specifically rather than weakening the patterns.
if grep -rInE '(gho_|ghp_|github_pat_|sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})' \
     "$TMP" --exclude-dir=.git --exclude="mirror-to-github.sh" 2>/dev/null | grep -q .; then
  die "token-shaped string found in export - refusing to publish"
fi
for f in .env .env.local; do
  [ -e "$TMP/$f" ] && die "$f would be published - refusing"
done
[ -d "$TMP/data" ] && die "data/ would be published - refusing"
ok "no tokens, no .env, no data/"

FILE_COUNT="$(find "$TMP" -type f | wc -l | tr -d ' ')"
ok "$FILE_COUNT files, $(du -sh "$TMP" | cut -f1)"

if [ "$DRY" = "1" ]; then
  say "dry run - nothing pushed. Files that would go public:"
  (cd "$TMP" && find . -type f -not -path './.git/*' | sort | sed 's|^\./|  |')
  rm -rf "$TMP"; exit 0
fi

# ------------------------------------------------------------ publish
say "publish"
cd "$TMP"
git init -q -b main
git add -A
# Author identity for the mirrored commit. Overridable, and the default is a
# project-scoped address rather than a personal one: this script runs against a
# PUBLIC remote, so a hardcoded personal address would publish the maintainer's
# email on every commit. Set MIRROR_AUTHOR_NAME / MIRROR_AUTHOR_EMAIL to
# override.
# Named to avoid colliding with git's own GIT_AUTHOR_* env vars, which -c does
# not set but an inherited environment might.
MIRROR_NAME="${MIRROR_AUTHOR_NAME:-okx-jev-desk mirror}"
MIRROR_EMAIL="${MIRROR_AUTHOR_EMAIL:-mirror@users.noreply.github.com}"
git -c user.name="$MIRROR_NAME" -c user.email="$MIRROR_EMAIL" \
    commit -q -F - <<MSG
Mirror of private repo at commit $LOCAL_SHA

TypeScript/Node 22 multi-bot crypto trading desk. Jev (TypeSafe System One)
is the brain; all arithmetic, sizing and risk thresholds stay in code.

Exported with \`git archive\`, so docs/papers/*.pdf are omitted - the
SIGNAL_CATALOGUE links to arXiv / author copies instead of redistributing
third-party copyrighted work. See .gitattributes.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
MSG
git remote add github "https://github.com/$PUBLIC_REPO.git"
git push -q --force github main
ok "pushed $FILE_COUNT files to github.com/$PUBLIC_REPO"

rm -rf "$TMP"
say "done - $PUBLIC_REPO is current with $LOCAL_SHA"
