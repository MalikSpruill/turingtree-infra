# TuringTree — Enterprise Federated Identity & Multi-Account AWS Infrastructure

> **Portfolio Project | AWS Solutions Architect Associate**
>
> Demonstrates enterprise-grade federated identity (Okta SAML 2.0 → AWS STS) across a
> Control Tower multi-account Landing Zone, with private VPC-hosted serverless workloads
> and all infrastructure defined as AWS CDK TypeScript code (IaC).

---

## Architecture Overview

```
                         ┌─────────────────────────────────────────────────────┐
                         │                   OKTA (IdP)                        │
                         │  TuringTree-Developers  TuringTree-Analysts         │
                         │  TuringTree-Admins      (Groups → SCIM → AWS)       │
                         └───────────────────────┬─────────────────────────────┘
                                                 │  SAML 2.0 Assertion
                                                 ▼
                         ┌─────────────────────────────────────────────────────┐
                         │        AWS IAM IDENTITY CENTER (Management Acct)    │
                         │  External IdP (Okta) → SAML Validation              │
                         │  STS AssumeRoleWithSAML → Temporary Credentials     │
                         │  Access Portal: routes users to assigned accounts    │
                         └───────────┬─────────────────────────┬───────────────┘
                                     │                         │
                    DeveloperAccess  │              AnalystAccess│
                    (Engineering)    │              (Analytics)  │
                                     ▼                         ▼
┌────────────────────────────────────────┐   ┌────────────────────────────────────────┐
│         ENGINEERING ACCOUNT            │   │          ANALYTICS ACCOUNT             │
│         (Workloads OU)                 │   │          (Workloads OU)                │
│                                        │   │                                        │
│  ┌──────────────────────────────────┐  │   │  ┌──────────────────────────────────┐  │
│  │    Custom VPC (10.0.0.0/16)      │  │   │  │  CloudWatch OAM Sink             │  │
│  │    Private Subnets (2 AZs)       │  │   │  │  (accepts metric share from      │  │
│  │    No NAT Gateway / No IGW       │  │   │  │   Engineering via OAM Link)      │  │
│  │    DynamoDB Gateway Endpoint     │  │   │  └──────────────────────────────────┘  │
│  │                                  │  │   │                                        │
│  │  ┌──────────┐   ┌─────────────┐  │  │   │  ┌──────────────────────────────────┐  │
│  │  │  Lambda  │◄──│ API Gateway │  │  │   │  │  CloudWatch Dashboard            │  │
│  │  │ (private │   │ (IAM/SigV4) │  │  │   │  │  (cross-account Lambda +         │  │
│  │  │  subnet) │   └─────────────┘  │  │   │  │   API Gateway metrics from       │  │
│  │  └────┬─────┘                    │  │   │  │   Engineering account)           │  │
│  │       │ VPC Gateway Endpoint     │  │   │  └──────────────────────────────────┘  │
│  │  ┌────▼─────┐                    │  │   │                                        │
│  │  │ DynamoDB │                    │  │   │  OAM Link ◄───────────────────────────┤
│  │  └──────────┘                    │  │   │  (read-only metric share, one-way)    │
│  └──────────────────────────────────┘  │   └────────────────────────────────────────┘
│                                        │
│  SCPs (Workloads OU):                  │   SCPs (Workloads OU):
│  ✗ iam:CreateUser                      │   ✗ iam:CreateUser
│  ✗ cloudtrail:StopLogging              │   ✗ cloudtrail:StopLogging
│  ✗ organizations:LeaveOrganization     │   ✗ organizations:LeaveOrganization
└────────────────────────────────────────┘   └────────────────────────────────────────┘

Management Account: AWS Organizations, Control Tower, IAM Identity Center
Security OU: Log Archive Account, Audit Account (auto-created by Control Tower)
```

---

## Federation Flow (The Core Concept)

When a TuringTree developer wants to access AWS resources, the following sequence occurs:

