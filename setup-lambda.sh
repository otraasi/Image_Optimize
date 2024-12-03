#!/bin/bash

set -e  # Exit on error

echo "Creating build directory..."
# Create a temporary directory for building
mkdir -p lambda-build
cp lambda/package.json lambda-build/
cp lambda/index.js lambda-build/

echo "Installing dependencies using Docker..."
# Create a container to install dependencies
docker run --name lambda-builder \
    --entrypoint="" \
    -v "$PWD/lambda-build:/lambda" \
    public.ecr.aws/lambda/nodejs:18 \
    /bin/bash -c "cd /lambda && \
    npm install --platform=linux --arch=x64 sharp && \
    npm install --production"

# Copy the installed node_modules from the container
echo "Copying node_modules from container..."
docker cp lambda-builder:/lambda/node_modules ./lambda-build/

# Remove the container
echo "Cleaning up container..."
docker rm lambda-builder

echo "Checking if node_modules exists..."
if [ ! -d "lambda-build/node_modules" ]; then
    echo "Error: node_modules directory not found after npm install"
    exit 1
fi

echo "Checking if sharp module is properly installed..."
if [ ! -f "lambda-build/node_modules/sharp/build/Release/sharp-linux-x64.node" ]; then
    echo "Error: sharp module not properly built for linux-x64"
    exit 1
fi

echo "Creating deployment package..."
# Clean up any existing lambda.zip
rm -f lambda.zip

# Create deployment package
cd lambda-build && zip -r ../lambda.zip . -x "package.json" "package-lock.json" && cd ..

echo "Verifying zip contents..."
unzip -l lambda.zip | grep -q "node_modules/sharp/build/Release/sharp-linux-x64.node" || {
    echo "Error: sharp binary not found in lambda.zip"
    exit 1
}

echo "Cleaning up build directory..."
# Clean up build directory
rm -rf lambda-build

echo "Done! lambda.zip has been created with all dependencies."
