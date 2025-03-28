terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}


# If the bucket already exists, don't do anything
data "aws_s3_bucket" "source_images" {
  bucket = var.source_bucket_name
}

resource "aws_s3_bucket_public_access_block" "source_images" {
  bucket = data.aws_s3_bucket.source_images.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 bucket for resized images
resource "aws_s3_bucket" "resized_images" {
  bucket = var.resized_bucket_name
}

resource "aws_s3_bucket_public_access_block" "resized_images" {
  bucket = aws_s3_bucket.resized_images.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# IAM role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "${var.project_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# IAM policy for the Lambda role
resource "aws_iam_role_policy" "lambda_policy" {
  name = "${var.project_name}-lambda-policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          data.aws_s3_bucket.source_images.arn,
          "${data.aws_s3_bucket.source_images.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.resized_images.arn,
          "${aws_s3_bucket.resized_images.arn}/*"
        ]
      }
    ]
  })
}

# Lambda function
resource "aws_lambda_function" "image_resizer" {
  filename         = "${path.module}/lambda.zip"
  function_name    = "${var.project_name}-image-resizer"
  role            = aws_iam_role.lambda_role.arn
  handler         = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/lambda.zip")
  runtime         = "nodejs18.x"
  timeout         = 60  # Increased timeout for larger images
  memory_size     = 1024  # Increased memory for better performance

  environment {
    variables = {
      SOURCE_BUCKET = data.aws_s3_bucket.source_images.id
      RESIZED_BUCKET = aws_s3_bucket.resized_images.id
    }
  }
}

# API Gateway REST API
resource "aws_apigatewayv2_api" "image_api" {
  name          = "${var.project_name}-image-api"
  protocol_type = "HTTP"
  
  cors_configuration {
    allow_origins = ["*"]  # Or specify your allowed origins
    allow_methods = ["GET", "HEAD", "OPTIONS"]
    allow_headers = [
      "Content-Type",
      "X-Amz-Date",
      "Authorization",
      "X-Api-Key",
      "X-Amz-Security-Token",
      "X-Requested-With",
      "Origin",
      "Accept"
    ]
    expose_headers = ["*"]
    max_age = 3600
  }
}

# API Gateway stage
resource "aws_apigatewayv2_stage" "image_api" {
  api_id = aws_apigatewayv2_api.image_api.id
  name   = "$default"
  auto_deploy = true
}

# API Gateway integration with Lambda
resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id = aws_apigatewayv2_api.image_api.id

  integration_uri    = aws_lambda_function.image_resizer.invoke_arn
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
}

# API Gateway routes
resource "aws_apigatewayv2_route" "image_route" {
  for_each = toset(["GET /resize", "GET /original"])

  api_id = aws_apigatewayv2_api.image_api.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

# Lambda permission for API Gateway
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.image_resizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.image_api.execution_arn}/*/*"
}

# ACM Certificate for the domain
resource "aws_acm_certificate" "api_cert" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation record for the certificate
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api_cert.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.hosted_zone_id
}

# Certificate validation
resource "aws_acm_certificate_validation" "api_cert" {
  certificate_arn         = aws_acm_certificate.api_cert.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# API Gateway domain name
resource "aws_apigatewayv2_domain_name" "api" {
  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate.api_cert.arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  depends_on = [aws_acm_certificate_validation.api_cert]
}

# API Gateway stage and domain mapping
resource "aws_apigatewayv2_api_mapping" "api" {
  api_id      = aws_apigatewayv2_api.image_api.id
  domain_name = aws_apigatewayv2_domain_name.api.id
  stage       = aws_apigatewayv2_stage.image_api.id
}

# CloudFront distribution
resource "aws_cloudfront_distribution" "image_distribution" {
  enabled             = true
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"
  aliases             = [var.domain_name]

  origin {
    domain_name = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
    origin_id   = "api-gateway-${aws_apigatewayv2_api.image_api.id}"
    
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_keepalive_timeout = 5
      origin_read_timeout      = 30
    }
    
    custom_header {
      name  = "X-Forwarded-Host"
      value = var.domain_name
    }
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD", "OPTIONS"]  # Added OPTIONS to cached methods
    target_origin_id = "api-gateway-${aws_apigatewayv2_api.image_api.id}"
    compress         = true
    
    cache_policy_id          = aws_cloudfront_cache_policy.image_cache_policy.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.image_request_policy.id
    
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate.api_cert.arn
    ssl_support_method  = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Create a CloudFront cache policy
resource "aws_cloudfront_cache_policy" "image_cache_policy" {
  name        = "${var.project_name}-cache-policy"
  comment     = "Cache policy for image optimization service"
  default_ttl = 3600
  max_ttl     = 86400
  min_ttl     = 0
  
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = [
          "Origin",
          "Access-Control-Request-Headers",
          "Access-Control-Request-Method"
        ]
      }
    }
    
    query_strings_config {
      query_string_behavior = "all"
    }
    
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# Create a CloudFront origin request policy
resource "aws_cloudfront_origin_request_policy" "image_request_policy" {
  name    = "${var.project_name}-origin-request-policy"
  comment = "Origin request policy for image optimization service"
  
  cookies_config {
    cookie_behavior = "none"
  }
  
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = [
        "Origin",
        "Access-Control-Request-Headers",
        "Access-Control-Request-Method",
        "Host"
      ]
    }
  }
  
  query_strings_config {
    query_string_behavior = "all"
  }
}

# Update the Route53 record to point to CloudFront
resource "aws_route53_record" "api" {
  name    = var.domain_name
  type    = "A"
  zone_id = var.hosted_zone_id

  alias {
    name                   = aws_cloudfront_distribution.image_distribution.domain_name
    zone_id                = aws_cloudfront_distribution.image_distribution.hosted_zone_id
    evaluate_target_health = false
  }
}
