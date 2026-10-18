// ---------------------------------------------------------------------------
// Initialization (runs once per cold start, reused across warm invocations).
// Keeping the clients and the DAX connection at module scope means the SDK
// setup and underlying connections are established only once, not per request.
//
// Writes go directly to DynamoDB. Reads go through DAX via the SDK v3 DAX
// client (DaxDocument from @amazon-dax-sdk/lib-dax), which gives low-latency
// in-memory cached reads of the Orders table.
// ---------------------------------------------------------------------------
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { DaxDocument } = require('@amazon-dax-sdk/lib-dax');

const TABLE_NAME = process.env.ORDERS_TABLE;
const DAX_ENDPOINT = process.env.DAX_ENDPOINT;
const REGION = process.env.AWS_REGION;

// Write path: standard DynamoDB document client.
const ddbWrite = DynamoDBDocument.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
});

// Read path: DAX document client, built once and reused. Falls back to the
// DynamoDB client when no DAX endpoint is configured (e.g. local testing).
let readClient;
function getReadClient() {
  if (readClient) {
    return readClient;
  }
  readClient = DAX_ENDPOINT
    ? new DaxDocument({ endpoints: [DAX_ENDPOINT], region: REGION })
    : ddbWrite;
  return readClient;
}

/**
 * Entry point. Routes based on HTTP method:
 *   - POST -> save an order to DynamoDB (write path)
 *   - GET  -> read an order's items through DAX (read path)
 */
exports.handler = async (event) => {
  const method =
    event?.httpMethod || event?.requestContext?.http?.method || 'POST';

  try {
    if (method === 'GET') {
      return await getOrder(event);
    }
    return await saveOrder(event);
  } catch (err) {
    console.error('Request failed', err);
    return response(500, { message: 'Internal error.' });
  }
};

/**
 * Saves an order to the Orders DynamoDB table (write path, no DAX).
 */
async function saveOrder(event) {
  const order = parseInput(event);

  if (!order.orderId || !order.itemId) {
    return response(400, {
      message: 'Both "orderId" and "itemId" are required.',
    });
  }

  const item = {
    ...order,
    createdAt: order.createdAt || new Date().toISOString(),
  };

  await ddbWrite.put({
    TableName: TABLE_NAME,
    Item: item,
  });

  return response(201, {
    message: 'Order saved.',
    order: item,
  });
}

/**
 * Reads all items for an order through DAX (read path).
 * The orderId is taken from the path parameter.
 */
async function getOrder(event) {
  const orderId = event?.pathParameters?.orderId;

  if (!orderId) {
    return response(400, { message: '"orderId" path parameter is required.' });
  }

  const result = await getReadClient().query({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'orderId = :orderId',
    ExpressionAttributeValues: { ':orderId': orderId },
  });

  return response(200, {
    orderId,
    count: result.Count || 0,
    items: result.Items || [],
  });
}

function parseInput(event) {
  // Supports both direct invocation (event is the order) and
  // API Gateway proxy integration (order is a JSON string in event.body).
  if (event && typeof event.body === 'string') {
    return JSON.parse(event.body);
  }
  if (event && typeof event.body === 'object' && event.body !== null) {
    return event.body;
  }
  return event || {};
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
