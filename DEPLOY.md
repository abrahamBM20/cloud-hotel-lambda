# Guía de despliegue en AWS — Hotel Boutique 360

Guía paso a paso para dejar el stack funcionando sobre **AWS Learner Lab**.

---

## Qué hay que hacer, en dos rutas

| | Qué corre en el Learner Lab | Qué corre en tu máquina |
|---|---|---|
| **Ruta A (la de clase, recomendada)** | SNS + SQS + DLQ + las 3 Lambdas | ms-hotel-rooms, el BFF y el frontend |
| **Ruta B (todo en AWS)** | todo: SNS, SQS, Lambdas, BFF en EC2/ECS, API Gateway, S3 | solo el código |

**Empieza por la Ruta A.** Es la que se sostiene dentro de un Learner Lab: el
lab te da credenciales y los servicios de eventos (SNS, SQS, Lambda, IAM), pero
casi nunca te da un lugar donde correr un Spring Boot ni una base de datos. La
Ruta A pone los eventos en AWS (que es justo lo que te pide la guía del curso)
y el resto en local, y todo se conversa de verdad.

```
┌──────────────────── tu máquina ────────────────────┐      ┌──── Learner Lab ────┐
│ frontend (Vite)                                    │      │  SNS ──► SQS ──► Lambdas │
│    │ /api + X-Secret-Gateway (proxy de Vite)       │      │            │            │
│    ▼                                               │      │            ▼            │
│ cloud-hotel-bff ───────────────────────────────────┼─────►│      PostgreSQL          │
│    │                                               │      │                        │
│    └──X-Secret-Gateway──► ms-hotel-rooms           │      └────────────────────────┘
└────────────────────────────────────────────────────┘
```

---

## 0. Lo que cambia cuando usas Learner Lab

| Tema | En una cuenta normal | En Learner Lab |
|---|---|---|
| Credenciales | IAM user propio | Access Key/Secret Key **temporales**, que entrega el lab |
| IAM | Puedes crear roles y policies | A veces está bloqueado; hay un rol `LabRole` listo |
| Duración | Los recursos quedan | **Se borran al terminar la sesión** del lab |
| Región | La que elijas | Viene preconfigurada; no la cambies a la fuerza |
| Dónde corre el BFF | EC2/ECS | Casi nunca hay → se corre local (Ruta A) |
| Base de datos | RDS | Poca veces hay → usa Supabase o un Postgres local |
| Cuotas | Amplias | Crear Lambdas y Function URLs es lento (30-60 s) |

**Reglas del lab que te van a ahorrar tiempo:**

1. **No cambies la región.** El lab puede darte credenciales válidas solo en una.
   Verifica con `aws configure get region`.
2. **Todo se borra al final de la sesión.** Por eso `setup-lab.sh` es idempotente:
   si se borra, lo re-ejecutas y tienes todo de vuelta.
3. **Copia los valores a un archivo** (el script deja `lab-resources.env`) para
   poder volver a pegarlos en el BFF sin volver a buscarlos en la consola.
4. **Si el lab no incluye IAM**, no hay Lambda posible (toda Lambda necesita un
   rol). En ese caso usa el rol que ya existe; el script lo busca solo.

---

## 1. Preparar el entorno

```bash
# 1.1 Credenciales del lab (las entrega el propio Learner Lab)
aws configure
#   AWS Access Key ID:     <del lab>
#   AWS Secret Access Key: <del lab>
#   Default region:        us-east-1   (la del lab, no la cambies)
#   Default output format: json

# 1.2 Comprobar que todo está bien
aws sts get-caller-identity
# { "Account": "123456789012", "Arn": "arn:aws:iam::123456789012:user/LabUser", ... }

aws configure get region

# 1.3 Variables del ejercicio
export REGION=$(aws configure get region)
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export GATEWAY_SECRET='mi_secreto_de_clase'   # el MISMO en el BFF y en ms-hotel-rooms

# 1.4 La base de datos
#   - Opción 1 (recomendada): Supabase. Connection string del POOLER (puerto 6543).
export DATABASE_URL='postgresql://postgres.xxxx:CLAVE@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require'
#   - Opción 2: Postgres local.
# export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hotel'

echo "Región: $REGION | Cuenta: $ACCOUNT_ID"
```

