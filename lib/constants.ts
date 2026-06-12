/**
 * TuringTree — Shared infrastructure constants.
 *
 * These values are referenced by more than one stack. The Engineering stack
 * uses them to NAME its resources (Lambda function, REST API, stage); the
 * Analytics stack uses the same values to BUILD cross-account CloudWatch metric
 * widgets that point at those Engineering resources.
 *
 * Because the names are fixed and known at synth time, there is no cross-stack
 * dependency to resolve here — both stacks simply import the same literal. This
 * deliberately avoids a cross-account CloudFormation export/import, which is not
 * possible: CloudFormation exports are scoped to a single account and region.
 */

/** Name of the Engineering Project Status Lambda function. */
export const PROJECT_STATUS_FUNCTION_NAME = 'TuringTree-ProjectStatus';

/** Name of the Engineering Project Status API Gateway REST API. */
export const PROJECT_STATUS_API_NAME = 'TuringTree-ProjectStatus-API';

/** API Gateway stage name (also the CloudWatch `Stage` metric dimension value). */
export const API_STAGE_NAME = 'v1';

/** Home region for the entire TuringTree environment. */
export const HOME_REGION = 'us-east-1';
