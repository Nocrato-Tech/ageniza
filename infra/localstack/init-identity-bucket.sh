#!/bin/sh
# Runs once LocalStack reports ready. Creates the local identity storage bucket (issue #100),
# separate from media's own bucket -- see apps/api/src/modules/identity-storage/README.md.
# Only a GET/HEAD CORS rule is needed: upload goes through the API server, never a browser PUT.
# Production R2 buckets are configured by hand; see that README's "configured by hand" section.
set -eu

BUCKET=ageniza-identity-local

awslocal s3api create-bucket --bucket "$BUCKET" >/dev/null

awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://127.0.0.1:5173"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 300
    }
  ]
}' >/dev/null

# The healthcheck waits on this marker, alongside media's own -- see compose.yml.
touch /tmp/ageniza-identity-bucket-ready
