#!/usr/bin/env bash
# Weekly logical dump of the production database, encrypted before it touches
# any disk it does not have to, and uploaded to a private bucket in ap-south-1.
#
# Never run this in GitHub Actions. An Actions artifact is a full copy of
# children's records in a third-party store with a default 90-day retention and
# read access for anyone who can read the repository. See docs/auth/BACKUPS.md.
#
# Usage, from a machine you control:
#   BACKUP_DATABASE_URL=postgres://erp_migrator:...@<neon-host>/<db> \
#   BACKUP_AGE_RECIPIENTS=/path/to/backup-recipients.txt \
#   BACKUP_S3_URI=s3://<bucket>/postgres \
#   AWS_PROFILE=<profile> \
#   ./scripts/backup-dump.sh
#
# Needs: pg_dump of the same major version as the server, age, aws.
# The project runs PostgreSQL 18 (compose.db.yml and .github/workflows/ci.yml
# pin postgres:18.x), so use pg_dump 18. A pg_dump older than the server will
# refuse to run; a newer one writes an archive the server's pg_restore cannot
# read. Check with: pg_dump --version.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?Set BACKUP_DATABASE_URL to the migrator connection string}"
: "${BACKUP_AGE_RECIPIENTS:?Set BACKUP_AGE_RECIPIENTS to the file of age public keys}"
: "${BACKUP_S3_URI:?Set BACKUP_S3_URI, for example s3://erp-backups-apsouth1/postgres}"

for tool in pg_dump age aws; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing required tool: $tool" >&2
    exit 2
  }
done

if [ ! -s "$BACKUP_AGE_RECIPIENTS" ]; then
  echo "Recipients file is empty or missing: $BACKUP_AGE_RECIPIENTS" >&2
  exit 2
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="erp-${stamp}.dump.age"

# A private working directory that goes away whatever happens. The plaintext
# dump never exists outside it, and never at a predictable path.
workdir="$(mktemp -d)"
chmod 700 "$workdir"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

echo "Dumping to a temporary file and encrypting to ${name}"

# --no-owner and --no-privileges: the four logins are created by the migrations,
# not by the dump. Custom format so pg_restore can be selective.
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --verbose \
  --file="${workdir}/dump.pgdump" \
  "$BACKUP_DATABASE_URL"

age --encrypt --recipients-file "$BACKUP_AGE_RECIPIENTS" \
  --output "${workdir}/${name}" \
  "${workdir}/dump.pgdump"

shred -u "${workdir}/dump.pgdump" 2>/dev/null || rm -f "${workdir}/dump.pgdump"

size="$(wc -c <"${workdir}/${name}" | tr -d ' ')"
sha="$(shasum -a 256 "${workdir}/${name}" | cut -d' ' -f1)"

aws s3 cp "${workdir}/${name}" "${BACKUP_S3_URI}/${name}" \
  --region ap-south-1 \
  --sse AES256 \
  --only-show-errors

echo "Uploaded ${name}"
echo "  bytes:  ${size}"
echo "  sha256: ${sha}"
echo
echo "Record the name, size and digest in docs/compliance/RESTORE_LOG.md."
echo "The dump is readable only by a holder of an age private key in the"
echo "recipients file. If every one of those keys is lost, so is this backup."
