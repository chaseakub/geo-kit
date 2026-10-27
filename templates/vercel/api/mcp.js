// Public, read-only MCP endpoint over your site's markdown copies.
// Written by `geo-kit init vercel`. Docs: https://github.com/chaseakub/geo-kit
import { createVercelMcpHandler } from 'geo-kit/vercel-mcp'

export default createVercelMcpHandler({ site: '__SITE__', name: '__NAME__' })
