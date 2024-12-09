const AWS = require('aws-sdk');
const sharp = require('sharp');
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
    const dirName = originalKey.substring(0, originalKey.lastIndexOf('/'));
    const fileName = originalKey.substring(originalKey.lastIndexOf('/') + 1);
    const resizeDirName = `${dimensions.width}x${dimensions.height}/${dimensions.fit}`;
    
    // Combine the paths, ensuring proper directory structure
    if (dirName === '') {
        return `${resizeDirName}/${fileName}`;
    }
    return `${dirName}/${resizeDirName}/${fileName}`;
};

exports.handler = async (event) => {
    try {
        console.log('Request received:', {
            path: event.path,
            queryParams: event.queryStringParameters,
            headers: event.headers
        });

        const queryParams = event.queryStringParameters || {};
        const imagePath = queryParams.image;
        const requestPath = event.path || '';
        
        console.log('Parsed request parameters:', {
            imagePath,
            requestPath
        });

        if (!imagePath) {
            console.log('Error: Image path is missing');
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Image path is required' })
            };
        }

        // Clean the image path to prevent directory traversal
        const cleanImagePath = imagePath.replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
        console.log('Cleaned image path:', cleanImagePath);

        // Handle /original endpoint - serve directly from source
        if (requestPath === '/original') {
            console.log('Handling /original request');
            try {
                const originalImage = await s3.getObject({
                    Bucket: process.env.SOURCE_BUCKET,
                    Key: cleanImagePath
                }).promise();

                console.log('Successfully retrieved original image:', {
                    bucket: process.env.SOURCE_BUCKET,
                    key: cleanImagePath,
                    contentType: originalImage.ContentType,
                    size: originalImage.Body.length
                });

                return {
                    statusCode: 200,
                    headers: {
                        'Content-Type': originalImage.ContentType || 'image/jpeg',
                        'Cache-Control': 'public, no-cache'
                    },
                    body: originalImage.Body.toString('base64'),
                    isBase64Encoded: true
                };
            } catch (error) {
                console.error('Error retrieving original image:', {
                    bucket: process.env.SOURCE_BUCKET,
                    key: cleanImagePath,
                    error: error.message,
                    stack: error.stack
                });
                throw error;
            }
        }

        // Handle /resize endpoint
        if (requestPath !== '/resize' && requestPath !== '/original') {
            console.log('Invalid endpoint requested:', requestPath);
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid endpoint. Use /resize or /original' })
            };
        }

        // Get and validate dimensions
        let dimensions;
        try {
            dimensions = getDimensions(queryParams);
            console.log('Parsed dimensions:', dimensions);
        } catch (error) {
            console.error('Error parsing dimensions:', error.message);
            return {
                statusCode: 400,
                body: JSON.stringify({ error: error.message })
            };
        }

        // Generate resized image key maintaining directory structure
        const resizedKey = getResizedImageKey(cleanImagePath, dimensions);
        console.log('Generated resized image key:', resizedKey);
        
        try {
            const resizedImage = await s3.getObject({
                Bucket: process.env.RESIZED_BUCKET,
                Key: resizedKey
            }).promise();
            
            console.log('Successfully retrieved resized image:', {
                bucket: process.env.RESIZED_BUCKET,
                key: resizedKey,
                contentType: resizedImage.ContentType,
                size: resizedImage.Body.length
            });

            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, no-cache'
                },
                body: resizedImage.Body.toString('base64'),
                isBase64Encoded: true
            };
        } catch (error) {
            if (error.code !== 'NoSuchKey') {
                console.error('Error retrieving resized image:', {
                    bucket: process.env.RESIZED_BUCKET,
                    key: resizedKey,
                    error: error.message,
                    stack: error.stack
                });
                throw error;
            }
        }

        // Get original image
        const originalImage = await s3.getObject({
            Bucket: process.env.SOURCE_BUCKET,
            Key: cleanImagePath
        }).promise();

        console.log('Successfully retrieved original image:', {
            bucket: process.env.SOURCE_BUCKET,
            key: cleanImagePath,
            contentType: originalImage.ContentType,
            size: originalImage.Body.length
        });

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

        console.log('Applied resize transform:', {
            width: dimensions.width,
            height: dimensions.height,
            fit: dimensions.fit
        });

        // Check if watermark is required (default is true for backward compatibility)
        const shouldWatermark = queryParams.watermark !== 'false';
        let resizedBuffer;

        if (shouldWatermark) {
            // Get and process the watermark
            const watermark = await s3.getObject({
                Bucket: process.env.SOURCE_BUCKET,
                Key: 'tgc-logo.png'
            }).promise();

            const watermarkImage = await sharp(watermark.Body)
                .resize(Math.floor(dimensions.width * 0.1) || 80) // Make watermark 10% of image width or 80px if width not specified
                .toBuffer();

            // Generate resized image with watermark
            resizedBuffer = await transform
                .composite([{
                    input: watermarkImage,
                    gravity: 'northeast' // Position at bottom right
                }])
                .jpeg({ quality: 80 })
                .toBuffer();
        } else {
            // Generate resized image without watermark
            resizedBuffer = await transform
                .jpeg({ quality: 80 })
                .toBuffer();
        }

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
                'Cache-Control': 'public, no-cache'
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
