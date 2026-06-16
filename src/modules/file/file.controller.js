// src/modules/file/file.controller.js
const fileService = require('./file.service');
const { AppError } = require('../../middleware/errorHandler');
const path = require('path');

// Allowed MIME types for upload validation
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // xlsx
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/zip',
  'application/x-rar-compressed',
  'text/plain',
  'application/json',
  'text/csv',
  'audio/webm',
  'video/webm', // Chrome MediaRecorder often saves audio as video/webm
  'audio/ogg',
  'audio/mp3',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'video/mp4',
];

/**
 * POST /api/v1/files/upload
 * Upload one or more files to Cloudflare R2.
 * Returns R2 object keys as fileIds (e.g. "uploads/2026/06/uuid.pdf").
 */
async function uploadFiles(req, res) {
  const { fileTypeFromBuffer } = await import('file-type');
  if (!req.files || req.files.length === 0) {
    throw new AppError('Fayl tanlanmagan', 400);
  }

  const uploadPromises = req.files.map(async (file) => {
    // 1. Extension blocklist
    const ext = path.extname(file.originalname).toLowerCase();
    const FORBIDDEN_EXTS = ['.exe', '.sh', '.bat', '.js', '.php', '.py', '.cmd', '.vbs'];
    if (FORBIDDEN_EXTS.includes(ext)) {
      throw new AppError(`Ushbu kengaytmali faylni yuklash taqiqlangan: ${ext}`, 400);
    }

    // 2. Magic bytes validation (prevent MIME type spoofing)
    const typeInfo = await fileTypeFromBuffer(file.buffer);
    let mimeType = typeInfo ? typeInfo.mime : null;

    // Handle plain text files without magic bytes
    if (!typeInfo) {
      const SAFE_TEXT_EXTS = ['.txt', '.sql', '.json', '.csv', '.md', '.webm', '.m4a', '.mp3'];
      if (SAFE_TEXT_EXTS.includes(ext)) {
        if (ext === '.json') mimeType = 'application/json';
        else if (ext === '.csv') mimeType = 'text/csv';
        else if (ext === '.webm') mimeType = 'video/webm';
        else if (ext === '.m4a') mimeType = 'audio/x-m4a';
        else if (ext === '.mp3') mimeType = 'audio/mpeg';
        else mimeType = 'text/plain';
      }
    }

    if (!mimeType || !ALLOWED_TYPES.includes(mimeType)) {
      throw new AppError(`Fayl turi ruxsat etilmagan: ${file.originalname}`, 400);
    }

    // 3. Upload to Cloudflare R2
    const objectKey = await fileService.uploadFile(
      file.buffer,
      file.originalname,
      mimeType
    );

    return {
      fileId: objectKey,
      name: file.originalname,
      size: file.size,
      type: mimeType
    };
  });

  const results = await Promise.all(uploadPromises);

  res.status(201).json({
    success: true,
    message: 'Fayllar muvaffaqiyatli yuklandi',
    data: { files: results, fileIds: results.map(r => r.fileId) },
  });
}

/**
 * GET /api/v1/files/:fileId/url
 * Get a download URL for a file by its R2 object key.
 *
 * The fileId (R2 key) may contain slashes — client must URL-encode it:
 *   encodeURIComponent('uploads/2026/06/uuid.pdf')
 *   → 'uploads%2F2026%2F06%2Fuuid.pdf'
 */
async function getFileUrl(req, res) {
  const fileId = decodeURIComponent(req.params.fileId || '');

  if (!fileId) {
    throw new AppError('fileId ko\'rsatilmagan', 400);
  }

  const url = await fileService.getFileUrl(fileId);

  res.json({
    success: true,
    data: { url },
  });
}

/**
 * POST /api/v1/files/batch-urls
 * Get download URLs for multiple files in one request.
 * Body: { fileIds: string[] }  (max 50)
 */
async function getBatchUrls(req, res) {
  const { fileIds } = req.body;

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new AppError('fileIds massivi bo\'sh', 400);
  }
  if (fileIds.length > 50) {
    throw new AppError('Bir so\'rovda ko\'pi bilan 50 ta fayl so\'rash mumkin', 400);
  }

  const results = await fileService.getBatchFileUrls(fileIds);

  res.json({
    success: true,
    data: { files: results },
  });
}

/**
 * DELETE /api/v1/files/:fileId
 * Delete a file from R2.
 * SECURITY: Disabled to prevent IDOR data destruction. 
 * Files are soft-deleted via parent entities (Task, Chat, etc).
 */
async function deleteFile(_req, _res) {
  throw new AppError('Fayllarni to\'g\'ridan-to\'g\'ri o\'chirish xavfsizlik sababli taqiqlangan.', 403);
}


/**
 * GET /api/v1/files/:fileId/secure-token
 * Phase 13: Get an ephemeral token (60s) to securely view a file
 */
async function getSecureToken(req, res) {
  const fileId = decodeURIComponent(req.params.fileId || '');
  if (!fileId) throw new AppError('fileId ko\'rsatilmagan', 400);

  const token = await fileService.getSecureToken(fileId, req.user.id);

  res.json({
    success: true,
    data: { token }
  });
}

/**
 * GET /api/v1/files/stream/:token
 * Phase 13: Stream the file securely using the ephemeral token
 * Note: No requireAuth middleware here because <canvas> fetch often 
 * struggles with auth headers. The token ITSELF is the auth!
 */
async function streamSecureFile(req, res) {
  const { token } = req.params;
  if (!token) throw new AppError('Token kiritilmagan', 400);

  // This will pipe directly to `res`
  await fileService.streamSecureFile(token, res);
}

module.exports = {
  getSecureToken,
  streamSecureFile,
  uploadFiles,
  getFileUrl,
  getBatchUrls,
  deleteFile,
};