> El `DATABASE_URL` va en formato de la librería `pg` (`postgresql://`), **no** en
> formato JDBC. El BFF y ms-hotel-rooms usan `DB_URL` en formato JDBC
> (`jdbc:postgresql://...`).

---

## 2. Crear toda la capa de eventos (un solo comando)

El script `setup-lab.sh` hace los pasos 3 a 8 de esta guía de una: rol IAM, topic
SNS, dos colas con sus DLQ, suscripciones con FilterPolicy, las tres Lambdas y
la Function URL.

```bash
cd cloud-hotel-lambda
bash setup-lab.sh
```

Imprime al final los valores para el BFF y los guarda en `lab-resources.env`.

<details>
<summary>Los comandos por separado (si prefieres ver cada paso)</summary>

### 2.1 Rol IAM de las Lambdas

Las Lambdas necesitan leer de SQS y escribir logs en CloudWatch. Sin el permiso
de logs, la función falla aunque el código esté perfecto.

```bash
cat > trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

cat > lambda-policy.json <<EOF
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

aws iam create-role --role-name $ROLE_NAME --assume-role-policy-document file://trust-policy.json
aws iam put-role-policy --role-name $ROLE_NAME --policy-name lambda-hotel-policy \
  --policy-document file://lambda-policy.json
aws iam attach-role-policy --role-name $ROLE_NAME \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

**Si el lab no deja crear roles**, usa uno que ya exista:

```bash
aws iam list-roles --query "Roles[].{Nombre:RoleName,Arn:Arn}" --output table
# Typically: LabRole  arn:aws:iam::123456789012:role/LabRole
```

Y créala con ese rol:

```bash
aws lambda create-function \
  --function-name reservation-recorder \
  --role arn:aws:iam::$ACCOUNT_ID:role/LabRole \
  ...
```

> Si la base de datos está en una VPC privada, la Lambda necesita además
> `AWSLambdaVPCAccessExecutionRole` y los permisos de ENI. Con Supabase o una
> base pública no hace falta.

### 2.2 Topic SNS

```bash
aws sns create-topic --name $TOPIC_NAME --region $REGION
export TOPIC_ARN="arn:aws:sns:$REGION:$ACCOUNT_ID:$TOPIC_NAME"
```

El BFF publica mensajes con este formato (idéntico al de `cloud-chati-bff`):

```json
{ "type": "reservation.requested",      "body": { ... } }
{ "type": "reservation.status-changed", "body": { ... } }
```

### 2.3 Colas SQS + DLQ

```bash
aws sqs create-queue --queue-name $QUEUE_REQUESTS-dlq --region $REGION
aws sqs create-queue --queue-name $QUEUE_STATUS-dlq  --region $REGION

aws sqs create-queue --queue-name $QUEUE_REQUESTS --region $REGION \
  --attributes "RedrivePolicy={\"deadLetterTargetArn\":\"arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_REQUESTS-dlq\",\"maxReceiveCount\":3}"

aws sqs create-queue --queue-name $QUEUE_STATUS --region $REGION \
  --attributes "RedrivePolicy={\"deadLetterTargetArn\":\"arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_STATUS-dlq\",\"maxReceiveCount\":3}"

# Permiso para que SNS pueda enviar a las colas (y solo desde este topic)
for QUEUE in $QUEUE_REQUESTS $QUEUE_STATUS; do
  QUEUE_URL=$(aws sqs get-queue-url --queue-name $QUEUE --region $REGION --output text)
  QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url $QUEUE_URL \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)
  aws sqs set-queue-attributes --queue-url $QUEUE_URL --region $REGION \
    --attributes "Policy={\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$QUEUE_ARN\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$TOPIC_ARN\"}}}]}"
done
```

> Si no haces este paso, SNS publica bien pero **las colas nunca reciben nada**
> y las Lambdas se quedan idle. Es el error más común de esta guía.

### 2.4 Suscripciones con FilterPolicy

```bash
aws sns subscribe \
  --topic-arn $TOPIC_ARN --protocol sqs \
  --notification-endpoint "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_REQUESTS" \
  --attributes FilterPolicyScope=MessageBody \
               "FilterPolicy={\"type\":[\"reservation.requested\"]}" \
  --region $REGION

