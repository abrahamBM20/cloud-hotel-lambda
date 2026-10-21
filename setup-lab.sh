#!/usr/bin/env bash
# ============================================================================
#  setup-lab.sh — Crea TODA la capa de eventos del Hotel Boutique 360 en AWS.
#
#  Pensado para AWS Learner Lab: es idempotente, así que se puede volver a
#  ejecutar cuando el lab borra los recursos (pasa al terminar la sesión) o
#  cuando cambia algún parametro.
#
#  USO
#    # 1. Credenciales del lab (las entrega el propio Learner Lab)
#    aws configure
#    aws sts get-caller-identity        # tiene que responder
#
#    # 2. Variables
#    export REGION=us-east-1
#    export DATABASE_URL='postgresql://user:pass@host:5432/hotel?sslmode=require'
#    export GATEWAY_SECRET='mi_secreto'      # el mismo en el BFF y ms-hotel-rooms
#
#    # 3. Ejecutar
#    cd cloud-hotel-lambda
#    bash setup-lab.sh
#
#  Al terminar imprime los valores que hay que copiar al BFF y al manifiesto.
# ============================================================================
set -euo pipefail

REGION="${REGION:-${AWS_REGION:-us-east-1}}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TOPIC_NAME="${TOPIC_NAME:-hotel-reservation-events}"
QUEUE_REQUESTS="${QUEUE_REQUESTS:-reservation-requests}"
QUEUE_STATUS="${QUEUE_STATUS:-reservation-status}"
ROLE_NAME="${ROLE_NAME:-lambda-hotel-role}"
LAMBDA_PREFIX="${LAMBDA_PREFIX:-reservation}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || die "Falta DATABASE_URL (connection string de Postgres/Supabase)."
[ -n "${GATEWAY_SECRET:-}" ] || die "Falta GATEWAY_SECRET (el mismo que usaran el BFF y ms-hotel-rooms)."

say "Cuenta: $ACCOUNT_ID | Region: $REGION"

# ---------------------------------------------------------------------------
# 1. Rol IAM de las Lambdas
#    En Learner Lab muchas veces ya existe un rol util (LabRole). Si no puedes
#    crear roles, el script lo detecta y usa el que haya.
# ---------------------------------------------------------------------------
say "1/8 Rol IAM ($ROLE_NAME)"

cat > /tmp/trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

