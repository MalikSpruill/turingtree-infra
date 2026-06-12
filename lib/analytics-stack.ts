import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as oam from 'aws-cdk-lib/aws-oam';
import { Construct } from 'constructs';
import {
  PROJECT_STATUS_FUNCTION_NAME,
  PROJECT_STATUS_API_NAME,
  API_STAGE_NAME,
  HOME_REGION,
} from './constants';

/**
 * Props for the Analytics stack.
 * We need the Engineering account ID to configure the OAM Sink policy
 * (which account is allowed to link and share metrics into this sink).
 *
 * The Engineering Lambda/API names used to build the dashboard widgets are NOT
 * props: they are fixed, shared constants (see lib/constants.ts) that both
 * stacks import. This avoids a cross-account CloudFormation export/import, which
 * is impossible — exports are scoped to a single account and region.
 */
export interface AnalyticsStackProps extends cdk.StackProps {
  engineeringAccountId: string;
}

/**
 * AnalyticsStack
 *
 * Provisions the TuringTree Analytics account workload.
 *
 * This stack demonstrates a critical enterprise access-control concept:
 * the Analyst persona can OBSERVE what is happening in the Engineering
 * account (via this cross-account CloudWatch dashboard) without having
 * any access to Engineering account resources, IAM roles, or APIs.
 *
 * The access boundary is enforced at two levels:
 *   1. IAM Identity Center: the TuringTree-Analysts group is only
 *      assigned the AnalystAccess permission set on this (Analytics)
 *      account. They cannot access the Engineering account at all.
 *   2. OAM (Observability Access Manager): the Engineering account
 *      publishes a one-directional metric share to this account's Sink.
 *      The Analytics account can read those metrics; it cannot write to
 *      Engineering or assume any roles there.
 *
 * This pattern — read-only observability without account access — is
 * the AWS-recommended architecture for multi-team operations dashboards.
 */
