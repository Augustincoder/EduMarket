const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const r2Client = require('../../config/r2');
const env = require('../../config/env');
const { AppError } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const jwt = require('jsonwebtoken');
const prisma = require('../../config/prisma');

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine file extension from MIME type.
 * Falls back to .bin for unknown types.
 */
function getExtension(mimeType) {
  const map = {
    'image/jpeg':        'jpg',
    'image/png':         'png',
    'image/gif':         'gif',
    'image/webp':        'webp',
    'application/pdf':   'pdf',
    'application/msword':'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/zip':   'zip',
    'application/x-rar-compressed': 'rar',
    'text/plain':        'txt',
    'text/csv':          'csv',
    'application/json':  'json',
    'audio/webm':        'webm',
    'audio/ogg':         'ogg',
    'audio/mpeg':        'mp3',
    'audio/mp3':         'mp3',
    'audio/mp4':         'm4a',
    'audio/aac':         'aac',
    'audio/x-m4a':       'm4a',
    'video/mp4':         'mp4',
  };
  return map[mimeType] || 'bin';
}

/**
 * Generate a unique, safe object key for R2.
 * Format: uploads/<year>/<month>/<uuid>.<ext>
 * This keeps the bucket organized and avoids collisions.
 *
 * @param {string} mimeType - File MIME type
 * @param {string} originalName - Original filename (for logging only)
 * @returns {string} R2 object key
 */
function generateObjectKey(mimeType, _originalName) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const ext = getExtension(mimeType);
  const id = uuidv4();
  return `uploads/${year}/${month}/${id}.${ext}`;
}

// ─── Core Storage Functions ────────────────────────────────────────────────────

/**
 * Upload a file buffer to Cloudflare R2.
 * Returns the R2 object key (stored in DB as the "fileId").
 *
 * @param {Buffer} buffer - File data
 * @param {string} _originalName - Original filename
 * @param {string} mimeType - File MIME type
 * @returns {string} R2 object key (e.g. "uploads/2026/06/uuid.pdf")
 */
async function uploadFile(buffer, _originalName, mimeType) {
  const objectKey = generateObjectKey(mimeType, _originalName);
  const isImage = mimeType.startsWith('image/');

  try {
    await r2Client.send(new PutObjectCommand({
      Bucket:      env.R2_BUCKET_NAME,
      Key:         objectKey,
      Body:        buffer,
      ContentType: mimeType,
      // Aggressive caching for images at the edge, private for documents
      CacheControl: isImage 
        ? 'public, max-age=31536000, immutable' 
        : 'private, max-age=3600',
      // Store original filename as metadata for display purposes
      Metadata: {
        'original-name': encodeURIComponent(_originalName),
      },
    }));

    logger.info(`[R2] Uploaded: ${objectKey} (${buffer.length} bytes, ${mimeType})`);
    return objectKey;
  } catch (err) {
    logger.error(`[R2] Upload error for key "${objectKey}": ${err.message}`);
    throw new AppError(`Fayl yuklashda xatolik: ${err.message}`, 500);
  }
}

/**
 * Get a download URL for an R2 object.
 *
 * Strategy:
 * - Images (image/*) → Public CDN URL via R2 public bucket (permanent, fast, no auth)
 * - All other files  → Presigned S3 URL (1-hour expiry, requires signed request)
 *
 * This balances performance (images load fast without presigning round-trip)
 * with security (documents require authentication to download).
 *
 * @param {string} objectKey - R2 object key (stored as "fileId" in DB)
 * @param {number} expiresIn - Presigned URL expiry in seconds (default: 3600 = 1 hour)
 * @returns {string} Download URL
 */
