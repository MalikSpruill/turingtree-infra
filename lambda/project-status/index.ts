/**
 * TuringTree — Project Status Lambda Handler
 *
 * This function serves the GET /projects/{projectId} endpoint exposed by
 * API Gateway. It is protected by IAM authorization (AWS_IAM), meaning every
 * incoming request must be signed with Signature Version 4 (SigV4) using
 * valid AWS credentials.
 *
 * In the TuringTree federation flow, those credentials are the temporary
 * credentials issued by AWS STS when a developer authenticates via Okta
 * SAML and assumes their DeveloperAccess role through IAM Identity Center.
 *
 * The function first checks in-memory mock data (for reliable portfolio
 * demonstration), then falls back to a real DynamoDB GetItem call if the
 * project ID is not found in the mock set. This means you can demonstrate
 * the DynamoDB integration without pre-seeding the table.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ─────────────────────────────────────────────────────────────────────────────
// INITIALIZATION — runs once per Lambda execution context (container),
// not on every invocation. Placing SDK clients here allows them to be
// reused across warm invocations, reducing latency and connection overhead.
// This is the standard AWS Lambda performance optimization pattern.
// ─────────────────────────────────────────────────────────────────────────────
const ddbClient = new DynamoDBClient({ region: process.env.REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  // translateConfig: unmarshals DynamoDB's AttributeValue format into plain JS
  // objects automatically, so we get { projectId: 'p-001' } not { projectId: { S: 'p-001' } }
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env.TABLE_NAME!;

// ─────────────────────────────────────────────────────────────────────────────
// MOCK PROJECT DATA
//
// These records represent TuringTree's internal projects and are used for
// portfolio demonstration. They mirror what would actually live in DynamoDB
// in a real deployment. The mock data also lets you demonstrate the API
// working immediately after deploy without needing a separate seeding script.
//
// The `owner` field intentionally uses the same usernames configured in Okta,
// making the connection between the identity system and the data explicit.
// ─────────────────────────────────────────────────────────────────────────────
interface Project {
  projectId: string;
  name: string;
  status: 'Planning' | 'In Progress' | 'Complete' | 'On Hold';
  team: string;
  owner: string;
  lastUpdated: string;
  description: string;
}

const MOCK_PROJECTS: Record<string, Project> = {
  'p-001': {
    projectId: 'p-001',
    name: 'Apollo Platform',
    status: 'In Progress',
    team: 'Platform Engineering',
    owner: 'dev.user@turingtree.io',
    lastUpdated: '2025-04-15',
    description: 'Core infrastructure modernization: federated identity, multi-account landing zone.',
  },
  'p-002': {
    projectId: 'p-002',
    name: 'Orion Data Pipeline',
    status: 'Planning',
    team: 'Data Engineering',
    owner: 'analyst.user@turingtree.io',
    lastUpdated: '2025-04-10',
    description: 'Real-time streaming pipeline from application events to the analytics data lake.',
  },
  'p-003': {
    projectId: 'p-003',
    name: 'Hermes Notifications',
    status: 'Complete',
    team: 'Platform Engineering',
    owner: 'dev.user@turingtree.io',
    lastUpdated: '2025-03-28',
    description: 'Serverless SNS/SQS event notification service for internal tooling integrations.',
  },
  'p-004': {
    projectId: 'p-004',
    name: 'Delphi Reporting',
    status: 'On Hold',
    team: 'Analytics',
    owner: 'analyst.user@turingtree.io',
    lastUpdated: '2025-04-01',
    description: 'Self-service business intelligence dashboard for executive cost reporting.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE HELPERS
//
// Centralizing response construction ensures consistent headers and
// content-type across all return paths. The 'Access-Control-Allow-Origin'
// header is omitted intentionally — this is an internal API, not a public
// web-facing service. CORS is not needed for SigV4-authenticated callers.
// ─────────────────────────────────────────────────────────────────────────────
const jsonResponse = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    // Security headers — enterprise baseline for any HTTP API
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The requestContext.identity.userArn is populated by API Gateway IAM auth.
  // It contains the ARN of the IAM principal that signed the request — in our
  // case, the assumed-role session from STS (the federated developer's session).
  // This is available for audit purposes and would be logged to CloudTrail.
  const callerArn = event.requestContext?.identity?.userArn ?? 'unknown';
  const projectId = event.pathParameters?.projectId;

  console.log(JSON.stringify({
    event: 'ProjectStatusRequest',
    projectId,
    callerArn,    // Who made this request (from their STS session)
    httpMethod: event.httpMethod,
    sourceIp: event.requestContext?.identity?.sourceIp,
  }));

  if (!projectId) {
    return jsonResponse(400, {
      error: 'BAD_REQUEST',
      message: 'projectId path parameter is required',
    });
  }

  // Check mock data first — fast, reliable, zero cost for demo purposes
  const mockProject = MOCK_PROJECTS[projectId];
  if (mockProject) {
    console.log(JSON.stringify({ event: 'MockCacheHit', projectId }));
    return jsonResponse(200, {
      source: 'mock-data',
      data: mockProject,
      _meta: { callerArn },
    });
  }

  // Fall through to DynamoDB for any project ID not in the mock set
  // This demonstrates the actual DynamoDB integration
  try {
    console.log(JSON.stringify({ event: 'DynamoDBLookup', projectId, tableName: TABLE_NAME }));

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { projectId },
      })
    );

    if (!result.Item) {
      return jsonResponse(404, {
        error: 'NOT_FOUND',
        message: `Project '${projectId}' was not found.`,
      });
    }

    return jsonResponse(200, {
      source: 'dynamodb',
      data: result.Item,
      _meta: { callerArn },
    });
  } catch (error) {
    // Log full error server-side (visible in CloudWatch Logs for the operator)
    // but return only a generic message to the caller (information security practice)
    console.error(JSON.stringify({
      event: 'DynamoDBError',
      projectId,
      error: error instanceof Error ? error.message : String(error),
    }));

    return jsonResponse(500, {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please contact the Platform Engineering team.',
    });
  }
};