cat > /tmp/lambda-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      "Resource": [
        "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_REQUESTS",
        "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_STATUS"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/lambda/*"
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "El rol ya existe."
elif aws iam create-role --role-name "$ROLE_NAME" \
      --assume-role-policy-document file:///tmp/trust-policy.json >/dev/null 2>&1; then
  echo "Rol creado."
else
  echo "No se pudo crear el rol. Buscando uno que ya exista en la cuenta..."
  ROLE_NAME="$(aws iam list-roles --query "Roles[?contains(RoleName,'Lab') || contains(RoleName,'Lambda')].RoleName" --output text | awk '{print $1}')"
  [ -n "$ROLE_NAME" ] || die "No hay ningun rol disponible. El lab no permite crear roles ni tiene uno de Lambda."
  echo "Usando el rol existente: $ROLE_NAME"
fi

aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name lambda-hotel-policy --policy-document file:///tmp/lambda-policy.json 2>/dev/null \
  || echo "No se pudo actualizar la politica del rol (puede que ya exista con esos permisos)."

aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null \
  || echo "No se pudo adjuntar AWSLambdaBasicExecutionRole (quizas ya estaba)."

LAMBDA_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"
echo "LAMBDA_ROLE_ARN=$LAMBDA_ROLE_ARN"

# ---------------------------------------------------------------------------
# 2. Topic SNS
# ---------------------------------------------------------------------------
say "2/8 Topic SNS ($TOPIC_NAME)"
aws sns create-topic --name "$TOPIC_NAME" --region "$REGION" >/dev/null
TOPIC_ARN="arn:aws:sns:$REGION:$ACCOUNT_ID:$TOPIC_NAME"
echo "TOPIC_ARN=$TOPIC_ARN"

# ---------------------------------------------------------------------------
# 3. Colas SQS + DLQ
# ---------------------------------------------------------------------------
say "3/8 Colas SQS y DLQ"

aws sqs create-queue --queue-name "$QUEUE_REQUESTS-dlq" --region "$REGION" >/dev/null
aws sqs create-queue --queue-name "$QUEUE_STATUS-dlq"  --region "$REGION" >/dev/null

aws sqs create-queue --queue-name "$QUEUE_REQUESTS" --region "$REGION" \
  --attributes "RedrivePolicy={\"deadLetterTargetArn\":\"arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_REQUESTS-dlq\",\"maxReceiveCount\":3}" >/dev/null

aws sqs create-queue --queue-name "$QUEUE_STATUS" --region "$REGION" \
  --attributes "RedrivePolicy={\"deadLetterTargetArn\":\"arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_STATUS-dlq\",\"maxReceiveCount\":3}" >/dev/null

# Permiso para que SNS pueda enviar a las colas (y solo desde este topic).
for QUEUE in "$QUEUE_REQUESTS" "$QUEUE_STATUS"; do
  QUEUE_URL="$(aws sqs get-queue-url --queue-name "$QUEUE" --region "$REGION" --output text)"
  QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)"
  aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --region "$REGION" \
    --attributes "Policy={\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$QUEUE_ARN\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$TOPIC_ARN\"}}}]}" >/dev/null
  echo "  $QUEUE -> $QUEUE_ARN"
done

# ---------------------------------------------------------------------------
# 4. Suscripciones con FilterPolicy (idempotente: no duplica)
# ---------------------------------------------------------------------------
say "4/8 Suscripciones SNS -> SQS con FilterPolicy"

subscribe_if_missing() {
  local QUEUE_NAME="$1" TYPE="$2"
  local QUEUE_ARN="arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_NAME"
  local EXISTING
  EXISTING="$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
    --query "Subscriptions[?Endpoint=='$QUEUE_ARN'].SubscriptionArn" --output text)"
  if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
    echo "  $QUEUE_NAME ya esta suscrito (no se duplica)."
    return
  fi
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs \
    --notification-endpoint "$QUEUE_ARN" \
    --attributes FilterPolicyScope=MessageBody \
                 "FilterPolicy={\"type\":[\"$TYPE\"]}" \
    --region "$REGION" >/dev/null
  echo "  $QUEUE_NAME suscrito con type=$TYPE"
}

subscribe_if_missing "$QUEUE_REQUESTS" "reservation.requested"
subscribe_if_missing "$QUEUE_STATUS"   "reservation.status-changed"

# ---------------------------------------------------------------------------
# 5. Empaquetar las Lambdas
# ---------------------------------------------------------------------------
say "5/8 Empaquetar las Lambdas"
cd "$(dirname "$0")"
for FN in reservation-recorder reservation-status-updater reservation-query; do
  ( cd "$FN" && npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null 2>&1 )
done
( cd reservation-recorder       && zip -rq ../recorder-function.zip . -x "*.git*" "*.DS_Store*" )
( cd reservation-status-updater && zip -rq ../status-function.zip  . -x "*.git*" "*.DS_Store*" )
( cd reservation-query          && zip -rq ../query-function.zip   . -x "*.git*" "*.DS_Store*" )
echo "  Zips listos."

# ---------------------------------------------------------------------------
# 6. Lambdas
# ---------------------------------------------------------------------------
say "6/8 Crear / actualizar las Lambdas"

deploy_lambda() {
  local FN="$1" ZIP="$2" QUEUE="$3"
  local ENV_VARS="DATABASE_URL=$DATABASE_URL,NOTIFY_MODE=log"
  [ -n "${DATABASE_SSL:-}" ] && ENV_VARS="$ENV_VARS,DATABASE_SSL=$DATABASE_SSL"

  if aws lambda get-function --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
    echo "  $FN existe: se actualiza el codigo y la config."
    aws lambda update-function-code --function-name "$FN" \
      --zip-file "fileb://$ZIP" --region "$REGION" >/dev/null
    aws lambda wait function-updated --function-name "$FN" --region "$REGION"
    aws lambda update-function-configuration --function-name "$FN" \
      --environment "Variables={$ENV_VARS}" --region "$REGION" >/dev/null
  else
    echo "  $FN se crea."
    aws lambda create-function --function-name "$FN" \
      --runtime nodejs20.x --handler index.handler \
      --role "$LAMBDA_ROLE_ARN" --timeout 30 --memory-size 256 \
      --environment "Variables={$ENV_VARS}" \
      --zip-file "fileb://$ZIP" --region "$REGION" >/dev/null
    aws lambda wait function-active --function-name "$FN" --region "$REGION"
  fi

  # Event source mapping (solo en las que disparan desde SQS).
  if [ -n "$QUEUE" ]; then
    local UUID_FOUND
    UUID_FOUND="$(aws lambda list-event-source-mappings --function-name "$FN" \
      --event-source-arn "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE" \
      --query "EventSourceMappings[0].UUID" --output text)"
    if [ "$UUID_FOUND" = "None" ] || [ -z "$UUID_FOUND" ]; then
      aws lambda create-event-source-mapping --function-name "$FN" \
        --event-source-arn "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE" \
        --batch-size 10 --region "$REGION" >/dev/null
      echo "    -> conectada a la cola $QUEUE"
    else
      echo "    -> ya estaba conectada a la cola $QUEUE"
    fi
  fi
}

deploy_lambda "$LAMBDA_PREFIX-recorder"      recorder-function.zip "$QUEUE_REQUESTS"
deploy_lambda "$LAMBDA_PREFIX-status-updater" status-function.zip  "$QUEUE_STATUS"
deploy_lambda "$LAMBDA_PREFIX-query"          query-function.zip   ""

# ---------------------------------------------------------------------------
# 7. Function URL de la Lambda de lectura
# ---------------------------------------------------------------------------
say "7/8 Function URL de $LAMBDA_PREFIX-query"

if aws lambda get-function-url-config --function-name "$LAMBDA_PREFIX-query" --region "$REGION" >/dev/null 2>&1; then
  echo "  Ya existe, se actualiza."
  aws lambda update-function-url-config --function-name "$LAMBDA_PREFIX-query" \
    --auth-type NONE --invoke-mode BUFFERED --region "$REGION" >/dev/null
else
  echo "  Se crea."
  aws lambda create-function-url-config --function-name "$LAMBDA_PREFIX-query" \
    --auth-type NONE --invoke-mode BUFFERED --region "$REGION" >/dev/null
fi

RESERVATIONS_LAMBDA_URL="$(aws lambda get-function-url-config \
  --function-name "$LAMBDA_PREFIX-query" --query FunctionUrl --output text)"

# ---------------------------------------------------------------------------
# 8. Resumen
# ---------------------------------------------------------------------------
say "8/8 Listo. Copia esto a tus variables de entorno."

cat <<EOF

# --- Para el BFF (cloud-hotel-bff) ---
SNS_RESERVATION_TOPIC_ARN=$TOPIC_ARN
AWS_REGION=$REGION
RESERVATIONS_LAMBDA_URL=$RESERVATIONS_LAMBDA_URL
API_GATEWAY_SECRET=$GATEWAY_SECRET

# --- Para ms-hotel-rooms ---
API_GATEWAY_SECRET=$GATEWAY_SECRET

# --- Variables del lab (utiles para recrear todo) ---
ACCOUNT_ID=$ACCOUNT_ID
REGION=$REGION
TOPIC_ARN=$TOPIC_ARN
LAMBDA_ROLE_ARN=$LAMBDA_ROLE_ARN
RESERVATIONS_LAMBDA_URL=$RESERVATIONS_LAMBDA_URL

EOF

# Se guarda para poder recrear la infraestructura en otra sesion del lab.
cat > lab-resources.env <<EOF
export ACCOUNT_ID=$ACCOUNT_ID
export REGION=$REGION
export TOPIC_ARN=$TOPIC_ARN
export LAMBDA_ROLE_ARN=$LAMBDA_ROLE_ARN
export RESERVATIONS_LAMBDA_URL=$RESERVATIONS_LAMBDA_URL
export GATEWAY_SECRET=$GATEWAY_SECRET
EOF
echo "Guardado en lab-resources.env (NO lo commitees: contiene el secreto)."
