import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as oam from 'aws-cdk-lib/aws-oam';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  PROJECT_STATUS_FUNCTION_NAME,
  PROJECT_STATUS_API_NAME,
  API_STAGE_NAME,
} from './constants';

/**
 * Props for the Engineering stack.
 *
 * No extra props are required: the cross-account observability grant is owned by
 * the Analytics account's OAM Sink policy (which names this Engineering account),
 * and the Sink ARN this stack links to is supplied at deploy time as the
 * `OamSinkArn` CloudFormation parameter (see section 7 below).
 */
export interface EngineeringStackProps extends cdk.StackProps {}

/**
 * EngineeringStack
 *
 * Provisions the TuringTree internal Project Status API, hosted in a
 * private VPC in the Engineering AWS account. This is the workload
 * that TuringTree Developers (authenticated via Okta → STS) can invoke
 * using their temporary IAM credentials (SigV4-signed requests).
 *
 * Architecture:
 *   Okta SAML → IAM Identity Center → STS temp creds
 *     → API Gateway (IAM auth, SigV4) → Lambda (private subnet) → DynamoDB
 *
 * The cross-account OAM Link at the bottom of this stack grants the
 * Analytics account permission to observe this account's metrics —
 * without giving it any write access or role assumption rights.
 */
export class EngineeringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: EngineeringStackProps) {
    super(scope, id, props);

    // ═════════════════════════════════════════════════════════════════════════
    // 1. CUSTOM VPC
    //
    // Enterprise justification: TuringTree's security policy mandates that
    // all compute resources run in private subnets. We never rely on the
    // default VPC — the default VPC is provisioned with public subnets and
    // should be considered a dev/debug tool, not a production foundation.
    //
    // PRIVATE_ISOLATED means these subnets have NO route to the internet —
    // no NAT Gateway, no Internet Gateway. Lambda only needs to reach
    // DynamoDB, which we handle via a free Gateway Endpoint below.
    //
    // Two Availability Zones: Lambda VPC attachment distributes ENIs across
    // AZs for resilience. This is the minimum recommended for production.
    // ═════════════════════════════════════════════════════════════════════════
    const vpc = new ec2.Vpc(this, 'TuringTreeEngineeringVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 0, // No NAT Gateway = no ~$32/month/AZ cost + no internet exposure
      subnetConfiguration: [
        {
          cidrMask: 24,        // /24 = 256 IPs per subnet, ample for Lambda ENIs
          name: 'PrivateLambda',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      // Restrict default security group — enterprise baseline
      restrictDefaultSecurityGroup: true,
    });

    // VPC FLOW LOGS — Enterprise standard for network-level audit trail.
    // Logs all accepted/rejected traffic in the VPC to CloudWatch Logs.
    // This is separate from CloudTrail (API-level) and gives you packet-level
    // visibility for security investigations.
    vpc.addFlowLog('TuringTreeVpcFlowLog', {
      trafficType: ec2.FlowLogTrafficType.ALL,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'VpcFlowLogGroup', {
          logGroupName: '/turingtree/vpc/flow-logs',
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      ),
    });

    // DYNAMODB GATEWAY ENDPOINT — Routes DynamoDB traffic through the AWS
    // private backbone rather than the public internet. Gateway Endpoints
    // are free (unlike Interface Endpoints which cost ~$7/month/AZ).
    // This is the correct and cost-effective pattern for isolated subnets.
    vpc.addGatewayEndpoint('DynamoDBGatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      // Automatically added to all route tables in the VPC
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 2. SECURITY GROUP FOR LAMBDA
    //
    // Principle: deny everything, then allow only what is necessary.
    // No inbound rules — Lambda is invoked via the AWS service plane (API
    // Gateway → Lambda service → your function), not via TCP connections
    // to the function's ENI. Outbound restricted to HTTPS only.
    // ═════════════════════════════════════════════════════════════════════════
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      securityGroupName: 'turingtree-lambda-sg',
      description: 'Project Status Lambda: no inbound, HTTPS egress only (to DynamoDB via Gateway Endpoint)',
      allowAllOutbound: false, // We define egress explicitly below
    });

