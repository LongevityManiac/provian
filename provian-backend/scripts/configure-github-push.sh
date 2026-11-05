#!/usr/bin/env bash
# Idempotent push infrastructure; retire the old poll only once the worker is deployed.
set -euo pipefail
PROJECT=provian-ai
REGION=us-central1
QUEUE=provian-github-webhooks
RUNTIME=185909722463-compute@developer.gserviceaccount.com
IDENTITY=provian-github-worker@provian-ai.iam.gserviceaccount.com
ORIGIN=https://provian-api-185909722463.us-central1.run.app
WORKER_PATH=/v1/internal/tasks/github
if [[ "${1:-}" == --retire-poll ]]; then
  # Run after the worker deploy, at least one minute after configuring queue routing.
  if gcloud scheduler jobs describe provian-github-webhooks --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud scheduler jobs delete provian-github-webhooks --location="$REGION" --project="$PROJECT" --quiet
  fi
  gcloud tasks queues resume "$QUEUE" --location="$REGION" --project="$PROJECT" --quiet
  exit 0
fi
if ! gcloud iam service-accounts describe "$IDENTITY" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create provian-github-worker --project="$PROJECT" --display-name='Provian GitHub webhook worker' --quiet
fi
gcloud services enable cloudtasks.googleapis.com --project="$PROJECT" --quiet
if ! gcloud tasks queues describe "$QUEUE" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud tasks queues create "$QUEUE" --location="$REGION" --project="$PROJECT" --quiet
fi
gcloud tasks queues update "$QUEUE" --location="$REGION" --project="$PROJECT" \
  --max-attempts=-1 --max-retry-duration=0s --min-backoff=1s --max-backoff=900s --max-doublings=10 \
  --max-dispatches-per-second=20 --max-concurrent-dispatches=10 --log-sampling-ratio=1 --quiet
gcloud tasks queues pause "$QUEUE" --location="$REGION" --project="$PROJECT" --quiet
gcloud tasks queues update "$QUEUE" --location="$REGION" --project="$PROJECT" \
  --http-method-override=POST \
  --http-uri-override='scheme:HTTPS,host:provian-api-185909722463.us-central1.run.app,port:443,path:/v1/internal/tasks/github,query:' \
  --http-oidc-service-account-email-override="$IDENTITY" \
  --http-oidc-token-audience-override="$ORIGIN$WORKER_PATH" --quiet
gcloud tasks queues add-iam-policy-binding "$QUEUE" --location="$REGION" --project="$PROJECT" \
  --member="serviceAccount:$RUNTIME" --role=roles/cloudtasks.enqueuer --quiet
gcloud iam service-accounts add-iam-policy-binding "$IDENTITY" --project="$PROJECT" \
  --member="serviceAccount:$RUNTIME" --role=roles/iam.serviceAccountUser --quiet
gcloud iam service-accounts remove-iam-policy-binding provian-scheduler@provian-ai.iam.gserviceaccount.com --project="$PROJECT" \
  --member="serviceAccount:$RUNTIME" --role=roles/iam.serviceAccountUser --quiet 2>/dev/null || true
gcloud run services update provian-api --region="$REGION" --project="$PROJECT" \
  --add-custom-audiences="$ORIGIN$WORKER_PATH" --quiet
gcloud scheduler jobs update http provian-github-pr-gates --location="$REGION" --project="$PROJECT" \
  --schedule='18 4 * * *' --time-zone=Etc/UTC --quiet
