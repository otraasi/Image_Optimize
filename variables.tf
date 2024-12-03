variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name to be used for resource naming"
  type        = string
  default     = "image-optimizer"
}

variable "source_bucket_name" {
  description = "Name of the S3 bucket to store original images"
  type        = string
}

variable "resized_bucket_name" {
  description = "Name of the S3 bucket to store resized images"
  type        = string
}

variable "domain_name" {
  description = "The domain name to use for the API (e.g., images.example.com)"
  type        = string
}

variable "hosted_zone_id" {
  description = "The Route53 hosted zone ID for the parent domain"
  type        = string
}