aws sns subscribe \
  --topic-arn $TOPIC_ARN --protocol sqs \
  --notification-endpoint "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_STATUS" \
  --attributes FilterPolicyScope=MessageBody \
               "FilterPolicy={\"type\":[\"reservation.status-changed\"]}" \
  --region $REGION
```

> **`FilterPolicyScope=MessageBody` es obligatorio.** Con `RawMessageDelivery=false`
> (el default) el mensaje llega a SQS envuelto en
> `{"Type":"Notification","Message":"{\"type\":...}"}`. Si el scope fuera
> `MessageAttributes`, la política nunca coincidiría y las colas quedarían vacías
> **sin ningún error visible**.

### 2.5 Empaquetar

```bash
cd cloud-hotel-lambda
for FN in reservation-recorder reservation-status-updater reservation-query; do
  ( cd $FN && npm ci --omit=dev )
done

( cd reservation-recorder       && zip -rq ../recorder-function.zip . -x "*.git*" "*.DS_Store*" )
( cd reservation-status-updater && zip -rq ../status-function.zip  . -x "*.git*" "*.DS_Store*" )
( cd reservation-query          && zip -rq ../query-function.zip   . -x "*.git*" "*.DS_Store*" )
```

### 2.6 Las tres Lambdas

```bash
export LAMBDA_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"

# reservation-recorder (disparador SQS)
aws lambda create-function \
  --function-name reservation-recorder \
  --runtime nodejs20.x --handler index.handler \
  --role $LAMBDA_ROLE_ARN --timeout 30 --memory-size 256 \
  --environment "Variables={DATABASE_URL=$DATABASE_URL,NOTIFY_MODE=log}" \
  --zip-file fileb://recorder-function.zip --region $REGION

aws lambda create-event-source-mapping \
  --function-name reservation-recorder \
  --event-source-arn "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_REQUESTS" \
  --batch-size 10 --region $REGION

# reservation-status-updater (disparador SQS)
aws lambda create-function \
  --function-name reservation-status-updater \
  --runtime nodejs20.x --handler index.handler \
  --role $LAMBDA_ROLE_ARN --timeout 30 --memory-size 256 \
  --environment "Variables={DATABASE_URL=$DATABASE_URL,NOTIFY_MODE=log}" \
  --zip-file fileb://status-function.zip --region $REGION

aws lambda create-event-source-mapping \
  --function-name reservation-status-updater \
  --event-source-arn "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_STATUS" \
  --batch-size 10 --region $REGION

# reservation-query (Function URL: la que invoca el BFF)
aws lambda create-function \
  --function-name reservation-query \
  --runtime nodejs20.x --handler index.handler \
  --role $LAMBDA_ROLE_ARN --timeout 30 --memory-size 256 \
  --environment "Variables={DATABASE_URL=$DATABASE_URL}" \
  --zip-file fileb://query-function.zip --region $REGION

aws lambda create-function-url-config \
  --function-name reservation-query \
  --auth-type NONE --invoke-mode BUFFERED --region $REGION

export RESERVATIONS_LAMBDA_URL=$(aws lambda get-function-url-config \
  --function-name reservation-query --query FunctionUrl --output text)
```

> La Function URL va con `--auth-type NONE`. La **no** protegemos con el secreto
> de la pasarela: en este proyecto el `X-Secret-Gateway` protege el tramo
> **API Gateway → BFF → ms-hotel-rooms**, no las Lambdas.

</details>

---

## 3. Probar la capa de eventos (sin BFF ni frontend)

Esto se puede comprobar **antes** de tocar nada más. Publica un evento a mano y
mira si la Lambda lo procesó.

```bash
# 3.1 Publicar una solicitud de reserva
aws sns publish \
  --topic-arn $TOPIC_ARN \
  --message '{"type":"reservation.requested","body":{"reservationId":"test-001","guestName":"Huésped de prueba","guestEmail":"test@hotel.cl","guestId":"sub-test","roomNumber":"101","roomType":"SINGLE","checkIn":"2026-11-01","checkOut":"2026-11-03","guests":2,"totalAmount":120.00,"status":"PENDIENTE","notes":"","requestedAt":"2026-10-21T12:00:00Z","requestedBy":"test@hotel.cl"}}' \
  --region $REGION
