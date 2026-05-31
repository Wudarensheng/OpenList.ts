#!/bin/bash

# OpenList.ts Deployment Script

set -e

echo "🚀 Deploying OpenList.ts to Cloudflare Workers..."

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not found. Installing..."
    npm install -g wrangler
fi

# Check if logged in to Cloudflare
if ! wrangler whoami &> /dev/null; then
    echo "🔐 Please login to Cloudflare..."
    wrangler login
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Run type check
echo "🔍 Running type check..."
npm run typecheck

# Run linting
echo "🧹 Running linting..."
npm run lint

# Build and deploy
echo "🚀 Deploying to Cloudflare Workers..."
npm run deploy

echo "✅ Deployment complete!"
echo ""
echo "📝 Next steps:"
echo "1. Create D1 database: wrangler d1 create openlist-db"
echo "2. Update wrangler.toml with your database ID"
echo "3. Initialize database: wrangler d1 execute openlist-db --file=./src/models/schema.sql"
echo "4. Access your deployment at: https://openlist-ts.<your-subdomain>.workers.dev"
echo ""
echo "⚠️  Default credentials:"
echo "   Username: admin"
echo "   Password: admin"
echo "   Please change the password immediately!"
