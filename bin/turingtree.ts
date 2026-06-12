#!/usr/bin/env node
/**
 * TuringTree Infrastructure — CDK App Entry Point
 *
 * This file is the root of the CDK application. It wires together all stacks
 * and defines which AWS account and region each stack is deployed into.
 *
 * MULTI-ACCOUNT DEPLOYMENT PATTERN:
 * Each stack targets a specific AWS account via the `env` prop. When you run
 * `cdk deploy TuringTree-Engineering`, CDK uses your currently active AWS
 * credentials to assume the CDKToolkit deployment role in the Engineering
 * account — credentials you obtained through the IAM Identity Center access
 * portal. This is the enterprise-standard CDK multi-account deployment flow.
 *
 * ENVIRONMENT VARIABLES (set before deploying):
 *   ENGINEERING_ACCOUNT_ID  — 12-digit account ID of the Engineering account
 *   ANALYTICS_ACCOUNT_ID    — 12-digit account ID of the Analytics account
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EngineeringStack } from '../lib/engineering-stack';
import { AnalyticsStack } from '../lib/analytics-stack';

const app = new cdk.App();

// Validate that the required environment variables are present before synthesis.
// Failing early with a clear message is better than a cryptic CloudFormation error.
const engineeringAccountId = process.env.ENGINEERING_ACCOUNT_ID;
const analyticsAccountId = process.env.ANALYTICS_ACCOUNT_ID;

if (!engineeringAccountId || !analyticsAccountId) {
  throw new Error(
    '\n[TuringTree CDK] Missing required environment variables.\n' +
    'Please export the following before running cdk commands:\n' +
    '  export ENGINEERING_ACCOUNT_ID=<12-digit-account-id>\n' +
    '  export ANALYTICS_ACCOUNT_ID=<12-digit-account-id>\n'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Engineering Account Stack
// VPC, Lambda, API Gateway, DynamoDB — the internal Project Status API.
// Deployed into the Engineering AWS account under the Workloads OU.
// ─────────────────────────────────────────────────────────────────────────────
new EngineeringStack(app, 'TuringTree-Engineering', {
  env: {
    account: engineeringAccountId,
    region: 'us-east-1',
  },
  // The OAM Sink ARN this stack links to is supplied at deploy time as the
  // `OamSinkArn` CloudFormation parameter (deploy Analytics first, then pass its
  // MonitoringSinkArn output). See the OAM Link section in engineering-stack.ts.
  description:
    'TuringTree Engineering workload: private VPC, Lambda Project Status API, API Gateway (IAM auth), DynamoDB',
  tags: {
    Project: 'TuringTree',
    Environment: 'Production',
    ManagedBy: 'CDK',
    Owner: 'platform-engineering',
    CostCenter: 'engineering',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Analytics Account Stack
// CloudWatch OAM Sink + cross-account dashboard observing Engineering metrics.
// Deployed into the Analytics AWS account under the Workloads OU.
// ─────────────────────────────────────────────────────────────────────────────
new AnalyticsStack(app, 'TuringTree-Analytics', {
  env: {
    account: analyticsAccountId,
    region: 'us-east-1',
  },
  engineeringAccountId, // Authorizes only this account to link into the OAM Sink
  description:
    'TuringTree Analytics workload: CloudWatch OAM Sink, cross-account Engineering health dashboard',
  tags: {
    Project: 'TuringTree',
    Environment: 'Production',
    ManagedBy: 'CDK',
    Owner: 'analytics-team',
    CostCenter: 'analytics',
  },
});

app.synth();
