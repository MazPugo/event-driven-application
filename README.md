# Event-Driven Orders Application

A serverless, multi-region order-management application built with the AWS
Serverless Application Model (SAM). It exposes a REST API for creating and
reading orders, backed by a DynamoDB Global Table, accelerated with DynamoDB
Accelerator (DAX), observable through CloudWatch and AWS X-Ray, and deployed
automatically via GitHub Actions.

---

## Architecture

```
                          ┌──────────────────────────────────────┐
                          │            Amazon API Gateway          │
                          │                (OrdersApi)             │
                          │     stage: prod · cache TTL 300s       │
                          └───────┬───────────┬───────────┬────────┘
                                  │           │           │
              POST /orders        │           │           │  GET /orders/{orderId}
              (Lambda proxy)      │           │           │  (direct DynamoDB, no Lambda)
                                  │           │           │
                                  ▼           ▼           ▼
                        ┌──────────────────┐       ┌───────────────────┐
                        │  SaveOrder Lambda │       │  DynamoDB Query     │
                        │   (Node.js, VPC)  │       │  service integration│
                        │  writes → DynamoDB│       └─────────┬──────────┘
                        │  reads  → DAX     │                 │
                        └───────┬───────────┘                 │
                                │  reads                       │
                                ▼                              │
                        ┌──────────────────┐                  │
                        │   DAX Cluster      │                 │
                        │  (in private VPC)  │                 │
                        └───────┬───────────┘                  │
                                │                              │
                                ▼                              ▼
                        ┌──────────────────────────────────────────┐
                        │          DynamoDB Global Table "Orders"    │
                        │   streams enabled · replica in 2nd region  │
                        └──────────────────────────────────────────┘

        Observability: CloudWatch dashboard + X-Ray tracing on API & Lambda
```

### Request paths

| Method & path                 | Integration                                   | Purpose                                            |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------- |
| `POST /orders`                | Lambda proxy → `SaveOrder`                    | Create/save an order (writes to DynamoDB)          |
| `GET /orders/{orderId}`       | Direct API Gateway → DynamoDB `Query`         | Read an order's items without invoking a Lambda    |
| `GET /orders/{orderId}/cached`| Lambda proxy → `SaveOrder`                    | Read an order's items through DAX (cached reads)   |

---

## Resources provisioned

Everything is defined in [`template.yaml`](./template.yaml).

### Data

- **`OrdersTable`** — `AWS::DynamoDB::GlobalTable`
  - Partition key `orderId` (String), sort key `itemId` (String)
  - On-demand billing (`PAY_PER_REQUEST`)
  - DynamoDB Streams enabled (`NEW_AND_OLD_IMAGES`) — required for global tables
  - Replicas in the primary region and a configurable `SecondaryRegion`, each with point-in-time recovery

### Compute

- **`SaveOrderFunction`** — `AWS::Serverless::Function` (Node.js 24.x)
  - Writes go directly to DynamoDB; reads go through DAX
  - Runs inside the VPC so it can reach the DAX cluster
  - X-Ray active tracing enabled
  - Scoped IAM: `DynamoDBWritePolicy`, DAX data-plane actions, and `VPCAccessPolicy`

### API

- **`OrdersApi`** — `AWS::Serverless::Api` (REST, stage `prod`)
  - Stage-level caching enabled, 0.5 GB cache cluster, 300-second TTL
  - X-Ray tracing enabled
  - `ApiGatewayDynamoDbRole` lets API Gateway call DynamoDB `Query` directly for the no-Lambda read path

### Acceleration & networking

- **`OrdersDaxCluster`** — `AWS::DAX::Cluster` (`dax.t3.small`, replication factor 2, SSE enabled)
- **`DaxServiceRole`**, **`DaxSubnetGroup`**
- **`OrdersVpc`** with two private subnets, **`DaxSecurityGroup`**, a private route table, and a DynamoDB gateway VPC endpoint

### Observability

- **`OrdersDashboard`** — `AWS::CloudWatch::Dashboard` with four widgets:
  - API Gateway `Count`
  - API Gateway `4XXError`
  - Lambda `Invocations`
  - Lambda `Errors`

---

## Project structure

```
event-driven-application/
├── template.yaml                 # SAM template (all AWS resources)
├── README.md
├── .github/
│   └── workflows/
│       └── deploy.yml            # CI/CD: build + deploy on push to main (OIDC)
└── src/
    └── save-order/
        ├── index.js              # Lambda handler (write to DynamoDB, read via DAX)
        ├── package.json          # Runtime dep: DAX SDK v3; AWS SDK is dev-only
        └── .npmignore            # Keeps the deployment package small
```

---

## Prerequisites

- An AWS account and credentials configured locally
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- Node.js 18 or higher (the DAX SDK v3 client requires it; the function runs on Node.js 24.x)
- Docker (recommended, used by `sam build` for a consistent build environment)

---

## Lambda function behavior

`src/save-order/index.js` routes on the HTTP method:

- **`POST`** → `saveOrder`: validates that `orderId` and `itemId` are present, adds a `createdAt` timestamp if missing, and writes the item to DynamoDB.
- **`GET`** → `getOrder`: reads all items for a given `orderId` **through DAX** using a `Query`.

Initialization (SDK clients, the DAX connection, and configuration) happens once
at module scope so it is reused across warm invocations. The AWS SDK v3 is
provided by the Lambda runtime and is declared as a dev dependency to keep the
deployment package small; the DAX SDK v3 client (`@amazon-dax-sdk/lib-dax`) is a
real runtime dependency and is bundled.