1. The developer navigates to the IAM Identity Center access portal URL
2. IAM Identity Center redirects them to Okta for authentication
3. Okta verifies the developer's credentials (+ MFA) and generates a SAML 2.0 assertion — a cryptographically signed XML document asserting the user's identity and group memberships
4. The developer's browser posts this assertion to the AWS ACS (Assertion Consumer Service) endpoint
5. AWS validates the assertion's signature against Okta's registered certificate, then calls `STS:AssumeRoleWithSAML` and issues temporary credentials (access key, secret key, session token) valid for the session duration
6. IAM Identity Center renders the access portal showing only the accounts and roles this user's Okta group is mapped to — a Developer sees only the Engineering account; an Analyst sees only the Analytics account
7. When the developer calls `GET /projects/p-001` via the Project Status API, they sign the request with their temporary credentials using SigV4. API Gateway validates the signature and the `execute-api:Invoke` permission before forwarding to Lambda

No IAM users. No static access keys. No shared passwords. Every human access to AWS in TuringTree originates from a time-limited credential that traces back to an authenticated Okta session.

---

## Technology Stack

**Identity & Federation:** Okta Developer (IdP, SAML 2.0, SCIM 2.0), AWS IAM Identity Center, AWS STS (`AssumeRoleWithSAML`)

**Account Governance:** AWS Organizations, AWS Control Tower (Landing Zone, Account Factory, guardrails), Service Control Policies (SCPs)

**Networking:** Custom VPC (private isolated subnets, no NAT Gateway), VPC Gateway Endpoint (DynamoDB), VPC Flow Logs, Security Groups (least-privilege egress)

**Workloads:** AWS Lambda (Node.js 20.x, private subnet, X-Ray tracing), Amazon API Gateway REST API (IAM authorization, Regional endpoint, access logging), Amazon DynamoDB (on-demand, AWS-managed encryption, PITR)

**Observability:** CloudWatch OAM (cross-account metric sharing), CloudWatch Dashboards, CloudWatch Logs, AWS X-Ray, AWS CloudTrail (organization-level)

**IaC:** AWS CDK v2 (TypeScript), generates CloudFormation templates, multi-stack multi-account deployment

---

## Repository Structure

```
turingtree-infra/
├── bin/
│   └── turingtree.ts          # CDK app entry point — wires stacks to accounts
├── lib/
│   ├── engineering-stack.ts   # VPC, Lambda, API Gateway, DynamoDB, OAM Link
│   └── analytics-stack.ts     # OAM Sink, cross-account CloudWatch Dashboard
├── lambda/
│   └── project-status/
│       └── index.ts           # Lambda handler (TypeScript, bundled by NodejsFunction)
├── docs/
│   └── architecture.drawio    # Architecture diagram source (draw.io)
├── cdk.json                   # CDK configuration and feature flags
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

Before deploying, complete the following manually (console/wizard steps):

1. **AWS Organizations** — enabled on your personal (management) account with "All features" on
2. **Control Tower Landing Zone** — deployed in `us-east-1`, `Workloads` OU created
3. **Engineering and Analytics accounts** — provisioned via Account Factory, placed in `Workloads` OU
4. **SCPs** — the three governance SCPs attached to the `Workloads` OU (see Phase 5 of build guide)
5. **Okta** — developer tenant created, users and groups defined, AWS IAM Identity Center SAML app added
6. **IAM Identity Center** — identity source switched to Okta (external IdP), SAML + SCIM configured, permission sets created and assigned to Okta groups per account
7. **CDK bootstrapped** — run `cdk bootstrap` in both Engineering and Analytics accounts (see Bootstrap section below)

---

## Environment Setup

```bash
# Clone the repo and install dependencies
git clone <your-repo-url>
cd turingtree-infra
npm install