```

### 3.2 ¿Llegó a la cola?

```bash
aws sqs get-queue-attributes \
  --queue-url "$(aws sqs get-queue-url --queue-name $QUEUE_REQUESTS --region $REGION --output text)" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --region $REGION
```

- `NotVisible > 0` y luego `0` → la Lambda lo tomó y lo procesó.
- `Messages > 0` y no baja → **la Lambda no está conectada a la cola** (falta el
  event source mapping) o **el rol no puede leer de SQS**.

### 3.3 ¿Lo.processó la Lambda?

```bash
aws logs tail "/aws/lambda/reservation-recorder" --follow --region $REGION
```

O desde la consola: **Lambda → reservation-recorder → Logs → ver**.

### 3.4 ¿Quedó en la base?

```sql
SELECT id, guest_name, room_number, check_in, status FROM reservations ORDER BY created_at DESC LIMIT 5;
SELECT room_number, is_available FROM rooms WHERE room_number = '101';
```

La habitación 101 debe quedar con `is_available = false`.

### 3.5 Probar la Lambda de lectura

```bash
curl -s -X POST "$RESERVATIONS_LAMBDA_URL" \
  -H 'Content-Type: application/json' \
  -d '{"httpMethod":"GET","path":"/reservations","queryStringParameters":{"limit":10}}'
```

### 3.6 Probar un cambio de estado

```bash
aws sns publish \
  --topic-arn $TOPIC_ARN \
  --message '{"type":"reservation.status-changed","body":{"reservationId":"test-001","newStatus":"CHECKED_OUT","notes":"","changedBy":"test@hotel.cl","changedAt":"2026-10-21T12:05:00Z"}}' \
  --region $REGION
```

La habitación 101 debería volver a `is_available = true`.

---

## 4. Ruta A: levantar el BFF, ms-hotel-rooms y el frontend en local

Los tres corren en tu máquina. El BFF y ms-hotel-rooms hablan con AWS de verdad
(SNS, SQS, Function URL) usando las credenciales del lab.

```bash
# 4.1 Las credenciales del lab también las usan las apps locales
export AWS_ACCESS_KEY_ID=<del lab>
export AWS_SECRET_ACCESS_KEY=<del lab>
export AWS_REGION=$REGION

# 4.2 Cargar el manifiesto de variables
cd ../ms-hotel-rooms
cp config/secrets.env.example config/secrets.env   # edítalo con tus valores
set -a && . config/secrets.env && set +a

# 4.3 ms-hotel-rooms (el microservicio del catálogo)
PORT=8081 ./gradlew bootRun

# 4.4 El BFF, en otra terminal (con las variables de arriba + las del lab)
cd ../cloud-hotel-bff
export SNS_RESERVATION_TOPIC_ARN=$TOPIC_ARN
export RESERVATIONS_LAMBDA_URL=$RESERVATIONS_LAMBDA_URL
export API_GATEWAY_SECRET=$GATEWAY_SECRET
export ROOMS_SERVICE_URL=http://localhost:8081
PORT=8080 ./gradlew bootRun

# 4.5 El frontend, en otra terminal
cd ../frontend-hotelboutique360
pnpm dev
```

El frontend local usa el proxy de Vite, que inyecta `X-Secret-Gateway` y reenvía
a `http://localhost:8080`. Todo eso está en `.env.development.local`:

```
VITE_API_BASE=
BFF_URL=http://localhost:8080
GATEWAY_SECRET=secreto_local
```

> **Ojo:** `GATEWAY_SECRET` tiene que ser **igual** que `API_GATEWAY_SECRET` del
> BFF y del ms-hotel-rooms. Si no, el BFF responde 403.
>
> Y `ms-hotel-rooms` **muestra el secreto en sus logs** (`DEBUG SECRETO -> ...`).
> Es a propósito, para acordarse del valor mientras configurás. En una entrega
> de clases se deja así; en producción esa línea se borra.

### 4.6 Probar la cadena completa en local