async function getFileUrl(objectKey, expiresIn = 3600) {
  if (!objectKey) {
    throw new AppError('objectKey ko\'rsatilmagan', 400);
  }

  try {
    // Check if this is an image — use public CDN URL for images
    const isImage = objectKey.match(/\.(jpg|jpeg|png|gif|webp)$/i);

    if (isImage && env.R2_PUBLIC_URL) {
      // Public CDN URL — no expiry, fast delivery via Cloudflare CDN
      const publicUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${objectKey}`;
      return publicUrl;
    }

    // For non-image files, generate a presigned URL (time-limited, authenticated)
    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key:    objectKey,
    });

    const presignedUrl = await getSignedUrl(r2Client, command, { expiresIn });
    return presignedUrl;
  } catch (err) {
    logger.error(`[R2] getFileUrl error for key "${objectKey}": ${err.message}`);
    throw new AppError('Faylni topib bo\'lmadi', 404);
  }
}

/**
 * Delete a file from R2 by its object key.
 * Used when a user deletes a portfolio item, task attachment, etc.
 *
 * @param {string} objectKey - R2 object key
 */
async function deleteFile(objectKey) {
  if (!objectKey) return;

  try {
    await r2Client.send(new DeleteObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key:    objectKey,
    }));
    logger.info(`[R2] Deleted: ${objectKey}`);
  } catch (err) {
    // Non-fatal — log but don't throw. Orphaned objects can be cleaned up later.
    logger.warn(`[R2] Delete error for key "${objectKey}": ${err.message}`);
  }
}

/**
 * Get multiple file URLs in a single call.
 * More efficient than calling getFileUrl() in a loop for lists.
 *
 * @param {string[]} objectKeys - Array of R2 object keys
 * @returns {Promise<{ key: string, url: string }[]>}
 */
async function getBatchFileUrls(objectKeys) {
  if (!objectKeys || objectKeys.length === 0) return [];

  const results = await Promise.allSettled(
    objectKeys.map(async (key) => ({
      key,
      url: await getFileUrl(key),
    }))
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}


// ─── Phase 13: Secure File Delivery (EduViewer) ────────────────────────────────

/**
 * Generate a 60-second Ephemeral Token for viewing a file
 * Enforces a daily view limit (e.g., 3 views per file for clients).
 */
async function getSecureToken(fileId, userId) {
  if (!fileId) throw new AppError('fileId kiritilmagan', 400);

  // Check rate limit (Max 3 views per day for this specific file)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const viewsToday = await prisma.fileViewLog.count({
    where: {
      fileId,
      userId,
      viewedAt: { gte: today }
    }
  });

  // Limit to 10 views per day to be safe, but typically 3 for non-paid.
  // We'll use 5 as a balance.
  if (viewsToday >= 5) {
    throw new AppError('Ushbu faylni ko\'rish bo\'yicha kunlik limit (5) tugadi.', 429);
  }

  // Log the view
  await prisma.fileViewLog.create({
    data: { fileId, userId }
  });

  // Create Ephemeral Token (valid for 60 seconds)
  const token = jwt.sign({ fileId, userId }, env.JWT_SECRET, { expiresIn: '60s' });
  
  return token;
}

/**
 * Helper: Inject zero-width characters into text for Forensic Watermarking
 */
function injectSteganography(text, userId) {
  // Convert userId to binary representation
  const binary = Array.from(userId).map(char => char.charCodeAt(0).toString(2).padStart(8, '0')).join('');
  
  // 0 = Zero-width space (\u200B), 1 = Zero-width non-joiner (\u200C)
  const secret = Array.from(binary).map(b => b === '0' ? '\u200B' : '\u200C').join('');
  
  // Inject right after the first newline or at the start
  return secret + text;
}

/**
 * Stream the file directly to the Express response object, 
 * bypassing public URLs entirely.
 */
async function streamSecureFile(token, res) {
  if (!token) throw new AppError('Token kiritilmagan', 401);

  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    throw new AppError('Token yaroqsiz yoki muddati o\'tgan', 403);
  }

  const { fileId, userId } = decoded;

  try {
    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: fileId,
    });
    const s3Response = await r2Client.send(command);

    // Set headers
    res.setHeader('Content-Type', s3Response.ContentType);
    res.setHeader('Content-Length', s3Response.ContentLength);
    // Force inline viewing instead of attachment
    res.setHeader('Content-Disposition', 'inline');

    // Forensic Watermarking for Text/Code files
    if (s3Response.ContentType && s3Response.ContentType.startsWith('text/')) {
      const streamToString = async (stream) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
      };
      
      let text = await streamToString(s3Response.Body);
      text = injectSteganography(text, userId);
      
      res.setHeader('Content-Length', Buffer.byteLength(text, 'utf8'));
      res.send(text);
      return;
    }

    // Binary files (Images, PDFs) are piped directly
    s3Response.Body.pipe(res);
  } catch (err) {
    logger.error(`[R2] Secure stream error for ${fileId}: ${err.message}`);
    throw new AppError('Faylni yuklab olishda xatolik', 500);
  }
}

module.exports = {
  getSecureToken,
  streamSecureFile,
  uploadFile,
  getFileUrl,
  deleteFile,
  getBatchFileUrls,
};