# Export account IDs (find these in Control Tower or AWS Organizations console)
export ENGINEERING_ACCOUNT_ID=111122223333
export ANALYTICS_ACCOUNT_ID=444455556666
```

---

## CDK Bootstrap (One-Time Per Account)

CDK bootstrapping creates the S3 bucket and IAM deployment roles CDK needs to deploy stacks into an account. You must do this once per account per region before any deployment.

```bash
# Step 1: Log in to the IAM Identity Center access portal
# Navigate to: https://d-XXXXXXXXXX.awsapps.com/start
# Assume the AdministratorAccess role in the Engineering account
# Export the credentials shown in the portal as environment variables

# Step 2: Bootstrap the Engineering account
cdk bootstrap aws://$ENGINEERING_ACCOUNT_ID/us-east-1

# Step 3: Switch credentials to the Analytics account via the portal, then:
cdk bootstrap aws://$ANALYTICS_ACCOUNT_ID/us-east-1
```

---

## Deployment Order

> ⚠️ **Critical:** The Analytics stack MUST be deployed first because the Engineering
> stack's OAM Link requires the OAM Sink ARN (a CloudFormation export from the Analytics stack).

```bash
# ── Step 1: Deploy the Analytics stack (creates the OAM Sink) ──────────────
# Switch credentials to the Analytics account via the IAM Identity Center portal
export AWS_ACCESS_KEY_ID=...      # From the Analytics account session
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...

npm run deploy:analytics
# CDK will output: TuringTree-Analytics-SinkArn = arn:aws:oam:us-east-1:...

# ── Step 2: Deploy the Engineering stack ───────────────────────────────────
# Switch credentials to the Engineering account via the portal
export AWS_ACCESS_KEY_ID=...      # From the Engineering account session
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...

npm run deploy:engineering
# CDK will output: ApiGatewayUrl, LambdaFunctionName, VpcId, etc.
```

---

## Testing the Full Federation Flow

### Test 1 — Developer persona (should succeed on Engineering API)

```bash
# 1. Log in to the IAM Identity Center access portal as dev.user@turingtree.io
#    The portal will show only the Engineering account with DeveloperAccess.
# 2. Click "Command line or programmatic access" and export credentials.

# 3. Call the Project Status API using AWS CLI (SigV4 signing is automatic)
#    Replace <API_URL> with the CDK deploy output: TuringTree-Engineering-ApiUrl
aws apigateway get-rest-apis --region us-east-1     # Should succeed (DeveloperAccess allows this)

# 4. Invoke the Lambda directly
aws lambda invoke \
  --function-name TuringTree-ProjectStatus \
  --payload '{}' \
  --region us-east-1 \
  /tmp/response.json && cat /tmp/response.json

# 5. Call the REST API endpoint (requires awscurl for SigV4 signing)
#    Install: pip install awscurl
awscurl --service execute-api \
  --region us-east-1 \
  "<API_URL>v1/projects/p-001"
# Expected: HTTP 200 with TuringTree Project data
```

### Test 2 — Analyst persona (should be DENIED on Engineering API)

```bash
# 1. Log out and log in as analyst.user@turingtree.io
#    The portal will show ONLY the Analytics account. Engineering is not visible.
# 2. Export the Analytics account credentials.

# 3. Attempt to call the Engineering Lambda directly (cross-account)
aws lambda invoke \
  --function-name arn:aws:lambda:us-east-1:$ENGINEERING_ACCOUNT_ID:function:TuringTree-ProjectStatus \
  --payload '{}' \
  --region us-east-1 \
  /tmp/denied.json
# Expected: AccessDeniedException — AnalystAccess has no lambda:InvokeFunction permission
#           on the Engineering account. Save this output as evidence for the portfolio.