```bash
# El health del BFF (público)
curl -s http://localhost:8080/api/health

# El catálogo: el BFF llama a ms-hotel-rooms con el secreto
curl -s http://localhost:8080/api/v1/rooms | head -c 300

# Crear una reserva (necesita un id_token de Cognito)
TOKEN=<id_token>
curl -s -i -X POST http://localhost:8080/api/v1/reservations \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"guestName":"Carlos Mendoza","guestEmail":"carlos@hotel.cl","roomNumber":"101","checkIn":"2026-11-01","checkOut":"2026-11-03","guests":2,"notes":"prueba"}'
# → HTTP 202 Accepted + {"id":"...","status":"PENDIENTE",...}

# Esperar y leer (la Lambda ya insertó la fila)
sleep 5
curl -s "http://localhost:8080/api/v1/reservations?limit=5" -H "Authorization: Bearer $TOKEN"
```

Y desde el navegador: el frontend en `http://localhost:5173`, login con Cognito,
la lista de reservas se actualiza sola cada 10 segundos.

---

## 5. Ruta B: el BFF en AWS

Solo si el lab te da EC2 o ECS. En la mayoría de los Learner Lab **no hay**,
así que la Ruta A es la buena.

### 5.1 Build y push de la imagen

```bash
cd cloud-hotel-bff
docker build -t hotel-bff:latest .

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
aws ecr create-repository --repository-name hotel-bff --region $REGION   # solo la primera vez
docker tag hotel-bff:latest $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/hotel-bff:latest
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/hotel-bff:latest
```

### 5.2 Publicar en SNS

El `SnsClient` del BFF usa las credenciales del entorno. En EC2, lo más simple
es una **instance profile** (IAM role de la instancia):

```bash
cat > bff-instance-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "sns:Publish", "Resource": "$TOPIC_ARN" }
  ]
}
EOF

aws iam create-role --role-name hotel-bff-ec2-role \
  --assume-role-policy-document file://trust-policy.json
aws iam put-role-policy --role-name hotel-bff-ec2-role --policy-name hotel-bff-policy \
  --policy-document file://bff-instance-policy.json
aws iam create-instance-profile --instance-profile-name hotel-bff-ec2-profile
aws iam add-role-to-instance-profile --instance-profile-name hotel-bff-ec2-profile \
  --role-name hotel-bff-ec2-role
```

> Con una instance profile **no** hay que pasar `AWS_ACCESS_KEY_ID` ni
> `AWS_SECRET_ACCESS_KEY`: el SDK las toma del metadata de IMDS.

### 5.3 Correr el contenedor

```bash
docker run -d --name hotel-bff --restart unless-stopped -p 8080:8080 \
  -e DB_URL="$JDBC_URL" \
  -e DB_USER="$DB_USER" \
  -e DB_PASSWORD="$DB_PASSWORD" \
  -e API_GATEWAY_SECRET="$GATEWAY_SECRET" \
  -e COGNITO_ISSUER_URI="$COGNITO_ISSUER_URI" \
  -e SNS_RESERVATION_TOPIC_ARN="$TOPIC_ARN" \
  -e AWS_REGION="$REGION" \
  -e RESERVATIONS_LAMBDA_URL="$RESERVATIONS_LAMBDA_URL" \
  -e ROOMS_SERVICE_URL="http://<ip-interna-de-ms-hotel-rooms>:8081" \
  -e PUBLIC_HOST_URL="https://evyja84d54.execute-api.us-east-1.amazonaws.com" \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/hotel-bff:latest
```

`ms-hotel-rooms` se corre igual, con `API_GATEWAY_SECRET`, `DB_*` y
`COGNITO_ISSUER_URI`. Su security group solo debe aceptar tráfico del BFF.

---

## 6. API Gateway

### 6.1 Qué hay que cambiar

El API Gateway `evyja84d54` hoy apunta al **microservicio** `ms-hotel-rooms`.
Con el BFF en medio, **todas** las rutas `/api/*` van al BFF, y el BFF es el
único que habla con el microservicio:

```
antes:  internet → API Gateway → ms-hotel-rooms
ahora:  internet → API Gateway → cloud-hotel-bff → ms-hotel-rooms (red interna)
```

