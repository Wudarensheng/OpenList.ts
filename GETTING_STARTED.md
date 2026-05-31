# Getting Started with OpenList.ts

## Quick Start

### 1. Prerequisites

- Node.js 18 or later
- npm or yarn
- Cloudflare account
- Wrangler CLI

### 2. Installation

```bash
# Install Wrangler CLI globally
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Clone the repository (if not already done)
# git clone <repository-url>
# cd OpenList.ts

# Install dependencies
npm install
```

### 3. Setup D1 Database

```bash
# Create D1 database
wrangler d1 create openlist-db

# Copy the database ID from the output and update wrangler.toml
# Replace "your-database-id-here" with the actual ID

# Initialize database schema
npm run db:init
```

### 4. Local Development

```bash
# Start local development server
npm run dev

# The server will be available at http://localhost:8787
```

### 5. Deploy to Cloudflare

```bash
# Deploy to Cloudflare Workers
npm run deploy

# Your deployment will be available at:
# https://openlist-ts.<your-subdomain>.workers.dev
```

## First Time Setup

### 1. Access the Admin Panel

1. Open your deployment URL
2. Click on the login button or go to `/api/auth/login`
3. Use default credentials:
   - Username: `admin`
   - Password: `admin`

### 2. Change Default Password

**Important:** Change the default password immediately!

You can do this through the API:

```bash
# Get your auth token
curl -X POST https://your-deployment-url/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin"}'

# Update password (replace <token> with the token from login response)
curl -X POST https://your-deployment-url/api/admin/user/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"id": 1, "password": "your-new-password"}'
```

### 3. Add S3 Storage

```bash
# Add S3 storage (replace <token> with your auth token)
curl -X POST https://your-deployment-url/api/admin/storage/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "mount_path": "/s3",
    "driver": "S3",
    "addition": "{\"bucket\":\"your-bucket\",\"endpoint\":\"https://s3.amazonaws.com\",\"region\":\"us-east-1\",\"access_key_id\":\"your-key\",\"access_key_secret\":\"your-secret\",\"root_path\":\"\",\"custom_host\":\"\",\"sign_url_expire\":3600,\"enable_custom_host_presign\":false,\"remove_bucket\":false,\"add_filename_to_disposition\":false,\"list_object_version\":\"v2\",\"placeholder\":\"placeholder\"}"
  }'
```

## API Usage Examples

### List Files

```bash
curl -X POST https://your-deployment-url/api/fs/list \
  -H "Content-Type: application/json" \
  -d '{"path": "/s3"}'
```

### Upload File

```bash
curl -X PUT "https://your-deployment-url/api/fs/upload?path=/s3&name=test.txt" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test.txt
```

### Create Directory

```bash
curl -X POST https://your-deployment-url/api/fs/mkdir \
  -H "Content-Type: application/json" \
  -d '{"path": "/s3", "name": "new-folder"}'
```

## Configuration

### Environment Variables

Edit `wrangler.toml` to configure environment variables:

```toml
[vars]
ENVIRONMENT = "production"
```

### Custom Domain

To use a custom domain:

1. Add your domain to Cloudflare
2. Update `wrangler.toml`:

```toml
name = "openlist-ts"
main = "src/worker.ts"
compatibility_date = "2024-04-05"

[env.production]
name = "openlist-ts-prod"
routes = [
  { pattern = "your-domain.com", zone_name = "your-domain.com" }
]
```

3. Deploy with environment:

```bash
npm run deploy -- --env production
```

## Troubleshooting

### Database Issues

If you encounter database issues:

```bash
# Reset database (WARNING: This will delete all data!)
npm run db:reset
```

### Deployment Issues

If deployment fails:

1. Check Wrangler configuration
2. Verify Cloudflare account permissions
3. Check for syntax errors: `npm run typecheck`

### Local Development Issues

If local development fails:

1. Clear Wrangler cache: `rm -rf .wrangler`
2. Reinstall dependencies: `rm -rf node_modules && npm install`
3. Check Node.js version: `node --version`

## Security Recommendations

1. **Change default password** immediately after first login
2. **Use strong passwords** for admin accounts
3. **Enable HTTPS** (enabled by default on Cloudflare Workers)
4. **Regular backups** of D1 database
5. **Monitor access logs** in Cloudflare dashboard
6. **Use environment variables** for sensitive configuration
7. **Implement rate limiting** for production use

## Next Steps

- Read the [README.md](README.md) for detailed documentation
- Explore the API endpoints
- Customize the frontend
- Add additional storage drivers
- Implement caching strategies
- Set up monitoring and alerts

## Support

For issues and questions:
- Check the [GitHub repository](https://github.com/OpenListTeam/OpenList)
- Open an issue for bugs
- Join the community discussions
