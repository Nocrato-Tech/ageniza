#!/bin/sh
# Runs once LocalStack reports ready. Creates the local bucket and gives it the CORS rule the
# browser multipart upload needs -- ETag must be exposed, or the client cannot complete the upload.
# Production R2 buckets are configured by hand; see apps/api/src/modules/media/README.md.
set -eu

BUCKET=ageniza-media-local

awslocal s3api create-bucket --bucket "$BUCKET" >/dev/null

awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://127.0.0.1:5173"],
      "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 300
    }
  ]
}' >/dev/null

# The healthcheck waits on this marker: LocalStack reports healthy before init hooks finish, and
# without it `--wait` returns while the bucket still does not exist.
touch /tmp/ageniza-bucket-ready
