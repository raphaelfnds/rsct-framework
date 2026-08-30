import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import pino from 'pino'

import { TOOLS, HANDLERS } from './catalog.js'
import { RESOURCE_TEMPLATES, STATIC_RESOURCES, readResource } from './resources.js'
import { RSCT_MCP_VERSION } from './lib/version.js'

const SERVER_NAME = 'rsct-mcp'
const SERVER_VERSION = RSCT_MCP_VERSION

const logger = pino(
  {
    level: process.env.RSCT_LOG_LEVEL ?? 'info',
    base: { name: SERVER_NAME, version: SERVER_VERSION },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2),
)

async function main(): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const handler = HANDLERS[name]
    if (!handler) {
      logger.warn({ name }, 'unknown tool requested')
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: `unknown tool: ${name}` }) },
        ],
        isError: true,
      }
    }

    try {
      const result = await handler(request.params.arguments ?? {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ name, err }, 'tool handler threw')
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message, tool: name }),
          },
        ],
        isError: true,
      }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES,
  }))

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    try {
      const result = readResource(uri)
      return {
        contents: [
          {
            uri: result.uri,
            mimeType: result.mimeType,
            text: result.text,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ uri, err }, 'resource read failed')
      throw new Error(message)
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info(
    {
      tools: TOOLS.map((t) => t.name),
      resources: STATIC_RESOURCES.map((r) => r.uri),
      resource_templates: RESOURCE_TEMPLATES.map((r) => r.uriTemplate),
    },
    'rsct-mcp ready',
  )
}

main().catch((err) => {
  logger.fatal({ err }, 'rsct-mcp failed to start')
  process.exit(1)
})
