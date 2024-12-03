# Image Resizing Service

This project sets up an AWS infrastructure for dynamic image resizing using Lambda, S3, and API Gateway.

## Architecture

- Source S3 bucket: Stores original images
- Resized S3 bucket: Caches resized images
- Lambda function: Handles image resizing using the Sharp library
- API Gateway: Provides HTTP endpoint for image resizing requests

## Prerequisites

1. AWS CLI configured with appropriate credentials
2. Terraform installed
3. Node.js and npm installed
4. Docker installed (for building Lambda dependencies)

## Setup Instructions

1. Build Lambda dependencies (using Docker to ensure compatibility):
   ```bash
   # This step is required to create lambda.zip with the correct platform binaries
   ./setup-lambda.sh
   ```

2. Initialize Terraform:
   ```bash
   terraform init
   ```

3. Apply the infrastructure:
   ```bash
   terraform apply
   ```

Note: Any time you make changes to the Lambda function code or dependencies, you need to:
1. Run `./setup-lambda.sh` again to rebuild the lambda.zip
2. Run `terraform apply` to deploy the updated function

## Usage

1. Upload original images to the source S3 bucket
2. Access resized images through the API Gateway endpoint using one of these parameter combinations:

   a. Using predefined sizes:
   ```
   GET https://<api-gateway-url>/resize?image=example.jpg&size=medium
   ```
   Available sizes:
   - tiny (150x150)
   - small (300x300)
   - medium (600x600)
   - large (1200x1200)
   - extra-large (2400x2400)

   b. Using custom dimensions:
   ```
   GET https://<api-gateway-url>/resize?image=example.jpg&width=800&height=600
   ```
   Or specify just one dimension to maintain aspect ratio:
   ```
   GET https://<api-gateway-url>/resize?image=example.jpg&width=800
   ```

### Query Parameters

- `image`: Path of the image in the source bucket (required)
- `size`: Predefined size (optional, mutually exclusive with width/height)
  - Available sizes:
    - tiny (150x150)
    - small (300x300)
    - medium (600x600)
    - large (1200x1200)
    - extra-large (2400x2400)
- `width`: Custom width in pixels (optional)
- `height`: Custom height in pixels (optional)
- `fit`: Resizing behavior (optional, defaults to 'cover')
  - Available options:
    - `cover`: Preserves aspect ratio and crops excess (default)
    - `contain`: Preserves aspect ratio and adds padding if needed
    - `fill`: Ignores aspect ratio to fill exact size
    - `inside`: Preserves aspect ratio, scales down to fit within dimensions
    - `outside`: Preserves aspect ratio, scales up to cover dimensions

Examples:

```
# Crop to exact size (no padding)
https://images.example.com/resize?image=banner.jpg&width=800&height=600

# Preserve aspect ratio with padding
https://images.example.com/resize?image=banner.jpg&width=800&height=600&fit=contain

# Scale to fit within dimensions
https://images.example.com/resize?image=banner.jpg&width=800&height=600&fit=inside

# Use predefined size with specific fit mode
https://images.example.com/resize?image=banner.jpg&size=medium&fit=cover
```

Notes:
- You must specify either `size` OR `width`/`height` (not both)
- If using custom dimensions, at least one of `width` or `height` must be specified
- If only one dimension is specified, the image will be resized maintaining its aspect ratio
- If no size parameters are provided, defaults to 'medium' size (600x600)

## Domain Configuration

The service can be accessed through a custom domain with HTTPS support. You'll need to provide:

1. A domain name for the API (e.g., `images.example.com`)
2. The Route53 hosted zone ID of the parent domain
3. Names for the source and resized S3 buckets

Create a `terraform.tfvars` file with these values:
```hcl
domain_name         = "images.example.com"
hosted_zone_id      = "ZXXXXXXXXXXXXX"
source_bucket_name  = "my-original-images"
resized_bucket_name = "my-resized-images"
```

The infrastructure will:
1. Create an ACM certificate for your domain
2. Validate the certificate using DNS validation
3. Create a custom domain name for the API Gateway
4. Set up an A-record alias pointing to the API Gateway
5. Create two S3 buckets with the specified names for original and resized images

After deployment, you can access the API using your custom domain. The service supports nested paths for images:

```
# Image in root of bucket
https://images.example.com/resize?image=example.jpg&size=medium

# Image in nested directory
https://images.example.com/resize?image=/media/film/2001/banner/banner.jpg&size=large
```

The resized images will maintain the same directory structure as the source images, with an additional dimension directory:
- Original: `/media/film/2001/banner/banner.jpg`
- Resized: `/media/film/2001/banner/800x600/banner.jpg`

## Clean Up

To destroy the infrastructure:
```bash
terraform destroy
