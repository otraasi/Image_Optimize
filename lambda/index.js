const AWS = require('aws-sdk');
const sharp = require('sharp');
const path = require('path');
const s3 = new AWS.S3();

// Predefined sizes with industry-standard dimensions
const PREDEFINED_SIZES = {
    'tiny': { width: 150, height: 150 },
    'small': { width: 300, height: 300 },
    'medium': { width: 600, height: 600 },
    'large': { width: 1200, height: 1200 },
    'extra-large': { width: 2400, height: 2400 }
};

// Validate and get dimensions from request parameters
const getDimensions = (queryParams) => {
    const width = queryParams.width ? parseInt(queryParams.width) : null;
    const height = queryParams.height ? parseInt(queryParams.height) : null;
    const size = queryParams.size ? queryParams.size.toLowerCase() : null;
    const fit = queryParams.fit ? queryParams.fit.toLowerCase() : 'cover';

    // Validate fit option
    if (!['cover', 'contain', 'fill', 'inside', 'outside'].includes(fit)) {
        throw new Error('Invalid fit option. Must be one of: cover, contain, fill, inside, outside');
    }

    // Check for mutually exclusive parameters
    if ((width || height) && size) {
        throw new Error('Cannot specify both size and dimensions (width/height)');
    }

    // Handle predefined size
    if (size) {
        if (!PREDEFINED_SIZES[size]) {
            throw new Error('Invalid size. Must be one of: tiny, small, medium, large, extra-large');
        }
        return { ...PREDEFINED_SIZES[size], fit };
    }

    // Handle custom dimensions
    if (width || height) {
        if (!width && !height) {
            throw new Error('At least one of width or height must be specified');
        }
        return {
            width: width || null,
            height: height || null,
            fit
        };
    }

    // Default size if no parameters provided
    return { ...PREDEFINED_SIZES.medium, fit };
};

// Generate the resized image key maintaining directory structure
const getResizedImageKey = (originalKey, dimensions) => {
    const dirName = path.dirname(originalKey);
    const fileName = path.basename(originalKey);
    const resizeDirName = `${dimensions.width}x${dimensions.height}`;
    
    // Combine the paths, ensuring proper directory structure
    if (dirName === '.') {
        return `${resizeDirName}/${fileName}`;
    }
    return `${dirName}/${resizeDirName}/${fileName}`;
};

exports.handler = async (event) => {
    try {
        const queryParams = event.queryStringParameters || {};
        const imagePath = queryParams.image;
        
        if (!imagePath) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Image path is required' })
            };
        }

        // Clean the image path to prevent directory traversal
        const cleanImagePath = path.normalize(imagePath).replace(/^(\.\.[\/\\])+/, '');

        // Get and validate dimensions
        let dimensions;
        try {
            dimensions = getDimensions(queryParams);
        } catch (error) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: error.message })
            };
        }

        // Generate resized image key maintaining directory structure
        const resizedKey = getResizedImageKey(cleanImagePath, dimensions);
        
        try {
            const resizedImage = await s3.getObject({
                Bucket: process.env.RESIZED_BUCKET,
                Key: resizedKey
            }).promise();
            
            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, max-age=31536000'
                },
                body: resizedImage.Body.toString('base64'),
                isBase64Encoded: true
            };
        } catch (error) {
            if (error.code !== 'NoSuchKey') {
                throw error;
            }
        }

        // Get original image
        const originalImage = await s3.getObject({
            Bucket: process.env.SOURCE_BUCKET,
            Key: cleanImagePath
        }).promise();

        // Create resize transform
        let transform = sharp(originalImage.Body);
        
        // Apply resize with the specified fit option
        if (dimensions.width && dimensions.height) {
            transform = transform.resize(dimensions.width, dimensions.height, {
                fit: dimensions.fit,
                position: 'center'
            });
        } else if (dimensions.width) {
            transform = transform.resize(dimensions.width, null, {
                fit: dimensions.fit,
                position: 'center'
            });
        } else {
            transform = transform.resize(null, dimensions.height, {
                fit: dimensions.fit,
                position: 'center'
            });
        }

        // Generate resized image
        const resizedBuffer = await transform
            .jpeg({ quality: 80 })
            .toBuffer();

        // Save resized image
        await s3.putObject({
            Bucket: process.env.RESIZED_BUCKET,
            Key: resizedKey,
            Body: resizedBuffer,
            ContentType: 'image/jpeg',
            CacheControl: 'public, max-age=31536000'
        }).promise();

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=31536000'
            },
            body: resizedBuffer.toString('base64'),
            isBase64Encoded: true
        };

    } catch (error) {
        console.error('Error:', error);
        
        if (error.code === 'NoSuchKey') {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Original image not found' })
            };
        }
        
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
