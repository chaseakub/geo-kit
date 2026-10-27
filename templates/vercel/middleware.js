// Serves the markdown copies `geo-kit build` writes: /page.md, /api/md/page,
// /api/md/_catalog, and any page requested with Accept: text/markdown.
// Browsers and everything else fall through to your HTML untouched.
// Written by `geo-kit init vercel`. Docs: https://github.com/chaseakub/geo-kit
import { createMarkdownMiddleware } from 'geo-kit/middleware'

export const config = {
  // Skip API routes (except /api/md) and static asset folders. Add your own
  // asset folders here so the middleware never runs in front of them.
  matcher: ['/((?!api/(?!md)|assets/|fonts/|images/|_next/|_vercel/).*)'],
}

export default createMarkdownMiddleware({ site: '__SITE__' })
