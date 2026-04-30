import {
  IWebhookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookResponseData,
  INodeExecutionData,
  IDataObject,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';

// ---------------------------------------------------------------------------
// Dynamic snake_case converter
//
// Strategy, applied in order:
//   1. Strip surrounding parentheses groups: "SUM(Review Score)" → "Review Score"
//   2. Replace any run of non-alphanumeric characters with a single underscore
//   3. Collapse multiple underscores, trim leading/trailing ones
//   4. Lowercase everything
//
// Examples:
//   "Reviewer Email Address"  → "reviewer_email_address"
//   "SUM(Review Score)"       → "sum_review_score"
//   "AGG(Review Criticality)" → "agg_review_criticality"
//   "Product Name"            → "product_name"
//   "  Weird  Key!! "         → "weird_key"
// ---------------------------------------------------------------------------
function toSnakeCase(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9]+/g, '_')   // non-alphanumeric runs → underscore
    .replace(/^_+|_+$/g, '')           // trim leading/trailing underscores
    .replace(/_+/g, '_')               // collapse consecutive underscores
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Types matching the expected Tableau webhook payload
// ---------------------------------------------------------------------------
interface TableauRow {
  [key: string]: unknown;
}

interface TableauPayload {
  metadata?: {
    dashboardName?: string;
    dashboardId?: string;
    timestamp?: string;
    user?: string;
  };
  data: TableauRow[];
  additional_data?: {
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------
export class Autom8TableauActionTrigger implements INodeType {
  description: INodeTypeDescription = {
    // ── Identity ─────────────────────────────────────────────────────────
    displayName: 'Autom8 Tableau - Data Action Trigger',
    name: 'autom8TableauActionTrigger',
    icon: { light: 'file:../../icons/autom8-action-light.svg', dark: 'file:../../icons/autom8-action-dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["path"] ? "/" + $parameter["path"] : ""}}',
    description:
      'Receives data from the Autom8 Tableau dashboard extension, and gets it ready for downstream processing.',
    usableAsTool: undefined,

    // ── Defaults ──────────────────────────────────────────────────────────
    defaults: {
      name: 'Autom8 Tableau - Data Action Trigger',
    },

    // ── Credentials ───────────────────────────────────────────────────────
    credentials: [
      {
        name: 'autom8TableauBearerApi',
        required: true,
        displayOptions: {
          show: {
            authentication: ['bearerToken'],
          },
        },
      },
    ],

    // ── Webhook setup ─────────────────────────────────────────────────────
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        isFullPath: true,
        responseMode: '={{$parameter["responseMode"]}}',
        responseData: 'firstEntryJson',
        path: '={{$parameter["path"]}}',
      },
    ],
 
    // ── User-facing parameters ────────────────────────────────────────────
    properties: [
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        options: [
          {
            name: 'Bearer Token',
            value: 'bearerToken',
          },
          {
            name: 'None',
            value: 'none',
          },
        ],
        default: 'none',
        description: 'Whether to require a Bearer token on incoming requests',
      },

      {
        displayName: 'Webhook Path',
        name: 'path',
        type: 'string',
        default: 'autom8-tableau',
        required: true,
        description:
          'The URL path segment that Tableau will POST to. Must be unique across your n8n instance.',
        placeholder: 'e.g. autom8-customer-satisfaction',
      },
 
      // ── Response mode — mirrors the built-in Webhook node ─────────────
      {
        displayName: 'Respond',
        name: 'responseMode',
        type: 'options',
        options: [
          {
            name: 'Immediately',
            value: 'onReceived',
            description: 'As soon as this node executes',
          },
          {
            name: 'When Last Node Finishes',
            value: 'lastNode',
            description: 'Returns the JSON of the first entry of the last-executed node. Use a single field `autom8_response` to display a message in Tableau.',
          },
        ],
        default: 'onReceived',
        description: 'When and how to respond to the incoming Tableau request',
      },
 
      // ── Autom8-specific options ───────────────────────────────────────
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Include Metadata',
            name: 'includeMetadata',
            type: 'boolean',
            default: false,
            description:
              'Whether to add the request metadata (dashboard_name, dashboard_id, timestamp, user) as fields on every output item',
          },
          {
            displayName: 'Pass Through Raw Body',
            name: 'passThroughRaw',
            type: 'boolean',
            default: false,
            description:
              'Whether to output the full, unmodified request body as a single item instead of the processed rows — useful for debugging',
          },
        ],
      },
    ],
  };
 
  // ── Webhook handler ──────────────────────────────────────────────────────
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject();
    const authentication = this.getNodeParameter('authentication', 'none') as string;
    const options = this.getNodeParameter('options', {}) as {
      includeMetadata?: boolean;
      passThroughRaw?: boolean;
    };

    const includeMetadata = options.includeMetadata === true;
    const passThroughRaw = options.passThroughRaw === true;
 
    // ── 1. Authenticate ───────────────────────────────────────────────────
    if (authentication === 'bearerToken') {
      const credentials = await this.getCredentials<{ token: string }>('autom8TableauBearerApi');
      const authHeader = (req.headers['authorization'] as string) ?? '';
      const incomingToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

      if (!incomingToken || incomingToken !== credentials.token) {
        const res = this.getResponseObject();
        res.status(401).json({ message: 'Unauthorized' });
        return { noWebhookResponse: true };
      }
    }

    // ── 2. Parse & validate the incoming body ──────────────────────────────
    let payload: TableauPayload;
    try {
      payload = req.body as TableauPayload;
      if (!payload || typeof payload.data !== 'object' || payload.data === null) {
        throw new NodeOperationError(this.getNode(), 'Missing or invalid "data" key in request body.');
      }
    } catch (err) {
      throw new NodeOperationError(
        this.getNode(),
        `Autom8 Data Action (Tableau): could not parse request body. ${  (err instanceof Error ? err.message : 'Unknown error')}`,
      );
    }
 
    if (passThroughRaw) {
      return { workflowData: [[{ json: payload as unknown as IDataObject }]] };
    }

    const metadataFields: IDataObject = {};
    if (includeMetadata) {
      for (const [key, value] of Object.entries(payload.metadata ?? {})) {
        metadataFields[toSnakeCase(key)] = value as unknown as IDataObject;
      }
    }

    const additionalData: IDataObject = {};
    for (const [key, value] of Object.entries(payload.additional_data ?? {})) {
      additionalData[toSnakeCase(key)] = value as unknown as IDataObject;
    }

    // ── 3. Normalise & iterate rows ───────────────────────────────────────
    // All payload formats (all-sheets, selected-marks, specific-sheet) send a
    // flat TableauRow[] where each row includes a worksheet_name column.
    const flatRows: TableauRow[] = payload.data;

    const outputItems: INodeExecutionData[] = [];

    for (const row of flatRows) {
      const shaped: IDataObject = {};

      for (const [rawKey, value] of Object.entries(row)) {
        shaped[toSnakeCase(rawKey)] = value as IDataObject;
      }

      Object.assign(shaped, metadataFields, additionalData);

      outputItems.push({ json: shaped });
    }
 
    // ── 4. Return workflow data ────────────────────────────────────────────
    // - 'onReceived': n8n replies immediately; workflowData triggers the workflow.
    // - 'lastNode':   n8n waits for the workflow to finish, returns first-entry JSON.
    return {
      workflowData: [outputItems],
    };
  }
}