# 4. Navigate to CloudWatch in the Analytics account via the portal
#    The TuringTree-Engineering-Health dashboard should be visible and populated
#    with Engineering account metrics via the OAM cross-account link.
```

### Test 3 — SCP enforcement (governance layer proof)

```bash
# Using Engineering account credentials (DeveloperAccess):
aws iam create-user --user-name test-iam-user --region us-east-1
# Expected: AccessDenied — the SCP on the Workloads OU denies iam:CreateUser
#           regardless of what the DeveloperAccess permission set allows.
#           This proves the SCP is a hard ceiling, not just a policy preference.
```

---

## Key Architecture Decisions

**Why IAM authorization on API Gateway instead of Cognito?** Cognito is for customer-facing (CIAM) scenarios where external users sign up with email/password. TuringTree's employees already have AWS identity from the Okta → STS flow. Their temporary STS credentials are AWS credentials, so SigV4 is the natural and correct authorization mechanism. Adding Cognito would be a redundant identity layer on top of an already-complete one.

**Why private isolated subnets with no NAT Gateway?** TuringTree's security policy mandates all compute in private subnets. The Lambda only needs to reach DynamoDB, which is served via a free VPC Gateway Endpoint. No public internet access is needed, so no NAT Gateway is needed — removing both the cost (~$32/month/AZ) and the internet exposure.

**Why deploy Analytics before Engineering?** The Engineering stack creates an OAM Link that references the OAM Sink ARN in the Analytics account. The Sink must exist first. This is a real-world CDK dependency management pattern — documenting it shows understanding of multi-account deployment sequencing.

**Why CDK TypeScript over CloudFormation YAML?** CDK synthesizes to CloudFormation at deploy time, so you get all of CloudFormation's rollback, change sets, and state management. TypeScript adds type safety (misconfigured props are caught at compile time), reusability (constructs can be shared across stacks), and testability (CDK assertions). Enterprise teams building AWS-native workloads increasingly default to CDK for exactly these reasons.

---

## Cost Estimate (Portfolio/Dev Usage)

| Service | Estimated Monthly Cost |
|---|---|
| AWS Organizations | Free |
| IAM Identity Center | Free |
| Control Tower | Free (pay for underlying services) |
| CloudTrail (org-level trail) | ~$2/month |
| AWS Config (~3 accounts, 1 region) | ~$3–5/month |
| Lambda (near-zero invocations) | Free tier |
| API Gateway (near-zero calls) | Free tier |
| DynamoDB (on-demand, idle) | Free tier |
| CloudWatch Logs/Dashboards | ~$1/month |
| **Total estimate** | **~$6–8/month** |

> Teardown: `cdk destroy TuringTree-Engineering` then `cdk destroy TuringTree-Analytics`.
> Also disable Control Tower and leave Organizations to stop Config recording costs.

---

## What This Project Demonstrates

This project provides hands-on evidence of the following production-grade skills:

**Security:** SAML 2.0 federated authentication, STS temporary credential issuance, SigV4 request authorization, least-privilege IAM Permission Sets, SCP governance, no long-lived human credentials, CloudTrail audit logging, VPC Flow Logs, DynamoDB encryption at rest

**Identity Architecture:** IdP as the single source of identity truth, SCIM for automated identity lifecycle, separation of authentication (Okta) from authorization (IAM), group-to-role mapping, cross-account access boundaries enforced at the account level

**Networking:** Custom VPC design, private isolated subnets, VPC Gateway Endpoints, Security Group least-privilege rules, Lambda VPC attachment patterns

**Governance:** AWS multi-account strategy, Control Tower Landing Zone, Account Factory, OU hierarchy design, SCP policy-as-code

**IaC Engineering:** AWS CDK TypeScript, multi-stack multi-account deployment, CDK cross-stack exports, NodejsFunction with esbuild bundling, CDK cdk synth/diff workflow

**Observability:** CloudWatch OAM cross-account metric sharing, CloudWatch Dashboards, X-Ray distributed tracing, API Gateway access logging, VPC Flow Logs

---

*Built by [Malik Spruill] | Software Engineer & AWS Certified Solutions Architect