export class AnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    const { engineeringAccountId } = props;

    // ═════════════════════════════════════════════════════════════════════════
    // 1. CLOUDWATCH OAM SINK (Observability Access Manager)
    //
    // The Sink is the "receiver" side of a cross-account observability link.
    // It lives in the monitoring/analytics account. The Engineering account
    // will create a corresponding Link that points to this Sink's ARN.
    //
    // The Sink policy defines which accounts are allowed to link into it and
    // what resource types they can share. This is a resource-based policy —
    // the Analytics account controls who it accepts data from.
    //
    // DEPLOYMENT ORDER REQUIREMENT:
    //   AnalyticsStack MUST be deployed BEFORE EngineeringStack, because the
    //   Engineering stack's OAM Link needs this Sink's ARN to exist. After this
    //   stack deploys, take the `MonitoringSinkArn` output and feed it to the
    //   Engineering deploy as the `OamSinkArn` parameter. (A CloudFormation
    //   export would NOT work — the Engineering stack is in another account, and
    //   exports/imports are confined to a single account and region.)
    // ═════════════════════════════════════════════════════════════════════════
    const monitoringSink = new oam.CfnSink(this, 'TuringTreeMonitoringSink', {
      name: 'TuringTree-Monitoring-Sink',
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              // Only the Engineering account can link into this Sink.
              // Even if another account tried to create a Link pointing here,
              // this policy would deny it. Explicit allow = deny by default.
              AWS: `arn:aws:iam::${engineeringAccountId}:root`,
            },
            Action: [
              'oam:CreateLink',
              'oam:UpdateLink',
            ],
            Resource: '*',
            Condition: {
              // Restrict the resource types that can be shared.
              // We accept CloudWatch Metrics and Log Groups — nothing else.
              // This prevents Engineering from accidentally (or intentionally)
              // sharing resource types we don't want here.
              'ForAllValues:StringEquals': {
                'oam:ResourceTypes': [
                  'AWS::CloudWatch::Metric',
                  'AWS::Logs::LogGroup',
                ],
              },
            },
          },
        ],
      },
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 2. CLOUDWATCH DASHBOARD — Cross-Account Engineering Health View
    //
    // This dashboard is what TuringTree Analysts actually see when they log
    // in via IAM Identity Center and navigate to CloudWatch in the Analytics
    // account. It surfaces Engineering account Lambda and API Gateway metrics
    // without giving Analysts any access to the Engineering account itself.
    //
    // CROSS-ACCOUNT METRICS: by passing `account: engineeringAccountId` to
    // each Metric definition, CDK generates dashboard widgets that query
    // metrics from the Engineering account. This works because of the OAM
    // Link established between the accounts — CloudWatch uses the link
    // permissions to authorize the cross-account metric read.
    //
    // The Engineering Lambda/API names come from shared constants (lib/constants.ts),
    // the same literals the Engineering stack uses to name those resources. No
    // cross-stack reference is involved — the names are fixed and known at synth.
    // ═════════════════════════════════════════════════════════════════════════

    // Lambda Metric definitions — scoped to the Engineering account via `account`
    const lambdaInvocations = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Invocations',
      dimensionsMap: { FunctionName: PROJECT_STATUS_FUNCTION_NAME },
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      label: 'Invocations (5m)',
    });

    const lambdaErrors = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensionsMap: { FunctionName: PROJECT_STATUS_FUNCTION_NAME },
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      color: cloudwatch.Color.RED,
      label: 'Errors (5m)',
    });

    const lambdaDurationP99 = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      dimensionsMap: { FunctionName: PROJECT_STATUS_FUNCTION_NAME },
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'p99',
      color: cloudwatch.Color.ORANGE,
      label: 'Duration p99 (ms)',
    });

    const lambdaConcurrency = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      dimensionsMap: { FunctionName: PROJECT_STATUS_FUNCTION_NAME },
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
      label: 'Concurrent Executions (max)',
    });

    const lambdaThrottles = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Throttles',
      dimensionsMap: { FunctionName: PROJECT_STATUS_FUNCTION_NAME },
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      color: cloudwatch.Color.PURPLE,
      label: 'Throttles (5m)',
    });

    // API Gateway Metric definitions
    const apiDimensions = {
      ApiName: PROJECT_STATUS_API_NAME,
      Stage: API_STAGE_NAME,
    };

    const api4xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      dimensionsMap: apiDimensions,
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      color: cloudwatch.Color.ORANGE,
      label: '4XX Errors (5m)',
    });

    const api5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      dimensionsMap: apiDimensions,
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      color: cloudwatch.Color.RED,
      label: '5XX Errors (5m)',
    });

    const apiLatency = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Latency',
      dimensionsMap: apiDimensions,
      account: engineeringAccountId,
      region: HOME_REGION,
      period: cdk.Duration.minutes(5),
      statistic: 'p95',
      label: 'API Latency p95 (ms)',
    });

    // Build the CloudWatch Dashboard with logical widget groupings
    const dashboard = new cloudwatch.Dashboard(this, 'EngineeringHealthDashboard', {
      dashboardName: 'TuringTree-Engineering-Health',
      // Start default view at the last 3 hours
      start: '-PT3H',
    });

    // Row 1: Text header widget — contextualizes the dashboard for the Analyst
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          '# TuringTree Engineering Health Dashboard\n' +
          'Cross-account view of Engineering workload metrics. Sourced from the ' +
          `Engineering account (\`${engineeringAccountId}\`) via CloudWatch OAM.\n\n` +
          '> **Analytics team access only.** This dashboard is read-only. ' +
          'To modify Engineering infrastructure, contact the Platform Engineering team.',
        width: 24,
        height: 2,
      })
    );

    // Row 2: Lambda invocations, errors, throttles, and concurrency
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda: Invocations & Errors (Engineering Account)',
        left: [lambdaInvocations],
        right: [lambdaErrors],
        leftYAxis: { label: 'Count', showUnits: false },
        rightYAxis: { label: 'Errors', showUnits: false },
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda: Throttles & Concurrent Executions (Engineering Account)',
        left: [lambdaThrottles],
        right: [lambdaConcurrency],
        width: 12,
        height: 6,
      })
    );

    // Row 3: Lambda duration and API Gateway latency + error rates
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda: Duration p99 (Engineering Account)',
        left: [lambdaDurationP99],
        leftYAxis: { label: 'Milliseconds', showUnits: false },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway: Latency p95 (Engineering Account)',
        left: [apiLatency],
        leftYAxis: { label: 'Milliseconds', showUnits: false },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway: 4XX & 5XX Errors (Engineering Account)',
        left: [api4xx],
        right: [api5xx],
        width: 8,
        height: 6,
      })
    );

    // Row 4: Alarm status summary widgets for quick health overview
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Engineering Account — Active Alarms',
        alarms: [], // Alarms would be added here in a full production setup
        width: 24,
        height: 3,
      })
    );

    // ═════════════════════════════════════════════════════════════════════════
    // 3. STACK OUTPUTS
    // ═════════════════════════════════════════════════════════════════════════
    // Copy this ARN after deploy and pass it to the Engineering stack as the
    // `OamSinkArn` CloudFormation parameter. It is intentionally NOT a CloudFormation
    // export: the Engineering stack lives in a different account, and exports cannot
    // be imported across accounts.
    new cdk.CfnOutput(this, 'MonitoringSinkArn', {
      value: monitoringSink.attrArn,
      description:
        'OAM Sink ARN — pass to the Engineering deploy as --parameters OamSinkArn=<this value>',
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value:
        `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1` +
        `#dashboards:name=TuringTree-Engineering-Health`,
      description: 'Direct link to the Engineering Health CloudWatch Dashboard',
    });

    new cdk.CfnOutput(this, 'OamSinkName', {
      value: 'TuringTree-Monitoring-Sink',
      description: 'OAM Sink name',
    });
  }
}