> **No crees una ruta pública al `ms-hotel-rooms`.** Si la dejas, el
> microservicio queda accesible sin pasar por el BFF. El `X-Secret-Gateway`
> sigue siendo obligatorio, pero el control principal es que no haya ruta
> directa.

### 6.2 El API Gateway inyecta el secreto

El secreto se guarda como **stage variable** y se inyecta en la cabecera
`X-Secret-Gateway` de la petición al BFF. Así el secreto nunca viaja por
internet ni lo ve el navegador.

```bash
export API_ID=<id-del-api-gateway-rest>

aws apigateway update-stage --rest-api-id $API_ID --stage-name prod \
  --variables "gatewaySecret=$GATEWAY_SECRET" --region $REGION
```

Para que la stage variable se convierta en cabecera, la integración tiene que
ser **HTTP_PROXY** (no AWS_PROXY) y llevar el mapeo:

```
Integration request → Request parameters:
  integration.request.header.X-Secret-Gateway = stageVariables.gatewaySecret
```

En la consola: **API Gateway → tu API → Resources → {proxy+} → ANY → Integration
Request → Header parameters** → agrega `X-Secret-Gateway` con valor
`stageVariables.gatewaySecret`.

```bash
aws apigateway put-integration \
  --rest-api-id $API_ID --resource-id <proxy-resource-id> --http-method ANY \
  --type HTTP_PROXY \
  --uri "http://<bff-host>:8080/api/{proxy}" \
  --http-method GET \
  --request-parameters "integration.request.header.X-Secret-Gateway=stageVariables.gatewaySecret" \
  --passthrough-behavior WHEN_NO_MATCH
```

El recurso `/api/health` va aparte, con `authorization-type NONE` (el BFF lo
exime del secreto).

### 6.3 Autorización con Cognito

```bash
aws apigateway create-authorizer \
  --rest-api-id $API_ID \
  --name hotel-cognito \
  --type COGNITO_USER_POOLS \
  --provider-arns "arn:aws:cognito-idp:$REGION:$ACCOUNT_ID:userpool/$COGNITO_USER_POOL_ID" \
  --identity-source "method.request.header.Authorization" \
  --region $REGION
```

### 6.4 CORS (si el front llama a otro dominio)

```bash
aws apigateway put-method-response --rest-api-id $API_ID --resource-id <proxy-resource-id> --http-method ANY --status-code 200 \
  --response-parameters "method.response.header.Access-Control-Allow-Origin=true,method.response.header.Access-Control-Allow-Headers=true,method.response.header.Access-Control-Allow-Methods=true"

aws apigateway put-integration-response --rest-api-id $API_ID --resource-id <proxy-resource-id> --http-method ANY --status-code 200 \
  --response-parameters "method.response.header.Access-Control-Allow-Origin='*',method.response.header.Access-Control-Allow-Headers='Content-Type,Authorization',method.response.header.Access-Control-Allow-Methods='GET,POST,PATCH,PUT,DELETE,OPTIONS'"
```

> Alternativa más simple: dejar `VITE_API_BASE` **vacío** y hacer que CloudFront
> enrute `/api/*` al API Gateway. Sin CORS, porque todo queda en el mismo origen.

### 6.5 Desplegar

```bash
aws apigateway create-deployment --rest-api-id $API_ID --stage-name prod --region $REGION
```

---

## 7. Frontend → S3 + CloudFront

Documentado en `frontend-hotelboutique360/DEPLOY-S3.md`. Lo mínimo:

```bash
cd frontend-hotelboutique360
pnpm install
pnpm run build
aws s3 sync dist/ s3://hotel-boutique-360 --delete
```

Las variables `VITE_*` se leen **al compilar**: si cambian (API Gateway,
Cognito) hay que recompilar y resubir. El App client de Cognito debe tener la
URL de CloudFront en `Allowed callback URLs` y `Allowed sign-out URLs`.

---

## 8. Secretos de GitHub (para los pipelines)

