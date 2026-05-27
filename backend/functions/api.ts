import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getUserFromEvent, hasPermission, PERMISSIONS } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_MAPPINGS = {
  '0': 'LOGIN_USER',
  '1': 'NOTIFICATION_SETTING',
  '2': 'NOTIFICATION_HISTORY',
  '3': 'WORK_ITEM_MASTER',
  '4': 'WORK_RESULT',
  '5': 'OUTSOURCE_VENDOR_MASTER',
  '6': 'OUTSOURCE_REQUEST',
  '7': 'OUTSOURCE_COST',
  '8': 'INSOURCING_EVALUATION',
  '9': 'METADATA_OPERATION_LOG',
  '10': 'AUTOMATION_EFFECT_ANALYSIS',
  '11': 'MONTHLY_WORKLOAD_SUMMARY',
  '12': 'ANALYSIS_REPORT'
};

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters: { [key: string]: string } | null;
  queryStringParameters: { [key: string]: string } | null;
  body: string | null;
  requestContext: any;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(userId: string, action: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    const user = getUserFromEvent(event);
    const method = event.httpMethod;
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources
    if (method === 'GET' && path === 'resources') {
      if (!hasPermission(user, PERMISSIONS.READ_RESOURCES)) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const results = {};
        
        for (const [index, tableName] of Object.entries(TABLE_MAPPINGS)) {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableName
            }
          });
          
          const response = await docClient.send(command);
          results[tableName] = response.Items || [];
        }
        
        return createResponse(200, results);
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Bulk import endpoints: POST /api/{tableIndex}/bulk
    if (method === 'POST' && pathParts.length === 3 && pathParts[0] === 'api' && pathParts[2] === 'bulk') {
      if (!hasPermission(user, PERMISSIONS.BULK_IMPORT)) {
        return createResponse(403, { error: 'Insufficient permissions for bulk import' });
      }

      const tableIndex = pathParts[1];
      const tableName = TABLE_MAPPINGS[tableIndex as keyof typeof TABLE_MAPPINGS];
      
      if (!tableName) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body is required' });
      }

      try {
        const { items } = JSON.parse(event.body);
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const now = new Date().toISOString();

        // Process in batches of 25 (DynamoDB BatchWrite limit)
        for (let i = 0; i < items.length; i += 25) {
          const batch = items.slice(i, i + 25);
          const writeRequests = batch.map(item => {
            const id = item.id || crypto.randomUUID();
            return {
              PutRequest: {
                Item: {
                  pk: tableName,
                  sk: id,
                  id,
                  ...item,
                  createdAt: now,
                  updatedAt: now,
                  createdBy: user.id,
                  updatedBy: user.id
                }
              }
            };
          });

          try {
            await docClient.send(new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += batch.length;
          } catch (error) {
            failed += batch.length;
            errors.push(`Batch ${Math.floor(i/25) + 1}: ${error.message}`);
          }
        }

        await createAuditLog(user.id, 'BULK_IMPORT', {
          tableName,
          imported,
          failed,
          totalItems: items.length
        });

        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        console.error('Bulk import error:', error);
        return createResponse(500, { error: 'Internal server error during bulk import' });
      }
    }

    // Individual table operations: /api/{tableIndex}
    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const tableName = TABLE_MAPPINGS[tableIndex as keyof typeof TABLE_MAPPINGS];
      
      if (!tableName) {
        return createResponse(404, { error: 'Table not found' });
      }

      const resourceId = pathParts[2];

      // GET /api/{tableIndex} - List all items
      if (method === 'GET' && !resourceId) {
        if (!hasPermission(user, PERMISSIONS.READ_RESOURCES)) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableName
            }
          });
          
          const response = await docClient.send(command);
          return createResponse(200, { items: response.Items || [] });
        } catch (error) {
          console.error('Error listing items:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // GET /api/{tableIndex}/{id} - Get specific item
      if (method === 'GET' && resourceId) {
        if (!hasPermission(user, PERMISSIONS.READ_RESOURCES)) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const command = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableName,
              sk: resourceId
            }
          });
          
          const response = await docClient.send(command);
          
          if (!response.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, response.Item);
        } catch (error) {
          console.error('Error getting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // POST /api/{tableIndex} - Create new item
      if (method === 'POST' && !resourceId) {
        if (!hasPermission(user, PERMISSIONS.WRITE_RESOURCES)) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        try {
          const data = JSON.parse(event.body);
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          
          const item = {
            pk: tableName,
            sk: id,
            id,
            ...data,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog(user.id, 'CREATE', {
            tableName,
            itemId: id,
            data
          });

          return createResponse(201, item);
        } catch (error) {
          console.error('Error creating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // PUT /api/{tableIndex}/{id} - Update item
      if (method === 'PUT' && resourceId) {
        if (!hasPermission(user, PERMISSIONS.WRITE_RESOURCES)) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        try {
          // Check if item exists
          const getCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableName,
              sk: resourceId
            }
          });
          
          const existingItem = await docClient.send(getCommand);
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const data = JSON.parse(event.body);
          const now = new Date().toISOString();
          
          const updatedItem = {
            ...existingItem.Item,
            ...data,
            updatedAt: now,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(user.id, 'UPDATE', {
            tableName,
            itemId: resourceId,
            oldData: existingItem.Item,
            newData: data
          });

          return createResponse(200, updatedItem);
        } catch (error) {
          console.error('Error updating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // DELETE /api/{tableIndex}/{id} - Delete item
      if (method === 'DELETE' && resourceId) {
        if (!hasPermission(user, PERMISSIONS.DELETE_RESOURCES)) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          // Check if item exists
          const getCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableName,
              sk: resourceId
            }
          });
          
          const existingItem = await docClient.send(getCommand);
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableName,
              sk: resourceId
            }
          }));

          await createAuditLog(user.id, 'DELETE', {
            tableName,
            itemId: resourceId,
            deletedData: existingItem.Item
          });

          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          console.error('Error deleting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};