### Environment variables

| Variable       | Source                                             | Description                               |
| -------------- | -------------------------------------------------- | ----------------------------------------- |
| `ORDERS_TABLE` | `!Ref OrdersTable`                                 | Table name used by read/write operations  |
| `DAX_ENDPOINT` | `!GetAtt OrdersDaxCluster.ClusterDiscoveryEndpointURL` | DAX cluster discovery endpoint (`dax://`) |

---

## Deploy

### Option A — Local, guided deploy

```bash
sam build
sam deploy --guided
```

During the guided flow you can set the `SecondaryRegion` parameter (default
`us-west-2`) for the Global Table replica. Accept the IAM capabilities prompt
(`CAPABILITY_IAM`) so SAM can create the roles.

### Option B — Non-interactive deploy

```bash
sam build
sam deploy \
  --stack-name event-driven-application \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides SecondaryRegion=us-west-2 \
  --no-confirm-changeset
```

After deployment, the stack **Outputs** include the API endpoints, the
dashboard URL, the table/stream ARNs, and the replica region.

---

## Continuous deployment (GitHub Actions + OIDC)

`.github/workflows/deploy.yml` builds and deploys the stack on every push to
`main`. It authenticates to AWS using **OpenID Connect** (short-lived tokens,
no long-lived access keys stored in GitHub).

### One-time setup

1. **Create a GitHub OIDC identity provider** in your AWS account
   (provider URL `token.actions.githubusercontent.com`, audience
   `sts.amazonaws.com`).

2. **Create an IAM role** the workflow assumes. Its trust policy should restrict
   the `sub` claim to this repository and branch, for example:

   ```json
   {
     "Effect": "Allow",
     "Principal": {
       "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
     },
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": {
       "StringEquals": {
         "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
       },
       "StringLike": {
         "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:ref:refs/heads/main"
       }
     }
   }
   ```

   The role needs permissions to manage the stack's resources (CloudFormation,
   Lambda, API Gateway, DynamoDB, DAX, EC2/VPC, IAM, CloudWatch, S3).

3. **Add repository configuration:**
   - Secret `AWS_DEPLOY_ROLE_ARN` — the ARN of the role from step 2.
   - (Optional) variables `AWS_REGION` (default `us-east-1`) and
     `SAM_STACK_NAME` (default `event-driven-application`).

---

## Usage

Replace `<api-id>` and `<region>` with values from the stack outputs
(`CreateOrderEndpoint` / `GetOrderEndpoint`).

### Create an order

```bash
curl -X POST "https://<api-id>.execute-api.<region>.amazonaws.com/prod/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"o-123","itemId":"i-456","quantity":2}'
```

Response:

```json
{
  "message": "Order saved.",
  "order": {
    "orderId": "o-123",
    "itemId": "i-456",
    "quantity": 2,
    "createdAt": "2026-10-18T00:00:00.000Z"
  }
}
```

### Read an order (direct DynamoDB integration, no Lambda)

```bash
curl "https://<api-id>.execute-api.<region>.amazonaws.com/prod/orders/o-123"
```

### Read an order through DAX (Lambda-backed cached read)

```bash
curl "https://<api-id>.execute-api.<region>.amazonaws.com/prod/orders/o-123/cached"
```

> Responses from `GET` endpoints may be served from the API Gateway stage cache
> for up to 300 seconds.

---

## Observability

- **CloudWatch dashboard** — open the `DashboardUrl` from the stack outputs to
  see API Gateway request count and 4XX errors alongside Lambda invocations and
  errors.
- **X-Ray** — tracing is enabled on both the API and the Lambda, so you can view
  end-to-end traces in the X-Ray console.

---

## Local development

Install dependencies for the function (pulls in the dev-only AWS SDK and the DAX
client for local work):

```bash
cd src/save-order
npm install
```

Check the handler parses:

```bash
node --check src/save-order/index.js
```

Validate the template:

```bash
sam validate --lint
```

> DAX only runs inside a VPC, so the cached read path cannot be fully exercised
> locally. When `DAX_ENDPOINT` is unset, the handler falls back to DynamoDB for
> reads, which is convenient for local testing.

---

## Important notes & caveats

- **Global Table conversion is replacing.** The table is defined as
  `AWS::DynamoDB::GlobalTable`. If you are migrating an existing stack that used
  `AWS::DynamoDB::Table`, CloudFormation treats this as a new resource and the
  old table may be deleted. Back up data first, or add `DeletionPolicy: Retain`.
- **DAX is single-region.** The DAX cluster accelerates reads in the primary
  region only. The secondary-region replica is not fronted by this DAX cluster;
  a full multi-region read-acceleration design would deploy a DAX cluster per
  region.
- **Cost.** A DAX cluster and the API Gateway cache cluster both bill hourly
  while provisioned, and placing the Lambda in a VPC adds ENI management. These
  are reasonable for production latency/DR goals but are not free-tier friendly.
- **Verification status.** The template passes `sam validate --lint` and the
  handler passes `node --check`. Runtime behavior (DAX connectivity, global-table
  replication, the VTL mapping for the direct integration) should be confirmed
  with a real `sam build` / `sam deploy` in your account.

---

## Cleanup

```bash
sam delete --stack-name event-driven-application
```

Removing the Global Table deletes its replicas. Confirm you have backups if the
data matters.