    // Egress: HTTPS only. The DynamoDB Gateway Endpoint intercepts this
    // traffic and routes it privately — it never leaves the AWS network.
    lambdaSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS egress to DynamoDB via Gateway Endpoint'
    );

    // ═════════════════════════════════════════════════════════════════════════
    // 3. DYNAMODB TABLE
    //
    // PAY_PER_REQUEST: no cost when idle, no capacity planning. Correct for
    // a variable-traffic internal API.
    //
    // AWS_MANAGED encryption: data at rest encrypted with an AWS-managed
    // KMS key. Enterprise baseline requirement. If TuringTree needed
    // compliance controls over key rotation, we'd use CUSTOMER_MANAGED.
    //
    // Point-in-time recovery: standard enterprise data protection baseline.
    // Allows restoration to any second in the last 35 days.
    // ═════════════════════════════════════════════════════════════════════════
    const projectTable = new dynamodb.Table(this, 'ProjectTable', {
      tableName: 'TuringTree-Projects',
      partitionKey: {
        name: 'projectId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Safe to destroy for portfolio teardown
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 4. LAMBDA EXECUTION ROLE
    //
    // We build the role explicitly rather than letting CDK auto-create one.
    // This is important for portfolio demonstration: it shows you understand
    // what permissions Lambda actually needs, rather than defaulting to
    // overly-broad managed policies.
    //
    // AWSLambdaVPCAccessExecutionRole grants:
    //   - ec2:CreateNetworkInterface / DescribeNetworkInterfaces / DeleteNetworkInterface
    //     (required for Lambda to attach ENIs to your private subnets)
    //   - logs:CreateLogGroup / CreateLogStream / PutLogEvents
    //     (required for Lambda to write to CloudWatch Logs)
    //
    // We then use grantReadData() to add the minimal DynamoDB actions —
    // GetItem, Query, Scan, BatchGetItem — scoped to the specific table ARN.
    // The function has no write permissions on DynamoDB.
    // ═════════════════════════════════════════════════════════════════════════
    const lambdaRole = new iam.Role(this, 'ProjectStatusLambdaRole', {
      roleName: 'TuringTree-ProjectStatus-Lambda-Role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Least-privilege execution role for Project Status Lambda',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
    });

    // Grant read-only access scoped to exactly this table
    projectTable.grantReadData(lambdaRole);

    // ═════════════════════════════════════════════════════════════════════════
    // 5. LAMBDA FUNCTION (NodejsFunction)
    //
    // NodejsFunction uses esbuild to automatically bundle and transpile the
    // TypeScript source at `entry` into a deployment-ready JavaScript bundle.
    // You never need to run `tsc` or create a zip manually — CDK handles it.
    //
    // KEY SECURITY SETTINGS:
    //   - vpc + vpcSubnets: places the function in our private isolated subnets
    //   - securityGroups: attaches the least-privilege security group
    //   - role: uses our explicitly defined execution role
    //   - tracing: ACTIVE enables AWS X-Ray distributed tracing
    //     (enterprise observability standard — correlates API Gateway → Lambda)
    // ═════════════════════════════════════════════════════════════════════════
    const projectStatusFn = new NodejsFunction(this, 'ProjectStatusFunction', {
      functionName: PROJECT_STATUS_FUNCTION_NAME,
      entry: path.join(__dirname, '../lambda/project-status/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      role: lambdaRole,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [lambdaSg],
      environment: {
        TABLE_NAME: projectTable.tableName,
        REGION: this.region,
        // NODE_OPTIONS is an AWS best-practice for Lambda:
        // enables source map support for readable stack traces in CloudWatch
        NODE_OPTIONS: '--enable-source-maps',
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'TuringTree internal Project Status API handler',
      bundling: {
        // esbuild bundling config — minify reduces cold start time
        minify: true,
        sourceMap: true,
        // Externalize the AWS SDK since Lambda runtime includes it
        // This dramatically reduces bundle size
        externalModules: ['@aws-sdk/*'],
      },
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 6. API GATEWAY REST API WITH IAM AUTHORIZATION
    //
    // WHY IAM AUTH (NOT COGNITO):
    // TuringTree employees authenticate via Okta SAML → AWS STS, which issues
    // them temporary AWS credentials. These credentials ARE AWS IAM credentials.
    // Using IAM auth (SigV4) on the API means the same credentials that granted
    // them access to the Engineering account also authorize them to call this API.
    // It's a single, coherent authorization chain — no second identity layer needed.
    //
    // Cognito would be appropriate if external customers (not internal employees)
    // were calling this API. Cognito is customer identity; IAM Identity Center
    // is workforce identity. Using the right tool for the context matters.
    //
    // SigV4: every API call is signed with the caller's access key, secret key,
    // and session token. AWS validates the signature server-side, verifying
    // the caller is who they claim to be and the request wasn't tampered with.
    // ═════════════════════════════════════════════════════════════════════════
    const api = new apigateway.RestApi(this, 'ProjectStatusApi', {
      restApiName: PROJECT_STATUS_API_NAME,
      description: 'TuringTree internal Project Status API (IAM-authorized, SigV4)',
      endpointConfiguration: {
        // REGIONAL: serves from the same region as the Lambda.
        // For internal workforce APIs, Regional endpoints are recommended
        // over Edge (CloudFront-backed) because the callers are known
        // internal employees, not geographically distributed consumers.
        types: [apigateway.EndpointType.REGIONAL],
      },
      deployOptions: {
        stageName: API_STAGE_NAME,
        tracingEnabled: true,         // X-Ray traces propagated from API Gateway → Lambda
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,      // Never log request/response bodies — they may contain PII
        metricsEnabled: true,         // Enables 4XX, 5XX, latency metrics in CloudWatch
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiAccessLogGroup', {
            logGroupName: '/turingtree/api/access-logs',
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(projectStatusFn, {
      proxy: true, // Proxy integration: pass the full request to Lambda
    });

    // Define the /projects resource tree
    const projects = api.root.addResource('projects');
    const projectById = projects.addResource('{projectId}');

    // GET /projects/{projectId} — protected by AWS IAM (SigV4)
    projectById.addMethod('GET', lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.IAM,
      methodResponses: [
        { statusCode: '200' },
        { statusCode: '403' },
        { statusCode: '404' },
        { statusCode: '500' },
      ],
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 7. CLOUDWATCH OAM LINK (Cross-Account Observability)
    //
    // This OAM Link, created in the Engineering account, connects TO the
    // OAM Sink in the Analytics account. It authorizes the Analytics account
    // to read CloudWatch metrics and log groups from this account.
    //
    // This is a uni-directional read grant: the Analytics account can OBSERVE
    // Engineering's metrics — it cannot invoke APIs, assume roles, or modify
    // any resources in this account. This separation is the whole point of the
    // cross-account access story: the Analyst persona sees data, not resources.
    //
    // HOW THE SINK ARN GETS HERE (and why it is NOT a CloudFormation export):
    //   CloudFormation Export/Fn::ImportValue cross-stack references work only
    //   within a SINGLE account and region. The Sink lives in the Analytics
    //   account, so its export is invisible to this (Engineering) account —
    //   importing it would fail with "No export named ... found".
    //
    //   Instead we accept the Sink ARN as a CloudFormation PARAMETER. You deploy
    //   AnalyticsStack first, read its `MonitoringSinkArn` output, and pass it on
    //   the Engineering deploy: `--parameters OamSinkArn=arn:aws:oam:...:sink/...`.
    //   CloudFormation persists the parameter on the stack, so later deploys from
    //   any machine/CI reuse the stored value without re-supplying it.
    //
    //   The Link is wrapped in a condition so the stack can also deploy with an
    //   empty OamSinkArn (e.g. a first pass before the Sink exists, or teardown);
    //   in that case the Link is simply omitted.
    // ═════════════════════════════════════════════════════════════════════════
    const oamSinkArn = new cdk.CfnParameter(this, 'OamSinkArn', {
      type: 'String',
      default: '',
      description:
        'ARN of the OAM Sink in the Analytics account (the TuringTree-Analytics ' +
        'MonitoringSinkArn output). Leave empty to skip the cross-account link.',
    });

    const hasOamSink = new cdk.CfnCondition(this, 'HasOamSink', {
      expression: cdk.Fn.conditionNot(
        cdk.Fn.conditionEquals(oamSinkArn.valueAsString, '')
      ),
    });

    const oamLink = new oam.CfnLink(this, 'EngineeringToAnalyticsOamLink', {
      labelTemplate: '$AccountName',  // Displays as the account name in the sink
      resourceTypes: [
        'AWS::CloudWatch::Metric',
        'AWS::Logs::LogGroup',
      ],
      // Format: arn:aws:oam:us-east-1:<analytics-account-id>:sink/<sink-id>
      sinkIdentifier: oamSinkArn.valueAsString,
    });
    oamLink.cfnOptions.condition = hasOamSink;

    // ═════════════════════════════════════════════════════════════════════════
    // 8. STACK OUTPUTS
    //
    // CloudFormation Outputs serve two purposes here:
    //   1. They export values used by other stacks (cross-stack references)
    //   2. They surface important URLs and identifiers for the operator
    //      after deployment, visible in the CDK deploy output and AWS Console
    // ═════════════════════════════════════════════════════════════════════════
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'Base URL for the TuringTree Project Status REST API',
      exportName: 'TuringTree-Engineering-ApiUrl',
    });

    new cdk.CfnOutput(this, 'ProjectsEndpoint', {
      value: `${api.url}projects/{projectId}`,
      description: 'Example endpoint: GET /projects/p-001',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: projectStatusFn.functionName,
      description: 'Lambda function name (used by Analytics stack for cross-account metrics)',
      exportName: 'TuringTree-Engineering-LambdaName',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'Engineering custom VPC ID',
    });

    new cdk.CfnOutput(this, 'DynamoDbTableName', {
      value: projectTable.tableName,
      description: 'Projects DynamoDB table name',
    });
  }
}