| Secret | Qué es |
|---|---|
| `AWS_ACCESS_KEY_ID` | Access key del lab o de un usuario IAM con permiso de deploy |
| `AWS_SECRET_ACCESS_KEY` | Secret key de ese access key |
| `AWS_REGION` | `us-east-1` |
| `LAMBDA_RECORDER_FUNCTION_NAME` | `reservation-recorder` |
| `LAMBDA_STATUS_FUNCTION_NAME` | `reservation-status-updater` |
| `LAMBDA_QUERY_FUNCTION_NAME` | `reservation-query` |
| `DATABASE_URL` | Connection string de Postgres/Supabase |
| `DATABASE_SSL` | `true` en Supabase |
| `S3_BUCKET_NAME` | `hotel-boutique-360` (workflow del frontend) |
| `CLOUDFRONT_DISTRIBUTION_ID` | Para invalidar caché en cada deploy |

> **Ojo:** los workflows de las Lambdas hacen `update-function-configuration`, que
> **reemplaza todas** las env vars. Por eso escriben el set completo, no solo
> `DATABASE_URL`.

---

## 9. Troubleshooting

| Síntoma | Causa probable | Qué revisar |
|---|---|---|
| `aws sts get-caller-identity` falla | Credenciales del lab expiraron o mal copiadas | Vuelve a `aws configure` con las claves del panel del lab |
| `AccessDenied` al crear el rol | El lab no da permisos de IAM | Usa el rol existente (`aws iam list-roles`) |
| La cola nunca recibe mensajes | Falta el permiso de SNS→SQS (paso 2.3) | `aws sqs get-queue-attributes --attribute-names Policy` |
| La cola recibe pero la Lambda no la toma | Falta el event source mapping, o el rol no puede leer | `aws lambda list-event-source-mappings` y el log |
| Las colas no reciben **de este** topic | `FilterPolicyScope` mal | Debe ser `MessageBody` y el `type` exacto |
| La Lambda no escribe en la BD | `DATABASE_URL` mal, o certificado de Supabase | Usa el **pooler** (6543) y `?sslmode=require` |
| La Lambda falla con `AccessDenied` | El rol no tiene `logs:CreateLogGroup` | Paso 2.1 |
| El BFF devuelve 403 | `API_GATEWAY_SECRET` no coincide entre BFF y ms-hotel-rooms | Mira el log `DEBUG SECRETO` del ms-rooms |
| El BFF devuelve 500 al crear reserva | No puede publicar en SNS | ¿`SNS_RESERVATION_TOPIC_ARN` existe? ¿hay credenciales AWS? |
| El BFF devuelve 502 al leer | `RESERVATIONS_LAMBDA_URL` mal | `aws lambda get-function-url-config` |
| La reserva no aparece en el front | La Lambda no alcanzó la base | Log de `reservation-recorder`; si el mensaje está en la DLQ, mira el error |
| El lab se reinició y no hay nada | Los recursos se borraron | `bash setup-lab.sh` lo recrea todo |

---

## 10. Antes de que termine la sesión del lab

Los recursos del Learner Lab **se borran** cuando la sesión expira. Para no
perder el trabajo:

```bash
# El script ya dejó este archivo con los valores importantes
cat lab-resources.env
```

Cópialo a tu máquina (o al manifiesto `ms-hotel-rooms/config/secrets.env`) y
guarda una captura de la **Function URL**, que es lo que más cuesta recuperar.

Para empezar de cero en la sesión siguiente:

```bash
export DATABASE_URL=... GATEWAY_SECRET=...
bash setup-lab.sh
```

---

## 11. Limpieza

```bash
aws lambda delete-event-source-mapping --event-source-uuid <uuid> --function-name reservation-recorder
aws lambda delete-function --function-name reservation-recorder
aws lambda delete-function --function-name reservation-status-updater
aws lambda delete-function-url-config --function-name reservation-query
aws lambda delete-function --function-name reservation-query

aws sns delete-topic --topic-arn $TOPIC_ARN
for Q in $QUEUE_REQUESTS $QUEUE_STATUS $QUEUE_REQUESTS-dlq $QUEUE_STATUS-dlq; do
  aws sqs delete-queue --queue-url "$(aws sqs get-queue-url --queue-name $Q --region $REGION --output text)"
done

aws iam delete-role-policy --role-name $ROLE_NAME --policy-name lambda-hotel-policy
aws iam detach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name $ROLE_NAME
```
