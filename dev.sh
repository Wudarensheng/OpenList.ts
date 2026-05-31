#!/bin/bash

# OpenList.ts Development Script

set -e

echo "🚀 Starting OpenList.ts development server..."

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not found. Installing..."
    npm install -g wrangler
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Start development server
echo "🔧 Starting development server..."
echo "📝 Note: You may need to create a D1 database first:"
echo "   wrangler d1 create openlist-db"
echo ""
npm run dev
