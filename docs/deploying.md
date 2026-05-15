# Deploying Conduit Documentation

The docs site lives at **https://conduit.wyre.ai/docs** as a path on the marketing/app domain (not a subdomain). This document covers Cloudflare Pages deployment under that path.

## Prerequisites

1. **Cloudflare Account**: Access to the WYRE Cloudflare account with Pages permissions
2. **GitHub Repository Access**: Admin access to configure secrets and webhooks
3. **Domain Access**: Ability to configure DNS records for the documentation subdomain

## Cloudflare Pages Setup

### Initial Project Creation

1. **Create Cloudflare Pages Project**
   - Log into Cloudflare dashboard
   - Navigate to Pages → Create a project
   - Connect to GitHub repository: `wyre-technology/wyre-mcp-gateway-platform`
   - Project name: `conduit-docs`
   - Production branch: `main`
   - Build settings:
     - Framework preset: None
     - Build command: `cd docs && npm ci && npm run build`
     - Build output directory: `docs/dist`
     - Node.js version: `20`

2. **Routing under conduit.wyre.ai/docs**
   - Docs are served at the `/docs` path of the main `conduit.wyre.ai` site, not on a separate subdomain.
   - Astro is configured with `base: '/docs'` (see `docs/astro.config.mjs`), so all internal links and asset URLs prefix `/docs`.
   - In the Cloudflare Pages project that owns `conduit.wyre.ai`, configure a route or Workers rule that serves this Pages project's output for paths matching `/docs/*`. Two viable patterns:
     - **Pages → Pages Functions/Routes:** if both the marketing site and the docs build live under the same Pages project, place this build's output in a `/docs` subdirectory of the deploy.
     - **Cloudflare Worker fronting both:** route `/docs/*` on `conduit.wyre.ai` to this Pages project, route everything else to the marketing site project.
   - Confirm with Aaron which pattern to use; the second is more flexible if the marketing site is on a different repo or stack.

### GitHub Secrets Configuration

The deployment workflow requires these repository secrets:

```bash
# Get from Cloudflare → My Profile → API Tokens
CLOUDFLARE_API_TOKEN=<token-with-pages-edit-permissions>

# Get from Cloudflare → Pages → Account ID (right sidebar)
CLOUDFLARE_ACCOUNT_ID=<account-id>
```

To add secrets:
1. Go to GitHub repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add each secret name/value pair

## Deployment Process

### Automatic Deployment

The documentation automatically deploys when:
- **Production**: Changes are pushed to `main` branch affecting `docs/` folder
- **Preview**: Pull requests modify files in `docs/` folder

### Manual Deployment

To trigger a manual deployment:
1. Go to GitHub → Actions → "Deploy Docs to Cloudflare Pages"
2. Click "Run workflow"
3. Select branch and click "Run workflow"

### Build Process

The deployment workflow:
1. Checks out the repository
2. Sets up Node.js 20 with npm caching
3. Installs dependencies with `npm ci` in `docs/` folder
4. Builds the site with `npm run build` (outputs to `docs/dist/`)
5. Deploys to Cloudflare Pages using the official action
6. Posts preview URL as PR comment (for pull requests)

## Domain Configuration

### Public URL

Final URL: **https://conduit.wyre.ai/docs**

No new DNS records are needed; `conduit.wyre.ai` already resolves to the Cloudflare Pages site (per the wyre.ai apex setup). The `/docs` routing is handled at the Pages-project / Worker level, not via a subdomain.

## Monitoring and Maintenance

### Deployment Status

- **Cloudflare Dashboard**: Pages → conduit-docs → Deployments
- **GitHub Actions**: Repository → Actions tab
- **Preview URLs**: Posted as comments on PRs

### Common Issues

1. **Build Failures**
   - Check Node.js version compatibility (should be 20)
   - Verify all dependencies install correctly
   - Review build logs in Cloudflare Pages dashboard

2. **Missing Secrets**
   - Verify `CLOUDFLARE_API_TOKEN` has correct permissions
   - Confirm `CLOUDFLARE_ACCOUNT_ID` matches the account

3. **DNS Issues**
   - Allow up to 24 hours for DNS propagation
   - Use `dig` or online tools to verify CNAME resolution
   - Check Cloudflare DNS settings if issues persist

### Security Notes

- API tokens should have minimal required permissions (Cloudflare Pages:Edit)
- Tokens can be rotated in Cloudflare dashboard → My Profile → API Tokens
- Monitor deployment logs for any exposed sensitive information

## Updating the Deployment

To modify the deployment configuration:
1. Edit `.github/workflows/docs-deploy.yml` for build changes
2. Update Cloudflare Pages settings for domain or build configuration changes
3. Test changes in a pull request before merging to main

## Support

For deployment issues:
- Check Cloudflare Pages dashboard for detailed error logs
- Review GitHub Actions logs for build failures
- Contact Aaron for DNS or domain configuration assistance